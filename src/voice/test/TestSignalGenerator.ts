/**
 * TestSignalGenerator - Generate test audio signals for voice chat testing
 *
 * Generates various test signals to verify the voice pipeline:
 * - Sine waves at different frequencies
 * - Chirps (frequency sweeps)
 * - DTMF tones
 * - White noise
 * - Silence
 */

import { VOICE_SAMPLE_RATE, VOICE_FRAME_SAMPLES } from '../types.js';

export type SignalType = 'sine' | 'chirp' | 'dtmf' | 'noise' | 'silence' | 'speech_like';

export interface SignalConfig {
  type: SignalType;
  frequency?: number;       // For sine wave
  startFreq?: number;       // For chirp
  endFreq?: number;         // For chirp
  dtmfDigit?: string;       // For DTMF (0-9, *, #)
  amplitude?: number;       // 0-1, default 0.5
  durationMs?: number;      // Total duration
}

// DTMF frequency pairs
const DTMF_FREQS: Record<string, [number, number]> = {
  '1': [697, 1209], '2': [697, 1336], '3': [697, 1477],
  '4': [770, 1209], '5': [770, 1336], '6': [770, 1477],
  '7': [852, 1209], '8': [852, 1336], '9': [852, 1477],
  '*': [941, 1209], '0': [941, 1336], '#': [941, 1477],
};

/**
 * Test signal generator
 */
export class TestSignalGenerator {
  private config: SignalConfig;
  private sampleIndex: number = 0;
  private totalSamples: number;

  constructor(config: SignalConfig) {
    this.config = {
      amplitude: 0.5,
      frequency: 440,
      startFreq: 200,
      endFreq: 2000,
      dtmfDigit: '5',
      durationMs: 5000,
      ...config,
    };
    this.totalSamples = Math.floor((this.config.durationMs! / 1000) * VOICE_SAMPLE_RATE);
  }

  /**
   * Generate next frame of samples
   * Returns null when duration is exceeded
   */
  nextFrame(): Int16Array | null {
    if (this.sampleIndex >= this.totalSamples) {
      return null;
    }

    const samples = new Int16Array(VOICE_FRAME_SAMPLES);
    const amplitude = this.config.amplitude! * 32767;

    for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
      const globalIndex = this.sampleIndex + i;
      if (globalIndex >= this.totalSamples) {
        samples[i] = 0;
        continue;
      }

      const t = globalIndex / VOICE_SAMPLE_RATE;
      let value = 0;

      switch (this.config.type) {
        case 'sine':
          value = Math.sin(2 * Math.PI * this.config.frequency! * t);
          break;

        case 'chirp': {
          // Linear frequency sweep
          const progress = globalIndex / this.totalSamples;
          const freq = this.config.startFreq! + (this.config.endFreq! - this.config.startFreq!) * progress;
          // Integrate frequency to get phase
          const phase = 2 * Math.PI * (this.config.startFreq! * t +
            0.5 * (this.config.endFreq! - this.config.startFreq!) * t * t / (this.totalSamples / VOICE_SAMPLE_RATE));
          value = Math.sin(phase);
          break;
        }

        case 'dtmf': {
          const [f1, f2] = DTMF_FREQS[this.config.dtmfDigit!] || [697, 1209];
          value = 0.5 * (Math.sin(2 * Math.PI * f1 * t) + Math.sin(2 * Math.PI * f2 * t));
          break;
        }

        case 'noise':
          value = Math.random() * 2 - 1;
          break;

        case 'silence':
          value = 0;
          break;

        case 'speech_like': {
          // Simulate speech-like signal with formants and modulation
          const f0 = 150 + 50 * Math.sin(2 * Math.PI * 3 * t);  // Pitch ~150Hz with vibrato
          const formant1 = 500;
          const formant2 = 1500;
          const formant3 = 2500;

          // Amplitude modulation to simulate syllables
          const ampMod = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);

          // Combine harmonics with formant emphasis
          value = ampMod * (
            0.5 * Math.sin(2 * Math.PI * f0 * t) +
            0.3 * Math.sin(2 * Math.PI * formant1 * t) * Math.exp(-0.5) +
            0.15 * Math.sin(2 * Math.PI * formant2 * t) * Math.exp(-1) +
            0.05 * Math.sin(2 * Math.PI * formant3 * t) * Math.exp(-1.5)
          );
          break;
        }
      }

