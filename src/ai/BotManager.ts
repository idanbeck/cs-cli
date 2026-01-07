// Bot manager - handles spawning, updating, and rendering bots
import { Vector3 } from '../engine/math/Vector3.js';
import { Bot, BotDifficulty } from './Bot.js';
import { BotBrain, BotThinkContext } from './BotBrain.js';
import { Player } from '../game/Player.js';
import { AABB } from '../maps/MapFormat.js';
import { SpawnPoint } from '../maps/MapFormat.js';
import { rayAABBIntersection } from '../physics/Collision.js';
import { TeamId, getTeamManager } from '../game/Team.js';
import { getDroppedWeaponManager } from '../game/DroppedWeapon.js';

// Callback for tracer spawning
export type TracerCallback = (origin: Vector3, endpoint: Vector3) => void;
// Callback for kill registration
export type KillCallback = (killerName: string, victimName: string, weaponName: string, headshot: boolean) => void;
// Callback for player damage (for damage direction indicator)
export type PlayerDamageCallback = (attackerPos: Vector3, damage: number, headshot: boolean) => void;
// Callback for bot sounds (shooting, hits, deaths)
export type BotSoundCallback = (soundType: string, position: Vector3) => void;

export class BotManager {
  private bots: Bot[] = [];
  private spawnPoints: Vector3[] = [];
  private tSpawnPoints: Vector3[] = [];
  private ctSpawnPoints: Vector3[] = [];
  private respawnDelay: number = 3000; // ms
  private respawnEnabled: boolean = true; // Disable for round-based mode
  private onTracerSpawn: TracerCallback | null = null;
  private onKill: KillCallback | null = null;
  private onPlayerDamage: PlayerDamageCallback | null = null;
  private onBotSound: BotSoundCallback | null = null;

  constructor() {}

  // Set tracer callback
  setTracerCallback(callback: TracerCallback): void {
    this.onTracerSpawn = callback;
  }

  // Set kill callback
  setKillCallback(callback: KillCallback): void {
    this.onKill = callback;
  }

  // Set player damage callback
  setPlayerDamageCallback(callback: PlayerDamageCallback): void {
    this.onPlayerDamage = callback;
  }

  // Set bot sound callback
  setBotSoundCallback(callback: BotSoundCallback): void {
    this.onBotSound = callback;
  }

  // Initialize with spawn points from map
  setSpawnPoints(spawns: SpawnPoint[]): void {
    this.spawnPoints = spawns.map(s => new Vector3(s.position[0], s.position[1], s.position[2]));
  }

  // Set spawn points by team
  setTeamSpawnPoints(spawns: SpawnPoint[]): void {
    this.tSpawnPoints = [];
    this.ctSpawnPoints = [];
    this.spawnPoints = [];

    for (const s of spawns) {
      const pos = new Vector3(s.position[0], s.position[1], s.position[2]);
      if (s.team === 'T') {
        this.tSpawnPoints.push(pos);
      } else if (s.team === 'CT') {
        this.ctSpawnPoints.push(pos);
      } else {
        // DM spawns go to both
        this.spawnPoints.push(pos);
        this.tSpawnPoints.push(pos);
        this.ctSpawnPoints.push(pos);
      }
    }
  }

  // Enable/disable automatic respawns (disable for round-based)
  setRespawnEnabled(enabled: boolean): void {
    this.respawnEnabled = enabled;
  }

  // Get spawn points for a team
  getSpawnPointsForTeam(team: TeamId): Vector3[] {
    if (team === 'T') return this.tSpawnPoints.length > 0 ? this.tSpawnPoints : this.spawnPoints;
    if (team === 'CT') return this.ctSpawnPoints.length > 0 ? this.ctSpawnPoints : this.spawnPoints;
    return this.spawnPoints;
  }

  // Assign bots to teams (balances between T and CT)
  assignBotsToTeams(playerName: string): void {
    const teamManager = getTeamManager();
    const botNames = this.bots.map(b => b.name);

    // Auto-balance teams (player + bots)
    teamManager.autoBalance(playerName, botNames);

    // Update bot team assignments
    for (const bot of this.bots) {
      const team = teamManager.getTeam(bot.name);
      if (team) {
        bot.team = team;
      }
    }
  }

  // Execute buy phase for all bots
  executeBotBuyPhase(): void {
    for (const bot of this.bots) {
      if (bot.isAlive) {
        bot.executeBuyPhase();
      }
    }
  }

