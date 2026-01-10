/**
 * Codec2 Native Speech Codec Wrapper
 *
 * Wraps the native Codec2 speech codec library via N-API bindings.
 * Codec2 is an open-source ultra-low bitrate speech codec optimized for
 * voice communication over narrow bandwidth channels.
 *
 * Supported modes:
 *   3200 bps - Best quality, 20ms frames, 8 bytes/frame
 *   2400 bps - Good quality, 20ms frames, 6 bytes/frame
 *   1600 bps - Moderate quality, 40ms frames, 8 bytes/frame
 *   1400 bps - 40ms frames, 7 bytes/frame
 *   1300 bps - 40ms frames, 6.5 bytes/frame
 *   1200 bps - 40ms frames, 6 bytes/frame
 *   700C bps - Lowest bitrate, 40ms frames, 4 bytes/frame
 */

import * as path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import {
  Codec2Mode as Codec2ModeEnum,
  VOICE_SAMPLE_RATE,
  VOICE_FRAME_SAMPLES,
} from "./types.js";

// Re-export the enum for backwards compatibility
export { Codec2Mode as Codec2ModeEnum } from "./types.js";

// ESM compatibility - get __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// String-based mode type for native API
export type Codec2ModeString =
  | "3200"
  | "2400"
  | "1600"
  | "1400"
  | "1300"
  | "1200"
  | "700C";

// Native module interface
interface NativeCodec2 {
  getModes(): Codec2ModeString[];
  getModeInfo(mode: Codec2ModeString): Codec2ModeInfo;
  encode(mode: Codec2ModeString, samples: Int16Array): Uint8Array;
  decode(mode: Codec2ModeString, bytes: Uint8Array): Int16Array;
  encodeFrame(mode: Codec2ModeString, samples: Int16Array): Uint8Array;
  decodeFrame(mode: Codec2ModeString, bytes: Uint8Array): Int16Array;
}

export interface Codec2ModeInfo {
  samplesPerFrame: number; // Audio samples per frame (160 or 320 @ 8kHz)
  bytesPerFrame: number; // Compressed bytes per frame
  bitsPerFrame: number; // Compressed bits per frame
  bitrate: number; // Bits per second
  frameDurationMs: number; // Frame duration in milliseconds (20 or 40)
}

// Load native module
const nativeCodec2: NativeCodec2 | null = (() => {
  try {
    // Try multiple possible paths
    const paths = [
      path.join(__dirname, "../../native/build/Release/codec2.node"),
      path.join(process.cwd(), "native/build/Release/codec2.node"),
    ];

    for (const p of paths) {
      try {
        return require(p);
      } catch {
        continue;
      }
    }
    return null;
  } catch (e) {
    // Silent fail - will use LPC fallback
    return null;
  }
})();

// Map enum to string mode
function modeEnumToString(mode: Codec2ModeEnum): Codec2ModeString {
  switch (mode) {
    case Codec2ModeEnum.MODE_3200:
      return "3200";
    case Codec2ModeEnum.MODE_2400:
      return "2400";
    case Codec2ModeEnum.MODE_1600:
      return "1600";
    case Codec2ModeEnum.MODE_1400:
      return "1400";
    case Codec2ModeEnum.MODE_1300:
      return "1300";
    case Codec2ModeEnum.MODE_1200:
      return "1200";
    case Codec2ModeEnum.MODE_700C:
    default:
      return "700C";
  }
}

/**
 * Codec2 encoder/decoder instance
 *
 * Now uses native Codec2 library via N-API bindings.
 * Falls back to LPC-based synthesis when native module unavailable.
 */
export class Codec2 {
  private modeEnum: Codec2ModeEnum;
  private modeString: Codec2ModeString;
  private modeInfo: Codec2ModeInfo | null = null;
  private _isInitialized = false;

  // Fallback LPC state
  private hpState1 = 0;
  private hpState2 = 0;
  private lpState1 = 0;
  private lpState2 = 0;

  constructor(mode: Codec2ModeEnum = Codec2ModeEnum.MODE_2400) {
    this.modeEnum = mode;
    this.modeString = modeEnumToString(mode);
  }

