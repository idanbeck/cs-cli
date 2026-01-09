/**
 * SpatialMixer - 3D audio mixing for voice chat
 *
 * Applies distance attenuation and stereo panning to voice streams.
 * Reuses spatial audio math from SoundEngine.
 */

import { Vector3 } from '../engine/math/Vector3.js';
import { SpatialParams, VOICE_FRAME_SAMPLES, VOICE_SAMPLE_RATE } from './types.js';

// Spatial audio constants (matching SoundEngine)
const DEFAULT_MAX_DISTANCE = 50;  // Beyond this, voice is silent
const REFERENCE_DISTANCE = 5;      // Distance at which voice is at full volume

/**
 * Voice stream state for mixing
 */
interface VoiceStreamState {
  senderId: number;
  position: Vector3;
  lastUpdate: number;
  gain: number;  // 0-1 smoothed gain
}

/**
 * Spatial audio mixer for voice
 */
export class SpatialMixer {
  private listenerPos: Vector3 = new Vector3(0, 0, 0);
  private listenerYaw: number = 0;
  private maxDistance: number = DEFAULT_MAX_DISTANCE;
  private outputVolume: number = 1.0;
  private spatialEnabled: boolean = true;
  private streams: Map<number, VoiceStreamState> = new Map();

  // Output buffer (stereo interleaved at 8kHz)
  private outputBuffer: Int16Array = new Int16Array(VOICE_FRAME_SAMPLES * 2);

  /**
   * Update listener position and orientation
   */
  setListenerPosition(pos: Vector3, yaw: number): void {
    this.listenerPos = pos.clone();
    this.listenerYaw = yaw;
  }

  /**
   * Set maximum voice distance
   */
  setMaxDistance(distance: number): void {
    this.maxDistance = Math.max(1, distance);
  }

  /**
   * Set output volume (0-100)
   */
  setOutputVolume(volume: number): void {
    this.outputVolume = Math.max(0, Math.min(100, volume)) / 100;
  }

  /**
   * Enable/disable spatial audio
   */
  setSpatialEnabled(enabled: boolean): void {
    this.spatialEnabled = enabled;
  }

  /**
   * Update position for a voice stream
   */
  updateStreamPosition(senderId: number, position: Vector3): void {
    let stream = this.streams.get(senderId);
    if (!stream) {
      stream = {
        senderId,
        position: position.clone(),
        lastUpdate: Date.now(),
        gain: 0,
      };
      this.streams.set(senderId, stream);
    } else {
      stream.position = position.clone();
      stream.lastUpdate = Date.now();
    }
  }

  /**
   * Remove a voice stream
   */
  removeStream(senderId: number): void {
    this.streams.delete(senderId);
  }

  /**
   * Calculate spatial parameters for a position
   */
  calculateSpatial(soundPos: Vector3): SpatialParams {
    if (!this.spatialEnabled) {
      return { distance: 0, pan: 0, volume: this.outputVolume };
    }

    const toSound = Vector3.sub(soundPos, this.listenerPos);
    const distance = toSound.length();

    // Volume attenuation based on distance (inverse falloff)
    let volume = 1.0;
    if (distance > REFERENCE_DISTANCE) {
      volume = REFERENCE_DISTANCE / Math.max(distance, 0.1);
      volume = Math.max(0, Math.min(1, volume));
    }
    if (distance > this.maxDistance) {
      volume = 0;
    }

    // Apply master volume
    volume *= this.outputVolume;

    // Calculate pan based on angle relative to listener
    const dirX = toSound.x;
    const dirZ = toSound.z;
    const soundAngle = Math.atan2(-dirX, -dirZ);

    // Relative angle
    let relativeAngle = soundAngle - this.listenerYaw;
    // Normalize to -PI to PI
    while (relativeAngle > Math.PI) relativeAngle -= 2 * Math.PI;
    while (relativeAngle < -Math.PI) relativeAngle += 2 * Math.PI;

    // Pan: -1 = full left, 0 = center, 1 = full right
    const pan = Math.sin(relativeAngle);

    return { distance, pan, volume };
  }

  /**
   * Get spatial parameters for a stream
   * Returns full volume at center if position unknown (for lobby mode)
   */
  getStreamSpatial(senderId: number): SpatialParams {
    const stream = this.streams.get(senderId);
    if (!stream || !this.spatialEnabled) {
      // No position known or spatial disabled - return full volume at center
      return { distance: 0, pan: 0, volume: this.outputVolume };
    }

    return this.calculateSpatial(stream.position);
  }

  /**
   * Apply spatial effect to a mono frame
   *
   * @param samples Mono 16-bit samples (160 samples)
   * @param spatial Spatial parameters
   * @returns Stereo interleaved 16-bit samples (320 samples)
   */
  applySpatial(samples: Int16Array, spatial: SpatialParams): Int16Array {
    const output = new Int16Array(samples.length * 2);

    // Calculate left/right volumes from pan
    // Pan -1 = full left, +1 = full right
    // Use constant-power panning
    const leftVol = spatial.volume * Math.cos((spatial.pan + 1) * Math.PI / 4);
    const rightVol = spatial.volume * Math.sin((spatial.pan + 1) * Math.PI / 4);

    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      output[i * 2] = Math.round(sample * leftVol);
      output[i * 2 + 1] = Math.round(sample * rightVol);
    }

    return output;
  }

  /**
   * Mix multiple stereo streams together
   *
   * @param streams Array of stereo frames to mix
   * @returns Mixed stereo frame
   */
  mixStreams(streams: Int16Array[]): Int16Array {
    const output = new Int16Array(VOICE_FRAME_SAMPLES * 2);

    if (streams.length === 0) {
      return output;
    }

    if (streams.length === 1) {
      output.set(streams[0]);
      return output;
    }

    // Mix with saturation
    for (let i = 0; i < output.length; i++) {
      let sum = 0;
      for (const stream of streams) {
        sum += stream[i];
      }

      // Soft clipping
      if (sum > 32767) sum = 32767;
      else if (sum < -32768) sum = -32768;

      output[i] = sum;
    }

    return output;
  }

  /**
   * Process a voice frame for a sender
   *
   * @param senderId Sender ID
   * @param samples Mono samples from decoder
   * @returns Spatialized stereo samples, or null if too quiet
   */
  processVoice(senderId: number, samples: Int16Array): Int16Array | null {
    const spatial = this.getStreamSpatial(senderId);
    if (spatial.volume < 0.01) {
      return null; // Too quiet (far away)
    }

    return this.applySpatial(samples, spatial);
  }

  /**
   * Cleanup old streams
   */
  cleanup(maxAgeMs: number = 5000): void {
    const now = Date.now();
    for (const [senderId, stream] of this.streams) {
      if (now - stream.lastUpdate > maxAgeMs) {
        this.streams.delete(senderId);
      }
    }
  }

  /**
   * Get active stream count
   */
  get streamCount(): number {
    return this.streams.size;
  }

  /**
   * Clear all streams
   */
  clear(): void {
    this.streams.clear();
  }
}

// Singleton instance
let mixerInstance: SpatialMixer | null = null;

/**
 * Get shared SpatialMixer instance
 */
export function getSpatialMixer(): SpatialMixer {
  if (!mixerInstance) {
    mixerInstance = new SpatialMixer();
  }
  return mixerInstance;
}

/**
 * Destroy shared SpatialMixer
 */
export function destroySpatialMixer(): void {
  if (mixerInstance) {
    mixerInstance.clear();
    mixerInstance = null;
  }
}