      samples[i] = Math.round(value * amplitude);
    }

    this.sampleIndex += VOICE_FRAME_SAMPLES;
    return samples;
  }

  /**
   * Reset to beginning
   */
  reset(): void {
    this.sampleIndex = 0;
  }

  /**
   * Check if finished
   */
  get isFinished(): boolean {
    return this.sampleIndex >= this.totalSamples;
  }

  /**
   * Get progress (0-1)
   */
  get progress(): number {
    return Math.min(1, this.sampleIndex / this.totalSamples);
  }

  /**
   * Get elapsed time in ms
   */
  get elapsedMs(): number {
    return (this.sampleIndex / VOICE_SAMPLE_RATE) * 1000;
  }
}

/**
 * Create a sequence of test signals
 */
export class TestSignalSequence {
  private generators: TestSignalGenerator[] = [];
  private currentIndex: number = 0;

  constructor(configs: SignalConfig[]) {
    this.generators = configs.map(c => new TestSignalGenerator(c));
  }

  /**
   * Get next frame from the sequence
   */
  nextFrame(): Int16Array | null {
    while (this.currentIndex < this.generators.length) {
      const frame = this.generators[this.currentIndex].nextFrame();
      if (frame) return frame;
      this.currentIndex++;
    }
    return null;
  }

  /**
   * Reset sequence
   */
  reset(): void {
    this.currentIndex = 0;
    for (const gen of this.generators) {
      gen.reset();
    }
  }

  /**
   * Check if finished
   */
  get isFinished(): boolean {
    return this.currentIndex >= this.generators.length;
  }
}

/**
 * Create a standard test signal sequence
 */
export function createStandardTestSequence(): TestSignalSequence {
  return new TestSignalSequence([
    // Start with silence
    { type: 'silence', durationMs: 500 },
    // 440Hz sine wave (A4 note)
    { type: 'sine', frequency: 440, durationMs: 1000, amplitude: 0.6 },
    // Short silence
    { type: 'silence', durationMs: 200 },
    // 880Hz sine wave (A5 note)
    { type: 'sine', frequency: 880, durationMs: 1000, amplitude: 0.6 },
    // Short silence
    { type: 'silence', durationMs: 200 },
    // Frequency chirp
    { type: 'chirp', startFreq: 200, endFreq: 1500, durationMs: 2000, amplitude: 0.5 },
    // Short silence
    { type: 'silence', durationMs: 200 },
    // Speech-like signal
    { type: 'speech_like', durationMs: 2000, amplitude: 0.7 },
    // End with silence
    { type: 'silence', durationMs: 500 },
  ]);
}

/**
 * Create a unique identifier signal for a client
 * Uses different DTMF tones to identify each client
 */
export function createClientIdentifierSequence(clientIndex: number): TestSignalSequence {
  const digits = '0123456789*#';
  const digit1 = digits[clientIndex % digits.length];
  const digit2 = digits[(clientIndex + 1) % digits.length];

  return new TestSignalSequence([
    { type: 'silence', durationMs: 100 },
    // Play two DTMF tones to identify client
    { type: 'dtmf', dtmfDigit: digit1, durationMs: 200, amplitude: 0.6 },
    { type: 'silence', durationMs: 100 },
    { type: 'dtmf', dtmfDigit: digit2, durationMs: 200, amplitude: 0.6 },
    { type: 'silence', durationMs: 100 },
    // Then speech-like signal
    { type: 'speech_like', durationMs: 1500, amplitude: 0.5 },
    { type: 'silence', durationMs: 200 },
  ]);
}
