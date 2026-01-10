/**
 * VoiceClient - Binary WebSocket frame handling for voice chat
 *
 * Handles encoding/sending voice frames and receiving/decoding frames from server.
 * Uses the existing GameClient WebSocket connection.
 */

import {
  VoiceFrame,
  DecodedVoiceFrame,
  VoiceEventCallback,
  VoiceEvent,
  VOICE_FRAME_TYPE,
  VOICE_FLAG_VAD,
  VOICE_FLAG_TEAM_ONLY,
  serializeVoiceFrame,
  deserializeVoiceFrame,
  truncatePlayerId,
  isVoiceFrame,
} from './types.js';
import { Codec2, getCodec2Encoder } from './Codec2.js';
import { JitterBuffer, JitterBufferManager } from './JitterBuffer.js';

// WebSocket binary send callback type
type SendBinaryCallback = (data: Uint8Array) => void;

/**
 * Voice client for sending and receiving voice frames
 */
export class VoiceClient {
  private playerId: string = '';
  private senderIdTrunc: number = 0;
  private sequenceNumber: number = 0;
  private startTime: number = 0;
  private sendBinary: SendBinaryCallback | null = null;
  private codec: Codec2;
  private jitterManager: JitterBufferManager;
  private eventCallbacks: Set<VoiceEventCallback> = new Set();
  private teamOnly: boolean = false;

  constructor() {
    this.codec = getCodec2Encoder();
    this.jitterManager = new JitterBufferManager();
    this.startTime = Date.now();
  }

  /**
   * Set local player ID
   */
  setPlayerId(playerId: string): void {
    this.playerId = playerId;
    this.senderIdTrunc = truncatePlayerId(playerId);
  }

  /**
   * Set send callback for binary WebSocket messages
   */
  setSendCallback(callback: SendBinaryCallback): void {
    this.sendBinary = callback;
  }

  /**
   * Set team-only mode
   */
  setTeamOnly(teamOnly: boolean): void {
    this.teamOnly = teamOnly;
  }

  /**
   * Register event callback
   */
  onEvent(callback: VoiceEventCallback): () => void {
    this.eventCallbacks.add(callback);
    return () => this.eventCallbacks.delete(callback);
  }

  /**
   * Emit event to all callbacks
   */
  private emitEvent(event: VoiceEvent): void {
    for (const callback of this.eventCallbacks) {
      try {
        callback(event);
      } catch (error) {
        console.error('[VoiceClient] Event callback error:', error);
      }
    }
  }

  /**
   * Send encoded voice frame
   *
   * @param samples 160 16-bit samples (20ms at 8kHz)
   * @param vadActive Whether voice activity was detected
   */
  sendVoice(samples: Int16Array, vadActive: boolean): void {
    if (!this.sendBinary) {
      return;  // Silent - callback not set yet
    }
    if (!this.codec || !this.codec.isInitialized) {
      return;  // Silent - codec not ready yet
    }

    // Encode samples - wrap in try-catch to prevent crashes
    let payload: Uint8Array;
    try {
      payload = this.codec.encode(samples);
    } catch (error) {
      console.error('[VoiceClient] Encode error:', error);
      return;
    }

    if (!payload || payload.length === 0) {
      return;  // Encoding failed
    }

    // Build flags
    let flags = 0;
    if (vadActive) flags |= VOICE_FLAG_VAD;
    if (this.teamOnly) flags |= VOICE_FLAG_TEAM_ONLY;

    // Calculate timestamp offset from start
    const timestampOffset = (Date.now() - this.startTime) & 0xFFFF;

    // Create frame
    const frame: VoiceFrame = {
      frameType: VOICE_FRAME_TYPE,
      flags,
      senderId: this.senderIdTrunc,
      sequence: this.sequenceNumber++,
      timestampOffset,
      payload,
    };

    // Serialize and send
    const data = serializeVoiceFrame(frame);
    this.sendBinary(data);
  }

  /**
   * Handle received binary data
   * Returns true if it was a voice frame
   */
  handleBinaryData(data: Uint8Array): boolean {
    if (!isVoiceFrame(data)) {
      return false;
    }

    const frame = deserializeVoiceFrame(data);
    if (!frame) {
      console.warn('[VoiceClient] Failed to deserialize voice frame');
      return false;
    }

    // Ignore our own frames
    if (frame.senderId === this.senderIdTrunc) {
      return true;
    }

    // Decode audio - wrap in try-catch to prevent crashes
    let samples: Int16Array;
    try {
      if (!this.codec || !this.codec.isInitialized) {
        console.warn('[VoiceClient] Codec not ready, dropping frame');
        return true;  // Codec not ready
      }
      samples = this.codec.decode(frame.payload);
      if (!samples || samples.length === 0) {
        console.warn('[VoiceClient] Decode returned empty samples');
        return true;  // Decoding failed
      }
    } catch (error) {
      console.error('[VoiceClient] Decode error:', error);
      return true;
    }

    // Create decoded frame
    const decoded: DecodedVoiceFrame = {
      senderId: frame.senderId,
      sequence: frame.sequence,
      timestamp: frame.timestampOffset,
      samples,
      vadActive: (frame.flags & VOICE_FLAG_VAD) !== 0,
      teamOnly: (frame.flags & VOICE_FLAG_TEAM_ONLY) !== 0,
    };

    // Push to jitter buffer
    this.jitterManager.pushFrame(decoded);

    // Log receipt (every 50 frames to avoid spam)
    if (frame.sequence % 50 === 0) {
      console.log(`[VoiceClient] Received voice frame from ${frame.senderId.toString(16)}, seq=${frame.sequence}, buffers=${this.jitterManager.count}`);
    }

    return true;
  }

  /**
   * Get next frame from jitter buffer for a sender
   * Returns null if not ready
   */
  getNextFrame(senderId: number): Int16Array | null {
    const buffer = this.jitterManager.getBuffer(senderId);
    return buffer.pop();
  }

  /**
   * Get all active sender IDs
   */
  getActiveSenders(): number[] {
    return this.jitterManager.getActiveSenders();
  }

  /**
   * Check if buffer is ready for a sender
   */
  isBufferReady(senderId: number): boolean {
    const buffer = this.jitterManager.getBuffer(senderId);
    return buffer.isReady();
  }

  /**
   * Reset state for a sender
   */
  resetSender(senderId: number): void {
    this.jitterManager.removeBuffer(senderId);
  }

  /**
   * Reset all state
   */
  reset(): void {
    this.jitterManager.clear();
    this.sequenceNumber = 0;
    this.startTime = Date.now();
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.reset();
    this.eventCallbacks.clear();
    this.sendBinary = null;
  }
}

// Singleton instance
let clientInstance: VoiceClient | null = null;

/**
 * Get shared VoiceClient instance
 */
export function getVoiceClient(): VoiceClient {
  if (!clientInstance) {
    clientInstance = new VoiceClient();
  }
  return clientInstance;
}

/**
 * Destroy shared VoiceClient
 */
export function destroyVoiceClient(): void {
  if (clientInstance) {
    clientInstance.destroy();
    clientInstance = null;
  }
}
