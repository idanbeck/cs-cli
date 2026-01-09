/**
 * Codec2 WASM Wrapper
 *
 * Wraps the Codec2 vocoder library compiled to WebAssembly.
 * Provides ultra-low bitrate speech encoding (2400bps target).
 *
 * Codec2 2400bps mode:
 * - Input: 160 samples (20ms at 8kHz)
 * - Output: 6 bytes (48 bits)
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  Codec2Mode,
  CODEC2_PAYLOAD_SIZE,
  VOICE_SAMPLE_RATE,
  VOICE_FRAME_SAMPLES,
} from './types.js';

// Codec2 WASM module interface
interface Codec2WasmModule {
  _codec2_create(mode: number): number;
  _codec2_destroy(codec: number): void;
  _codec2_encode(codec: number, bits: number, speech: number): void;
  _codec2_decode(codec: number, speech: number, bits: number): void;
  _codec2_samples_per_frame(codec: number): number;
  _codec2_bits_per_frame(codec: number): number;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
  HEAP16: Int16Array;
}

/**
 * Codec2 encoder/decoder instance
 */
export class Codec2 {
  private wasmModule: Codec2WasmModule | null = null;
  private codecPtr: number = 0;
  private speechPtr: number = 0;
  private bitsPtr: number = 0;
  private mode: Codec2Mode;
  private samplesPerFrame: number = VOICE_FRAME_SAMPLES;
  private bytesPerFrame: number = CODEC2_PAYLOAD_SIZE;
  private _isInitialized = false;

  constructor(mode: Codec2Mode = Codec2Mode.MODE_2400) {
    this.mode = mode;
  }

  /**
   * Initialize the Codec2 WASM module
   */
  async initialize(): Promise<void> {
    if (this._isInitialized) return;

    try {
      // Try to load WASM module
      const wasmPath = this.getWasmPath();
      this.wasmModule = await this.loadWasmModule(wasmPath);

      if (this.wasmModule) {
        // Create codec instance
        this.codecPtr = this.wasmModule._codec2_create(this.mode);
        if (this.codecPtr === 0) {
          throw new Error('Failed to create Codec2 instance');
        }

        // Get frame sizes
        this.samplesPerFrame = this.wasmModule._codec2_samples_per_frame(this.codecPtr);
        const bitsPerFrame = this.wasmModule._codec2_bits_per_frame(this.codecPtr);
        this.bytesPerFrame = Math.ceil(bitsPerFrame / 8);

        // Allocate buffers
        this.speechPtr = this.wasmModule._malloc(this.samplesPerFrame * 2); // 16-bit samples
        this.bitsPtr = this.wasmModule._malloc(this.bytesPerFrame);
      }
    } catch (error) {
      // Fall back to LPC mode when WASM not available
      this.wasmModule = null;
    }

    this._isInitialized = true;
  }

  /**
   * Get path to WASM file
   */
  private getWasmPath(): string {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    return join(__dirname, 'codec2.wasm');
  }

  /**
   * Load WASM module
   */
  private async loadWasmModule(wasmPath: string): Promise<Codec2WasmModule | null> {
    try {
      const wasmBuffer = await readFile(wasmPath);

      // Simple WASM instantiation - real implementation would use Emscripten loader
      const wasmModule = await WebAssembly.instantiate(wasmBuffer, {
        env: {
          memory: new WebAssembly.Memory({ initial: 256 }),
          __memory_base: 0,
          __table_base: 0,
          abort: () => { throw new Error('WASM abort'); },
        },
      });

      return wasmModule.instance.exports as unknown as Codec2WasmModule;
    } catch {
      return null;
    }
  }

