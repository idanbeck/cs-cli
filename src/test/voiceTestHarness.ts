#!/usr/bin/env npx ts-node
/**
 * Voice Chat Test Harness
 *
 * Comprehensive end-to-end test for the voice chat system.
 * Spins up a server and multiple clients, tests voice transmission.
 *
 * Usage: npx ts-node src/test/voiceTestHarness.ts [numClients]
 */

import { spawn, ChildProcess, fork } from 'child_process';
import { WebSocket } from 'ws';
import * as path from 'path';
import * as fs from 'fs';
import { Codec2, initializeCodec2 } from '../voice/Codec2.js';
import {
  serializeVoiceFrame,
  deserializeVoiceFrame,
  isVoiceFrame,
  VoiceFrame,
  VOICE_FRAME_TYPE,
  VOICE_HEADER_SIZE,
  truncatePlayerId,
} from '../voice/types.js';

// Test configuration
const SERVER_PORT = 19080;  // Use high port to avoid conflicts
const HUB_PORT = 19081;
const NUM_CLIENTS = parseInt(process.argv[2]) || 2;
const TEST_DURATION_MS = 10000; // 10 seconds
const VOICE_FRAME_INTERVAL_MS = 20; // 20ms per frame

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

const clientColors = [colors.cyan, colors.magenta, colors.yellow, colors.blue, colors.green];

function log(prefix: string, message: string, color: string = colors.reset) {
  const timestamp = new Date().toISOString().slice(11, 23);
  console.log(`${color}[${timestamp}] [${prefix}] ${message}${colors.reset}`);
}

// Stats tracking
interface ClientStats {
  framesSent: number;
  framesReceived: number;
  bytesSent: number;
  bytesReceived: number;
  latencies: number[];
}

const clientStats: Map<string, ClientStats> = new Map();

/**
 * Generate a sine wave tone as test audio
 */
function generateTestTone(sampleRate: number, frequency: number, durationMs: number, amplitude: number = 0.5): Int16Array {
  const numSamples = Math.floor(sampleRate * durationMs / 1000);
  const samples = new Int16Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    samples[i] = Math.floor(Math.sin(2 * Math.PI * frequency * t) * amplitude * 32767);
  }

  return samples;
}

/**
 * Test client that sends and receives voice frames
 */
class TestVoiceClient {
  private ws: WebSocket | null = null;
  private playerId: string;
  private senderId: number;
  private codec: Codec2 | null = null;
  private sequenceNumber = 0;
  private isConnected = false;
  private roomId: string | null = null;
  private voiceInterval: ReturnType<typeof setInterval> | null = null;
  private stats: ClientStats;
  private clientIndex: number;
  private toneFrequency: number;

  constructor(playerId: string, clientIndex: number) {
    this.playerId = playerId;
    this.senderId = truncatePlayerId(playerId);
    this.clientIndex = clientIndex;
    this.toneFrequency = 440 + clientIndex * 100; // Different tone per client
    this.stats = {
      framesSent: 0,
      framesReceived: 0,
      bytesSent: 0,
      bytesReceived: 0,
      latencies: [],
    };
    clientStats.set(playerId, this.stats);
  }

  private log(message: string) {
    const color = clientColors[this.clientIndex % clientColors.length];
    log(`Client ${this.clientIndex}`, message, color);
  }

