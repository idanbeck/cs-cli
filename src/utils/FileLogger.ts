// File-based logger for performance analysis
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

class FileLogger {
  private logFile: string;
  private stream: fs.WriteStream | null = null;
  private enabled: boolean = false;

  constructor() {
    // Default log location
    const logDir = path.join(os.homedir(), '.csterm', 'logs');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.logFile = path.join(logDir, `game-${timestamp}.log`);
  }

  enable(customPath?: string): void {
    if (customPath) {
      this.logFile = customPath;
    }

    // Ensure directory exists
    const dir = path.dirname(this.logFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.stream = fs.createWriteStream(this.logFile, { flags: 'a' });
    this.enabled = true;
    this.log('='.repeat(60));
    this.log(`Log started: ${new Date().toISOString()}`);
    this.log(`Log file: ${this.logFile}`);
    this.log('='.repeat(60));
  }

  disable(): void {
    if (this.stream) {
      this.log('Log ended');
      this.stream.end();
      this.stream = null;
    }
    this.enabled = false;
  }

  log(message: string): void {
    if (!this.enabled || !this.stream) return;
    const timestamp = new Date().toISOString();
    this.stream.write(`[${timestamp}] ${message}\n`);
  }

  perf(data: {
    fps?: number;
    physicsTicks?: number;
    serverTickRate?: number;
    totalTicks?: number;
    frameTime?: number;
    alpha?: number;
  }): void {
    if (!this.enabled) return;
    const line = `PERF fps=${data.fps?.toFixed(1) ?? '-'} physics=${data.physicsTicks ?? '-'} serverTick=${data.serverTickRate?.toFixed(1) ?? '-'} total=${data.totalTicks ?? '-'} frameMs=${data.frameTime?.toFixed(2) ?? '-'} alpha=${data.alpha?.toFixed(3) ?? '-'}`;
    this.log(line);
  }

  hit(data: {
    shooter: string;
    damage: number;
    distance: number;
    perpDist: number;
  }): void {
    if (!this.enabled) return;
    this.log(`HIT shooter=${data.shooter} dmg=${data.damage} dist=${data.distance.toFixed(1)} perp=${data.perpDist.toFixed(2)}`);
  }

  event(eventType: string, data?: Record<string, any>): void {
    if (!this.enabled) return;
    const extra = data ? ' ' + JSON.stringify(data) : '';
    this.log(`EVENT ${eventType}${extra}`);
  }

  getLogFile(): string {
    return this.logFile;
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

// Singleton
let loggerInstance: FileLogger | null = null;

export function getFileLogger(): FileLogger {
  if (!loggerInstance) {
    loggerInstance = new FileLogger();
  }
  return loggerInstance;
}

// Simple file-based debug log that doesn't interfere with terminal display
// Always writes to a fixed location, useful for internal logging
const DEBUG_LOG_DIR = path.join(os.homedir(), '.csterm', 'logs');
const DEBUG_LOG_FILE = path.join(DEBUG_LOG_DIR, 'debug.log');
let debugLogInitialized = false;

function ensureDebugLog(): void {
  if (!debugLogInitialized) {
    try {
      if (!fs.existsSync(DEBUG_LOG_DIR)) {
        fs.mkdirSync(DEBUG_LOG_DIR, { recursive: true });
      }
      debugLogInitialized = true;
    } catch {
      // Ignore
    }
  }
}

/**
 * Write a message to the debug log file (never to stdout/stderr).
 * Use this for internal logging that shouldn't interfere with TUI/gameplay.
 */
export function debugLog(message: string): void {
  ensureDebugLog();
  try {
    const timestamp = new Date().toISOString();
    fs.appendFileSync(DEBUG_LOG_FILE, `[${timestamp}] ${message}\n`);
  } catch {
    // Silently ignore log failures
  }
}

export function enableFileLogging(customPath?: string): string {
  const logger = getFileLogger();
  logger.enable(customPath);
  return logger.getLogFile();
}

export function disableFileLogging(): void {
  getFileLogger().disable();
}