  /**
   * Initialize the Codec2 module
   */
  async initialize(): Promise<void> {
    if (this._isInitialized) return;

    if (nativeCodec2) {
      this.modeInfo = nativeCodec2.getModeInfo(this.modeString);
    } else {
      // Fallback mode info
      this.modeInfo = {
        samplesPerFrame: VOICE_FRAME_SAMPLES,
        bytesPerFrame: 16, // LPC fallback uses 16 bytes
        bitsPerFrame: 128,
        bitrate: 6400, // 16 bytes * 8 bits / 0.02s = 6400 bps
        frameDurationMs: 20,
      };
    }

    this._isInitialized = true;
  }

  /**
   * Check if native Codec2 is available
   */
  static isNativeAvailable(): boolean {
    return nativeCodec2 !== null;
  }

  /**
   * Get available codec modes
   */
  static getModes(): Codec2ModeString[] {
    if (nativeCodec2) {
      return nativeCodec2.getModes();
    }
    return ["3200", "2400", "1600", "1400", "1300", "1200", "700C"];
  }

  /**
   * Get info about a specific mode
   */
  static getModeInfo(mode: Codec2ModeString): Codec2ModeInfo | null {
    if (nativeCodec2) {
      return nativeCodec2.getModeInfo(mode);
    }
    // Approximate info for fallback
    const infos: Record<Codec2ModeString, Codec2ModeInfo> = {
      "3200": {
        samplesPerFrame: 160,
        bytesPerFrame: 8,
        bitsPerFrame: 64,
        bitrate: 3200,
        frameDurationMs: 20,
      },
      "2400": {
        samplesPerFrame: 160,
        bytesPerFrame: 6,
        bitsPerFrame: 48,
        bitrate: 2400,
        frameDurationMs: 20,
      },
      "1600": {
        samplesPerFrame: 320,
        bytesPerFrame: 8,
        bitsPerFrame: 64,
        bitrate: 1600,
        frameDurationMs: 40,
      },
      "1400": {
        samplesPerFrame: 320,
        bytesPerFrame: 7,
        bitsPerFrame: 56,
        bitrate: 1400,
        frameDurationMs: 40,
      },
      "1300": {
        samplesPerFrame: 320,
        bytesPerFrame: 7,
        bitsPerFrame: 52,
        bitrate: 1300,
        frameDurationMs: 40,
      },
      "1200": {
        samplesPerFrame: 320,
        bytesPerFrame: 6,
        bitsPerFrame: 48,
        bitrate: 1200,
        frameDurationMs: 40,
      },
      "700C": {
        samplesPerFrame: 320,
        bytesPerFrame: 4,
        bitsPerFrame: 28,
        bitrate: 700,
        frameDurationMs: 40,
      },
    };
    return infos[mode] || null;
  }

  /**
   * Encode audio samples to Codec2 bitstream
   *
   * @param samples 16-bit signed PCM samples at 8kHz
   * @returns Compressed codec2 data
   */
  encode(samples: Int16Array): Uint8Array {
    if (!this._isInitialized) {
      throw new Error("Codec2 not initialized");
    }

    if (nativeCodec2) {
      return nativeCodec2.encode(this.modeString, samples);
    }

    // Fallback to LPC
    return this.fallbackEncode(samples);
  }

  /**
   * Decode Codec2 bitstream to audio samples
   *
   * @param bits Compressed codec2 data
   * @returns 16-bit signed PCM samples at 8kHz
   */
  decode(bits: Uint8Array): Int16Array {
    if (!this._isInitialized) {
      throw new Error("Codec2 not initialized");
    }

    if (nativeCodec2) {
      return nativeCodec2.decode(this.modeString, bits);
    }

    // Fallback to LPC
    return this.fallbackDecode(bits);
  }

  /**
   * Get samples per frame
   */
  getSamplesPerFrame(): number {
    return this.modeInfo?.samplesPerFrame || VOICE_FRAME_SAMPLES;
  }

  /**
   * Get bytes per frame
   */
  getBytesPerFrame(): number {
    return this.modeInfo?.bytesPerFrame || 16;
  }

