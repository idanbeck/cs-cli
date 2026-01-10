/**
 * VoicePlayback - Audio output for voice chat
 *
 * Uses afplay (macOS) for reliable audio output.
 * Upsamples from 8kHz to 22050Hz stereo 16-bit.
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { VOICE_SAMPLE_RATE, VOICE_FRAME_SAMPLES, VOICE_FRAME_MS } from './types.js';
import { voiceLog } from './voiceLog.js';

// Output format
const OUTPUT_SAMPLE_RATE = 22050;
const OUTPUT_CHANNELS = 2;
const OUTPUT_BIT_DEPTH = 16;

/**
 * Voice playback configuration
 */
export interface VoicePlaybackConfig {
  sampleRate: number;
  channels: number;
  bufferMs: number;
}

const DEFAULT_PLAYBACK_CONFIG: VoicePlaybackConfig = {
  sampleRate: OUTPUT_SAMPLE_RATE,
  channels: OUTPUT_CHANNELS,
  bufferMs: 80,  // Buffer 80ms before playing
};

/**
 * Create a WAV file header
 */
function createWavHeader(dataLength: number): Buffer {
  const header = Buffer.alloc(44);

  // RIFF header
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);  // File size - 8
  header.write('WAVE', 8);

  // fmt chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);  // Chunk size
  header.writeUInt16LE(1, 20);   // Audio format (PCM)
  header.writeUInt16LE(OUTPUT_CHANNELS, 22);
  header.writeUInt32LE(OUTPUT_SAMPLE_RATE, 24);
  header.writeUInt32LE(OUTPUT_SAMPLE_RATE * OUTPUT_CHANNELS * (OUTPUT_BIT_DEPTH / 8), 28);  // Byte rate
  header.writeUInt16LE(OUTPUT_CHANNELS * (OUTPUT_BIT_DEPTH / 8), 32);  // Block align
  header.writeUInt16LE(OUTPUT_BIT_DEPTH, 34);

  // data chunk
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);

  return header;
}

/**
 * Voice audio playback handler using afplay
 */
export class VoicePlayback {
  private config: VoicePlaybackConfig;
  private isPlaying = false;
  private pendingFrames: Buffer[] = [];  // Stores resampled 16-bit stereo buffers
  private frameCount = 0;
  private lastPlayTime = 0;
  private fileCounter = 0;

  // Temp directory and active processes
  private tempDir: string;
  private activeProcesses: Set<ChildProcess> = new Set();

  constructor(config: Partial<VoicePlaybackConfig> = {}) {
    this.config = { ...DEFAULT_PLAYBACK_CONFIG, ...config };

    // Create temp directory for audio files
    this.tempDir = path.join(os.tmpdir(), 'csterm-voice');
    try {
      if (!fs.existsSync(this.tempDir)) {
        fs.mkdirSync(this.tempDir, { recursive: true });
      }
    } catch {
      this.tempDir = os.tmpdir();
    }
  }

  /**
   * Start playback
   */
  start(): void {
    if (this.isPlaying) return;
    this.isPlaying = true;
  }

  /**
   * Play audio buffer using afplay
   */
  private playBuffer(samples: Buffer): void {
    try {
      // Create WAV file
      const header = createWavHeader(samples.length);
      const wavData = Buffer.concat([header, samples]);

      // Write to temp file
      const filename = path.join(this.tempDir, `voice_${this.fileCounter++}.wav`);
      fs.writeFileSync(filename, wavData);

      // Debug: log file creation
      voiceLog(`[VoicePlayback] Created WAV: ${filename} (${wavData.length} bytes)`);

      // Play with afplay
      const proc = spawn('afplay', [filename], {
        stdio: 'ignore',
        detached: true
      });

      this.activeProcesses.add(proc);

      proc.on('exit', (code) => {
        this.activeProcesses.delete(proc);
        voiceLog(`[VoicePlayback] afplay exited with code ${code}`);
        // Clean up temp file
        try {
          fs.unlinkSync(filename);
        } catch {}
      });

      proc.on('error', (err) => {
        voiceLog(`[VoicePlayback] afplay error: ${err.message}`);
        this.activeProcesses.delete(proc);
      });

      // Unref so it doesn't keep process alive
      proc.unref();
    } catch (err) {
      voiceLog(`[VoicePlayback] playBuffer error: ${err}`);
    }
  }

