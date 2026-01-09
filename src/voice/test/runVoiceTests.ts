#!/usr/bin/env npx tsx
/**
 * Voice Chat Test Runner
 *
 * Run with:
 *   npx tsx src/voice/test/runVoiceTests.ts [options]
 *
 * Options:
 *   --server=URL     Server URL (default: ws://localhost:8080)
 *   --clients=N      Number of test clients (default: 3)
 *   --duration=MS    Test duration in ms (default: 3000)
 *   --verbose        Enable verbose logging
 *   --quiet          Minimal output
 *   --e2e            Run end-to-end signal integrity test
 *   --frequency=HZ   Test signal frequency (default: 440)
 *
 * Make sure the server is running first:
 *   cd server && npm run dev
 */

import { runVoiceTests, VoiceTestConfig } from './VoiceTestHarness.js';
import { runEndToEndTest, E2ETestConfig } from './EndToEndTest.js';

interface ParsedArgs {
  config: Partial<VoiceTestConfig>;
  runE2E: boolean;
  frequency: number;
}

// Parse command line arguments
function parseArgs(): ParsedArgs {
  const config: Partial<VoiceTestConfig> = {};
  let runE2E = false;
  let frequency = 440;

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--server=')) {
      config.serverUrl = arg.split('=')[1];
    } else if (arg.startsWith('--clients=')) {
      config.numClients = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--duration=')) {
      config.testDurationMs = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--frequency=')) {
      frequency = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--verbose') {
      config.logLevel = 'verbose';
    } else if (arg === '--quiet') {
      config.logLevel = 'silent';
    } else if (arg === '--e2e') {
      runE2E = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return { config, runE2E, frequency };
}

function printHelp(): void {
  console.log(`
Voice Chat Test Runner

Usage:
  npx tsx src/voice/test/runVoiceTests.ts [options]

Options:
  --server=URL     Server URL (default: ws://localhost:8080)
  --clients=N      Number of test clients (default: 3)
  --duration=MS    Test duration in ms (default: 3000)
  --verbose        Enable verbose logging
  --quiet          Minimal output
  --e2e            Run end-to-end signal integrity test
  --frequency=HZ   Test signal frequency in Hz (default: 440)
  --help, -h       Show this help

Prerequisites:
  1. Start the game server first:
     cd server && npm run dev

  2. Then run the tests:
     npx tsx src/voice/test/runVoiceTests.ts

Examples:
  # Run with 5 clients for 5 seconds
  npx tsx src/voice/test/runVoiceTests.ts --clients=5 --duration=5000

  # Run end-to-end signal integrity test
  npx tsx src/voice/test/runVoiceTests.ts --e2e --frequency=880 --verbose

  # Connect to different server
  npx tsx src/voice/test/runVoiceTests.ts --server=ws://192.168.1.100:8080
`);
}

async function main(): Promise<void> {
  console.log('\n=== Voice Chat Test Suite ===\n');

  const { config, runE2E, frequency } = parseArgs();
  const serverUrl = config.serverUrl || 'ws://localhost:8080';
  const logLevel = config.logLevel || 'minimal';

  console.log('Configuration:');
  console.log(`  Server: ${serverUrl}`);
  console.log(`  Mode: ${runE2E ? 'End-to-End Signal Test' : 'Multi-Client Test'}`);
  if (runE2E) {
    console.log(`  Test Frequency: ${frequency}Hz`);
  } else {
    console.log(`  Clients: ${config.numClients || 3}`);
  }
  console.log(`  Duration: ${config.testDurationMs || 3000}ms`);
  console.log(`  Log Level: ${logLevel}`);
  console.log('');

  try {
    if (runE2E) {
      // Run end-to-end signal integrity test
      const e2eConfig: E2ETestConfig = {
        serverUrl,
        testFrequency: frequency,
        testAmplitude: 0.6,
        testDurationMs: config.testDurationMs || 2000,
        expectedLatencyMs: 150,
        logLevel,
      };

      const result = await runEndToEndTest(e2eConfig);
      process.exit(result.passed ? 0 : 1);
    } else {
      // Run multi-client test suite
      const results = await runVoiceTests(config);
      const failed = results.filter(r => !r.passed).length;
      process.exit(failed > 0 ? 1 : 0);
    }

  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

main().catch(console.error);
