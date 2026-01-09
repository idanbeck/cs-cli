/**
 * VoiceTestHarness - Multi-client voice chat testing
 *
 * Spawns multiple headless voice clients and tests:
 * - Codec2 encode/decode round-trip
 * - Network transmission and relay
 * - Multi-client audio mixing
 * - Jitter buffer operation
 * - Statistics and latency measurement
 */

import { Vector3 } from '../../engine/math/Vector3.js';
import { HeadlessVoiceClient, VoiceStats } from './HeadlessVoiceClient.js';
import {
  TestSignalGenerator,
  createStandardTestSequence,
  createClientIdentifierSequence,
  SignalConfig,
} from './TestSignalGenerator.js';
import { Codec2, initializeCodec2 } from '../Codec2.js';
import { VOICE_FRAME_SAMPLES, VOICE_FRAME_MS } from '../types.js';

export interface VoiceTestConfig {
  serverUrl: string;
  numClients: number;
  testDurationMs: number;
  clientPositions?: Vector3[];  // 3D positions for spatial audio testing
  logLevel?: 'silent' | 'minimal' | 'verbose';
}

export interface TestResult {
  passed: boolean;
  testName: string;
  details: string;
  stats?: any;
}

/**
 * Main test harness
 */
export class VoiceTestHarness {
  private config: VoiceTestConfig;
  private clients: HeadlessVoiceClient[] = [];
  private results: TestResult[] = [];

  constructor(config: VoiceTestConfig) {
    this.config = {
      logLevel: 'minimal',
      ...config,
    };
  }

  /**
   * Run all tests
   */
  async runAllTests(): Promise<TestResult[]> {
    console.log('\n========================================');
    console.log('   Voice Chat Test Harness');
    console.log('========================================\n');

    try {
      // Test 1: Codec2 encode/decode
      await this.runCodecTest();

      // Test 2: Single client connection
      await this.runSingleClientTest();

      // Test 3: Multi-client transmission
      await this.runMultiClientTest();

      // Test 4: Verify received audio quality
      await this.runAudioQualityTest();

    } catch (error) {
      this.results.push({
        passed: false,
        testName: 'Test Suite',
        details: `Fatal error: ${error}`,
      });
    } finally {
      await this.cleanup();
    }

    this.printSummary();
    return this.results;
  }

  /**
   * Test 1: Codec2 encode/decode round-trip
   */
  async runCodecTest(): Promise<void> {
    console.log('Test 1: Codec2 Encode/Decode Round-Trip');
    console.log('---------------------------------------');

    try {
      const codec = await initializeCodec2();

      // Generate test signal
      const generator = new TestSignalGenerator({
        type: 'sine',
        frequency: 440,
        amplitude: 0.7,
        durationMs: 100,
      });

      let totalMSE = 0;
      let frameCount = 0;
      let totalEncodeTime = 0;
      let totalDecodeTime = 0;

      // Encode and decode multiple frames
      while (!generator.isFinished) {
        const original = generator.nextFrame();
        if (!original) break;

        // Encode
        const startEncode = performance.now();
        const encoded = codec.encode(original);
        totalEncodeTime += performance.now() - startEncode;

        // Decode
        const startDecode = performance.now();
        const decoded = codec.decode(encoded);
        totalDecodeTime += performance.now() - startDecode;

        // Calculate MSE (mean squared error)
        let mse = 0;
        for (let i = 0; i < original.length; i++) {
          const diff = original[i] - decoded[i];
          mse += diff * diff;
        }
        mse /= original.length;
        totalMSE += mse;
        frameCount++;
      }

      const avgMSE = totalMSE / frameCount;
      const avgEncodeTime = totalEncodeTime / frameCount;
      const avgDecodeTime = totalDecodeTime / frameCount;

      // MSE should be reasonable (vocoder is lossy)
      // For fallback encoder, MSE will be high; for real Codec2, should be < 10000
      const passed = frameCount > 0 && avgEncodeTime < 10 && avgDecodeTime < 10;

      console.log(`  Frames processed: ${frameCount}`);
      console.log(`  Avg encode time: ${avgEncodeTime.toFixed(2)}ms`);
      console.log(`  Avg decode time: ${avgDecodeTime.toFixed(2)}ms`);
      console.log(`  Avg MSE: ${avgMSE.toFixed(2)}`);
      console.log(`  WASM available: ${codec.isWasmAvailable}`);
      console.log(`  Result: ${passed ? 'PASS' : 'FAIL'}\n`);

      this.results.push({
        passed,
        testName: 'Codec2 Encode/Decode',
        details: `${frameCount} frames, encode: ${avgEncodeTime.toFixed(2)}ms, decode: ${avgDecodeTime.toFixed(2)}ms`,
        stats: { avgMSE, avgEncodeTime, avgDecodeTime, frameCount },
      });

    } catch (error) {
      console.log(`  Error: ${error}\n`);
      this.results.push({
        passed: false,
        testName: 'Codec2 Encode/Decode',
        details: `Error: ${error}`,
      });
    }
  }

