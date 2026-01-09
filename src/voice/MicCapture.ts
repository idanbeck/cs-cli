/**
 * MicCapture - Microphone input capture using naudiodon (portaudio bindings)
 *
 * Captures audio at 8kHz mono for Codec2 encoding.
 * Provides 160-sample frames (20ms) for voice processing.
 */

import {
  AudioDevice,
  VOICE_SAMPLE_RATE,
  VOICE_FRAME_SAMPLES,
} from './types.js';

// naudiodon types (the package doesn't have built-in types)
interface AudioIOOptions {
  channelCount: number;
  sampleFormat: number;
  sampleRate: number;
  deviceId?: number;
  highwaterMark?: number;
}

interface AudioIO {
  on(event: 'data', callback: (data: Buffer) => void): void;
  on(event: 'error', callback: (error: Error) => void): void;
  on(event: 'close', callback: () => void): void;
  start(): void;
  quit(callback?: () => void): void;
}

interface PortAudioDevice {
  id: number;
  name: string;
  maxInputChannels: number;
  maxOutputChannels: number;
  defaultSampleRate: number;
  defaultLowInputLatency: number;
  defaultLowOutputLatency: number;
  defaultHighInputLatency: number;
  defaultHighOutputLatency: number;
  hostAPIName: string;
}

interface PortAudio {
  getDevices(): PortAudioDevice[];
  getDefaultInputDevice(): PortAudioDevice | null;
  AudioIO: new (options: { inOptions: AudioIOOptions }) => AudioIO;
  SampleFormat16Bit: number;
}

type FrameCallback = (samples: Int16Array) => void;

// Audio processing constants
const NOISE_GATE_THRESHOLD = 150;    // RMS threshold for noise gate
const NOISE_GATE_ATTACK_MS = 5;      // Attack time in ms
const NOISE_GATE_RELEASE_MS = 100;   // Release time in ms
const COMPRESSOR_THRESHOLD = 8000;   // Compression threshold
const COMPRESSOR_RATIO = 4;          // Compression ratio (4:1)
const LIMITER_THRESHOLD = 28000;     // Hard limiter threshold
const TARGET_RMS = 6000;             // Target RMS for normalization

/**
 * Microphone capture handler
 */
export class MicCapture {
  private portaudio: PortAudio | null = null;
  private audioIO: AudioIO | null = null;
  private isCapturing = false;
  private frameBuffer: Int16Array;
  private frameOffset = 0;
  private onFrame: FrameCallback | null = null;
  private deviceId: number = -1;  // -1 = default

  // Audio processing state
  private gateOpen = false;
  private gateGain = 0;           // Current gate gain (0-1)
  private avgRMS = 0;             // Smoothed RMS for AGC
  private dcOffset = 0;           // DC offset removal

  constructor() {
    this.frameBuffer = new Int16Array(VOICE_FRAME_SAMPLES);
  }

  /**
   * Initialize the capture system
   */
  async initialize(): Promise<void> {
    try {
      // Dynamic import since naudiodon2 might not be installed
      // Using naudiodon2 instead of naudiodon for Node.js 22+ compatibility
      const naudiodon = await import('naudiodon2');
      this.portaudio = naudiodon.default || naudiodon;
    } catch (error) {
      // naudiodon2 not available - mic capture won't work
      this.portaudio = null;
    }
  }

  /**
   * Get list of available input devices
   */
  getInputDevices(): AudioDevice[] {
    if (!this.portaudio) return [];

    try {
      const devices = this.portaudio.getDevices();
      return devices
        .filter((d: PortAudioDevice) => d.maxInputChannels > 0)
        .map((d: PortAudioDevice) => ({
          id: String(d.id),
          name: d.name,
          isDefault: d.id === this.getDefaultInputDeviceId(),
          isInput: true,
        }));
    } catch (error) {
      console.error('[MicCapture] Failed to enumerate input devices:', error);
      return [];
    }
  }