  // Respawn all bots for a new round
  respawnAllBots(now: number): void {
    for (const bot of this.bots) {
      const spawnPoints = this.getSpawnPointsForTeam(bot.team);
      if (spawnPoints.length > 0) {
        const spawnIndex = Math.floor(Math.random() * spawnPoints.length);
        const spawn = spawnPoints[spawnIndex];
        // keepInventory = true if bot was alive, false if dead
        bot.respawn(spawn, Math.random() * Math.PI * 2, bot.isAlive);
        bot.setState('idle', now);
      }
    }
  }

  // Reset bots for a new match (reset economy, inventory)
  resetBotsForMatch(): void {
    for (const bot of this.bots) {
      bot.economy.resetForMatch();
      bot.resetInventory();
      bot.kills = 0;
      bot.deaths = 0;
    }
  }

  // Award round end money to all bots
  awardBotRoundMoney(winningTeam: TeamId): void {
    for (const bot of this.bots) {
      if (bot.team === winningTeam) {
        bot.economy.awardRoundWin();
      } else {
        bot.economy.awardRoundLoss();
      }
    }
  }

  // Handle bot death with weapon drops
  handleBotDeathWithDrops(bot: Bot, now: number): void {
    if (!bot.isAlive) return;

    // Drop weapons before dying
    bot.dropAllWeapons(now);

    // Mark as dead (don't call die() as it increments deaths, which is done elsewhere)
    bot.isAlive = false;
    bot.setState('dead', now);

    // Play death sound
    if (this.onBotSound) {
      this.onBotSound('bot_death', bot.position);
    }
  }

  // Get alive count per team
  getAliveCountByTeam(): { T: number; CT: number } {
    let t = 0, ct = 0;
    for (const bot of this.bots) {
      if (bot.isAlive) {
        if (bot.team === 'T') t++;
        else if (bot.team === 'CT') ct++;
      }
    }
    return { T: t, CT: ct };
  }

  // Spawn a new bot
  spawnBot(difficulty: BotDifficulty = 'medium'): Bot {
    const bot = new Bot(difficulty);

    // Pick a random spawn point
    if (this.spawnPoints.length > 0) {
      const spawnIndex = Math.floor(Math.random() * this.spawnPoints.length);
      const spawn = this.spawnPoints[spawnIndex];
      bot.position = new Vector3(spawn.x, spawn.y + bot.config.eyeHeight, spawn.z);
      bot.yaw = Math.random() * Math.PI * 2;
    }

    // Give bot a weapon (pistol by default, random chance for rifle)
    bot.giveWeapon('pistol');
    if (Math.random() > 0.5) {
      bot.giveWeapon('rifle');
      bot.selectWeapon(1); // Rifle is slot 1
    } else {
      bot.selectWeapon(2); // Pistol is slot 2
    }

    // Set patrol route using spawn points as waypoints
    bot.setPatrolRoute(this.spawnPoints);

    // Start in patrol state
    bot.setState('patrol', performance.now());

    this.bots.push(bot);
    return bot;
  }

  // Spawn multiple bots
  spawnBots(count: number, difficulty: BotDifficulty = 'medium'): void {
    for (let i = 0; i < count; i++) {
      this.spawnBot(difficulty);
    }
  }

  // Get all bots
  getBots(): Bot[] {
    return this.bots;
  }

  // Get alive bots
  getAliveBots(): Bot[] {
    return this.bots.filter(b => b.isAlive);
  }

  // Update all bots
  update(
    player: Player,
    colliders: AABB[],
    now: number,
    deltaTime: number,
    isFrozen: boolean = false,
    teamMode: boolean = false
  ): void {
    const ctx: BotThinkContext = {
      player,
      allBots: this.bots,
      colliders,
      now,
      deltaTime,
      isFrozen,
      teamMode,
    };

    for (const bot of this.bots) {
      if (!bot.isAlive) {
        // Handle respawn (only if enabled)
        if (this.respawnEnabled) {
          this.handleRespawn(bot, now);
        }
        continue;
      }

      // Run AI and get new position
      const newPos = BotBrain.think(bot, ctx);
      if (newPos.x !== 0 || newPos.y !== 0 || newPos.z !== 0) {
        bot.position = newPos;
      }

      // Snap bot to ground using raycast (prevent clipping)
      this.snapToGround(bot, colliders);

      // Update weapon state
      bot.updateWeapon(now);

      // Handle bot shooting (check if bot just fired) - only if not frozen
      if (!isFrozen && bot.lastFireTime === now) {
        this.handleBotShot(bot, player, colliders, now, teamMode);
      }
    }
  }