  /**
   * Upsample and convert stereo 16-bit 8kHz to 16-bit 22050Hz
   *
   * @param samples Stereo interleaved 16-bit samples at 8kHz
   * @returns Buffer of 16-bit stereo samples at 22050Hz
   */
  private resampleAndConvert(samples: Int16Array): Buffer {
    const ratio = OUTPUT_SAMPLE_RATE / VOICE_SAMPLE_RATE; // 22050/8000 = ~2.756
    const inputStereoSamples = samples.length / 2; // Number of stereo pairs
    const outputStereoSamples = Math.floor(inputStereoSamples * ratio);
    // 4 bytes per stereo sample (2 bytes left + 2 bytes right at 16-bit)
    const output = Buffer.alloc(outputStereoSamples * 4);

    for (let i = 0; i < outputStereoSamples; i++) {
      // Calculate source position
      const srcPos = i / ratio;
      const srcIdx = Math.floor(srcPos);
      const frac = srcPos - srcIdx;

      // Linear interpolation for left and right channels
      const srcIdxClamped = Math.min(srcIdx, inputStereoSamples - 1);
      const srcIdxNext = Math.min(srcIdx + 1, inputStereoSamples - 1);

      // Get 16-bit stereo samples
      const leftSrc = samples[srcIdxClamped * 2];
      const rightSrc = samples[srcIdxClamped * 2 + 1];
      const leftNext = samples[srcIdxNext * 2];
      const rightNext = samples[srcIdxNext * 2 + 1];

      // Interpolate
      const leftInterp = leftSrc * (1 - frac) + leftNext * frac;
      const rightInterp = rightSrc * (1 - frac) + rightNext * frac;

      // Write as 16-bit little-endian
      const leftOut = Math.max(-32768, Math.min(32767, Math.round(leftInterp)));
      const rightOut = Math.max(-32768, Math.min(32767, Math.round(rightInterp)));

      output.writeInt16LE(leftOut, i * 4);
      output.writeInt16LE(rightOut, i * 4 + 2);
    }

    return output;
  }

  /**
   * Queue a stereo audio frame for playback
   *
   * @param samples Stereo interleaved 16-bit samples (320 samples = 160 stereo pairs)
   */
  queueFrame(samples: Int16Array): void {
    voiceLog(`[VoicePlayback] queueFrame called with ${samples.length} samples`);

    if (!this.isPlaying) {
      voiceLog(`[VoicePlayback] Starting playback`);
      this.start();
    }

    this.frameCount++;

    // Debug logging - every frame for now
    let maxAmp = 0;
    for (let i = 0; i < samples.length; i++) maxAmp = Math.max(maxAmp, Math.abs(samples[i]));
    voiceLog(`[VoicePlayback] queueFrame #${this.frameCount}: ${samples.length} samples, max amp: ${maxAmp}`);

    // Resample and convert
    const converted = this.resampleAndConvert(samples);
    this.pendingFrames.push(converted);

    const now = Date.now();
    const timeSinceLastPlay = now - this.lastPlayTime;

    // Calculate buffered duration
    // 4 bytes per stereo sample at 22050Hz
    const totalBytes = this.pendingFrames.reduce((sum, b) => sum + b.length, 0);
    const bufferedMs = (totalBytes / 4) / OUTPUT_SAMPLE_RATE * 1000;

    // Play when we have enough buffered or timeout reached
    if (bufferedMs >= this.config.bufferMs || timeSinceLastPlay > 120) {
      // Combine all pending frames
      const combined = Buffer.concat(this.pendingFrames);
      this.pendingFrames = [];
      this.lastPlayTime = now;

      if (this.frameCount % 50 < 5) {
        voiceLog(`[VoicePlayback] Playing ${combined.length} bytes (${bufferedMs.toFixed(0)}ms buffered)`);
      }

      // Play using afplay
      this.playBuffer(combined);
    }
  }

  /**
   * Stop playback
   */
  stop(): void {
    if (!this.isPlaying) return;

    // Kill active processes
    for (const proc of this.activeProcesses) {
      try {
        proc.kill();
      } catch {}
    }
    this.activeProcesses.clear();

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
   * Play a test tone (440Hz for 0.5s)
   */
  playTestTone(): void {
    const duration = 0.5;
    const sampleCount = Math.floor(OUTPUT_SAMPLE_RATE * duration);
    // 16-bit stereo = 4 bytes per sample
    const samples = Buffer.alloc(sampleCount * 4);

    for (let i = 0; i < sampleCount; i++) {
      const t = i / OUTPUT_SAMPLE_RATE;
      // 440Hz sine wave with envelope
      const envelope = Math.min(1, Math.min(t * 10, (duration - t) * 10));
      const sample = Math.sin(2 * Math.PI * 440 * t) * 16000 * envelope;
      const value = Math.max(-32768, Math.min(32767, Math.round(sample)));
      samples.writeInt16LE(value, i * 4);      // Left
      samples.writeInt16LE(value, i * 4 + 2);  // Right
    }

    this.playBuffer(samples);
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.stop();

    // Clean up temp directory
    try {
      const files = fs.readdirSync(this.tempDir);
      for (const file of files) {
        if (file.startsWith('voice_')) {
          try {
            fs.unlinkSync(path.join(this.tempDir, file));
          } catch {}
        }
      }
    } catch {}
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
