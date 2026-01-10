/**
 * VoiceManager - Voice chat orchestrator
 *
 * Coordinates all voice chat components:
 * - Microphone capture
 * - VAD processing
 * - Codec2 encoding/decoding
 * - Network transmission
 * - Spatial mixing
 * - Audio playback
 */

import { Vector3 } from '../engine/math/Vector3.js';
import {
  VoiceSettings,
  DEFAULT_VOICE_SETTINGS,
  VoiceEventCallback,
  VoiceEvent,
  VOICE_FRAME_MS,
  truncatePlayerId,
} from './types.js';
import { Codec2, initializeCodec2, destroyCodec2 } from './Codec2.js';
import { MicCapture, initializeMicCapture, destroyMicCapture } from './MicCapture.js';
import { VADProcessor } from './VADProcessor.js';
import { VoiceClient, getVoiceClient, destroyVoiceClient } from './VoiceClient.js';
import { SpatialMixer, getSpatialMixer, destroySpatialMixer } from './SpatialMixer.js';
import { VoicePlayback, getVoicePlayback, destroyVoicePlayback } from './VoicePlayback.js';
import { VoicePostProcessor, getVoicePostProcessor, destroyVoicePostProcessor } from './VoicePostProcessor.js';
import { voiceLog } from './voiceLog.js';

// Playback tick interval (process received audio)
const PLAYBACK_TICK_MS = 20;  // Match codec frame rate

/**
 * Voice manager state
 */
type VoiceState = 'stopped' | 'initializing' | 'running' | 'error';

/**
 * Speaking player info
 */
interface SpeakingPlayer {
  playerId: string;
  senderId: number;
  lastActivity: number;
}

/**
 * Main voice chat manager
 */
export class VoiceManager {
  private settings: VoiceSettings;
  private state: VoiceState = 'stopped';
  private errorMessage: string = '';

  // Components
  private codec: Codec2 | null = null;
  private mic: MicCapture | null = null;
  private vad: VADProcessor;
  private client: VoiceClient;
  private mixer: SpatialMixer;
  private playback: VoicePlayback;
  private postProcessor: VoicePostProcessor;

  // State
  private localPlayerId: string = '';
  private localPosition: Vector3 = new Vector3(0, 0, 0);
  private localYaw: number = 0;
  private isPTTActive: boolean = false;
  private speakingPlayers: Map<number, SpeakingPlayer> = new Map();

  // Mic level tracking (0-1 normalized)
  private currentMicLevel: number = 0;
  private isTransmitting: boolean = false;

  // Playback loop
  private playbackInterval: ReturnType<typeof setInterval> | null = null;

  // Events
  private eventCallbacks: Set<VoiceEventCallback> = new Set();

  constructor(settings: Partial<VoiceSettings> = {}) {
    this.settings = { ...DEFAULT_VOICE_SETTINGS, ...settings };
    this.vad = new VADProcessor({ sensitivity: this.settings.voiceVADSensitivity });
    this.client = getVoiceClient();
    this.mixer = getSpatialMixer();
    this.playback = getVoicePlayback();
    this.postProcessor = getVoicePostProcessor();  // CSterm radio effects
  }

  /**
   * Initialize voice chat system
   */
  async initialize(): Promise<void> {
    if (this.state === 'running' || this.state === 'initializing') return;

    this.state = 'initializing';

    try {
      // Initialize codec
      this.codec = await initializeCodec2();

      // Initialize microphone
      this.mic = await initializeMicCapture();
      if (this.settings.voiceInputDevice !== 'default') {
        this.mic.setInputDevice(this.settings.voiceInputDevice);
      }

      // Configure mixer
      this.mixer.setMaxDistance(this.settings.voiceMaxDistance);
      this.mixer.setOutputVolume(this.settings.voiceOutputVolume);
      this.mixer.setSpatialEnabled(this.settings.voiceSpatialEnabled);

      this.state = 'running';
      this.emitEvent({ type: 'connected' });
    } catch (error) {
      this.state = 'error';
      this.errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.emitEvent({ type: 'error', error: error instanceof Error ? error : new Error(String(error)) });
    }
  }

