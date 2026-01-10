/**
 * VocoderDebug - Debug loopback for testing vocoder quality
 *
 * Records from mic until silence, stores both original and encoded/decoded.
 * Provides TUI for tweaking vocoder parameters in real-time.
 */

import Speaker from 'speaker';
import { appendFileSync, writeFileSync } from 'fs';
import { MicCapture, initializeMicCapture, destroyMicCapture } from './MicCapture.js';
import { VOICE_SAMPLE_RATE, VOICE_FRAME_SAMPLES } from './types.js';
import { Codec2, Codec2ModeString } from './Codec2.js';

// Debug log file
const LOG_FILE = '/tmp/vocoder_debug.log';

function debugLog(msg: string): void {
  const timestamp = new Date().toISOString();
  try {
    appendFileSync(LOG_FILE, `${timestamp} ${msg}\n`);
  } catch {
    // Ignore log errors
  }
}

// Configurable vocoder parameters
export interface VocoderParams {
  // Native Codec2 mode (overrides LPC when true)
  useNativeCodec2: boolean;   // Use native Codec2 library instead of LPC
  codec2Mode: Codec2ModeString; // '3200' | '2400' | '1600' | '1300' | '700C' etc.

  // Codec settings - THE KEY TO INTELLIGIBILITY
  codecBytes: number;         // 16-64 bytes per 20ms frame (more = clearer voice!)
  lpcOrder: number;           // 4-24 (more = better formants)

  // LPC settings
  preEmphasis: number;        // 0.9-0.99 (high freq boost before analysis)
  bwExpand: number;           // 0.9-1.0 (bandwidth expansion)

  // Filter settings
  highpassCutoff: number;     // 50-500 Hz (remove low rumble)
  lowpassCutoff: number;      // 2000-4000 Hz (telephone bandwidth)
  filterQ: number;            // 0.5-3.0 (filter resonance)

  // Excitation settings
  excitationType: 'sawtooth' | 'pulse' | 'triangle' | 'square' | 'impulse' | 'noise' | 'sync' | 'diff';
  voicingThreshold: number;   // 0.1-0.6 (pitch detection sensitivity)
  aspirationLevel: number;    // 0.0-0.5 (breathiness)
  pitchShift: number;         // 0.5-2.0 (pitch modification)

  // Radio effects
  bitCrush: number;           // 8-16 bits
  sampleRateDiv: number;      // 1-4 (sample rate decimation)
  ringModFreq: number;        // 0-500 Hz (metallic ring)
  ringModMix: number;         // 0.0-0.5 (ring mod amount)
  noiseLevel: number;         // 0.0-0.2 (static)

  // Output settings
  deEmphasis: number;         // 0.9-0.99 (restore high freq)
  outputGain: number;         // 0.5-3.0 (volume)
  hardClip: number;           // 0.0-0.5 (distortion)
  formantShift: number;       // 0.7-1.5 (voice character)
}

export const DEFAULT_VOCODER_PARAMS: VocoderParams = {
  // CSterm default - Codec2 with tactical radio character
  useNativeCodec2: true,      // Use Codec2 by default
  codec2Mode: '2400',         // 2400bps - good balance of quality and bandwidth
  codecBytes: 32,             // 32 bytes = ~12.8 kbps (for LPC fallback)
  lpcOrder: 10,               // Lower order = smoother formants, less peaky
  preEmphasis: 0.93,          // Lower for more natural sound
  bwExpand: 0.985,            // Wider bandwidth for clearer formants
  highpassCutoff: 180,        // CSterm: slight bass cut for radio character
  lowpassCutoff: 2200,        // CSterm: bandwidth limiting for radio feel
  filterQ: 0.707,
  excitationType: 'sync',     // Sync oscillator for richer sound
  voicingThreshold: 0.35,     // Reduce buzzy artifacts
  aspirationLevel: 0.08,      // Light breathiness
  pitchShift: 1.0,
  bitCrush: 10,               // CSterm: slight digital artifact
  sampleRateDiv: 1,
  ringModFreq: 0,
  ringModMix: 0,
  noiseLevel: 0,              // CSterm: clean, no static
  deEmphasis: 0.93,           // Match pre-emphasis
  outputGain: 1.5,            // CSterm: boosted output
  hardClip: 0.25,             // CSterm: radio compression/distortion
  formantShift: 1.0,
};

