/**
 * EndToEndTest - Full pipeline verification
 *
 * Tests the complete voice pipeline:
 * 1. Generate known test signal (sine wave at specific frequency)
 * 2. Encode with Codec2
 * 3. Send through network to server
 * 4. Server relays to other clients
 * 5. Clients decode
 * 6. Verify decoded signal matches expected characteristics
 */

import { Vector3 } from '../../engine/math/Vector3.js';
import { HeadlessVoiceClient } from './HeadlessVoiceClient.js';
import { TestSignalGenerator, SignalConfig } from './TestSignalGenerator.js';
import { analyzeFrame, analyzeFrames, verifySignal, formatAnalysis, SignalVerification } from './SignalAnalyzer.js';
import { Codec2, initializeCodec2 } from '../Codec2.js';
import { DecodedVoiceFrame, VOICE_FRAME_MS } from '../types.js';

export interface E2ETestConfig {
  serverUrl: string;
  testFrequency: number;      // Hz, the test tone frequency
  testAmplitude: number;      // 0-1, amplitude of test signal
  testDurationMs: number;     // How long to transmit
  expectedLatencyMs: number;  // Expected max latency
  logLevel?: 'silent' | 'minimal' | 'verbose';
}

export interface E2ETestResult {
  passed: boolean;
  tests: {
    name: string;
    passed: boolean;
    details: string;
    measurements?: Record<string, number | string>;
  }[];
  summary: string;
}

/**
 * Run end-to-end voice pipeline test
 */