  async initialize(): Promise<void> {
    this.codec = await initializeCodec2();
    this.log(`Codec initialized (native=${Codec2.isNativeAvailable()})`);
  }

  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.log(`Connecting to ${url}...`);

      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this.isConnected = true;
        this.log('Connected');
        resolve();
      });

      this.ws.on('message', (data: Buffer | string) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (err) => {
        this.log(`WebSocket error: ${err.message}`);
        reject(err);
      });

      this.ws.on('close', () => {
        this.isConnected = false;
        this.log('Disconnected');
      });

      setTimeout(() => reject(new Error('Connection timeout')), 5000);
    });
  }

  private handleMessage(data: Buffer | string) {
    // Check if it's binary (voice frame)
    if (Buffer.isBuffer(data) && isVoiceFrame(new Uint8Array(data))) {
      this.handleVoiceFrame(new Uint8Array(data));
      return;
    }

    // JSON message
    try {
      const msg = JSON.parse(data.toString());
      this.handleJsonMessage(msg);
    } catch (err) {
      // Ignore parse errors
    }
  }

  private handleJsonMessage(msg: any) {
    switch (msg.type) {
      case 'welcome':
        this.log(`Welcome received, playerId: ${msg.playerId?.slice(0, 8)}`);
        break;
      case 'room_created':
        this.roomId = msg.roomId;
        this.log(`Room created: ${msg.roomId}`);
        break;
      case 'room_joined':
        this.roomId = msg.roomId;
        this.log(`Joined room: ${msg.roomId}`);
        break;
      case 'player_joined':
        this.log(`Player joined: ${msg.playerId?.slice(0, 8)}`);
        break;
      case 'player_left':
        this.log(`Player left: ${msg.playerId?.slice(0, 8)}`);
        break;
      case 'error':
        this.log(`Server error: ${msg.message}`);
        break;
      default:
        // Log other messages for debugging
        if (msg.type) {
          this.log(`Received: ${msg.type}`);
        }
    }
  }

  private handleVoiceFrame(data: Uint8Array) {
    const frame = deserializeVoiceFrame(data);
    if (!frame) return;

    // Ignore our own frames
    if (frame.senderId === this.senderId) return;

    this.stats.framesReceived++;
    this.stats.bytesReceived += data.length;

    // Decode and check
    if (this.codec) {
      try {
        const samples = this.codec.decode(frame.payload);
        // Calculate max amplitude
        let maxAmp = 0;
        for (let i = 0; i < samples.length; i++) {
          maxAmp = Math.max(maxAmp, Math.abs(samples[i]));
        }

        if (this.stats.framesReceived % 50 === 1) {
          this.log(`Received frame #${this.stats.framesReceived} from ${frame.senderId.toString(16)}, seq=${frame.sequence}, samples=${samples.length}, maxAmp=${maxAmp}`);
        }
      } catch (err) {
        this.log(`Decode error: ${err}`);
      }
    }
  }

  createRoom(name: string): void {
    if (!this.ws || !this.isConnected) return;
    this.log(`Creating room: ${name}`);
    this.ws.send(JSON.stringify({
      type: 'create_room',
      config: {
        name,
        map: 'dust2',
        mode: 'deathmatch',
        maxPlayers: 10,
        botCount: 0,
        botDifficulty: 'medium',
        isPrivate: false,
      },
    }));
  }

  joinRoom(roomId: string): void {
    if (!this.ws || !this.isConnected) return;
    this.log(`Joining room: ${roomId}`);
    this.ws.send(JSON.stringify({
      type: 'join_room',
      roomId,
      playerName: `TestPlayer${this.clientIndex}`,
    }));
  }

  startVoice(): void {
    if (!this.ws || !this.isConnected || !this.codec) return;

    this.log(`Starting voice transmission at ${this.toneFrequency}Hz`);

    // Generate test tone frames
    this.voiceInterval = setInterval(() => {
      this.sendVoiceFrame();
    }, VOICE_FRAME_INTERVAL_MS);
  }

  private sendVoiceFrame(): void {
    if (!this.ws || !this.isConnected || !this.codec) return;

    // Generate 20ms of test tone (160 samples at 8kHz)
    const samples = generateTestTone(8000, this.toneFrequency, 20, 0.3);

    // Encode
    const payload = this.codec.encode(samples);

    // Create frame
    const frame: VoiceFrame = {
      frameType: VOICE_FRAME_TYPE,
      flags: 0x01, // VAD active
      senderId: this.senderId,
      sequence: this.sequenceNumber++,
      timestampOffset: Date.now() & 0xFFFF,
      payload,
    };

    // Serialize and send
    const data = serializeVoiceFrame(frame);

    try {
      this.ws!.send(data);
      this.stats.framesSent++;
      this.stats.bytesSent += data.length;

      if (this.stats.framesSent % 50 === 1) {
        this.log(`Sent frame #${this.stats.framesSent}, seq=${frame.sequence}, payload=${payload.length} bytes`);
      }
    } catch (err) {
      this.log(`Send error: ${err}`);
    }
  }

  stopVoice(): void {
    if (this.voiceInterval) {
      clearInterval(this.voiceInterval);
      this.voiceInterval = null;
    }
    this.log('Stopped voice transmission');
  }

  disconnect(): void {
    this.stopVoice();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  getRoomId(): string | null {
    return this.roomId;
  }

  getStats(): ClientStats {
    return this.stats;
  }
}

/**
 * Kill any existing processes on our test ports
 */
