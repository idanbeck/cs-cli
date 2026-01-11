/**
 * VoicePlayback - Streaming audio output for voice chat
 *
 * Uses Speaker with direct write for low-latency continuous playback.
 */

import Speaker from 'speaker';
import { VOICE_SAMPLE_RATE } from './types.js';
import { voiceLog } from './voiceLog.js';

// Output format - 16-bit stereo at voice sample rate
const OUTPUT_SAMPLE_RATE = VOICE_SAMPLE_RATE; // 8kHz
const OUTPUT_CHANNELS = 2;
const OUTPUT_BIT_DEPTH = 16;

/**
 * Streaming voice audio playback using direct writes to Speaker
 */
export class VoicePlayback {
  private speaker: Speaker | null = null;
  private isPlaying = false;

  // Stats
  private frameCount = 0;
  private lastLogTime = 0;
  private totalBytesWritten = 0;

  constructor() {}

  /**
   * Start the audio stream
   */
  start(): void {
    if (this.isPlaying) return;

    voiceLog(`[VoicePlayback] Starting streaming playback at ${OUTPUT_SAMPLE_RATE}Hz stereo`);

    try {
      // Create the speaker - it will start playing when we write to it
      this.speaker = new Speaker({
        channels: OUTPUT_CHANNELS,
        bitDepth: OUTPUT_BIT_DEPTH,
        sampleRate: OUTPUT_SAMPLE_RATE,
        signed: true,
      });

      // Handle speaker events
      this.speaker.on('error', (err: Error) => {
        voiceLog(`[VoicePlayback] Speaker error: ${err.message}`);
      });

      this.speaker.on('close', () => {
        voiceLog(`[VoicePlayback] Speaker closed, total bytes: ${this.totalBytesWritten}`);
        this.isPlaying = false;
        this.speaker = null;
      });

      this.speaker.on('drain', () => {
        // Speaker buffer drained - ready for more data
      });

      this.isPlaying = true;

    } catch (err) {
      voiceLog(`[VoicePlayback] Failed to start: ${err}`);
      this.isPlaying = false;
    }
  }

  /**
   * Queue a stereo audio frame for playback
   *
   * @param samples Stereo interleaved 16-bit samples at 8kHz
   */
  queueFrame(samples: Int16Array): void {
    if (!this.speaker) {
      this.start();
    }

    if (!this.speaker || !this.isPlaying) {
      return;
    }

    this.frameCount++;

    // Convert Int16Array to Buffer
    const buffer = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);

    // Write directly to speaker
    try {
      const canWrite = this.speaker.write(buffer);
      this.totalBytesWritten += buffer.length;

      if (!canWrite) {
        // Buffer is full, speaker will emit 'drain' when ready
        // For now we just drop frames if buffer is full
      }
    } catch (err) {
      voiceLog(`[VoicePlayback] Write error: ${err}`);
    }

    // Log stats periodically
    const now = Date.now();
    if (now - this.lastLogTime > 5000) {
      voiceLog(`[VoicePlayback] Stats: frames=${this.frameCount}, totalBytes=${this.totalBytesWritten}`);
      this.lastLogTime = now;
    }
  }

  /**
   * Stop playback
   */
  stop(): void {
    if (!this.isPlaying) return;

    voiceLog(`[VoicePlayback] Stopping playback`);

    if (this.speaker) {
      try {
        this.speaker.end();
      } catch {}
      this.speaker = null;
    }

    this.isPlaying = false;
  }

  /**
   * Check if playing
   */
  get playing(): boolean {
    return this.isPlaying;
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
