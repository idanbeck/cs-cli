/**
 * VoicePlayback - Audio output for voice chat
 *
 * Streams decoded voice audio to the speaker using the existing speaker package.
 * Handles stereo output at 8kHz 16-bit.
 */

import Speaker from 'speaker';
import { Readable } from 'stream';
import { VOICE_SAMPLE_RATE, VOICE_FRAME_SAMPLES, VOICE_FRAME_MS } from './types.js';

/**
 * Voice playback configuration
 */
export interface VoicePlaybackConfig {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  bufferMs: number;
}

const DEFAULT_PLAYBACK_CONFIG: VoicePlaybackConfig = {
  sampleRate: VOICE_SAMPLE_RATE,
  channels: 2,  // Stereo
  bitDepth: 16,
  bufferMs: 40, // ~2 frames
};

/**
 * Voice audio playback handler
 */
export class VoicePlayback {
  private config: VoicePlaybackConfig;
  private speaker: Speaker | null = null;
  private readable: Readable | null = null;
  private isPlaying = false;
  private pendingFrames: Int16Array[] = [];
  private isPushing = false;

  constructor(config: Partial<VoicePlaybackConfig> = {}) {
    this.config = { ...DEFAULT_PLAYBACK_CONFIG, ...config };
  }

  /**
   * Start playback
   */
  start(): void {
    if (this.isPlaying) return;

    try {
      // Create speaker
      this.speaker = new Speaker({
        channels: this.config.channels,
        bitDepth: this.config.bitDepth,
        sampleRate: this.config.sampleRate,
        signed: true,
      });

      // Create readable stream that pulls from our buffer
      this.readable = new Readable({
        read: () => {
          this.pushAudio();
        },
        highWaterMark: this.config.bufferMs * this.config.sampleRate * this.config.channels * 2 / 1000,
      });

      // Handle speaker events silently
      this.speaker.on('error', () => {
        // Silently ignore speaker errors
      });

      this.speaker.on('close', () => {
        this.isPlaying = false;
      });

      // Pipe readable to speaker
      this.readable.pipe(this.speaker);
      this.isPlaying = true;

    } catch (error) {
      console.error('[VoicePlayback] Failed to start:', error);
      this.isPlaying = false;
    }
  }

  /**
   * Push audio data to the stream
   */
  private pushAudio(): void {
    if (this.isPushing || !this.readable) return;
    this.isPushing = true;

    try {
      // Push all pending frames
      while (this.pendingFrames.length > 0) {
        const frame = this.pendingFrames.shift()!;
        const buffer = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
        const shouldContinue = this.readable.push(buffer);

        if (!shouldContinue) {
          break;
        }
      }

      // If no frames available, push silence to keep stream alive
      if (this.pendingFrames.length === 0 && this.isPlaying) {
        const silenceSize = VOICE_FRAME_SAMPLES * this.config.channels * 2;
        const silence = Buffer.alloc(silenceSize, 0);
        this.readable.push(silence);
      }
    } catch {
      // Ignore push errors
    }

    this.isPushing = false;
  }

  /**
   * Queue a stereo audio frame for playback
   *
   * @param samples Stereo interleaved 16-bit samples (320 samples = 160 stereo pairs)
   */
  queueFrame(samples: Int16Array): void {
    if (!this.isPlaying) {
      this.start();
    }

    // Add to pending frames
    this.pendingFrames.push(samples);

    // Prevent buffer overflow
    const maxFrames = Math.ceil(200 / VOICE_FRAME_MS); // Max 200ms buffer
    while (this.pendingFrames.length > maxFrames) {
      this.pendingFrames.shift();
    }
  }

  /**
   * Stop playback
   */
  stop(): void {
    if (!this.isPlaying) return;

    try {
      if (this.readable) {
        this.readable.push(null); // Signal end
        this.readable = null;
      }

      if (this.speaker) {
        this.speaker.end();
        this.speaker = null;
      }
    } catch {
      // Ignore stop errors
    }

    this.isPlaying = false;
    this.pendingFrames = [];
  }

  /**
   * Check if playing
   */
  get playing(): boolean {
    return this.isPlaying;
  }

  /**
   * Get current buffer depth in frames
   */
  get bufferDepth(): number {
    return this.pendingFrames.length;
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.stop();
  }
}

// Singleton instance
let playbackInstance: VoicePlayback | null = null;

/**
 * Get shared VoicePlayback instance
 */
export function getVoicePlayback(): VoicePlayback {
  if (!playbackInstance) {
    playbackInstance = new VoicePlayback();
  }
  return playbackInstance;
}

/**
 * Destroy shared VoicePlayback
 */
export function destroyVoicePlayback(): void {
  if (playbackInstance) {
    playbackInstance.destroy();
    playbackInstance = null;
  }
}