  /**
   * Start voice chat
   */
  start(): void {
    if (this.state !== 'running' || !this.settings.voiceEnabled) {
      return;
    }

    // Start microphone capture
    if (this.mic && this.mic.isAvailable) {
      this.mic.start((samples) => this.onMicFrame(samples));
    }

    // Start playback loop
    this.playbackInterval = setInterval(() => this.processPlayback(), PLAYBACK_TICK_MS);
  }

  /**
   * Stop voice chat
   */
  stop(): void {
    // Stop microphone
    if (this.mic) {
      this.mic.stop();
    }

    // Stop playback loop
    if (this.playbackInterval) {
      clearInterval(this.playbackInterval);
      this.playbackInterval = null;
    }

    // Stop playback
    this.playback.stop();
  }

  /**
   * Handle microphone frame
   */
  private onMicFrame(samples: Int16Array): void {
    try {
      // Calculate RMS level for meter (before volume adjustment)
      let sumSquares = 0;
      for (let i = 0; i < samples.length; i++) {
        sumSquares += samples[i] * samples[i];
      }
      const rms = Math.sqrt(sumSquares / samples.length);
      // Normalize to 0-1 (32767 is max for 16-bit audio)
      this.currentMicLevel = Math.min(1, rms / 16384);  // Use 16384 for headroom

      if (!this.settings.voiceEnabled || !this.codec) {
        this.isTransmitting = false;
        return;
      }
      // Apply input volume
      if (this.settings.voiceInputVolume < 100) {
        const scale = this.settings.voiceInputVolume / 100;
        for (let i = 0; i < samples.length; i++) {
          samples[i] = Math.round(samples[i] * scale);
        }
      }

      // Check PTT or VAD
      let shouldTransmit = false;
      if (this.settings.voicePTTEnabled) {
        shouldTransmit = this.isPTTActive;
      } else {
        shouldTransmit = this.vad.process(samples);
      }

      this.isTransmitting = shouldTransmit;

      // Send if active
      if (shouldTransmit) {
        this.client.sendVoice(samples, true);
      }
    } catch (error) {
      // Swallow errors to prevent mic callback crashes
      this.isTransmitting = false;
    }
  }

  // Debug counter for logging
  private debugCounter = 0;