async function cleanupPorts(): Promise<void> {
  const { execSync } = await import('child_process');
  try {
    execSync(`lsof -ti:${SERVER_PORT} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
    execSync(`lsof -ti:${HUB_PORT} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
  } catch {}
  // Wait a moment for ports to be released
  await new Promise(r => setTimeout(r, 500));
}

/**
 * Start the game server
 */
async function startServer(): Promise<ChildProcess> {
  // Clean up any existing processes first
  await cleanupPorts();

  log('Server', 'Starting server...', colors.green);

  const serverPath = path.join(process.cwd(), 'server', 'dist', 'index.js');

  const server = spawn('node', [serverPath], {
    env: {
      ...process.env,
      PORT: SERVER_PORT.toString(),
      HUB_PORT: HUB_PORT.toString(),
      NODE_ENV: 'test',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  server.stdout?.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      if (line.includes('VoiceRelay') || line.includes('Room')) {
        log('Server', line, colors.green);
      }
    }
  });

  server.stderr?.on('data', (data) => {
    log('Server', `ERROR: ${data}`, colors.red);
  });

  // Wait for server to be ready
  await new Promise<void>((resolve) => {
    const checkReady = setInterval(async () => {
      try {
        const ws = new WebSocket(`ws://localhost:${SERVER_PORT}`);
        ws.on('open', () => {
          ws.close();
          clearInterval(checkReady);
          resolve();
        });
        ws.on('error', () => {});
      } catch {}
    }, 500);
  });

  log('Server', 'Server ready', colors.green);
  return server;
}

/**
 * Run the test
 */
async function runTest() {
  console.log('\n' + '='.repeat(60));
  console.log('  Voice Chat Test Harness');
  console.log('  ' + '-'.repeat(56));
  console.log(`  Clients: ${NUM_CLIENTS}`);
  console.log(`  Duration: ${TEST_DURATION_MS / 1000}s`);
  console.log('='.repeat(60) + '\n');

  let server: ChildProcess | null = null;
  const clients: TestVoiceClient[] = [];

  try {
    // Start server
    server = await startServer();

    // Create and initialize clients
    for (let i = 0; i < NUM_CLIENTS; i++) {
      const playerId = `test-client-${i}-${Date.now()}`;
      const client = new TestVoiceClient(playerId, i);
      await client.initialize();
      clients.push(client);
    }

    // Connect all clients
    const serverUrl = `ws://localhost:${SERVER_PORT}`;
    await Promise.all(clients.map(c => c.connect(serverUrl)));

    // Wait for connections to stabilize
    await new Promise(r => setTimeout(r, 500));

    // First client creates room
    clients[0].createRoom('Voice Test Room');

    // Wait for room creation (with retry)
    let roomId: string | null = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 100));
      roomId = clients[0].getRoomId();
      if (roomId) break;
    }

    if (!roomId) {
      log('Test', 'Failed to create room after 2 seconds', colors.red);
      throw new Error('Failed to create room');
    }
    log('Test', `Room created: ${roomId}`, colors.yellow);

    // Other clients join the room
    for (let i = 1; i < clients.length; i++) {
      clients[i].joinRoom(roomId);
      await new Promise(r => setTimeout(r, 200));
    }

    // Wait for all to join
    await new Promise(r => setTimeout(r, 1000));

    // Start voice transmission from all clients
    log('Test', 'Starting voice transmission...', colors.yellow);
    for (const client of clients) {
      client.startVoice();
    }

    // Run test for specified duration
    log('Test', `Running for ${TEST_DURATION_MS / 1000} seconds...`, colors.yellow);
    await new Promise(r => setTimeout(r, TEST_DURATION_MS));

    // Stop voice
    for (const client of clients) {
      client.stopVoice();
    }

    // Wait for final frames
    await new Promise(r => setTimeout(r, 500));

    // Print results
    console.log('\n' + '='.repeat(60));
    console.log('  Test Results');
    console.log('='.repeat(60));

    let totalSent = 0;
    let totalReceived = 0;

    for (let i = 0; i < clients.length; i++) {
      const stats = clients[i].getStats();
      const color = clientColors[i % clientColors.length];

      console.log(`${color}`);
      console.log(`  Client ${i}:`);
      console.log(`    Frames sent:     ${stats.framesSent}`);
      console.log(`    Frames received: ${stats.framesReceived}`);
      console.log(`    Bytes sent:      ${stats.bytesSent}`);
      console.log(`    Bytes received:  ${stats.bytesReceived}`);
      console.log(`${colors.reset}`);

      totalSent += stats.framesSent;
      totalReceived += stats.framesReceived;
    }

    // Expected frames: each client sends frames, each other client should receive them
    const expectedFramesPerClient = Math.floor(TEST_DURATION_MS / VOICE_FRAME_INTERVAL_MS);
    const expectedTotalReceived = expectedFramesPerClient * NUM_CLIENTS * (NUM_CLIENTS - 1);
    const receiveRate = totalReceived / expectedTotalReceived * 100;

    console.log('  Summary:');
    console.log(`    Total frames sent:     ${totalSent}`);
    console.log(`    Total frames received: ${totalReceived}`);
    console.log(`    Expected received:     ${expectedTotalReceived}`);
    console.log(`    Receive rate:          ${receiveRate.toFixed(1)}%`);
    console.log('='.repeat(60) + '\n');

    if (receiveRate > 90) {
      console.log(`${colors.green}✓ TEST PASSED${colors.reset}`);
    } else if (receiveRate > 50) {
      console.log(`${colors.yellow}⚠ TEST PARTIAL${colors.reset}`);
    } else {
      console.log(`${colors.red}✗ TEST FAILED${colors.reset}`);
    }

  } catch (err) {
    log('Test', `Error: ${err}`, colors.red);
    console.error(err);
  } finally {
    // Cleanup
    for (const client of clients) {
      client.disconnect();
    }

    if (server) {
      server.kill();
    }

    process.exit(0);
  }
}

// Run the test
runTest().catch(console.error);
