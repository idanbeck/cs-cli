/**
 * Lockstep Integration Test
 *
 * Tests lockstep networking with two clients connecting to the real game server.
 * Run the server first: cd server && npm run start
 * Then run this test: npm run build && node dist/test/lockstepIntegrationTest.js
 */

import WebSocket from 'ws';

const SERVER_URL = 'ws://localhost:8080';
const TEST_DURATION_MS = 5000;
const TICK_RATE = 60;
const TICK_MS = 1000 / TICK_RATE;

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

// ANSI colors
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';

function log(client: string, message: string, color: string = RESET) {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`${color}[${timestamp}] [${client}] ${message}${RESET}`);
}

class TestClient {
  private ws: WebSocket | null = null;
  private name: string;
  private playerId: string | null = null;
  private roomId: string | null = null;
  private isHost: boolean;
  private color: string;

  // Lockstep state
  private inLockstep = false;
  private currentTick = 0;
  private position: Vec3 = { x: 0, y: 1.7, z: 0 };
  private yaw = 0;
  private pitch = 0;

  // Stats
  private ticksSent = 0;
  private ticksReceived = 0;
  private remotePositions: Map<string, Vec3> = new Map();
  private fireActionsSent = 0;
  private fireActionsReceived = 0;

  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private onReady: (() => void) | null = null;
  private onGameStart: (() => void) | null = null;

