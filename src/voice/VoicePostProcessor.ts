/**
 * VoicePostProcessor - Apply CSterm radio effects to decoded voice
 *
 * Applies the characteristic tactical radio sound:
 * - Bandpass filter (180Hz - 2200Hz)
 * - Slight distortion/compression
 * - Bit crushing for digital artifact
 */

import { VOICE_SAMPLE_RATE, VOICE_FRAME_SAMPLES } from './types.js';
import { DEFAULT_VOCODER_PARAMS } from './VocoderDebug.js';

export interface PostProcessParams {
  highpassCutoff: number;   // Hz
  lowpassCutoff: number;    // Hz
  hardClip: number;         // 0-0.5 distortion
  bitCrush: number;         // 8-16 bits
  outputGain: number;       // 0.5-2.5
  noiseLevel: number;       // 0-0.15 static
}

// CSterm defaults from VocoderDebug
const DEFAULT_POST_PROCESS: PostProcessParams = {
  highpassCutoff: DEFAULT_VOCODER_PARAMS.highpassCutoff,
  lowpassCutoff: DEFAULT_VOCODER_PARAMS.lowpassCutoff,
  hardClip: DEFAULT_VOCODER_PARAMS.hardClip,
  bitCrush: DEFAULT_VOCODER_PARAMS.bitCrush,
  outputGain: DEFAULT_VOCODER_PARAMS.outputGain,
  noiseLevel: DEFAULT_VOCODER_PARAMS.noiseLevel,
};

/**
 * Voice post-processor for CSterm radio effect
 */
export class VoicePostProcessor {
  private params: PostProcessParams;

  // Filter state (persistent across frames)
  private hpState1 = 0;
  private hpState2 = 0;
  private lpState1 = 0;
  private lpState2 = 0;

  constructor(params: Partial<PostProcessParams> = {}) {
    this.params = { ...DEFAULT_POST_PROCESS, ...params };
  }

  /**
   * Update parameters
   */
  setParams(params: Partial<PostProcessParams>): void {
    Object.assign(this.params, params);
    // Reset filter state if cutoffs changed
    if ('highpassCutoff' in params || 'lowpassCutoff' in params) {
      this.hpState1 = this.hpState2 = 0;
      this.lpState1 = this.lpState2 = 0;
    }
  }

  /**
   * Process a frame of audio samples
   */
  process(samples: Int16Array): Int16Array {
    const result = new Int16Array(samples.length);
    const N = samples.length;

    // Apply bandpass filter
    const filtered = this.applyBandpassFilter(samples);

    // Convert to float for processing
    const floatSamples = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      floatSamples[i] = filtered[i];
    }

    // Add static noise
    if (this.params.noiseLevel > 0) {
      const noiseAmp = this.params.noiseLevel * 6000;
      for (let i = 0; i < N; i++) {
        floatSamples[i] += (Math.random() * 2 - 1) * noiseAmp;
      }
    }

    // Bit crushing (digital radio artifact)
    const bitDepth = Math.max(1, Math.min(16, Math.floor(this.params.bitCrush)));
    if (bitDepth < 16) {
      const levels = Math.pow(2, bitDepth);
      for (let i = 0; i < N; i++) {
        const normalized = (floatSamples[i] + 32768) / 65536;
        const quantized = Math.floor(normalized * levels) / levels;
        floatSamples[i] = quantized * 65536 - 32768;
      }
    }

    // Hard clipping / distortion (radio compression)
    if (this.params.hardClip > 0) {
      const clipThreshold = 32767 * (1 - this.params.hardClip * 0.9);
      for (let i = 0; i < N; i++) {
        if (floatSamples[i] > clipThreshold) {
          floatSamples[i] = clipThreshold + (floatSamples[i] - clipThreshold) * 0.1;
        } else if (floatSamples[i] < -clipThreshold) {
          floatSamples[i] = -clipThreshold + (floatSamples[i] + clipThreshold) * 0.1;
        }
      }
    }

    // Output gain and soft limiting
    for (let i = 0; i < N; i++) {
      let sample = floatSamples[i] * this.params.outputGain;

      // Soft knee limiter
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
   * Apply bandpass filter
   */
  private applyBandpassFilter(samples: Int16Array): Float32Array {
    const N = samples.length;
    const output = new Float32Array(N);

    // High-pass filter coefficients
    const hpCutoff = this.params.highpassCutoff / (VOICE_SAMPLE_RATE / 2);
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

    // Low-pass filter coefficients
    const lpCutoff = this.params.lowpassCutoff / (VOICE_SAMPLE_RATE / 2);
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

    // Apply low-pass
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
   * Reset filter state
   */
  reset(): void {
    this.hpState1 = this.hpState2 = 0;
    this.lpState1 = this.lpState2 = 0;
  }
}

// Singleton instance
let processorInstance: VoicePostProcessor | null = null;

/**
 * Get shared VoicePostProcessor instance
 */
export function getVoicePostProcessor(): VoicePostProcessor {
  if (!processorInstance) {
    processorInstance = new VoicePostProcessor();
  }
  return processorInstance;
}

/**
 * Destroy shared VoicePostProcessor
 */
export function destroyVoicePostProcessor(): void {
  processorInstance = null;
}
