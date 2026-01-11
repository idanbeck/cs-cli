/**
 * Voice Chat Module
 *
 * Spatial vocoder voice chat for CS-CLI multiplayer.
 *
 * Features:
 * - Ultra-low bandwidth (2.4 kbps) using Codec2 vocoder
 * - Voice Activity Detection (VAD) or Push-to-Talk (PTT)
 * - Spatial audio with distance attenuation and stereo panning
 * - Jitter buffer for smooth playback
 * - Team-only voice chat support
 */

// Types and constants
export {
  VoiceFrame,
  DecodedVoiceFrame,
  VoiceStream,
  VoiceSettings,
  VoiceEvent,
  VoiceEventCallback,
  SpatialParams,
  AudioDevice,
  DEFAULT_VOICE_SETTINGS,
  VOICE_FRAME_TYPE,
  VOICE_HEADER_SIZE,
  VOICE_SAMPLE_RATE,
  VOICE_FRAME_SAMPLES,
  VOICE_FRAME_MS,
  serializeVoiceFrame,
  deserializeVoiceFrame,
  isVoiceFrame,
  truncatePlayerId,
  Codec2Mode,
} from './types.js';

// Codec2 WASM wrapper
export {
  Codec2,
  getCodec2Encoder,
  initializeCodec2,
  destroyCodec2,
} from './Codec2.js';

// Microphone capture
export {
  MicCapture,
  getMicCapture,
  initializeMicCapture,
  destroyMicCapture,
} from './MicCapture.js';

// Voice Activity Detection
export {
  VADProcessor,
  VADConfig,
  calculateEnergy,
  calculatePeak,
} from './VADProcessor.js';

// Jitter buffer
export {
  JitterBuffer,
  JitterBufferManager,
  JitterBufferConfig,
} from './JitterBuffer.js';

// Spatial mixer
export {
  SpatialMixer,
  getSpatialMixer,
  destroySpatialMixer,
} from './SpatialMixer.js';

// Voice playback
export {
  VoicePlayback,
  getVoicePlayback,
  destroyVoicePlayback,
} from './VoicePlayback.js';

// Voice client (network)
export {
  VoiceClient,
  getVoiceClient,
  destroyVoiceClient,
} from './VoiceClient.js';

// Voice manager (main orchestrator)
export {
  VoiceManager,
  getVoiceManager,
  initializeVoiceManager,
  destroyVoiceManager,
} from './VoiceManager.js';

// Voice post-processor (CSterm radio effects)
export {
  VoicePostProcessor,
  getVoicePostProcessor,
  destroyVoicePostProcessor,
  PostProcessParams,
} from './VoicePostProcessor.js';

// Settings persistence
export {
  loadVoiceSettings,
  saveVoiceSettings,
  resetVoiceSettings,
} from './VoiceSettings.js';
