// Client-side multiplayer state management
// Handles server state, client-side prediction, and interpolation

import { Vector3 } from '../engine/math/Vector3.js';
import {
  GameStateSnapshot,
  PlayerSnapshot,
  BotSnapshot,
  DroppedWeaponSnapshot,
  PlayerInput,
  Vec3,
  GamePhase,
  TeamId,
  KillEvent,
  HitEvent,
  FireEvent,
} from '../shared/types/Protocol.js';

// Convert protocol Vec3 to engine Vector3
function toVector3(v: Vec3): Vector3 {
  return new Vector3(v.x, v.y, v.z);
}

// Convert engine Vector3 to protocol Vec3
function toVec3(v: Vector3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

// Pending input for client-side prediction reconciliation
interface PendingInput {
  sequence: number;
  input: PlayerInput;
  position: Vector3;  // Position after applying this input locally
  timestamp: number;
}

// Interpolation buffer entry
interface InterpolationState {
  timestamp: number;
  position: Vector3;
  yaw: number;
  pitch: number;
}

// Remote entity state for interpolation
interface RemoteEntity {
  id: string;
  name: string;
  team: TeamId;
  health: number;
  armor: number;
  isAlive: boolean;
  currentWeapon: string;
  kills: number;
  deaths: number;

  // Interpolation buffer (last N states)
  states: InterpolationState[];

  // Current interpolated state
  position: Vector3;
  yaw: number;
  pitch: number;
}

// Events queued from server
interface QueuedEvent {
  type: 'fire' | 'hit' | 'kill';
  event: FireEvent | HitEvent | KillEvent;
  timestamp: number;
}

export class MultiplayerState {
  // Are we in multiplayer mode?
  private active: boolean = false;

  // Local player ID (assigned by server)
  private localPlayerId: string | null = null;

  // Server state
  private serverTick: number = 0;
  private serverTimestamp: number = 0;
  private phase: GamePhase = 'warmup';
  private roundTime: number = 0;
  private freezeTime: number = 0;
  private tScore: number = 0;
  private ctScore: number = 0;
  private roundNumber: number = 0;

  // Remote entities (other players and bots)
  private remotePlayers: Map<string, RemoteEntity> = new Map();
  private remoteBots: Map<string, RemoteEntity> = new Map();

  // Dropped weapons from server
  private droppedWeapons: DroppedWeaponSnapshot[] = [];

  // Client-side prediction
  private pendingInputs: PendingInput[] = [];
  private lastAckedSequence: number = 0;
  private inputSequence: number = 0;

  // Interpolation settings
  private interpolationDelay: number = 100; // ms - render 100ms behind server
  private maxInterpolationStates: number = 10;

  // Event queue
  private eventQueue: QueuedEvent[] = [];

  // Local player authoritative position from server (for reconciliation)
  private serverPosition: Vector3 | null = null;

  constructor() {}

  // ============ Lifecycle ============

  activate(localPlayerId: string): void {
    this.active = true;
    this.localPlayerId = localPlayerId;
    this.reset();
  }

  deactivate(): void {
    this.active = false;
    this.localPlayerId = null;
    this.reset();
  }

  isActive(): boolean {
    return this.active;
  }

  getLocalPlayerId(): string | null {
    return this.localPlayerId;
  }

  private reset(): void {
    this.serverTick = 0;
    this.serverTimestamp = 0;
    this.phase = 'warmup';
    this.roundTime = 0;
    this.freezeTime = 0;
    this.tScore = 0;
    this.ctScore = 0;
    this.roundNumber = 0;
    this.remotePlayers.clear();
    this.remoteBots.clear();
    this.droppedWeapons = [];
    this.pendingInputs = [];
    this.lastAckedSequence = 0;
    this.inputSequence = 0;
    this.eventQueue = [];
    this.serverPosition = null;
  }

  // ============ Server State Updates ============

  applyServerState(state: GameStateSnapshot): void {
    if (!this.active) return;

    this.serverTick = state.tick;
    this.serverTimestamp = state.timestamp;
    this.phase = state.phase;
    this.roundTime = state.roundTime;
    this.freezeTime = state.freezeTime;
    this.tScore = state.tScore;
    this.ctScore = state.ctScore;
    this.roundNumber = state.roundNumber;

    // Update remote players
    const seenPlayers = new Set<string>();
    for (const playerData of state.players) {
      seenPlayers.add(playerData.id);

      // Skip local player - handled separately for prediction
      if (playerData.id === this.localPlayerId) {
        // Update server position for reconciliation
        this.serverPosition = toVector3(playerData.position);
        continue;
      }

      this.updateRemoteEntity(this.remotePlayers, playerData, state.timestamp);
    }

    // Remove players no longer in state
    for (const id of this.remotePlayers.keys()) {
      if (!seenPlayers.has(id)) {
        this.remotePlayers.delete(id);
      }
    }

    // Update remote bots
    const seenBots = new Set<string>();
    for (const botData of state.bots) {
      seenBots.add(botData.id);
      this.updateRemoteEntity(this.remoteBots, botData, state.timestamp);
    }

    // Remove bots no longer in state
    for (const id of this.remoteBots.keys()) {
      if (!seenBots.has(id)) {
        this.remoteBots.delete(id);
      }
    }

    // Update dropped weapons
    this.droppedWeapons = state.droppedWeapons;
  }

  private updateRemoteEntity(
    map: Map<string, RemoteEntity>,
    data: PlayerSnapshot | BotSnapshot,
    timestamp: number
  ): void {
    let entity = map.get(data.id);

    if (!entity) {
      // New entity
      entity = {
        id: data.id,
        name: data.name,
        team: data.team,
        health: data.health,
        armor: data.armor,
        isAlive: data.isAlive,
        currentWeapon: data.currentWeapon,
        kills: data.kills,
        deaths: data.deaths,
        states: [],
        position: toVector3(data.position),
        yaw: data.yaw,
        pitch: data.pitch,
      };
      map.set(data.id, entity);
    }

    // Update non-interpolated data
    entity.name = data.name;
    entity.team = data.team;
    entity.health = data.health;
    entity.armor = data.armor;
    entity.isAlive = data.isAlive;
    entity.currentWeapon = data.currentWeapon;
    entity.kills = data.kills;
    entity.deaths = data.deaths;

    // Add to interpolation buffer
    entity.states.push({
      timestamp,
      position: toVector3(data.position),
      yaw: data.yaw,
      pitch: data.pitch,
    });

    // Trim old states
    while (entity.states.length > this.maxInterpolationStates) {
      entity.states.shift();
    }
  }

  // ============ Client-Side Prediction ============

  getNextInputSequence(): number {
    return ++this.inputSequence;
  }

  recordPendingInput(sequence: number, input: PlayerInput, positionAfter: Vector3): void {
    this.pendingInputs.push({
      sequence,
      input,
      position: positionAfter.clone(),
      timestamp: Date.now(),
    });

    // Limit pending inputs (shouldn't grow too large if server is responding)
    while (this.pendingInputs.length > 60) {
      this.pendingInputs.shift();
    }
  }

  acknowledgeInput(sequence: number, serverPosition: Vec3): Vector3 | null {
    this.lastAckedSequence = sequence;
    this.serverPosition = toVector3(serverPosition);

    // Remove acknowledged inputs
    this.pendingInputs = this.pendingInputs.filter(p => p.sequence > sequence);

    // Check if reconciliation is needed
    // Return the corrected position if there's drift
    return this.reconcile();
  }

  private reconcile(): Vector3 | null {
    if (!this.serverPosition || this.pendingInputs.length === 0) {
      return this.serverPosition;
    }

    // Server position is authoritative for the acked sequence
    // Re-apply all pending (unacked) inputs on top of server position
    let reconciledPosition = this.serverPosition.clone();

    // For simplicity, we'll just return the server position
    // A full implementation would re-simulate each pending input
    // This is acceptable for now since server updates are frequent

    // Check drift
    const lastPending = this.pendingInputs[this.pendingInputs.length - 1];
    const drift = Vector3.distance(reconciledPosition, lastPending.position);

    // If drift is significant, snap to server position
    if (drift > 1.0) {
      console.log(`[MP] Reconciliation: drift=${drift.toFixed(2)}, snapping to server position`);
      return reconciledPosition;
    }

    // Small drift, let prediction continue
    return null;
  }

  // ============ Interpolation ============

  updateInterpolation(now: number): void {
    // Render time is behind server time by interpolationDelay
    const renderTime = now - this.interpolationDelay;

    // Interpolate remote players
    for (const entity of this.remotePlayers.values()) {
      this.interpolateEntity(entity, renderTime);
    }

    // Interpolate remote bots
    for (const entity of this.remoteBots.values()) {
      this.interpolateEntity(entity, renderTime);
    }
  }

  private interpolateEntity(entity: RemoteEntity, renderTime: number): void {
    const states = entity.states;
    if (states.length === 0) return;

    // Find the two states to interpolate between
    let before: InterpolationState | null = null;
    let after: InterpolationState | null = null;

    for (let i = 0; i < states.length - 1; i++) {
      if (states[i].timestamp <= renderTime && states[i + 1].timestamp >= renderTime) {
        before = states[i];
        after = states[i + 1];
        break;
      }
    }

    if (before && after) {
      // Interpolate between the two states
      const t = (renderTime - before.timestamp) / (after.timestamp - before.timestamp);

      entity.position = Vector3.lerp(before.position, after.position, t);
      entity.yaw = this.lerpAngle(before.yaw, after.yaw, t);
      entity.pitch = this.lerpAngle(before.pitch, after.pitch, t);
    } else if (states.length > 0) {
      // No interpolation possible, use latest state
      const latest = states[states.length - 1];
      entity.position = latest.position.clone();
      entity.yaw = latest.yaw;
      entity.pitch = latest.pitch;
    }
  }

  private lerpAngle(a: number, b: number, t: number): number {
    // Handle angle wrapping
    let diff = b - a;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return a + diff * t;
  }

  // ============ Events ============

  queueFireEvent(event: FireEvent): void {
    this.eventQueue.push({ type: 'fire', event, timestamp: Date.now() });
  }

  queueHitEvent(event: HitEvent): void {
    this.eventQueue.push({ type: 'hit', event, timestamp: Date.now() });
  }

  queueKillEvent(event: KillEvent): void {
    this.eventQueue.push({ type: 'kill', event, timestamp: Date.now() });
  }

  popEvents(): QueuedEvent[] {
    const events = this.eventQueue;
    this.eventQueue = [];
    return events;
  }

  // ============ Getters ============

  getPhase(): GamePhase {
    return this.phase;
  }

  getRoundTime(): number {
    return this.roundTime;
  }

  getFreezeTime(): number {
    return this.freezeTime;
  }

  getScores(): { t: number; ct: number; round: number } {
    return { t: this.tScore, ct: this.ctScore, round: this.roundNumber };
  }

  getRemotePlayers(): RemoteEntity[] {
    return Array.from(this.remotePlayers.values());
  }

  getRemoteBots(): RemoteEntity[] {
    return Array.from(this.remoteBots.values());
  }

  getAllRemoteEntities(): RemoteEntity[] {
    return [...this.getRemotePlayers(), ...this.getRemoteBots()];
  }

  getDroppedWeapons(): DroppedWeaponSnapshot[] {
    return this.droppedWeapons;
  }

  getServerPosition(): Vector3 | null {
    return this.serverPosition;
  }

  // Get local player data from last server state (for HUD, etc)
  getLocalPlayerFromServer(): PlayerSnapshot | null {
    // This would need to be stored from applyServerState
    // For now, return null - local player uses its own state
    return null;
  }

  // Get remote entities in a Bot-compatible format for rendering
  // Returns objects that can be passed to renderer.setBots()
  getBotCompatibleEntities(): Array<{
    position: Vector3;
    config: { eyeHeight: number };
    isAlive: boolean;
    health: number;
    state: string;
    name: string;
    team: TeamId;
    yaw: number;
    pitch: number;
  }> {
    const entities: Array<{
      position: Vector3;
      config: { eyeHeight: number };
      isAlive: boolean;
      health: number;
      state: string;
      name: string;
      team: TeamId;
      yaw: number;
      pitch: number;
    }> = [];

    // Add remote players
    for (const player of this.remotePlayers.values()) {
      entities.push({
        position: player.position,
        config: { eyeHeight: 1.7 },
        isAlive: player.isAlive,
        health: player.health,
        state: 'idle',
        name: player.name,
        team: player.team,
        yaw: player.yaw,
        pitch: player.pitch,
      });
    }

    // Add remote bots
    for (const bot of this.remoteBots.values()) {
      entities.push({
        position: bot.position,
        config: { eyeHeight: 1.7 },
        isAlive: bot.isAlive,
        health: bot.health,
        state: 'idle',
        name: bot.name,
        team: bot.team,
        yaw: bot.yaw,
        pitch: bot.pitch,
      });
    }

    return entities;
  }

  isPlayerFrozen(): boolean {
    return this.phase === 'freeze' || this.phase === 'round_end';
  }

  canBuy(): boolean {
    return this.phase === 'freeze' || this.phase === 'warmup';
  }
}

// Singleton
let multiplayerStateInstance: MultiplayerState | null = null;

export function getMultiplayerState(): MultiplayerState {
  if (!multiplayerStateInstance) {
    multiplayerStateInstance = new MultiplayerState();
  }
  return multiplayerStateInstance;
}

export function resetMultiplayerState(): void {
  if (multiplayerStateInstance) {
    multiplayerStateInstance.deactivate();
  }
  multiplayerStateInstance = new MultiplayerState();
}
