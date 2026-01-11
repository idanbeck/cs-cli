#!/usr/bin/env npx ts-node
/**
 * Deterministic Lockstep Test Harness
 *
 * Tests deterministic lockstep networking with multiple clients.
 * Each client runs the same physics simulation, server only relays inputs.
 *
 * Usage: npx ts-node src/test/lockstepTestHarness.ts [numClients]
 */

import { spawn, ChildProcess } from 'child_process';
import { WebSocket } from 'ws';
import * as path from 'path';

// Test configuration
const SERVER_PORT = 19090;
const NUM_CLIENTS = parseInt(process.argv[2]) || 3;
const TEST_DURATION_TICKS = 300; // Run for 300 ticks (~5 seconds at 60Hz)
const TICK_RATE = 60; // 60 ticks per second
const TICK_MS = 1000 / TICK_RATE;

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

const clientColors = [colors.cyan, colors.magenta, colors.yellow, colors.blue, colors.green];

function log(prefix: string, message: string, color: string = colors.reset) {
  const timestamp = new Date().toISOString().slice(11, 23);
  console.log(`${color}[${timestamp}] [${prefix}] ${message}${colors.reset}`);
}

// =============================================================================
// Deterministic Math (fixed-point style, but using floats carefully)
// =============================================================================

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