  /**
   * Check if initialized
   */
  get isInitialized(): boolean {
    return this._isInitialized;
  }

  /**
   * Check if using real native codec or fallback
   */
  get isWasmAvailable(): boolean {
    // Kept for backwards compatibility - now checks native availability
    return nativeCodec2 !== null;
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this._isInitialized = false;
  }

  // ========== Fallback LPC Implementation ==========

  /**
   * Apply bandpass filter (120Hz - 2500Hz)
   */
  private applyBandpassFilter(samples: Int16Array): Float32Array {
    const N = samples.length;
    const output = new Float32Array(N);

    // High-pass filter coefficients (120Hz cutoff at 8kHz)
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

    // Low-pass filter coefficients (2500Hz cutoff)
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

    // Apply high-pass
    let x1 = 0,
      x2 = 0,
      y1 = this.hpState1,
      y2 = this.hpState2;
    const hpFiltered = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x0 = samples[i];
      const y0 = hpB0 * x0 + hpB1 * x1 + hpB2 * x2 - hpA1 * y1 - hpA2 * y2;
      hpFiltered[i] = y0;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
    }
    this.hpState1 = y1;
    this.hpState2 = y2;

    // Apply low-pass
    x1 = 0;
    x2 = 0;
    y1 = this.lpState1;
    y2 = this.lpState2;
    for (let i = 0; i < N; i++) {
      const x0 = hpFiltered[i];
      const y0 = lpB0 * x0 + lpB1 * x1 + lpB2 * x2 - lpA1 * y1 - lpA2 * y2;
      output[i] = y0;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
    }
    this.lpState1 = y1;
    this.lpState2 = y2;