// Preset configurations for quick switching
export const VOCODER_PRESETS: Record<string, Partial<VocoderParams>> = {
  // === CSTERM DEFAULT - The signature CS-CLI voice sound ===
  'CSterm': {
    // Classic military tactical radio - the default for CS-CLI multiplayer
    useNativeCodec2: true,
    codec2Mode: '2400',
    highpassCutoff: 180,
    lowpassCutoff: 2200,
    noiseLevel: 0.0,
    hardClip: 0.25,
    bitCrush: 10,
    outputGain: 1.5,
  },

  // === NATIVE CODEC2 PRESETS - Clean modes ===
  'Codec2 3.2k': {
    // Best quality - 3200 bps native codec
    useNativeCodec2: true,
    codec2Mode: '3200',
    outputGain: 1.0,
  },
  'Codec2 2.4k': {
    // Good quality - 2400 bps native codec
    useNativeCodec2: true,
    codec2Mode: '2400',
    outputGain: 1.0,
  },
  'Codec2 1.6k': {
    // Moderate quality - 1600 bps native codec
    useNativeCodec2: true,
    codec2Mode: '1600',
    outputGain: 1.0,
  },
  'Codec2 700C': {
    // Ultra low bitrate - 700 bps native codec
    useNativeCodec2: true,
    codec2Mode: '700C',
    outputGain: 1.0,
  },

  // === CODEC2 MILITARY RADIO PRESETS ===
  'Mil Radio Clean': {
    // Clean military radio - codec compression + slight bandwidth limiting
    useNativeCodec2: true,
    codec2Mode: '2400',
    highpassCutoff: 300,
    lowpassCutoff: 3000,
    noiseLevel: 0.01,
    hardClip: 0.05,
    outputGain: 1.1,
  },
  'Mil Radio Static': {
    // Military radio with background static/hiss
    useNativeCodec2: true,
    codec2Mode: '2400',
    highpassCutoff: 350,
    lowpassCutoff: 2800,
    noiseLevel: 0.04,
    hardClip: 0.1,
    bitCrush: 14,
    outputGain: 1.15,
  },
  'Mil Radio Harsh': {
    // Harsh field radio conditions - more distortion
    useNativeCodec2: true,
    codec2Mode: '1600',
    highpassCutoff: 400,
    lowpassCutoff: 2500,
    noiseLevel: 0.06,
    hardClip: 0.2,
    bitCrush: 12,
    outputGain: 1.2,
  },
  'Mil Encrypted': {
    // Encrypted comms feel - digital artifacts
    useNativeCodec2: true,
    codec2Mode: '700C',
    highpassCutoff: 300,
    lowpassCutoff: 3200,
    noiseLevel: 0.02,
    hardClip: 0.08,
    bitCrush: 13,
    outputGain: 1.1,
  },
  'Radio Telephone': {
    // Classic telephone/radio hybrid
    useNativeCodec2: true,
    codec2Mode: '2400',
    highpassCutoff: 300,
    lowpassCutoff: 3400,
    noiseLevel: 0.015,
    hardClip: 0.05,
    outputGain: 1.0,
  },

  // === LPC VOCODER PRESETS (Stylized/radio effects) ===
  'HQ Clear': {
    // Maximum intelligibility - 64 bytes = ~25.6 kbps
    codecBytes: 64,
    lpcOrder: 12,           // Smooth formants
    preEmphasis: 0.92,
    bwExpand: 0.980,        // Wide for clearer formants
    highpassCutoff: 60,
    lowpassCutoff: 3800,
    voicingThreshold: 0.4,
    aspirationLevel: 0.1,
    deEmphasis: 0.92,
    excitationType: 'diff', // Differentiated pulse - natural HF
  },
  'Police Radio': {
    // Clear but with radio character - 48 bytes
    codecBytes: 48,
    lpcOrder: 10,           // Smooth formants
    preEmphasis: 0.92,
    bwExpand: 0.982,
    highpassCutoff: 200,
    lowpassCutoff: 3200,
    voicingThreshold: 0.4,
    aspirationLevel: 0.08,
    filterQ: 1.0,
    noiseLevel: 0.015,
    hardClip: 0.08,
    deEmphasis: 0.92,
    excitationType: 'sync',
    outputGain: 1.15,
  },
  'Military': {
    // Tactical radio sound - 32 bytes
    codecBytes: 32,
    lpcOrder: 10,
    preEmphasis: 0.91,
    bwExpand: 0.980,
    highpassCutoff: 300,
    lowpassCutoff: 2800,
    filterQ: 1.2,
    noiseLevel: 0.04,
    hardClip: 0.15,
    aspirationLevel: 0.1,
    deEmphasis: 0.91,
    excitationType: 'sync',
  },
  'Walkie Talkie': {
    // Classic walkie talkie - 24 bytes
    codecBytes: 24,
    lpcOrder: 8,
    preEmphasis: 0.90,
    bwExpand: 0.975,
    highpassCutoff: 350,
    lowpassCutoff: 2500,
    filterQ: 1.4,
    noiseLevel: 0.06,
    hardClip: 0.25,
    deEmphasis: 0.90,
    excitationType: 'sync',
    outputGain: 1.2,
  },
  'Droid': {
    // Star Wars style
    codecBytes: 40,
    lpcOrder: 12,
    pitchShift: 1.15,
    ringModFreq: 100,
    ringModMix: 0.2,
    formantShift: 1.1,
    aspirationLevel: 0.05,
  },
  'Vader': {
    // Deep and menacing
    codecBytes: 48,
    lpcOrder: 16,
    pitchShift: 0.8,
    formantShift: 0.9,
    aspirationLevel: 0.2,
    bwExpand: 0.99,
    noiseLevel: 0.02,
  },
  'Robot': {
    // Robotic
    codecBytes: 32,
    lpcOrder: 10,
    excitationType: 'square',
    pitchShift: 0.95,
    bitCrush: 12,
    ringModFreq: 50,
    ringModMix: 0.15,
  },
};

export type DebugState = 'idle' | 'recording' | 'playing_original' | 'playing_processed';
type StateCallback = (state: DebugState, info: string) => void;
type LevelCallback = (level: number) => void;
type WaveformCallback = (waveform: number[]) => void;
type PlaybackPositionCallback = (position: number) => void; // 0-1 normalized position

/**
 * Vocoder debug/loopback tool
 */
export class VocoderDebug {
  private mic: MicCapture | null = null;
  private speaker: Speaker | null = null;
  private params: VocoderParams;

  // Native Codec2 instance
  private codec2: Codec2 | null = null;
  private codec2Initialized = false;

  private state: DebugState = 'idle';
  private originalFrames: Int16Array[] = [];
  private processedFrames: Int16Array[] = [];

  // Filter state (persistent across frames)
  private hpState1 = 0;
  private hpState2 = 0;
  private lpState1 = 0;
  private lpState2 = 0;

  // Callbacks
  private onStateChange: StateCallback | null = null;
  private onLevelChange: LevelCallback | null = null;
  private onWaveformChange: WaveformCallback | null = null;
  private onPlaybackPosition: PlaybackPositionCallback | null = null;

  // Throttling for UI updates - higher values reduce flickering
  private lastLevelUpdate = 0;
  private readonly LEVEL_UPDATE_INTERVAL = 150; // ms - slower updates to prevent flicker
  private lastStatusUpdate = 0;
  private readonly STATUS_UPDATE_INTERVAL = 200; // ms

  // Playback position tracking
  private playbackTimer: ReturnType<typeof setInterval> | null = null;
  private playbackStartTime = 0;
  private playbackDuration = 0;
  private readonly PLAYBACK_UPDATE_INTERVAL = 200; // ms - slower position updates

  // Ring modulator phase
  private ringModPhase = 0;

  constructor(params: Partial<VocoderParams> = {}) {
    this.params = { ...DEFAULT_VOCODER_PARAMS, ...params };
  }

  /**
   * Initialize the debug system
   */
  async initialize(): Promise<void> {
    // Clear log file
    try {
      writeFileSync(LOG_FILE, `=== Vocoder Debug Session Started ===\n`);
    } catch { /* ignore */ }

    debugLog('Initializing...');
    this.mic = await initializeMicCapture();
    debugLog(`Mic initialized, isAvailable: ${this.mic?.isAvailable}`);

    // Initialize native Codec2 if available
    if (Codec2.isNativeAvailable()) {
      debugLog('Native Codec2 available, initializing...');
      await this.initializeCodec2();
    } else {
      debugLog('Native Codec2 NOT available - will use LPC fallback');
    }
  }

