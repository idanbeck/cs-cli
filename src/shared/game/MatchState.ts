// Match state tracking for CS-style game
// Tracks overall match progress, player stats, and round history

import { TeamId } from './Team.js';
import { GameModeType } from '../types/GameTypes.js';

export interface PlayerMatchStats {
  name: string;
  team: TeamId;
  kills: number;
  deaths: number;
  assists: number;
  headshots: number;
  damage: number;
  money: number;
  mvpCount: number;
  roundsWon: number;
  weaponKills: Record<string, number>;  // Kills per weapon type
}

export interface RoundHistory {
  roundNumber: number;
  winner: TeamId;
  reason: string;  // 'elimination', 'time', 'bomb', etc.
  mvp: string | null;
  duration: number;  // ms
  tAlive: number;
  ctAlive: number;
}

export interface MatchState {
  mapName: string;
  gameMode: GameModeType;
  startTime: number;
  endTime: number | null;

  // Scores
  tRoundWins: number;
  ctRoundWins: number;
  roundsToWin: number;

  // Current round
  currentRound: number;
  isHalftime: boolean;

  // Player stats
  playerStats: Map<string, PlayerMatchStats>;

  // History
  roundHistory: RoundHistory[];

  // Match result
  matchWinner: TeamId | null;
  matchMvp: string | null;
}

export class MatchStateManager {
  private state: MatchState;

  constructor(mapName: string, gameMode: GameModeType, roundsToWin: number, now: number) {
    this.state = {
      mapName,
      gameMode,
      startTime: now,
      endTime: null,
      tRoundWins: 0,
      ctRoundWins: 0,
      roundsToWin,
      currentRound: 0,
      isHalftime: false,
      playerStats: new Map(),
      roundHistory: [],
      matchWinner: null,
      matchMvp: null,
    };
  }

  getState(): MatchState {
    return this.state;
  }

  // Register a player/bot for stat tracking
  registerPlayer(name: string, team: TeamId): void {
    if (!this.state.playerStats.has(name)) {
      this.state.playerStats.set(name, {
        name,
        team,
        kills: 0,
        deaths: 0,
        assists: 0,
        headshots: 0,
        damage: 0,
        money: 0,
        mvpCount: 0,
        roundsWon: 0,
        weaponKills: {},
      });
    } else {
      // Update team if changed (halftime swap)
      const stats = this.state.playerStats.get(name)!;
      stats.team = team;
    }
  }

  // Update player's current money (for display)
  updatePlayerMoney(name: string, money: number): void {
    const stats = this.state.playerStats.get(name);
    if (stats) {
      stats.money = money;
    }
  }

  // Record a kill
  recordKill(killer: string, victim: string, weaponType: string, isHeadshot: boolean): void {
    const killerStats = this.state.playerStats.get(killer);
    const victimStats = this.state.playerStats.get(victim);

    if (killerStats) {
      killerStats.kills++;
      if (isHeadshot) {
        killerStats.headshots++;
      }
      killerStats.weaponKills[weaponType] = (killerStats.weaponKills[weaponType] || 0) + 1;
    }

    if (victimStats) {
      victimStats.deaths++;
    }
  }

  // Record damage dealt
  recordDamage(attacker: string, damage: number): void {
    const stats = this.state.playerStats.get(attacker);
    if (stats) {
      stats.damage += damage;
    }
  }

  // Record an assist
  recordAssist(assister: string): void {
    const stats = this.state.playerStats.get(assister);
    if (stats) {
      stats.assists++;
    }
  }

  // Start a new round
  startRound(): void {
    this.state.currentRound++;
  }

  // Record round end
  recordRoundEnd(
    winner: TeamId,
    reason: string,
    mvp: string | null,
    duration: number,
    tAlive: number,
    ctAlive: number
  ): void {
    // Update scores
    if (winner === 'T') {
      this.state.tRoundWins++;
    } else if (winner === 'CT') {
      this.state.ctRoundWins++;
    }

    // Record MVP
    if (mvp) {
      const mvpStats = this.state.playerStats.get(mvp);
      if (mvpStats) {
        mvpStats.mvpCount++;
      }
    }

    // Update rounds won for winning team players
    for (const [, stats] of this.state.playerStats) {
      if (stats.team === winner) {
        stats.roundsWon++;
      }
    }

    // Add to history
    this.state.roundHistory.push({
      roundNumber: this.state.currentRound,
      winner,
      reason,
      mvp,
      duration,
      tAlive,
      ctAlive,
    });
  }

