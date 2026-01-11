/**
 * Voice Chat Type Definitions
 *
 * Types for the spatial vocoder voice chat system.
 */

// Binary protocol constants
export const VOICE_FRAME_TYPE = 0x01;
export const VOICE_HEADER_SIZE = 12;  // Header size (frameType + flags + senderId + seq + timestamp)
// Payload size varies: 6 bytes for native Codec2 2400, 16 bytes for LPC fallback
export const VOICE_SAMPLE_RATE = 8000;
export const VOICE_FRAME_SAMPLES = 160; // 20ms at 8kHz
export const VOICE_FRAME_MS = 20;

// Voice frame flags
export const VOICE_FLAG_VAD = 0x01;      // Bit 0: Voice activity detected
export const VOICE_FLAG_TEAM_ONLY = 0x02; // Bit 1: Team-only broadcast

/**
 * Binary voice frame structure (28 bytes)
 * Offset  Size  Field
 * 0       1     frameType (0x01)
 * 1       1     flags (bit0: VAD, bit1: teamOnly)
 * 2       4     senderId (truncated player ID)
 * 6       4     sequence number
 * 10      2     timestamp offset (ms)
 * 12      16    Enhanced LPC payload
 *
 * Payload structure (16 bytes):
 * - Bytes 0-1: Energy (16-bit)
 * - Byte 2: Pitch period
 * - Byte 3: Voicing strength
 * - Bytes 4-15: 12 LPC reflection coefficients (8-bit each)
 */
export interface VoiceFrame {
  frameType: number;
  flags: number;
  senderId: number;
  sequence: number;
  timestampOffset: number;
  payload: Uint8Array;
}

/**
 * Decoded voice frame with sender info
 */
export interface DecodedVoiceFrame {
  senderId: number;
  sequence: number;
  timestamp: number;
  samples: Int16Array;  // 160 samples at 8kHz (20ms)
  vadActive: boolean;
  teamOnly: boolean;
}

/**
 * Voice stream state for a single player
 */
export interface VoiceStream {
  playerId: string;
  senderIdTrunc: number;  // Truncated ID for protocol
  position: { x: number; y: number; z: number };
  lastSequence: number;
  lastActivity: number;
  isSpeaking: boolean;
  team: number;
}

/**
 * Jitter buffer entry
 */
export interface JitterBufferEntry {
  sequence: number;
  timestamp: number;
  samples: Int16Array;
  received: number;
}

/**
 * Voice settings (persisted to settings.json)
 */
export interface VoiceSettings {
  voiceEnabled: boolean;
  voiceInputVolume: number;    // 0-100
  voiceOutputVolume: number;   // 0-100
  voicePTTEnabled: boolean;
  voicePTTKey: string;
  voiceVADSensitivity: number; // 1-10
  voiceInputDevice: string;
  voiceMaxDistance: number;    // In game units
  voiceSpatialEnabled: boolean;
}

/**
 * Default voice settings
 */
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  voiceEnabled: true,
  voiceInputVolume: 100,
  voiceOutputVolume: 100,
  voicePTTEnabled: false,
  voicePTTKey: 'v',
  voiceVADSensitivity: 5,
  voiceInputDevice: 'default',
  voiceMaxDistance: 50,
  voiceSpatialEnabled: true,
};

/**
 * Audio device info
 */
export interface AudioDevice {
  id: string;
  name: string;
  isDefault: boolean;
  isInput: boolean;
}

/**
 * Spatial audio parameters for a voice source
 */
export interface SpatialParams {
  distance: number;
  pan: number;      // -1 (left) to 1 (right)
  volume: number;   // 0 to 1 (distance attenuated)
}

/**
 * Voice client events
 */
export type VoiceEventType =
  | 'speaking-start'
  | 'speaking-stop'
  | 'connected'
  | 'disconnected'
  | 'error';

export interface VoiceEvent {
  type: VoiceEventType;
  playerId?: string;
  error?: Error;
}

export type VoiceEventCallback = (event: VoiceEvent) => void;

/**
 * Codec2 mode enumeration
 */
export enum Codec2Mode {
  MODE_3200 = 0,  // 3200 bps
  MODE_2400 = 1,  // 2400 bps (our target)
  MODE_1600 = 2,  // 1600 bps
  MODE_1400 = 3,  // 1400 bps
  MODE_1300 = 4,  // 1300 bps
  MODE_1200 = 5,  // 1200 bps
  MODE_700C = 6,  // 700 bps
  MODE_450 = 7,   // 450 bps
}

/**
 * Serialize a voice frame to binary
 * Frame size is dynamic based on payload length
 */
export function serializeVoiceFrame(frame: VoiceFrame): Uint8Array {
  const buffer = new Uint8Array(VOICE_HEADER_SIZE + frame.payload.length);
  const view = new DataView(buffer.buffer);

  buffer[0] = frame.frameType;
  buffer[1] = frame.flags;
  view.setUint32(2, frame.senderId, true);  // Little-endian
  view.setUint32(6, frame.sequence, true);
  view.setUint16(10, frame.timestampOffset, true);
  buffer.set(frame.payload, VOICE_HEADER_SIZE);

  return buffer;
}

/**
 * Deserialize a binary voice frame
 * Payload size is derived from total frame size
 */
export function deserializeVoiceFrame(data: Uint8Array): VoiceFrame | null {
  if (data.length < VOICE_HEADER_SIZE) return null;
  if (data[0] !== VOICE_FRAME_TYPE) return null;

  const view = new DataView(data.buffer, data.byteOffset);

  return {
    frameType: data[0],
    flags: data[1],
    senderId: view.getUint32(2, true),
    sequence: view.getUint32(6, true),
    timestampOffset: view.getUint16(10, true),
    payload: data.slice(VOICE_HEADER_SIZE),  // Extract actual payload (variable size)
  };
}

/**
 * Check if a binary message is a voice frame
 */
export function isVoiceFrame(data: Uint8Array): boolean {
  return data.length >= 1 && data[0] === VOICE_FRAME_TYPE;
}

/**
 * Generate a truncated sender ID from player ID string
 */
export function truncatePlayerId(playerId: string): number {
  let hash = 0;
  for (let i = 0; i < playerId.length; i++) {
    hash = ((hash << 5) - hash + playerId.charCodeAt(i)) | 0;
  }
  return hash >>> 0; // Convert to unsigned 32-bit
}
