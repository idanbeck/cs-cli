#!/usr/bin/env node
/**
 * Voice Playback Integration Test
 *
 * Tests the full voice pipeline WITH AUDIO PLAYBACK:
 * TX Client: Generate test tone -> Codec2 Encode -> WebSocket -> Server
 * RX Client: Server -> WebSocket -> Codec2 Decode -> NativeAudioPlayer -> SPEAKER
 *
 * You should hear a 440Hz test tone for 5 seconds.
 */

import { Vector3 } from '../engine/math/Vector3.js';
import { HeadlessVoiceClient } from '../voice/test/HeadlessVoiceClient.js';
import { SignalConfig } from '../voice/test/TestSignalGenerator.js';
import { getNativeAudioPlayer } from '../voice/NativeAudioPlayer.js';
import { VOICE_SAMPLE_RATE } from '../voice/types.js';

const SERVER_URL = 'ws://localhost:8080';
const TEST_DURATION_MS = 5000;
const TEST_FREQUENCY = 440;

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runPlaybackTest(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Voice Playback Integration Test');
  console.log('='.repeat(60));
  console.log(`\nYou should hear a ${TEST_FREQUENCY}Hz tone for ${TEST_DURATION_MS / 1000} seconds.\n`);

  let sender: HeadlessVoiceClient | null = null;
  let receiver: HeadlessVoiceClient | null = null;

  try {
    // Get the audio player
    const audioPlayer = getNativeAudioPlayer();

    // Create sender
    const senderSignal: SignalConfig = {
      type: 'sine',
      frequency: TEST_FREQUENCY,
      amplitude: 0.7,
      durationMs: TEST_DURATION_MS,
    };

    sender = new HeadlessVoiceClient({
      serverUrl: SERVER_URL,
      playerName: 'TX-Client',
      position: new Vector3(0, 0, 0),
      signalConfig: senderSignal,
      logLevel: 'minimal',
    });

    console.log('[TX] Connecting...');
    await sender.connect();
    await sender.waitUntilReady();
    const roomId = sender.getRoomId();
    console.log(`[TX] Connected, room: ${roomId}`);

    // Create receiver
    receiver = new HeadlessVoiceClient({
      serverUrl: SERVER_URL,
      playerName: 'RX-Client',
      roomId,
      position: new Vector3(10, 0, 0),
      logLevel: 'minimal',
    });

    console.log('[RX] Connecting...');
    await receiver.connect();
    await receiver.waitUntilReady();
    console.log('[RX] Connected');

    // Set up audio playback on receive
    let framesReceived = 0;
    let samplesPlayed = 0;

    receiver.onFrameReceived((_senderId, frame) => {
      framesReceived++;

      // Upsample from 8kHz mono to 22050Hz stereo for NativeAudioPlayer
      const ratio = 22050 / VOICE_SAMPLE_RATE;
      const outputLength = Math.floor(frame.samples.length * ratio);
      const stereoOutput = new Int16Array(outputLength * 2);

      for (let i = 0; i < outputLength; i++) {
        const srcIdx = Math.min(Math.floor(i / ratio), frame.samples.length - 1);
        const sample = frame.samples[srcIdx];
        stereoOutput[i * 2] = sample;      // Left
        stereoOutput[i * 2 + 1] = sample;  // Right
      }

      // Play through NativeAudioPlayer
      audioPlayer.play(stereoOutput);
      samplesPlayed += stereoOutput.length;

      if (framesReceived % 25 === 0) {
        console.log(`[RX] Playing... ${framesReceived} frames received`);
      }
    });

    // Wait for clients to stabilize
    await delay(300);

    // Start transmission
    console.log('\n[TX] Starting transmission...');
    console.log('[RX] Playing received audio through speakers...\n');
    sender.startTransmitting();

    // Wait for test duration + buffer
    await delay(TEST_DURATION_MS + 1000);
    sender.stopTransmitting();

    // Wait for final playback
    await delay(1000);

    // Print results
    const senderStats = sender.getStats();
    console.log('\n' + '='.repeat(60));
    console.log('Test Complete');
    console.log('='.repeat(60));
    console.log(`TX: Sent ${senderStats.framesSent} frames`);
    console.log(`RX: Received ${framesReceived} frames`);
    console.log(`Samples played: ${samplesPlayed}`);
    console.log(`Delivery rate: ${((framesReceived / senderStats.framesSent) * 100).toFixed(1)}%`);

    if (framesReceived === 0) {
      console.log('\n[ERROR] No frames received!');
      console.log('Check that the server is relaying binary frames correctly.');
    } else if (samplesPlayed > 0) {
      console.log('\n[SUCCESS] Audio should have played through your speakers!');
      console.log('If you did not hear anything, check:');
      console.log('  1. Your system volume is turned up');
      console.log('  2. The correct output device is selected');
      console.log('  3. afplay command works: afplay /System/Library/Sounds/Ping.aiff');
    }

  } catch (error) {
    console.error('\n[ERROR]', error);
  } finally {
    if (sender) sender.disconnect();
    if (receiver) receiver.disconnect();

    // Give audio player time to finish
    await delay(500);

    console.log('\n[Done]');
    process.exit(0);
  }
}

// Run the test
runPlaybackTest().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
