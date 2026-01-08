// Game mode system - handles rounds, scoring, phases, and game state
// Supports both FFA Deathmatch and Team Competitive modes

import { Player } from './Player.js';
import { Bot } from '../ai/Bot.js';
import { TeamId, getTeamManager } from './Team.js';
import { PlayerEconomy, DEFAULT_ECONOMY_CONFIG, EconomyConfig } from './Economy.js';

export type GameModeType = 'deathmatch' | 'competitive';
export type GamePhase =
  | 'pre_match'     // Main menu/waiting
  | 'warmup'        // Pre-game warmup
  | 'freeze'        // Buy phase, frozen
  | 'live'          // Round in progress
  | 'round_end'     // Brief pause showing winner
  | 'halftime'      // Team swap (competitive only)
  | 'match_end';    // Final scoreboard

export interface KillEvent {
  killer: string;
  killerTeam: TeamId;
  victim: string;
  victimTeam: TeamId;
  weapon: string;
  headshot: boolean;
  timestamp: number;
}

export interface GameModeConfig {
  type: GameModeType;

  // Match settings
  roundsToWin: number;        // Rounds needed to win match
  maxRounds: number;          // Maximum rounds (for halftime calc)

  // Round timing
  freezeTime: number;         // Seconds for buy phase
  roundTime: number;          // Seconds per round
  roundEndDelay: number;      // Seconds after round end
  warmupTime: number;         // Seconds for pre-match warmup

  // Team settings
  halftimeRound: number;      // Round number to swap sides (0 = no halftime)
  friendlyFire: boolean;

  // Economy
  economy: EconomyConfig;

  // Legacy deathmatch settings (for DM mode)
  respawnDelay: number;       // ms before respawn (DM only)
}

export const DEFAULT_COMPETITIVE_CONFIG: GameModeConfig = {
  type: 'competitive',
  roundsToWin: 7,             // First to 7 wins (MR13)
  maxRounds: 13,              // 13 rounds per half
  freezeTime: 15,
  roundTime: 115,
  roundEndDelay: 5,
  warmupTime: 10,
  halftimeRound: 7,           // Swap after 7 rounds
  friendlyFire: true,
  economy: DEFAULT_ECONOMY_CONFIG,
  respawnDelay: 0,            // No respawn in competitive
};

export const DEFAULT_DEATHMATCH_CONFIG: GameModeConfig = {
  type: 'deathmatch',
  roundsToWin: 10,            // First to 10 round wins
  maxRounds: 0,               // No max (no halftime)
  freezeTime: 10,             // Shorter freeze for DM
  roundTime: 120,
  roundEndDelay: 3,
  warmupTime: 5,
  halftimeRound: 0,           // No halftime in DM
  friendlyFire: true,
  economy: DEFAULT_ECONOMY_CONFIG,
  respawnDelay: 3000,         // 3 second respawn in DM warmup
};

export interface RoundState {
  roundNumber: number;
  tScore: number;
  ctScore: number;
  roundWinner: TeamId | null;
  roundWinReason: string;
  mvp: string | null;
}

export interface ScoreEntry {
  name: string;
  team: TeamId;
  kills: number;
  deaths: number;
  money: number;
  isPlayer: boolean;
  isAlive: boolean;
}

export class GameMode {
  public config: GameModeConfig;
  public phase: GamePhase = 'pre_match';

  // Timing
  private phaseStartTime: number = 0;
  private matchStartTime: number = 0;

  // Round state
  public round: RoundState = {
    roundNumber: 0,
    tScore: 0,
    ctScore: 0,
    roundWinner: null,
    roundWinReason: '',
    mvp: null,
  };

  // Match winner
  public matchWinner: TeamId | null = null;

  // Kill feed
  private killFeed: KillEvent[] = [];
  private maxKillFeedSize: number = 5;
  private killFeedDuration: number = 5000;

  // Player death tracking for respawn (DM only)
  private playerDeathTime: number = 0;

  // Round kills for MVP tracking
  private roundKills: Map<string, number> = new Map();

  constructor(config: GameModeConfig = DEFAULT_COMPETITIVE_CONFIG) {
    this.config = config;
  }

