// Client-side multiplayer state management
// Handles server state, client-side prediction, and interpolation

import { Vector3 } from '../engine/math/Vector3.js';
import { getFileLogger, debugLog } from '../utils/FileLogger.js';
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
  LockstepStartMessage,
  LockstepTickMessage,
  LockstepAction,
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

  // Lockstep interpolation (for smooth movement between ticks)
  targetPosition: Vector3;  // Position received from server
  targetYaw: number;
  targetPitch: number;
  lastUpdateTime: number;
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

  // Lockstep mode
  private lockstepMode: boolean = false;
  private currentTick: number = 0;
  private pendingLockstepInput: PlayerInput | null = null;
  private pendingLockstepActions: LockstepAction[] = [];

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

  // Callback for incoming fire actions (for hit detection)
  private onRemoteFireCallback: ((
    shooterId: string,
    origin: Vec3,
    direction: Vec3,
    weaponType: string
  ) => void) | null = null;

  // Performance metrics
  private ticksReceived: number = 0;
  private lastTickTime: number = 0;
  private tickRate: number = 0;  // Measured ticks per second

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

    // Lockstep reset
    this.lockstepMode = false;
    this.currentTick = 0;
    this.pendingLockstepInput = null;
    this.pendingLockstepActions = [];
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
      const pos = toVector3(data.position);
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
        position: pos.clone(),
        yaw: data.yaw,
        pitch: data.pitch,
        // Lockstep interpolation fields (needed for all modes)
        targetPosition: pos.clone(),
        targetYaw: data.yaw,
        targetPitch: data.pitch,
        lastUpdateTime: Date.now(),
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
      debugLog(`[MP] Reconciliation: drift=${drift.toFixed(2)}, snapping to server position`);
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

  // ============ Lockstep Mode ============

  isLockstepMode(): boolean {
    return this.lockstepMode;
  }

  initializeLockstep(message: LockstepStartMessage): void {
    this.lockstepMode = true;
    this.currentTick = message.tick;
    this.phase = 'live';

    // Each client is authoritative for their own physics - no full simulation needed
    // Just track remote player positions for rendering

    for (const player of message.players) {
      // Track remote players for rendering (skip local player)
      if (player.id !== this.localPlayerId) {
        const spawnPos = toVector3(player.spawnPosition);
        const remoteEntity: RemoteEntity = {
          id: player.id,
          name: player.name,
          team: player.team,
          health: 100,
          armor: 0,
          isAlive: true,
          currentWeapon: 'rifle',
          kills: 0,
          deaths: 0,
          states: [],
          position: spawnPos.clone(),
          yaw: player.spawnYaw,
          pitch: 0,
          // Lockstep interpolation - target is same as current at start
          targetPosition: spawnPos.clone(),
          targetYaw: player.spawnYaw,
          targetPitch: 0,
          lastUpdateTime: Date.now(),
        };
        this.remotePlayers.set(player.id, remoteEntity);
      }
    }

    debugLog(`[MultiplayerState] Lockstep initialized at tick ${message.tick} with ${message.players.length} players`);
  }

  /**
   * Set the local player's input for the current tick.
   * This will be sent to the server and applied when the tick is processed.
   */
  setLockstepInput(input: PlayerInput): void {
    this.pendingLockstepInput = input;
  }

  /**
   * Add an action (fire, reload, etc) to be sent with the next tick's input.
   */
  addLockstepAction(action: LockstepAction): void {
    this.pendingLockstepActions.push(action);
    debugLog(`[MPSTATE] Added action: ${action.type}, pending count: ${this.pendingLockstepActions.length}`);
    getFileLogger().event('action_added', { type: action.type, pending: this.pendingLockstepActions.length });
  }

  /**
   * Get and clear pending lockstep actions.
   * Call this when sending input to include any queued actions.
   */
  popPendingActions(): LockstepAction[] {
    const actions = [...this.pendingLockstepActions];
    if (actions.length > 0) {
      debugLog(`[MPSTATE] Popping ${actions.length} actions: ${actions.map(a => a.type).join(',')}`);
      getFileLogger().event('actions_sent', { count: actions.length, types: actions.map(a => a.type).join(',') });
    }
    this.pendingLockstepActions = [];
    return actions;
  }

  /**
   * Get the current tick's input to send to server.
   */
  getLockstepInputToSend(): { tick: number; input: PlayerInput; actions: LockstepAction[] } | null {
    if (!this.pendingLockstepInput) return null;

    const result = {
      tick: this.currentTick,
      input: this.pendingLockstepInput,
      actions: [...this.pendingLockstepActions],
    };

    // Clear pending actions (they'll be sent with this input)
    this.pendingLockstepActions = [];

    return result;
  }

  /**
   * Process a lockstep tick received from the server.
   * Each client is authoritative for their own position - we just use received positions.
   */
  applyLockstepTick(message: LockstepTickMessage): void {
    if (!this.lockstepMode) return;

    // Update performance metrics
    const now = Date.now();
    this.ticksReceived++;
    if (this.lastTickTime > 0) {
      const elapsed = now - this.lastTickTime;
      // Exponential moving average for tick rate (avoid division by zero)
      if (elapsed > 0) {
        const instantRate = 1000 / elapsed;
        this.tickRate = this.tickRate === 0 ? instantRate : this.tickRate * 0.9 + instantRate * 0.1;
      }
    }
    this.lastTickTime = now;

    // Verify tick sequence
    if (message.tick !== this.currentTick) {
      debugLog(`[MultiplayerState] Tick mismatch: expected ${this.currentTick}, got ${message.tick}`);
      // For now, accept it anyway to avoid desync
      this.currentTick = message.tick;
    }

    // Update remote player positions from received data
    // Each client is authoritative for their own position (no simulation needed)
    for (const playerInput of message.inputs) {
      if (playerInput.playerId === this.localPlayerId) {
        // This is our own position echoed back - we can ignore it
        // since we're authoritative for our own physics
        continue;
      }

      // Update remote player with received position and health
      const remote = this.remotePlayers.get(playerInput.playerId);
      if (remote) {
        // Update target position (current position will interpolate toward this)
        remote.targetPosition = toVector3(playerInput.position);
        remote.targetYaw = playerInput.yaw;
        remote.targetPitch = playerInput.pitch;
        remote.lastUpdateTime = now;
        // Update health and alive status from authoritative client
        remote.health = playerInput.health;
        remote.isAlive = playerInput.isAlive;
      }

      // Process fire actions from this remote player
      if (this.onRemoteFireCallback && playerInput.actions) {
        for (const action of playerInput.actions) {
          if (action.type === 'fire' && action.data) {
            this.onRemoteFireCallback(
              playerInput.playerId,
              action.data.origin,
              action.data.direction,
              action.data.weaponType || 'rifle'
            );
          }
        }
      }
    }

    // Advance tick counter
    this.currentTick++;
  }

  /**
   * Get the current tick number.
   */
  getCurrentTick(): number {
    return this.currentTick;
  }

  /**
   * Interpolate remote player positions for smooth rendering.
   * Call this every frame before rendering.
   * @param deltaTime Time since last frame in seconds
   * @param lerpSpeed Interpolation speed (higher = faster catch-up, default 15)
   */
  interpolateLockstepPositions(deltaTime: number, lerpSpeed: number = 15): void {
    if (!this.lockstepMode) return;

    const t = Math.min(1, deltaTime * lerpSpeed);

    for (const remote of this.remotePlayers.values()) {
      // Smoothly interpolate current position toward target
      remote.position = Vector3.lerp(remote.position, remote.targetPosition, t);

      // Interpolate angles
      remote.yaw = this.lerpAngleLockstep(remote.yaw, remote.targetYaw, t);
      remote.pitch = remote.pitch + (remote.targetPitch - remote.pitch) * t;
    }
  }

  private lerpAngleLockstep(a: number, b: number, t: number): number {
    let diff = b - a;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return a + diff * t;
  }

  /**
   * Get the state hash for sync verification.
   * Since each client is authoritative for their own position, this is informational only.
   */
  getLockstepStateHash(): string {
    // Simple hash based on tick and known remote player positions
    const parts: string[] = [`tick${this.currentTick}`];
    for (const [id, player] of this.remotePlayers) {
      parts.push(`${id}:${player.position.x.toFixed(2)},${player.position.z.toFixed(2)}`);
    }
    return parts.join('|');
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

  // ============ Fire Action Callback ============

  /**
   * Set callback for when a remote player fires.
   * The callback should check if the shot hits the local player and apply damage.
   */
  setOnRemoteFireCallback(callback: (
    shooterId: string,
    origin: Vec3,
    direction: Vec3,
    weaponType: string
  ) => void): void {
    this.onRemoteFireCallback = callback;
  }

  // ============ Performance Metrics ============

  /**
   * Get the measured tick rate (ticks per second received from server).
   */
  getTickRate(): number {
    return this.tickRate;
  }

  /**
   * Get total ticks received.
   */
  getTicksReceived(): number {
    return this.ticksReceived;
  }

  /**
   * Get performance metrics for debugging.
   */
  getPerformanceMetrics(): {
    tickRate: number;
    ticksReceived: number;
    currentTick: number;
    remotePlayers: number;
  } {
    return {
      tickRate: this.tickRate,
      ticksReceived: this.ticksReceived,
      currentTick: this.currentTick,
      remotePlayers: this.remotePlayers.size,
    };
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