  // Check if halftime should occur
  shouldHalftime(halftimeRound: number): boolean {
    if (halftimeRound === 0) return false;
    return this.state.currentRound === halftimeRound && !this.state.isHalftime;
  }

  // Perform halftime swap
  doHalftime(): void {
    this.state.isHalftime = true;

    // Swap scores
    const tempScore = this.state.tRoundWins;
    this.state.tRoundWins = this.state.ctRoundWins;
    this.state.ctRoundWins = tempScore;

    // Swap player teams
    for (const [, stats] of this.state.playerStats) {
      if (stats.team === 'T') {
        stats.team = 'CT';
      } else if (stats.team === 'CT') {
        stats.team = 'T';
      }
    }
  }

  // Check if match is over
  checkMatchEnd(): TeamId | null {
    if (this.state.tRoundWins >= this.state.roundsToWin) {
      return 'T';
    }
    if (this.state.ctRoundWins >= this.state.roundsToWin) {
      return 'CT';
    }
    return null;
  }

  // End the match
  endMatch(winner: TeamId, now: number): void {
    this.state.endTime = now;
    this.state.matchWinner = winner;

    // Determine match MVP (most MVPs, then most kills)
    let matchMvp: string | null = null;
    let maxMvps = 0;
    let maxKills = 0;

    for (const [name, stats] of this.state.playerStats) {
      if (stats.team === winner) {
        if (stats.mvpCount > maxMvps ||
            (stats.mvpCount === maxMvps && stats.kills > maxKills)) {
          matchMvp = name;
          maxMvps = stats.mvpCount;
          maxKills = stats.kills;
        }
      }
    }

    this.state.matchMvp = matchMvp;
  }

  // Get scoreboard data sorted by kills
  getScoreboard(): PlayerMatchStats[] {
    const stats = Array.from(this.state.playerStats.values());
    return stats.sort((a, b) => {
      // Sort by kills descending, then deaths ascending
      if (b.kills !== a.kills) return b.kills - a.kills;
      return a.deaths - b.deaths;
    });
  }

  // Get scoreboard for a specific team
  getTeamScoreboard(team: TeamId): PlayerMatchStats[] {
    return this.getScoreboard().filter(s => s.team === team);
  }

  // Get current scores
  getScores(): { t: number; ct: number } {
    return {
      t: this.state.tRoundWins,
      ct: this.state.ctRoundWins,
    };
  }

  // Get match duration
  getMatchDuration(now: number): number {
    return (this.state.endTime ?? now) - this.state.startTime;
  }

  // Get player stats
  getPlayerStats(name: string): PlayerMatchStats | null {
    return this.state.playerStats.get(name) ?? null;
  }

  // Get top players by stat
  getTopPlayers(stat: keyof Pick<PlayerMatchStats, 'kills' | 'deaths' | 'damage' | 'mvpCount'>, count: number = 3): PlayerMatchStats[] {
    const stats = Array.from(this.state.playerStats.values());
    return stats
      .sort((a, b) => (b[stat] as number) - (a[stat] as number))
      .slice(0, count);
  }

  // Reset for new match (keeps same config)
  reset(now: number): void {
    this.state.startTime = now;
    this.state.endTime = null;
    this.state.tRoundWins = 0;
    this.state.ctRoundWins = 0;
    this.state.currentRound = 0;
    this.state.isHalftime = false;
    this.state.roundHistory = [];
    this.state.matchWinner = null;
    this.state.matchMvp = null;

    // Reset player stats but keep registrations
    for (const [, stats] of this.state.playerStats) {
      stats.kills = 0;
      stats.deaths = 0;
      stats.assists = 0;
      stats.headshots = 0;
      stats.damage = 0;
      stats.mvpCount = 0;
      stats.roundsWon = 0;
      stats.weaponKills = {};
    }
  }
}

// Singleton for current match
let currentMatchState: MatchStateManager | null = null;

export function createMatchState(
  mapName: string,
  gameMode: GameModeType,
  roundsToWin: number,
  now: number
): MatchStateManager {
  currentMatchState = new MatchStateManager(mapName, gameMode, roundsToWin, now);
  return currentMatchState;
}

export function getMatchState(): MatchStateManager | null {
  return currentMatchState;
}

export function clearMatchState(): void {
  currentMatchState = null;
}
