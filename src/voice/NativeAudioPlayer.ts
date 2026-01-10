/**
 * NativeAudioPlayer - Audio output using macOS afplay command
 *
 * Alternative to speaker package which has issues on newer macOS.
 * Writes audio to temp files and plays them with afplay.
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Audio format
const SAMPLE_RATE = 22050;
const CHANNELS = 2;
const BIT_DEPTH = 16;

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
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * CHANNELS * (BIT_DEPTH / 8), 28);  // Byte rate
  header.writeUInt16LE(CHANNELS * (BIT_DEPTH / 8), 32);  // Block align
  header.writeUInt16LE(BIT_DEPTH, 34);

  // data chunk
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);

  return header;
}

/**
 * Native audio player using afplay
 */
export class NativeAudioPlayer {
  private tempDir: string;
  private fileCounter = 0;
  private activeProcesses: Set<ChildProcess> = new Set();
  private isPlaying = false;
  private audioQueue: Buffer[] = [];
  private currentFile: string | null = null;
  private playbackInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Create temp directory for audio files
    this.tempDir = path.join(os.tmpdir(), 'csterm-audio');
    try {
      if (!fs.existsSync(this.tempDir)) {
        fs.mkdirSync(this.tempDir, { recursive: true });
      }
    } catch {
      this.tempDir = os.tmpdir();
    }
  }

  /**
   * Play audio samples (16-bit signed stereo at 22050Hz)
   */
  play(samples: Int16Array): void {
    console.log(`[NativeAudioPlayer] play() called with ${samples.length} samples`);
    // Convert Int16Array to Buffer
    const buffer = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    this.audioQueue.push(buffer);
    console.log(`[NativeAudioPlayer] Queue size: ${this.audioQueue.length}, isPlaying: ${this.isPlaying}`);

    // Start playback if not already playing
    if (!this.isPlaying) {
      this.startPlayback();
    }
  }

  /**
   * Start continuous playback
   */
  private startPlayback(): void {
    if (this.isPlaying) return;
    this.isPlaying = true;

    // Process queue periodically
    this.playbackInterval = setInterval(() => {
      this.processQueue();
    }, 100);
  }

  /**
   * Process audio queue
   */
  private processQueue(): void {
    if (this.audioQueue.length === 0) return;

    // Collect all queued audio
    const buffers = this.audioQueue.splice(0);
    const totalLength = buffers.reduce((sum, b) => sum + b.length, 0);
    const combined = Buffer.concat(buffers, totalLength);

    console.log(`[NativeAudioPlayer] processQueue: ${buffers.length} buffers, ${totalLength} bytes total`);

    // Create WAV file
    const header = createWavHeader(combined.length);
    const wavData = Buffer.concat([header, combined]);

    // Write to temp file
    const filename = path.join(this.tempDir, `voice_${this.fileCounter++}.wav`);

    try {
      fs.writeFileSync(filename, wavData);
      console.log(`[NativeAudioPlayer] Wrote ${wavData.length} bytes to ${filename}`);

      // Play with afplay
      const proc = spawn('afplay', [filename], {
        stdio: 'ignore',
        detached: true
      });

      console.log(`[NativeAudioPlayer] Spawned afplay for ${filename}`);
      this.activeProcesses.add(proc);

      proc.on('exit', () => {
        this.activeProcesses.delete(proc);
        // Clean up temp file
        try {
          fs.unlinkSync(filename);
        } catch {}
      });

      proc.on('error', (err) => {
        console.log(`[NativeAudioPlayer] afplay error: ${err.message}`);
        this.activeProcesses.delete(proc);
      });

      // Unref so it doesn't keep process alive
      proc.unref();
    } catch (err) {
      console.log(`[NativeAudioPlayer] Error: ${err}`);
    }
  }

  /**
   * Play a simple test tone
   */
  playTestTone(): void {
    const duration = 0.5;
    const samples = Math.floor(SAMPLE_RATE * duration);
    const buffer = new Int16Array(samples * CHANNELS);

    for (let i = 0; i < samples; i++) {
      const t = i / SAMPLE_RATE;
      // 440Hz sine wave with envelope
      const envelope = Math.min(1, Math.min(t * 10, (duration - t) * 10));
      const sample = Math.sin(2 * Math.PI * 440 * t) * 16000 * envelope;
      buffer[i * 2] = sample;      // Left
      buffer[i * 2 + 1] = sample;  // Right
    }

    this.play(buffer);
  }

  /**
   * Stop all playback
   */
  stop(): void {
    if (this.playbackInterval) {
      clearInterval(this.playbackInterval);
      this.playbackInterval = null;
    }

    this.isPlaying = false;
    this.audioQueue = [];

    // Kill active processes
    for (const proc of this.activeProcesses) {
      try {
        proc.kill();
      } catch {}
    }
    this.activeProcesses.clear();
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
          fs.unlinkSync(path.join(this.tempDir, file));
        }
      }
    } catch {}
  }
}

// Singleton
let playerInstance: NativeAudioPlayer | null = null;

export function getNativeAudioPlayer(): NativeAudioPlayer {
  if (!playerInstance) {
    playerInstance = new NativeAudioPlayer();
  }
  return playerInstance;
}

export function destroyNativeAudioPlayer(): void {
  if (playerInstance) {
    playerInstance.destroy();
    playerInstance = null;
  }
}