  // ========== PHASE TRANSITIONS ==========

  // Start the match
  startMatch(now: number): void {
    this.matchStartTime = now;
    this.phaseStartTime = now;
    this.matchWinner = null;
    this.killFeed = [];

    // Reset round state
    this.round = {
      roundNumber: 0,
      tScore: 0,
      ctScore: 0,
      roundWinner: null,
      roundWinReason: '',
      mvp: null,
    };

    // Start warmup phase
    this.phase = this.config.warmupTime > 0 ? 'warmup' : 'freeze';
    if (this.phase === 'freeze') {
      this.round.roundNumber = 1;
    }
  }

  // Start a new round (freeze phase)
  startRound(now: number): void {
    this.phase = 'freeze';
    this.phaseStartTime = now;
    this.round.roundNumber++;
    this.round.roundWinner = null;
    this.round.roundWinReason = '';
    this.round.mvp = null;
    this.roundKills.clear();
  }

  // End freeze phase, start live round
  endFreezePhase(now: number): void {
    this.phase = 'live';
    this.phaseStartTime = now;
  }

  // End current round
  endRound(winner: TeamId, reason: string, now: number): void {
    this.phase = 'round_end';
    this.phaseStartTime = now;
    this.round.roundWinner = winner;
    this.round.roundWinReason = reason;

    // Update score
    if (winner === 'T') {
      this.round.tScore++;
    } else if (winner === 'CT') {
      this.round.ctScore++;
    }

    // Determine MVP (most kills this round)
    let maxKills = 0;
    let mvpName: string | null = null;
    for (const [name, kills] of this.roundKills) {
      if (kills > maxKills) {
        maxKills = kills;
        mvpName = name;
      }
    }
    this.round.mvp = mvpName;
  }

  // Start halftime
  startHalftime(now: number): void {
    this.phase = 'halftime';
    this.phaseStartTime = now;
  }

  // End match
  endMatch(winner: TeamId, now: number): void {
    this.phase = 'match_end';
    this.phaseStartTime = now;
    this.matchWinner = winner;
  }

  // ========== UPDATE ==========

  update(player: Player, bots: Bot[], now: number): void {
    const elapsed = (now - this.phaseStartTime) / 1000;

    switch (this.phase) {
      case 'warmup':
        if (elapsed >= this.config.warmupTime) {
          this.startRound(now);
        }
        break;

      case 'freeze':
        if (elapsed >= this.config.freezeTime) {
          this.endFreezePhase(now);
        }
        break;

      case 'live':
        // Check round end conditions
        const winner = this.checkRoundEndConditions(player, bots);
        if (winner) {
          const reason = this.getRoundEndReason(player, bots, winner);
          this.endRound(winner, reason, now);
        } else if (elapsed >= this.config.roundTime) {
          // Time ran out - determine winner by alive count or score
          const timeWinner = this.determineTimeoutWinner(player, bots);
          this.endRound(timeWinner, 'Time expired', now);
        }
        break;

      case 'round_end':
        if (elapsed >= this.config.roundEndDelay) {
          // Check for match end
          if (this.checkMatchEnd()) {
            this.endMatch(this.round.roundWinner!, now);
          } else if (this.shouldHalftime()) {
            this.startHalftime(now);
          } else {
            this.startRound(now);
          }
        }
        break;

      case 'halftime':
        if (elapsed >= 5) { // 5 second halftime display
          // Swap sides
          getTeamManager().swapSides();
          // Swap scores
          const temp = this.round.tScore;
          this.round.tScore = this.round.ctScore;
          this.round.ctScore = temp;
          this.startRound(now);
        }
        break;

      case 'match_end':
        // Match is over, waiting for restart
        break;

      case 'pre_match':
        // Waiting for game start
        break;
    }

    // Clean up old kill feed entries
    this.cleanKillFeed(now);
  }

  // ========== ROUND END CHECKS ==========

