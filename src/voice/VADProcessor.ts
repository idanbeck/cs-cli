/**
 * VADProcessor - Voice Activity Detection
 *
 * Energy-based VAD with adaptive threshold and hangover.
 * Prevents transmitting silence and reduces bandwidth.
 */

import { VOICE_FRAME_SAMPLES, VOICE_FRAME_MS } from './types.js';

/**
 * VAD configuration
 */
export interface VADConfig {
  sensitivity: number;       // 1-10 (higher = more sensitive)
  hangoverMs: number;        // Keep transmitting after speech ends
  minSpeechMs: number;       // Minimum speech duration to trigger
  adaptiveThreshold: boolean; // Auto-adjust threshold to noise floor
}

const DEFAULT_VAD_CONFIG: VADConfig = {
  sensitivity: 5,
  hangoverMs: 200,
  minSpeechMs: 40,
  adaptiveThreshold: true,
};

/**
 * Voice Activity Detector
 */
export class VADProcessor {
  private config: VADConfig;
  private noiseFloor = 0;
  private threshold = 0;
  private speechFrames = 0;
  private hangoverFrames = 0;
  private isSpeaking = false;
  private hangoverRemaining = 0;

  constructor(config: Partial<VADConfig> = {}) {
    this.config = { ...DEFAULT_VAD_CONFIG, ...config };
    this.updateThreshold();
  }

  /**
   * Update VAD threshold based on sensitivity
   */
  private updateThreshold(): void {
    // Map sensitivity 1-10 to threshold multiplier
    // Higher sensitivity = lower threshold multiplier
    const multiplier = 2.5 - (this.config.sensitivity / 10) * 1.5;
    this.threshold = Math.max(100, this.noiseFloor * multiplier);
  }

  /**
   * Set sensitivity (1-10)
   */
  setSensitivity(sensitivity: number): void {
    this.config.sensitivity = Math.max(1, Math.min(10, sensitivity));
    this.updateThreshold();
  }

  /**
   * Process a frame and return VAD decision
   *
   * @param samples 160 16-bit samples (20ms)
   * @returns true if voice activity detected
   */
  process(samples: Int16Array): boolean {
    // Calculate frame energy (RMS)
    let sumSquares = 0;
    for (let i = 0; i < samples.length; i++) {
      sumSquares += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sumSquares / samples.length);

    // Update noise floor (adaptive threshold)
    if (this.config.adaptiveThreshold) {
      if (rms < this.noiseFloor || this.noiseFloor === 0) {
        // Decay noise floor towards current level
        this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
      } else if (!this.isSpeaking) {
        // Slowly adapt up during silence
        this.noiseFloor = this.noiseFloor * 0.999 + rms * 0.001;
      }
      this.updateThreshold();
    }

    // Check if energy exceeds threshold
    const speechDetected = rms > this.threshold;

    // State machine with hangover
    if (speechDetected) {
      this.speechFrames++;
      this.hangoverRemaining = Math.ceil(this.config.hangoverMs / VOICE_FRAME_MS);

      // Require minimum speech duration
      const minFrames = Math.ceil(this.config.minSpeechMs / VOICE_FRAME_MS);
      if (this.speechFrames >= minFrames) {
        this.isSpeaking = true;
      }
    } else {
      if (this.isSpeaking) {
        // In hangover period
        if (this.hangoverRemaining > 0) {
          this.hangoverRemaining--;
        } else {
          // End of speech
          this.isSpeaking = false;
          this.speechFrames = 0;
        }
      } else {
        this.speechFrames = 0;
      }
    }

    return this.isSpeaking;
  }

  /**
   * Get current energy threshold
   */
  getThreshold(): number {
    return this.threshold;
  }

  /**
   * Get current noise floor
   */
  getNoiseFloor(): number {
    return this.noiseFloor;
  }

  /**
   * Check if currently speaking
   */
  get speaking(): boolean {
    return this.isSpeaking;
  }

  /**
   * Reset VAD state
   */
  reset(): void {
    this.speechFrames = 0;
    this.hangoverRemaining = 0;
    this.isSpeaking = false;
    // Keep noise floor estimate
  }

  /**
   * Reset noise floor (call when switching devices)
   */
  resetNoiseFloor(): void {
    this.noiseFloor = 0;
    this.updateThreshold();
  }
}

/**
 * Calculate frame energy (RMS)
 */
export function calculateEnergy(samples: Int16Array): number {
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    sumSquares += samples[i] * samples[i];
  }
  return Math.sqrt(sumSquares / samples.length);
}

/**
 * Calculate peak amplitude
 */
export function calculatePeak(samples: Int16Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) peak = abs;
  }
  return peak;
}