  /**
   * Get list of available output devices
   */
  getOutputDevices(): AudioDevice[] {
    if (!this.portaudio) return [];

    try {
      const devices = this.portaudio.getDevices();
      return devices
        .filter((d: PortAudioDevice) => d.maxOutputChannels > 0)
        .map((d: PortAudioDevice) => ({
          id: String(d.id),
          name: d.name,
          isDefault: d.id === this.getDefaultOutputDeviceId(),
          isInput: false,
        }));
    } catch (error) {
      console.error('[MicCapture] Failed to enumerate output devices:', error);
      return [];
    }
  }

  /**
   * Get default output device ID
   */
  private getDefaultOutputDeviceId(): number {
    if (!this.portaudio) return -1;

    try {
      // portaudio doesn't have getDefaultOutputDevice, so find first device with output channels
      const devices = this.portaudio.getDevices();
      const outputDevice = devices.find((d: PortAudioDevice) => d.maxOutputChannels > 0);
      return outputDevice?.id ?? -1;
    } catch {
      return -1;
    }
  }

  /**
   * Get default input device ID
   */
  private getDefaultInputDeviceId(): number {
    if (!this.portaudio) return -1;

    try {
      const device = this.portaudio.getDefaultInputDevice();
      return device?.id ?? -1;
    } catch {
      return -1;
    }
  }

  /**
   * Set input device by ID string
   */
  setInputDevice(deviceIdStr: string): void {
    if (deviceIdStr === 'default') {
      this.deviceId = -1;
    } else {
      this.deviceId = parseInt(deviceIdStr, 10);
      if (isNaN(this.deviceId)) this.deviceId = -1;
    }
  }

  /**
   * Start capturing audio
   *
   * @param onFrame Callback invoked with each 160-sample frame
   */
  start(onFrame: FrameCallback): void {
    if (this.isCapturing || !this.portaudio) {
      return;
    }

    this.onFrame = onFrame;
    this.frameOffset = 0;

    try {
      const inputOptions: AudioIOOptions = {
        channelCount: 1,
        sampleFormat: this.portaudio.SampleFormat16Bit,
        sampleRate: VOICE_SAMPLE_RATE,
        highwaterMark: 320,  // ~2 frames buffer
      };

      if (this.deviceId >= 0) {
        inputOptions.deviceId = this.deviceId;
      }

      this.audioIO = new this.portaudio.AudioIO({
        inOptions: inputOptions,
      });

      this.audioIO.on('data', (data: Buffer) => {
        this.processAudioData(data);
      });

      this.audioIO.on('error', (_error: Error) => {
        // Audio error - ignore silently
      });

      this.audioIO.on('close', () => {
        // Stream closed
      });

      this.audioIO.start();
      this.isCapturing = true;
    } catch (error) {
      this.isCapturing = false;
    }
  }

  /**
   * Process incoming audio data
   */
  private processAudioData(data: Buffer): void {
    // Convert Buffer to Int16Array
    const samples = new Int16Array(data.buffer, data.byteOffset, data.length / 2);

    for (let i = 0; i < samples.length; i++) {
      this.frameBuffer[this.frameOffset++] = samples[i];

      // Emit frame when full
      if (this.frameOffset >= VOICE_FRAME_SAMPLES) {
        if (this.onFrame) {
          // Apply audio processing chain
          const processedFrame = this.processFrame(this.frameBuffer);
          this.onFrame(processedFrame);
        }
        this.frameOffset = 0;
      }
    }
  }

