// WebSocket client for CS-CLI multiplayer
// Handles connection to game server, lobby operations, and in-game networking

import WebSocket, { CloseEvent, ErrorEvent, MessageEvent, RawData } from 'ws';
import { isVoiceFrame } from '../voice/types.js';
import {
  ClientMessage,
  ServerMessage,
  RoomConfig,
  RoomInfo,
  PlayerInput,
  GameStateSnapshot,
  KillEvent,
  HitEvent,
  FireEvent,
  TeamId,
  GamePhase,
  Vec3,
} from '../shared/types/Protocol.js';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'in_lobby' | 'in_game';

export interface GameClientConfig {
  serverUrl: string;
  reconnectAttempts: number;
  reconnectDelay: number;
  inputSendRate: number;  // Hz for input updates
}

export const DEFAULT_CLIENT_CONFIG: GameClientConfig = {
  serverUrl: 'ws://localhost:8080',
  reconnectAttempts: 3,
  reconnectDelay: 2000,
  inputSendRate: 60,
};

export interface GameClientCallbacks {
  // Connection events
  onConnect?: () => void;
  onDisconnect?: (reason: string) => void;
  onError?: (error: string) => void;

  // Lobby events
  onRoomList?: (rooms: RoomInfo[]) => void;
  onRoomJoined?: (roomId: string, playerId: string, room: RoomInfo) => void;
  onRoomError?: (error: string) => void;
  onPlayerJoined?: (playerId: string, playerName: string) => void;
  onPlayerLeft?: (playerId: string, playerName: string) => void;
  onPlayerReady?: (playerId: string, ready: boolean) => void;
  onPlayerTeamChanged?: (playerId: string, team: TeamId) => void;
  onGameStarting?: (countdown: number) => void;
  onAssignedTeam?: (team: TeamId) => void;

  // Game state events
  onGameState?: (state: GameStateSnapshot) => void;
  onPhaseChange?: (phase: GamePhase, roundNumber: number, tScore: number, ctScore: number) => void;

  // Combat events
  onFireEvent?: (event: FireEvent) => void;
  onHitEvent?: (event: HitEvent) => void;
  onKillEvent?: (event: KillEvent) => void;

  // Entity events
  onSpawnEvent?: (entityId: string, entityType: 'player' | 'bot', position: Vec3, team: TeamId) => void;
  onWeaponDropped?: (weaponId: string, weaponType: string, position: Vec3) => void;
  onWeaponPickedUp?: (weaponId: string, playerId: string) => void;

  // Chat
  onChatReceived?: (senderId: string, senderName: string, message: string, teamOnly: boolean) => void;

  // Input acknowledgement (for client-side prediction reconciliation)
  onInputAck?: (sequence: number, position: Vec3) => void;

  // Voice (binary data)
  onVoiceData?: (data: Uint8Array) => void;
}

export class GameClient {
  private socket: WebSocket | null = null;
  private config: GameClientConfig;
  private callbacks: GameClientCallbacks = {};
  private state: ConnectionState = 'disconnected';

  // Client info
  private playerId: string | null = null;
  private playerName: string = 'Player';
  private currentRoomId: string | null = null;

  // Input sequencing for client-side prediction
  private inputSequence: number = 0;
  private pendingInputs: Map<number, PlayerInput> = new Map();