function vec3Add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function vec3Scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function vec3Length(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function vec3Normalize(v: Vec3): Vec3 {
  const len = vec3Length(v);
  if (len === 0) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function vec3Equals(a: Vec3, b: Vec3, epsilon: number = 0.0001): boolean {
  return (
    Math.abs(a.x - b.x) < epsilon &&
    Math.abs(a.y - b.y) < epsilon &&
    Math.abs(a.z - b.z) < epsilon
  );
}

// =============================================================================
// Deterministic Physics Simulation
// =============================================================================

const MOVE_SPEED = 8.0; // Units per second
const PLAYER_RADIUS = 0.4;
const GRAVITY = 20.0;
const JUMP_VELOCITY = 8.0;
const GROUND_Y = 1.7; // Eye height

// Simple box arena bounds
const ARENA_MIN = { x: -20, y: 0, z: -20 };
const ARENA_MAX = { x: 20, y: 10, z: 20 };

// Some obstacles in the arena (axis-aligned boxes)
const OBSTACLES: Array<{ min: Vec3; max: Vec3 }> = [
  { min: { x: -5, y: 0, z: -5 }, max: { x: -3, y: 2, z: -3 } },
  { min: { x: 3, y: 0, z: 3 }, max: { x: 5, y: 2, z: 5 } },
  { min: { x: -8, y: 0, z: 5 }, max: { x: -6, y: 1.5, z: 8 } },
  { min: { x: 6, y: 0, z: -8 }, max: { x: 9, y: 1.5, z: -5 } },
];

interface PlayerInput {
  forward: number;  // -1 to 1
  strafe: number;   // -1 to 1
  yaw: number;      // Facing angle
  jump: boolean;
}

interface PlayerState {
  id: string;
  position: Vec3;
  velocity: Vec3;
  yaw: number;
}

/**
 * Deterministic physics simulation - must produce identical results on all clients
 */
class DeterministicSimulation {
  private players: Map<string, PlayerState> = new Map();
  private currentTick = 0;

  constructor() {}

  addPlayer(id: string, spawnPosition: Vec3): void {
    this.players.set(id, {
      id,
      position: { ...spawnPosition },
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 0,
    });
  }

  removePlayer(id: string): void {
    this.players.delete(id);
  }

  getPlayer(id: string): PlayerState | undefined {
    return this.players.get(id);
  }

  getAllPlayers(): PlayerState[] {
    return Array.from(this.players.values());
  }

  getCurrentTick(): number {
    return this.currentTick;
  }

  /**
   * Advance simulation by one tick with given inputs
   * This MUST be deterministic - same inputs = same outputs
   */
  tick(inputs: Map<string, PlayerInput>): void {
    const deltaTime = 1.0 / TICK_RATE;

    // Process players in deterministic order (sorted by ID)
    const sortedIds = Array.from(this.players.keys()).sort();

    for (const playerId of sortedIds) {
      const player = this.players.get(playerId)!;
      const input = inputs.get(playerId);

      if (input) {
        this.processInput(player, input, deltaTime);
      }

      this.applyPhysics(player, deltaTime);
    }

    this.currentTick++;
  }

  private processInput(player: PlayerState, input: PlayerInput, deltaTime: number): void {
    // Update yaw
    player.yaw = input.yaw;

    // Calculate movement direction based on input and yaw
    const cosYaw = Math.cos(player.yaw);
    const sinYaw = Math.sin(player.yaw);

    // Forward/backward movement
    const forwardX = sinYaw * input.forward;
    const forwardZ = cosYaw * input.forward;

    // Strafe movement (perpendicular to forward)
    const strafeX = cosYaw * input.strafe;
    const strafeZ = -sinYaw * input.strafe;

    // Combined movement
    let moveX = forwardX + strafeX;
    let moveZ = forwardZ + strafeZ;

    // Normalize if moving diagonally
    const moveLen = Math.sqrt(moveX * moveX + moveZ * moveZ);
    if (moveLen > 1.0) {
      moveX /= moveLen;
      moveZ /= moveLen;
    }

    // Apply movement with collision detection
    const speed = MOVE_SPEED * deltaTime;
    const newPos = {
      x: player.position.x + moveX * speed,
      y: player.position.y,
      z: player.position.z + moveZ * speed,
    };

    // Collision detection with sliding
    if (!this.checkCollision(newPos)) {
      player.position = newPos;
    } else {
      // Try X-only movement
      const newPosX = { ...player.position, x: newPos.x };
      if (!this.checkCollision(newPosX)) {
        player.position = newPosX;
      } else {
        // Try Z-only movement
        const newPosZ = { ...player.position, z: newPos.z };
        if (!this.checkCollision(newPosZ)) {
          player.position = newPosZ;
        }
      }
    }

    // Jump
    if (input.jump && player.position.y <= GROUND_Y + 0.1) {
      player.velocity.y = JUMP_VELOCITY;
    }
  }

  private applyPhysics(player: PlayerState, deltaTime: number): void {
    // Gravity
    player.velocity.y -= GRAVITY * deltaTime;
    player.position.y += player.velocity.y * deltaTime;

    // Ground collision
    if (player.position.y < GROUND_Y) {
      player.position.y = GROUND_Y;
      player.velocity.y = 0;
    }
  }

  private checkCollision(pos: Vec3): boolean {
    // Check arena bounds
    if (
      pos.x < ARENA_MIN.x + PLAYER_RADIUS ||
      pos.x > ARENA_MAX.x - PLAYER_RADIUS ||
      pos.z < ARENA_MIN.z + PLAYER_RADIUS ||
      pos.z > ARENA_MAX.z - PLAYER_RADIUS
    ) {
      return true;
    }

    // Check obstacles (AABB vs sphere)
    for (const obs of OBSTACLES) {
      const minX = obs.min.x - PLAYER_RADIUS;
      const maxX = obs.max.x + PLAYER_RADIUS;
      const minZ = obs.min.z - PLAYER_RADIUS;
      const maxZ = obs.max.z + PLAYER_RADIUS;
      const maxY = obs.max.y;

      if (
        pos.x >= minX && pos.x <= maxX &&
        pos.z >= minZ && pos.z <= maxZ &&
        (pos.y - GROUND_Y) < maxY
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get a deterministic hash of the current state (for sync verification)
   */
  getStateHash(): string {
    const players = this.getAllPlayers();
    const stateStr = players
      .map(p => `${p.id}:${p.position.x.toFixed(4)},${p.position.y.toFixed(4)},${p.position.z.toFixed(4)}`)
      .join('|');
    return `tick${this.currentTick}:${stateStr}`;
  }
}

// =============================================================================
// Lockstep Protocol Messages
// =============================================================================

interface LockstepInput {
  type: 'lockstep_input';
  playerId: string;
  tick: number;
  input: PlayerInput;
}

interface LockstepTickInputs {
  type: 'lockstep_tick';
  tick: number;
  inputs: Array<{ playerId: string; input: PlayerInput }>;
}

interface LockstepJoin {
  type: 'lockstep_join';
  playerId: string;
}

interface LockstepStart {
  type: 'lockstep_start';
  players: Array<{ id: string; spawnPosition: Vec3 }>;
  startTick: number;
}

interface LockstepSyncCheck {
  type: 'lockstep_sync';
  tick: number;
  hash: string;
}

type LockstepMessage = LockstepInput | LockstepTickInputs | LockstepJoin | LockstepStart | LockstepSyncCheck;

// =============================================================================
// Lockstep Server (Input Relay)
// =============================================================================

class LockstepServer {
  private wss: any = null;
  private clients: Map<string, WebSocket> = new Map();
  private currentTick = 0;
  private tickInputs: Map<number, Map<string, PlayerInput>> = new Map();
  private playerSpawns: Map<string, Vec3> = new Map();
  private gameStarted = false;
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private tickCheckInterval: ReturnType<typeof setInterval> | null = null;
  private lastTickTime = 0;

  async start(port: number): Promise<void> {
    const { WebSocketServer } = await import('ws');

    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ port });

      this.wss.on('connection', (ws: WebSocket) => {
        this.handleConnection(ws);
      });

      this.wss.on('listening', () => {
        log('LockstepServer', `Listening on port ${port}`, colors.green);
        resolve();
      });
    });
  }

  private handleConnection(ws: WebSocket): void {
    let playerId: string | null = null;

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as LockstepMessage;

        if (msg.type === 'lockstep_join') {
          playerId = msg.playerId;
          this.clients.set(playerId, ws);

          // Assign spawn position
          const spawnIndex = this.clients.size - 1;
          const angle = (spawnIndex / NUM_CLIENTS) * Math.PI * 2;
          const spawnPos = {
            x: Math.cos(angle) * 10,
            y: GROUND_Y,
            z: Math.sin(angle) * 10,
          };
          this.playerSpawns.set(playerId, spawnPos);

          log('LockstepServer', `Player joined: ${playerId.slice(0, 8)}, spawn at (${spawnPos.x.toFixed(1)}, ${spawnPos.z.toFixed(1)})`, colors.green);

          // Start game when all clients connected
          if (this.clients.size === NUM_CLIENTS && !this.gameStarted) {
            this.startGame();
          }
        } else if (msg.type === 'lockstep_input' && playerId) {
          this.handleInput(msg);
        } else if (msg.type === 'lockstep_sync' && playerId) {
          // Just log sync checks for debugging
          log('LockstepServer', `Sync check from ${playerId.slice(0, 8)}: tick=${msg.tick}, hash=${msg.hash.slice(0, 30)}...`, colors.gray);
        }
      } catch (err) {
        log('LockstepServer', `Message error: ${err}`, colors.red);
      }
    });

    ws.on('close', () => {
      if (playerId) {
        this.clients.delete(playerId);
        this.playerSpawns.delete(playerId);
        log('LockstepServer', `Player disconnected: ${playerId.slice(0, 8)}`, colors.yellow);
      }
    });
  }

  private startGame(): void {
    this.gameStarted = true;
    this.lastTickTime = Date.now();

    // Send start message to all clients
    const players = Array.from(this.playerSpawns.entries()).map(([id, pos]) => ({
      id,
      spawnPosition: pos,
    }));

    const startMsg: LockstepStart = {
      type: 'lockstep_start',
      players,
      startTick: 0,
    };

    this.broadcast(startMsg);
    log('LockstepServer', `Game started with ${players.length} players`, colors.green);

    // Give clients a moment to receive start message and send first input
    setTimeout(() => {
      this.lastTickTime = Date.now();

      // Check for tick completion more frequently than tick rate
      // This allows us to advance as soon as all inputs are received
      this.tickCheckInterval = setInterval(() => {
        this.checkAndProcessTick();
      }, TICK_MS / 2); // Check twice per tick period
    }, 100);
  }

  private checkAndProcessTick(): void {
    const now = Date.now();
    const timeSinceLastTick = now - this.lastTickTime;

    // Get inputs for current tick
    const inputs = this.tickInputs.get(this.currentTick);
    const inputCount = inputs ? inputs.size : 0;
    const expectedInputs = this.clients.size;

    // Advance tick if:
    // 1. We have all inputs, OR
    // 2. We've waited at least TICK_MS (don't stall forever)
    const haveAllInputs = inputCount >= expectedInputs;
    const timeoutReached = timeSinceLastTick >= TICK_MS;

    if (haveAllInputs || timeoutReached) {
      this.processTick();
      this.lastTickTime = now;
    }
  }

  private handleInput(msg: LockstepInput): void {
    // Store input for the specified tick
    if (!this.tickInputs.has(msg.tick)) {
      this.tickInputs.set(msg.tick, new Map());
    }
    this.tickInputs.get(msg.tick)!.set(msg.playerId, msg.input);
  }

  private processTick(): void {
    // Collect all inputs for current tick
    const inputs = this.tickInputs.get(this.currentTick) || new Map();

    // Create tick message with all inputs
    const tickMsg: LockstepTickInputs = {
      type: 'lockstep_tick',
      tick: this.currentTick,
      inputs: Array.from(inputs.entries()).map(([playerId, input]) => ({
        playerId,
        input,
      })),
    };

    // Broadcast to all clients
    this.broadcast(tickMsg);

    // Cleanup old tick inputs
    this.tickInputs.delete(this.currentTick - 10);

    this.currentTick++;

    // End test after TEST_DURATION_TICKS
    if (this.currentTick >= TEST_DURATION_TICKS) {
      if (this.tickCheckInterval) {
        clearInterval(this.tickCheckInterval);
        this.tickCheckInterval = null;
      }
      log('LockstepServer', `Test completed at tick ${this.currentTick}`, colors.green);
    }
  }

  private broadcast(msg: LockstepMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.clients.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
    }
    if (this.tickCheckInterval) {
      clearInterval(this.tickCheckInterval);
    }
    if (this.wss) {
      this.wss.close();
    }
  }
}