  private checkRoundEndConditions(player: Player, bots: Bot[]): TeamId | null {
    const teamManager = getTeamManager();

    if (this.config.type === 'competitive') {
      // Team mode: check if one team is eliminated
      const allPlayers = [player, ...bots];

      const tAlive = allPlayers.filter(p =>
        teamManager.getTeam(p.name) === 'T' && p.isAlive
      ).length;

      const ctAlive = allPlayers.filter(p =>
        teamManager.getTeam(p.name) === 'CT' && p.isAlive
      ).length;

      if (tAlive === 0 && ctAlive > 0) return 'CT';
      if (ctAlive === 0 && tAlive > 0) return 'T';

    } else {
      // FFA Deathmatch: last player standing wins
      const allPlayers = [player, ...bots];
      const alive = allPlayers.filter(p => p.isAlive);

      if (alive.length === 1) {
        // Winner is the team of the last survivor
        return teamManager.getTeam(alive[0].name) ?? 'T';
      }

      if (alive.length === 0) {
        // Everyone died somehow - draw, give to T
        return 'T';
      }
    }

    return null; // Round continues
  }

  private getRoundEndReason(player: Player, bots: Bot[], winner: TeamId): string {
    if (this.config.type === 'competitive') {
      return winner === 'T' ? 'Terrorists eliminated CTs' : 'CTs eliminated Terrorists';
    } else {
      const teamManager = getTeamManager();
      const alive = [player, ...bots].filter(p => p.isAlive);
      if (alive.length === 1) {
        return `${alive[0].name} is the last survivor`;
      }
      return 'Round ended';
    }
  }

  private determineTimeoutWinner(player: Player, bots: Bot[]): TeamId {
    const teamManager = getTeamManager();
    const allPlayers = [player, ...bots];

    if (this.config.type === 'competitive') {
      // Count alive on each team
      const tAlive = allPlayers.filter(p =>
        teamManager.getTeam(p.name) === 'T' && p.isAlive
      ).length;
      const ctAlive = allPlayers.filter(p =>
        teamManager.getTeam(p.name) === 'CT' && p.isAlive
      ).length;

      if (tAlive > ctAlive) return 'T';
      if (ctAlive > tAlive) return 'CT';
      // Tie goes to CT (defenders in CS)
      return 'CT';
    } else {
      // FFA: most health wins
      let winner = player;
      for (const bot of bots) {
        if (bot.health > winner.health) {
          winner = bot;
        }
      }
      return teamManager.getTeam(winner.name) ?? 'T';
    }
  }

  private checkMatchEnd(): boolean {
    return this.round.tScore >= this.config.roundsToWin ||
           this.round.ctScore >= this.config.roundsToWin;
  }

  private shouldHalftime(): boolean {
    if (this.config.halftimeRound <= 0) return false;
    return this.round.roundNumber === this.config.halftimeRound;
  }

  // ========== KILLS ==========

  registerKill(
    killerName: string,
    victimName: string,
    weaponName: string,
    headshot: boolean,
    now: number
  ): void {
    const teamManager = getTeamManager();

    this.killFeed.push({
      killer: killerName,
      killerTeam: teamManager.getTeam(killerName) ?? 'T',
      victim: victimName,
      victimTeam: teamManager.getTeam(victimName) ?? 'CT',
      weapon: weaponName,
      headshot,
      timestamp: now,
    });

    // Track kills for MVP
    this.roundKills.set(killerName, (this.roundKills.get(killerName) ?? 0) + 1);

    // Trim kill feed
    while (this.killFeed.length > this.maxKillFeedSize) {
      this.killFeed.shift();
    }
  }

  private cleanKillFeed(now: number): void {
    this.killFeed = this.killFeed.filter(
      event => now - event.timestamp < this.killFeedDuration
    );
  }

  getKillFeed(now: number): KillEvent[] {
    return this.killFeed.filter(
      event => now - event.timestamp < this.killFeedDuration
    );
  }

  // ========== STATE QUERIES ==========

  isPlayerFrozen(): boolean {
    return this.phase === 'freeze' || this.phase === 'round_end' ||
           this.phase === 'halftime' || this.phase === 'match_end';
  }

  areBotsFrozen(): boolean {
    return this.phase === 'freeze' || this.phase === 'warmup' ||
           this.phase === 'round_end' || this.phase === 'halftime' ||
           this.phase === 'match_end';
  }

