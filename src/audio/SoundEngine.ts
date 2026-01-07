// 8-bit procedural sound engine for CS-CLI
// Generates retro-style sound effects without external samples

import Speaker from 'speaker';
import { Readable, Writable } from 'stream';
import { Vector3 } from '../engine/math/Vector3.js';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// Audio format settings - stereo for spatial audio
const SAMPLE_RATE = 22050;
const BIT_DEPTH = 8;
const CHANNELS = 2; // Stereo for panning

// Spatial audio settings
const MAX_SOUND_DISTANCE = 60; // Beyond this, sound is silent
const REFERENCE_DISTANCE = 5;  // Distance at which sound is at full volume

// Log file for redirected output
const LOG_FILE = path.join(process.cwd(), 'audio_debug.log');
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

// Sound effect types
export type SoundType =
  | 'shoot_pistol'
  | 'shoot_rifle'
  | 'shoot_shotgun'
  | 'shoot_sniper'
  | 'reload'
  | 'empty_clip'
  | 'hit_enemy'
  | 'hit_headshot'
  | 'player_hurt'
  | 'player_death'
  | 'bot_death'
  | 'footstep'
  | 'jump'
  | 'land'
  | 'spawn'
  | 'pickup'
  | 'menu_select'
  | 'round_start'
  | 'round_end';

// Waveform generators
type WaveformFn = (t: number, freq: number) => number;

const waveforms: Record<string, WaveformFn> = {
  square: (t, freq) => Math.sign(Math.sin(2 * Math.PI * freq * t)),
  pulse: (t, freq) => (Math.sin(2 * Math.PI * freq * t) > 0.5 ? 1 : -1),
  triangle: (t, freq) => 2 * Math.abs(2 * (t * freq - Math.floor(t * freq + 0.5))) - 1,
  sawtooth: (t, freq) => 2 * (t * freq - Math.floor(t * freq + 0.5)),
  sine: (t, freq) => Math.sin(2 * Math.PI * freq * t),
  noise: () => Math.random() * 2 - 1,
};

interface Envelope {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

interface SoundDef {
  duration: number;
  envelope: Envelope;
  frequency: number | ((t: number, duration: number) => number);
  waveform: keyof typeof waveforms;
  noiseMix?: number;
  vibrato?: { rate: number; depth: number };
  volume?: number;
}

// Sound definitions
const soundDefs: Record<SoundType, SoundDef | SoundDef[]> = {
  shoot_pistol: {
    duration: 0.1,
    envelope: { attack: 0.001, decay: 0.02, sustain: 0.3, release: 0.07 },
    frequency: (t) => 200 - t * 1500,
    waveform: 'square',
    noiseMix: 0.4,
    volume: 0.8,
  },
  shoot_rifle: {
    duration: 0.08,
    envelope: { attack: 0.001, decay: 0.015, sustain: 0.2, release: 0.05 },
    frequency: (t) => 150 - t * 1000,
    waveform: 'pulse',
    noiseMix: 0.5,
    volume: 0.9,
  },
  shoot_shotgun: {
    duration: 0.15,
    envelope: { attack: 0.001, decay: 0.03, sustain: 0.4, release: 0.1 },
    frequency: (t) => 100 - t * 500,
    waveform: 'square',
    noiseMix: 0.7,
    volume: 1.0,
  },
  shoot_sniper: {
    duration: 0.2,
    envelope: { attack: 0.001, decay: 0.05, sustain: 0.3, release: 0.14 },
    frequency: (t) => 300 - t * 1200,
    waveform: 'sawtooth',
    noiseMix: 0.3,
    volume: 0.9,
  },
  reload: {
    duration: 0.3,
    envelope: { attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.15 },
    frequency: (t) => 400 + Math.sin(t * 20) * 100,
    waveform: 'square',
    noiseMix: 0.2,
    volume: 0.5,
  },
  empty_clip: {
    duration: 0.05,
    envelope: { attack: 0.001, decay: 0.01, sustain: 0.1, release: 0.03 },
    frequency: 800,
    waveform: 'square',
    volume: 0.4,
  },
  hit_enemy: {
    duration: 0.08,
    envelope: { attack: 0.001, decay: 0.02, sustain: 0.3, release: 0.05 },
    frequency: (t) => 600 + t * 400,
    waveform: 'square',
    volume: 0.6,
  },
  hit_headshot: {
    duration: 0.12,
    envelope: { attack: 0.001, decay: 0.03, sustain: 0.4, release: 0.08 },
    frequency: (t) => 800 + t * 600,
    waveform: 'square',
    noiseMix: 0.2,
    volume: 0.8,
  },
  player_hurt: {
    duration: 0.15,
    envelope: { attack: 0.001, decay: 0.05, sustain: 0.4, release: 0.09 },
    frequency: (t) => 300 - t * 200,
    waveform: 'sawtooth',
    noiseMix: 0.3,
    volume: 0.7,
  },
  player_death: {
    duration: 0.5,
    envelope: { attack: 0.01, decay: 0.1, sustain: 0.3, release: 0.35 },
    frequency: (t) => 400 - t * 350,
    waveform: 'sawtooth',
    noiseMix: 0.4,
    volume: 0.8,
  },
  bot_death: {
    duration: 0.3,
    envelope: { attack: 0.01, decay: 0.08, sustain: 0.3, release: 0.2 },
    frequency: (t) => 500 - t * 400,
    waveform: 'square',
    noiseMix: 0.3,
    volume: 0.6,
  },
  footstep: {
    duration: 0.06,
    envelope: { attack: 0.001, decay: 0.02, sustain: 0.2, release: 0.03 },
    frequency: 80 + Math.random() * 40,
    waveform: 'noise',
    volume: 0.2,
  },
  jump: {
    duration: 0.1,
    envelope: { attack: 0.01, decay: 0.03, sustain: 0.3, release: 0.05 },
    frequency: (t) => 200 + t * 300,
    waveform: 'square',
    volume: 0.4,
  },
  land: {
    duration: 0.08,
    envelope: { attack: 0.001, decay: 0.03, sustain: 0.3, release: 0.04 },
    frequency: (t) => 150 - t * 100,
    waveform: 'noise',
    volume: 0.3,
  },
  spawn: {
    duration: 0.25,
    envelope: { attack: 0.02, decay: 0.08, sustain: 0.4, release: 0.14 },
    frequency: (t) => 300 + t * 500,
    waveform: 'triangle',
    volume: 0.5,
  },
  pickup: {
    duration: 0.15,
    envelope: { attack: 0.01, decay: 0.05, sustain: 0.5, release: 0.08 },
    frequency: (t, d) => 400 + (t / d) * 400,
    waveform: 'square',
    volume: 0.5,
  },
  menu_select: {
    duration: 0.08,
    envelope: { attack: 0.005, decay: 0.02, sustain: 0.4, release: 0.05 },
    frequency: 600,
    waveform: 'square',
    volume: 0.4,
  },
  round_start: {
    duration: 0.4,
    envelope: { attack: 0.02, decay: 0.1, sustain: 0.5, release: 0.25 },
    frequency: (t) => 400 + Math.sin(t * 15) * 200,
    waveform: 'square',
    volume: 0.6,
  },
  round_end: {
    duration: 0.5,
    envelope: { attack: 0.02, decay: 0.15, sustain: 0.4, release: 0.3 },
    frequency: (t) => 600 - t * 300,
    waveform: 'triangle',
    volume: 0.6,
  },
};

// Null writable stream to suppress speaker errors
class NullWritable extends Writable {
  _write(_chunk: any, _encoding: string, callback: () => void): void {
    callback();
  }
}

export class SoundEngine {
  private enabled: boolean = true;
  private volume: number = 0.7;
  private activeSpeakers: Set<Speaker> = new Set();
  private listenerPos: Vector3 = new Vector3(0, 0, 0);
  private listenerYaw: number = 0;