  constructor(name: string, isHost: boolean, color: string) {
    this.name = name;
    this.isHost = isHost;
    this.color = color;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(SERVER_URL);

      this.ws.on('open', () => {
        log(this.name, 'Connected to server', this.color);
        resolve();
      });

      this.ws.on('error', (err) => {
        log(this.name, `Error: ${err.message}`, RED);
        reject(err);
      });

      this.ws.on('close', () => {
        log(this.name, 'Disconnected', YELLOW);
        this.stopTicking();
      });

      this.ws.on('message', (data) => {
        this.handleMessage(JSON.parse(data.toString()));
      });
    });
  }

  private handleMessage(msg: any) {
    switch (msg.type) {
      case 'room_list':
        log(this.name, `Received room list: ${msg.rooms.length} rooms`, this.color);
        break;

      case 'room_joined':
        this.playerId = msg.playerId;
        this.roomId = msg.roomId;
        log(this.name, `Joined room ${msg.room.name} as ${msg.playerId}`, this.color);
        this.onReady?.();
        break;

      case 'player_joined':
        log(this.name, `Player joined: ${msg.playerName}`, this.color);
        break;

      case 'game_starting':
        log(this.name, `Game starting in ${msg.countdown}...`, this.color);
        if (msg.countdown <= 0) {
          this.onGameStart?.();
        }
        break;

      case 'lockstep_start':
        log(this.name, `Lockstep started at tick ${msg.tick} with ${msg.players.length} players`, GREEN);
        this.inLockstep = true;
        this.currentTick = msg.tick;

        // Find our spawn position
        const me = msg.players.find((p: any) => p.id === this.playerId);
        if (me) {
          this.position = { ...me.spawnPosition };
          this.yaw = me.spawnYaw;
          log(this.name, `Spawned at (${this.position.x.toFixed(1)}, ${this.position.y.toFixed(1)}, ${this.position.z.toFixed(1)})`, this.color);
        }

        // Start sending ticks
        this.startTicking();
        break;

      case 'lockstep_tick':
        this.ticksReceived++;

        // Update remote player positions and count fire actions
        for (const input of msg.inputs) {
          if (input.playerId !== this.playerId) {
            this.remotePositions.set(input.playerId, input.position);

            // Count fire actions from others
            for (const action of input.actions || []) {
              if (action.type === 'fire') {
                this.fireActionsReceived++;
                log(this.name, `Received FIRE from ${input.playerId.slice(0, 8)}`, YELLOW);
              }
            }
          }
        }

        this.currentTick++;

        if (this.ticksReceived % 60 === 0) {
          log(this.name, `Tick ${msg.tick}: pos=(${this.position.x.toFixed(2)}, ${this.position.z.toFixed(2)}), remotes=${this.remotePositions.size}`, this.color);
        }
        break;

      case 'lockstep_desync':
        log(this.name, `DESYNC at tick ${msg.tick}!`, RED);
        break;
    }
  }

  private fireCounter = 0;

  private startTicking() {
    this.tickInterval = setInterval(() => {
      if (!this.inLockstep || !this.ws) return;

      // Simulate movement - walk forward
      const speed = 0.1;
      this.position.x += Math.sin(this.yaw) * speed;
      this.position.z += Math.cos(this.yaw) * speed;

      // Slowly rotate
      this.yaw += 0.01;

      const input: PlayerInput = {
        forward: 1,
        strafe: 0,
        yaw: this.yaw,
        pitch: this.pitch,
        jump: false,
        crouch: false,
      };

      // Fire every 30 ticks (~0.5 seconds)
      const actions: any[] = [];
      this.fireCounter++;
      if (this.fireCounter % 30 === 0) {
        const fireDir = {
          x: Math.sin(this.yaw),
          y: 0,
          z: Math.cos(this.yaw),
        };
        actions.push({
          type: 'fire',
          data: {
            origin: { ...this.position },
            direction: fireDir,
            weaponType: 'rifle',
          },
        });
        this.fireActionsSent++;
        log(this.name, `FIRE! dir=(${fireDir.x.toFixed(2)}, ${fireDir.z.toFixed(2)})`, this.color);
      }

      this.send({
        type: 'lockstep_input',
        tick: this.currentTick,
        input,
        actions,
        position: this.position,
        yaw: this.yaw,
        pitch: this.pitch,
        health: 100,
        isAlive: true,
      });

      this.ticksSent++;
    }, TICK_MS);
  }

  private stopTicking() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  private send(msg: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  listRooms() {
    this.send({ type: 'list_rooms' });
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

  waitForGameStart(): Promise<void> {
    return new Promise((resolve) => {
      this.onGameStart = resolve;
    });
  }

  disconnect() {
    this.stopTicking();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  getStats() {
    return {
      name: this.name,
      ticksSent: this.ticksSent,
      ticksReceived: this.ticksReceived,
      fireActionsSent: this.fireActionsSent,
      fireActionsReceived: this.fireActionsReceived,
      position: this.position,
      remotePositions: Array.from(this.remotePositions.entries()),
    };
  }

  getRoomId() {
    return this.roomId;
  }
}

async function runTest() {
  console.log('\n' + '='.repeat(60));
  console.log('  Lockstep Integration Test');
  console.log('  Testing two clients with real game server');
  console.log('='.repeat(60) + '\n');

  const client1 = new TestClient('Player1', true, CYAN);
  const client2 = new TestClient('Player2', false, MAGENTA);

  try {
    // Connect both clients
    log('Test', 'Connecting clients...', YELLOW);
    await Promise.all([client1.connect(), client2.connect()]);

    // Client 1 creates a room
    log('Test', 'Client 1 creating room...', YELLOW);
    const ready1 = client1.waitForReady();
    client1.createRoom('Lockstep Test Room');
    await ready1;

    // Get room ID and have client 2 join
    const roomId = client1.getRoomId();
    if (!roomId) {
      throw new Error('No room ID after creating room');
    }

    log('Test', `Client 2 joining room ${roomId}...`, YELLOW);
    const ready2 = client2.waitForReady();
    client2.joinRoom(roomId);
    await ready2;

    // Both set ready
    log('Test', 'Both clients setting ready...', YELLOW);
    client1.setReady();
    client2.setReady();

    // Wait a moment for ready states to sync
    await new Promise(r => setTimeout(r, 500));

    // Host starts game
    log('Test', 'Host starting game...', YELLOW);
    const gameStart1 = client1.waitForGameStart();
    const gameStart2 = client2.waitForGameStart();
    client1.startGame();

    // Wait for game to start (lockstep_start)
    await Promise.race([
      Promise.all([gameStart1, gameStart2]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Game start timeout')), 5000)),
    ]);

    // Let the game run for a while
    log('Test', `Running for ${TEST_DURATION_MS / 1000} seconds...`, YELLOW);
    await new Promise(r => setTimeout(r, TEST_DURATION_MS));

    // Get stats
    const stats1 = client1.getStats();
    const stats2 = client2.getStats();

    console.log('\n' + '='.repeat(60));
    console.log('  Test Results');
    console.log('='.repeat(60));

    console.log(`\n${CYAN}  ${stats1.name}:${RESET}`);
    console.log(`    Ticks sent:     ${stats1.ticksSent}`);
    console.log(`    Ticks received: ${stats1.ticksReceived}`);
    console.log(`    Fire sent:      ${stats1.fireActionsSent}`);
    console.log(`    Fire received:  ${stats1.fireActionsReceived}`);
    console.log(`    Final position: (${stats1.position.x.toFixed(2)}, ${stats1.position.y.toFixed(2)}, ${stats1.position.z.toFixed(2)})`);
    console.log(`    Remote players: ${stats1.remotePositions.length}`);
    for (const [id, pos] of stats1.remotePositions) {
      console.log(`      ${id}: (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)})`);
    }

    console.log(`\n${MAGENTA}  ${stats2.name}:${RESET}`);
    console.log(`    Ticks sent:     ${stats2.ticksSent}`);
    console.log(`    Ticks received: ${stats2.ticksReceived}`);
    console.log(`    Fire sent:      ${stats2.fireActionsSent}`);
    console.log(`    Fire received:  ${stats2.fireActionsReceived}`);
    console.log(`    Final position: (${stats2.position.x.toFixed(2)}, ${stats2.position.y.toFixed(2)}, ${stats2.position.z.toFixed(2)})`);
    console.log(`    Remote players: ${stats2.remotePositions.length}`);
    for (const [id, pos] of stats2.remotePositions) {
      console.log(`      ${id}: (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)})`);
    }

    // Check if they can see each other
    const client1SeesClient2 = stats1.remotePositions.length > 0;
    const client2SeesClient1 = stats2.remotePositions.length > 0;
    const bothReceiveTicks = stats1.ticksReceived > 0 && stats2.ticksReceived > 0;
    const fireActionsWork = stats1.fireActionsReceived > 0 && stats2.fireActionsReceived > 0;

    console.log('\n' + '='.repeat(60));
    if (client1SeesClient2 && client2SeesClient1 && bothReceiveTicks && fireActionsWork) {
      console.log(`${GREEN}  TEST PASSED${RESET}`);
      console.log('  - Both clients receiving ticks');
      console.log('  - Both clients see each other');
      console.log('  - Fire actions being relayed');
    } else {
      console.log(`${RED}  TEST FAILED${RESET}`);
      if (!bothReceiveTicks) console.log('  - Not all clients receiving ticks');
      if (!client1SeesClient2) console.log('  - Client 1 does not see Client 2');
      if (!client2SeesClient1) console.log('  - Client 2 does not see Client 1');
      if (!fireActionsWork) console.log('  - Fire actions not being relayed');
    }
    console.log('='.repeat(60) + '\n');

  } catch (err: any) {
    log('Test', `Error: ${err.message}`, RED);
    console.error(err);
  } finally {
    client1.disconnect();
    client2.disconnect();

    // Give time for cleanup
    await new Promise(r => setTimeout(r, 500));
    process.exit(0);
  }
}

runTest();