  // Snap bot to ground to prevent clipping
  private snapToGround(bot: Bot, colliders: AABB[]): void {
    const eyePos = bot.position;
    const feetY = eyePos.y - bot.config.eyeHeight;

    // Raycast down from above the bot to find ground
    const rayOrigin = new Vector3(eyePos.x, eyePos.y + 2.0, eyePos.z);
    const rayDir = new Vector3(0, -1, 0);

    let groundY = 0; // Default to world floor at y=0

    // Check for any platform/collider below the bot
    for (const collider of colliders) {
      const result = rayAABBIntersection(rayOrigin, rayDir, collider);
      if (result.hit) {
        const hitY = result.point.y;
        // Find the highest surface that's at or below where feet should be
        if (hitY > groundY && hitY <= feetY + 0.3) {
          groundY = hitY;
        }
      }
    }

    // Calculate where bot's eyes should be based on ground
    const targetEyeY = groundY + bot.config.eyeHeight;

    // Always enforce minimum height (can't be below world floor)
    const minEyeY = bot.config.eyeHeight; // Eyes at eyeHeight when feet at y=0

    // If bot is below where it should be, snap up
    if (eyePos.y < minEyeY) {
      bot.position.y = minEyeY;
    }
    // If close to a valid ground surface, snap to it
    else if (Math.abs(feetY - groundY) < 0.5) {
      bot.position.y = targetEyeY;
    }
  }

  // Handle a bot shooting - check hits and spawn tracers
  private handleBotShot(bot: Bot, player: Player, colliders: AABB[], now: number, teamMode: boolean = false): void {
    const weapon = bot.getCurrentWeapon();
    if (!weapon) return;

    const target = bot.target;
    if (!target || !target.isAlive) return;

    // In team mode, don't shoot teammates
    if (teamMode && !bot.isEnemy(target)) return;

    const origin = bot.getEyePosition();
    const targetPos = target.getEyePosition();
    const direction = bot.getAimDirectionWithAccuracy(targetPos);
    const maxRange = weapon.def.range;

    // Play weapon sound at bot position
    if (this.onBotSound) {
      const weaponType = weapon.def.type;
      if (weaponType === 'pistol') this.onBotSound('shoot_pistol', bot.position);
      else if (weaponType === 'rifle') this.onBotSound('shoot_rifle', bot.position);
      else if (weaponType === 'shotgun') this.onBotSound('shoot_shotgun', bot.position);
      else if (weaponType === 'sniper') this.onBotSound('shoot_sniper', bot.position);
    }

    // Check what we hit (walls first for endpoint calculation)
    let wallHitPoint: Vector3 | null = null;
    let wallHitDist = maxRange;

    for (const collider of colliders) {
      const result = rayAABBIntersection(origin, direction, collider);
      if (result.hit && result.distance < wallHitDist) {
        wallHitDist = result.distance;
        wallHitPoint = result.point;
      }
    }

    // Determine tracer endpoint
    let tracerEnd = wallHitPoint || Vector3.add(origin, Vector3.scale(direction, maxRange));

    // Check if we hit the target
    let hitTarget = false;
    let headshot = false;

    // Check body hit
    const bodyRadius = 0.4;
    const chestPos = new Vector3(
      target.position.x,
      target.position.y - 0.3,
      target.position.z
    );
    const bodyHit = this.raySphereIntersection(origin, direction, chestPos, bodyRadius);

    if (bodyHit && bodyHit.distance <= maxRange && bodyHit.distance < wallHitDist) {
      hitTarget = true;
      tracerEnd = Vector3.add(origin, Vector3.scale(direction, bodyHit.distance));
    }

    // Check head hit
    const headRadius = 0.2;
    const headHit = this.raySphereIntersection(origin, direction, target.getEyePosition(), headRadius);

    if (headHit && headHit.distance <= maxRange && headHit.distance < wallHitDist) {
      hitTarget = true;
      headshot = true;
      tracerEnd = Vector3.add(origin, Vector3.scale(direction, headHit.distance));
    }

    // Spawn tracer
    if (this.onTracerSpawn) {
      this.onTracerSpawn(origin, tracerEnd);
    }

    // Apply damage if hit
    if (hitTarget) {
      const damage = weapon.def.damage * (headshot ? weapon.def.headshotMultiplier : 1);
      const wasAlive = target.isAlive;
      target.takeDamage(damage, headshot);

      // Play hit sound at target position (for bot vs bot)
      if (this.onBotSound && target !== player) {
        this.onBotSound(headshot ? 'hit_headshot' : 'hit_enemy', target.position);
      }

      // Call player damage callback if target is the human player
      // (check if target is not a Bot - player doesn't have botConfig)
      if (this.onPlayerDamage && target === player) {
        this.onPlayerDamage(bot.position, damage, headshot);
      }

      // Check for kill
      if (wasAlive && !target.isAlive) {
        // Award kill to the bot
        bot.kills++;

        // Play death sound at target position
        if (this.onBotSound) {
          this.onBotSound('bot_death', target.position);
        }

        // Call kill callback
        if (this.onKill) {
          this.onKill(bot.name, target.name, weapon.def.name, headshot);
        }
      }
    }
  }

