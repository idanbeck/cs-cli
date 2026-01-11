/**
 * LockstepRunner - Server-side input relay for deterministic lockstep multiplayer
 *
 * Unlike GameRunner which runs authoritative physics, LockstepRunner only:
 * 1. Collects inputs from all clients for each tick
 * 2. Broadcasts all inputs when the tick is ready
 * 3. Tracks player connections and disconnections
 *
 * All physics simulation happens on clients.
 */

import {
  RoomConfig,
  ServerMessage,
  TeamId,
  Vec3,
  PlayerInput,
  LockstepTickMessage,
  LockstepStartMessage,
  LockstepAction,
  GamePhase,
} from './protocol.js';
import {
  ServerConfig,
  MapData,
  SpawnPoint,
  createVec3,
} from './types.js';

// Timing constants
const TICK_RATE = 60;
const TICK_MS = 1000 / TICK_RATE;
const INPUT_TIMEOUT_MS = TICK_MS * 2; // Wait up to 2 ticks for stragglers

interface LockstepPlayer {
  id: string;
  name: string;
  team: TeamId;
  spawnPosition: Vec3;
  spawnYaw: number;
}

interface TickInputs {
  tick: number;
  inputs: Map<string, {
    input: PlayerInput;
    actions: LockstepAction[];
    position: Vec3;
    yaw: number;
    pitch: number;
    health: number;
    isAlive: boolean;
  }>;
  receivedAt: number;
}

export class LockstepRunner {
  private players: Map<string, LockstepPlayer> = new Map();
  private currentTick = 0;
  private pendingInputs: Map<number, TickInputs> = new Map();
  private usedSpawns: Set<number> = new Set();

  // Timing
  private tickCheckInterval: ReturnType<typeof setInterval> | null = null;
  private lastTickTime = 0;
  private isRunning = false;

  // Callbacks
  private broadcast: (msg: ServerMessage) => void;
  private sendToClient: (clientId: string, msg: ServerMessage) => void;

  // Config
  private mapData: MapData;
  private roomConfig: RoomConfig;
  private serverConfig: ServerConfig;

  // Sync tracking
  private syncHashes: Map<string, Map<number, string>> = new Map(); // playerId -> (tick -> hash)

  constructor(
    mapData: MapData,
    roomConfig: RoomConfig,
    serverConfig: ServerConfig,
    broadcast: (msg: ServerMessage) => void,
    sendToClient: (clientId: string, msg: ServerMessage) => void
  ) {
    this.mapData = mapData;
    this.roomConfig = roomConfig;
    this.serverConfig = serverConfig;
    this.broadcast = broadcast;
    this.sendToClient = sendToClient;
  }

  // ============ Lifecycle ============

  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    this.currentTick = 0;
    this.lastTickTime = Date.now();

    // Send lockstep start message to all clients
    const startMsg: LockstepStartMessage = {
      type: 'lockstep_start',
      tick: 0,
      players: Array.from(this.players.values()).map(p => ({
        id: p.id,
        name: p.name,
        team: p.team,
        spawnPosition: p.spawnPosition,
        spawnYaw: p.spawnYaw,
      })),
      mapData: {
        bounds: this.mapData.bounds,
        colliders: this.mapData.colliders,
        spawnPoints: this.mapData.spawnPoints.map(sp => ({
          position: sp.position,
          angle: sp.angle,
          team: sp.team,
        })),
      },
    };

    this.broadcast(startMsg);
    console.log(`[LockstepRunner] Started with ${this.players.size} players`);