// =============================================================================
// Lockstep Test Client
// =============================================================================

interface ClientStats {
  ticksProcessed: number;
  inputsSent: number;
  inputsReceived: number;
  syncChecks: number;
  syncMismatches: number;
  stateHashes: string[];
}

class LockstepTestClient {
  private ws: WebSocket | null = null;
  private playerId: string;
  private clientIndex: number;
  private simulation: DeterministicSimulation;
  private isConnected = false;
  private gameStarted = false;
  private currentTick = 0;
  private inputInterval: ReturnType<typeof setInterval> | null = null;
  private stats: ClientStats;
  private movementPattern: 'circle' | 'random' | 'straight';
  private startTime = 0;
  private finalStateHash = '';

  constructor(playerId: string, clientIndex: number) {
    this.playerId = playerId;
    this.clientIndex = clientIndex;
    this.simulation = new DeterministicSimulation();
    this.stats = {
      ticksProcessed: 0,
      inputsSent: 0,
      inputsReceived: 0,
      syncChecks: 0,
      syncMismatches: 0,
      stateHashes: [],
    };
    // Each client moves in a predictable pattern
    this.movementPattern = ['circle', 'random', 'straight'][clientIndex % 3] as any;
  }

  private log(message: string) {
    const color = clientColors[this.clientIndex % clientColors.length];
    log(`Client ${this.clientIndex}`, message, color);
  }

  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.log(`Connecting to ${url}...`);

      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this.isConnected = true;
        this.log('Connected');

