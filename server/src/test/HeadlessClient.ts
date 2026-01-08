// Headless WebSocket client for testing multiplayer server
// Can simulate multiple clients connecting, joining rooms, and performing actions

import WebSocket from 'ws';
import {
  ClientMessage,
  ServerMessage,
  RoomConfig,
  RoomInfo,
  TeamId,
  GamePhase,
} from '../protocol.js';

interface HeadlessClientCallbacks {
  onConnect?: () => void;
  onDisconnect?: (reason: string) => void;
  onMessage?: (message: ServerMessage) => void;
  onRoomList?: (rooms: RoomInfo[]) => void;
  onRoomJoined?: (roomId: string, playerId: string, room: RoomInfo) => void;
  onPlayerJoined?: (playerId: string, playerName: string) => void;
  onPlayerTeamChanged?: (playerId: string, team: TeamId) => void;
  onPhaseChange?: (phase: GamePhase, round: number, tScore: number, ctScore: number) => void;
}

export class HeadlessClient {
  private socket: WebSocket | null = null;
  private callbacks: HeadlessClientCallbacks = {};
  private playerId: string | null = null;
  private playerName: string;
  private roomId: string | null = null;
  private team: TeamId | null = null;
  private messageLog: ServerMessage[] = [];

  constructor(playerName: string = 'TestPlayer') {
    this.playerName = playerName;
  }

  async connect(serverUrl: string = 'ws://localhost:8080'): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(serverUrl);

      this.socket.onopen = () => {
        console.log(`[${this.playerName}] Connected to server`);
        this.callbacks.onConnect?.();
        resolve();
      };

      this.socket.onclose = (event) => {
        const reason = event.reason || 'Connection closed';
        console.log(`[${this.playerName}] Disconnected: ${reason}`);
        this.callbacks.onDisconnect?.(reason);
      };

      this.socket.onerror = (error) => {
        console.error(`[${this.playerName}] WebSocket error`);
        reject(new Error('WebSocket error'));
      };

      this.socket.onmessage = (event) => {
        this.handleMessage(event.data.toString());
      };
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  setCallbacks(callbacks: HeadlessClientCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  // Lobby operations
  listRooms(): void {
    this.send({ type: 'list_rooms' });
  }

  createRoom(config: Partial<RoomConfig>): void {
    const fullConfig: RoomConfig = {
      name: config.name || `${this.playerName}'s Room`,
      map: config.map || 'dm_arena',
      mode: config.mode || 'deathmatch',
      maxPlayers: config.maxPlayers || 10,
      botCount: config.botCount || 0,
      botDifficulty: config.botDifficulty || 'medium',
      isPrivate: config.isPrivate || false,
      password: config.password,
    };
    this.send({ type: 'create_room', config: fullConfig });
  }

  joinRoom(roomId: string, password?: string): void {
    this.send({
      type: 'join_room',
      roomId,
      playerName: this.playerName,
      password,
    });
  }

  leaveRoom(): void {
    this.send({ type: 'leave_room' });
    this.roomId = null;
  }

  setReady(): void {
    this.send({ type: 'ready' });
  }

  startGame(): void {
    this.send({ type: 'start_game' });
  }

  changeTeam(team: 'T' | 'CT'): void {
    this.send({ type: 'change_team', team } as any);
  }

  // Game operations
  sendInput(forward: number, strafe: number, yaw: number, pitch: number, jump: boolean = false): void {
    this.send({
      type: 'input',
      input: { forward, strafe, yaw, pitch, jump, crouch: false },
      sequence: Date.now(),
    });
  }

  sendFire(): void {
    this.send({ type: 'fire' });
  }

  // Getters
  getPlayerId(): string | null {
    return this.playerId;
  }

  getRoomId(): string | null {
    return this.roomId;
  }

  getTeam(): TeamId | null {
    return this.team;
  }

  getMessageLog(): ServerMessage[] {
    return this.messageLog;
  }

  clearMessageLog(): void {
    this.messageLog = [];
  }

  // Wait for a specific message type
  async waitForMessage(type: string, timeout: number = 5000): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const checkInterval = setInterval(() => {
        const message = this.messageLog.find(m => m.type === type);
        if (message) {
          clearInterval(checkInterval);
          resolve(message);
        } else if (Date.now() - startTime > timeout) {
          clearInterval(checkInterval);
          reject(new Error(`Timeout waiting for message type: ${type}`));
        }
      }, 50);
    });
  }

  private send(message: ClientMessage): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data) as ServerMessage;
      this.messageLog.push(message);
      this.callbacks.onMessage?.(message);
      this.dispatchMessage(message);
    } catch (error) {
      console.error(`[${this.playerName}] Failed to parse message:`, error);
    }
  }

  private dispatchMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'room_list':
        console.log(`[${this.playerName}] Room list: ${message.rooms.length} rooms`);
        this.callbacks.onRoomList?.(message.rooms);
        break;

      case 'room_joined':
        this.playerId = message.playerId;
        this.roomId = message.roomId;
        console.log(`[${this.playerName}] Joined room ${message.roomId} as ${message.playerId}`);
        this.callbacks.onRoomJoined?.(message.roomId, message.playerId, message.room);
        break;

      case 'room_error':
        console.error(`[${this.playerName}] Room error: ${message.error}`);
        break;

      case 'player_joined':
        console.log(`[${this.playerName}] Player joined: ${message.playerName} (${message.playerId})`);
        this.callbacks.onPlayerJoined?.(message.playerId, message.playerName);
        break;

      case 'player_team_changed':
        console.log(`[${this.playerName}] Player ${message.playerId} changed to team ${message.team}`);
        this.callbacks.onPlayerTeamChanged?.(message.playerId, message.team);
        break;

      case 'assigned_team':
        this.team = message.team;
        console.log(`[${this.playerName}] Assigned to team: ${message.team}`);
        break;

      case 'player_ready':
        console.log(`[${this.playerName}] Player ${message.playerId} ready: ${message.ready}`);
        break;

      case 'game_starting':
        console.log(`[${this.playerName}] Game starting in ${message.countdown}...`);
        break;

      case 'phase_change':
        console.log(`[${this.playerName}] Phase: ${message.phase}, Round ${message.roundNumber}`);
        this.callbacks.onPhaseChange?.(message.phase, message.roundNumber, message.tScore, message.ctScore);
        break;

      case 'game_state':
        // Frequent message, don't log
        break;

      case 'kill_event':
        console.log(`[${this.playerName}] Kill: ${message.event.killerName} killed ${message.event.victimName}`);
        break;

      default:
        // Ignore other messages
        break;
    }
  }
}

// Helper function to run tests
export async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