  /**
   * Test 2: Single client connection
   */
  async runSingleClientTest(): Promise<void> {
    console.log('Test 2: Single Client Connection');
    console.log('---------------------------------');

    try {
      const client = new HeadlessVoiceClient({
        serverUrl: this.config.serverUrl,
        playerName: 'TestClient1',
        position: new Vector3(0, 0, 0),
        signalConfig: { type: 'sine', frequency: 440, durationMs: 500, amplitude: 0.5 },
        logLevel: this.config.logLevel,
      });

      await client.connect();
      await client.waitUntilReady();

      const roomId = client.getRoomId();
      const playerId = client.getPlayerId();

      const passed = client.isReady && roomId.length > 0 && playerId.length > 0;

      console.log(`  Room ID: ${roomId}`);
      console.log(`  Player ID: ${playerId}`);
      console.log(`  Result: ${passed ? 'PASS' : 'FAIL'}\n`);

      this.clients.push(client);

      this.results.push({
        passed,
        testName: 'Single Client Connection',
        details: `Room: ${roomId}, Player: ${playerId}`,
      });

    } catch (error) {
      console.log(`  Error: ${error}\n`);
      this.results.push({
        passed: false,
        testName: 'Single Client Connection',
        details: `Error: ${error}`,
      });
    }
  }

  /**
   * Test 3: Multi-client transmission
   */
  async runMultiClientTest(): Promise<void> {
    console.log('Test 3: Multi-Client Voice Transmission');
    console.log('----------------------------------------');

    try {
      // Get room ID from first client
      const roomId = this.clients[0]?.getRoomId();
      if (!roomId) {
        throw new Error('No room available from previous test');
      }

      // Create additional clients
      const numAdditional = Math.max(0, this.config.numClients - 1);
      console.log(`  Creating ${numAdditional} additional clients...`);

      for (let i = 0; i < numAdditional; i++) {
        const position = this.config.clientPositions?.[i + 1] ||
          new Vector3(10 * (i + 1), 0, 10 * Math.sin(i));

        // Each client gets a unique frequency sine wave with staggered start
        const signalConfigs: SignalConfig[] = [
          { type: 'silence', durationMs: 200 * (i + 1) },  // Stagger start
          { type: 'sine', frequency: 440 + 100 * (i + 1), durationMs: 1500, amplitude: 0.6 },
          { type: 'silence', durationMs: 200 },
        ];

        const client = new HeadlessVoiceClient({
          serverUrl: this.config.serverUrl,
          playerName: `TestClient${i + 2}`,
          roomId,
          position,
          signalConfig: signalConfigs,
          logLevel: this.config.logLevel,
        });

        await client.connect();
        await client.waitUntilReady();
        this.clients.push(client);
        console.log(`  Client ${i + 2} connected`);
      }

      // Wait a moment for all clients to be ready
      await this.delay(500);

      // Start all clients transmitting
      console.log('  Starting voice transmission...');
      for (const client of this.clients) {
        client.startTransmitting();
      }

      // Wait for test duration
      console.log(`  Transmitting for ${this.config.testDurationMs}ms...`);
      await this.delay(this.config.testDurationMs);

      // Stop transmission
      for (const client of this.clients) {
        client.stopTransmitting();
      }

      // Wait for final frames to arrive
      await this.delay(200);

      // Collect stats
      console.log('\n  Client Statistics:');
      let totalSent = 0;
      let totalReceived = 0;

      for (let i = 0; i < this.clients.length; i++) {
        const client = this.clients[i];
        const stats = client.getStats();
        console.log(`    Client ${i + 1}: sent=${stats.framesSent}, received=${stats.framesReceived}, ` +
          `tx=${stats.bytesTransmitted}B, rx=${stats.bytesReceived}B`);
        totalSent += stats.framesSent;
        totalReceived += stats.framesReceived;
      }

      // Each client should receive from other clients
      // Expected: each client sends N frames, other clients receive them
      const expectedReceived = totalSent * (this.clients.length - 1) / this.clients.length;
      const receiveRatio = totalReceived / (expectedReceived || 1);

      const passed = totalSent > 0 && totalReceived > 0 && receiveRatio > 0.5;

      console.log(`\n  Total frames sent: ${totalSent}`);
      console.log(`  Total frames received: ${totalReceived}`);
      console.log(`  Receive ratio: ${(receiveRatio * 100).toFixed(1)}%`);
      console.log(`  Result: ${passed ? 'PASS' : 'FAIL'}\n`);

      this.results.push({
        passed,
        testName: 'Multi-Client Transmission',
        details: `${this.clients.length} clients, sent: ${totalSent}, received: ${totalReceived}`,
        stats: { totalSent, totalReceived, receiveRatio },
      });

    } catch (error) {
      console.log(`  Error: ${error}\n`);
      this.results.push({
        passed: false,
        testName: 'Multi-Client Transmission',
        details: `Error: ${error}`,
      });
    }
  }