  /**
   * Initialize or re-initialize Codec2 with current mode
   */
  private async initializeCodec2(): Promise<void> {
    const { Codec2Mode } = await import('./types.js');

    // Map string mode to enum
    const modeMap: Record<Codec2ModeString, number> = {
      '3200': Codec2Mode.MODE_3200,
      '2400': Codec2Mode.MODE_2400,
      '1600': Codec2Mode.MODE_1600,
      '1400': Codec2Mode.MODE_1400,
      '1300': Codec2Mode.MODE_1300,
      '1200': Codec2Mode.MODE_1200,
      '700C': Codec2Mode.MODE_700C,
    };

    const modeEnum = modeMap[this.params.codec2Mode] ?? Codec2Mode.MODE_2400;

    if (this.codec2) {
      this.codec2.destroy();
    }

    this.codec2 = new Codec2(modeEnum);
    await this.codec2.initialize();
    this.codec2Initialized = true;

    const modeInfo = Codec2.getModeInfo(this.params.codec2Mode);
    if (modeInfo) {
      debugLog(`Codec2 initialized: ${this.params.codec2Mode} bps, ${modeInfo.samplesPerFrame} samples/frame, ${modeInfo.bytesPerFrame} bytes/frame`);
    }
  }

  /**
   * Set callbacks
   */
  setCallbacks(
    onState: StateCallback,
    onLevel: LevelCallback,
    onWaveform?: WaveformCallback,
    onPlaybackPos?: PlaybackPositionCallback
  ): void {
    this.onStateChange = onState;
    this.onLevelChange = onLevel;
    this.onWaveformChange = onWaveform || null;
    this.onPlaybackPosition = onPlaybackPos || null;
  }

  /**
   * Load a preset
   */
  loadPreset(presetName: string): void {
    const preset = VOCODER_PRESETS[presetName];
    if (preset) {
      const oldCodec2Mode = this.params.codec2Mode;
      this.params = { ...DEFAULT_VOCODER_PARAMS, ...preset };

      // Reset filter state
      this.hpState1 = this.hpState2 = 0;
      this.lpState1 = this.lpState2 = 0;

      // Re-initialize Codec2 if mode changed
      if (this.params.useNativeCodec2 && this.params.codec2Mode !== oldCodec2Mode) {
        this.initializeCodec2().catch(err => {
          debugLog(`Failed to re-init Codec2: ${err}`);
        });
      }
    }
  }

  /**
   * Get available preset names
   */
  getPresetNames(): string[] {
    return Object.keys(VOCODER_PRESETS);
  }

  /**
   * Update vocoder parameters
   */
  updateParams(params: Partial<VocoderParams>): void {
    Object.assign(this.params, params);
    if ('highpassCutoff' in params || 'lowpassCutoff' in params) {
      this.hpState1 = this.hpState2 = 0;
      this.lpState1 = this.lpState2 = 0;
    }
  }

  /**
   * Get current parameters
   */
  getParams(): VocoderParams {
    return { ...this.params };
  }

  /**
   * Check if we have a recording
   */
  hasRecording(): boolean {
    return this.originalFrames.length > 0;
  }

  /**
   * Get recording duration in seconds
   */
  getRecordingDuration(): number {
    return (this.originalFrames.length * 20) / 1000;
  }

  /**
   * Start recording - press SPACE again to stop
   */
  startRecording(): void {
    debugLog(`startRecording called, state=${this.state}`);

    if (this.state !== 'idle') {
      debugLog('Not idle, ignoring');
      return;
    }

    if (!this.mic) {
      debugLog('ERROR: Mic not initialized');
      this.emitState('Error: Mic not initialized');
      return;
    }

    if (!this.mic.isAvailable) {
      debugLog('ERROR: Mic not available');
      this.emitState('Error: No microphone available (naudiodon2 not installed?)');
      return;
    }

    this.state = 'recording';
    this.originalFrames = [];
    this.processedFrames = [];

    // Reset filter state
    this.hpState1 = this.hpState2 = 0;
    this.lpState1 = this.lpState2 = 0;

    debugLog('Starting mic capture...');
    this.emitState('Recording... (SPACE to stop)');

    try {
      this.mic.start((samples) => this.onMicFrame(samples));
      debugLog(`Mic started, capturing=${this.mic.capturing}`);

      // Check if mic actually started
      setTimeout(() => {
        debugLog(`Mic check: state=${this.state}, capturing=${this.mic?.capturing}`);
        if (this.state === 'recording' && !this.mic?.capturing) {
          debugLog('ERROR: Mic not capturing after start');
          this.state = 'idle';
          this.emitState('Error: Mic failed to start');
        }
      }, 100);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      debugLog(`ERROR starting mic: ${errMsg}`);
      this.state = 'idle';
      this.emitState(`Error: ${errMsg}`);
    }
  }

  /**
   * Stop recording manually
   */
  stopRecordingManual(): void {
    debugLog(`stopRecordingManual called, state=${this.state}, frames=${this.originalFrames.length}`);
    if (this.state === 'recording') {
      this.stopRecording();
    }
  }

  /**
   * Handle incoming mic frame
   */
  private onMicFrame(samples: Int16Array): void {
    if (this.state !== 'recording') return;

    try {
      // Store frame
      this.originalFrames.push(samples.slice());

      // Calculate RMS level for UI
      let sumSquares = 0;
      for (let i = 0; i < samples.length; i++) {
        sumSquares += samples[i] * samples[i];
      }
      const rms = Math.sqrt(sumSquares / samples.length);

      // Throttle UI updates to prevent flicker
      const now = Date.now();
      if (now - this.lastLevelUpdate >= this.LEVEL_UPDATE_INTERVAL) {
        this.lastLevelUpdate = now;

        // Update mic level
        const normalizedLevel = Math.min(1, rms / 16384);
        this.onLevelChange?.(normalizedLevel);

        // Update status with duration
        const duration = (this.originalFrames.length * 20 / 1000).toFixed(1);
        this.emitState(`Recording: ${duration}s (SPACE to stop)`);
      }
    } catch (err) {
      debugLog(`Frame processing error: ${err}`);
    }
  }

