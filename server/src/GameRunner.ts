// Server-side game loop for CS-CLI multiplayer

import { v4 as uuidv4 } from 'uuid';
import {
  RoomConfig,
  GamePhase,
  TeamId,
  WeaponType,
  BotDifficulty,
  ClientMessage,
  ServerMessage,
  GameStateSnapshot,
  PlayerSnapshot,
  BotSnapshot,
  DroppedWeaponSnapshot,
  Vec3,
} from './protocol.js';
import {
  ServerConfig,
  ServerGameState,
  ServerPlayerState,
  ServerBotState,
  ServerDroppedWeapon,
  MapData,
  SpawnPoint,
  createVec3,
  vec3Add,
  vec3Sub,
  vec3Scale,
  vec3Length,
  vec3Normalize,
  vec3Distance,
  WEAPON_DEFS,
  DEFAULT_ECONOMY_CONFIG,
} from './types.js';

// Game timing constants
const WARMUP_TIME = 5;
const FREEZE_TIME_DM = 5;
const FREEZE_TIME_COMP = 15;
const ROUND_TIME = 120;
const ROUND_END_DELAY = 3;

// Player constants
const PLAYER_MOVE_SPEED = 8;
const PLAYER_EYE_HEIGHT = 1.7;
const PLAYER_RADIUS = 0.4;
const GRAVITY = 20;
const JUMP_VELOCITY = 8;

// Bot AI constants
const BOT_REACTION_TIME_EASY = 800;
const BOT_REACTION_TIME_MEDIUM = 400;
const BOT_REACTION_TIME_HARD = 150;
const BOT_ACCURACY_EASY = 0.3;
const BOT_ACCURACY_MEDIUM = 0.5;
const BOT_ACCURACY_HARD = 0.8;

export class GameRunner {
  private state: ServerGameState;
  private mapData: MapData;
  private roomConfig: RoomConfig;
  private serverConfig: ServerConfig;

  // Callbacks
  private broadcast: (msg: ServerMessage) => void;
  private sendToClient: (clientId: string, msg: ServerMessage) => void;

  // Intervals
  private gameLoopInterval: ReturnType<typeof setInterval> | null = null;
  private broadcastInterval: ReturnType<typeof setInterval> | null = null;

  // Timing
  private lastTickTime: number = 0;
  private tickDeltaMs: number;
  private broadcastDeltaMs: number;

  // Spawn tracking
  private usedSpawns: Set<number> = new Set();

  constructor(
    state: ServerGameState,
    mapData: MapData,
    roomConfig: RoomConfig,
    serverConfig: ServerConfig,
    broadcast: (msg: ServerMessage) => void,
    sendToClient: (clientId: string, msg: ServerMessage) => void
  ) {
    this.state = state;
    this.mapData = mapData;
    this.roomConfig = roomConfig;
    this.serverConfig = serverConfig;
    this.broadcast = broadcast;
    this.sendToClient = sendToClient;

    this.tickDeltaMs = 1000 / serverConfig.tickRate;
    this.broadcastDeltaMs = 1000 / serverConfig.broadcastRate;
  }

  // ============ Lifecycle ============

  start(): void {
    this.lastTickTime = Date.now();
    this.state.phaseStartTime = Date.now();
    this.state.phase = 'warmup';

    // Start game loop
    this.gameLoopInterval = setInterval(
      () => this.tick(),
      this.tickDeltaMs
    );

    // Start broadcast loop
    this.broadcastInterval = setInterval(
      () => this.broadcastState(),
      this.broadcastDeltaMs
    );

    console.log('GameRunner started');
  }