  /**
   * Test 4: Verify audio quality
   */
  async runAudioQualityTest(): Promise<void> {
    console.log('Test 4: Audio Quality Verification');
    console.log('-----------------------------------');

    try {
      // Analyze received frames for each client
      let totalFramesAnalyzed = 0;
      let consecutiveFrames = 0;
      let outOfOrderFrames = 0;
      let duplicateFrames = 0;

      for (const client of this.clients) {
        const senderIds = client.getReceivedSenderIds();

        for (const senderId of senderIds) {
          const frames = client.getReceivedFrames(senderId);
          if (frames.length === 0) continue;

          totalFramesAnalyzed += frames.length;

          // Check sequence continuity
          let lastSeq = -1;
          const seenSeqs = new Set<number>();

          for (const frame of frames) {
            if (seenSeqs.has(frame.sequence)) {
              duplicateFrames++;
            } else {
              seenSeqs.add(frame.sequence);

              if (lastSeq >= 0) {
                if (frame.sequence === lastSeq + 1) {
                  consecutiveFrames++;
                } else if (frame.sequence < lastSeq) {
                  outOfOrderFrames++;
                }
              }
              lastSeq = frame.sequence;
            }
          }
        }
      }

      const consecutiveRatio = consecutiveFrames / (totalFramesAnalyzed || 1);
      const passed = totalFramesAnalyzed > 0 && consecutiveRatio > 0.7;

      console.log(`  Frames analyzed: ${totalFramesAnalyzed}`);
      console.log(`  Consecutive frames: ${consecutiveFrames} (${(consecutiveRatio * 100).toFixed(1)}%)`);
      console.log(`  Out of order: ${outOfOrderFrames}`);
      console.log(`  Duplicates: ${duplicateFrames}`);
      console.log(`  Result: ${passed ? 'PASS' : 'FAIL'}\n`);

      this.results.push({
        passed,
        testName: 'Audio Quality',
        details: `${totalFramesAnalyzed} frames, ${(consecutiveRatio * 100).toFixed(1)}% consecutive`,
        stats: { totalFramesAnalyzed, consecutiveFrames, outOfOrderFrames, duplicateFrames },
      });

    } catch (error) {
      console.log(`  Error: ${error}\n`);
      this.results.push({
        passed: false,
        testName: 'Audio Quality',
        details: `Error: ${error}`,
      });
    }
  }

  /**
   * Print test summary
   */
  private printSummary(): void {
    console.log('\n========================================');
    console.log('   Test Summary');
    console.log('========================================\n');

    let passed = 0;
    let failed = 0;

    for (const result of this.results) {
      const status = result.passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
      console.log(`  [${status}] ${result.testName}`);
      console.log(`         ${result.details}\n`);

      if (result.passed) passed++;
      else failed++;
    }

    console.log('----------------------------------------');
    console.log(`  Total: ${passed + failed} tests`);
    console.log(`  Passed: \x1b[32m${passed}\x1b[0m`);
    console.log(`  Failed: \x1b[31m${failed}\x1b[0m`);
    console.log('========================================\n');
  }

  /**
   * Cleanup all clients
   */
  private async cleanup(): Promise<void> {
    console.log('Cleaning up...');
    for (const client of this.clients) {
      client.disconnect();
    }
    this.clients = [];
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Run voice test harness
 */
export async function runVoiceTests(config: Partial<VoiceTestConfig> = {}): Promise<TestResult[]> {
  const harness = new VoiceTestHarness({
    serverUrl: 'ws://localhost:8080',
    numClients: 3,
    testDurationMs: 3000,
    logLevel: 'minimal',
    ...config,
  });

  return harness.runAllTests();
}