    // Start tick processing loop
    this.tickCheckInterval = setInterval(() => {
      this.checkAndProcessTick();
    }, TICK_MS / 2);
  }

  stop(): void {
    if (this.tickCheckInterval) {
      clearInterval(this.tickCheckInterval);
      this.tickCheckInterval = null;
    }
    this.isRunning = false;
    console.log('[LockstepRunner] Stopped');
  }

  getPhase(): GamePhase {
    return this.isRunning ? 'live' : 'pre_match';
  }

  // ============ Player Management ============

  addPlayer(clientId: string, name: string, team: TeamId): void {
    const spawn = this.getSpawnPoint(team);
    const player: LockstepPlayer = {
      id: clientId,
      name,
      team,
      spawnPosition: { ...spawn.position, y: spawn.position.y + 1.7 }, // Add eye height
      spawnYaw: spawn.angle,
    };
    this.players.set(clientId, player);
    console.log(`[LockstepRunner] Added player ${name} (${clientId}) to team ${team} at spawn (${spawn.position.x.toFixed(1)}, ${spawn.position.y.toFixed(1)}, ${spawn.position.z.toFixed(1)})`);

    // If game is already running, send current state to new player
    if (this.isRunning) {
      this.sendToClient(clientId, {
        type: 'lockstep_start',
        tick: this.currentTick,
        players: Array.from(this.players.values()).map(p => ({
          id: p.id,
          name: p.name,
          team: p.team,
          spawnPosition: p.spawnPosition,
          spawnYaw: p.spawnYaw,
        })),
        mapData: {
          bounds: this.mapData.bounds,
          colliders: this.mapData.colliders,
          spawnPoints: this.mapData.spawnPoints.map(sp => ({
            position: sp.position,
            angle: sp.angle,
            team: sp.team,
          })),
        },
      });
    }
  }

  removePlayer(clientId: string): void {
    this.players.delete(clientId);
    this.syncHashes.delete(clientId);
    console.log(`[LockstepRunner] Removed player ${clientId}`);
  }

  // ============ Input Handling ============

  handleLockstepInput(
    clientId: string,
    tick: number,
    input: PlayerInput,
    actions: LockstepAction[],
    position: Vec3,
    yaw: number,
    pitch: number,
    health: number,
    isAlive: boolean
  ): void {
    if (!this.isRunning) return;

    // Store input for the specified tick
    if (!this.pendingInputs.has(tick)) {
      this.pendingInputs.set(tick, {
        tick,
        inputs: new Map(),
        receivedAt: Date.now(),
      });
    }

    const tickInputs = this.pendingInputs.get(tick)!;
    tickInputs.inputs.set(clientId, { input, actions, position, yaw, pitch, health, isAlive });

    // Log if actions are received
    if (actions.length > 0) {
      console.log(`[LockstepRunner] Received ${actions.length} actions from ${clientId.slice(0, 8)} at tick ${tick}: ${JSON.stringify(actions)}`);
    }
  }

  handleSyncCheck(clientId: string, tick: number, hash: string): void {
    // Store hash for sync verification
    if (!this.syncHashes.has(clientId)) {
      this.syncHashes.set(clientId, new Map());
    }
    this.syncHashes.get(clientId)!.set(tick, hash);

    // Check if all players agree on this tick
    this.verifySyncForTick(tick);
  }

  // ============ Tick Processing ============

  private checkAndProcessTick(): void {
    if (!this.isRunning) return;

    const now = Date.now();
    const timeSinceLastTick = now - this.lastTickTime;

    // Get inputs for current tick
    const tickInputs = this.pendingInputs.get(this.currentTick);
    const inputCount = tickInputs ? tickInputs.inputs.size : 0;
    const expectedInputs = this.players.size;

    // Advance tick if:
    // 1. We have all inputs, OR
    // 2. We've waited long enough (don't stall forever)
    const haveAllInputs = inputCount >= expectedInputs;
    const timeoutReached = timeSinceLastTick >= INPUT_TIMEOUT_MS;

    if (haveAllInputs || timeoutReached) {
      this.processTick();
      this.lastTickTime = now;
    }
  }

  private processTick(): void {
    // Collect all inputs for current tick
    const tickInputs = this.pendingInputs.get(this.currentTick);
    const inputs: Array<{
      playerId: string;
      input: PlayerInput;
      actions: LockstepAction[];
      position: Vec3;
      yaw: number;
      pitch: number;
      health: number;
      isAlive: boolean;
    }> = [];

    if (tickInputs) {
      for (const [playerId, data] of tickInputs.inputs) {
        inputs.push({
          playerId,
          input: data.input,
          actions: data.actions,
          position: data.position,
          yaw: data.yaw,
          pitch: data.pitch,
          health: data.health,
          isAlive: data.isAlive,
        });
      }
    }

    // Broadcast tick to all clients
    const tickMsg: LockstepTickMessage = {
      type: 'lockstep_tick',
      tick: this.currentTick,
      inputs,
    };

    // Log if any actions are being broadcast
    const totalActions = inputs.reduce((sum, i) => sum + i.actions.length, 0);
    if (totalActions > 0) {
      const actionsWithData = inputs.filter(i => i.actions.length > 0).map(i => ({
        player: i.playerId.slice(0, 8),
        actions: i.actions.map(a => ({ type: a.type, hasData: !!a.data })),
      }));
      console.log(`[LockstepRunner] Broadcasting tick ${this.currentTick} with ${totalActions} actions: ${JSON.stringify(actionsWithData)}`);
    }

    this.broadcast(tickMsg);

    // Cleanup old tick data
    this.pendingInputs.delete(this.currentTick - 10);

    // Advance tick
    this.currentTick++;
  }

  private verifySyncForTick(tick: number): void {
    // Collect all hashes for this tick
    const hashes = new Map<string, string[]>(); // hash -> playerIds

    for (const [playerId, playerHashes] of this.syncHashes) {
      const hash = playerHashes.get(tick);
      if (hash) {
        if (!hashes.has(hash)) {
          hashes.set(hash, []);
        }
        hashes.get(hash)!.push(playerId);
      }
    }

    // Check for desync
    if (hashes.size > 1) {
      // Multiple different hashes - desync detected!
      console.error(`[LockstepRunner] DESYNC at tick ${tick}!`);

      // Find the majority hash (or first if tie)
      let majorityHash = '';
      let majorityCount = 0;
      for (const [hash, players] of hashes) {
        if (players.length > majorityCount) {
          majorityHash = hash;
          majorityCount = players.length;
        }
      }

      // Notify desynced players
      for (const [hash, players] of hashes) {
        if (hash !== majorityHash) {
          for (const playerId of players) {
            console.error(`[LockstepRunner] Player ${playerId} desynced: expected ${majorityHash}, got ${hash}`);
            this.sendToClient(playerId, {
              type: 'lockstep_desync',
              tick,
              expectedHash: majorityHash,
              receivedHash: hash,
              playerId,
            });
          }
        }
      }
    }

    // Cleanup old sync data
    for (const playerHashes of this.syncHashes.values()) {
      playerHashes.delete(tick - 100);
    }
  }

  // ============ Utility ============

  private getSpawnPoint(team: TeamId): SpawnPoint {
    // Filter spawns by team
    const validSpawns = this.mapData.spawnPoints.filter(
      (s, idx) => !this.usedSpawns.has(idx) && (s.team === team || s.team === 'DM')
    );

    if (validSpawns.length === 0) {
      // All spawns used, reset
      this.usedSpawns.clear();
      return this.mapData.spawnPoints[0];
    }

    // Pick spawn deterministically (by index to ensure consistency)
    const idx = this.usedSpawns.size % validSpawns.length;
    const spawn = validSpawns[idx];
    const originalIdx = this.mapData.spawnPoints.indexOf(spawn);
    this.usedSpawns.add(originalIdx);

    return spawn;
  }
}