        // Send join message
        this.send({
          type: 'lockstep_join',
          playerId: this.playerId,
        });

        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (err) => {
        this.log(`WebSocket error: ${err.message}`);
        reject(err);
      });

      this.ws.on('close', () => {
        this.isConnected = false;
        this.log('Disconnected');
      });

      setTimeout(() => reject(new Error('Connection timeout')), 5000);
    });
  }

  private handleMessage(data: Buffer): void {
    try {
      const msg = JSON.parse(data.toString()) as LockstepMessage;

      switch (msg.type) {
        case 'lockstep_start':
          this.handleStart(msg);
          break;
        case 'lockstep_tick':
          this.handleTick(msg);
          break;
      }
    } catch (err) {
      this.log(`Message error: ${err}`);
    }
  }

  private handleStart(msg: LockstepStart): void {
    this.log(`Game starting with ${msg.players.length} players`);

    // Initialize simulation with all players
    for (const player of msg.players) {
      this.simulation.addPlayer(player.id, player.spawnPosition);
    }

    this.gameStarted = true;
    this.startTime = Date.now();
    this.currentTick = msg.startTick;

    // Start sending inputs
    this.startInputLoop();
  }

  private handleTick(msg: LockstepTickInputs): void {
    if (!this.gameStarted) return;

    // Apply all inputs for this tick
    const inputs = new Map<string, PlayerInput>();
    for (const { playerId, input } of msg.inputs) {
      inputs.set(playerId, input);
      this.stats.inputsReceived++;
    }

    // Advance simulation
    this.simulation.tick(inputs);
    this.stats.ticksProcessed++;

    // Periodic sync check
    if (this.stats.ticksProcessed % 50 === 0) {
      const hash = this.simulation.getStateHash();
      this.stats.stateHashes.push(hash);
      this.stats.syncChecks++;

      // Send sync check to server
      this.send({
        type: 'lockstep_sync',
        tick: this.simulation.getCurrentTick(),
        hash,
      });

      // Log position
      const player = this.simulation.getPlayer(this.playerId);
      if (player) {
        this.log(`Tick ${this.simulation.getCurrentTick()}: pos=(${player.position.x.toFixed(2)}, ${player.position.z.toFixed(2)})`);
      }
    }

    // Store final hash
    if (this.stats.ticksProcessed === TEST_DURATION_TICKS) {
      this.finalStateHash = this.simulation.getStateHash();
    }
  }

  private startInputLoop(): void {
    // Send input slightly ahead of server tick
    this.inputInterval = setInterval(() => {
      this.sendInput();
    }, TICK_MS);
  }

  private sendInput(): void {
    if (!this.ws || !this.gameStarted) return;

    const input = this.generateInput();

    this.send({
      type: 'lockstep_input',
      playerId: this.playerId,
      tick: this.currentTick,
      input,
    });

    this.stats.inputsSent++;
    this.currentTick++;
  }

  private generateInput(): PlayerInput {
    const t = (Date.now() - this.startTime) / 1000;

    switch (this.movementPattern) {
      case 'circle': {
        // Move in a circle
        const angle = t * 0.5;
        return {
          forward: 1,
          strafe: 0,
          yaw: angle,
          jump: Math.sin(t * 2) > 0.9, // Occasional jumps
        };
      }
      case 'random': {
        // Use deterministic "random" based on time and client index
        const seed = Math.floor(t * 10) + this.clientIndex * 1000;
        const pseudoRandom = (n: number) => Math.sin(n * 12.9898 + seed * 78.233) * 0.5 + 0.5;
        return {
          forward: pseudoRandom(1) > 0.3 ? 1 : (pseudoRandom(2) > 0.7 ? -1 : 0),
          strafe: pseudoRandom(3) > 0.6 ? 1 : (pseudoRandom(4) > 0.6 ? -1 : 0),
          yaw: pseudoRandom(5) * Math.PI * 2,
          jump: pseudoRandom(6) > 0.95,
        };
      }
      case 'straight': {
        // Move in straight lines with turns
        const segment = Math.floor(t / 2);
        const yaw = (segment * Math.PI / 2) % (Math.PI * 2);
        return {
          forward: 1,
          strafe: 0,
          yaw,
          jump: false,
        };
      }
    }
  }

  private send(msg: LockstepMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  disconnect(): void {
    if (this.inputInterval) {
      clearInterval(this.inputInterval);
    }
    if (this.ws) {
      this.ws.close();
    }
  }

  getStats(): ClientStats {
    return this.stats;
  }

  getFinalStateHash(): string {
    return this.finalStateHash;
  }

  getSimulation(): DeterministicSimulation {
    return this.simulation;
  }

  getPlayerId(): string {
    return this.playerId;
  }
}

