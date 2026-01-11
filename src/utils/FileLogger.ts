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

export function enableFileLogging(customPath?: string): string {
  const logger = getFileLogger();
  logger.enable(customPath);
  return logger.getLogFile();
}

export function disableFileLogging(): void {
  getFileLogger().disable();
}
