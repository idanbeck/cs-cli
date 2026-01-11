#!/usr/bin/env npx ts-node
/**
 * Multiplayer Damage Test Harness
 *
 * Tests multiplayer damage/frag mechanics:
 * - Player spawning at valid positions
 * - Shooting detection (fire actions transmitted)
 * - Hit detection (victim receives damage)
 * - Hit confirmation (shooter gets feedback)
 * - Kill/frag mechanics (death events, kill credit)
 *
 * Usage:
 *   1. Start server: cd server && npm run start
 *   2. Run test: npx ts-node src/test/multiplayerDamageTest.ts
 */

import WebSocket from 'ws';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

// Test configuration
const SERVER_URL = 'ws://localhost:8080';
const TICK_RATE = 60;
const TICK_MS = 1000 / TICK_RATE;

// ANSI colors
const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const GRAY = '\x1b[90m';
const BOLD = '\x1b[1m';

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface PlayerInput {
  forward: number;
  strafe: number;
  yaw: number;
  pitch: number;
  jump: boolean;
  crouch: boolean;
}

interface LockstepAction {
  type: string;
  data?: any;
}

function log(prefix: string, message: string, color: string = RESET) {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`${color}[${timestamp}] [${prefix}] ${message}${RESET}`);
}

function vec3Dist(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function vec3Sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function vec3Normalize(v: Vec3): Vec3 {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (len === 0) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

// =============================================================================
// Test Client
// =============================================================================

interface TestClientStats {
  ticksSent: number;
  ticksReceived: number;
  fireActionsSent: number;
  fireActionsReceived: number;
  hitActionsSent: number;
  hitActionsReceived: number;
  deathActionsSent: number;
  deathActionsReceived: number;
  damageReceived: number;
  killsConfirmed: number;
}

class TestClient {
  private ws: WebSocket | null = null;
  private name: string;
  private color: string;
  private playerId: string | null = null;
  private roomId: string | null = null;

  // Lockstep state
  private inLockstep = false;
  private currentTick = 0;
  private position: Vec3 = { x: 0, y: 1.7, z: 0 };
  private yaw = 0;
  private pitch = 0;
  private health = 100;
  private isAlive = true;

  // Other players
  private otherPlayers: Map<string, { position: Vec3; yaw: number; health: number; isAlive: boolean }> = new Map();

  // Stats
  private stats: TestClientStats = {
    ticksSent: 0,
    ticksReceived: 0,
    fireActionsSent: 0,
    fireActionsReceived: 0,
    hitActionsSent: 0,
    hitActionsReceived: 0,
    deathActionsSent: 0,
    deathActionsReceived: 0,
    damageReceived: 0,
    killsConfirmed: 0,
  };

  // Pending actions to send
  private pendingActions: LockstepAction[] = [];

  // Tick loop
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  // Callbacks
  private onReady: (() => void) | null = null;
  private onLockstepStart: (() => void) | null = null;
  private messageLog: Array<{ tick: number; type: string; data: any }> = [];

  constructor(name: string, color: string) {
    this.name = name;
    this.color = color;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(SERVER_URL);

      this.ws.on('open', () => {
        log(this.name, 'Connected to server', this.color);
        resolve();
      });

      this.ws.on('error', (err) => {
        log(this.name, `WebSocket error: ${err.message}`, RED);
        reject(err);
      });

      this.ws.on('close', () => {
        log(this.name, 'Disconnected', YELLOW);
        this.stopTicking();
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch (err: any) {
          log(this.name, `Parse error: ${err.message}`, RED);
        }
      });

      setTimeout(() => reject(new Error('Connection timeout')), 5000);
    });
  }

  private handleMessage(msg: any) {
    switch (msg.type) {
      case 'room_list':
        log(this.name, `Received room list: ${msg.rooms.length} rooms`, GRAY);
        break;

      case 'room_joined':
        this.playerId = msg.playerId;
        this.roomId = msg.roomId;
        log(this.name, `Joined room "${msg.room.name}" as ${msg.playerId.slice(0, 8)}`, this.color);
        this.onReady?.();
        break;

      case 'player_joined':
        log(this.name, `Player joined: ${msg.playerName}`, GRAY);
        break;

      case 'game_starting':
        log(this.name, `Game starting in ${msg.countdown}s...`, this.color);
        break;

      case 'lockstep_start':
        this.handleLockstepStart(msg);
        break;

      case 'lockstep_tick':
        this.handleLockstepTick(msg);
        break;

      case 'error':
        log(this.name, `Server error: ${msg.message}`, RED);
        break;
    }
  }

  private handleLockstepStart(msg: any) {
    this.inLockstep = true;
    this.currentTick = msg.tick;

    // Find our spawn position
    const me = msg.players.find((p: any) => p.id === this.playerId);
    if (me) {
      this.position = { ...me.spawnPosition };
      this.yaw = me.spawnYaw || 0;
      this.health = 100;
      this.isAlive = true;
      log(this.name, `Spawned at (${this.position.x.toFixed(1)}, ${this.position.y.toFixed(1)}, ${this.position.z.toFixed(1)})`, GREEN);
    } else {
      log(this.name, 'WARNING: Could not find our spawn position!', RED);
    }

    // Store other players
    for (const p of msg.players) {
      if (p.id !== this.playerId) {
        this.otherPlayers.set(p.id, {
          position: { ...p.spawnPosition },
          yaw: p.spawnYaw || 0,
          health: 100,
          isAlive: true,
        });
        log(this.name, `Other player ${p.id.slice(0, 8)} at (${p.spawnPosition.x.toFixed(1)}, ${p.spawnPosition.y.toFixed(1)}, ${p.spawnPosition.z.toFixed(1)})`, GRAY);
      }
    }

    log(this.name, `Lockstep started at tick ${msg.tick} with ${msg.players.length} players`, GREEN);

    // Start tick loop
    this.startTicking();

    this.onLockstepStart?.();
  }

  private handleLockstepTick(msg: any) {
    this.stats.ticksReceived++;

    // Process inputs from all players
    for (const playerInput of msg.inputs) {
      // Update other player states
      if (playerInput.playerId !== this.playerId) {
        const other = this.otherPlayers.get(playerInput.playerId);
        if (other) {
          other.position = playerInput.position;
          other.yaw = playerInput.yaw;
          other.health = playerInput.health;
          other.isAlive = playerInput.isAlive;
        }
      }

      // Process actions
      for (const action of playerInput.actions || []) {
        this.handleRemoteAction(playerInput.playerId, action, msg.tick);
      }
    }

    this.currentTick++;
  }

  private handleRemoteAction(playerId: string, action: LockstepAction, tick: number) {
    const isOwnAction = playerId === this.playerId;

    if (action.type === 'fire') {
      if (!isOwnAction) {
        this.stats.fireActionsReceived++;
        this.messageLog.push({ tick, type: 'fire_received', data: { from: playerId, ...action.data } });

        // Simulate hit detection - check if the shot hits us
        if (this.isAlive && action.data) {
          const { origin, direction, weaponType } = action.data;
          const hitResult = this.checkIfHit(origin, direction, weaponType);
          if (hitResult.hit) {
            this.handleGotHit(playerId, hitResult.damage, weaponType);
          }
        }
      }
    } else if (action.type === 'hit') {
      if (!isOwnAction) {
        this.stats.hitActionsReceived++;
        this.messageLog.push({ tick, type: 'hit_received', data: action.data });

        // If we're the attacker, we got confirmation
        if (action.data?.attackerId === this.playerId) {
          this.stats.killsConfirmed += 0; // Not a kill, just a hit
          log(this.name, `HIT CONFIRMED on ${action.data.victimId?.slice(0, 8)} for ${action.data.damage} damage`, GREEN);
        }
      }
    } else if (action.type === 'death') {
      if (!isOwnAction) {
        this.stats.deathActionsReceived++;
        this.messageLog.push({ tick, type: 'death_received', data: action.data });

        // If we're the killer, we got the frag
        if (action.data?.killerId === this.playerId) {
          this.stats.killsConfirmed++;
          log(this.name, `KILL CONFIRMED: Fragged ${action.data.victimId?.slice(0, 8)}!`, GREEN);
        }
      }
    }
  }

  private checkIfHit(origin: Vec3, direction: Vec3, weaponType: string): { hit: boolean; damage: number } {
    // Simple cylinder hit detection
    const playerCenter = {
      x: this.position.x,
      y: this.position.y - 0.5, // Center mass
      z: this.position.z,
    };

    const toPlayer = vec3Sub(playerCenter, origin);
    const dist = Math.sqrt(toPlayer.x * toPlayer.x + toPlayer.y * toPlayer.y + toPlayer.z * toPlayer.z);

    if (dist > 100) return { hit: false, damage: 0 };

    // Normalize direction
    const dirLen = Math.sqrt(direction.x * direction.x + direction.y * direction.y + direction.z * direction.z);
    const dirNorm = { x: direction.x / dirLen, y: direction.y / dirLen, z: direction.z / dirLen };

    // Project player onto ray
    const dot = toPlayer.x * dirNorm.x + toPlayer.y * dirNorm.y + toPlayer.z * dirNorm.z;
    if (dot < 0) return { hit: false, damage: 0 }; // Behind the shooter

    const closestPoint = {
      x: origin.x + dirNorm.x * dot,
      y: origin.y + dirNorm.y * dot,
      z: origin.z + dirNorm.z * dot,
    };

    const perpDist = vec3Dist(playerCenter, closestPoint);
    const hitRadius = 0.8;

    if (perpDist < hitRadius && dot > 0 && dot < 100) {
      const damage = weaponType === 'sniper' ? 80 : weaponType === 'shotgun' ? 40 : 25;
      return { hit: true, damage };
    }

    return { hit: false, damage: 0 };
  }

  private handleGotHit(attackerId: string, damage: number, weaponType: string) {
    const wasAlive = this.isAlive;
    this.health -= damage;
    this.stats.damageReceived += damage;

    log(this.name, `GOT HIT by ${attackerId.slice(0, 8)} for ${damage} damage (health: ${this.health})`, YELLOW);

    // Send hit action to notify attacker
    this.pendingActions.push({
      type: 'hit',
      data: {
        attackerId,
        victimId: this.playerId,
        damage,
        headshot: false,
      },
    });
    this.stats.hitActionsSent++;

    // Check for death
    if (this.health <= 0 && wasAlive) {
      this.health = 0;
      this.isAlive = false;
      log(this.name, `DIED! Killed by ${attackerId.slice(0, 8)}`, RED);

      // Send death action
      this.pendingActions.push({
        type: 'death',
        data: {
          killerId: attackerId,
          victimId: this.playerId,
          weapon: weaponType,
        },
      });
      this.stats.deathActionsSent++;
    }
  }

  private startTicking() {
    this.tickInterval = setInterval(() => {
      if (!this.inLockstep || !this.ws) return;
      this.sendTick();
    }, TICK_MS);
  }

  private stopTicking() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  private sendTick() {
    const input: PlayerInput = {
      forward: 0,
      strafe: 0,
      yaw: this.yaw,
      pitch: this.pitch,
      jump: false,
      crouch: false,
    };

    // Grab pending actions and clear
    const actions = [...this.pendingActions];
    this.pendingActions = [];

    this.send({
      type: 'lockstep_input',
      tick: this.currentTick,
      input,
      actions,
      position: this.position,
      yaw: this.yaw,
      pitch: this.pitch,
      health: this.health,
      isAlive: this.isAlive,
    });

    this.stats.ticksSent++;
  }

  // ==========================================================================
  // Test Actions
  // ==========================================================================

  /**
   * Fire at a specific position
   */
  fireAt(targetPos: Vec3) {
    const direction = vec3Normalize(vec3Sub(targetPos, this.position));

    this.pendingActions.push({
      type: 'fire',
      data: {
        origin: { ...this.position },
        direction,
        weaponType: 'rifle',
      },
    });
    this.stats.fireActionsSent++;

    log(this.name, `FIRING at (${targetPos.x.toFixed(1)}, ${targetPos.y.toFixed(1)}, ${targetPos.z.toFixed(1)})`, this.color);
  }

  /**
   * Fire at another player by ID
   */
  fireAtPlayer(playerId: string) {
    const other = this.otherPlayers.get(playerId);
    if (other) {
      this.fireAt(other.position);
    } else {
      log(this.name, `Cannot fire at ${playerId.slice(0, 8)} - player not found`, RED);
    }
  }

  /**
   * Set position (for test setup)
   */
  setPosition(pos: Vec3) {
    this.position = { ...pos };
    log(this.name, `Position set to (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`, GRAY);
  }

  /**
   * Set aim direction (yaw in radians)
   */
  setYaw(yaw: number) {
    this.yaw = yaw;
  }

  // ==========================================================================
  // Room Management
  // ==========================================================================

  private send(msg: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  createRoom(name: string) {
    this.send({
      type: 'create_room',
      config: {
        name,
        map: 'de_dust2',
        mode: 'deathmatch',
        maxPlayers: 10,
        botCount: 0,
        botDifficulty: 'easy',
        isPrivate: false,
      },
    });
  }

  joinRoom(roomId: string) {
    this.send({
      type: 'join_room',
      roomId,
      playerName: this.name,
    });
  }

  setReady() {
    this.send({ type: 'ready' });
  }

  startGame() {
    this.send({ type: 'start_game' });
  }

  waitForReady(): Promise<void> {
    return new Promise((resolve) => {
      this.onReady = resolve;
    });
  }

  waitForLockstepStart(): Promise<void> {
    return new Promise((resolve) => {
      this.onLockstepStart = resolve;
    });
  }

  disconnect() {
    this.stopTicking();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // ==========================================================================
  // Getters
  // ==========================================================================

  getPlayerId() { return this.playerId; }
  getRoomId() { return this.roomId; }
  getPosition() { return this.position; }
  getHealth() { return this.health; }
  getIsAlive() { return this.isAlive; }
  getStats() { return this.stats; }
  getOtherPlayers() { return this.otherPlayers; }
  getMessageLog() { return this.messageLog; }
  getName() { return this.name; }
}

// =============================================================================
// Test Scenarios
// =============================================================================

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
}

async function runSpawnTest(client1: TestClient, client2: TestClient): Promise<TestResult> {
  log('Test', 'Running spawn test...', YELLOW);

  // Check that both players spawned at valid positions (not at origin, above ground)
  const pos1 = client1.getPosition();
  const pos2 = client2.getPosition();

  const validSpawn1 = pos1.y > 0 && (pos1.x !== 0 || pos1.z !== 0);
  const validSpawn2 = pos2.y > 0 && (pos2.x !== 0 || pos2.z !== 0);
  const notSameSpawn = vec3Dist(pos1, pos2) > 1.0;

  const passed = validSpawn1 && validSpawn2 && notSameSpawn;

  return {
    name: 'Spawn Positions',
    passed,
    details: `P1: (${pos1.x.toFixed(1)}, ${pos1.y.toFixed(1)}, ${pos1.z.toFixed(1)}), ` +
             `P2: (${pos2.x.toFixed(1)}, ${pos2.y.toFixed(1)}, ${pos2.z.toFixed(1)}), ` +
             `dist: ${vec3Dist(pos1, pos2).toFixed(1)}`,
  };
}

async function runFireActionTest(client1: TestClient, client2: TestClient): Promise<TestResult> {
  log('Test', 'Running fire action relay test...', YELLOW);

  const initialReceived = client2.getStats().fireActionsReceived;

  // Client 1 fires at client 2's position
  const target = client2.getPosition();
  client1.fireAt(target);

  // Wait for tick relay
  await sleep(200);

  const finalReceived = client2.getStats().fireActionsReceived;
  const fireReceived = finalReceived > initialReceived;

  return {
    name: 'Fire Action Relay',
    passed: fireReceived,
    details: `Fire actions received by P2: ${initialReceived} -> ${finalReceived}`,
  };
}

async function runHitDetectionTest(client1: TestClient, client2: TestClient): Promise<TestResult> {
  log('Test', 'Running hit detection test...', YELLOW);

  const initialDamage = client2.getStats().damageReceived;
  const initialHits = client1.getStats().hitActionsReceived;

  // Position clients close together and facing each other
  // (they should already be in range from fire action test)

  // Client 1 fires directly at client 2
  const targetPos = client2.getPosition();
  client1.fireAt(targetPos);

  // Wait for damage processing and hit action relay
  await sleep(500);

  const finalDamage = client2.getStats().damageReceived;
  const finalHits = client1.getStats().hitActionsReceived;

  const damageTaken = finalDamage > initialDamage;
  const hitConfirmed = finalHits > initialHits;

  return {
    name: 'Hit Detection',
    passed: damageTaken && hitConfirmed,
    details: `Damage taken: ${initialDamage} -> ${finalDamage}, ` +
             `Hit confirms received: ${initialHits} -> ${finalHits}`,
  };
}

async function runKillTest(client1: TestClient, client2: TestClient): Promise<TestResult> {
  log('Test', 'Running kill/frag test...', YELLOW);

  const initialKills = client1.getStats().killsConfirmed;
  const initialDeaths = client1.getStats().deathActionsReceived;

  // Fire many times to kill client 2
  const targetPos = client2.getPosition();
  for (let i = 0; i < 10; i++) {
    client1.fireAt(targetPos);
    await sleep(100);
  }

  // Wait for death processing
  await sleep(500);

  const finalKills = client1.getStats().killsConfirmed;
  const client2Dead = !client2.getIsAlive();
  const killConfirmed = finalKills > initialKills;

  return {
    name: 'Kill/Frag Detection',
    passed: client2Dead && killConfirmed,
    details: `P2 alive: ${client2.getIsAlive()}, P2 health: ${client2.getHealth()}, ` +
             `Kill confirms: ${initialKills} -> ${finalKills}`,
  };
}

// =============================================================================
// Main Test Runner
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runAllTests() {
  console.log('\n' + '='.repeat(70));
  console.log(`${BOLD}  Multiplayer Damage Test Harness${RESET}`);
  console.log('  Testing spawn, shooting, hit detection, and kill mechanics');
  console.log('='.repeat(70) + '\n');

  const client1 = new TestClient('Attacker', CYAN);
  const client2 = new TestClient('Victim', MAGENTA);
  const results: TestResult[] = [];

  try {
    // Connect both clients
    log('Setup', 'Connecting clients...', YELLOW);
    await Promise.all([client1.connect(), client2.connect()]);

    // Client 1 creates room
    log('Setup', 'Creating room...', YELLOW);
    const ready1 = client1.waitForReady();
    client1.createRoom('Damage Test Room');
    await ready1;

    const roomId = client1.getRoomId();
    if (!roomId) throw new Error('Failed to create room');

    // Client 2 joins
    log('Setup', 'Client 2 joining room...', YELLOW);
    const ready2 = client2.waitForReady();
    client2.joinRoom(roomId);
    await ready2;

    // Both set ready
    log('Setup', 'Setting ready...', YELLOW);
    client1.setReady();
    client2.setReady();
    await sleep(500);

    // Start game
    log('Setup', 'Starting game...', YELLOW);
    const lockstep1 = client1.waitForLockstepStart();
    const lockstep2 = client2.waitForLockstepStart();
    client1.startGame();

    // Wait for lockstep start
    await Promise.race([
      Promise.all([lockstep1, lockstep2]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Lockstep start timeout')), 10000)),
    ]);

    log('Setup', 'Game started, running tests...', GREEN);

    // Wait for a few ticks to stabilize
    await sleep(500);

    // Run tests
    results.push(await runSpawnTest(client1, client2));
    results.push(await runFireActionTest(client1, client2));
    results.push(await runHitDetectionTest(client1, client2));
    results.push(await runKillTest(client1, client2));

    // Print results
    console.log('\n' + '='.repeat(70));
    console.log(`${BOLD}  Test Results${RESET}`);
    console.log('='.repeat(70));

    let passCount = 0;
    for (const result of results) {
      const status = result.passed ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
      console.log(`\n  ${status} - ${result.name}`);
      console.log(`       ${GRAY}${result.details}${RESET}`);
      if (result.passed) passCount++;
    }

    // Print stats
    console.log('\n' + '-'.repeat(70));
    console.log(`${BOLD}  Client Statistics${RESET}`);
    console.log('-'.repeat(70));

    for (const client of [client1, client2]) {
      const stats = client.getStats();
      console.log(`\n  ${client.getName()}:`);
      console.log(`    Ticks sent/received: ${stats.ticksSent}/${stats.ticksReceived}`);
      console.log(`    Fire actions sent/received: ${stats.fireActionsSent}/${stats.fireActionsReceived}`);
      console.log(`    Hit actions sent/received: ${stats.hitActionsSent}/${stats.hitActionsReceived}`);
      console.log(`    Death actions sent/received: ${stats.deathActionsSent}/${stats.deathActionsReceived}`);
      console.log(`    Damage received: ${stats.damageReceived}`);
      console.log(`    Kills confirmed: ${stats.killsConfirmed}`);
    }

    // Final summary
    console.log('\n' + '='.repeat(70));
    if (passCount === results.length) {
      console.log(`${GREEN}${BOLD}  ALL TESTS PASSED (${passCount}/${results.length})${RESET}`);
    } else {
      console.log(`${RED}${BOLD}  TESTS FAILED (${passCount}/${results.length} passed)${RESET}`);
    }
    console.log('='.repeat(70) + '\n');

    // Debug: print message log if failures
    if (passCount < results.length) {
      console.log(`${YELLOW}Message Log (last 20):${RESET}`);
      const log1 = client1.getMessageLog().slice(-10);
      const log2 = client2.getMessageLog().slice(-10);
      console.log(`  ${client1.getName()}:`, log1);
      console.log(`  ${client2.getName()}:`, log2);
    }

  } catch (err: any) {
    log('Test', `Error: ${err.message}`, RED);
    console.error(err);
  } finally {
    client1.disconnect();
    client2.disconnect();
    await sleep(500);
    process.exit(0);
  }
}

// Run tests
runAllTests().catch(console.error);