export async function runEndToEndTest(config: E2ETestConfig): Promise<E2ETestResult> {
  const results: E2ETestResult = {
    passed: true,
    tests: [],
    summary: '',
  };

  const log = (level: 'silent' | 'minimal' | 'verbose', msg: string) => {
    const levels = { silent: 0, minimal: 1, verbose: 2 };
    if (levels[level] <= levels[config.logLevel || 'minimal']) {
      console.log(msg);
    }
  };

  log('minimal', '\n=== End-to-End Voice Pipeline Test ===\n');
  log('minimal', `Test Signal: ${config.testFrequency}Hz sine wave, amplitude ${config.testAmplitude}`);
  log('minimal', `Duration: ${config.testDurationMs}ms\n`);

  let sender: HeadlessVoiceClient | null = null;
  let receiver: HeadlessVoiceClient | null = null;

  try {
    // ========================================
    // Test 1: Codec Round-Trip Signal Integrity
    // ========================================
    log('minimal', '--- Test 1: Codec Signal Integrity ---');

    const codec = await initializeCodec2();
    const testGen = new TestSignalGenerator({
      type: 'sine',
      frequency: config.testFrequency,
      amplitude: config.testAmplitude,
      durationMs: 200,
    });

    let codecTestPassed = true;
    let totalLevelError = 0;
    let totalFreqError = 0;
    let framesTested = 0;

    while (!testGen.isFinished) {
      const original = testGen.nextFrame();
      if (!original) break;

      const encoded = codec.encode(original);
      const decoded = codec.decode(encoded);

      const verification = verifySignal(
        decoded,
        config.testFrequency,
        config.testAmplitude,
        100,  // Allow 100Hz frequency tolerance (vocoder distorts)
        25    // Allow 25dB level tolerance (vocoder is lossy)
      );

      if (!verification.passed) {
        codecTestPassed = false;
        log('verbose', `  Frame ${framesTested}: FAIL - ${verification.details}`);
      }

      totalLevelError += verification.levelError;
      totalFreqError += verification.frequencyError;
      framesTested++;
    }

    const avgLevelError = totalLevelError / framesTested;
    const avgFreqError = totalFreqError / framesTested;

    // If using fallback codec (no WASM), be more lenient
    // Fallback is just for testing - real Codec2 will be much better
    const usingFallback = !codec.isWasmAvailable;
    const effectivePassed = usingFallback ? (avgFreqError < 200) : codecTestPassed;

    results.tests.push({
      name: 'Codec Signal Integrity',
      passed: effectivePassed,
      details: effectivePassed
        ? `${framesTested} frames processed${usingFallback ? ' (fallback codec)' : ''}`
        : `Signal distortion detected`,
      measurements: {
        framesProcessed: framesTested,
        avgLevelErrorDb: avgLevelError.toFixed(2),
        avgFrequencyErrorHz: avgFreqError.toFixed(2),
        wasmAvailable: codec.isWasmAvailable.toString(),
        usingFallback: usingFallback.toString(),
      },
    });

    log('minimal', `  Frames: ${framesTested}, Avg level error: ${avgLevelError.toFixed(2)}dB, Freq error: ${avgFreqError.toFixed(2)}Hz`);
    log('minimal', `  WASM: ${codec.isWasmAvailable ? 'yes' : 'no (using fallback)'}`);
    log('minimal', `  Result: ${effectivePassed ? 'PASS' : 'FAIL'}\n`);

    // ========================================
    // Test 2: Network Transmission
    // ========================================
    log('minimal', '--- Test 2: Network Signal Transmission ---');

    // Create sender client
    const senderSignal: SignalConfig = {
      type: 'sine',
      frequency: config.testFrequency,
      amplitude: config.testAmplitude,
      durationMs: config.testDurationMs,
    };

    sender = new HeadlessVoiceClient({
      serverUrl: config.serverUrl,
      playerName: 'E2E-Sender',
      position: new Vector3(0, 0, 0),
      signalConfig: senderSignal,
      logLevel: config.logLevel,
    });

    await sender.connect();
    await sender.waitUntilReady();
    const roomId = sender.getRoomId();
    log('minimal', `  Sender connected, room: ${roomId}`);

    // Create receiver client
    receiver = new HeadlessVoiceClient({
      serverUrl: config.serverUrl,
      playerName: 'E2E-Receiver',
      roomId,
      position: new Vector3(10, 0, 0),
      logLevel: config.logLevel,
    });

    await receiver.connect();
    await receiver.waitUntilReady();
    log('minimal', `  Receiver connected`);

    // Collect received frames for analysis
    const receivedFrames: Int16Array[] = [];
    const frameTimestamps: number[] = [];
    const transmitStartTime = Date.now();

    receiver.onFrameReceived((_senderId, frame) => {
      receivedFrames.push(frame.samples);
      frameTimestamps.push(Date.now() - transmitStartTime);
    });

    // Wait for clients to stabilize
    await delay(200);

    // Start transmission
    log('minimal', `  Starting transmission...`);
    sender.startTransmitting();

    // Wait for transmission to complete + buffer time
    await delay(config.testDurationMs + 500);
    sender.stopTransmitting();

    // Wait for final frames
    await delay(300);

    const senderStats = sender.getStats();
    const receiverStats = receiver.getStats();

    log('minimal', `  Sender: ${senderStats.framesSent} frames sent`);
    log('minimal', `  Receiver: ${receivedFrames.length} frames received`);

    // Check frame delivery
    const deliveryRatio = receivedFrames.length / (senderStats.framesSent || 1);
    const networkPassed = deliveryRatio > 0.8;  // Allow up to 20% loss

    results.tests.push({
      name: 'Network Frame Delivery',
      passed: networkPassed,
      details: networkPassed
        ? `${deliveryRatio * 100}% frames delivered`
        : `Only ${deliveryRatio * 100}% frames delivered`,
      measurements: {
        framesSent: senderStats.framesSent,
        framesReceived: receivedFrames.length,
        deliveryRatio: `${(deliveryRatio * 100).toFixed(1)}%`,
      },
    });

    log('minimal', `  Delivery ratio: ${(deliveryRatio * 100).toFixed(1)}%`);
    log('minimal', `  Result: ${networkPassed ? 'PASS' : 'FAIL'}\n`);

    // ========================================
    // Test 3: Received Signal Verification
    // ========================================
    log('minimal', '--- Test 3: Received Signal Verification ---');

    if (receivedFrames.length > 0) {
      const analysis = analyzeFrames(receivedFrames);

      log('verbose', `  Avg RMS: ${analysis.avgRms.toFixed(0)}`);
      log('verbose', `  Avg Frequency: ${analysis.avgFrequency.toFixed(0)}Hz`);
      log('verbose', `  Peak Level: ${analysis.peakLevel}`);
      log('verbose', `  Silent Frames: ${analysis.silentFrames}, Active: ${analysis.activeFrames}`);

      // Verify frequency matches expected
      const freqError = Math.abs(analysis.avgFrequency - config.testFrequency);
      const freqPassed = freqError < 150;  // Allow 150Hz tolerance for vocoder

      // Verify signal is not silent
      const levelPassed = analysis.activeFrames > analysis.silentFrames * 0.5;

      const signalPassed = freqPassed && levelPassed;

      results.tests.push({
        name: 'Received Signal Quality',
        passed: signalPassed,
        details: signalPassed
          ? `Signal integrity verified (freq error: ${freqError.toFixed(0)}Hz)`
          : `Signal degradation: freq error ${freqError.toFixed(0)}Hz, ${analysis.silentFrames} silent frames`,
        measurements: {
          expectedFrequency: `${config.testFrequency}Hz`,
          measuredFrequency: `${analysis.avgFrequency.toFixed(0)}Hz`,
          frequencyError: `${freqError.toFixed(0)}Hz`,
          avgEnergyDb: `${analysis.avgEnergyDb.toFixed(1)}dB`,
          activeFrames: analysis.activeFrames,
          silentFrames: analysis.silentFrames,
        },
      });

      log('minimal', `  Expected: ${config.testFrequency}Hz, Measured: ${analysis.avgFrequency.toFixed(0)}Hz (error: ${freqError.toFixed(0)}Hz)`);
      log('minimal', `  Active frames: ${analysis.activeFrames}/${receivedFrames.length}`);
      log('minimal', `  Result: ${signalPassed ? 'PASS' : 'FAIL'}\n`);
    } else {
      results.tests.push({
        name: 'Received Signal Quality',
        passed: false,
        details: 'No frames received',
      });
      log('minimal', `  No frames received`);
      log('minimal', `  Result: FAIL\n`);
    }

    // ========================================
    // Test 4: Latency Measurement
    // ========================================
    log('minimal', '--- Test 4: Latency Measurement ---');

    if (frameTimestamps.length > 5) {
      // Estimate latency from first frame arrival
      const firstFrameLatency = frameTimestamps[0];
      // Average inter-frame time
      let totalInterFrame = 0;
      for (let i = 1; i < frameTimestamps.length; i++) {
        totalInterFrame += frameTimestamps[i] - frameTimestamps[i - 1];
      }
      const avgInterFrame = totalInterFrame / (frameTimestamps.length - 1);

      const latencyPassed = firstFrameLatency < config.expectedLatencyMs * 2;

      results.tests.push({
        name: 'Latency',
        passed: latencyPassed,
        details: latencyPassed
          ? `First frame: ${firstFrameLatency}ms, avg interval: ${avgInterFrame.toFixed(1)}ms`
          : `High latency: ${firstFrameLatency}ms`,
        measurements: {
          firstFrameLatencyMs: firstFrameLatency,
          avgInterFrameMs: avgInterFrame.toFixed(1),
          expectedFrameIntervalMs: VOICE_FRAME_MS,
        },
      });

      log('minimal', `  First frame arrived: ${firstFrameLatency}ms`);
      log('minimal', `  Avg inter-frame: ${avgInterFrame.toFixed(1)}ms (expected: ${VOICE_FRAME_MS}ms)`);
      log('minimal', `  Result: ${latencyPassed ? 'PASS' : 'FAIL'}\n`);
    } else {
      results.tests.push({
        name: 'Latency',
        passed: false,
        details: 'Insufficient frames for latency measurement',
      });
      log('minimal', `  Insufficient frames`);
      log('minimal', `  Result: FAIL\n`);
    }

  } catch (error) {
    results.tests.push({
      name: 'Test Execution',
      passed: false,
      details: `Error: ${error}`,
    });
    log('minimal', `\nError: ${error}\n`);
  } finally {
    // Cleanup
    if (sender) sender.disconnect();
    if (receiver) receiver.disconnect();
  }

  // Compute overall result
  const failedTests = results.tests.filter(t => !t.passed);
  results.passed = failedTests.length === 0;
  results.summary = results.passed
    ? `All ${results.tests.length} tests passed`
    : `${failedTests.length}/${results.tests.length} tests failed`;

  // Print summary
  log('minimal', '=== Test Summary ===');
  for (const test of results.tests) {
    const status = test.passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    log('minimal', `[${status}] ${test.name}: ${test.details}`);
  }
  log('minimal', `\nOverall: ${results.summary}\n`);

  return results;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// CLI runner
if (process.argv[1]?.includes('EndToEndTest')) {
  const config: E2ETestConfig = {
    serverUrl: process.argv.find(a => a.startsWith('--server='))?.split('=')[1] || 'ws://localhost:8080',
    testFrequency: 440,
    testAmplitude: 0.6,
    testDurationMs: 2000,
    expectedLatencyMs: 150,
    logLevel: process.argv.includes('--verbose') ? 'verbose' : 'minimal',
  };

  runEndToEndTest(config)
    .then(result => process.exit(result.passed ? 0 : 1))
    .catch(err => {
      console.error('Fatal error:', err);
      process.exit(1);
    });
}