  /**
   * Encode audio samples to Codec2 bitstream
   *
   * @param samples 160 16-bit samples (20ms at 8kHz)
   * @returns 6 bytes of encoded data
   */
  encode(samples: Int16Array): Uint8Array {
    if (!this._isInitialized) {
      throw new Error('Codec2 not initialized');
    }

    // If WASM is available, use it
    if (this.wasmModule && this.codecPtr) {
      // Copy samples to WASM memory
      const heap16 = this.wasmModule.HEAP16;
      const speechOffset = this.speechPtr >> 1; // Divide by 2 for 16-bit array
      for (let i = 0; i < this.samplesPerFrame; i++) {
        heap16[speechOffset + i] = samples[i] || 0;
      }

      // Encode
      this.wasmModule._codec2_encode(this.codecPtr, this.bitsPtr, this.speechPtr);

      // Copy result
      const result = new Uint8Array(this.bytesPerFrame);
      result.set(this.wasmModule.HEAPU8.subarray(this.bitsPtr, this.bitsPtr + this.bytesPerFrame));
      return result;
    }

    // Fallback: simple compression for testing
    return this.fallbackEncode(samples);
  }

  /**
   * Decode Codec2 bitstream to audio samples
   *
   * @param bits 6 bytes of encoded data
   * @returns 160 16-bit samples (20ms at 8kHz)
   */
  decode(bits: Uint8Array): Int16Array {
    if (!this._isInitialized) {
      throw new Error('Codec2 not initialized');
    }

    // If WASM is available, use it
    if (this.wasmModule && this.codecPtr) {
      // Copy bits to WASM memory
      this.wasmModule.HEAPU8.set(bits, this.bitsPtr);

      // Decode
      this.wasmModule._codec2_decode(this.codecPtr, this.speechPtr, this.bitsPtr);

      // Copy result
      const result = new Int16Array(this.samplesPerFrame);
      const heap16 = this.wasmModule.HEAP16;
      const speechOffset = this.speechPtr >> 1;
      for (let i = 0; i < this.samplesPerFrame; i++) {
        result[i] = heap16[speechOffset + i];
      }
      return result;
    }

    // Fallback: simple decompression for testing
    return this.fallbackDecode(bits);
  }

  // Bandpass filter state (persistent across frames for continuity)
  private hpState1 = 0;  // High-pass filter state
  private hpState2 = 0;
  private lpState1 = 0;  // Low-pass filter state
  private lpState2 = 0;

  /**
   * Apply bandpass filter (120Hz - 2500Hz) to focus on speech frequencies
   * Uses cascaded biquad filters for stability
   */
  private applyBandpassFilter(samples: Int16Array): Float32Array {
    const N = samples.length;
    const output = new Float32Array(N);

    // High-pass filter coefficients (120Hz cutoff at 8kHz sample rate)
    // 2nd order Butterworth - removes rumble and DC
    const hpCutoff = 120 / (VOICE_SAMPLE_RATE / 2);
    const hpQ = 0.707;
    const hpW0 = Math.PI * hpCutoff;
    const hpAlpha = Math.sin(hpW0) / (2 * hpQ);
    const hpCosW0 = Math.cos(hpW0);
    const hpA0 = 1 + hpAlpha;
    const hpB0 = ((1 + hpCosW0) / 2) / hpA0;
    const hpB1 = (-(1 + hpCosW0)) / hpA0;
    const hpB2 = ((1 + hpCosW0) / 2) / hpA0;
    const hpA1 = (-2 * hpCosW0) / hpA0;
    const hpA2 = (1 - hpAlpha) / hpA0;

    // Low-pass filter coefficients (2500Hz cutoff at 8kHz sample rate)
    // 2nd order Butterworth - allows more high frequency for transients
    const lpCutoff = 2500 / (VOICE_SAMPLE_RATE / 2);
    const lpQ = 0.707;
    const lpW0 = Math.PI * lpCutoff;
    const lpAlpha = Math.sin(lpW0) / (2 * lpQ);
    const lpCosW0 = Math.cos(lpW0);
    const lpA0 = 1 + lpAlpha;
    const lpB0 = ((1 - lpCosW0) / 2) / lpA0;
    const lpB1 = (1 - lpCosW0) / lpA0;
    const lpB2 = ((1 - lpCosW0) / 2) / lpA0;
    const lpA1 = (-2 * lpCosW0) / lpA0;
    const lpA2 = (1 - lpAlpha) / lpA0;

    // Apply high-pass filter
    let x1 = 0, x2 = 0, y1 = this.hpState1, y2 = this.hpState2;
    const hpFiltered = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x0 = samples[i];
      const y0 = hpB0 * x0 + hpB1 * x1 + hpB2 * x2 - hpA1 * y1 - hpA2 * y2;
      hpFiltered[i] = y0;
      x2 = x1; x1 = x0;
      y2 = y1; y1 = y0;
    }
    this.hpState1 = y1;
    this.hpState2 = y2;