  /**
   * Stop recording and process
   */
  private stopRecording(): void {
    debugLog(`stopRecording: ${this.originalFrames.length} frames`);
    this.mic?.stop();
    this.emitState('Processing...');
    this.onLevelChange?.(0);

    if (this.originalFrames.length === 0) {
      debugLog('No frames recorded');
      this.state = 'idle';
      this.emitState('No audio recorded - try again');
      return;
    }

    // Process all frames through encode/decode
    this.processedFrames = [];

    // Reset filter state for processing
    this.hpState1 = this.hpState2 = 0;
    this.lpState1 = this.lpState2 = 0;

    debugLog('Encoding/decoding frames...');

    // Use native Codec2 if enabled and available
    if (this.params.useNativeCodec2 && this.codec2 && this.codec2Initialized) {
      this.processFramesWithCodec2();
    } else {
      // Use LPC vocoder
      for (const original of this.originalFrames) {
        const encoded = this.encodeFrame(original);
        const decoded = this.decodeFrame(encoded);
        this.processedFrames.push(decoded);
      }
    }
    debugLog(`Processed ${this.processedFrames.length} frames`);

    // Generate waveform for display
    this.updateWaveform();

    this.state = 'idle';
    const duration = (this.originalFrames.length * 20 / 1000).toFixed(1);
    this.emitState(`Ready (${duration}s) - O: Original, P: Processed`);
    debugLog('Ready for playback');
  }

  /**
   * Update waveform display
   */
  private updateWaveform(): void {
    if (!this.onWaveformChange || this.originalFrames.length === 0) return;

    // Sample the waveform at regular intervals for display
    const displayWidth = 70;
    const waveform: number[] = [];
    const totalSamples = this.originalFrames.length * VOICE_FRAME_SAMPLES;
    const samplesPerPixel = Math.max(1, Math.floor(totalSamples / displayWidth));

    for (let i = 0; i < displayWidth; i++) {
      const startSample = i * samplesPerPixel;
      const endSample = Math.min(startSample + samplesPerPixel, totalSamples);

      // Get RMS value in this pixel's range for smoother display
      let sumSquares = 0;
      let count = 0;

      for (let s = startSample; s < endSample; s++) {
        const frameIdx = Math.floor(s / VOICE_FRAME_SAMPLES);
        const sampleIdx = s % VOICE_FRAME_SAMPLES;

        if (frameIdx < this.originalFrames.length) {
          const sample = this.originalFrames[frameIdx][sampleIdx];
          sumSquares += sample * sample;
          count++;
        }
      }

      if (count > 0) {
        const rms = Math.sqrt(sumSquares / count);
        // Normalize with some headroom and apply slight curve for better visual
        const normalized = Math.min(1, (rms / 20000) ** 0.7);
        waveform.push(normalized);
      } else {
        waveform.push(0);
      }
    }

    this.onWaveformChange(waveform);
  }

  /**
   * Play original recording
   */
  playOriginal(): void {
    if (this.state !== 'idle' || this.originalFrames.length === 0) return;
    this.playFrames(this.originalFrames, 'playing_original', 'Playing original...');
  }

  /**
   * Play processed (encoded/decoded) recording
   * Re-processes with current parameters each time!
   */
  playProcessed(): void {
    if (this.state !== 'idle' || this.originalFrames.length === 0) return;

    // Re-process with current parameters
    this.emitState('Processing with current params...');

    // Reset filter state for processing
    this.hpState1 = this.hpState2 = 0;
    this.lpState1 = this.lpState2 = 0;
    this.ringModPhase = 0;

    this.processedFrames = [];

    // Use native Codec2 if enabled and available
    if (this.params.useNativeCodec2 && this.codec2 && this.codec2Initialized) {
      this.processFramesWithCodec2();
    } else {
      // Use LPC vocoder
      for (const original of this.originalFrames) {
        const encoded = this.encodeFrame(original);
        const decoded = this.decodeFrame(encoded);
        this.processedFrames.push(decoded);
      }
    }

    this.playFrames(this.processedFrames, 'playing_processed', 'Playing processed...');
  }

  /**
   * Process frames using native Codec2
   * Handles different frame sizes between our 160-sample frames and Codec2's requirements
   * Applies post-processing effects (bandpass, noise, distortion) for radio character
   */
  private processFramesWithCodec2(): void {
    if (!this.codec2 || !this.codec2Initialized) return;

    const modeInfo = Codec2.getModeInfo(this.params.codec2Mode);
    if (!modeInfo) {
      debugLog('Failed to get Codec2 mode info');
      return;
    }

    const codec2SamplesPerFrame = modeInfo.samplesPerFrame;
    debugLog(`Codec2 mode ${this.params.codec2Mode}: ${codec2SamplesPerFrame} samples/frame`);

    // Concatenate all original frames into one buffer
    const totalSamples = this.originalFrames.length * VOICE_FRAME_SAMPLES;
    const allSamples = new Int16Array(totalSamples);
    for (let i = 0; i < this.originalFrames.length; i++) {
      allSamples.set(this.originalFrames[i], i * VOICE_FRAME_SAMPLES);
    }

    // Process in Codec2 frame-sized chunks
    const numCodec2Frames = Math.floor(totalSamples / codec2SamplesPerFrame);
    const decodedSamples = new Int16Array(numCodec2Frames * codec2SamplesPerFrame);

    for (let i = 0; i < numCodec2Frames; i++) {
      const frameStart = i * codec2SamplesPerFrame;
      const frameSamples = allSamples.slice(frameStart, frameStart + codec2SamplesPerFrame);

      // Encode and decode through Codec2
      const encoded = this.codec2.encode(frameSamples);
      const decoded = this.codec2.decode(encoded);

      decodedSamples.set(decoded, frameStart);
    }

    // Split back into our 160-sample frames and apply post-processing
    const numOutputFrames = Math.floor(decodedSamples.length / VOICE_FRAME_SAMPLES);
    for (let i = 0; i < numOutputFrames; i++) {
      const frameStart = i * VOICE_FRAME_SAMPLES;
      const frame = decodedSamples.slice(frameStart, frameStart + VOICE_FRAME_SAMPLES);

      // Apply post-processing effects for military radio character
      const processed = this.applyCodec2PostProcessing(frame);
      this.processedFrames.push(processed);
    }

    debugLog(`Codec2 processed: ${numCodec2Frames} codec frames -> ${this.processedFrames.length} output frames`);
  }

  /**
   * Apply post-processing effects to Codec2 output
   * Creates the military radio character on top of clean codec output
   */
  private applyCodec2PostProcessing(samples: Int16Array): Int16Array {
    const result = new Int16Array(samples.length);
    const N = samples.length;

    // Convert to float for processing
    const floatSamples = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      floatSamples[i] = samples[i];
    }

