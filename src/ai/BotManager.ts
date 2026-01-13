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
import { adjustSpawnPosition, getGlobalCollisionMesh, raycastMesh, generateBlueNoiseSpawns, getSpawnFarFromEntities } from '../physics/MeshCollision.js';
import { debugLog } from '../utils/FileLogger.js';

// Callback for tracer spawning
export type TracerCallback = (origin: Vector3, endpoint: Vector3) => void;
// Callback for kill registration
export type KillCallback = (killerName: string, victimName: string, weaponName: string, headshot: boolean) => void;
// Callback for player damage (for damage direction indicator and death screen)
export type PlayerDamageCallback = (attackerPos: Vector3, damage: number, headshot: boolean, attackerName: string, weaponName: string) => void;
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

    // First pass: collect dedicated T/CT spawns and gather DM spawns
    const dmSpawns: Vector3[] = [];

    for (const s of spawns) {
      const pos = new Vector3(s.position[0], s.position[1], s.position[2]);
      if (s.team === 'T') {
        this.tSpawnPoints.push(pos);
      } else if (s.team === 'CT') {
        this.ctSpawnPoints.push(pos);
      } else {
        // DM spawns collected separately
        this.spawnPoints.push(pos);
        dmSpawns.push(pos);
      }
    }

    // If we have dedicated T/CT spawns, don't use DM spawns for teams
    // If we only have DM spawns, split them geographically between teams
    if (this.tSpawnPoints.length === 0 && this.ctSpawnPoints.length === 0 && dmSpawns.length > 0) {
      // Sort DM spawns by X coordinate to geographically split them
      const sorted = [...dmSpawns].sort((a, b) => a.x - b.x);
      const midpoint = Math.ceil(sorted.length / 2);

      // First half goes to T, second half goes to CT
      for (let i = 0; i < sorted.length; i++) {
        if (i < midpoint) {
          this.tSpawnPoints.push(sorted[i]);
        } else {
          this.ctSpawnPoints.push(sorted[i]);
        }
      }
      console.log(`[BotManager] Split ${dmSpawns.length} DM spawns: T=${this.tSpawnPoints.length}, CT=${this.ctSpawnPoints.length}`);
    } else {
      console.log(`[BotManager] Team spawns: T=${this.tSpawnPoints.length}, CT=${this.ctSpawnPoints.length}, DM=${dmSpawns.length}`);
      // Log first spawn of each team for debugging
      if (this.tSpawnPoints.length > 0) {
        const t = this.tSpawnPoints[0];
        console.log(`[BotManager] T spawn example: ${t.x.toFixed(1)}, ${t.z.toFixed(1)}`);
      }
      if (this.ctSpawnPoints.length > 0) {
        const ct = this.ctSpawnPoints[0];
        console.log(`[BotManager] CT spawn example: ${ct.x.toFixed(1)}, ${ct.z.toFixed(1)}`);
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

  // Get a spawn point that's far from all given positions
  // Returns the spawn point with the maximum minimum distance to any entity
  getSpreadSpawnPoint(spawnPoints: Vector3[], avoidPositions: Vector3[]): Vector3 {
    const result = this.getSpreadSpawnPointWithDistance(spawnPoints, avoidPositions);
    return result.spawn;
  }

  // Get a spawn point that's far from all given positions, also returns the distance
  // Returns the spawn point with the maximum minimum distance to any entity
  getSpreadSpawnPointWithDistance(spawnPoints: Vector3[], avoidPositions: Vector3[]): { spawn: Vector3; distance: number } {
    if (spawnPoints.length === 0) {
      return { spawn: new Vector3(0, 0, 0), distance: 0 };
    }

    if (avoidPositions.length === 0) {
      // No positions to avoid, pick random
      return {
        spawn: spawnPoints[Math.floor(Math.random() * spawnPoints.length)],
        distance: Infinity
      };
    }

    // Find the spawn with maximum minimum distance to any entity
    let bestSpawn = spawnPoints[0];
    let bestMinDist = -1;

    for (const spawn of spawnPoints) {
      // Find minimum distance from this spawn to any entity
      let minDist = Infinity;
      for (const pos of avoidPositions) {
        const dx = spawn.x - pos.x;
        const dz = spawn.z - pos.z;  // Use horizontal distance only
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < minDist) {
          minDist = dist;
        }
      }

      // If this spawn's minimum distance is greater, it's a better choice
      if (minDist > bestMinDist) {
        bestMinDist = minDist;
        bestSpawn = spawn;
      }
    }

    return { spawn: bestSpawn, distance: bestMinDist };
  }

  // Generate a random position within map bounds (uses spawn point bounds)
  getRandomMapPosition(spawnPoints: Vector3[]): Vector3 {
    if (spawnPoints.length === 0) {
      return new Vector3(0, 0, 0);
    }

    // Calculate bounds from spawn points
    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    let avgY = 0;

    for (const sp of spawnPoints) {
      minX = Math.min(minX, sp.x);
      maxX = Math.max(maxX, sp.x);
      minZ = Math.min(minZ, sp.z);
      maxZ = Math.max(maxZ, sp.z);
      avgY += sp.y;
    }
    avgY /= spawnPoints.length;

    // Add some padding to allow spawning outside spawn point area
    const padX = (maxX - minX) * 0.3;
    const padZ = (maxZ - minZ) * 0.3;

    // Random position within expanded bounds
    const x = minX - padX + Math.random() * (maxX - minX + 2 * padX);
    const z = minZ - padZ + Math.random() * (maxZ - minZ + 2 * padZ);

    return new Vector3(x, avgY, z);
  }

  // Get all entity positions (bots + optional player)
  getAllEntityPositions(includePlayer?: Player): Vector3[] {
    const positions: Vector3[] = [];
    for (const bot of this.bots) {
      if (bot.isAlive) {
        positions.push(bot.position.clone());
      }
    }
    if (includePlayer && includePlayer.isAlive) {
      positions.push(includePlayer.position.clone());
    }
    return positions;
  }

  // Assign bots to teams (balances between T and CT)
  assignBotsToTeams(playerName: string): void {
    const teamManager = getTeamManager();
    const botNames = this.bots.map(b => b.name);

    debugLog(`[BotManager] assignBotsToTeams: ${botNames.length} bots to assign`);

    // Auto-balance teams (player + bots)
    teamManager.autoBalance(playerName, botNames);

    // Update bot team assignments
    let tCount = 0, ctCount = 0;
    for (const bot of this.bots) {
      const team = teamManager.getTeam(bot.name);
      if (team) {
        bot.team = team;
        if (team === 'T') tCount++;
        else if (team === 'CT') ctCount++;
      }
    }
    debugLog(`[BotManager] assignBotsToTeams complete: T=${tCount}, CT=${ctCount}`);
  }

  // Execute buy phase for all bots
  executeBotBuyPhase(): void {
    for (const bot of this.bots) {
      if (bot.isAlive) {
        bot.executeBuyPhase();
      }
    }
  }

  // Track player's spawn point to exclude from bot spawning
  private playerSpawnPoint: Vector3 | null = null;

  // Set which spawn point the player used (call before respawnAllBots)
  setPlayerSpawnPoint(spawn: Vector3 | null): void {
    this.playerSpawnPoint = spawn ? spawn.clone() : null;
  }

  // Respawn all bots for a new round (with spread spawning)
  // CRITICAL: Each spawn point should only be used ONCE per team
  respawnAllBots(now: number, player?: Player): void {
    const collisionMesh = getGlobalCollisionMesh();

    // Separate bots by team
    const tBots = this.bots.filter(b => b.team === 'T');
    const ctBots = this.bots.filter(b => b.team === 'CT');

    debugLog(`[BotManager] respawnAllBots: totalBots=${this.bots.length}, T=${tBots.length}, CT=${ctBots.length}`);

    // Get COPIES of spawn points so we can remove used ones
    let availableTSpawns = [...this.tSpawnPoints];
    let availableCTSpawns = [...this.ctSpawnPoints];

    // Remove player's spawn point from their team's available spawns
    if (this.playerSpawnPoint && player) {
      const playerTeamSpawns = player.team === 'T' ? availableTSpawns : availableCTSpawns;
      const MIN_DIST = 2.0; // Consider spawns within 2 units as "same spawn"
      const idxToRemove = playerTeamSpawns.findIndex(sp => {
        const dx = sp.x - this.playerSpawnPoint!.x;
        const dz = sp.z - this.playerSpawnPoint!.z;
        return Math.sqrt(dx * dx + dz * dz) < MIN_DIST;
      });
      if (idxToRemove >= 0) {
        playerTeamSpawns.splice(idxToRemove, 1);
      }
    }

    // Track all used positions for spread calculation
    const usedPositions: Vector3[] = [];

    // Include player position if provided
    if (player && player.isAlive) {
      usedPositions.push(player.position.clone());
    }

    // Helper to spawn a bot at a unique position from available spawns
    const spawnBotAtUnique = (bot: Bot, availableSpawns: Vector3[]): void => {
      if (availableSpawns.length === 0) return;

      // Find best spawn (furthest from used positions)
      let bestIdx = 0;
      let bestMinDist = -1;

      for (let i = 0; i < availableSpawns.length; i++) {
        const spawn = availableSpawns[i];
        let minDist = Infinity;

        for (const pos of usedPositions) {
          const dx = spawn.x - pos.x;
          const dz = spawn.z - pos.z;
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist < minDist) minDist = dist;
        }

        if (minDist > bestMinDist) {
          bestMinDist = minDist;
          bestIdx = i;
        }
      }

      // Remove the chosen spawn from available list (prevent reuse!)
      const rawSpawn = availableSpawns.splice(bestIdx, 1)[0];

      // Adjust spawn position for BSP collision mesh
      let spawn: Vector3 = rawSpawn;
      if (collisionMesh && collisionMesh.triangles.length > 0) {
        const adjusted = adjustSpawnPosition(rawSpawn, collisionMesh);
        if (adjusted) spawn = adjusted;
      }

      usedPositions.push(spawn.clone());
      bot.respawn(spawn, Math.random() * Math.PI * 2, bot.isAlive);
    };

    // Spawn T bots at T spawns, patrol towards CT spawns
    for (const bot of tBots) {
      spawnBotAtUnique(bot, availableTSpawns);
      console.log(`[Spawn] Bot ${bot.name} (T) at: ${bot.position.x.toFixed(1)}, ${bot.position.z.toFixed(1)}`);
      // Set patrol route towards enemy spawns so bots hunt enemies
      bot.setPatrolRoute(this.ctSpawnPoints.length > 0 ? this.ctSpawnPoints : this.spawnPoints);
      bot.setState('patrol', now);
    }

    // Spawn CT bots at CT spawns, patrol towards T spawns
    for (const bot of ctBots) {
      spawnBotAtUnique(bot, availableCTSpawns);
      console.log(`[Spawn] Bot ${bot.name} (CT) at: ${bot.position.x.toFixed(1)}, ${bot.position.z.toFixed(1)}`);
      // Set patrol route towards enemy spawns so bots hunt enemies
      bot.setPatrolRoute(this.tSpawnPoints.length > 0 ? this.tSpawnPoints : this.spawnPoints);
      bot.setState('patrol', now);
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
  spawnBot(difficulty: BotDifficulty = 'medium', playerPos?: Vector3): Bot {
    const bot = new Bot(difficulty);

    // Pick a spawn point far from existing entities
    if (this.spawnPoints.length > 0) {
      // Collect positions of all existing bots and player
      const avoidPositions: Vector3[] = [];
      for (const existingBot of this.bots) {
        avoidPositions.push(existingBot.position.clone());
      }
      if (playerPos) {
        avoidPositions.push(playerPos.clone());
      }

      // Use spread spawning to find a spawn far from others
      const rawSpawn = this.getSpreadSpawnPoint(this.spawnPoints, avoidPositions);

      // Adjust spawn position for BSP collision mesh, trying alternatives if null
      const collisionMesh = getGlobalCollisionMesh();
      let spawn: Vector3 | null = null;
      if (collisionMesh && collisionMesh.triangles.length > 0) {
        spawn = adjustSpawnPosition(rawSpawn, collisionMesh);

        // If first choice is invalid, try other spawn points
        if (spawn === null) {
          for (const altSpawn of this.spawnPoints) {
            spawn = adjustSpawnPosition(altSpawn, collisionMesh);
            if (spawn !== null) break;
          }
        }

        // If still null, use raw spawn as fallback
        if (spawn === null) {
          spawn = rawSpawn;
        }
      } else {
        spawn = rawSpawn;
      }

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
  spawnBots(count: number, difficulty: BotDifficulty = 'medium', playerPos?: Vector3): void {
    const beforeCount = this.bots.length;
    for (let i = 0; i < count; i++) {
      this.spawnBot(difficulty, playerPos);
    }
    debugLog(`[BotManager] spawnBots: requested=${count}, before=${beforeCount}, after=${this.bots.length}`);
  }

  // Spawn multiple bots using blue noise distribution for even spacing
  // Use this for deathmatch initial spawns to spread players across the map
  spawnBotsWithBlueNoise(count: number, difficulty: BotDifficulty = 'medium', playerPos?: Vector3): void {
    const collisionMesh = getGlobalCollisionMesh();
    if (!collisionMesh || collisionMesh.triangles.length === 0 || this.spawnPoints.length === 0) {
      // Fall back to regular spawning
      this.spawnBots(count, difficulty, playerPos);
      return;
    }

    // Generate blue noise distributed spawn positions
    // Request extra spawns to account for player position
    const totalNeeded = count + (playerPos ? 1 : 0);
    const blueNoiseSpawns = generateBlueNoiseSpawns(
      this.spawnPoints,
      collisionMesh,
      totalNeeded + 5, // Extra buffer
      8.0 // Minimum spacing between spawns
    );

    if (blueNoiseSpawns.length === 0) {
      // Fall back to regular spawning
      this.spawnBots(count, difficulty, playerPos);
      return;
    }

    // Filter out spawns too close to player if provided
    let availableSpawns = blueNoiseSpawns;
    if (playerPos) {
      const MIN_PLAYER_DISTANCE = 10.0;
      availableSpawns = blueNoiseSpawns.filter(sp => {
        const dx = sp.x - playerPos.x;
        const dz = sp.z - playerPos.z;
        return dx * dx + dz * dz >= MIN_PLAYER_DISTANCE * MIN_PLAYER_DISTANCE;
      });

      // If we filtered too many, use all spawns sorted by distance from player
      if (availableSpawns.length < count) {
        availableSpawns = [...blueNoiseSpawns].sort((a, b) => {
          const distA = (a.x - playerPos.x) ** 2 + (a.z - playerPos.z) ** 2;
          const distB = (b.x - playerPos.x) ** 2 + (b.z - playerPos.z) ** 2;
          return distB - distA; // Furthest first
        });
      }
    }

    // Spawn bots at blue noise positions
    for (let i = 0; i < count && i < availableSpawns.length; i++) {
      const spawn = availableSpawns[i];
      const bot = new Bot(difficulty);

      bot.position = new Vector3(spawn.x, spawn.y + bot.config.eyeHeight, spawn.z);
      bot.yaw = Math.random() * Math.PI * 2;

      // Give bot weapons
      bot.giveWeapon('pistol');
      if (Math.random() > 0.5) {
        bot.giveWeapon('rifle');
        bot.selectWeapon(1);
      } else {
        bot.selectWeapon(2);
      }

      // Set patrol route and state
      bot.setPatrolRoute(this.spawnPoints);
      bot.setState('patrol', performance.now());

      this.bots.push(bot);
    }

    // If we didn't have enough blue noise spawns, spawn remaining normally
    const remaining = count - Math.min(count, availableSpawns.length);
    if (remaining > 0) {
      for (let i = 0; i < remaining; i++) {
        this.spawnBot(difficulty, playerPos);
      }
    }
  }

  // Get a blue noise spawn position for the player
  // Returns a spawn position that's well distributed across the map
  getBlueNoisePlayerSpawn(): Vector3 | null {
    const collisionMesh = getGlobalCollisionMesh();
    if (!collisionMesh || collisionMesh.triangles.length === 0 || this.spawnPoints.length === 0) {
      return null;
    }

    // Generate blue noise spawns
    const blueNoiseSpawns = generateBlueNoiseSpawns(
      this.spawnPoints,
      collisionMesh,
      10, // Generate several options
      8.0
    );

    if (blueNoiseSpawns.length === 0) {
      return null;
    }

    // Return a random one from the generated spawns
    return blueNoiseSpawns[Math.floor(Math.random() * blueNoiseSpawns.length)];
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
    teamMode: boolean = false,
    possessedBot: Bot | null = null // Bot being controlled by player (skip AI)
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
          this.handleRespawn(bot, now, player);
        }
        continue;
      }

      // Skip AI for possessed bot - player controls it directly
      // But still check for falling through floor
      if (bot === possessedBot) {
        // Safety check for possessed bot falling through floor
        if (bot.position.y < -10) {
          const teamSpawnPoints = this.getSpawnPointsForTeam(bot.team);
          if (teamSpawnPoints.length > 0) {
            const rawSpawn = teamSpawnPoints[Math.floor(Math.random() * teamSpawnPoints.length)];
            const collisionMesh = getGlobalCollisionMesh();
            let spawn = collisionMesh ? adjustSpawnPosition(rawSpawn, collisionMesh) : rawSpawn;
            if (!spawn) spawn = rawSpawn;
            bot.position = new Vector3(spawn.x, spawn.y + bot.config.eyeHeight, spawn.z);
            bot.verticalVelocity = 0;
          }
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

      // Safety check - respawn bot if they fell out of the world
      // Use -10 as threshold - most maps have floors at y >= 0
      if (bot.position.y < -10) {
        const teamSpawnPoints = this.getSpawnPointsForTeam(bot.team);
        if (teamSpawnPoints.length > 0) {
          const rawSpawn = teamSpawnPoints[Math.floor(Math.random() * teamSpawnPoints.length)];
          const collisionMesh = getGlobalCollisionMesh();

          let spawn: Vector3 | null = null;
          if (collisionMesh && collisionMesh.triangles.length > 0) {
            spawn = adjustSpawnPosition(rawSpawn, collisionMesh);

            // If first choice is invalid, try other spawn points
            if (spawn === null) {
              for (const altSpawn of teamSpawnPoints) {
                spawn = adjustSpawnPosition(altSpawn, collisionMesh);
                if (spawn !== null) break;
              }
            }

            // If still null, use raw spawn as fallback
            if (spawn === null) {
              spawn = rawSpawn;
            }
          } else {
            spawn = rawSpawn;
          }

          bot.position = new Vector3(spawn.x, spawn.y + bot.config.eyeHeight, spawn.z);
          bot.verticalVelocity = 0;
        }
      }

      // Update weapon state
      bot.updateWeapon(now);

      // Handle bot shooting (check if bot just fired) - only if not frozen
      if (!isFrozen && bot.lastFireTime === now) {
        this.handleBotShot(bot, player, colliders, now, teamMode);
      }
    }
  }

  // Snap bot to ground to prevent clipping (AABB collision only)
  // When mesh collision is active, BotBrain handles ground detection
  private snapToGround(bot: Bot, colliders: AABB[]): void {
    // Skip AABB-based snap when using mesh collision (BSP maps)
    // BotBrain.applyMovement already handles ground detection for mesh collision
    const collisionMesh = getGlobalCollisionMesh();
    if (collisionMesh && collisionMesh.triangles.length > 0) {
      return; // Mesh collision handles ground snapping
    }

    const eyePos = bot.position;
    const feetY = eyePos.y - bot.config.eyeHeight;

    // Raycast down from above the bot to find ground
    const rayOrigin = new Vector3(eyePos.x, eyePos.y + 2.0, eyePos.z);
    const rayDir = new Vector3(0, -1, 0);

    let groundY = -Infinity; // No default floor - find actual ground

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

    // Only snap if we found actual ground
    if (groundY > -Infinity) {
      const targetEyeY = groundY + bot.config.eyeHeight;
      // If close to a valid ground surface, snap to it
      if (Math.abs(feetY - groundY) < 0.5) {
        bot.position.y = targetEyeY;
      }
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
    // Use BSP mesh collision if available, otherwise fall back to AABB
    let wallHitPoint: Vector3 | null = null;
    let wallHitDist = maxRange;

    const collisionMesh = getGlobalCollisionMesh();
    if (collisionMesh && collisionMesh.triangles.length > 0) {
      // Use BSP mesh raycast for accurate wall collision
      const meshResult = raycastMesh(origin, direction, collisionMesh, maxRange);
      if (meshResult.hit) {
        wallHitDist = meshResult.distance;
        wallHitPoint = meshResult.point;
      }
    } else {
      // Fallback to AABB collision
      for (const collider of colliders) {
        const result = rayAABBIntersection(origin, direction, collider);
        if (result.hit && result.distance < wallHitDist) {
          wallHitDist = result.distance;
          wallHitPoint = result.point;
        }
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
        this.onPlayerDamage(bot.position, damage, headshot, bot.name, weapon.def.name);
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
  private handleRespawn(bot: Bot, now: number, player?: Player): void {
    // Check if enough time has passed since death
    // (using stateStartTime as death time)
    if (now - bot.stateStartTime > this.respawnDelay) {
      // Get all alive entity positions to spawn far from
      const avoidPositions = this.getAllEntityPositions(player);

      // Try to use pre-computed spawn points first (maximally far from entities)
      let spawn = getSpawnFarFromEntities(avoidPositions);

      // Fallback to old method if no pre-computed spawns available
      if (!spawn && this.spawnPoints.length > 0) {
        const spawnResult = this.getSpreadSpawnPointWithDistance(this.spawnPoints, avoidPositions);
        const rawSpawn = spawnResult.spawn;

        const collisionMesh = getGlobalCollisionMesh();
        if (collisionMesh && collisionMesh.triangles.length > 0) {
          spawn = adjustSpawnPosition(rawSpawn, collisionMesh);
          if (spawn === null) {
            spawn = rawSpawn;
          }
        } else {
          spawn = rawSpawn;
        }
      }

      if (spawn) {
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