// =============================================================================
// Test Runner
// =============================================================================

async function runTest() {
  console.log('\n' + '='.repeat(60));
  console.log('  Deterministic Lockstep Test Harness');
  console.log('  ' + '-'.repeat(56));
  console.log(`  Clients: ${NUM_CLIENTS}`);
  console.log(`  Duration: ${TEST_DURATION_TICKS} ticks (~${(TEST_DURATION_TICKS / TICK_RATE).toFixed(1)}s)`);
  console.log(`  Tick rate: ${TICK_RATE} Hz`);
  console.log('='.repeat(60) + '\n');

  const server = new LockstepServer();
  const clients: LockstepTestClient[] = [];

  try {
    // Start server
    await server.start(SERVER_PORT);

    // Create and connect clients
    for (let i = 0; i < NUM_CLIENTS; i++) {
      const playerId = `lockstep-client-${i}-${Date.now()}`;
      const client = new LockstepTestClient(playerId, i);
      clients.push(client);
    }

    // Connect all clients
    const serverUrl = `ws://localhost:${SERVER_PORT}`;
    await Promise.all(clients.map(c => c.connect(serverUrl)));

    // Wait for test to complete
    log('Test', `Running for ${TEST_DURATION_TICKS} ticks...`, colors.yellow);

    // Wait for all ticks plus buffer
    const testDurationMs = (TEST_DURATION_TICKS / TICK_RATE) * 1000 + 2000;
    await new Promise(r => setTimeout(r, testDurationMs));

    // Print results
    console.log('\n' + '='.repeat(60));
    console.log('  Test Results');
    console.log('='.repeat(60));

    // Check state synchronization
    const finalHashes = clients.map(c => c.getFinalStateHash());
    const allHashesMatch = finalHashes.every(h => h === finalHashes[0]);

    for (let i = 0; i < clients.length; i++) {
      const stats = clients[i].getStats();
      const sim = clients[i].getSimulation();
      const player = sim.getPlayer(clients[i].getPlayerId());
      const color = clientColors[i % clientColors.length];

      console.log(`${color}`);
      console.log(`  Client ${i}:`);
      console.log(`    Ticks processed:  ${stats.ticksProcessed}`);
      console.log(`    Inputs sent:      ${stats.inputsSent}`);
      console.log(`    Inputs received:  ${stats.inputsReceived}`);
      console.log(`    Sync checks:      ${stats.syncChecks}`);
      if (player) {
        console.log(`    Final position:   (${player.position.x.toFixed(4)}, ${player.position.y.toFixed(4)}, ${player.position.z.toFixed(4)})`);
      }
      console.log(`    Final hash:       ${finalHashes[i].slice(0, 50)}...`);
      console.log(`${colors.reset}`);
    }

    // Compare final states
    console.log('  Synchronization Check:');
    console.log(`    All clients synced: ${allHashesMatch ? 'YES' : 'NO'}`);

    if (!allHashesMatch) {
      console.log(`${colors.red}    Hash mismatch detected!${colors.reset}`);
      for (let i = 0; i < finalHashes.length; i++) {
        console.log(`      Client ${i}: ${finalHashes[i].slice(0, 60)}...`);
      }
    }

    // Compare individual player positions across all clients
    console.log('\n  Cross-Client Position Verification:');
    let positionMismatch = false;

    for (let playerIdx = 0; playerIdx < clients.length; playerIdx++) {
      const playerId = clients[playerIdx].getPlayerId();
      const positions: Vec3[] = [];

      for (const client of clients) {
        const player = client.getSimulation().getPlayer(playerId);
        if (player) {
          positions.push(player.position);
        }
      }

      // Check if all clients agree on this player's position
      const allMatch = positions.every(p => vec3Equals(p, positions[0]));
      if (!allMatch) {
        positionMismatch = true;
        console.log(`${colors.red}    Player ${playerIdx} MISMATCH:${colors.reset}`);
        for (let i = 0; i < positions.length; i++) {
          console.log(`      Client ${i} sees: (${positions[i].x.toFixed(4)}, ${positions[i].y.toFixed(4)}, ${positions[i].z.toFixed(4)})`);
        }
      }
    }

    if (!positionMismatch) {
      console.log(`${colors.green}    All player positions match across all clients${colors.reset}`);
    }

    console.log('='.repeat(60) + '\n');

    // Final verdict
    const avgTicksProcessed = clients.reduce((sum, c) => sum + c.getStats().ticksProcessed, 0) / clients.length;
    const tickCompletionRate = (avgTicksProcessed / TEST_DURATION_TICKS) * 100;

    if (allHashesMatch && !positionMismatch && tickCompletionRate > 95) {
      console.log(`${colors.green}TEST PASSED${colors.reset}`);
      console.log(`  Synchronization: ${allHashesMatch ? 'PASS' : 'FAIL'}`);
      console.log(`  Position match:  ${!positionMismatch ? 'PASS' : 'FAIL'}`);
      console.log(`  Tick completion: ${tickCompletionRate.toFixed(1)}%`);
    } else if (tickCompletionRate > 50) {
      console.log(`${colors.yellow}TEST PARTIAL${colors.reset}`);
      console.log(`  Synchronization: ${allHashesMatch ? 'PASS' : 'FAIL'}`);
      console.log(`  Position match:  ${!positionMismatch ? 'PASS' : 'FAIL'}`);
      console.log(`  Tick completion: ${tickCompletionRate.toFixed(1)}%`);
    } else {
      console.log(`${colors.red}TEST FAILED${colors.reset}`);
      console.log(`  Synchronization: ${allHashesMatch ? 'PASS' : 'FAIL'}`);
      console.log(`  Position match:  ${!positionMismatch ? 'PASS' : 'FAIL'}`);
      console.log(`  Tick completion: ${tickCompletionRate.toFixed(1)}%`);
    }

  } catch (err) {
    log('Test', `Error: ${err}`, colors.red);
    console.error(err);
  } finally {
    // Cleanup
    for (const client of clients) {
      client.disconnect();
    }
    server.stop();

    // Give time for cleanup
    await new Promise(r => setTimeout(r, 500));
    process.exit(0);
  }
}

// Run the test
runTest().catch(console.error);
