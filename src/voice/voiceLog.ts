/**
 * Voice debug logging to file
 *
 * Writes debug messages to /tmp/csterm-voice-debug.log
 */

import * as fs from 'fs';
import * as path from 'path';

const LOG_FILE = '/tmp/csterm-voice-debug.log';

// Clear log file on startup
try {
  fs.writeFileSync(LOG_FILE, `=== Voice Debug Log Started ${new Date().toISOString()} ===\n`);
} catch {}

/**
 * Write a debug message to the voice log file
 */
export function voiceLog(message: string): void {
  const timestamp = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const line = `[${timestamp}] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

/**
 * Get log file path
 */
export function getVoiceLogPath(): string {
  return LOG_FILE;
}
