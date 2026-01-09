/**
 * VoiceSettings - Settings persistence for voice chat
 *
 * Integrates voice settings with the game's settings system.
 */

import { VoiceSettings, DEFAULT_VOICE_SETTINGS } from './types.js';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Settings file path
const SETTINGS_DIR = join(homedir(), '.csterm');
const SETTINGS_FILE = join(SETTINGS_DIR, 'settings.json');

/**
 * Full game settings (voice is a subset)
 */
interface GameSettings {
  // Voice settings
  voiceEnabled?: boolean;
  voiceInputVolume?: number;
  voiceOutputVolume?: number;
  voicePTTEnabled?: boolean;
  voicePTTKey?: string;
  voiceVADSensitivity?: number;
  voiceInputDevice?: string;
  voiceMaxDistance?: number;
  voiceSpatialEnabled?: boolean;

  // Other game settings (not managed here)
  [key: string]: unknown;
}

/**
 * Load voice settings from disk
 */
export async function loadVoiceSettings(): Promise<VoiceSettings> {
  try {
    if (!existsSync(SETTINGS_FILE)) {
      return { ...DEFAULT_VOICE_SETTINGS };
    }

    const content = await readFile(SETTINGS_FILE, 'utf-8');
    const settings: GameSettings = JSON.parse(content);

    return {
      voiceEnabled: settings.voiceEnabled ?? DEFAULT_VOICE_SETTINGS.voiceEnabled,
      voiceInputVolume: settings.voiceInputVolume ?? DEFAULT_VOICE_SETTINGS.voiceInputVolume,
      voiceOutputVolume: settings.voiceOutputVolume ?? DEFAULT_VOICE_SETTINGS.voiceOutputVolume,
      voicePTTEnabled: settings.voicePTTEnabled ?? DEFAULT_VOICE_SETTINGS.voicePTTEnabled,
      voicePTTKey: settings.voicePTTKey ?? DEFAULT_VOICE_SETTINGS.voicePTTKey,
      voiceVADSensitivity: settings.voiceVADSensitivity ?? DEFAULT_VOICE_SETTINGS.voiceVADSensitivity,
      voiceInputDevice: settings.voiceInputDevice ?? DEFAULT_VOICE_SETTINGS.voiceInputDevice,
      voiceMaxDistance: settings.voiceMaxDistance ?? DEFAULT_VOICE_SETTINGS.voiceMaxDistance,
      voiceSpatialEnabled: settings.voiceSpatialEnabled ?? DEFAULT_VOICE_SETTINGS.voiceSpatialEnabled,
    };
  } catch (error) {
    console.warn('[VoiceSettings] Failed to load settings:', error);
    return { ...DEFAULT_VOICE_SETTINGS };
  }
}

/**
 * Save voice settings to disk
 */
export async function saveVoiceSettings(voiceSettings: Partial<VoiceSettings>): Promise<void> {
  try {
    // Ensure directory exists
    if (!existsSync(SETTINGS_DIR)) {
      await mkdir(SETTINGS_DIR, { recursive: true });
    }

    // Load existing settings
    let settings: GameSettings = {};
    if (existsSync(SETTINGS_FILE)) {
      try {
        const content = await readFile(SETTINGS_FILE, 'utf-8');
        settings = JSON.parse(content);
      } catch {
        // Start fresh if file is corrupt
      }
    }

    // Merge voice settings
    if (voiceSettings.voiceEnabled !== undefined) {
      settings.voiceEnabled = voiceSettings.voiceEnabled;
    }
    if (voiceSettings.voiceInputVolume !== undefined) {
      settings.voiceInputVolume = voiceSettings.voiceInputVolume;
    }
    if (voiceSettings.voiceOutputVolume !== undefined) {
      settings.voiceOutputVolume = voiceSettings.voiceOutputVolume;
    }
    if (voiceSettings.voicePTTEnabled !== undefined) {
      settings.voicePTTEnabled = voiceSettings.voicePTTEnabled;
    }
    if (voiceSettings.voicePTTKey !== undefined) {
      settings.voicePTTKey = voiceSettings.voicePTTKey;
    }
    if (voiceSettings.voiceVADSensitivity !== undefined) {
      settings.voiceVADSensitivity = voiceSettings.voiceVADSensitivity;
    }
    if (voiceSettings.voiceInputDevice !== undefined) {
      settings.voiceInputDevice = voiceSettings.voiceInputDevice;
    }
    if (voiceSettings.voiceMaxDistance !== undefined) {
      settings.voiceMaxDistance = voiceSettings.voiceMaxDistance;
    }
    if (voiceSettings.voiceSpatialEnabled !== undefined) {
      settings.voiceSpatialEnabled = voiceSettings.voiceSpatialEnabled;
    }

    // Write settings
    await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (error) {
    console.error('[VoiceSettings] Failed to save settings:', error);
  }
}

/**
 * Reset voice settings to defaults
 */
export async function resetVoiceSettings(): Promise<VoiceSettings> {
  await saveVoiceSettings(DEFAULT_VOICE_SETTINGS);
  return { ...DEFAULT_VOICE_SETTINGS };
}