  constructor() {
    // Note: Native audio libraries (CoreAudio, ALSA) may print warnings directly to stderr fd.
    // To fully suppress, run with: npx tsx src/index.tsx 2>/dev/null
    // We suppress what we can at the Node.js level.
    this.suppressNodeStderr();
  }

  private suppressNodeStderr(): void {
    // Override process.stderr.write to suppress audio-related messages
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any)._origWrite = origWrite;

    process.stderr.write = ((chunk: any, encoding?: any, callback?: any): boolean => {
      const str = chunk?.toString() || '';
      // Suppress audio-related messages
      if (str.includes('coreaudio') ||
          str.includes('ALSA') ||
          str.includes('audio') ||
          str.includes('buffer') ||
          str.includes('underrun') ||
          str.includes('underflow') ||
          str.includes('callback') ||
          str.includes('warning')) {
        if (typeof encoding === 'function') {
          encoding();
        } else if (typeof callback === 'function') {
          callback();
        }
        return true;
      }
      return origWrite(chunk, encoding, callback);
    }) as any;
  }

  private restoreNodeStderr(): void {
    if ((process.stderr as any)._origWrite) {
      process.stderr.write = (process.stderr as any)._origWrite;
      delete (process.stderr as any)._origWrite;
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // Update listener position and orientation for spatial audio
  setListenerPosition(pos: Vector3, yaw: number): void {
    this.listenerPos = pos.clone();
    this.listenerYaw = yaw;
  }

  // Calculate spatial audio parameters
  private calculateSpatial(soundPos: Vector3): { volume: number; pan: number } {
    const toSound = Vector3.sub(soundPos, this.listenerPos);
    const distance = toSound.length();

    // Volume attenuation based on distance
    let volume = 1.0;
    if (distance > REFERENCE_DISTANCE) {
      volume = REFERENCE_DISTANCE / Math.max(distance, 0.1);
      volume = Math.max(0, Math.min(1, volume));
    }
    if (distance > MAX_SOUND_DISTANCE) {
      volume = 0;
    }

    // Calculate pan based on angle relative to listener
    // Get direction to sound in XZ plane
    const dirX = toSound.x;
    const dirZ = toSound.z;
    const soundAngle = Math.atan2(-dirX, -dirZ);

    // Relative angle (how far left/right the sound is)
    let relativeAngle = soundAngle - this.listenerYaw;
    // Normalize to -PI to PI
    while (relativeAngle > Math.PI) relativeAngle -= 2 * Math.PI;
    while (relativeAngle < -Math.PI) relativeAngle += 2 * Math.PI;

    // Pan: -1 = full left, 0 = center, 1 = full right
    // sin gives us -1 to 1 based on angle
    const pan = Math.sin(relativeAngle);

    return { volume, pan };
  }

  // Generate stereo PCM samples with spatial audio
  private generateStereoSamples(def: SoundDef, spatialVolume: number, pan: number): Buffer {
    const numSamples = Math.floor(def.duration * SAMPLE_RATE);
    const buffer = Buffer.alloc(numSamples * 2); // 2 bytes per sample (L+R)
    const waveformFn = waveforms[def.waveform];
    const noiseFn = waveforms.noise;
    const baseVolume = (def.volume ?? 1) * this.volume * spatialVolume;

    // Calculate left/right volumes from pan
    // Pan -1 = full left, +1 = full right
    const leftVol = baseVolume * Math.cos((pan + 1) * Math.PI / 4);
    const rightVol = baseVolume * Math.sin((pan + 1) * Math.PI / 4);

    for (let i = 0; i < numSamples; i++) {
      const t = i / SAMPLE_RATE;

      let freq: number;
      if (typeof def.frequency === 'function') {
        freq = def.frequency(t, def.duration);
      } else {
        freq = def.frequency;
      }

      if (def.vibrato) {
        freq += Math.sin(2 * Math.PI * def.vibrato.rate * t) * def.vibrato.depth;
      }

      let sample = waveformFn(t, Math.max(20, freq));

      if (def.noiseMix && def.noiseMix > 0) {
        sample = sample * (1 - def.noiseMix) + noiseFn(t, freq) * def.noiseMix;
      }

      const env = this.getEnvelopeValue(t, def.duration, def.envelope);
      sample *= env;

      // Convert to 8-bit unsigned for left and right channels
      const leftSample = Math.floor((sample * leftVol + 1) * 0.5 * 255);
      const rightSample = Math.floor((sample * rightVol + 1) * 0.5 * 255);

      buffer[i * 2] = Math.max(0, Math.min(255, leftSample));
      buffer[i * 2 + 1] = Math.max(0, Math.min(255, rightSample));
    }

    return buffer;
  }

  private getEnvelopeValue(t: number, duration: number, env: Envelope): number {
    const { attack, decay, sustain, release } = env;
    const releaseStart = duration - release;

    if (t < attack) {
      return t / attack;
    } else if (t < attack + decay) {
      const decayProgress = (t - attack) / decay;
      return 1 - decayProgress * (1 - sustain);
    } else if (t < releaseStart) {
      return sustain;
    } else {
      const releaseProgress = (t - releaseStart) / release;
      return sustain * (1 - releaseProgress);
    }
  }

  // Play a sound at the listener position (no spatial effect)
  play(sound: SoundType): void {
    this.playAt(sound, this.listenerPos);
  }

  // Play a sound at a 3D position with spatial audio
  playAt(sound: SoundType, position: Vector3): void {
    if (!this.enabled) return;

    try {
      const def = soundDefs[sound];
      if (!def) return;

      const { volume, pan } = this.calculateSpatial(position);

      // Don't play if too quiet
      if (volume < 0.01) return;

      const defs = Array.isArray(def) ? def : [def];
      for (const d of defs) {
        this.playDefSpatial(d, volume, pan);
      }
    } catch {
      // Silently ignore
    }
  }

  private playDefSpatial(def: SoundDef, spatialVolume: number, pan: number): void {
    try {
      const samples = this.generateStereoSamples(def, spatialVolume, pan);

      const speaker = new Speaker({
        channels: CHANNELS,
        bitDepth: BIT_DEPTH,
        sampleRate: SAMPLE_RATE,
        signed: false,
      });

      this.activeSpeakers.add(speaker);

      speaker.on('close', () => {
        this.activeSpeakers.delete(speaker);
      });

      speaker.on('error', () => {
        this.activeSpeakers.delete(speaker);
      });

      const readable = new Readable({
        read() {
          this.push(samples);
          this.push(null);
        }
      });

      readable.pipe(speaker);
    } catch {
      // Silently ignore
    }
  }

  stopAll(): void {
    for (const speaker of this.activeSpeakers) {
      try {
        speaker.end();
      } catch {}
    }
    this.activeSpeakers.clear();
  }

  destroy(): void {
    this.stopAll();
    this.restoreNodeStderr();
  }
}

// Singleton instance
let soundEngineInstance: SoundEngine | null = null;

export function getSoundEngine(): SoundEngine {
  if (!soundEngineInstance) {
    soundEngineInstance = new SoundEngine();
  }
  return soundEngineInstance;
}

export function playSound(sound: SoundType): void {
  getSoundEngine().play(sound);
}

export function playSoundAt(sound: SoundType, position: Vector3): void {
  getSoundEngine().playAt(sound, position);
}
