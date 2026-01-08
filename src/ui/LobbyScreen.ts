// Lobby screen UI for CS-CLI multiplayer
// Pre-game lobby where players wait and ready up

import { RoomInfo, TeamId } from '../shared/types/Protocol.js';

export interface LobbyPlayer {
  id: string;
  name: string;
  team: TeamId;
  isReady: boolean;
  isHost: boolean;
}

export interface LobbyState {
  roomInfo: RoomInfo | null;
  players: LobbyPlayer[];
  localPlayerId: string | null;
  localTeam: TeamId;
  isReady: boolean;
  countdown: number | null;  // null = not starting, number = seconds until start
  chatMessages: { sender: string; message: string; teamOnly: boolean }[];
}

export class LobbyScreen {
  private state: LobbyState;

  constructor() {
    this.state = {
      roomInfo: null,
      players: [],
      localPlayerId: null,
      localTeam: 'SPECTATOR',
      isReady: false,
      countdown: null,
      chatMessages: [],
    };
  }

  getState(): LobbyState {
    return this.state;
  }

  // ============ State Updates ============

  setRoomInfo(info: RoomInfo): void {
    this.state.roomInfo = info;
  }

  setLocalPlayerId(id: string): void {
    this.state.localPlayerId = id;
  }

  setLocalTeam(team: TeamId): void {
    this.state.localTeam = team;
  }

  addPlayer(id: string, name: string, isHost: boolean = false): void {
    // Check if player already exists
    const existing = this.state.players.find(p => p.id === id);
    if (existing) return;

    this.state.players.push({
      id,
      name,
      team: 'SPECTATOR',
      isReady: false,
      isHost,
    });
  }

  removePlayer(id: string): void {
    this.state.players = this.state.players.filter(p => p.id !== id);
  }

  setPlayerReady(id: string, ready: boolean): void {
    const player = this.state.players.find(p => p.id === id);
    if (player) {
      player.isReady = ready;
    }

    // Update local state if it's us
    if (id === this.state.localPlayerId) {
      this.state.isReady = ready;
    }
  }

  setPlayerTeam(id: string, team: TeamId): void {
    const player = this.state.players.find(p => p.id === id);
    if (player) {
      player.team = team;
    }
  }

  setCountdown(seconds: number | null): void {
    this.state.countdown = seconds;
  }

  addChatMessage(sender: string, message: string, teamOnly: boolean): void {
    this.state.chatMessages.push({ sender, message, teamOnly });
    // Keep only last 50 messages
    if (this.state.chatMessages.length > 50) {
      this.state.chatMessages.shift();
    }
  }

  // ============ Getters ============

  getRoomInfo(): RoomInfo | null {
    return this.state.roomInfo;
  }

  getPlayers(): LobbyPlayer[] {
    return this.state.players;
  }

  getLocalPlayer(): LobbyPlayer | null {
    return this.state.players.find(p => p.id === this.state.localPlayerId) || null;
  }

  isLocalHost(): boolean {
    const local = this.getLocalPlayer();
    return local?.isHost || false;
  }

  isLocalReady(): boolean {
    return this.state.isReady;
  }

  getCountdown(): number | null {
    return this.state.countdown;
  }

  getChatMessages(): { sender: string; message: string; teamOnly: boolean }[] {
    return this.state.chatMessages;
  }

  getPlayersByTeam(): { T: LobbyPlayer[]; CT: LobbyPlayer[]; SPECTATOR: LobbyPlayer[] } {
    return {
      T: this.state.players.filter(p => p.team === 'T'),
      CT: this.state.players.filter(p => p.team === 'CT'),
      SPECTATOR: this.state.players.filter(p => p.team === 'SPECTATOR'),
    };
  }

  getReadyCount(): { ready: number; total: number } {
    const ready = this.state.players.filter(p => p.isReady).length;
    return { ready, total: this.state.players.length };
  }

  canStartGame(): boolean {
    // Host can start if all players are ready and there are at least 1 player
    if (!this.isLocalHost()) return false;
    if (this.state.players.length < 1) return false;

    // In competitive mode, need balanced teams
    // For now, just require at least one player ready
    return this.state.players.some(p => p.isReady);
  }

  // ============ Actions ============

  toggleReady(): boolean {
    this.state.isReady = !this.state.isReady;
    return this.state.isReady;
  }

  // Handle key input - returns action to perform
  handleKey(key: string): { action: 'ready' | 'start' | 'leave' | 'chat' | 'team_t' | 'team_ct' | 'none' } {
    switch (key) {
      case 'r':
      case 'R':
      case 'enter':
        // Enter or R toggles ready
        return { action: 'ready' };
      case 's':
      case 'S':
        // S starts game (host only)
        if (this.isLocalHost() && this.canStartGame()) {
          return { action: 'start' };
        }
        return { action: 'none' };
      case 'escape':
        return { action: 'leave' };
      case '1':
        return { action: 'team_t' };
      case '2':
        return { action: 'team_ct' };
      case 't':
      case 'T':
        return { action: 'chat' };
      default:
        return { action: 'none' };
    }
  }

  // ============ Display Helpers ============

  getScreenTitle(): string {
    if (this.state.countdown !== null) {
      return `Game Starting in ${this.state.countdown}...`;
    }
    return this.state.roomInfo?.name || 'Lobby';
  }

  getHelpText(): string {
    const hints: string[] = [];

    if (!this.state.isReady) {
      hints.push('[Enter/R] Ready');
    } else {
      hints.push('[Enter/R] Unready');
    }

    hints.push('[1] Team T');
    hints.push('[2] Team CT');

    if (this.isLocalHost() && this.canStartGame()) {
      hints.push('[S] Start');
    }

    hints.push('[Esc] Leave');

    return hints.join(' | ');
  }

  getRoomDescription(): string {
    const info = this.state.roomInfo;
    if (!info) return '';

    const mode = info.mode === 'deathmatch' ? 'Deathmatch' : 'Competitive';
    return `${mode} on ${info.map} | ${info.playerCount}/${info.maxPlayers} players | ${info.botCount} bots`;
  }

  // ============ Reset ============

  reset(): void {
    this.state = {
      roomInfo: null,
      players: [],
      localPlayerId: null,
      localTeam: 'SPECTATOR',
      isReady: false,
      countdown: null,
      chatMessages: [],
    };
  }
}

// Singleton
let lobbyScreenInstance: LobbyScreen | null = null;

export function getLobbyScreen(): LobbyScreen {
  if (!lobbyScreenInstance) {
    lobbyScreenInstance = new LobbyScreen();
  }
  return lobbyScreenInstance;
}

export function resetLobbyScreen(): void {
  lobbyScreenInstance = new LobbyScreen();
}