  // Reconnection state
  private reconnectAttempt: number = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: Partial<GameClientConfig> = {}) {
    this.config = { ...DEFAULT_CLIENT_CONFIG, ...config };
  }

  // ============ Connection Management ============

  async connect(serverUrl?: string): Promise<void> {
    if (this.socket && this.state !== 'disconnected') {
      throw new Error('Already connected or connecting');
    }

    const url = serverUrl || this.config.serverUrl;
    this.state = 'connecting';

    return new Promise((resolve, reject) => {
      try {
        this.socket = new WebSocket(url);

        this.socket.onopen = () => {
          this.state = 'connected';
          this.reconnectAttempt = 0;
          this.callbacks.onConnect?.();
          resolve();
        };

        this.socket.onclose = (event: CloseEvent) => {
          const reason = event.reason || 'Connection closed';
          this.handleDisconnect(reason);
        };

        this.socket.onerror = (_error: ErrorEvent) => {
          const message = 'WebSocket error';
          this.callbacks.onError?.(message);
          if (this.state === 'connecting') {
            reject(new Error(message));
          }
        };

        this.socket.onmessage = (event: MessageEvent) => {
          this.handleRawMessage(event.data);
        };

      } catch (error: any) {
        this.state = 'disconnected';
        reject(error);
      }
    });
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    this.state = 'disconnected';
    this.playerId = null;
    this.currentRoomId = null;
    this.pendingInputs.clear();
  }

  private handleDisconnect(reason: string): void {
    this.state = 'disconnected';
    this.playerId = null;
    this.currentRoomId = null;
    this.callbacks.onDisconnect?.(reason);

    // Attempt reconnection if configured
    if (this.reconnectAttempt < this.config.reconnectAttempts) {
      this.reconnectAttempt++;
      this.reconnectTimer = setTimeout(() => {
        this.connect().catch(() => {});
      }, this.config.reconnectDelay);
    }
  }

  getState(): ConnectionState {
    return this.state;
  }

  getPlayerId(): string | null {
    return this.playerId;
  }

  getCurrentRoomId(): string | null {
    return this.currentRoomId;
  }

  isConnected(): boolean {
    return this.state !== 'disconnected' && this.state !== 'connecting';
  }

  // ============ Callbacks ============

  setCallbacks(callbacks: GameClientCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  // ============ Lobby Operations ============

  setPlayerName(name: string): void {
    this.playerName = name;
  }

  listRooms(): void {
    this.send({ type: 'list_rooms' });
  }

  createRoom(config: RoomConfig): void {
    this.send({ type: 'create_room', config });
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
    this.currentRoomId = null;
    this.state = 'connected';
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

  // ============ In-Game Operations ============

  sendInput(input: PlayerInput): void {
    const sequence = ++this.inputSequence;
    this.pendingInputs.set(sequence, input);

    this.send({
      type: 'input',
      input,
      sequence,
    });
  }

  sendFire(): void {
    this.send({ type: 'fire' });
  }

  sendReload(): void {
    this.send({ type: 'reload' });
  }

  sendBuyWeapon(weaponName: string): void {
    this.send({ type: 'buy_weapon', weaponName });
  }

  sendPickupWeapon(weaponId: string): void {
    this.send({ type: 'pickup_weapon', weaponId });
  }

  sendDropWeapon(): void {
    this.send({ type: 'drop_weapon' });
  }

  sendSelectWeapon(slot: number): void {
    this.send({ type: 'select_weapon', slot });
  }

  sendChat(message: string, teamOnly: boolean = false): void {
    this.send({ type: 'chat', message, teamOnly });
  }

  // Get pending inputs for reconciliation
  getPendingInputs(): Map<number, PlayerInput> {
    return this.pendingInputs;
  }

  // Clear acknowledged inputs
  acknowledgeInput(sequence: number): void {
    // Remove all inputs up to and including the acknowledged sequence
    for (const [seq] of this.pendingInputs) {
      if (seq <= sequence) {
        this.pendingInputs.delete(seq);
      }
    }
  }

  // ============ Message Handling ============

  private send(message: ClientMessage): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  /**
   * Send binary data (for voice frames)
   */
  sendBinary(data: Uint8Array): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(data);
    }
  }

  /**
   * Handle raw message data (binary or text)
   */
  private handleRawMessage(data: RawData): void {
    // Check if it's binary data
    if (data instanceof ArrayBuffer) {
      const uint8 = new Uint8Array(data);
      if (isVoiceFrame(uint8)) {
        this.callbacks.onVoiceData?.(uint8);
        return;
      }
    } else if (Buffer.isBuffer(data)) {
      if (data.length > 0 && data[0] === 0x01) {
        const uint8 = new Uint8Array(data.buffer, data.byteOffset, data.length);
        this.callbacks.onVoiceData?.(uint8);
        return;
      }
    } else if (Array.isArray(data)) {
      // ws sometimes sends array of buffers
      const combined = Buffer.concat(data);
      if (combined.length > 0 && combined[0] === 0x01) {
        const uint8 = new Uint8Array(combined.buffer, combined.byteOffset, combined.length);
        this.callbacks.onVoiceData?.(uint8);
        return;
      }
    }

    // Handle as text JSON message
    this.handleMessage(data.toString());
  }

  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data) as ServerMessage;
      this.dispatchMessage(message);
    } catch (error) {
      console.error('Failed to parse server message:', error);
    }
  }

  private dispatchMessage(message: ServerMessage): void {
    switch (message.type) {
      // Lobby messages
      case 'room_list':
        this.callbacks.onRoomList?.(message.rooms);
        break;

      case 'room_joined':
        this.playerId = message.playerId;
        this.currentRoomId = message.roomId;
        this.state = 'in_lobby';
        this.callbacks.onRoomJoined?.(message.roomId, message.playerId, message.room);
        break;

      case 'room_error':
        this.callbacks.onRoomError?.(message.error);
        break;

      case 'player_joined':
        this.callbacks.onPlayerJoined?.(message.playerId, message.playerName);
        break;

      case 'player_left':
        this.callbacks.onPlayerLeft?.(message.playerId, message.playerName);
        break;

      case 'player_ready':
        this.callbacks.onPlayerReady?.(message.playerId, message.ready);
        break;

      case 'player_team_changed':
        this.callbacks.onPlayerTeamChanged?.(message.playerId, message.team);
        break;

      case 'game_starting':
        this.callbacks.onGameStarting?.(message.countdown);
        break;

      case 'assigned_team':
        this.callbacks.onAssignedTeam?.(message.team);
        break;

      // Game state messages
      case 'game_state':
        this.state = 'in_game';
        this.callbacks.onGameState?.(message.state);
        break;

      case 'phase_change':
        this.callbacks.onPhaseChange?.(
          message.phase,
          message.roundNumber,
          message.tScore,
          message.ctScore
        );
        break;

      // Combat messages
      case 'fire_event':
        this.callbacks.onFireEvent?.(message.event);
        break;

      case 'hit_event':
        this.callbacks.onHitEvent?.(message.event);
        break;

      case 'kill_event':
        this.callbacks.onKillEvent?.(message.event);
        break;

      // Entity messages
      case 'spawn_event':
        this.callbacks.onSpawnEvent?.(
          message.entityId,
          message.entityType,
          message.position,
          message.team
        );
        break;

      case 'weapon_dropped':
        this.callbacks.onWeaponDropped?.(
          message.weaponId,
          message.weaponType,
          message.position
        );
        break;

      case 'weapon_picked_up':
        this.callbacks.onWeaponPickedUp?.(message.weaponId, message.playerId);
        break;

      // Chat
      case 'chat_received':
        this.callbacks.onChatReceived?.(
          message.senderId,
          message.senderName,
          message.message,
          message.teamOnly
        );
        break;

      // Input acknowledgement
      case 'input_ack':
        this.acknowledgeInput(message.sequence);
        this.callbacks.onInputAck?.(message.sequence, message.position);
        break;

      default:
        console.warn('Unknown message type:', (message as any).type);
    }
  }
}

// Singleton instance
let gameClientInstance: GameClient | null = null;

export function getGameClient(): GameClient {
  if (!gameClientInstance) {
    gameClientInstance = new GameClient();
  }
  return gameClientInstance;
}

export function resetGameClient(): void {
  if (gameClientInstance) {
    gameClientInstance.disconnect();
  }
  gameClientInstance = new GameClient();
}