  // Handle bot respawn
  private handleRespawn(bot: Bot, now: number): void {
    // Check if enough time has passed since death
    // (using stateStartTime as death time)
    if (now - bot.stateStartTime > this.respawnDelay) {
      // Respawn at random spawn point
      if (this.spawnPoints.length > 0) {
        const spawnIndex = Math.floor(Math.random() * this.spawnPoints.length);
        const spawn = this.spawnPoints[spawnIndex];
        bot.respawn(spawn, Math.random() * Math.PI * 2);
        bot.setState('idle', now);
      }
    }
  }

  // Check if player shot hits any bot, returns hit bot and damage
  checkPlayerHit(
    origin: Vector3,
    direction: Vector3,
    damage: number,
    maxRange: number
  ): { bot: Bot; distance: number; headshot: boolean } | null {
    let closestHit: { bot: Bot; distance: number; headshot: boolean } | null = null;

    for (const bot of this.bots) {
      if (!bot.isAlive) continue;

      // Simple sphere collision for body
      const bodyRadius = 0.4;
      const headRadius = 0.2;

      // Check body hit (centered at chest height)
      const chestPos = new Vector3(
        bot.position.x,
        bot.position.y - 0.3, // Chest is below eye level
        bot.position.z
      );

      const bodyHit = this.raySphereIntersection(origin, direction, chestPos, bodyRadius);
      if (bodyHit && bodyHit.distance <= maxRange) {
        if (!closestHit || bodyHit.distance < closestHit.distance) {
          closestHit = { bot, distance: bodyHit.distance, headshot: false };
        }
      }

      // Check head hit
      const headPos = bot.getEyePosition();
      const headHit = this.raySphereIntersection(origin, direction, headPos, headRadius);
      if (headHit && headHit.distance <= maxRange) {
        if (!closestHit || headHit.distance < closestHit.distance) {
          closestHit = { bot, distance: headHit.distance, headshot: true };
        }
      }
    }

    return closestHit;
  }

  // Ray-sphere intersection
  private raySphereIntersection(
    origin: Vector3,
    direction: Vector3,
    center: Vector3,
    radius: number
  ): { distance: number } | null {
    const oc = Vector3.sub(origin, center);
    const a = Vector3.dot(direction, direction);
    const b = 2 * Vector3.dot(oc, direction);
    const c = Vector3.dot(oc, oc) - radius * radius;
    const discriminant = b * b - 4 * a * c;

    if (discriminant < 0) return null;

    const t = (-b - Math.sqrt(discriminant)) / (2 * a);
    if (t < 0) return null;

    return { distance: t };
  }

  // Check if bot shot hits player
  checkBotHitPlayer(
    bot: Bot,
    player: Player,
    maxRange: number
  ): { hit: boolean; headshot: boolean; distance: number } | null {
    if (!player.isAlive) return null;

    const origin = bot.getEyePosition();
    const targetPos = player.getEyePosition();
    const direction = bot.getAimDirectionWithAccuracy(targetPos);

    // Check body
    const bodyRadius = 0.4;
    const chestPos = new Vector3(
      player.position.x,
      player.position.y - 0.3,
      player.position.z
    );

    const bodyHit = this.raySphereIntersection(origin, direction, chestPos, bodyRadius);
    if (bodyHit && bodyHit.distance <= maxRange) {
      return { hit: true, headshot: false, distance: bodyHit.distance };
    }

    // Check head
    const headRadius = 0.2;
    const headHit = this.raySphereIntersection(origin, direction, player.getEyePosition(), headRadius);
    if (headHit && headHit.distance <= maxRange) {
      return { hit: true, headshot: true, distance: headHit.distance };
    }

    return null;
  }

  // Remove all bots
  clear(): void {
    this.bots = [];
  }
}
