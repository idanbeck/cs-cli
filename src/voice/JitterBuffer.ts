/**
 * JitterBuffer - Packet reordering and jitter smoothing
 *
 * Handles out-of-order packets and provides smooth audio playback.
 * Target latency: 60-100ms (3-5 frames at 20ms each)
 */

import {
  JitterBufferEntry,
  DecodedVoiceFrame,
  VOICE_FRAME_SAMPLES,
  VOICE_FRAME_MS,
} from './types.js';

/**
 * Jitter buffer configuration
 */
export interface JitterBufferConfig {
  minLatencyMs: number;    // Minimum buffer depth
  maxLatencyMs: number;    // Maximum buffer depth
  adaptiveDepth: boolean;  // Auto-adjust based on jitter
}

const DEFAULT_JITTER_CONFIG: JitterBufferConfig = {
  minLatencyMs: 60,
  maxLatencyMs: 100,
  adaptiveDepth: true,
};

/**
 * Jitter buffer for a single audio stream
 */
export class JitterBuffer {
  private config: JitterBufferConfig;
  private buffer: Map<number, JitterBufferEntry> = new Map();
  private nextSequence = 0;
  private lastPlayedSequence = -1;
  private targetDepth: number;  // Target frames in buffer
  private jitterEstimate = 0;   // Smoothed jitter estimate in ms
  private lastReceiveTime = 0;
  private lastSequenceReceived = -1;
  private isActive = false;
  private silenceCount = 0;

  constructor(config: Partial<JitterBufferConfig> = {}) {
    this.config = { ...DEFAULT_JITTER_CONFIG, ...config };
    this.targetDepth = Math.ceil(this.config.minLatencyMs / VOICE_FRAME_MS);
  }

  /**
   * Add a received frame to the buffer
   */
  push(frame: DecodedVoiceFrame): void {
    const now = Date.now();

    // Track jitter
    if (this.lastReceiveTime > 0 && this.lastSequenceReceived >= 0) {
      const expectedInterval = (frame.sequence - this.lastSequenceReceived) * VOICE_FRAME_MS;
      const actualInterval = now - this.lastReceiveTime;
      const jitter = Math.abs(actualInterval - expectedInterval);

      // Exponential moving average
      this.jitterEstimate = this.jitterEstimate * 0.9 + jitter * 0.1;

      // Adapt buffer depth based on jitter
      if (this.config.adaptiveDepth) {
        this.adaptDepth();
      }
    }

    this.lastReceiveTime = now;
    this.lastSequenceReceived = frame.sequence;

    // Initialize sequence tracking on first frame
    if (!this.isActive) {
      this.nextSequence = frame.sequence;
      this.isActive = true;
      this.silenceCount = 0;
    }

    // Reject very old packets
    if (frame.sequence < this.nextSequence - 10) {
      return; // Too old, discard
    }

    // Add to buffer
    this.buffer.set(frame.sequence, {
      sequence: frame.sequence,
      timestamp: frame.timestamp,
      samples: frame.samples,
      received: now,
    });

    // Cleanup old entries
    this.cleanup();
  }

  /**
   * Adapt buffer depth based on jitter
   */
  private adaptDepth(): void {
    const minFrames = Math.ceil(this.config.minLatencyMs / VOICE_FRAME_MS);
    const maxFrames = Math.ceil(this.config.maxLatencyMs / VOICE_FRAME_MS);

    // Add frames based on jitter
    const jitterFrames = Math.ceil(this.jitterEstimate / VOICE_FRAME_MS);
    this.targetDepth = Math.min(maxFrames, Math.max(minFrames, minFrames + jitterFrames));
  }

