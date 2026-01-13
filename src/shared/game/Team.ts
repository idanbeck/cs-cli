// Team management for CS-style game
// Handles team assignments, balance, and scoring

import { debugLog } from '../../utils/FileLogger.js';

export type TeamId = 'T' | 'CT' | 'SPECTATOR';

export interface TeamConfig {
  id: TeamId;
  name: string;
  shortName: string;
  color: [number, number, number];
  spawnFilter: 'T' | 'CT' | 'DM';
}

export const TEAMS: Record<TeamId, TeamConfig> = {
  T: {
    id: 'T',
    name: 'Terrorists',
    shortName: 'T',
    color: [255, 80, 80],   // Red
    spawnFilter: 'T',
  },
  CT: {
    id: 'CT',
    name: 'Counter-Terrorists',
    shortName: 'CT',
    color: [100, 150, 255],  // Blue
    spawnFilter: 'CT',
  },
  SPECTATOR: {
    id: 'SPECTATOR',
    name: 'Spectators',
    shortName: 'SPEC',
    color: [150, 150, 150],  // Gray
    spawnFilter: 'DM',
  },
};

export function getTeamConfig(teamId: TeamId): TeamConfig {
  return TEAMS[teamId];
}

export function getOpposingTeam(teamId: TeamId): TeamId {
  if (teamId === 'T') return 'CT';
  if (teamId === 'CT') return 'T';
  return 'SPECTATOR';
}

// Interface for entities that can be on a team
export interface TeamMember {
  name: string;
  team: TeamId;
  isAlive: boolean;
}

export class TeamManager {
  private assignments: Map<string, TeamId> = new Map();

  // Assign a player/bot to a team
  assignToTeam(name: string, team: TeamId): void {
    this.assignments.set(name, team);
  }

  // Get the team for a player/bot
  getTeam(name: string): TeamId | null {
    return this.assignments.get(name) ?? null;
  }

  // Get all members of a team
  getTeamMembers(team: TeamId): string[] {
    const members: string[] = [];
    for (const [name, assignedTeam] of this.assignments) {
      if (assignedTeam === team) {
        members.push(name);
      }
    }
    return members;
  }

  // Get count of members on each team
  getTeamCounts(): { T: number; CT: number; SPECTATOR: number } {
    let t = 0, ct = 0, spec = 0;
    for (const team of this.assignments.values()) {
      if (team === 'T') t++;
      else if (team === 'CT') ct++;
      else spec++;
    }
    return { T: t, CT: ct, SPECTATOR: spec };
  }

  // Count alive members on a team
  getAliveCount(team: TeamId, members: TeamMember[]): number {
    return members.filter(m => m.team === team && m.isAlive).length;
  }

  // Check if two members are on the same team
  areTeammates(name1: string, name2: string): boolean {
    const team1 = this.getTeam(name1);
    const team2 = this.getTeam(name2);
    if (!team1 || !team2) return false;
    if (team1 === 'SPECTATOR' || team2 === 'SPECTATOR') return false;
    return team1 === team2;
  }

  // Check if two members are enemies
  areEnemies(name1: string, name2: string): boolean {
    const team1 = this.getTeam(name1);
    const team2 = this.getTeam(name2);
    if (!team1 || !team2) return false;
    if (team1 === 'SPECTATOR' || team2 === 'SPECTATOR') return false;
    return team1 !== team2;
  }

  // Auto-balance: assign bots to teams to create equal teams
  // Player's team should already be assigned before calling this
  autoBalance(playerName: string, botNames: string[]): void {
    // Get player's already-assigned team (don't override it!)
    const playerTeam = this.getTeam(playerName);
    if (!playerTeam || playerTeam === 'SPECTATOR') {
      // Player team not assigned before autoBalance - skip
      debugLog(`[Team] autoBalance: Player team not set (${playerTeam}), skipping`);
      return;
    }

    // Calculate total players per team for balance
    // For 4v4: player + 7 bots = 8 total, 4 per team
    const totalPlayers = 1 + botNames.length; // player + bots
    const playersPerTeam = Math.ceil(totalPlayers / 2);

    // Player counts as 1 on their team
    // So we need (playersPerTeam - 1) bots on player's team
    // And playersPerTeam bots on enemy team
    const botsNeededOnPlayerTeam = playersPerTeam - 1;
    const botsNeededOnEnemyTeam = totalPlayers - playersPerTeam;

    let tBots: number;
    let ctBots: number;

    if (playerTeam === 'T') {
      tBots = botsNeededOnPlayerTeam;
      ctBots = botsNeededOnEnemyTeam;
    } else {
      tBots = botsNeededOnEnemyTeam;
      ctBots = botsNeededOnPlayerTeam;
    }

    debugLog(`[Team] autoBalance: player=${playerName} (${playerTeam}), botCount=${botNames.length}, total=${totalPlayers}, perTeam=${playersPerTeam}`);
    debugLog(`[Team] autoBalance: botsNeededOnPlayerTeam=${botsNeededOnPlayerTeam}, botsNeededOnEnemyTeam=${botsNeededOnEnemyTeam}`);
    debugLog(`[Team] autoBalance: assigning tBots=${tBots}, ctBots=${ctBots}`);

    // Assign bots
    let tAssigned = 0;
    let ctAssigned = 0;
    const tBotNames: string[] = [];
    const ctBotNames: string[] = [];

    for (const botName of botNames) {
      if (tAssigned < tBots) {
        this.assignToTeam(botName, 'T');
        tBotNames.push(botName);
        tAssigned++;
      } else {
        this.assignToTeam(botName, 'CT');
        ctBotNames.push(botName);
        ctAssigned++;
      }
    }

    // Final team totals
    const tTotal = playerTeam === 'T' ? tAssigned + 1 : tAssigned;
    const ctTotal = playerTeam === 'CT' ? ctAssigned + 1 : ctAssigned;
    debugLog(`[Team] autoBalance complete: T=${tTotal} (${tAssigned} bots: ${tBotNames.join(', ')}), CT=${ctTotal} (${ctAssigned} bots: ${ctBotNames.join(', ')})`);
  }

  // Swap all team assignments (for halftime)
  swapSides(): void {
    for (const [name, team] of this.assignments) {
      if (team === 'T') {
        this.assignments.set(name, 'CT');
      } else if (team === 'CT') {
        this.assignments.set(name, 'T');
      }
      // SPECTATOR stays SPECTATOR
    }
  }

  // Remove a member (when bot is kicked, etc.)
  removeMember(name: string): void {
    this.assignments.delete(name);
  }

  // Clear all assignments
  clear(): void {
    this.assignments.clear();
  }
}

// Singleton instance
let teamManagerInstance: TeamManager | null = null;

export function getTeamManager(): TeamManager {
  if (!teamManagerInstance) {
    teamManagerInstance = new TeamManager();
  }
  return teamManagerInstance;
}

export function resetTeamManager(): void {
  teamManagerInstance = new TeamManager();
}