  /**
   * Apply audio processing chain to a frame:
   * 1. DC offset removal
   * 2. Noise gate
   * 3. Normalization/AGC
   * 4. Compression
   * 5. Limiter
   */
  private processFrame(input: Int16Array): Int16Array {
    const output = new Int16Array(input.length);
    const frameMs = (input.length / VOICE_SAMPLE_RATE) * 1000;

    // 1. Calculate frame statistics and remove DC offset
    let sum = 0;
    let sumSquares = 0;
    for (let i = 0; i < input.length; i++) {
      sum += input[i];
      sumSquares += input[i] * input[i];
    }
    const frameDC = sum / input.length;
    // Smooth DC offset update
    this.dcOffset = this.dcOffset * 0.95 + frameDC * 0.05;

    // Calculate RMS after DC removal
    let rmsSum = 0;
    for (let i = 0; i < input.length; i++) {
      const sample = input[i] - this.dcOffset;
      rmsSum += sample * sample;
    }
    const frameRMS = Math.sqrt(rmsSum / input.length);

    // 2. Noise gate with smooth attack/release
    const gateAttackRate = frameMs / NOISE_GATE_ATTACK_MS;
    const gateReleaseRate = frameMs / NOISE_GATE_RELEASE_MS;

    if (frameRMS > NOISE_GATE_THRESHOLD) {
      // Open gate
      this.gateOpen = true;
      this.gateGain = Math.min(1, this.gateGain + gateAttackRate);
    } else {
      // Close gate
      this.gateOpen = false;
      this.gateGain = Math.max(0, this.gateGain - gateReleaseRate);
    }

    // If gate is fully closed, output silence
    if (this.gateGain < 0.01) {
      return output; // All zeros
    }

    // 3. AGC/Normalization - calculate gain to reach target RMS
    // Smooth RMS tracking
    this.avgRMS = this.avgRMS * 0.9 + frameRMS * 0.1;
    let normGain = 1.0;
    if (this.avgRMS > 100) {
      normGain = TARGET_RMS / this.avgRMS;
      // Limit gain range
      normGain = Math.max(0.5, Math.min(8.0, normGain));
    }

    // 4 & 5. Apply processing to each sample
    for (let i = 0; i < input.length; i++) {
      // Remove DC offset
      let sample = input[i] - this.dcOffset;

      // Apply gate gain
      sample *= this.gateGain;

      // Apply normalization gain
      sample *= normGain;

      // Compression (soft knee)
      const absSample = Math.abs(sample);
      if (absSample > COMPRESSOR_THRESHOLD) {
        const excess = absSample - COMPRESSOR_THRESHOLD;
        const compressed = COMPRESSOR_THRESHOLD + (excess / COMPRESSOR_RATIO);
        sample = sample > 0 ? compressed : -compressed;
      }

      // Hard limiter
      if (sample > LIMITER_THRESHOLD) {
        sample = LIMITER_THRESHOLD;
      } else if (sample < -LIMITER_THRESHOLD) {
        sample = -LIMITER_THRESHOLD;
      }

      output[i] = Math.round(sample);
    }

    return output;
  }

  /**
   * Stop capturing audio
   */
  stop(): void {
    if (!this.isCapturing || !this.audioIO) return;

    try {
      this.audioIO.quit();
    } catch (error) {
      // Ignore stop errors
    }

    this.audioIO = null;
    this.isCapturing = false;
    this.onFrame = null;
    this.frameOffset = 0;
  }

  /**
   * Check if capturing
   */
  get capturing(): boolean {
    return this.isCapturing;
  }

  /**
   * Check if available
   */
  get isAvailable(): boolean {
    return this.portaudio !== null;
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.stop();
    this.portaudio = null;
  }
}

// Singleton instance
let micInstance: MicCapture | null = null;

/**
 * Get shared MicCapture instance
 */
export function getMicCapture(): MicCapture {
  if (!micInstance) {
    micInstance = new MicCapture();
  }
  return micInstance;
}

/**
 * Initialize shared MicCapture
 */
export async function initializeMicCapture(): Promise<MicCapture> {
  const mic = getMicCapture();
  await mic.initialize();
  return mic;
}

/**
 * Destroy shared MicCapture
 */
export function destroyMicCapture(): void {
  if (micInstance) {
    micInstance.destroy();
    micInstance = null;
  }
}
