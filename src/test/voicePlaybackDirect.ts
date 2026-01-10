#!/usr/bin/env node
/**
 * Direct VoicePlayback Test
 *
 * Tests VoicePlayback in isolation - generates a test tone and feeds it
 * directly through VoicePlayback to verify the speaker integration works.
 */

import { VoicePlayback, getVoicePlayback } from '../voice/VoicePlayback.js';
import { VOICE_SAMPLE_RATE, VOICE_FRAME_SAMPLES, VOICE_FRAME_MS } from '../voice/types.js';

const TEST_DURATION_MS = 3000;
const TEST_FREQUENCY = 440;

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTest(): Promise<void> {
  console.log('='.repeat(60));
  console.log('VoicePlayback Direct Test');
  console.log('='.repeat(60));
  console.log(`\nGenerating ${TEST_FREQUENCY}Hz tone for ${TEST_DURATION_MS / 1000}s`);
  console.log('This tests VoicePlayback in isolation.\n');

  const playback = getVoicePlayback();
  playback.start();

  const numFrames = Math.floor(TEST_DURATION_MS / VOICE_FRAME_MS);
  let sampleOffset = 0;

  console.log(`Sending ${numFrames} frames (${VOICE_FRAME_SAMPLES * 2} stereo samples each)...\n`);

  for (let frame = 0; frame < numFrames; frame++) {
    // Generate stereo 16-bit samples at 8kHz (what VoicePlayback expects)
    const samples = new Int16Array(VOICE_FRAME_SAMPLES * 2); // 320 samples (160 stereo pairs)

    for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
      const t = (sampleOffset + i) / VOICE_SAMPLE_RATE;
      // 440Hz sine wave
      const sample = Math.sin(2 * Math.PI * TEST_FREQUENCY * t) * 16000;
      const value = Math.round(sample);
      samples[i * 2] = value;     // Left
      samples[i * 2 + 1] = value; // Right
    }

    sampleOffset += VOICE_FRAME_SAMPLES;

    // Queue the frame
    playback.queueFrame(samples);

    // Wait 20ms to simulate real-time delivery
    await delay(VOICE_FRAME_MS);
  }

  console.log('\nWaiting for playback to complete...');
  await delay(1000);

  playback.stop();

  console.log('\n' + '='.repeat(60));
  console.log('Test complete!');
  console.log('='.repeat(60));
  console.log('\nIf you heard a tone, VoicePlayback works correctly.');
  console.log('If not, the issue is in VoicePlayback speaker integration.');

  process.exit(0);
}

runTest().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