  canBuy(): boolean {
    // In deathmatch, can buy anytime (no economy pressure)
    if (this.config.type === 'deathmatch') {
      return this.phase === 'live' || this.phase === 'warmup';
    }
    // In competitive, only during freeze or warmup
    return this.phase === 'freeze' || this.phase === 'warmup';
  }

  isRoundLive(): boolean {
    return this.phase === 'live';
  }

  // ========== TIMING ==========

  getFreezeTimeRemaining(now: number): number {
    if (this.phase !== 'freeze') return 0;
    const elapsed = (now - this.phaseStartTime) / 1000;
    return Math.max(0, this.config.freezeTime - elapsed);
  }

  getRoundTimeRemaining(now: number): number {
    if (this.phase !== 'live') return this.config.roundTime;
    const elapsed = (now - this.phaseStartTime) / 1000;
    return Math.max(0, this.config.roundTime - elapsed);
  }

  getWarmupRemaining(now: number): number {
    if (this.phase !== 'warmup') return 0;
    const elapsed = (now - this.phaseStartTime) / 1000;
    return Math.max(0, this.config.warmupTime - elapsed);
  }

  formatTime(seconds: number): string {
    if (seconds < 0) return '--:--';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  // ========== SCOREBOARD ==========

  getScoreboard(player: Player, bots: Bot[]): ScoreEntry[] {
    const teamManager = getTeamManager();
    const entries: ScoreEntry[] = [];

    // Add player
    entries.push({
      name: player.name,
      team: teamManager.getTeam(player.name) ?? 'T',
      kills: player.kills,
      deaths: player.deaths,
      money: player.economy?.getMoney() ?? 0,
      isPlayer: true,
      isAlive: player.isAlive,
    });

    // Add bots
    for (const bot of bots) {
      entries.push({
        name: bot.name,
        team: teamManager.getTeam(bot.name) ?? 'CT',
        kills: bot.kills,
        deaths: bot.deaths,
        money: bot.economy?.getMoney() ?? 0,
        isPlayer: false,
        isAlive: bot.isAlive,
      });
    }

    // Sort: by team, then kills
    entries.sort((a, b) => {
      // Team first (T before CT)
      if (a.team !== b.team) {
        if (a.team === 'T') return -1;
        if (b.team === 'T') return 1;
      }
      // Then by kills
      if (b.kills !== a.kills) return b.kills - a.kills;
      return a.deaths - b.deaths;
    });

    return entries;
  }

  // ========== RESPAWN (DM mode only) ==========

  shouldPlayerRespawn(player: Player, now: number): boolean {
    // No respawn in competitive mode rounds
    if (this.config.type === 'competitive' && this.phase === 'live') {
      return false;
    }

    // No respawn when match/round ended
    if (this.phase === 'match_end' || this.phase === 'round_end') {
      return false;
    }

    if (player.isAlive) return false;

    // Only respawn in warmup or DM mode
    if (this.phase !== 'warmup' && this.config.type !== 'deathmatch') {
      return false;
    }

    // Record death time
    if (this.playerDeathTime === 0) {
      this.playerDeathTime = now;
    }

    if (now - this.playerDeathTime >= this.config.respawnDelay) {
      this.playerDeathTime = 0;
      return true;
    }

    return false;
  }

  getRespawnCountdown(now: number): number {
    if (this.playerDeathTime === 0) return 0;
    const remaining = this.config.respawnDelay - (now - this.playerDeathTime);
    return Math.max(0, Math.ceil(remaining / 1000));
  }

  onPlayerRespawn(): void {
    this.playerDeathTime = 0;
  }

  // ========== MATCH CONTROL ==========

  restart(player: Player, bots: Bot[], now: number): void {
    player.kills = 0;
    player.deaths = 0;
    player.economy?.resetForMatch();

    for (const bot of bots) {
      bot.kills = 0;
      bot.deaths = 0;
      bot.economy?.resetForMatch();
    }

    this.startMatch(now);
  }

  // For backward compatibility
  get winner(): string | null {
    if (!this.matchWinner) return null;
    return this.matchWinner === 'T' ? 'Terrorists' : 'Counter-Terrorists';
  }
}