  /**
   * Process received audio for playback
   */
  private processPlayback(): void {
    try {
      const now = Date.now();
      const activeSenders = this.client.getActiveSenders();
      const stereoStreams: Int16Array[] = [];

      // Debug: Log active senders periodically
      this.debugCounter++;
      const shouldLog = this.debugCounter % 50 === 1;

      if (shouldLog && activeSenders.length > 0) {
        voiceLog(`[VoiceManager] Active senders: ${activeSenders.length}`);
      }

      for (const senderId of activeSenders) {
        // Get next frame from jitter buffer
        const samples = this.client.getNextFrame(senderId);
        if (!samples) {
          if (shouldLog) {
            voiceLog(`[VoiceManager] No frame from jitter buffer for sender ${senderId.toString(16)}`);
          }
          continue;
        }

        if (shouldLog) {
          let maxAmp = 0;
          for (let i = 0; i < samples.length; i++) maxAmp = Math.max(maxAmp, Math.abs(samples[i]));
          voiceLog(`[VoiceManager] Got frame: ${samples.length} samples, max amp: ${maxAmp}`);
        }

        // TEMPORARILY BYPASS post-processing to debug codec
        // const processed = this.postProcessor.process(samples);
        const processed = samples; // Direct passthrough for debugging

        if (shouldLog) {
          let maxAmp = 0;
          for (let i = 0; i < processed.length; i++) maxAmp = Math.max(maxAmp, Math.abs(processed[i]));
          voiceLog(`[VoiceManager] After postprocess: ${processed.length} samples, max amp: ${maxAmp}`);
        }

        // Apply spatial processing
        const stereo = this.mixer.processVoice(senderId, processed);
        if (stereo) {
          stereoStreams.push(stereo);
          if (shouldLog) {
            voiceLog(`[VoiceManager] Spatial OK: ${stereo.length} stereo samples`);
          }
        } else {
          if (shouldLog) {
            voiceLog(`[VoiceManager] Spatial returned null for sender ${senderId.toString(16)}`);
          }
        }

        // Track speaking player
        let speaker = this.speakingPlayers.get(senderId);
        if (!speaker) {
          speaker = {
            playerId: '',  // Will be resolved from network state
            senderId,
            lastActivity: now,
          };
          this.speakingPlayers.set(senderId, speaker);
          this.emitEvent({ type: 'speaking-start', playerId: speaker.playerId });
        }
        speaker.lastActivity = now;
      }

      // Mix and play
      if (stereoStreams.length > 0) {
        voiceLog(`[VoiceManager] About to mix ${stereoStreams.length} streams, sizes: ${stereoStreams.map(s => s.length).join(',')}`);
        const mixed = this.mixer.mixStreams(stereoStreams);
        voiceLog(`[VoiceManager] Mixed result: ${mixed.length} samples`);
        if (shouldLog) {
          let maxAmp = 0;
          for (let i = 0; i < mixed.length; i++) maxAmp = Math.max(maxAmp, Math.abs(mixed[i]));
          voiceLog(`[VoiceManager] Mixing ${stereoStreams.length} streams, output max amp: ${maxAmp}`);
        }
        voiceLog(`[VoiceManager] Calling playback.queueFrame`);
        this.playback.queueFrame(mixed);
        voiceLog(`[VoiceManager] queueFrame returned`);
      }

      // Cleanup inactive speakers
      for (const [senderId, speaker] of this.speakingPlayers) {
        if (now - speaker.lastActivity > 300) {  // 300ms timeout
          this.speakingPlayers.delete(senderId);
          this.emitEvent({ type: 'speaking-stop', playerId: speaker.playerId });
        }
      }
    } catch (error) {
      // Log errors instead of silently swallowing
      voiceLog(`[VoiceManager] processPlayback ERROR: ${error}`);
    }
  }

  /**
   * Handle binary data from network
   * Returns true if it was a voice frame
   */
  handleBinaryData(data: Uint8Array): boolean {
    return this.client.handleBinaryData(data);
  }

  /**
   * Set binary send callback
   */
  setSendCallback(callback: (data: Uint8Array) => void): void {
    this.client.setSendCallback(callback);
  }

  /**
   * Set local player ID
   */
  setLocalPlayer(playerId: string): void {
    this.localPlayerId = playerId;
    this.client.setPlayerId(playerId);
  }

  /**
   * Update local listener position and orientation
   */
  updateLocalPosition(position: Vector3, yaw: number): void {
    this.localPosition = position.clone();
    this.localYaw = yaw;
    this.mixer.setListenerPosition(position, yaw);
  }

  /**
   * Update remote player position (for spatial audio)
   */
  updatePlayerPosition(playerId: string, position: Vector3): void {
    const senderId = truncatePlayerId(playerId);
    this.mixer.updateStreamPosition(senderId, position);

    // Update speaking player mapping
    const speaker = this.speakingPlayers.get(senderId);
    if (speaker) {
      speaker.playerId = playerId;
    }
  }

  /**
   * Remove player
   */
  removePlayer(playerId: string): void {
    const senderId = truncatePlayerId(playerId);
    this.mixer.removeStream(senderId);
    this.client.resetSender(senderId);
    this.speakingPlayers.delete(senderId);
  }

  /**
   * Set PTT state
   */
  setPTTActive(active: boolean): void {
    this.isPTTActive = active;
  }

  /**
   * Set team-only mode
   */
  setTeamOnly(teamOnly: boolean): void {
    this.client.setTeamOnly(teamOnly);
  }

