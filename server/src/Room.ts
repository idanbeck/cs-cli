// Single game room for CS-CLI multiplayer server

import { WebSocket } from 'ws';
import {
  RoomConfig,
  RoomInfo,
  ClientMessage,
  ServerMessage,
  GamePhase,
  TeamId,
  serializeServerMessage,
} from './protocol.js';
import {
  ConnectedClient,
  ServerConfig,
  ServerGameState,
  ServerPlayerState,
  ServerBotState,
  MapData,
  SpawnPoint,
  createVec3,
  WEAPON_DEFS,
  DEFAULT_ECONOMY_CONFIG,
} from './types.js';
import { GameRunner } from './GameRunner.js';

// Default map data for dm_arena
const DEFAULT_MAP: MapData = {
  id: 'dm_arena',
  name: 'DM Arena',
  spawnPoints: [
    // DM spawns
    { position: createVec3(-48, 0.1, -48), angle: 45 * Math.PI / 180, team: 'DM' },
    { position: createVec3(48, 0.1, -48), angle: 135 * Math.PI / 180, team: 'DM' },
    { position: createVec3(-48, 0.1, 48), angle: -45 * Math.PI / 180, team: 'DM' },
    { position: createVec3(48, 0.1, 48), angle: -135 * Math.PI / 180, team: 'DM' },
    { position: createVec3(-28, 0.1, -28), angle: 45 * Math.PI / 180, team: 'DM' },
    { position: createVec3(28, 0.1, -28), angle: 135 * Math.PI / 180, team: 'DM' },
    { position: createVec3(-28, 0.1, 28), angle: -45 * Math.PI / 180, team: 'DM' },
    { position: createVec3(28, 0.1, 28), angle: -135 * Math.PI / 180, team: 'DM' },
    { position: createVec3(0, 0.1, -35), angle: Math.PI, team: 'DM' },
    { position: createVec3(0, 0.1, 35), angle: 0, team: 'DM' },
    { position: createVec3(-35, 0.1, 0), angle: Math.PI / 2, team: 'DM' },
    { position: createVec3(35, 0.1, 0), angle: -Math.PI / 2, team: 'DM' },
    // T spawns (south)
    { position: createVec3(-20, 0.1, 48), angle: 0, team: 'T' },
    { position: createVec3(0, 0.1, 50), angle: 0, team: 'T' },
    { position: createVec3(20, 0.1, 48), angle: 0, team: 'T' },
    { position: createVec3(-35, 0.1, 42), angle: 0, team: 'T' },
    { position: createVec3(35, 0.1, 42), angle: 0, team: 'T' },
    // CT spawns (north)
    { position: createVec3(-20, 0.1, -48), angle: Math.PI, team: 'CT' },
    { position: createVec3(0, 0.1, -50), angle: Math.PI, team: 'CT' },
    { position: createVec3(20, 0.1, -48), angle: Math.PI, team: 'CT' },
    { position: createVec3(-35, 0.1, -42), angle: Math.PI, team: 'CT' },
    { position: createVec3(35, 0.1, -42), angle: Math.PI, team: 'CT' },
  ],
  colliders: [
    // Outer walls
    { min: createVec3(-60, 0, -59), max: createVec3(60, 12, -57) },
    { min: createVec3(-60, 0, 57), max: createVec3(60, 12, 59) },
    { min: createVec3(57, 0, -58), max: createVec3(59, 12, 58) },
    { min: createVec3(-59, 0, -58), max: createVec3(-57, 12, 58) },
    // Central pillar
    { min: createVec3(-2.5, 0, -2.5), max: createVec3(2.5, 8, 2.5) },
    // Buildings
    { min: createVec3(-41, 0, -40), max: createVec3(-29, 6, -30) },
    { min: createVec3(29, 0, -41), max: createVec3(40, 6, -29) },
    { min: createVec3(-40, 0, 29), max: createVec3(-30, 6, 41) },
    { min: createVec3(29, 0, 29), max: createVec3(41, 6, 41) },
  ],
  bounds: {
    min: createVec3(-60, 0, -60),
    max: createVec3(60, 20, 60),
  },
};

// Bot names
const BOT_NAMES = [
  'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo',
  'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet',
];

export class Room {
  public id: string;
  public config: RoomConfig;
  public hostId: string;
  public lastActivity: number;

  private clients: Map<string, ConnectedClient> = new Map();
  private gameRunner: GameRunner | null = null;
  private serverConfig: ServerConfig;
  private mapData: MapData;

  // Team assignments
  private teamAssignments: Map<string, TeamId> = new Map();

  constructor(
    id: string,
    config: RoomConfig,
    hostId: string,
    serverConfig: ServerConfig
  ) {
    this.id = id;
    this.config = config;
    this.hostId = hostId;
    this.serverConfig = serverConfig;
    this.lastActivity = Date.now();
    this.mapData = DEFAULT_MAP;
  }

  // ============ Player Management ============

  addPlayer(clientId: string, client: ConnectedClient): void {
    this.clients.set(clientId, client);
    this.lastActivity = Date.now();

    // Assign team
    const team = this.assignTeam(clientId);
    this.teamAssignments.set(clientId, team);

    // Send team assignment
    this.sendToClient(clientId, {
      type: 'assigned_team',
      team,
    });

    // If game is running, spawn the player
    if (this.gameRunner) {
      this.gameRunner.addPlayer(clientId, client.name || 'Player', team);
    }
  }

