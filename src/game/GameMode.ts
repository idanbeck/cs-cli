// Game mode system - handles deathmatch rules, scoring, and game state
import { Player } from './Player.js';
import { Bot } from '../ai/Bot.js';

export type GameModeType = 'deathmatch' | 'team_deathmatch';
export type GamePhase = 'warmup' | 'playing' | 'ended';

export interface KillEvent {
  killer: string;
  victim: string;
  weapon: string;
  headshot: boolean;
  timestamp: number;
}

export interface GameModeConfig {
  type: GameModeType;
  killLimit: number;           // Score to win (0 = no limit)
  timeLimit: number;           // Time in seconds (0 = no limit)
  respawnDelay: number;        // ms before respawn
  warmupTime: number;          // Warmup period in seconds
  friendlyFire: boolean;
}

export const DEFAULT_DEATHMATCH_CONFIG: GameModeConfig = {
  type: 'deathmatch',
  killLimit: 20,
  timeLimit: 600, // 10 minutes
  respawnDelay: 3000,
  warmupTime: 5,
  friendlyFire: true,
};

export interface ScoreEntry {
  name: string;
  kills: number;
  deaths: number;
  isPlayer: boolean;
  isAlive: boolean;
}

export class GameMode {
  public config: GameModeConfig;
  public phase: GamePhase = 'warmup';
  public startTime: number = 0;
  public endTime: number = 0;
  public winner: string | null = null;

  // Kill feed
  private killFeed: KillEvent[] = [];
  private maxKillFeedSize: number = 5;
  private killFeedDuration: number = 5000; // ms

  // Player death tracking for respawn
  private playerDeathTime: number = 0;

  constructor(config: GameModeConfig = DEFAULT_DEATHMATCH_CONFIG) {
    this.config = config;
  }

  // Initialize game
  start(now: number): void {
    this.startTime = now;
    this.phase = this.config.warmupTime > 0 ? 'warmup' : 'playing';
    this.winner = null;
    this.killFeed = [];
    this.playerDeathTime = 0;
  }

  // Update game state
  update(player: Player, bots: Bot[], now: number): void {
    // Handle warmup phase
    if (this.phase === 'warmup') {
      const warmupElapsed = (now - this.startTime) / 1000;
      if (warmupElapsed >= this.config.warmupTime) {
        this.phase = 'playing';
        this.startTime = now; // Reset start time for actual game
      }
      return;
    }

    if (this.phase === 'ended') return;

    // Check time limit
    if (this.config.timeLimit > 0) {
      const elapsed = (now - this.startTime) / 1000;
      if (elapsed >= this.config.timeLimit) {
        this.endGame(player, bots, now);
        return;
      }
    }

    // Check kill limit
    if (this.config.killLimit > 0) {
      // Check player
      if (player.kills >= this.config.killLimit) {
        this.winner = player.name;
        this.endGame(player, bots, now);
        return;
      }

      // Check bots
      for (const bot of bots) {
        if (bot.kills >= this.config.killLimit) {
          this.winner = bot.name;
          this.endGame(player, bots, now);
          return;
        }
      }
    }

    // Clean up old kill feed entries
    this.cleanKillFeed(now);
  }

  // End the game
  private endGame(player: Player, bots: Bot[], now: number): void {
    this.phase = 'ended';
    this.endTime = now;

    // Determine winner if not already set (time ran out)
    if (!this.winner) {
      let topScore = player.kills;
      this.winner = player.name;

      for (const bot of bots) {
        if (bot.kills > topScore) {
          topScore = bot.kills;
          this.winner = bot.name;
        }
      }
    }
  }

  // Register a kill
  registerKill(
    killerName: string,
    victimName: string,
    weaponName: string,
    headshot: boolean,
    now: number
  ): void {
    this.killFeed.push({
      killer: killerName,
      victim: victimName,
      weapon: weaponName,
      headshot,
      timestamp: now,
    });

    // Trim to max size
    while (this.killFeed.length > this.maxKillFeedSize) {
      this.killFeed.shift();
    }
  }

  // Clean up old kill feed entries
  private cleanKillFeed(now: number): void {
    this.killFeed = this.killFeed.filter(
      event => now - event.timestamp < this.killFeedDuration
    );
  }

  // Get active kill feed entries
  getKillFeed(now: number): KillEvent[] {
    return this.killFeed.filter(
      event => now - event.timestamp < this.killFeedDuration
    );
  }

  // Get time remaining (in seconds)
  getTimeRemaining(now: number): number {
    if (this.config.timeLimit <= 0) return -1; // No limit
    if (this.phase === 'warmup') return this.config.timeLimit;
    if (this.phase === 'ended') return 0;

    const elapsed = (now - this.startTime) / 1000;
    return Math.max(0, this.config.timeLimit - elapsed);
  }

  // Get warmup time remaining (in seconds)
  getWarmupRemaining(now: number): number {
    if (this.phase !== 'warmup') return 0;
    const elapsed = (now - this.startTime) / 1000;
    return Math.max(0, this.config.warmupTime - elapsed);
  }

  // Format time as MM:SS
  formatTime(seconds: number): string {
    if (seconds < 0) return '--:--';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  // Get scoreboard entries sorted by kills
  getScoreboard(player: Player, bots: Bot[]): ScoreEntry[] {
    const entries: ScoreEntry[] = [];

    // Add player
    entries.push({
      name: player.name,
      kills: player.kills,
      deaths: player.deaths,
      isPlayer: true,
      isAlive: player.isAlive,
    });

    // Add bots
    for (const bot of bots) {
      entries.push({
        name: bot.name,
        kills: bot.kills,
        deaths: bot.deaths,
        isPlayer: false,
        isAlive: bot.isAlive,
      });
    }

    // Sort by kills (descending), then deaths (ascending)
    entries.sort((a, b) => {
      if (b.kills !== a.kills) return b.kills - a.kills;
      return a.deaths - b.deaths;
    });

    return entries;
  }

  // Check if player should respawn
  shouldPlayerRespawn(player: Player, now: number): boolean {
    if (player.isAlive) return false;
    if (this.phase === 'ended') return false;

    // Record death time if not set
    if (this.playerDeathTime === 0) {
      this.playerDeathTime = now;
    }

    // Check if respawn delay has passed
    if (now - this.playerDeathTime >= this.config.respawnDelay) {
      this.playerDeathTime = 0;
      return true;
    }

    return false;
  }

  // Get respawn countdown (in seconds)
  getRespawnCountdown(now: number): number {
    if (this.playerDeathTime === 0) return 0;
    const remaining = this.config.respawnDelay - (now - this.playerDeathTime);
    return Math.max(0, Math.ceil(remaining / 1000));
  }

  // Reset player death time (call when player respawns)
  onPlayerRespawn(): void {
    this.playerDeathTime = 0;
  }

  // Restart the game
  restart(player: Player, bots: Bot[], now: number): void {
    // Reset player
    player.kills = 0;
    player.deaths = 0;

    // Reset bots
    for (const bot of bots) {
      bot.kills = 0;
      bot.deaths = 0;
    }

    // Reset game state
    this.start(now);
  }
}