  /**
   * Update settings
   */
  updateSettings(settings: Partial<VoiceSettings>): void {
    Object.assign(this.settings, settings);

    // Apply changes
    if ('voiceVADSensitivity' in settings) {
      this.vad.setSensitivity(this.settings.voiceVADSensitivity);
    }
    if ('voiceMaxDistance' in settings) {
      this.mixer.setMaxDistance(this.settings.voiceMaxDistance);
    }
    if ('voiceOutputVolume' in settings) {
      this.mixer.setOutputVolume(this.settings.voiceOutputVolume);
    }
    if ('voiceSpatialEnabled' in settings) {
      this.mixer.setSpatialEnabled(this.settings.voiceSpatialEnabled);
    }
    if ('voiceInputDevice' in settings && this.mic) {
      this.mic.setInputDevice(this.settings.voiceInputDevice);
    }
  }

  /**
   * Get current settings
   */
  getSettings(): VoiceSettings {
    return { ...this.settings };
  }

  /**
   * Get available input devices
   */
  getInputDevices(): { id: string; name: string }[] {
    if (!this.mic) return [];
    return this.mic.getInputDevices().map(d => ({ id: d.id, name: d.name }));
  }

  /**
   * Get available output devices
   */
  getOutputDevices(): { id: string; name: string }[] {
    if (!this.mic) return [];
    return this.mic.getOutputDevices().map(d => ({ id: d.id, name: d.name }));
  }

  /**
   * Get current microphone input level (0-1)
   */
  getMicLevel(): number {
    return this.currentMicLevel;
  }

  /**
   * Check if currently transmitting
   */
  getIsTransmitting(): boolean {
    return this.isTransmitting;
  }

  /**
   * Check if mic is available and capturing
   */
  isMicActive(): boolean {
    return this.mic?.capturing ?? false;
  }

  /**
   * Get speaking players
   */
  getSpeakingPlayers(): string[] {
    return Array.from(this.speakingPlayers.values())
      .map(s => s.playerId || `Player ${s.senderId.toString(16).slice(-4)}`);
  }

  /**
   * Check if a player is speaking
   */
  isPlayerSpeaking(playerId: string): boolean {
    const senderId = truncatePlayerId(playerId);
    return this.speakingPlayers.has(senderId);
  }

  /**
   * Get current state
   */
  getState(): VoiceState {
    return this.state;
  }

  /**
   * Get error message
   */
  getError(): string {
    return this.errorMessage;
  }

  /**
   * Register event callback
   */
  onEvent(callback: VoiceEventCallback): () => void {
    this.eventCallbacks.add(callback);
    return () => this.eventCallbacks.delete(callback);
  }

  /**
   * Emit event
   */
  private emitEvent(event: VoiceEvent): void {
    for (const callback of this.eventCallbacks) {
      try {
        callback(event);
      } catch (error) {
        console.error('[VoiceManager] Event callback error:', error);
      }
    }
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.stop();

    destroyCodec2();
    destroyMicCapture();
    destroyVoiceClient();
    destroySpatialMixer();
    destroyVoicePlayback();
    destroyVoicePostProcessor();

    this.codec = null;
    this.mic = null;
    this.state = 'stopped';
    this.eventCallbacks.clear();
  }
}

// Singleton instance
let managerInstance: VoiceManager | null = null;

/**
 * Get shared VoiceManager instance
 */
export function getVoiceManager(settings?: Partial<VoiceSettings>): VoiceManager {
  if (!managerInstance) {
    managerInstance = new VoiceManager(settings);
  }
  return managerInstance;
}

/**
 * Initialize shared VoiceManager
 */
export async function initializeVoiceManager(settings?: Partial<VoiceSettings>): Promise<VoiceManager> {
  const manager = getVoiceManager(settings);
  await manager.initialize();
  return manager;
}

/**
 * Destroy shared VoiceManager
 */
export function destroyVoiceManager(): void {
  if (managerInstance) {
    managerInstance.destroy();
    managerInstance = null;
  }
}