  removePlayer(clientId: string): void {
    this.clients.delete(clientId);
    this.teamAssignments.delete(clientId);
    this.lastActivity = Date.now();

    if (this.gameRunner) {
      this.gameRunner.removePlayer(clientId);
    }

    // Transfer host if needed
    if (clientId === this.hostId && this.clients.size > 0) {
      this.hostId = this.clients.keys().next().value!;
      console.log(`Host transferred to ${this.hostId}`);
    }
  }

  getPlayerCount(): number {
    return this.clients.size;
  }

  // ============ Team Management ============

  private assignTeam(clientId: string): TeamId {
    // Count current teams
    let tCount = 0;
    let ctCount = 0;

    for (const team of this.teamAssignments.values()) {
      if (team === 'T') tCount++;
      else if (team === 'CT') ctCount++;
    }

    // Assign to smaller team, or random if equal
    if (tCount < ctCount) return 'T';
    if (ctCount < tCount) return 'CT';
    return Math.random() < 0.5 ? 'T' : 'CT';
  }

  // ============ Game Control ============

  startGame(): void {
    if (this.gameRunner) {
      this.gameRunner.stop();
    }

    // Create game state
    const gameState = this.createInitialGameState();

    // Create game runner
    this.gameRunner = new GameRunner(
      gameState,
      this.mapData,
      this.config,
      this.serverConfig,
      (msg) => this.broadcast(msg),
      (clientId, msg) => this.sendToClient(clientId, msg)
    );

    // Add all connected players
    for (const [clientId, client] of this.clients) {
      const team = this.teamAssignments.get(clientId) || 'T';
      this.gameRunner.addPlayer(clientId, client.name || 'Player', team);
    }

    // Add bots
    for (let i = 0; i < this.config.botCount; i++) {
      const botName = BOT_NAMES[i % BOT_NAMES.length];
      const team = i % 2 === 0 ? 'T' : 'CT';
      this.gameRunner.addBot(botName, team, this.config.botDifficulty);
    }

    // Start the game
    this.gameRunner.start();

    // Notify players
    this.broadcast({
      type: 'phase_change',
      phase: 'warmup',
      roundNumber: 0,
      tScore: 0,
      ctScore: 0,
    });

    console.log(`Game started in room ${this.id}`);
  }

  private createInitialGameState(): ServerGameState {
    return {
      phase: 'pre_match',
      phaseStartTime: Date.now(),
      roundNumber: 0,
      tScore: 0,
      ctScore: 0,
      roundWinner: null,
      players: new Map(),
      bots: new Map(),
      droppedWeapons: new Map(),
      tick: 0,
      lastBroadcastTick: 0,
    };
  }

  stop(): void {
    if (this.gameRunner) {
      this.gameRunner.stop();
      this.gameRunner = null;
    }
  }

  // ============ Message Handling ============

  handleMessage(clientId: string, message: ClientMessage): void {
    this.lastActivity = Date.now();

    switch (message.type) {
      case 'ready':
        this.handleReady(clientId);
        break;

      case 'start_game':
        this.handleStartGame(clientId);
        break;

      case 'input':
      case 'fire':
      case 'reload':
      case 'buy_weapon':
      case 'pickup_weapon':
      case 'drop_weapon':
      case 'select_weapon':
        // Forward to game runner
        if (this.gameRunner) {
          this.gameRunner.handleInput(clientId, message);
        }
        break;

      case 'chat':
        this.handleChat(clientId, message.message, message.teamOnly);
        break;

      default:
        break;
    }
  }

  private handleReady(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    client.isReady = !client.isReady;

    this.broadcast({
      type: 'player_ready',
      playerId: clientId,
      ready: client.isReady,
    });
  }

  private handleStartGame(clientId: string): void {
    // Only host can start
    if (clientId !== this.hostId) return;

    // Check if all players are ready (or just the host for now)
    this.startGame();
  }

  private handleChat(
    clientId: string,
    message: string,
    teamOnly: boolean
  ): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    const chatMessage: ServerMessage = {
      type: 'chat_received',
      senderId: clientId,
      senderName: client.name || 'Unknown',
      message,
      teamOnly,
    };

    if (teamOnly) {
      // Only send to same team
      const senderTeam = this.teamAssignments.get(clientId);
      for (const [id, _] of this.clients) {
        if (this.teamAssignments.get(id) === senderTeam) {
          this.sendToClient(id, chatMessage);
        }
      }
    } else {
      this.broadcast(chatMessage);
    }
  }

  // ============ Communication ============

  broadcast(message: ServerMessage): void {
    const data = serializeServerMessage(message);
    for (const client of this.clients.values()) {
      if (client.socket.readyState === WebSocket.OPEN) {
        try {
          client.socket.send(data);
        } catch (e) {
          // Ignore send errors
        }
      }
    }
  }

  broadcastExcept(excludeId: string, message: ServerMessage): void {
    const data = serializeServerMessage(message);
    for (const [id, client] of this.clients) {
      if (id !== excludeId && client.socket.readyState === WebSocket.OPEN) {
        try {
          client.socket.send(data);
        } catch (e) {
          // Ignore send errors
        }
      }
    }
  }

  sendToClient(clientId: string, message: ServerMessage): void {
    const client = this.clients.get(clientId);
    if (!client || client.socket.readyState !== WebSocket.OPEN) return;

    try {
      client.socket.send(serializeServerMessage(message));
    } catch (e) {
      // Ignore send errors
    }
  }

  // ============ Info ============

  getInfo(): RoomInfo {
    return {
      id: this.id,
      name: this.config.name,
      map: this.config.map,
      mode: this.config.mode,
      playerCount: this.clients.size,
      maxPlayers: this.config.maxPlayers,
      botCount: this.config.botCount,
      isPrivate: this.config.isPrivate,
      phase: this.gameRunner?.getPhase() || 'pre_match',
    };
  }
}