    // Apply bandpass filter (simulate radio bandwidth limiting)
    const filtered = this.applyBandpassFilter(samples);

    // Copy filtered back to float
    for (let i = 0; i < N; i++) {
      floatSamples[i] = filtered[i];
    }

    // Add static noise
    if (this.params.noiseLevel > 0) {
      const noiseAmp = this.params.noiseLevel * 6000;
      for (let i = 0; i < N; i++) {
        floatSamples[i] += (Math.random() * 2 - 1) * noiseAmp;
      }
    }

    // Bit crushing (digital radio artifact)
    const bitDepth = Math.max(1, Math.min(16, Math.floor(this.params.bitCrush)));
    if (bitDepth < 16) {
      const levels = Math.pow(2, bitDepth);
      for (let i = 0; i < N; i++) {
        const normalized = (floatSamples[i] + 32768) / 65536;
        const quantized = Math.floor(normalized * levels) / levels;
        floatSamples[i] = quantized * 65536 - 32768;
      }
    }

    // Hard clipping / distortion (radio compression)
    if (this.params.hardClip > 0) {
      const clipThreshold = 32767 * (1 - this.params.hardClip * 0.9);
      for (let i = 0; i < N; i++) {
        if (floatSamples[i] > clipThreshold) {
          floatSamples[i] = clipThreshold + (floatSamples[i] - clipThreshold) * 0.1;
        } else if (floatSamples[i] < -clipThreshold) {
          floatSamples[i] = -clipThreshold + (floatSamples[i] + clipThreshold) * 0.1;
        }
      }
    }

    // Output gain and soft limiting
    for (let i = 0; i < N; i++) {
      let sample = floatSamples[i] * this.params.outputGain;

      // Soft knee limiter
      if (sample > 24000) {
        sample = 24000 + (sample - 24000) * 0.3;
      } else if (sample < -24000) {
        sample = -24000 + (sample + 24000) * 0.3;
      }

      result[i] = Math.max(-32768, Math.min(32767, Math.round(sample)));
    }

