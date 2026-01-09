/**
 * HeadlessVoiceClient - Headless client for testing voice chat
 *
 * Connects to server, joins a room, and transmits/receives voice data
 * without any UI. Used for automated testing.
 */

import WebSocket from 'ws';
import { Vector3 } from '../../engine/math/Vector3.js';
import {
  VoiceFrame,
  DecodedVoiceFrame,
  VOICE_FRAME_TYPE,
  VOICE_FRAME_MS,
  VOICE_FLAG_VAD,
  serializeVoiceFrame,
  deserializeVoiceFrame,
  isVoiceFrame,
  truncatePlayerId,
} from '../types.js';
import { Codec2, initializeCodec2 } from '../Codec2.js';
import { JitterBuffer } from '../JitterBuffer.js';
import { TestSignalGenerator, TestSignalSequence, SignalConfig } from './TestSignalGenerator.js';

export interface HeadlessVoiceClientConfig {
  serverUrl: string;
  playerName: string;
  roomId?: string;       // Join existing room, or create new if not specified
  position: Vector3;     // 3D position for spatial audio
  signalConfig?: SignalConfig | SignalConfig[];  // Test signal to transmit
  transmitIntervalMs?: number;  // How often to transmit (default: 20ms = frame rate)
  logLevel?: 'silent' | 'minimal' | 'verbose';
}

export interface VoiceStats {
  framesSent: number;
  framesReceived: number;
  bytesTransmitted: number;
  bytesReceived: number;
  encodeTimeMs: number;
  decodeTimeMs: number;
  packetsLost: number;
  avgJitterMs: number;
}

/**
 * Headless voice client for testing
 */
export class HeadlessVoiceClient {
  private config: HeadlessVoiceClientConfig;
  private socket: WebSocket | null = null;
  private codec: Codec2 | null = null;
  private playerId: string = '';
  private senderIdTrunc: number = 0;
  private sequenceNumber: number = 0;
  private roomId: string = '';
  private isConnected: boolean = false;
  private isInRoom: boolean = false;

  // Test signal generation
  private signalGenerator: TestSignalGenerator | TestSignalSequence | null = null;
  private transmitInterval: ReturnType<typeof setInterval> | null = null;

  // Receiving
  private jitterBuffers: Map<number, JitterBuffer> = new Map();
  private receivedFrames: Map<number, DecodedVoiceFrame[]> = new Map();

  // Stats
  private stats: VoiceStats = {
    framesSent: 0,
    framesReceived: 0,
    bytesTransmitted: 0,
    bytesReceived: 0,
    encodeTimeMs: 0,
    decodeTimeMs: 0,
    packetsLost: 0,
    avgJitterMs: 0,
  };

  // Events
  private onReadyCallbacks: (() => void)[] = [];
  private onFrameReceivedCallbacks: ((senderId: number, frame: DecodedVoiceFrame) => void)[] = [];
  private onErrorCallbacks: ((error: Error) => void)[] = [];

  constructor(config: HeadlessVoiceClientConfig) {
    this.config = {
      transmitIntervalMs: VOICE_FRAME_MS,
      logLevel: 'minimal',
      ...config,
    };
  }

  /**
   * Initialize and connect
   */
  async connect(): Promise<void> {
    this.log('verbose', `Connecting to ${this.config.serverUrl}...`);

    // Initialize codec
    this.codec = await initializeCodec2();

    // Create signal generator
    if (this.config.signalConfig) {
      if (Array.isArray(this.config.signalConfig)) {
        this.signalGenerator = new TestSignalSequence(this.config.signalConfig);
      } else {
        this.signalGenerator = new TestSignalGenerator(this.config.signalConfig);
      }
    }

    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.config.serverUrl);

      this.socket.on('open', () => {
        this.log('minimal', `Connected to ${this.config.serverUrl}`);
        this.isConnected = true;

        // Create or join room
        if (this.config.roomId) {
          this.joinRoom(this.config.roomId);
        } else {
          this.createRoom();
        }
      });

      this.socket.on('message', (data: Buffer) => {
        this.handleMessage(data);
      });