    return output;
  }

  /**
   * Fallback encoder using LPC
   */
  private fallbackEncode(samples: Int16Array): Uint8Array {
    const result = new Uint8Array(16);
    const N = samples.length;

    const bandpassed = this.applyBandpassFilter(samples);

    // Pre-emphasis
    const preEmphasis = 0.97;
    const emphasized = new Float32Array(N);
    emphasized[0] = bandpassed[0];
    for (let i = 1; i < N; i++) {
      emphasized[i] = bandpassed[i] - preEmphasis * bandpassed[i - 1];
    }

    // Calculate energy
    let sumSquares = 0;
    for (let i = 0; i < N; i++) {
      sumSquares += emphasized[i] * emphasized[i];
    }
    const rms = Math.sqrt(sumSquares / N);
    const logEnergy = rms > 1 ? Math.log(rms) / Math.log(32768) : 0;
    const energyQuant = Math.max(
      0,
      Math.min(65535, Math.floor(logEnergy * 65535))
    );
    result[0] = energyQuant & 0xff;
    result[1] = (energyQuant >> 8) & 0xff;

    // Pitch detection
    const minPitch = 16;
    const maxPitch = 100;
    let bestPitch = 0;
    let bestCorr = 0;

    let r0 = 0;
    for (let i = 0; i < N; i++) {
      r0 += emphasized[i] * emphasized[i];
    }

    if (r0 > 1000) {
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
      if (bestCorr < 0.25) {
        bestPitch = 0;
      }
    }
    result[2] = bestPitch;
    result[3] = Math.max(0, Math.min(255, Math.floor(bestCorr * 255)));

    // LPC analysis
    const order = 12;
    const r = new Float32Array(order + 1);

    for (let k = 0; k <= order; k++) {
      let sum = 0;
      for (let i = 0; i < N - k; i++) {
        const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (N - 1));
        sum += emphasized[i] * emphasized[i + k] * w;
      }
      r[k] = sum;
    }

    const bwExpand = 0.994;
    for (let k = 1; k <= order; k++) {
      r[k] *= Math.pow(bwExpand, k);
    }

    // Levinson-Durbin
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

    // Quantize reflection coefficients
    for (let i = 0; i < 12; i++) {
      const k = reflectionCoeffs[i];
      const arcsin = Math.asin(Math.max(-0.99, Math.min(0.99, k)));
      const normalized = (arcsin / (Math.PI / 2) + 1) * 127.5;
      result[4 + i] = Math.max(0, Math.min(255, Math.round(normalized)));
    }

    return result;
  }

  /**
   * Fallback decoder using LPC synthesis
   */
  private fallbackDecode(bits: Uint8Array): Int16Array {
    const result = new Int16Array(VOICE_FRAME_SAMPLES);
    const order = 12;

    // Decode energy
    const energyQuant = bits[0] | (bits[1] << 8);
    const logEnergy = energyQuant / 65535;
    const energy = Math.pow(32768, logEnergy);
    const gain = energy / 3;

    // Decode pitch and voicing
    const pitch = bits[2];
    const voicingStrength = bits[3];
    const voiced = pitch > 0 && voicingStrength > 30;
    const voicingMix = voicingStrength / 255;

    // Decode reflection coefficients
    const reflectionCoeffs = new Float32Array(order);
    for (let i = 0; i < 12; i++) {
      const quantized = bits[4 + i];
      const normalized = quantized / 127.5 - 1;
      reflectionCoeffs[i] = Math.sin(normalized * (Math.PI / 2));
      reflectionCoeffs[i] = Math.max(-0.98, Math.min(0.98, reflectionCoeffs[i]));
    }

    // Convert to LPC coefficients
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

    // Generate excitation
    const excitation = new Float32Array(VOICE_FRAME_SAMPLES);
    if (voiced && pitch > 0) {
      let pulsePhase = 0;
      for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
        const phaseInPitch = pulsePhase / pitch;
        const sawtooth = (1 - 2 * phaseInPitch) * gain;
        const aspirationAmount = 0.15 * (1 - voicingMix * 0.7);
        const noise = (Math.random() * 2 - 1) * gain * aspirationAmount;
        excitation[i] = sawtooth * voicingMix + noise;
        pulsePhase++;
        if (pulsePhase >= pitch) pulsePhase = 0;
      }
    } else {
      for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
        excitation[i] = (Math.random() * 2 - 1) * gain * 0.5;
      }
    }

    // LPC synthesis
    const state = new Float32Array(order);
    const deEmphasis = 0.95;
    let prevOutput = 0;

    for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
      let sample = excitation[i];
      for (let j = 0; j < order; j++) {
        sample -= a[j + 1] * state[j];
      }

      for (let j = order - 1; j > 0; j--) {
        state[j] = state[j - 1];
      }
      state[0] = sample;

      sample = sample + deEmphasis * prevOutput;
      prevOutput = sample;

      if (sample > 24000) {
        sample = 24000 + (sample - 24000) * 0.3;
      } else if (sample < -24000) {
        sample = -24000 + (sample + 24000) * 0.3;
      }

      result[i] = Math.max(-32768, Math.min(32767, Math.round(sample)));
    }

    return result;
  }
}

// Singleton encoder instance
let encoderInstance: Codec2 | null = null;

/**
 * Get shared Codec2 encoder instance
 */
export function getCodec2Encoder(): Codec2 {
  if (!encoderInstance) {
    encoderInstance = new Codec2(Codec2ModeEnum.MODE_2400);
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

/**
 * Resample audio from one sample rate to 8kHz
 */
export function resampleTo8kHz(
  samples: Float32Array,
  sourceSampleRate: number
): Int16Array {
  const ratio = sourceSampleRate / 8000;
  const outputLength = Math.floor(samples.length / ratio);
  const output = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, samples.length - 1);
    const frac = srcIndex - srcIndexFloor;

    const sample =
      samples[srcIndexFloor] * (1 - frac) + samples[srcIndexCeil] * frac;
    output[i] = Math.max(-32768, Math.min(32767, Math.floor(sample * 32767)));
  }

  return output;
}

/**
 * Resample audio from 8kHz to target sample rate
 */
export function resampleFrom8kHz(
  samples: Int16Array,
  targetSampleRate: number
): Float32Array {
  const ratio = targetSampleRate / 8000;
  const outputLength = Math.floor(samples.length * ratio);
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i / ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, samples.length - 1);
    const frac = srcIndex - srcIndexFloor;

    const sample16 =
      samples[srcIndexFloor] * (1 - frac) + samples[srcIndexCeil] * frac;
    output[i] = sample16 / 32767;
  }

  return output;
}