    // Apply low-pass filter
    x1 = 0; x2 = 0; y1 = this.lpState1; y2 = this.lpState2;
    for (let i = 0; i < N; i++) {
      const x0 = hpFiltered[i];
      const y0 = lpB0 * x0 + lpB1 * x1 + lpB2 * x2 - lpA1 * y1 - lpA2 * y2;
      output[i] = y0;
      x2 = x1; x1 = x0;
      y2 = y1; y1 = y0;
    }
    this.lpState1 = y1;
    this.lpState2 = y2;

    return output;
  }

  /**
   * Fallback encoder using enhanced LPC (Linear Predictive Coding)
   * This provides intelligible vocoded speech when WASM is not available.
   *
   * Encodes 160 samples into 16 bytes:
   * - Bytes 0-1: Energy (16-bit for better dynamic range)
   * - Byte 2: Pitch period (0 = unvoiced, 1-255 = voiced pitch in samples)
   * - Byte 3: Voicing strength (0-255)
   * - Bytes 4-15: 12 LPC reflection coefficients (8 bits each)
   *
   * Uses 12 LPC coefficients for detailed formant modeling
   * Includes bandpass filtering (120Hz-2.5kHz) and pre-emphasis
   */
  private fallbackEncode(samples: Int16Array): Uint8Array {
    const result = new Uint8Array(CODEC2_PAYLOAD_SIZE);
    const N = samples.length;

    // Apply bandpass filter (120Hz - 2.5kHz) to focus on speech frequencies
    const bandpassed = this.applyBandpassFilter(samples);

    // Pre-emphasis filter (boost high frequencies for better LPC analysis)
    // H(z) = 1 - 0.97*z^-1
    const preEmphasis = 0.97;
    const emphasized = new Float32Array(N);
    emphasized[0] = bandpassed[0];
    for (let i = 1; i < N; i++) {
      emphasized[i] = bandpassed[i] - preEmphasis * bandpassed[i - 1];
    }

    // Calculate energy (RMS of emphasized signal)
    let sumSquares = 0;
    for (let i = 0; i < N; i++) {
      sumSquares += emphasized[i] * emphasized[i];
    }
    const rms = Math.sqrt(sumSquares / N);

    // Energy quantization (16-bit for better dynamic range)
    // Map log energy to 0-65535 range
    const logEnergy = rms > 1 ? Math.log(rms) / Math.log(32768) : 0;
    const energyQuant = Math.max(0, Math.min(65535, Math.floor(logEnergy * 65535)));
    result[0] = energyQuant & 0xFF;         // Low byte
    result[1] = (energyQuant >> 8) & 0xFF;  // High byte

    // Pitch detection using autocorrelation
    const minPitch = 16;  // ~500 Hz max
    const maxPitch = 100; // ~80 Hz min
    let bestPitch = 0;
    let bestCorr = 0;

    // Calculate autocorrelation at lag 0 for normalization
    let r0 = 0;
    for (let i = 0; i < N; i++) {
      r0 += emphasized[i] * emphasized[i];
    }

    if (r0 > 1000) {
      // Find pitch using autocorrelation
      for (let lag = minPitch; lag <= maxPitch; lag++) {
        let corr = 0;
        for (let i = 0; i < N - lag; i++) {
          corr += emphasized[i] * emphasized[i + lag];
        }
        const normalizedCorr = corr / (r0 + 1e-10);
        if (normalizedCorr > bestCorr) {
          bestCorr = normalizedCorr;
          bestPitch = lag;
        }
      }

      // Voicing decision - require strong correlation
      if (bestCorr < 0.25) {
        bestPitch = 0; // Unvoiced
      }
    }
    result[2] = bestPitch;

    // Voicing strength (0-255) - used for mixed excitation
    const voicingStrength = Math.max(0, Math.min(255, Math.floor(bestCorr * 255)));
    result[3] = voicingStrength;

    // LPC analysis using autocorrelation method (Levinson-Durbin)
    // Use 12 coefficients for detailed formant modeling
    const order = 12;
    const r = new Float32Array(order + 1);

    // Calculate autocorrelation with Hamming window
    for (let k = 0; k <= order; k++) {
      let sum = 0;
      for (let i = 0; i < N - k; i++) {
        const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (N - 1));
        sum += emphasized[i] * emphasized[i + k] * w;
      }
      r[k] = sum;
    }

    // Bandwidth expansion to prevent filter instability
    const bwExpand = 0.994;
    for (let k = 1; k <= order; k++) {
      r[k] *= Math.pow(bwExpand, k);
    }

    // Levinson-Durbin recursion to get reflection coefficients
    const reflectionCoeffs = new Float32Array(order);
    const a = new Float32Array(order + 1);
    a[0] = 1;
    let e = r[0] + 1e-10;

    for (let i = 0; i < order; i++) {
      let lambda = r[i + 1];
      for (let j = 1; j <= i; j++) {
        lambda += a[j] * r[i + 1 - j];
      }

      reflectionCoeffs[i] = -lambda / e;
      reflectionCoeffs[i] = Math.max(-0.99, Math.min(0.99, reflectionCoeffs[i]));

      const aNew = new Float32Array(order + 1);
      aNew[0] = 1;
      for (let j = 1; j <= i; j++) {
        aNew[j] = a[j] + reflectionCoeffs[i] * a[i + 1 - j];
      }
      aNew[i + 1] = reflectionCoeffs[i];
      a.set(aNew);

      e = e * (1 - reflectionCoeffs[i] * reflectionCoeffs[i]);
      if (e < 1e-10) e = 1e-10;
    }

    // Quantize 12 reflection coefficients to 8 bits each
    // Use arcsine quantization for better distribution near ±1
    for (let i = 0; i < 12; i++) {
      const k = reflectionCoeffs[i];
      // Arcsine transform for better quantization of values near ±1
      const arcsin = Math.asin(Math.max(-0.99, Math.min(0.99, k)));
      const normalized = (arcsin / (Math.PI / 2) + 1) * 127.5; // Map to 0-255
      result[4 + i] = Math.max(0, Math.min(255, Math.round(normalized)));
    }

    return result;
  }

  /**
   * Fallback decoder using enhanced LPC synthesis with sawtooth excitation
   *
   * Decodes 16 bytes:
   * - Bytes 0-1: Energy (16-bit)
   * - Byte 2: Pitch period
   * - Byte 3: Voicing strength
   * - Bytes 4-15: 12 LPC reflection coefficients (8-bit each)
   */
  private fallbackDecode(bits: Uint8Array): Int16Array {
    const result = new Int16Array(VOICE_FRAME_SAMPLES);
    const order = 12;

    // Decode 16-bit energy
    const energyQuant = bits[0] | (bits[1] << 8);
    const logEnergy = energyQuant / 65535;
    const energy = Math.pow(32768, logEnergy);
    const gain = energy / 3; // Scale factor

    // Decode pitch and voicing
    const pitch = bits[2];
    const voicingStrength = bits[3];
    const voiced = pitch > 0 && voicingStrength > 30;
    const voicingMix = voicingStrength / 255; // 0 = all noise, 1 = all voiced

    // Decode 12 LPC reflection coefficients (8 bits each)
    const reflectionCoeffs = new Float32Array(order);
    for (let i = 0; i < 12; i++) {
      const quantized = bits[4 + i];
      // Inverse arcsine transform
      const normalized = (quantized / 127.5) - 1; // Map back to [-1, 1]
      reflectionCoeffs[i] = Math.sin(normalized * (Math.PI / 2));
      // Clamp to ensure stability
      reflectionCoeffs[i] = Math.max(-0.98, Math.min(0.98, reflectionCoeffs[i]));
    }

    // Convert reflection coefficients to LPC coefficients
    const a = new Float32Array(order + 1);
    a[0] = 1;
    for (let i = 0; i < order; i++) {
      const aNew = new Float32Array(order + 1);
      aNew[0] = 1;
      for (let j = 1; j <= i; j++) {
        aNew[j] = a[j] + reflectionCoeffs[i] * a[i + 1 - j];
      }
      aNew[i + 1] = reflectionCoeffs[i];
      a.set(aNew);
    }

    // Generate mixed excitation signal using SAWTOOTH for better transients
    const excitation = new Float32Array(VOICE_FRAME_SAMPLES);
    if (voiced && pitch > 0) {
      // Mixed excitation: sawtooth train + noise
      let pulsePhase = 0;
      for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
        // Sawtooth wave - rich in harmonics for better formant excitation
        // Phase goes from 0 to 1 over pitch period, sawtooth goes from 1 to -1
        const phaseInPitch = pulsePhase / pitch;
        const sawtooth = (1 - 2 * phaseInPitch) * gain;

        // Add aspiration noise (more for weaker voicing)
        const aspirationAmount = 0.15 * (1 - voicingMix * 0.7);
        const noise = (Math.random() * 2 - 1) * gain * aspirationAmount;

        excitation[i] = sawtooth * voicingMix + noise;

        pulsePhase++;
        if (pulsePhase >= pitch) pulsePhase = 0;
      }
    } else {
      // Unvoiced: filtered noise (fricatives, sibilants)
      for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
        excitation[i] = (Math.random() * 2 - 1) * gain * 0.5;
      }
    }

    // LPC synthesis filter (all-pole filter)
    const state = new Float32Array(order);
    const deEmphasis = 0.95;
    let prevOutput = 0;

    for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
      let sample = excitation[i];
      for (let j = 0; j < order; j++) {
        sample -= a[j + 1] * state[j];
      }

      // Update state (shift register)
      for (let j = order - 1; j > 0; j--) {
        state[j] = state[j - 1];
      }
      state[0] = sample;

      // De-emphasis filter (restore low frequencies)
      // H(z) = 1 / (1 - 0.95*z^-1)
      sample = sample + deEmphasis * prevOutput;
      prevOutput = sample;

      // Soft clipping for better sound quality
      if (sample > 24000) {
        sample = 24000 + (sample - 24000) * 0.3;
      } else if (sample < -24000) {
        sample = -24000 + (sample + 24000) * 0.3;
      }

      result[i] = Math.max(-32768, Math.min(32767, Math.round(sample)));
    }

    return result;
  }

  /**
   * Get samples per frame
   */
  getSamplesPerFrame(): number {
    return this.samplesPerFrame;
  }

  /**
   * Get bytes per frame
   */
  getBytesPerFrame(): number {
    return this.bytesPerFrame;
  }

  /**
   * Check if initialized
   */
  get isInitialized(): boolean {
    return this._isInitialized;
  }

  /**
   * Check if using real WASM or fallback
   */
  get isWasmAvailable(): boolean {
    return this.wasmModule !== null;
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    if (this.wasmModule && this.codecPtr) {
      if (this.speechPtr) this.wasmModule._free(this.speechPtr);
      if (this.bitsPtr) this.wasmModule._free(this.bitsPtr);
      this.wasmModule._codec2_destroy(this.codecPtr);
    }

    this.wasmModule = null;
    this.codecPtr = 0;
    this.speechPtr = 0;
    this.bitsPtr = 0;
    this._isInitialized = false;
  }
}

// Singleton encoder instance
let encoderInstance: Codec2 | null = null;

/**
 * Get shared Codec2 encoder instance
 */
export function getCodec2Encoder(): Codec2 {
  if (!encoderInstance) {
    encoderInstance = new Codec2(Codec2Mode.MODE_2400);
  }
  return encoderInstance;
}

/**
 * Initialize shared Codec2 encoder
 */
export async function initializeCodec2(): Promise<Codec2> {
  const codec = getCodec2Encoder();
  await codec.initialize();
  return codec;
}

/**
 * Destroy shared Codec2 encoder
 */
export function destroyCodec2(): void {
  if (encoderInstance) {
    encoderInstance.destroy();
    encoderInstance = null;
  }
}