  stop(): void {
    if (this.gameLoopInterval) {
      clearInterval(this.gameLoopInterval);
      this.gameLoopInterval = null;
    }
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    }
    console.log('GameRunner stopped');
  }

  getPhase(): GamePhase {
    return this.state.phase;
  }

  // ============ Player Management ============

  addPlayer(clientId: string, name: string, team: TeamId): void {
    const spawn = this.getSpawnPoint(team);
    const player: ServerPlayerState = {
      id: clientId,
      name,
      team,
      position: { ...spawn.position, y: spawn.position.y + PLAYER_EYE_HEIGHT },
      velocity: createVec3(),
      yaw: spawn.angle,
      pitch: 0,
      health: 100,
      armor: 0,
      isAlive: true,
      currentWeapon: 'pistol',
      weapons: new Map([
        [2, { type: 'pistol', currentAmmo: 12, reserveAmmo: 36, isReloading: false, reloadStartTime: 0, lastFireTime: 0 }],
        [3, { type: 'knife', currentAmmo: Infinity, reserveAmmo: Infinity, isReloading: false, reloadStartTime: 0, lastFireTime: 0 }],
      ]),
      money: DEFAULT_ECONOMY_CONFIG.startMoney,
      kills: 0,
      deaths: 0,
      lastInputSequence: 0,
    };

    this.state.players.set(clientId, player);

    this.broadcast({
      type: 'spawn_event',
      entityId: clientId,
      entityType: 'player',
      position: player.position,
      team,
    });
  }

  removePlayer(clientId: string): void {
    this.state.players.delete(clientId);
  }

  addBot(name: string, team: TeamId, difficulty: BotDifficulty): void {
    const botId = `bot_${uuidv4().substring(0, 8)}`;
    const spawn = this.getSpawnPoint(team);

    const bot: ServerBotState = {
      id: botId,
      name,
      team,
      difficulty,
      position: { ...spawn.position, y: spawn.position.y + PLAYER_EYE_HEIGHT },
      velocity: createVec3(),
      yaw: spawn.angle,
      pitch: 0,
      health: 100,
      armor: 0,
      isAlive: true,
      currentWeapon: 'pistol',
      kills: 0,
      deaths: 0,
      targetId: null,
      lastTargetSeen: 0,
      wanderAngle: spawn.angle,
      nextFireTime: 0,
    };

    this.state.bots.set(botId, bot);

    this.broadcast({
      type: 'spawn_event',
      entityId: botId,
      entityType: 'bot',
      position: bot.position,
      team,
    });
  }

  // ============ Input Handling ============

  handleInput(clientId: string, message: ClientMessage): void {
    const player = this.state.players.get(clientId);
    if (!player || !player.isAlive) return;

    const now = Date.now();

    switch (message.type) {
      case 'input':
        this.processPlayerInput(player, message.input, message.sequence);
        break;

      case 'fire':
        this.processPlayerFire(player, now);
        break;

      case 'reload':
        this.processPlayerReload(player, now);
        break;

      case 'buy_weapon':
        if (this.state.phase === 'freeze' || this.state.phase === 'warmup') {
          this.processPlayerBuy(player, message.weaponName);
        }
        break;

      case 'select_weapon':
        const weapon = player.weapons.get(message.slot);
        if (weapon) {
          player.currentWeapon = weapon.type;
        }
        break;

      case 'drop_weapon':
        this.processPlayerDrop(player, now);
        break;

      case 'pickup_weapon':
        this.processPlayerPickup(player, message.weaponId);
        break;
    }
  }

  private processPlayerInput(
    player: ServerPlayerState,
    input: { forward: number; strafe: number; yaw: number; pitch: number; jump: boolean; crouch: boolean },
    sequence: number
  ): void {
    // Update look direction
    player.yaw = input.yaw;
    player.pitch = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, input.pitch));

    // Can't move during freeze phase
    if (this.state.phase === 'freeze' || this.state.phase === 'round_end') {
      player.lastInputSequence = sequence;
      return;
    }

    // Calculate movement direction
    const forward = vec3Normalize({
      x: -Math.sin(player.yaw),
      y: 0,
      z: -Math.cos(player.yaw),
    });
    const right = vec3Normalize({
      x: Math.cos(player.yaw),
      y: 0,
      z: -Math.sin(player.yaw),
    });

    // Apply movement
    const moveDir = vec3Add(
      vec3Scale(forward, input.forward),
      vec3Scale(right, input.strafe)
    );

    if (vec3Length(moveDir) > 0) {
      const normalizedDir = vec3Normalize(moveDir);
      const speed = PLAYER_MOVE_SPEED * (this.tickDeltaMs / 1000);
      player.position = vec3Add(player.position, vec3Scale(normalizedDir, speed));
    }

    // Handle jumping
    if (input.jump && player.position.y <= PLAYER_EYE_HEIGHT + 0.1) {
      player.velocity.y = JUMP_VELOCITY;
    }

    player.lastInputSequence = sequence;

    // Send acknowledgment
    this.sendToClient(player.id, {
      type: 'input_ack',
      sequence,
      position: player.position,
    });
  }

  private processPlayerFire(player: ServerPlayerState, now: number): void {
    const weaponSlot = this.getWeaponSlot(player.currentWeapon);
    const weapon = player.weapons.get(weaponSlot);
    if (!weapon) return;

    const def = WEAPON_DEFS[player.currentWeapon];
    const fireInterval = 60000 / def.fireRate;

    // Check if can fire
    if (weapon.isReloading) return;
    if (weapon.currentAmmo <= 0) return;
    if (now - weapon.lastFireTime < fireInterval) return;

    // Fire the weapon
    weapon.currentAmmo--;
    weapon.lastFireTime = now;

    // Calculate fire direction
    const direction = this.getAimDirection(player, def.spread);

    // Broadcast fire event
    this.broadcast({
      type: 'fire_event',
      event: {
        playerId: player.id,
        origin: player.position,
        direction,
        weapon: player.currentWeapon,
      },
    });

    // Perform hit detection
    this.performHitDetection(player, direction, def);
  }

  private processPlayerReload(player: ServerPlayerState, now: number): void {
    const weaponSlot = this.getWeaponSlot(player.currentWeapon);
    const weapon = player.weapons.get(weaponSlot);
    if (!weapon) return;

    const def = WEAPON_DEFS[player.currentWeapon];
    if (weapon.isReloading) return;
    if (weapon.currentAmmo >= def.magazineSize) return;
    if (weapon.reserveAmmo <= 0) return;

    weapon.isReloading = true;
    weapon.reloadStartTime = now;
  }

  private processPlayerBuy(player: ServerPlayerState, weaponName: string): void {
    const def = WEAPON_DEFS[weaponName as WeaponType];
    if (!def) return;
    if (player.money < def.cost) return;

    player.money -= def.cost;
    player.weapons.set(def.slot, {
      type: def.type,
      currentAmmo: def.magazineSize,
      reserveAmmo: def.reserveAmmo,
      isReloading: false,
      reloadStartTime: 0,
      lastFireTime: 0,
    });
    player.currentWeapon = def.type;
  }

  private processPlayerDrop(player: ServerPlayerState, now: number): void {
    const weaponSlot = this.getWeaponSlot(player.currentWeapon);
    const weapon = player.weapons.get(weaponSlot);
    if (!weapon || weapon.type === 'knife') return;

    // Create dropped weapon
    const dropId = uuidv4().substring(0, 8);
    const dropped: ServerDroppedWeapon = {
      id: dropId,
      weaponType: weapon.type,
      position: { ...player.position, y: player.position.y - PLAYER_EYE_HEIGHT },
      ammo: weapon.currentAmmo,
      reserveAmmo: weapon.reserveAmmo,
      dropTime: now,
    };
    this.state.droppedWeapons.set(dropId, dropped);

    // Remove from player
    player.weapons.delete(weaponSlot);
    player.currentWeapon = player.weapons.has(2) ? 'pistol' : 'knife';

    this.broadcast({
      type: 'weapon_dropped',
      weaponId: dropId,
      weaponType: weapon.type,
      position: dropped.position,
    });
  }

  private processPlayerPickup(player: ServerPlayerState, weaponId: string): void {
    const dropped = this.state.droppedWeapons.get(weaponId);
    if (!dropped) return;

    // Check distance
    const dist = vec3Distance(player.position, {
      ...dropped.position,
      y: player.position.y,
    });
    if (dist > 3) return;

    // Pick up the weapon
    const def = WEAPON_DEFS[dropped.weaponType];
    player.weapons.set(def.slot, {
      type: dropped.weaponType,
      currentAmmo: dropped.ammo,
      reserveAmmo: dropped.reserveAmmo,
      isReloading: false,
      reloadStartTime: 0,
      lastFireTime: 0,
    });
    player.currentWeapon = dropped.weaponType;

    this.state.droppedWeapons.delete(weaponId);

    this.broadcast({
      type: 'weapon_picked_up',
      weaponId,
      playerId: player.id,
    });
  }

  // ============ Game Loop ============

  private tick(): void {
    const now = Date.now();
    const deltaTime = (now - this.lastTickTime) / 1000;
    this.lastTickTime = now;
    this.state.tick++;

    // Update phase
    this.updatePhase(now);

    // Only update physics/AI during live gameplay
    if (this.state.phase === 'live' || this.state.phase === 'warmup') {
      // Update players
      for (const player of this.state.players.values()) {
        this.updatePlayer(player, deltaTime, now);
      }

      // Update bots
      for (const bot of this.state.bots.values()) {
        this.updateBot(bot, deltaTime, now);
      }
    }

    // Update reloads always
    this.updateReloads(now);
  }

  private updatePhase(now: number): void {
    const elapsed = (now - this.state.phaseStartTime) / 1000;

    switch (this.state.phase) {
      case 'warmup':
        if (elapsed >= WARMUP_TIME) {
          this.startRound(now);
        }
        break;

      case 'freeze':
        const freezeTime = this.roomConfig.mode === 'competitive'
          ? FREEZE_TIME_COMP
          : FREEZE_TIME_DM;
        if (elapsed >= freezeTime) {
          this.state.phase = 'live';
          this.state.phaseStartTime = now;
          this.broadcastPhaseChange();
        }
        break;

      case 'live':
        // Check round end conditions
        const winner = this.checkRoundEnd();
        if (winner) {
          this.endRound(winner, now);
        } else if (elapsed >= ROUND_TIME) {
          // Time ran out
          this.endRound(this.getTimeoutWinner(), now);
        }
        break;

      case 'round_end':
        if (elapsed >= ROUND_END_DELAY) {
          // Check for match end
          const roundsToWin = this.roomConfig.mode === 'competitive' ? 7 : 10;
          if (this.state.tScore >= roundsToWin || this.state.ctScore >= roundsToWin) {
            this.state.phase = 'match_end';
            this.state.phaseStartTime = now;
            this.broadcastPhaseChange();
          } else {
            this.startRound(now);
          }
        }
        break;
    }
  }

  private startRound(now: number): void {
    this.state.phase = 'freeze';
    this.state.phaseStartTime = now;
    this.state.roundNumber++;
    this.state.roundWinner = null;
    this.usedSpawns.clear();

    // Respawn all players and bots
    for (const player of this.state.players.values()) {
      this.respawnPlayer(player);
    }
    for (const bot of this.state.bots.values()) {
      this.respawnBot(bot);
    }

    // Clear dropped weapons
    this.state.droppedWeapons.clear();

    this.broadcastPhaseChange();
  }

  private endRound(winner: TeamId, now: number): void {
    this.state.phase = 'round_end';
    this.state.phaseStartTime = now;
    this.state.roundWinner = winner;

    if (winner === 'T') {
      this.state.tScore++;
    } else if (winner === 'CT') {
      this.state.ctScore++;
    }

    // Award economy
    for (const player of this.state.players.values()) {
      if (player.team === winner) {
        player.money = Math.min(player.money + DEFAULT_ECONOMY_CONFIG.roundWinBonus, DEFAULT_ECONOMY_CONFIG.maxMoney);
      } else {
        player.money = Math.min(player.money + DEFAULT_ECONOMY_CONFIG.roundLoseBonus, DEFAULT_ECONOMY_CONFIG.maxMoney);
      }
    }

    this.broadcastPhaseChange();
  }

  private checkRoundEnd(): TeamId | null {
    // Count alive on each team
    let tAlive = 0;
    let ctAlive = 0;

    for (const player of this.state.players.values()) {
      if (player.isAlive) {
        if (player.team === 'T') tAlive++;
        else if (player.team === 'CT') ctAlive++;
      }
    }

    for (const bot of this.state.bots.values()) {
      if (bot.isAlive) {
        if (bot.team === 'T') tAlive++;
        else if (bot.team === 'CT') ctAlive++;
      }
    }

    if (tAlive === 0 && ctAlive > 0) return 'CT';
    if (ctAlive === 0 && tAlive > 0) return 'T';
    if (tAlive === 0 && ctAlive === 0) return 'CT'; // Draw goes to CT

    return null;
  }

  private getTimeoutWinner(): TeamId {
    // Count alive
    let tAlive = 0;
    let ctAlive = 0;

    for (const player of this.state.players.values()) {
      if (player.isAlive) {
        if (player.team === 'T') tAlive++;
        else if (player.team === 'CT') ctAlive++;
      }
    }

    for (const bot of this.state.bots.values()) {
      if (bot.isAlive) {
        if (bot.team === 'T') tAlive++;
        else if (bot.team === 'CT') ctAlive++;
      }
    }

    if (tAlive > ctAlive) return 'T';
    return 'CT'; // CT wins ties
  }

  private respawnPlayer(player: ServerPlayerState): void {
    const spawn = this.getSpawnPoint(player.team);
    player.position = { ...spawn.position, y: spawn.position.y + PLAYER_EYE_HEIGHT };
    player.velocity = createVec3();
    player.yaw = spawn.angle;
    player.pitch = 0;
    player.health = 100;
    player.armor = 0;
    player.isAlive = true;

    // Reset weapons
    player.weapons = new Map([
      [2, { type: 'pistol', currentAmmo: 12, reserveAmmo: 36, isReloading: false, reloadStartTime: 0, lastFireTime: 0 }],
      [3, { type: 'knife', currentAmmo: Infinity, reserveAmmo: Infinity, isReloading: false, reloadStartTime: 0, lastFireTime: 0 }],
    ]);
    player.currentWeapon = 'pistol';
  }

  private respawnBot(bot: ServerBotState): void {
    const spawn = this.getSpawnPoint(bot.team);
    bot.position = { ...spawn.position, y: spawn.position.y + PLAYER_EYE_HEIGHT };
    bot.velocity = createVec3();
    bot.yaw = spawn.angle;
    bot.pitch = 0;
    bot.health = 100;
    bot.armor = 0;
    bot.isAlive = true;
    bot.currentWeapon = 'pistol';
    bot.targetId = null;
    bot.lastTargetSeen = 0;
    bot.wanderAngle = spawn.angle;
    bot.nextFireTime = 0;
  }

  private updatePlayer(player: ServerPlayerState, deltaTime: number, now: number): void {
    if (!player.isAlive) return;

    // Apply gravity
    player.velocity.y -= GRAVITY * deltaTime;
    player.position.y += player.velocity.y * deltaTime;

    // Ground collision
    if (player.position.y < PLAYER_EYE_HEIGHT) {
      player.position.y = PLAYER_EYE_HEIGHT;
      player.velocity.y = 0;
    }

    // Clamp to map bounds
    player.position.x = Math.max(
      this.mapData.bounds.min.x + PLAYER_RADIUS,
      Math.min(this.mapData.bounds.max.x - PLAYER_RADIUS, player.position.x)
    );
    player.position.z = Math.max(
      this.mapData.bounds.min.z + PLAYER_RADIUS,
      Math.min(this.mapData.bounds.max.z - PLAYER_RADIUS, player.position.z)
    );
  }

  private updateBot(bot: ServerBotState, deltaTime: number, now: number): void {
    if (!bot.isAlive) return;

    // Apply gravity
    bot.velocity.y -= GRAVITY * deltaTime;
    bot.position.y += bot.velocity.y * deltaTime;

    if (bot.position.y < PLAYER_EYE_HEIGHT) {
      bot.position.y = PLAYER_EYE_HEIGHT;
      bot.velocity.y = 0;
    }

    // Simple AI: find and attack enemies
    const target = this.findBotTarget(bot);
    if (target) {
      bot.targetId = target.id;
      bot.lastTargetSeen = now;

      // Turn toward target
      const toTarget = vec3Sub(target.position, bot.position);
      const targetYaw = Math.atan2(-toTarget.x, -toTarget.z);
      const targetPitch = Math.atan2(toTarget.y, Math.sqrt(toTarget.x * toTarget.x + toTarget.z * toTarget.z));

      // Smooth turn
      const turnSpeed = 3 * deltaTime;
      let yawDiff = targetYaw - bot.yaw;
      while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
      while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
      bot.yaw += yawDiff * turnSpeed;
      bot.pitch += (targetPitch - bot.pitch) * turnSpeed;

      // Move toward target if far away
      const dist = vec3Length(toTarget);
      if (dist > 10) {
        const moveDir = vec3Normalize({ x: toTarget.x, y: 0, z: toTarget.z });
        const speed = PLAYER_MOVE_SPEED * 0.7 * deltaTime;
        bot.position = vec3Add(bot.position, vec3Scale(moveDir, speed));
      }

      // Fire at target
      if (now >= bot.nextFireTime && dist < 50) {
        this.botFire(bot, target, now);
      }
    } else {
      // Wander
      bot.wanderAngle += (Math.random() - 0.5) * deltaTime;
      const wanderDir = {
        x: -Math.sin(bot.wanderAngle),
        y: 0,
        z: -Math.cos(bot.wanderAngle),
      };
      const speed = PLAYER_MOVE_SPEED * 0.3 * deltaTime;
      bot.position = vec3Add(bot.position, vec3Scale(wanderDir, speed));
      bot.yaw = bot.wanderAngle;
    }

    // Clamp to map bounds
    bot.position.x = Math.max(
      this.mapData.bounds.min.x + PLAYER_RADIUS,
      Math.min(this.mapData.bounds.max.x - PLAYER_RADIUS, bot.position.x)
    );
    bot.position.z = Math.max(
      this.mapData.bounds.min.z + PLAYER_RADIUS,
      Math.min(this.mapData.bounds.max.z - PLAYER_RADIUS, bot.position.z)
    );
  }

  private findBotTarget(bot: ServerBotState): { id: string; position: Vec3 } | null {
    let closestDist = Infinity;
    let closest: { id: string; position: Vec3 } | null = null;

    // Check players
    for (const player of this.state.players.values()) {
      if (!player.isAlive || player.team === bot.team) continue;
      const dist = vec3Distance(bot.position, player.position);
      if (dist < closestDist) {
        closestDist = dist;
        closest = { id: player.id, position: player.position };
      }
    }

    // Check other bots
    for (const otherBot of this.state.bots.values()) {
      if (!otherBot.isAlive || otherBot.team === bot.team || otherBot.id === bot.id) continue;
      const dist = vec3Distance(bot.position, otherBot.position);
      if (dist < closestDist) {
        closestDist = dist;
        closest = { id: otherBot.id, position: otherBot.position };
      }
    }

    return closest;
  }

  private botFire(bot: ServerBotState, target: { id: string; position: Vec3 }, now: number): void {
    // Get bot accuracy based on difficulty
    let accuracy: number;
    let reactionTime: number;

    switch (bot.difficulty) {
      case 'easy':
        accuracy = BOT_ACCURACY_EASY;
        reactionTime = BOT_REACTION_TIME_EASY;
        break;
      case 'medium':
        accuracy = BOT_ACCURACY_MEDIUM;
        reactionTime = BOT_REACTION_TIME_MEDIUM;
        break;
      case 'hard':
        accuracy = BOT_ACCURACY_HARD;
        reactionTime = BOT_REACTION_TIME_HARD;
        break;
    }

    const def = WEAPON_DEFS[bot.currentWeapon];
    bot.nextFireTime = now + reactionTime + (60000 / def.fireRate);

    // Broadcast fire event
    const direction = this.getAimDirection({ position: bot.position, yaw: bot.yaw, pitch: bot.pitch }, def.spread);
    this.broadcast({
      type: 'fire_event',
      event: {
        playerId: bot.id,
        origin: bot.position,
        direction,
        weapon: bot.currentWeapon,
      },
    });

    // Check if hit (simplified - uses accuracy check)
    if (Math.random() < accuracy) {
      const dist = vec3Distance(bot.position, target.position);
      if (dist <= def.range) {
        const isHeadshot = Math.random() < 0.1;
        const damage = isHeadshot ? def.damage * def.headshotMultiplier : def.damage;

        // Find and damage target
        const targetPlayer = this.state.players.get(target.id);
        if (targetPlayer) {
          this.damagePlayer(targetPlayer, damage, isHeadshot, bot.id, bot.name, bot.currentWeapon);
        }

        const targetBot = this.state.bots.get(target.id);
        if (targetBot) {
          this.damageBot(targetBot, damage, isHeadshot, bot.id, bot.name, bot.currentWeapon);
        }
      }
    }
  }

  private updateReloads(now: number): void {
    for (const player of this.state.players.values()) {
      for (const weapon of player.weapons.values()) {
        if (weapon.isReloading) {
          const def = WEAPON_DEFS[weapon.type];
          if (now - weapon.reloadStartTime >= def.reloadTime * 1000) {
            const ammoNeeded = def.magazineSize - weapon.currentAmmo;
            const ammoToAdd = Math.min(ammoNeeded, weapon.reserveAmmo);
            weapon.currentAmmo += ammoToAdd;
            weapon.reserveAmmo -= ammoToAdd;
            weapon.isReloading = false;
          }
        }
      }
    }
  }

  // ============ Combat ============

  private performHitDetection(
    attacker: ServerPlayerState,
    direction: Vec3,
    weaponDef: typeof WEAPON_DEFS[WeaponType]
  ): void {
    // Check against all enemies
    for (const player of this.state.players.values()) {
      if (!player.isAlive || player.team === attacker.team) continue;
      const hit = this.checkRayHit(attacker.position, direction, player.position, weaponDef.range);
      if (hit) {
        const damage = hit.isHeadshot
          ? weaponDef.damage * weaponDef.headshotMultiplier
          : weaponDef.damage;
        this.damagePlayer(player, damage, hit.isHeadshot, attacker.id, attacker.name, attacker.currentWeapon);
      }
    }

    for (const bot of this.state.bots.values()) {
      if (!bot.isAlive || bot.team === attacker.team) continue;
      const hit = this.checkRayHit(attacker.position, direction, bot.position, weaponDef.range);
      if (hit) {
        const damage = hit.isHeadshot
          ? weaponDef.damage * weaponDef.headshotMultiplier
          : weaponDef.damage;
        this.damageBot(bot, damage, hit.isHeadshot, attacker.id, attacker.name, attacker.currentWeapon);
      }
    }
  }

  private checkRayHit(
    origin: Vec3,
    direction: Vec3,
    targetPos: Vec3,
    maxDist: number
  ): { isHeadshot: boolean } | null {
    // Simplified ray-sphere intersection
    const toTarget = vec3Sub(targetPos, origin);
    const dist = vec3Length(toTarget);
    if (dist > maxDist) return null;

    // Project target onto ray
    const dot = toTarget.x * direction.x + toTarget.y * direction.y + toTarget.z * direction.z;
    if (dot < 0) return null;

    // Check distance from ray to target
    const closestPoint = vec3Add(origin, vec3Scale(direction, dot));
    const distToRay = vec3Distance(closestPoint, targetPos);

    if (distToRay < PLAYER_RADIUS * 2) {
      // Hit! Check if headshot (target y is close to head height)
      const hitY = closestPoint.y - (targetPos.y - PLAYER_EYE_HEIGHT);
      const isHeadshot = hitY > 1.5;
      return { isHeadshot };
    }

    return null;
  }

  private damagePlayer(
    player: ServerPlayerState,
    damage: number,
    isHeadshot: boolean,
    attackerId: string,
    attackerName: string,
    weapon: WeaponType
  ): void {
    // Apply armor absorption
    let actualDamage = damage;
    if (player.armor > 0) {
      const absorbed = Math.min(player.armor, damage * 0.5);
      player.armor -= absorbed;
      actualDamage = damage - absorbed * 0.5;
    }

    player.health -= actualDamage;

    this.broadcast({
      type: 'hit_event',
      event: {
        attackerId,
        victimId: player.id,
        damage: actualDamage,
        headshot: isHeadshot,
      },
    });

    if (player.health <= 0) {
      player.health = 0;
      player.isAlive = false;
      player.deaths++;

      // Award kill to attacker
      const attackerPlayer = this.state.players.get(attackerId);
      if (attackerPlayer) {
        attackerPlayer.kills++;
        attackerPlayer.money = Math.min(
          attackerPlayer.money + DEFAULT_ECONOMY_CONFIG.killReward[weapon],
          DEFAULT_ECONOMY_CONFIG.maxMoney
        );
      }
      const attackerBot = this.state.bots.get(attackerId);
      if (attackerBot) {
        attackerBot.kills++;
      }

      this.broadcast({
        type: 'kill_event',
        event: {
          killerId: attackerId,
          killerName: attackerName,
          victimId: player.id,
          victimName: player.name,
          weapon,
          headshot: isHeadshot,
        },
      });
    }
  }

  private damageBot(
    bot: ServerBotState,
    damage: number,
    isHeadshot: boolean,
    attackerId: string,
    attackerName: string,
    weapon: WeaponType
  ): void {
    let actualDamage = damage;
    if (bot.armor > 0) {
      const absorbed = Math.min(bot.armor, damage * 0.5);
      bot.armor -= absorbed;
      actualDamage = damage - absorbed * 0.5;
    }

    bot.health -= actualDamage;

    this.broadcast({
      type: 'hit_event',
      event: {
        attackerId,
        victimId: bot.id,
        damage: actualDamage,
        headshot: isHeadshot,
      },
    });

    if (bot.health <= 0) {
      bot.health = 0;
      bot.isAlive = false;
      bot.deaths++;

      const attackerPlayer = this.state.players.get(attackerId);
      if (attackerPlayer) {
        attackerPlayer.kills++;
        attackerPlayer.money = Math.min(
          attackerPlayer.money + DEFAULT_ECONOMY_CONFIG.killReward[weapon],
          DEFAULT_ECONOMY_CONFIG.maxMoney
        );
      }
      const attackerBot = this.state.bots.get(attackerId);
      if (attackerBot) {
        attackerBot.kills++;
      }

      this.broadcast({
        type: 'kill_event',
        event: {
          killerId: attackerId,
          killerName: attackerName,
          victimId: bot.id,
          victimName: bot.name,
          weapon,
          headshot: isHeadshot,
        },
      });
    }
  }

  // ============ Broadcasting ============

  private broadcastState(): void {
    const snapshot = this.createSnapshot();
    this.broadcast({
      type: 'game_state',
      state: snapshot,
    });
    this.state.lastBroadcastTick = this.state.tick;
  }

  private createSnapshot(): GameStateSnapshot {
    const now = Date.now();
    const elapsed = (now - this.state.phaseStartTime) / 1000;

    let roundTime = ROUND_TIME;
    let freezeTime = 0;

    if (this.state.phase === 'freeze') {
      freezeTime = (this.roomConfig.mode === 'competitive' ? FREEZE_TIME_COMP : FREEZE_TIME_DM) - elapsed;
    } else if (this.state.phase === 'live') {
      roundTime = ROUND_TIME - elapsed;
    }

    const players: PlayerSnapshot[] = [];
    for (const player of this.state.players.values()) {
      players.push({
        id: player.id,
        name: player.name,
        position: player.position,
        yaw: player.yaw,
        pitch: player.pitch,
        health: player.health,
        armor: player.armor,
        team: player.team,
        isAlive: player.isAlive,
        currentWeapon: player.currentWeapon,
        money: player.money,
        kills: player.kills,
        deaths: player.deaths,
      });
    }

    const bots: BotSnapshot[] = [];
    for (const bot of this.state.bots.values()) {
      bots.push({
        id: bot.id,
        name: bot.name,
        position: bot.position,
        yaw: bot.yaw,
        pitch: bot.pitch,
        health: bot.health,
        armor: bot.armor,
        team: bot.team,
        isAlive: bot.isAlive,
        currentWeapon: bot.currentWeapon,
        kills: bot.kills,
        deaths: bot.deaths,
      });
    }

    const droppedWeapons: DroppedWeaponSnapshot[] = [];
    for (const weapon of this.state.droppedWeapons.values()) {
      droppedWeapons.push({
        id: weapon.id,
        weaponType: weapon.weaponType,
        position: weapon.position,
      });
    }

    return {
      tick: this.state.tick,
      timestamp: now,
      phase: this.state.phase,
      roundTime: Math.max(0, roundTime),
      freezeTime: Math.max(0, freezeTime),
      players,
      bots,
      droppedWeapons,
      tScore: this.state.tScore,
      ctScore: this.state.ctScore,
      roundNumber: this.state.roundNumber,
    };
  }

  private broadcastPhaseChange(): void {
    this.broadcast({
      type: 'phase_change',
      phase: this.state.phase,
      roundNumber: this.state.roundNumber,
      tScore: this.state.tScore,
      ctScore: this.state.ctScore,
    });
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

    // Pick random spawn
    const idx = Math.floor(Math.random() * validSpawns.length);
    const spawn = validSpawns[idx];
    const originalIdx = this.mapData.spawnPoints.indexOf(spawn);
    this.usedSpawns.add(originalIdx);

    return spawn;
  }

  private getAimDirection(
    entity: { position: Vec3; yaw: number; pitch: number },
    spread: number
  ): Vec3 {
    const spreadRad = (spread * Math.PI) / 180;
    const randomYaw = (Math.random() - 0.5) * spreadRad;
    const randomPitch = (Math.random() - 0.5) * spreadRad;

    return vec3Normalize({
      x: -Math.sin(entity.yaw + randomYaw) * Math.cos(entity.pitch + randomPitch),
      y: Math.sin(entity.pitch + randomPitch),
      z: -Math.cos(entity.yaw + randomYaw) * Math.cos(entity.pitch + randomPitch),
    });
  }

  private getWeaponSlot(type: WeaponType): number {
    return WEAPON_DEFS[type].slot;
  }
}