      this.socket.on('close', () => {
        this.log('minimal', 'Disconnected');
        this.isConnected = false;
        this.cleanup();
      });

      this.socket.on('error', (error) => {
        this.log('minimal', `Socket error: ${error.message}`);
        this.onErrorCallbacks.forEach(cb => cb(error));
        reject(error);
      });

      // Resolve after a short delay to allow initial messages
      setTimeout(() => {
        if (this.isConnected) {
          resolve();
        }
      }, 500);
    });
  }

  /**
   * Handle incoming message (JSON or binary)
   */
  private handleMessage(data: Buffer): void {
    // Check if it's a voice frame
    if (data.length > 0 && data[0] === VOICE_FRAME_TYPE) {
      this.handleVoiceFrame(data);
      return;
    }

    // Handle JSON message
    try {
      const message = JSON.parse(data.toString());
      this.handleJsonMessage(message);
    } catch (error) {
      this.log('verbose', `Failed to parse message: ${error}`);
    }
  }

  /**
   * Handle JSON protocol message
   */
  private handleJsonMessage(message: any): void {
    switch (message.type) {
      case 'room_joined':
        this.playerId = message.playerId;
        this.senderIdTrunc = truncatePlayerId(this.playerId);
        this.roomId = message.roomId;
        this.isInRoom = true;
        this.log('minimal', `Joined room ${this.roomId} as ${this.playerId}`);

        // Ready to go
        this.onReadyCallbacks.forEach(cb => cb());
        break;

      case 'room_list':
        this.log('verbose', `Rooms: ${JSON.stringify(message.rooms)}`);
        break;

      case 'player_joined':
        this.log('verbose', `Player joined: ${message.playerName}`);
        break;

      case 'player_left':
        this.log('verbose', `Player left: ${message.playerId}`);
        break;

      case 'room_error':
        this.log('minimal', `Room error: ${message.error}`);
        this.onErrorCallbacks.forEach(cb => cb(new Error(message.error)));
        break;

      default:
        this.log('verbose', `Unknown message type: ${message.type}`);
    }
  }

  /**
   * Handle incoming voice frame
   */
  private handleVoiceFrame(data: Buffer): void {
    const uint8 = new Uint8Array(data.buffer, data.byteOffset, data.length);
    const frame = deserializeVoiceFrame(uint8);
    if (!frame) return;

    // Ignore our own frames
    if (frame.senderId === this.senderIdTrunc) return;

    this.stats.framesReceived++;
    this.stats.bytesReceived += data.length;

    // Decode
    const startDecode = performance.now();
    let samples: Int16Array;
    try {
      samples = this.codec!.decode(frame.payload);
    } catch (error) {
      this.log('verbose', `Decode error: ${error}`);
      return;
    }
    this.stats.decodeTimeMs += performance.now() - startDecode;

    // Create decoded frame
    const decoded: DecodedVoiceFrame = {
      senderId: frame.senderId,
      sequence: frame.sequence,
      timestamp: frame.timestampOffset,
      samples,
      vadActive: (frame.flags & VOICE_FLAG_VAD) !== 0,
      teamOnly: false,
    };

    // Get or create jitter buffer for this sender
    let buffer = this.jitterBuffers.get(frame.senderId);
    if (!buffer) {
      buffer = new JitterBuffer();
      this.jitterBuffers.set(frame.senderId, buffer);
    }
    buffer.push(decoded);

    // Store for analysis
    let frames = this.receivedFrames.get(frame.senderId);
    if (!frames) {
      frames = [];
      this.receivedFrames.set(frame.senderId, frames);
    }
    frames.push(decoded);

    // Update jitter stats
    this.stats.avgJitterMs = buffer.getJitterEstimate();

    // Notify callbacks
    this.onFrameReceivedCallbacks.forEach(cb => cb(frame.senderId, decoded));

    this.log('verbose', `Received frame from ${frame.senderId}: seq=${frame.sequence}`);
  }

  /**
   * Create a room
   */
  private createRoom(): void {
    const config = {
      name: `VoiceTest-${Date.now()}`,
      map: 'dm_arena',
      mode: 'deathmatch' as const,
      maxPlayers: 10,
      botCount: 0,
      isPrivate: false,
    };

    this.send({
      type: 'create_room',
      config,
    });
  }

  /**
   * Join a room
   */
  private joinRoom(roomId: string): void {
    this.send({
      type: 'join_room',
      roomId,
      playerName: this.config.playerName,
    });
  }

  /**
   * Start transmitting test signal
   */
  startTransmitting(): void {
    if (this.transmitInterval) return;
    if (!this.signalGenerator) {
      this.log('minimal', 'No signal generator configured');
      return;
    }

    this.log('minimal', 'Starting transmission...');

    this.transmitInterval = setInterval(() => {
      this.transmitNextFrame();
    }, this.config.transmitIntervalMs!);
  }

  /**
   * Stop transmitting
   */
  stopTransmitting(): void {
    if (this.transmitInterval) {
      clearInterval(this.transmitInterval);
      this.transmitInterval = null;
      this.log('minimal', 'Stopped transmission');
    }
  }

  /**
   * Transmit a single frame
   */
  private transmitNextFrame(): void {
    if (!this.socket || !this.codec || !this.signalGenerator) return;

    // Get next frame from signal generator
    const samples = this.signalGenerator.nextFrame();
    if (!samples) {
      this.stopTransmitting();
      this.log('minimal', 'Signal sequence complete');
      return;
    }

    // Encode
    const startEncode = performance.now();
    const payload = this.codec.encode(samples);
    this.stats.encodeTimeMs += performance.now() - startEncode;

    // Create frame
    const frame: VoiceFrame = {
      frameType: VOICE_FRAME_TYPE,
      flags: VOICE_FLAG_VAD,  // Always mark as active for testing
      senderId: this.senderIdTrunc,
      sequence: this.sequenceNumber++,
      timestampOffset: Date.now() & 0xFFFF,
      payload,
    };

    // Send
    const data = serializeVoiceFrame(frame);
    this.socket.send(data);

    this.stats.framesSent++;
    this.stats.bytesTransmitted += data.length;

    this.log('verbose', `Sent frame ${frame.sequence}`);
  }

  /**
   * Send JSON message
   */
  private send(message: any): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  /**
   * Wait until ready (connected and in room)
   */
  waitUntilReady(): Promise<void> {
    return new Promise((resolve) => {
      if (this.isInRoom) {
        resolve();
      } else {
        this.onReadyCallbacks.push(resolve);
      }
    });
  }

  /**
   * Register frame received callback
   */
  onFrameReceived(callback: (senderId: number, frame: DecodedVoiceFrame) => void): void {
    this.onFrameReceivedCallbacks.push(callback);
  }

  /**
   * Register error callback
   */
  onError(callback: (error: Error) => void): void {
    this.onErrorCallbacks.push(callback);
  }

  /**
   * Get room ID (for other clients to join)
   */
  getRoomId(): string {
    return this.roomId;
  }

  /**
   * Get player ID
   */
  getPlayerId(): string {
    return this.playerId;
  }

  /**
   * Get stats
   */
  getStats(): VoiceStats {
    return { ...this.stats };
  }

  /**
   * Get received frames for a sender
   */
  getReceivedFrames(senderId: number): DecodedVoiceFrame[] {
    return this.receivedFrames.get(senderId) || [];
  }

  /**
   * Get all sender IDs that we've received from
   */
  getReceivedSenderIds(): number[] {
    return Array.from(this.receivedFrames.keys());
  }

  /**
   * Check if connected and in room
   */
  get isReady(): boolean {
    return this.isConnected && this.isInRoom;
  }

  /**
   * Disconnect and cleanup
   */
  disconnect(): void {
    this.cleanup();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    this.stopTransmitting();
    this.jitterBuffers.clear();
    this.onReadyCallbacks = [];
    this.onFrameReceivedCallbacks = [];
  }

  /**
   * Log message based on log level
   */
  private log(level: 'silent' | 'minimal' | 'verbose', message: string): void {
    const levels = { silent: 0, minimal: 1, verbose: 2 };
    if (levels[level] <= levels[this.config.logLevel || 'minimal']) {
      console.log(`[${this.config.playerName}] ${message}`);
    }
  }
}