  /**
   * Pop the next frame for playback
   * Returns null if buffer not ready, or generates silence frame on packet loss
   */
  pop(): Int16Array | null {
    // Check if buffer has enough depth
    if (!this.isReady()) {
      return null;
    }

    const entry = this.buffer.get(this.nextSequence);

    if (entry) {
      // Got the expected frame
      this.buffer.delete(this.nextSequence);
      this.lastPlayedSequence = this.nextSequence;
      this.nextSequence++;
      this.silenceCount = 0;
      return entry.samples;
    } else {
      // Packet loss - generate silence or use concealment
      this.lastPlayedSequence = this.nextSequence;
      this.nextSequence++;
      this.silenceCount++;

      // After too many lost packets, reset
      if (this.silenceCount > 5) {
        this.reset();
        return null;
      }

      // Return silence frame (could be enhanced with PLC)
      return new Int16Array(VOICE_FRAME_SAMPLES);
    }
  }

  /**
   * Check if buffer has enough data to start playback
   */
  isReady(): boolean {
    if (!this.isActive) return false;

    // Count available frames
    let available = 0;
    for (let i = 0; i < this.targetDepth + 2; i++) {
      if (this.buffer.has(this.nextSequence + i)) {
        available++;
      }
    }

    return available >= this.targetDepth;
  }

  /**
   * Get current buffer depth (frames)
   */
  getDepth(): number {
    return this.buffer.size;
  }

  /**
   * Get target buffer depth
   */
  getTargetDepth(): number {
    return this.targetDepth;
  }

  /**
   * Get estimated jitter in ms
   */
  getJitterEstimate(): number {
    return this.jitterEstimate;
  }

  /**
   * Check if stream is active
   */
  get active(): boolean {
    return this.isActive;
  }

  /**
   * Cleanup old entries
   */
  private cleanup(): void {
    const maxEntries = Math.ceil(this.config.maxLatencyMs / VOICE_FRAME_MS) + 5;

    // Remove entries older than nextSequence - 5
    for (const seq of this.buffer.keys()) {
      if (seq < this.nextSequence - 5) {
        this.buffer.delete(seq);
      }
    }

    // If buffer is too large, advance nextSequence
    if (this.buffer.size > maxEntries) {
      const sequences = Array.from(this.buffer.keys()).sort((a, b) => a - b);
      this.nextSequence = sequences[sequences.length - this.targetDepth];
    }
  }

  /**
   * Reset buffer state
   */
  reset(): void {
    this.buffer.clear();
    this.nextSequence = 0;
    this.lastPlayedSequence = -1;
    this.isActive = false;
    this.silenceCount = 0;
    // Keep jitter estimate
  }

  /**
   * Full reset including jitter estimate
   */
  fullReset(): void {
    this.reset();
    this.jitterEstimate = 0;
    this.lastReceiveTime = 0;
    this.lastSequenceReceived = -1;
    this.targetDepth = Math.ceil(this.config.minLatencyMs / VOICE_FRAME_MS);
  }
}

/**
 * Manager for multiple jitter buffers (one per player)
 */
export class JitterBufferManager {
  private buffers: Map<number, JitterBuffer> = new Map();
  private config: Partial<JitterBufferConfig>;

  constructor(config: Partial<JitterBufferConfig> = {}) {
    this.config = config;
  }

  /**
   * Get or create jitter buffer for a sender
   */
  getBuffer(senderId: number): JitterBuffer {
    let buffer = this.buffers.get(senderId);
    if (!buffer) {
      buffer = new JitterBuffer(this.config);
      this.buffers.set(senderId, buffer);
    }
    return buffer;
  }

  /**
   * Push frame to appropriate buffer
   */
  pushFrame(frame: DecodedVoiceFrame): void {
    const buffer = this.getBuffer(frame.senderId);
    buffer.push(frame);
  }

  /**
   * Get all active sender IDs
   */
  getActiveSenders(): number[] {
    const active: number[] = [];
    for (const [senderId, buffer] of this.buffers) {
      if (buffer.active) {
        active.push(senderId);
      }
    }
    return active;
  }

  /**
   * Remove buffer for a sender
   */
  removeBuffer(senderId: number): void {
    this.buffers.delete(senderId);
  }

  /**
   * Clear all buffers
   */
  clear(): void {
    this.buffers.clear();
  }

  /**
   * Get buffer count
   */
  get count(): number {
    return this.buffers.size;
  }
}