    return result;
  }

  /**
   * Play a set of frames
   */
  private playFrames(frames: Int16Array[], newState: DebugState, statusText: string): void {
    this.state = newState;
    this.emitState(statusText);

    // Track playback position
    this.playbackStartTime = Date.now();
    this.playbackDuration = (frames.length * VOICE_FRAME_SAMPLES / VOICE_SAMPLE_RATE) * 1000;

    // Start position update timer
    if (this.playbackTimer) {
      clearInterval(this.playbackTimer);
    }
    this.playbackTimer = setInterval(() => {
      const elapsed = Date.now() - this.playbackStartTime;
      const position = Math.min(1, elapsed / this.playbackDuration);
      this.onPlaybackPosition?.(position);
    }, this.PLAYBACK_UPDATE_INTERVAL);

    // Create speaker
    this.speaker = new Speaker({
      channels: 1,  // Mono
      bitDepth: 16,
      sampleRate: VOICE_SAMPLE_RATE,
      signed: true,
    });

    this.speaker.on('close', () => {
      // Stop position timer
      if (this.playbackTimer) {
        clearInterval(this.playbackTimer);
        this.playbackTimer = null;
      }
      this.onPlaybackPosition?.(0); // Reset position

      this.state = 'idle';
      const duration = (this.originalFrames.length * 20 / 1000).toFixed(1);
      this.emitState(`Ready (${duration}s recorded) - O: Original, P: Processed`);
      this.speaker = null;
    });

    this.speaker.on('error', () => {
      if (this.playbackTimer) {
        clearInterval(this.playbackTimer);
        this.playbackTimer = null;
      }
      this.onPlaybackPosition?.(0);
      this.state = 'idle';
      this.emitState('Playback error');
      this.speaker = null;
    });

    // Apply output gain and write all frames
    for (const frame of frames) {
      const output = new Int16Array(frame.length);
      for (let i = 0; i < frame.length; i++) {
        const sample = Math.round(frame[i] * this.params.outputGain);
        output[i] = Math.max(-32768, Math.min(32767, sample));
      }
      const buffer = Buffer.from(output.buffer, output.byteOffset, output.byteLength);
      this.speaker.write(buffer);
    }

    // End the stream
    this.speaker.end();
  }

  /**
   * Cancel current operation
   */
  cancel(): void {
    this.mic?.stop();
    if (this.playbackTimer) {
      clearInterval(this.playbackTimer);
      this.playbackTimer = null;
    }
    this.onPlaybackPosition?.(0);
    if (this.speaker) {
      this.speaker.end();
      this.speaker = null;
    }
    this.state = 'idle';
    this.onLevelChange?.(0);

    if (this.originalFrames.length > 0) {
      const duration = (this.originalFrames.length * 20 / 1000).toFixed(1);
      this.emitState(`Ready (${duration}s recorded) - O: Original, P: Processed`);
    } else {
      this.emitState('Ready');
    }
  }

  /**
   * Get current state
   */
  getState(): DebugState {
    return this.state;
  }

  /**
   * Emit state change
   */
  private emitState(info: string): void {
    this.onStateChange?.(this.state, info);
  }

  /**
   * Encode a single frame using current parameters
   * Proper LPC vocoder encoding with correct gain handling
   */
  private encodeFrame(samples: Int16Array): Uint8Array {
    const codecBytes = Math.max(16, Math.min(64, this.params.codecBytes));
    const result = new Uint8Array(codecBytes);
    const N = samples.length;

    // Apply bandpass filter
    const bandpassed = this.applyBandpassFilter(samples);

    // Pre-emphasis filter
    const emphasized = new Float32Array(N);
    emphasized[0] = bandpassed[0];
    for (let i = 1; i < N; i++) {
      emphasized[i] = bandpassed[i] - this.params.preEmphasis * bandpassed[i - 1];
    }

    // LPC analysis - use order based on available bytes
    // Reserve 4 bytes for header (2 gain, 1 pitch, 1 voicing)
    const availableBytes = codecBytes - 4;
    const order = Math.min(this.params.lpcOrder, Math.min(24, availableBytes));

    // Compute autocorrelation with Hamming window
    const r = new Float32Array(order + 1);
    for (let k = 0; k <= order; k++) {
      let sum = 0;
      for (let i = 0; i < N - k; i++) {
        const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (N - 1));
        sum += emphasized[i] * w * emphasized[i + k] * (k === 0 ? w : 0.54 - 0.46 * Math.cos(2 * Math.PI * (i + k) / (N - 1)));
      }
      r[k] = sum;
    }

    // Add small regularization for stability
    r[0] += r[0] * 1e-6;

    // Bandwidth expansion for stability
    for (let k = 1; k <= order; k++) {
      r[k] *= Math.pow(this.params.bwExpand, k);
    }

    // Levinson-Durbin to get reflection coefficients AND prediction gain
    const reflectionCoeffs = new Float32Array(order);
    const a = new Float32Array(order + 1);
    a[0] = 1;
    let e = r[0];

    for (let i = 0; i < order; i++) {
      let lambda = r[i + 1];
      for (let j = 1; j <= i; j++) {
        lambda += a[j] * r[i + 1 - j];
      }

      const k = -lambda / (e + 1e-10);
      reflectionCoeffs[i] = Math.max(-0.999, Math.min(0.999, k));

      const aNew = new Float32Array(order + 1);
      aNew[0] = 1;
      for (let j = 1; j <= i; j++) {
        aNew[j] = a[j] + reflectionCoeffs[i] * a[i + 1 - j];
      }
      aNew[i + 1] = reflectionCoeffs[i];
      a.set(aNew);

      e = e * (1 - reflectionCoeffs[i] * reflectionCoeffs[i]);
      if (e < 1e-10) e = 1e-10;
    }

    // Compute INPUT signal RMS (after bandpass, for output scaling)
    // This is critical for matching output loudness to input!
    let signalEnergy = 0;
    for (let i = 0; i < N; i++) {
      signalEnergy += bandpassed[i] * bandpassed[i];
    }
    const signalRMS = Math.sqrt(signalEnergy / N);

    // Quantize signal RMS in log domain (16-bit)
    // Range: roughly 1 to 32000
    const logRMS = Math.max(0, Math.log(signalRMS + 1) / Math.log(32001));
    const rmsQuant = Math.floor(logRMS * 65535);
    result[0] = rmsQuant & 0xFF;
    result[1] = (rmsQuant >> 8) & 0xFF;

    // Pitch detection using autocorrelation of original signal
    const minPitch = 16;  // ~500Hz at 8kHz
    const maxPitch = 120; // ~67Hz at 8kHz
    let bestPitch = 0;
    let bestCorr = 0;

    // Use r[0] from LPC computation as reference energy
    if (r[0] > 100) {
      for (let lag = minPitch; lag <= maxPitch; lag++) {
        // Calculate correlation at this lag
        let corrNum = 0;
        let corrDen = 0;
        for (let i = 0; i < N - lag; i++) {
          corrNum += emphasized[i] * emphasized[i + lag];
          corrDen += emphasized[i + lag] * emphasized[i + lag];
        }
        const normalizedCorr = corrNum / (Math.sqrt(r[0] * corrDen) + 1e-10);

        if (normalizedCorr > bestCorr) {
          bestCorr = normalizedCorr;
          bestPitch = lag;
        }
      }

      // Voicing decision
      if (bestCorr < this.params.voicingThreshold) {
        bestPitch = 0;
        bestCorr = 0;
      }
    }

    result[2] = Math.min(255, bestPitch);
    result[3] = Math.max(0, Math.min(255, Math.floor(bestCorr * 255)));

    // Quantize reflection coefficients using arcsine transform
    const bytesPerCoeff = Math.max(1, Math.min(2, Math.floor(availableBytes / order)));

    for (let i = 0; i < order && (4 + i * bytesPerCoeff) < codecBytes; i++) {
      const k = reflectionCoeffs[i];
      const arcsin = Math.asin(Math.max(-0.999, Math.min(0.999, k)));

      if (bytesPerCoeff === 2) {
        const normalized = (arcsin / (Math.PI / 2) + 1) * 32767.5;
        const quantized = Math.max(0, Math.min(65535, Math.round(normalized)));
        result[4 + i * 2] = quantized & 0xFF;
        result[4 + i * 2 + 1] = (quantized >> 8) & 0xFF;
      } else {
        const normalized = (arcsin / (Math.PI / 2) + 1) * 127.5;
        result[4 + i] = Math.max(0, Math.min(255, Math.round(normalized)));
      }
    }

    return result;
  }

  /**
   * Decode a single frame using current parameters
   * Proper LPC synthesis with correct gain application
   */
  private decodeFrame(bits: Uint8Array): Int16Array {
    const result = new Int16Array(VOICE_FRAME_SAMPLES);
    const codecBytes = bits.length;

    // Decode target signal RMS from log domain
    const rmsQuant = bits[0] | (bits[1] << 8);
    const logRMS = rmsQuant / 65535;
    const targetRMS = Math.exp(logRMS * Math.log(32001)) - 1;

    // Decode pitch and voicing
    let pitch = bits[2];
    if (pitch > 0 && this.params.pitchShift !== 1.0) {
      pitch = Math.round(pitch / this.params.pitchShift);
      pitch = Math.max(8, Math.min(200, pitch));
    }
    const voicingStrength = bits[3];
    const voiced = pitch > 0 && voicingStrength > Math.floor(this.params.voicingThreshold * 255);
    const voicingMix = voicingStrength / 255;

    // Decode reflection coefficients
    const availableBytes = codecBytes - 4;
    const order = Math.min(this.params.lpcOrder, Math.min(24, availableBytes));
    const bytesPerCoeff = Math.max(1, Math.min(2, Math.floor(availableBytes / order)));

    const reflectionCoeffs = new Float32Array(order);
    for (let i = 0; i < order && (4 + i * bytesPerCoeff) < codecBytes; i++) {
      let quantized: number;
      if (bytesPerCoeff === 2) {
        quantized = bits[4 + i * 2] | (bits[4 + i * 2 + 1] << 8);
        const normalized = (quantized / 32767.5) - 1;
        reflectionCoeffs[i] = Math.sin(normalized * (Math.PI / 2));
      } else {
        quantized = bits[4 + i];
        const normalized = (quantized / 127.5) - 1;
        reflectionCoeffs[i] = Math.sin(normalized * (Math.PI / 2));
      }

      // Apply formant shift by scaling reflection coefficients
      if (this.params.formantShift !== 1.0) {
        // Formant shift affects the spectral envelope
        const shiftFactor = Math.pow(this.params.formantShift, i * 0.05);
        reflectionCoeffs[i] *= shiftFactor;
      }

      reflectionCoeffs[i] = Math.max(-0.98, Math.min(0.98, reflectionCoeffs[i]));
    }

    // Convert reflection coefficients to LPC coefficients
    const a = new Float32Array(order + 1);
    a[0] = 1;
    for (let i = 0; i < order; i++) {
      const aNew = new Float32Array(order + 1);
      aNew[0] = 1;
      for (let j = 1; j <= i; j++) {
        aNew[j] = a[j] + reflectionCoeffs[i] * a[i + 1 - j];
      }
      aNew[i + 1] = reflectionCoeffs[i];
      a.set(aNew);
    }

    // Generate excitation signal with improved naturalness
    const excitation = new Float32Array(VOICE_FRAME_SAMPLES);

    if (voiced && pitch > 0) {
      // Add natural pitch jitter (±3% variation) for less robotic sound
      const jitterAmount = 0.03;
      let phase = 0;
      let currentPitch = pitch;

      for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
        const phaseNorm = phase / currentPitch;
        let exc = 0;

        switch (this.params.excitationType) {
          case 'sawtooth':
            exc = 1 - 2 * phaseNorm;
            break;
          case 'pulse':
            // LF model glottal pulse
            if (phaseNorm < 0.4) {
              const t = phaseNorm / 0.4;
              exc = 0.5 * (1 - Math.cos(Math.PI * t));
            } else if (phaseNorm < 0.6) {
              const t = (phaseNorm - 0.4) / 0.2;
              exc = Math.cos(Math.PI * t * 0.5);
            } else {
              const t = (phaseNorm - 0.6) / 0.4;
              exc = -0.2 * (1 - t);
            }
            break;
          case 'sync':
            // Hard sync oscillator - slave sawtooth reset by master
            // Creates richer harmonic content
            {
              const slaveFreq = 2.5; // Slave runs 2.5x faster
              const slavePhase = (phaseNorm * slaveFreq) % 1.0;
              // Blend master and slave for complex waveform
              const master = 1 - 2 * phaseNorm;
              const slave = 1 - 2 * slavePhase;
              exc = master * 0.6 + slave * 0.4;
              // Add glottal-like envelope
              const envelope = phaseNorm < 0.5
                ? Math.sin(phaseNorm * Math.PI / 0.5)
                : Math.max(0, 1 - (phaseNorm - 0.5) * 3);
              exc *= envelope;
            }
            break;
          case 'diff':
            // Differentiated glottal pulse - more natural high frequencies
            // This is what real speech actually uses (derivative of glottal flow)
            {
              if (phaseNorm < 0.35) {
                // Opening: positive flow derivative
                const t = phaseNorm / 0.35;
                exc = Math.sin(t * Math.PI);
              } else if (phaseNorm < 0.45) {
                // Closing: sharp negative spike (the "glottal pulse")
                const t = (phaseNorm - 0.35) / 0.1;
                exc = -2.5 * Math.sin(t * Math.PI);
              } else {
                // Closed: decay to zero
                const t = (phaseNorm - 0.45) / 0.55;
                exc = -0.3 * Math.exp(-t * 4);
              }
            }
            break;
          case 'triangle':
            exc = phaseNorm < 0.5 ? 4 * phaseNorm - 1 : 3 - 4 * phaseNorm;
            break;
          case 'square':
            exc = phaseNorm < 0.5 ? 1 : -1;
            break;
          case 'impulse':
            exc = phaseNorm < 1.0 / pitch ? 2 : 0;
            break;
          case 'noise':
            exc = Math.random() * 2 - 1;
            break;
        }

        // Add shimmer (amplitude variation, ±5%) for naturalness
        const shimmer = 1 + (Math.random() - 0.5) * 0.1;
        exc *= shimmer;

        // Mixed excitation: always add some noise to voiced speech
        // This is critical for natural sound - pure pulses sound robotic
        const noiseComponent = (Math.random() * 2 - 1) * 0.15;
        exc = exc * 0.85 + noiseComponent;

        // Add aspiration noise (breathy component)
        if (this.params.aspirationLevel > 0) {
          const aspirationNoise = (Math.random() * 2 - 1) * this.params.aspirationLevel;
          exc = exc * (1 - this.params.aspirationLevel * 0.5) + aspirationNoise;
        }

        // Blend with unvoiced based on voicing strength
        excitation[i] = exc * voicingMix + (Math.random() * 2 - 1) * (1 - voicingMix);

        phase++;
        if (phase >= currentPitch) {
          phase = 0;
          // Apply jitter for next pitch period
          currentPitch = pitch * (1 + (Math.random() - 0.5) * 2 * jitterAmount);
          currentPitch = Math.max(8, Math.min(200, currentPitch));
        }
      }
    } else {
      // Unvoiced: white noise
      for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
        excitation[i] = Math.random() * 2 - 1;
      }
    }

    // Apply spectral tilt compensation (-6dB/octave boost for more natural sound)
    // Simple first-order highpass to add back high frequencies lost in LPC
    let prevExc = 0;
    for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
      const current = excitation[i];
      excitation[i] = current - 0.4 * prevExc; // Gentle high-frequency boost
      prevExc = current;
    }

    // Normalize excitation to unit RMS for consistent filter input
    let excEnergy = 0;
    for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
      excEnergy += excitation[i] * excitation[i];
    }
    const excRMS = Math.sqrt(excEnergy / VOICE_FRAME_SAMPLES);
    if (excRMS > 0.001) {
      for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
        excitation[i] /= excRMS;
      }
    }

    // LPC synthesis (all-pole filter)
    const state = new Float32Array(order);
    let prevOutput = 0;
    const synthesized = new Float32Array(VOICE_FRAME_SAMPLES);

    for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
      let sample = excitation[i];

      // All-pole filter: y[n] = x[n] - sum(a[k] * y[n-k])
      for (let j = 0; j < order; j++) {
        sample -= a[j + 1] * state[j];
      }

      // Update state (shift register)
      for (let j = order - 1; j > 0; j--) {
        state[j] = state[j - 1];
      }
      state[0] = sample;

      // De-emphasis filter to restore spectral balance
      sample = sample + this.params.deEmphasis * prevOutput;
      prevOutput = sample;

      synthesized[i] = sample;
    }

    // CRITICAL: Scale output to match target RMS from encoder
    let outputEnergy = 0;
    for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
      outputEnergy += synthesized[i] * synthesized[i];
    }
    const outputRMS = Math.sqrt(outputEnergy / VOICE_FRAME_SAMPLES);
    if (outputRMS > 0.001 && targetRMS > 0.001) {
      const outputScale = targetRMS / outputRMS;
      for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
        synthesized[i] *= outputScale;
      }
    }

    // === POST-PROCESSING EFFECTS (for radio/stylized sound) ===

    // Sample rate decimation
    const srdiv = Math.max(1, Math.floor(this.params.sampleRateDiv));
    if (srdiv > 1) {
      for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
        synthesized[i] = synthesized[Math.floor(i / srdiv) * srdiv];
      }
    }

    // Ring modulation
    if (this.params.ringModFreq > 0 && this.params.ringModMix > 0) {
      const ringFreqNorm = (2 * Math.PI * this.params.ringModFreq) / VOICE_SAMPLE_RATE;
      for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
        const ringMod = Math.sin(this.ringModPhase);
        const dry = synthesized[i];
        const wet = dry * ringMod;
        synthesized[i] = dry * (1 - this.params.ringModMix) + wet * this.params.ringModMix;
        this.ringModPhase += ringFreqNorm;
        if (this.ringModPhase > 2 * Math.PI) this.ringModPhase -= 2 * Math.PI;
      }
    }

    // Static noise
    if (this.params.noiseLevel > 0) {
      const noiseAmp = this.params.noiseLevel * 6000;
      for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
        synthesized[i] += (Math.random() * 2 - 1) * noiseAmp;
      }
    }

    // Bit crushing
    const bitDepth = Math.max(1, Math.min(16, Math.floor(this.params.bitCrush)));
    if (bitDepth < 16) {
      const levels = Math.pow(2, bitDepth);
      for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
        const normalized = (synthesized[i] + 32768) / 65536;
        const quantized = Math.floor(normalized * levels) / levels;
        synthesized[i] = quantized * 65536 - 32768;
      }
    }

    // Hard clipping / distortion
    if (this.params.hardClip > 0) {
      const clipThreshold = 32767 * (1 - this.params.hardClip * 0.9);
      for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
        if (synthesized[i] > clipThreshold) {
          synthesized[i] = clipThreshold + (synthesized[i] - clipThreshold) * 0.1;
        } else if (synthesized[i] < -clipThreshold) {
          synthesized[i] = -clipThreshold + (synthesized[i] + clipThreshold) * 0.1;
        }
      }
    }

    // Soft limiting and output conversion
    for (let i = 0; i < VOICE_FRAME_SAMPLES; i++) {
      let sample = synthesized[i];

      // Soft knee limiter
      if (sample > 24000) {
        sample = 24000 + (sample - 24000) * 0.3;
      } else if (sample < -24000) {
        sample = -24000 + (sample + 24000) * 0.3;
      }

      result[i] = Math.max(-32768, Math.min(32767, Math.round(sample)));
    }

    return result;
  }

  /**
   * Apply bandpass filter with current parameters
   */
  private applyBandpassFilter(samples: Int16Array): Float32Array {
    const N = samples.length;
    const output = new Float32Array(N);

    const hpCutoff = this.params.highpassCutoff / (VOICE_SAMPLE_RATE / 2);
    const hpQ = this.params.filterQ;
    const hpW0 = Math.PI * hpCutoff;
    const hpAlpha = Math.sin(hpW0) / (2 * hpQ);
    const hpCosW0 = Math.cos(hpW0);
    const hpA0 = 1 + hpAlpha;
    const hpB0 = ((1 + hpCosW0) / 2) / hpA0;
    const hpB1 = (-(1 + hpCosW0)) / hpA0;
    const hpB2 = ((1 + hpCosW0) / 2) / hpA0;
    const hpA1 = (-2 * hpCosW0) / hpA0;
    const hpA2 = (1 - hpAlpha) / hpA0;

    const lpCutoff = this.params.lowpassCutoff / (VOICE_SAMPLE_RATE / 2);
    const lpQ = 0.707;
    const lpW0 = Math.PI * lpCutoff;
    const lpAlpha = Math.sin(lpW0) / (2 * lpQ);
    const lpCosW0 = Math.cos(lpW0);
    const lpA0 = 1 + lpAlpha;
    const lpB0 = ((1 - lpCosW0) / 2) / lpA0;
    const lpB1 = (1 - lpCosW0) / lpA0;
    const lpB2 = ((1 - lpCosW0) / 2) / lpA0;
    const lpA1 = (-2 * lpCosW0) / lpA0;
    const lpA2 = (1 - lpAlpha) / lpA0;

    let x1 = 0, x2 = 0, y1 = this.hpState1, y2 = this.hpState2;
    const hpFiltered = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x0 = samples[i];
      const y0 = hpB0 * x0 + hpB1 * x1 + hpB2 * x2 - hpA1 * y1 - hpA2 * y2;
      hpFiltered[i] = y0;
      x2 = x1; x1 = x0;
      y2 = y1; y1 = y0;
    }
    this.hpState1 = y1;
    this.hpState2 = y2;

    x1 = 0; x2 = 0; y1 = this.lpState1; y2 = this.lpState2;
    for (let i = 0; i < N; i++) {
      const x0 = hpFiltered[i];
      const y0 = lpB0 * x0 + lpB1 * x1 + lpB2 * x2 - lpA1 * y1 - lpA2 * y2;
      output[i] = y0;
      x2 = x1; x1 = x0;
      y2 = y1; y1 = y0;
    }
    this.lpState1 = y1;
    this.lpState2 = y2;

    return output;
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.cancel();
    destroyMicCapture();

    // Clean up Codec2
    if (this.codec2) {
      this.codec2.destroy();
      this.codec2 = null;
      this.codec2Initialized = false;
    }
  }
}

// Singleton
let debugInstance: VocoderDebug | null = null;

export function getVocoderDebug(params?: Partial<VocoderParams>): VocoderDebug {
  if (!debugInstance) {
    debugInstance = new VocoderDebug(params);
  }
  return debugInstance;
}

export async function initializeVocoderDebug(params?: Partial<VocoderParams>): Promise<VocoderDebug> {
  const debug = getVocoderDebug(params);
  await debug.initialize();
  return debug;
}

export function destroyVocoderDebug(): void {
  if (debugInstance) {
    debugInstance.destroy();
    debugInstance = null;
  }
}
