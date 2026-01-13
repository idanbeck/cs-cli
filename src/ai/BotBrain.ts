// Bot AI decision making
import { Vector3 } from '../engine/math/Vector3.js';
import { Bot, BotState } from './Bot.js';
import { Player } from '../game/Player.js';
import { AABB } from '../maps/MapFormat.js';
import { rayAABBIntersection, moveAndSlide, checkOnGround } from '../physics/Collision.js';
import { getGlobalCollisionMesh, moveWithMeshCollision, checkGroundMesh, raycastMesh, findGroundBelow, sphereTriangleCollision, capsuleTriangleCollision, CollisionMesh } from '../physics/MeshCollision.js';
import { getBotPath, getNextPathWaypoint, clearBotPath, getNavGrid, getNearestChokepoint, Chokepoint } from './Navigation.js';

const MOVE_SPEED = 8; // Match player speed for active hunting
const GRAVITY = 20;
const BOT_RADIUS = 1.0;      // Large radius to prevent falling through crevices
const BOT_HEIGHT = 1.8;
const SLOPE_LIMIT = 0.5;     // More forgiving slope detection
const MAX_LOS_DISTANCE = 200; // Always check LOS - don't skip for distant targets
const NOISE_HEARING_RANGE = 30; // How far bots can hear noise (walking/shooting)
const NOISE_MEMORY_TIME = 3000; // How long bots remember hearing noise (ms)
const STUCK_RECOVERY_TIME = 800; // How long to try escaping when stuck (ms)
const STAGNANT_CHECK_INTERVAL = 3000; // How often to check if bot is stagnant
const OBSTACLE_CHECK_DISTANCE = 3.0; // How far ahead to check for obstacles
const NUM_ESCAPE_DIRECTIONS = 8; // Number of directions to try when stuck

// Movement constants
const TARGET_WEIGHT = 1.0; // Weight for target/waypoint direction
const WALL_AVOIDANCE_WEIGHT = 1.5; // Weight for wall avoidance (high priority)
const ENEMY_SEARCH_RANGE = 100; // How far to search for enemies to navigate toward
const DIRECTION_EMA_ALPHA = 0.15; // EMA smoothing factor (lower = smoother, 0.1-0.2 is good)
const WALL_SENSE_DISTANCE = 4.0; // How far ahead to sense walls

// Stuck detection constants
const STUCK_DISTANCE_THRESHOLD = 0.5; // If moved less than this in check period, we're stuck
const STUCK_CHECK_INTERVAL = 500; // Check stuck status every 500ms
const STUCK_DIRECTION_COMMIT_TIME = 1500; // Commit to escape direction for 1.5 seconds
const STUCK_DIRECTION_ATTEMPTS = 8; // Try 8 different directions before giving up

// Disperse constants - enemy bots spread out until they find enemies
const DISPERSE_ENGAGE_RANGE = 25; // Stop dispersing when enemy is within this range
const DISPERSE_DISTANCE = 30; // How far ahead to target when dispersing
const DISPERSE_STUCK_ROTATE = Math.PI / 4; // Rotate 45 degrees when stuck during disperse
const DISPERSE_SEPARATION_DISTANCE = 8; // Bots push away from each other within this range
const DISPERSE_SEPARATION_WEIGHT = 2.0; // Strong separation force during disperse
const DISPERSE_WALL_WEIGHT = 2.5; // Strong wall avoidance during disperse
const DISPERSE_CHOKEPOINT_RANGE = 50; // How far to look for chokepoints during disperse
const DISPERSE_CHOKEPOINT_WEIGHT = 1.5; // Weight for chokepoint attraction

// Track noise sources (gunshots, footsteps)
export interface NoiseSource {
  position: Vector3;
  timestamp: number;
  loudness: number; // 1.0 = gunshot, 0.5 = walking
}

// Global noise tracking
const recentNoises: NoiseSource[] = [];

export function registerNoise(position: Vector3, loudness: number, now: number): void {
  recentNoises.push({ position: position.clone(), timestamp: now, loudness });
  // Keep only recent noises
  while (recentNoises.length > 20) recentNoises.shift();
}

export function clearOldNoises(now: number): void {
  const cutoff = now - NOISE_MEMORY_TIME;
  while (recentNoises.length > 0 && recentNoises[0].timestamp < cutoff) {
    recentNoises.shift();
  }
}

export interface BotThinkContext {
  player: Player;              // The human player (target)
  allBots: Bot[];              // All bots (for bot vs bot combat)
  colliders: AABB[];           // Map collision
  now: number;                 // Current timestamp
  deltaTime: number;           // Time since last frame
  isFrozen?: boolean;          // Whether bots are frozen (freeze phase)
  teamMode?: boolean;          // Whether team mode is active (filter targets)
}

export class BotBrain {
  // Check if bot can hear any recent noise
  static findNearbyNoise(bot: Bot, now: number): Vector3 | null {
    clearOldNoises(now);

    let closestNoise: NoiseSource | null = null;
    let closestDist = Infinity;

    for (const noise of recentNoises) {
      const dist = Vector3.sub(noise.position, bot.position).length();
      const hearingRange = NOISE_HEARING_RANGE * noise.loudness;

      if (dist < hearingRange && dist < closestDist) {
        closestDist = dist;
        closestNoise = noise;
      }
    }

    return closestNoise ? closestNoise.position.clone() : null;
  }

  // Find the clearest direction by checking multiple angles
  // Returns the direction with the most clearance ahead
  static findClearDirection(bot: Bot, preferredDir: Vector3 | null = null): Vector3 {
    const collisionMesh = getGlobalCollisionMesh();
    const pos = bot.position;
    const eyePos = bot.getEyePosition();

    // Start with preferred direction or current facing direction
    let baseAngle: number;
    if (preferredDir) {
      baseAngle = Math.atan2(preferredDir.x, preferredDir.z);
    } else {
      baseAngle = bot.yaw + Math.PI; // Facing direction
    }

    // Check multiple directions: forward, 45° left/right, 90° left/right, etc.
    const angles = [
      0,                    // Forward
      Math.PI / 4,          // 45° right
      -Math.PI / 4,         // 45° left
      Math.PI / 2,          // 90° right
      -Math.PI / 2,         // 90° left
      3 * Math.PI / 4,      // 135° right
      -3 * Math.PI / 4,     // 135° left
      Math.PI,              // Backward
    ];

    let bestDir: Vector3 = new Vector3(Math.sin(baseAngle), 0, Math.cos(baseAngle));
    let bestClearance = 0;

    for (const angleOffset of angles) {
      const angle = baseAngle + angleOffset;
      const dir = new Vector3(Math.sin(angle), 0, Math.cos(angle));

      // Check how far we can go in this direction
      const clearance = this.checkClearance(eyePos, dir, collisionMesh, OBSTACLE_CHECK_DISTANCE);

      // Prefer directions closer to the original (smaller angle offset)
      const anglePenalty = Math.abs(angleOffset) * 0.3;
      const adjustedClearance = clearance - anglePenalty;

      if (adjustedClearance > bestClearance) {
        bestClearance = adjustedClearance;
        bestDir = dir;
      }
    }

    // If all directions are blocked, try a random direction as last resort
    if (bestClearance < 0.5) {
      const randomAngle = Math.random() * Math.PI * 2;
      return new Vector3(Math.cos(randomAngle), 0, Math.sin(randomAngle));
    }

    return bestDir;
  }

  // Check how far we can travel in a direction (returns clearance distance)
  static checkClearance(from: Vector3, dir: Vector3, mesh: CollisionMesh | null, maxDist: number): number {
    if (!mesh || mesh.triangles.length === 0) {
      return maxDist; // No collision mesh, assume clear
    }

    // Check at waist height to detect walls
    const checkPos = new Vector3(from.x, from.y - 0.5, from.z);

    // Cast a ray to find obstacles
    let closestHit = maxDist;

    for (const tri of mesh.triangles) {
      // Skip floor/ceiling triangles
      if (Math.abs(tri.normal.y) > SLOPE_LIMIT) continue;

      const result = this.fastRayTriangle(checkPos, dir, tri, maxDist);
      if (result) {
        // Calculate hit distance
        const hitDist = this.getRayTriangleDistance(checkPos, dir, tri);
        if (hitDist !== null && hitDist < closestHit) {
          closestHit = hitDist;
        }
      }
    }

    return closestHit;
  }

  // Get actual distance to ray-triangle intersection
  private static getRayTriangleDistance(origin: Vector3, dir: Vector3, tri: { v0: Vector3; v1: Vector3; v2: Vector3 }): number | null {
    const EPSILON = 0.0001;

    const e1x = tri.v1.x - tri.v0.x, e1y = tri.v1.y - tri.v0.y, e1z = tri.v1.z - tri.v0.z;
    const e2x = tri.v2.x - tri.v0.x, e2y = tri.v2.y - tri.v0.y, e2z = tri.v2.z - tri.v0.z;

    const hx = dir.y * e2z - dir.z * e2y;
    const hy = dir.z * e2x - dir.x * e2z;
    const hz = dir.x * e2y - dir.y * e2x;

    const a = e1x * hx + e1y * hy + e1z * hz;
    if (a > -EPSILON && a < EPSILON) return null;

    const f = 1.0 / a;
    const sx = origin.x - tri.v0.x, sy = origin.y - tri.v0.y, sz = origin.z - tri.v0.z;
    const u = f * (sx * hx + sy * hy + sz * hz);
    if (u < 0.0 || u > 1.0) return null;

    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const v = f * (dir.x * qx + dir.y * qy + dir.z * qz);
    if (v < 0.0 || u + v > 1.0) return null;

    const t = f * (e2x * qx + e2y * qy + e2z * qz);
    return t > EPSILON ? t : null;
  }

  // Find nearest enemy position (for goal-directed navigation)
  static findNearestEnemy(bot: Bot, player: Player, allBots: Bot[], teamMode: boolean): Vector3 | null {
    let nearestPos: Vector3 | null = null;
    let nearestDist = ENEMY_SEARCH_RANGE;

    // Check player
    if (player.isAlive) {
      const isEnemy = !teamMode || bot.isEnemy(player);
      if (isEnemy) {
        const dist = Vector3.sub(player.position, bot.position).length();
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestPos = player.position.clone();
        }
      }
    }

    // Check other bots
    for (const other of allBots) {
      if (other === bot || !other.isAlive) continue;
      const isEnemy = !teamMode || bot.isEnemy(other);
      if (isEnemy) {
        const dist = Vector3.sub(other.position, bot.position).length();
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestPos = other.position.clone();
        }
      }
    }

    return nearestPos;
  }

  // Calculate direction toward target (returns normalized direction or zero)
  static calcTargetDir(bot: Bot, targetPos: Vector3 | null): Vector3 {
    if (!targetPos) return Vector3.zero();

    const dx = targetPos.x - bot.position.x;
    const dz = targetPos.z - bot.position.z;
    const len = Math.sqrt(dx * dx + dz * dz);

    if (len > 1) {
      return new Vector3(dx / len, 0, dz / len);
    }
    return Vector3.zero();
  }

  // Raycast to find distance to obstacle in a direction
  static raycastWall(pos: Vector3, dir: Vector3, maxDist: number): number {
    const mesh = getGlobalCollisionMesh();
    if (!mesh || mesh.triangles.length === 0) {
      return maxDist;
    }

    const checkPos = new Vector3(pos.x, pos.y + 0.5, pos.z); // Waist height
    let closestHit = maxDist;

    for (const tri of mesh.triangles) {
      // Skip floor/ceiling
      if (Math.abs(tri.normal.y) > SLOPE_LIMIT) continue;

      const hitDist = this.getRayTriangleDistance(checkPos, dir, tri);
      if (hitDist !== null && hitDist < closestHit) {
        closestHit = hitDist;
      }
    }

    return closestHit;
  }

  // Calculate wall avoidance direction by raycasting ahead and to sides
  static calcWallAvoidanceDir(bot: Bot, currentAngle: number): Vector3 {
    const pos = bot.position;

    // Cast rays: forward, left 30°, right 30°, left 60°, right 60°
    const angles = [
      0,                  // Forward
      -Math.PI / 6,       // Left 30°
      Math.PI / 6,        // Right 30°
      -Math.PI / 3,       // Left 60°
      Math.PI / 3,        // Right 60°
    ];

    let avoidX = 0, avoidZ = 0;
    let needsAvoidance = false;

    for (const angleOffset of angles) {
      const checkAngle = currentAngle + angleOffset;
      const dir = new Vector3(
        Math.sin(checkAngle),
        0,
        Math.cos(checkAngle)
      );

      const dist = this.raycastWall(pos, dir, WALL_SENSE_DISTANCE);

      // If wall is closer than buffer, add avoidance force
      if (dist < WALL_SENSE_DISTANCE) {
        needsAvoidance = true;
        // Strength inversely proportional to distance (closer = stronger)
        const strength = (WALL_SENSE_DISTANCE - dist) / WALL_SENSE_DISTANCE;
        // Push away from wall (opposite of ray direction)
        avoidX -= dir.x * strength;
        avoidZ -= dir.z * strength;
      }
    }

    if (needsAvoidance) {
      const len = Math.sqrt(avoidX * avoidX + avoidZ * avoidZ);
      if (len > 0.01) {
        return new Vector3(avoidX / len, 0, avoidZ / len);
      }
    }

    return Vector3.zero();
  }

  // Calculate separation direction from nearby bots (push away from each other)
  // Used during disperse to prevent bots from clumping
  static calcSeparationDir(bot: Bot, allBots: Bot[], teamMode: boolean): Vector3 {
    const pos = bot.position;
    let sepX = 0, sepZ = 0;
    let neighborCount = 0;

    for (const other of allBots) {
      if (other === bot || !other.isAlive) continue;

      // Only separate from same-team bots (enemy bots separate from other enemies)
      // In team mode, check team. In FFA, all bots separate from each other
      const sameTeam = teamMode ? bot.isTeammate(other) : true;
      if (!sameTeam) continue;

      const dx = pos.x - other.position.x;
      const dz = pos.z - other.position.z;
      const distSq = dx * dx + dz * dz;

      if (distSq < DISPERSE_SEPARATION_DISTANCE * DISPERSE_SEPARATION_DISTANCE && distSq > 0.01) {
        const dist = Math.sqrt(distSq);
        // Strength inversely proportional to distance (closer = stronger push)
        const strength = (DISPERSE_SEPARATION_DISTANCE - dist) / DISPERSE_SEPARATION_DISTANCE;
        sepX += (dx / dist) * strength;
        sepZ += (dz / dist) * strength;
        neighborCount++;
      }
    }

    if (neighborCount > 0) {
      const len = Math.sqrt(sepX * sepX + sepZ * sepZ);
      if (len > 0.01) {
        return new Vector3(sepX / len, 0, sepZ / len);
      }
    }

    return Vector3.zero();
  }

  // Smooth angle transition using EMA, handling angle wrapping
  static smoothAngle(currentAngle: number, targetAngle: number, alpha: number): number {
    // Handle angle wrapping (-PI to PI)
    let diff = targetAngle - currentAngle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;

    // Apply EMA
    let newAngle = currentAngle + diff * alpha;

    // Normalize result
    while (newAngle > Math.PI) newAngle -= Math.PI * 2;
    while (newAngle < -Math.PI) newAngle += Math.PI * 2;

    return newAngle;
  }

  // Check if bot is stuck by measuring distance traveled
  static checkStuckByDistance(bot: Bot, now: number): boolean {
    // Initialize on first call
    if (bot.lastStuckCheckTime === 0) {
      bot.lastStuckCheckTime = now;
      bot.lastStuckCheckPos = bot.position.clone();
      return false;
    }

    // Only check periodically
    if (now - bot.lastStuckCheckTime < STUCK_CHECK_INTERVAL) {
      return bot.escapeDirection !== null; // Return current stuck status
    }

    // Measure distance traveled since last check
    const distanceMoved = Math.sqrt(
      (bot.position.x - bot.lastStuckCheckPos.x) ** 2 +
      (bot.position.z - bot.lastStuckCheckPos.z) ** 2
    );

    // Update check position and time
    bot.lastStuckCheckPos = bot.position.clone();
    bot.lastStuckCheckTime = now;

    // If we moved enough, we're not stuck
    if (distanceMoved >= STUCK_DISTANCE_THRESHOLD) {
      // Clear escape mode if we're making progress
      if (bot.escapeDirection !== null && now > bot.escapeUntil) {
        bot.escapeDirection = null;
        bot.escapeAttempt = 0;
      }
      return false;
    }

    // We're stuck - need to try an escape direction
    return true;
  }

  // Get escape direction for stuck bot (tries different angles)
  static getEscapeDirection(bot: Bot, now: number): number {
    // If we have a committed escape direction that hasn't expired, use it
    if (bot.escapeDirection !== null && now < bot.escapeUntil) {
      return bot.escapeDirection;
    }

    // Time to try a new escape direction
    // Try 8 directions spread around the circle, offset by attempt number
    const baseAngle = bot.smoothedAngle;
    const attemptOffset = (bot.escapeAttempt * Math.PI * 2) / STUCK_DIRECTION_ATTEMPTS;

    // Alternate between left and right of base direction
    const direction = (bot.escapeAttempt % 2 === 0) ? 1 : -1;
    const escapeAngle = baseAngle + (Math.PI / 2 + attemptOffset * 0.5) * direction;

    // Commit to this direction
    bot.escapeDirection = escapeAngle;
    bot.escapeUntil = now + STUCK_DIRECTION_COMMIT_TIME;
    bot.escapeAttempt = (bot.escapeAttempt + 1) % STUCK_DIRECTION_ATTEMPTS;

    // Try to jump when starting a new escape direction
    bot.wantsToJump = true;

    return escapeAngle;
  }

  // Get unique disperse angle for a bot (based on name hash)
  // Can be rotated by passing an offset (for stuck recovery)
  static getDisperseAngle(bot: Bot, offset: number = 0): number {
    let hash = 0;
    for (let i = 0; i < bot.name.length; i++) {
      hash = ((hash << 5) - hash) + bot.name.charCodeAt(i);
      hash |= 0;
    }
    // Spread angles evenly around the circle, plus any offset
    return ((Math.abs(hash) % 360) * (Math.PI / 180)) + offset;
  }

  // Check if bot should be in disperse mode (enemy bots spread out until they find enemies)
  static shouldDisperse(bot: Bot, player: Player, allBots: Bot[], teamMode: boolean): boolean {
    // Only enemy bots disperse
    const isTeammate = teamMode && bot.isTeammate(player);
    if (isTeammate) return false;

    // Find nearest enemy position
    const enemyPos = this.findNearestEnemy(bot, player, allBots, teamMode);
    if (!enemyPos) return true; // No enemy found, keep dispersing

    // Check distance to nearest enemy
    const distToEnemy = Vector3.sub(enemyPos, bot.position).length();

    // Stop dispersing if enemy is within engagement range
    return distToEnemy > DISPERSE_ENGAGE_RANGE;
  }

  // Main movement function - calculates desired direction, smooths it, applies full speed
  // Bots always use A* to hunt enemies - no LOS required, no flocking
  // Teammates follow the player when player is alive
  // Enemy bots disperse until they find enemies within range
  static momentumMove(bot: Bot, ctx: BotThinkContext, targetPos: Vector3 | null): Vector3 {
    const { player, allBots, colliders, deltaTime, teamMode, now } = ctx;

    // Check if bot is on player's team
    const isTeammate = teamMode && bot.isTeammate(player);
    const distToPlayer = Vector3.sub(player.position, bot.position).length();

    // Determine navigation target based on team and disperse phase
    // PRIORITY: Teammates ALWAYS follow player (never disperse)
    let navigationTarget: Vector3 | null = null;
    let isDispersing = false;

    if (isTeammate && player.isAlive) {
      // TEAMMATES: Always follow the player (priority over everything else)
      if (distToPlayer > 3) {
        // Follow player if not too close
        navigationTarget = player.position.clone();
      } else {
        // Very close to player - hunt enemies together
        navigationTarget = this.findNearestEnemy(bot, player, allBots, teamMode || false);
      }
    } else if (this.shouldDisperse(bot, player, allBots, teamMode || false)) {
      // ENEMIES: Disperse until they find enemies within range
      isDispersing = true;

      // Use escapeAttempt as rotation offset when stuck
      const stuckOffset = bot.escapeAttempt * DISPERSE_STUCK_ROTATE;
      const disperseAngle = this.getDisperseAngle(bot, stuckOffset);
      const disperseDir = new Vector3(Math.sin(disperseAngle), 0, Math.cos(disperseAngle));

      // Look for a chokepoint in our disperse direction to flow through
      const nearestChokepoint = getNearestChokepoint(bot.position, disperseDir);

      if (nearestChokepoint) {
        const distToCP = Vector3.sub(nearestChokepoint.position, bot.position).length();

        if (distToCP < DISPERSE_CHOKEPOINT_RANGE && distToCP > 3) {
          // Navigate toward the chokepoint, then through it
          // Add the chokepoint's flow direction to push through, not just to it
          const throughOffset = Vector3.scale(nearestChokepoint.direction, 10);
          navigationTarget = Vector3.add(nearestChokepoint.position, throughOffset);
        } else {
          // Chokepoint too far or too close, use basic disperse
          navigationTarget = new Vector3(
            bot.position.x + disperseDir.x * DISPERSE_DISTANCE,
            bot.position.y,
            bot.position.z + disperseDir.z * DISPERSE_DISTANCE
          );
        }
      } else {
        // No chokepoint found, use basic disperse direction
        navigationTarget = new Vector3(
          bot.position.x + disperseDir.x * DISPERSE_DISTANCE,
          bot.position.y,
          bot.position.z + disperseDir.z * DISPERSE_DISTANCE
        );
      }
    } else {
      // Not a teammate following, not dispersing - hunt enemies via A*
      navigationTarget = this.findNearestEnemy(bot, player, allBots, teamMode || false);
    }


    // Initialize angle if needed
    if (!bot.hasInitializedAngle) {
      bot.smoothedAngle = Math.random() * Math.PI * 2 - Math.PI;
      bot.hasInitializedAngle = true;
    }

    // CHECK IF STUCK - track actual distance traveled
    const isStuck = this.checkStuckByDistance(bot, now);

    // If stuck, use escape direction instead of normal navigation
    if (isStuck) {
      const escapeAngle = this.getEscapeDirection(bot, now);
      // Use escape direction directly (no smoothing - commit to it)
      bot.smoothedAngle = escapeAngle;
    } else {
      // NORMAL NAVIGATION: A* pathfinding to target (player for teammates, enemy for others)
      let pathWaypoint: Vector3 | null = null;
      const navGrid = getNavGrid();

      if (navGrid.isInitialized() && navigationTarget) {
        // Get or compute path to target (staggered recalculation every 2-3 seconds)
        const cachedPath = getBotPath(bot.name, bot.position, navigationTarget, now);
        if (cachedPath && cachedPath.path.length > 0) {
          // Get next waypoint along A* path
          pathWaypoint = getNextPathWaypoint(bot.name, bot.position);

          // If we've reached end of path, head directly to target
          if (!pathWaypoint) {
            pathWaypoint = navigationTarget;
          }
        }
      }

      // Priority: A* path waypoint > direct navigation target > fallback target
      const effectiveTarget = pathWaypoint || navigationTarget || targetPos;

      // Calculate target direction (no flocking, just follow A* path)
      const targetDir = this.calcTargetDir(bot, effectiveTarget);

      // Wall avoidance - raycast ahead to detect obstacles
      const wallAvoidDir = this.calcWallAvoidanceDir(bot, bot.smoothedAngle);

      // Separation force - only during disperse phase to spread bots out
      const separationDir = isDispersing ? this.calcSeparationDir(bot, allBots, teamMode || false) : Vector3.zero();

      // Combine forces with weights (stronger during disperse)
      let desiredX = 0, desiredZ = 0;

      // Add wall avoidance (higher priority during disperse)
      if (wallAvoidDir.length() > 0.1) {
        const wallWeight = isDispersing ? DISPERSE_WALL_WEIGHT : WALL_AVOIDANCE_WEIGHT;
        desiredX += wallAvoidDir.x * wallWeight;
        desiredZ += wallAvoidDir.z * wallWeight;
      }

      // Add separation force during disperse (push away from other bots)
      if (separationDir.length() > 0.1) {
        desiredX += separationDir.x * DISPERSE_SEPARATION_WEIGHT;
        desiredZ += separationDir.z * DISPERSE_SEPARATION_WEIGHT;
      }

      // Add target direction (A* waypoint)
      if (targetDir.length() > 0.1) {
        desiredX += targetDir.x * TARGET_WEIGHT;
        desiredZ += targetDir.z * TARGET_WEIGHT;
      }

      // Calculate desired angle from combined forces
      const desiredLen = Math.sqrt(desiredX * desiredX + desiredZ * desiredZ);
      let desiredAngle: number;

      if (desiredLen > 0.1) {
        desiredX /= desiredLen;
        desiredZ /= desiredLen;
        desiredAngle = Math.atan2(desiredX, desiredZ);
      } else {
        desiredAngle = bot.smoothedAngle;
      }

      // Smooth toward desired direction (faster response during disperse)
      let alpha = wallAvoidDir.length() > 0.1 ? DIRECTION_EMA_ALPHA * 2 : DIRECTION_EMA_ALPHA;
      if (isDispersing && (separationDir.length() > 0.1 || wallAvoidDir.length() > 0.1)) {
        alpha = DIRECTION_EMA_ALPHA * 3; // Even faster response to avoid clumping/walls
      }
      bot.smoothedAngle = this.smoothAngle(bot.smoothedAngle, desiredAngle, alpha);
    }

    // Convert smoothed angle to direction vector at full speed
    const moveX = Math.sin(bot.smoothedAngle) * MOVE_SPEED;
    const moveZ = Math.cos(bot.smoothedAngle) * MOVE_SPEED;

    // Update velocity (for consistency with other code that reads it)
    bot.velocity.x = moveX;
    bot.velocity.z = moveZ;

    // Create movement
    const movement = new Vector3(
      moveX * deltaTime,
      0,
      moveZ * deltaTime
    );

    // Update bot's yaw to face movement direction
    bot.yaw = Math.atan2(-moveX, -moveZ);

    return this.applyMovement(bot, movement, colliders, deltaTime);
  }

  // Trigger stuck recovery - find the best escape direction
  static triggerStuckRecovery(bot: Bot, now: number): void {
    // Find clearest direction instead of random
    bot.stuckRecoveryDir = this.findClearDirection(bot, bot.moveTarget ? Vector3.sub(bot.moveTarget, bot.position).normalize() : null);
    bot.stuckRecoveryUntil = now + STUCK_RECOVERY_TIME;

    // Reset stuck tracking so we can detect if we're still stuck after recovery
    bot.stuckTime = 0;
    bot.lastSignificantMoveTime = now;

    // Also pick a new random waypoint to head toward after recovery
    if (bot.patrolWaypoints.length > 0) {
      bot.currentWaypointIndex = Math.floor(Math.random() * bot.patrolWaypoints.length);
    }
  }

  // Handle stuck recovery movement - move in escape direction
  static handleStuckRecovery(bot: Bot, colliders: AABB[], deltaTime: number): Vector3 {
    if (!bot.stuckRecoveryDir) {
      return Vector3.zero();
    }

    // Move faster during recovery to break free
    const recoverySpeed = MOVE_SPEED * 1.5;
    const movement = Vector3.scale(bot.stuckRecoveryDir, recoverySpeed * deltaTime);

    // Turn to face escape direction
    const targetYaw = Math.atan2(-bot.stuckRecoveryDir.x, -bot.stuckRecoveryDir.z);
    bot.yaw = targetYaw;

    return this.applyMovement(bot, movement, colliders, deltaTime);
  }

  // Main think function - called every frame for each bot
  static think(bot: Bot, ctx: BotThinkContext): Vector3 {
    const { player, allBots, colliders, now, deltaTime, isFrozen, teamMode } = ctx;

    // Don't think if dead
    if (!bot.isAlive) {
      bot.setState('dead', now);
      return Vector3.zero();
    }

    // If frozen (freeze phase), no movement or combat
    if (isFrozen) {
      bot.setState('idle', now);
      bot.moveTarget = null;
      return Vector3.zero();
    }

    // Throttle AI updates for performance
    if (now - bot.lastThinkTime < bot.thinkInterval) {
      // Still apply movement toward current target
      return this.continueMovement(bot, colliders, deltaTime);
    }
    bot.lastThinkTime = now;

    // Find closest VISIBLE target (requires line of sight!)
    const { target: visibleTarget, canSee } = this.findClosestTarget(bot, player, allBots, colliders, teamMode);

    // Update target tracking only if we can actually SEE them
    if (canSee && visibleTarget) {
      bot.target = visibleTarget;
      bot.lastSeenTargetPos = visibleTarget.getEyePosition().clone();
      bot.lastSeenTargetTime = now;
    }

    // Check for nearby noise (gunshots, footsteps) - can investigate without LOS
    const heardNoise = this.findNearbyNoise(bot, now);
    if (heardNoise && !canSee) {
      // Heard something - investigate that location
      bot.lastSeenTargetPos = heardNoise;
      bot.lastSeenTargetTime = now;
    }

    // Check for stuck/stagnant state and trigger recovery
    const isStuck = bot.checkStuck(now);
    const isStagnant = bot.isStagnant(now);

    // If currently in stuck recovery mode, continue with recovery movement
    if (bot.stuckRecoveryUntil > now) {
      return this.handleStuckRecovery(bot, colliders, deltaTime);
    }

    // Trigger stuck recovery if stuck or stagnant
    if (isStuck || isStagnant) {
      this.triggerStuckRecovery(bot, now);
      return this.handleStuckRecovery(bot, colliders, deltaTime);
    }

    // State machine
    switch (bot.state) {
      case 'idle':
        return this.handleIdle(bot, ctx, canSee);
      case 'patrol':
        return this.handlePatrol(bot, ctx, canSee);
      case 'chase':
        return this.handleChase(bot, ctx, canSee);
      case 'attack':
        return this.handleAttack(bot, ctx, canSee);
      case 'flee':
        return this.handleFlee(bot, ctx, canSee);
      default:
        return Vector3.zero();
    }
  }

  // Find the closest visible target (player or another bot)
  // Optimized: distance checks before expensive LOS, limit bot-vs-bot checks
  static findClosestTarget(
    bot: Bot,
    player: Player,
    allBots: Bot[],
    colliders: AABB[],
    teamMode?: boolean
  ): { target: Player | null; canSee: boolean } {
    let closestTarget: Player | null = null;
    let closestDistance = Infinity;
    const botPos = bot.position;
    const sightRange = bot.botConfig.sightRange;

    // Check player first - most important target
    if (player.isAlive) {
      const isValidTarget = !teamMode || bot.isEnemy(player);
      if (isValidTarget) {
        // Quick distance check before expensive LOS
        const dx = player.position.x - botPos.x;
        const dz = player.position.z - botPos.z;
        const distSq = dx * dx + dz * dz;

        if (distSq < sightRange * sightRange) {
          const dist = Math.sqrt(distSq);
          // Check FOV first (cheap), then LOS raycast (required before targeting)
          if (bot.canSeePosition(player.getEyePosition())) {
            // Always verify line of sight - never shoot through walls
            if (this.hasLineOfSight(bot.getEyePosition(), player.getEyePosition(), colliders)) {
              closestDistance = dist;
              closestTarget = player;
            }
          }
        }
      }
    }

    // Check bot-vs-bot combat:
    // - In FFA/deathmatch (non-team mode): all other bots are enemies
    // - In team mode: only enemy team bots are targets
    // Limit to 8 bots for performance
    if (allBots.length <= 8) {
      for (const otherBot of allBots) {
        if (otherBot === bot || !otherBot.isAlive) continue;

        // In FFA mode, everyone is an enemy. In team mode, use isEnemy check
        const isEnemy = teamMode ? bot.isEnemy(otherBot) : true;
        if (!isEnemy) continue;

        // Quick distance check
        const dx = otherBot.position.x - botPos.x;
        const dz = otherBot.position.z - botPos.z;
        const distSq = dx * dx + dz * dz;

        // Skip if further than current closest or out of range
        if (distSq >= closestDistance * closestDistance || distSq > sightRange * sightRange) continue;

        const dist = Math.sqrt(distSq);
        if (bot.canSeePosition(otherBot.getEyePosition())) {
          if (dist < MAX_LOS_DISTANCE && this.hasLineOfSight(bot.getEyePosition(), otherBot.getEyePosition(), colliders)) {
            closestDistance = dist;
            closestTarget = otherBot;
          }
        }
      }
    }

    return { target: closestTarget, canSee: closestTarget !== null };
  }

  // Check line of sight between two points
  // Optimized with spatial culling for BSP meshes
  static hasLineOfSight(from: Vector3, to: Vector3, colliders: AABB[]): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (distance < 0.1) return true; // Same point

    const invDist = 1 / distance;
    const dirX = dx * invDist;
    const dirY = dy * invDist;
    const dirZ = dz * invDist;

    // Try mesh collision first (for BSP maps)
    const collisionMesh = getGlobalCollisionMesh();
    if (collisionMesh && collisionMesh.triangles.length > 0) {
      // Fast path: check only triangles in the ray's bounding box
      const minX = Math.min(from.x, to.x) - 0.5;
      const maxX = Math.max(from.x, to.x) + 0.5;
      const minY = Math.min(from.y, to.y) - 0.5;
      const maxY = Math.max(from.y, to.y) + 0.5;
      const minZ = Math.min(from.z, to.z) - 0.5;
      const maxZ = Math.max(from.z, to.z) + 0.5;

      const dir = new Vector3(dirX, dirY, dirZ);
      const checkDist = distance - 0.1;

      for (const tri of collisionMesh.triangles) {
        // Quick AABB rejection
        const triMinX = Math.min(tri.v0.x, tri.v1.x, tri.v2.x);
        const triMaxX = Math.max(tri.v0.x, tri.v1.x, tri.v2.x);
        if (triMaxX < minX || triMinX > maxX) continue;

        const triMinZ = Math.min(tri.v0.z, tri.v1.z, tri.v2.z);
        const triMaxZ = Math.max(tri.v0.z, tri.v1.z, tri.v2.z);
        if (triMaxZ < minZ || triMinZ > maxZ) continue;

        const triMinY = Math.min(tri.v0.y, tri.v1.y, tri.v2.y);
        const triMaxY = Math.max(tri.v0.y, tri.v1.y, tri.v2.y);
        if (triMaxY < minY || triMinY > maxY) continue;

        // Do actual ray-triangle test
        const result = this.fastRayTriangle(from, dir, tri, checkDist);
        if (result) return false; // Hit something
      }
      return true;
    }

    // Fall back to AABB collision
    const dir = new Vector3(dirX, dirY, dirZ);
    for (const collider of colliders) {
      const result = rayAABBIntersection(from, dir, collider);
      if (result.hit && result.distance < distance - 0.1) {
        return false;
      }
    }
    return true;
  }

  // Fast ray-triangle intersection (returns true if hit within maxDist)
  private static fastRayTriangle(origin: Vector3, dir: Vector3, tri: { v0: Vector3; v1: Vector3; v2: Vector3 }, maxDist: number): boolean {
    const EPSILON = 0.0001;

    const e1x = tri.v1.x - tri.v0.x, e1y = tri.v1.y - tri.v0.y, e1z = tri.v1.z - tri.v0.z;
    const e2x = tri.v2.x - tri.v0.x, e2y = tri.v2.y - tri.v0.y, e2z = tri.v2.z - tri.v0.z;

    const hx = dir.y * e2z - dir.z * e2y;
    const hy = dir.z * e2x - dir.x * e2z;
    const hz = dir.x * e2y - dir.y * e2x;

    const a = e1x * hx + e1y * hy + e1z * hz;
    if (a > -EPSILON && a < EPSILON) return false;

    const f = 1.0 / a;
    const sx = origin.x - tri.v0.x, sy = origin.y - tri.v0.y, sz = origin.z - tri.v0.z;
    const u = f * (sx * hx + sy * hy + sz * hz);
    if (u < 0.0 || u > 1.0) return false;

    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const v = f * (dir.x * qx + dir.y * qy + dir.z * qz);
    if (v < 0.0 || u + v > 1.0) return false;

    const t = f * (e2x * qx + e2y * qy + e2z * qz);
    return t > EPSILON && t < maxDist;
  }

  // Continue current movement without full AI update
  // Uses bot's smoothedAngle to maintain consistent direction between AI updates
  static continueMovement(bot: Bot, colliders: AABB[], deltaTime: number): Vector3 {
    // Use the smoothed angle that was set by momentumMove
    const moveX = Math.sin(bot.smoothedAngle) * MOVE_SPEED;
    const moveZ = Math.cos(bot.smoothedAngle) * MOVE_SPEED;

    // Create movement vector
    const movement = new Vector3(
      moveX * deltaTime,
      0,
      moveZ * deltaTime
    );

    // Update bot's yaw to face movement direction
    bot.yaw = Math.atan2(-moveX, -moveZ);

    return this.applyMovement(bot, movement, colliders, deltaTime);
  }

  // Simple and fast wall check for bots - just check if movement is blocked
  static isMovementBlocked(from: Vector3, to: Vector3, mesh: CollisionMesh): boolean {
    // Quick bounding box pre-check
    const minX = Math.min(from.x, to.x) - BOT_RADIUS;
    const maxX = Math.max(from.x, to.x) + BOT_RADIUS;
    const minZ = Math.min(from.z, to.z) - BOT_RADIUS;
    const maxZ = Math.max(from.z, to.z) + BOT_RADIUS;
    const checkY = from.y + 0.5; // Check at waist height

    for (const tri of mesh.triangles) {
      // Skip triangles outside our movement bounds (spatial culling)
      const triMinX = Math.min(tri.v0.x, tri.v1.x, tri.v2.x);
      const triMaxX = Math.max(tri.v0.x, tri.v1.x, tri.v2.x);
      const triMinZ = Math.min(tri.v0.z, tri.v1.z, tri.v2.z);
      const triMaxZ = Math.max(tri.v0.z, tri.v1.z, tri.v2.z);

      if (triMaxX < minX || triMinX > maxX || triMaxZ < minZ || triMinZ > maxZ) continue;

      // Skip floor/ceiling triangles
      if (Math.abs(tri.normal.y) > SLOPE_LIMIT) continue;

      // Simple sphere check at destination
      const checkPos = new Vector3(to.x, checkY, to.z);
      const collision = sphereTriangleCollision(checkPos, BOT_RADIUS, tri);
      if (collision.collided && collision.penetration > 0.05) {
        return true;
      }
    }
    return false;
  }

  // Fast wall resolution - single pass with spatial culling
  static resolveWallCollision(pos: Vector3, mesh: CollisionMesh): Vector3 {
    const checkY = pos.y + 0.5; // Waist height
    let pushX = 0, pushZ = 0;

    // Quick bounds for spatial culling
    const minX = pos.x - BOT_RADIUS - 1;
    const maxX = pos.x + BOT_RADIUS + 1;
    const minZ = pos.z - BOT_RADIUS - 1;
    const maxZ = pos.z + BOT_RADIUS + 1;

    for (const tri of mesh.triangles) {
      // Spatial culling
      const triMinX = Math.min(tri.v0.x, tri.v1.x, tri.v2.x);
      const triMaxX = Math.max(tri.v0.x, tri.v1.x, tri.v2.x);
      const triMinZ = Math.min(tri.v0.z, tri.v1.z, tri.v2.z);
      const triMaxZ = Math.max(tri.v0.z, tri.v1.z, tri.v2.z);

      if (triMaxX < minX || triMinX > maxX || triMaxZ < minZ || triMinZ > maxZ) continue;

      // Skip floors/ceilings
      if (Math.abs(tri.normal.y) > SLOPE_LIMIT) continue;

      const checkPos = new Vector3(pos.x, checkY, pos.z);
      const collision = sphereTriangleCollision(checkPos, BOT_RADIUS, tri);
      if (collision.collided && collision.penetration > 0.01) {
        pushX += collision.pushOut.x;
        pushZ += collision.pushOut.z;
      }
    }

    return new Vector3(pos.x + pushX * 1.1, pos.y, pos.z + pushZ * 1.1);
  }

  // Fast ground finding with spatial culling (much faster than findGroundBelow)
  static fastFindGround(pos: Vector3, mesh: CollisionMesh): { found: boolean; groundY: number } {
    const searchRadius = 2.0;
    const minX = pos.x - searchRadius;
    const maxX = pos.x + searchRadius;
    const minZ = pos.z - searchRadius;
    const maxZ = pos.z + searchRadius;

    let bestY = -Infinity;
    let found = false;

    for (const tri of mesh.triangles) {
      // Only check floor-like triangles (pointing up)
      if (tri.normal.y < SLOPE_LIMIT) continue;

      // Spatial culling
      const triMinX = Math.min(tri.v0.x, tri.v1.x, tri.v2.x);
      const triMaxX = Math.max(tri.v0.x, tri.v1.x, tri.v2.x);
      if (triMaxX < minX || triMinX > maxX) continue;

      const triMinZ = Math.min(tri.v0.z, tri.v1.z, tri.v2.z);
      const triMaxZ = Math.max(tri.v0.z, tri.v1.z, tri.v2.z);
      if (triMaxZ < minZ || triMinZ > maxZ) continue;

      // Quick Y range check
      const triMaxY = Math.max(tri.v0.y, tri.v1.y, tri.v2.y);
      if (triMaxY > pos.y + 2) continue; // Too high above us
      if (triMaxY < pos.y - 10) continue; // Too far below

      // Simple point-in-triangle check (2D projection)
      if (this.pointInTriXZ(pos.x, pos.z, tri)) {
        // Interpolate Y at this XZ position
        const y = this.triangleYAtXZ(pos.x, pos.z, tri);
        if (y !== null && y > bestY && y < pos.y + 1) {
          bestY = y;
          found = true;
        }
      }
    }

    return { found, groundY: bestY };
  }

  // Check if point is inside triangle (XZ projection)
  private static pointInTriXZ(px: number, pz: number, tri: { v0: Vector3; v1: Vector3; v2: Vector3 }): boolean {
    const v0x = tri.v2.x - tri.v0.x, v0z = tri.v2.z - tri.v0.z;
    const v1x = tri.v1.x - tri.v0.x, v1z = tri.v1.z - tri.v0.z;
    const v2x = px - tri.v0.x, v2z = pz - tri.v0.z;

    const dot00 = v0x * v0x + v0z * v0z;
    const dot01 = v0x * v1x + v0z * v1z;
    const dot02 = v0x * v2x + v0z * v2z;
    const dot11 = v1x * v1x + v1z * v1z;
    const dot12 = v1x * v2x + v1z * v2z;

    const invDenom = 1 / (dot00 * dot11 - dot01 * dot01);
    const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
    const v = (dot00 * dot12 - dot01 * dot02) * invDenom;

    return (u >= -0.01) && (v >= -0.01) && (u + v <= 1.01);
  }

  // Get Y coordinate at XZ position on triangle
  private static triangleYAtXZ(px: number, pz: number, tri: { v0: Vector3; v1: Vector3; v2: Vector3; normal: Vector3 }): number | null {
    // Plane equation: normal.x*(x-v0.x) + normal.y*(y-v0.y) + normal.z*(z-v0.z) = 0
    // Solve for y: y = v0.y - (normal.x*(px-v0.x) + normal.z*(pz-v0.z)) / normal.y
    if (Math.abs(tri.normal.y) < 0.01) return null;
    return tri.v0.y - (tri.normal.x * (px - tri.v0.x) + tri.normal.z * (pz - tri.v0.z)) / tri.normal.y;
  }

  // Apply movement with collision - simplified and fast for bots
  static applyMovement(bot: Bot, movement: Vector3, colliders: AABB[], deltaTime: number): Vector3 {
    const feetPos = bot.getFeetPosition();
    const collisionMesh = getGlobalCollisionMesh();

    // Use mesh collision if available (BSP maps)
    if (collisionMesh && collisionMesh.triangles.length > 0) {
      // Skip collision if barely moving (optimization)
      const moveDist = Math.abs(movement.x) + Math.abs(movement.z);

      let newFeetPos: Vector3;
      if (moveDist < 0.001) {
        // Not moving horizontally, keep position
        newFeetPos = feetPos.clone();
      } else {
        // Calculate intended new position
        newFeetPos = new Vector3(
          feetPos.x + movement.x,
          feetPos.y,
          feetPos.z + movement.z
        );

        // Check if movement is blocked - if so, try wall sliding
        if (this.isMovementBlocked(feetPos, newFeetPos, collisionMesh)) {
          // Try wall sliding: attempt X-only or Z-only movement
          const slideX = new Vector3(feetPos.x + movement.x, feetPos.y, feetPos.z);
          const slideZ = new Vector3(feetPos.x, feetPos.y, feetPos.z + movement.z);

          const canSlideX = !this.isMovementBlocked(feetPos, slideX, collisionMesh);
          const canSlideZ = !this.isMovementBlocked(feetPos, slideZ, collisionMesh);

          if (canSlideX && canSlideZ) {
            // Both work - pick the one with more movement
            newFeetPos = Math.abs(movement.x) > Math.abs(movement.z) ? slideX : slideZ;
          } else if (canSlideX) {
            newFeetPos = slideX;
          } else if (canSlideZ) {
            newFeetPos = slideZ;
          } else {
            // Both blocked - try diagonal slides at reduced movement
            const diagLeft = new Vector3(
              feetPos.x + movement.z * 0.5,
              feetPos.y,
              feetPos.z - movement.x * 0.5
            );
            const diagRight = new Vector3(
              feetPos.x - movement.z * 0.5,
              feetPos.y,
              feetPos.z + movement.x * 0.5
            );

            if (!this.isMovementBlocked(feetPos, diagLeft, collisionMesh)) {
              newFeetPos = diagLeft;
            } else if (!this.isMovementBlocked(feetPos, diagRight, collisionMesh)) {
              newFeetPos = diagRight;
            } else {
              // Completely blocked - stay in place
              newFeetPos.x = feetPos.x;
              newFeetPos.z = feetPos.z;
            }
          }
        }

        // Resolve any wall penetrations
        newFeetPos = this.resolveWallCollision(newFeetPos, collisionMesh);
      }

      // Ground detection using fast method
      const groundCheck = this.fastFindGround(newFeetPos, collisionMesh);

      if (groundCheck.found) {
        const groundDist = newFeetPos.y - groundCheck.groundY;

        // Snap to ground if within reasonable distance
        if (groundDist <= 1.5 && groundDist >= -1.0) {
          newFeetPos.y = groundCheck.groundY;

          // Handle jump request when on ground
          if (bot.wantsToJump && bot.verticalVelocity <= 0) {
            bot.verticalVelocity = 8; // Jump velocity
            bot.wantsToJump = false;
            newFeetPos.y += bot.verticalVelocity * deltaTime;
          } else {
            bot.verticalVelocity = 0;
          }
        } else if (groundDist > 1.5) {
          // Falling - apply gravity
          let verticalVel = bot.verticalVelocity || 0;
          verticalVel -= GRAVITY * deltaTime;
          verticalVel = Math.max(verticalVel, -8); // Slower fall for bots
          newFeetPos.y += verticalVel * deltaTime;
          bot.verticalVelocity = verticalVel;

          // Snap if we crossed ground
          if (newFeetPos.y <= groundCheck.groundY) {
            newFeetPos.y = groundCheck.groundY;
            bot.verticalVelocity = 0;
          }
        } else {
          // Below ground - push up
          newFeetPos.y = groundCheck.groundY;
          bot.verticalVelocity = 0;
        }
      } else {
        // No ground - apply gentle gravity
        let verticalVel = bot.verticalVelocity || 0;
        verticalVel -= GRAVITY * 0.3 * deltaTime;
        verticalVel = Math.max(verticalVel, -3); // Very slow fall when no ground
        newFeetPos.y += verticalVel * deltaTime;
        bot.verticalVelocity = verticalVel;
      }

      // Clear jump flag if in air
      if (bot.verticalVelocity !== 0) {
        bot.wantsToJump = false;
      }

      return new Vector3(
        newFeetPos.x,
        newFeetPos.y + bot.config.eyeHeight,
        newFeetPos.z
      );
    } else {
      // Fall back to AABB collision
      const onGround = checkOnGround(feetPos, BOT_RADIUS, colliders);

      if (!onGround) {
        movement.y -= GRAVITY * deltaTime;
      }

      const newFeetPos = moveAndSlide(
        feetPos,
        movement,
        BOT_RADIUS,
        BOT_HEIGHT,
        colliders
      );

      return new Vector3(
        newFeetPos.x,
        newFeetPos.y + bot.config.eyeHeight,
        newFeetPos.z
      );
    }
  }

  // IDLE state - just spawned, start moving immediately
  static handleIdle(bot: Bot, ctx: BotThinkContext, canSeeTarget: boolean): Vector3 {
    const { now, player, allBots, teamMode } = ctx;

    if (canSeeTarget) {
      // React after reaction time
      if (now - bot.stateStartTime > bot.botConfig.reactionTime) {
        bot.setState('attack', now);
      }
      return Vector3.zero();
    }

    // Start patrolling almost immediately - bots should always be moving
    if (now - bot.stateStartTime > 100) {
      bot.setState('patrol', now);

      // Initialize smoothedAngle based on role:
      // - Enemies: disperse in unique direction until they find enemies
      // - Teammates: toward player if close, else toward enemies
      const isTeammate = teamMode && bot.isTeammate(player);
      const distToPlayer = Vector3.sub(player.position, bot.position).length();
      const shouldDisperseNow = this.shouldDisperse(bot, player, allBots, teamMode || false);

      if (shouldDisperseNow) {
        // Enemy bots: use unique disperse angle to spread out
        bot.smoothedAngle = this.getDisperseAngle(bot);
      } else if (isTeammate && player.isAlive && distToPlayer <= 5) {
        // Close teammates start moving toward player
        const dx = player.position.x - bot.position.x;
        const dz = player.position.z - bot.position.z;
        bot.smoothedAngle = Math.atan2(dx, dz);
      } else {
        // Hunt enemies
        const initTarget = this.findNearestEnemy(bot, player, allBots, teamMode || false);
        if (initTarget) {
          const dx = initTarget.x - bot.position.x;
          const dz = initTarget.z - bot.position.z;
          bot.smoothedAngle = Math.atan2(dx, dz);
        } else {
          bot.smoothedAngle = Math.random() * Math.PI * 2 - Math.PI;
        }
      }
      bot.hasInitializedAngle = true;

      // Start moving immediately using momentumMove
      return this.momentumMove(bot, ctx, null);
    }

    return Vector3.zero();
  }

  // PATROL state - moving between waypoints using steering behavior
  static handlePatrol(bot: Bot, ctx: BotThinkContext, canSeeTarget: boolean): Vector3 {
    const { now } = ctx;

    // If we can see an enemy, attack!
    if (canSeeTarget) {
      bot.setState('attack', now);
      return Vector3.zero();
    }

    // Check if we heard something or saw someone recently - investigate
    if (bot.lastSeenTargetPos && now - bot.lastSeenTargetTime < 5000) {
      bot.setState('chase', now);
      bot.moveTarget = bot.lastSeenTargetPos;
      return Vector3.zero();
    }

    // Get target - next waypoint or wander
    let targetPos = bot.getNextWaypoint();
    if (!targetPos) {
      // No waypoints - generate wander target periodically
      if (!bot.moveTarget || Vector3.sub(bot.moveTarget, bot.position).length() < 3) {
        const wanderDist = 10 + Math.random() * 15;
        const wanderAngle = bot.smoothedAngle + (Math.random() - 0.5) * Math.PI; // Vary from current direction
        bot.moveTarget = new Vector3(
          bot.position.x + Math.sin(wanderAngle) * wanderDist,
          bot.position.y,
          bot.position.z + Math.cos(wanderAngle) * wanderDist
        );
      }
      targetPos = bot.moveTarget;
    } else {
      bot.moveTarget = targetPos;
    }

    // Tactical reload while patrolling
    const weapon = bot.getCurrentWeapon();
    if (weapon && !weapon.isReloading && weapon.currentAmmo < weapon.def.magazineSize && weapon.reserveAmmo > 0) {
      bot.reload(now);
    }

    // Use momentum-based movement
    return this.momentumMove(bot, ctx, targetPos);
  }

  // CHASE state - investigate last known position or sound using steering
  static handleChase(bot: Bot, ctx: BotThinkContext, canSeeTarget: boolean): Vector3 {
    const { now } = ctx;

    // If we can see an enemy, attack!
    if (canSeeTarget) {
      bot.setState('attack', now);
      return Vector3.zero();
    }

    // No last seen/heard position - go back to patrol
    if (!bot.lastSeenTargetPos) {
      bot.setState('patrol', now);
      return Vector3.zero();
    }

    // Check if reached last known position
    const distanceToTarget = Vector3.sub(bot.lastSeenTargetPos, bot.position).length();
    if (distanceToTarget < 2) {
      // Arrived at location - nothing here, go back to patrol
      bot.lastSeenTargetPos = null;
      bot.setState('patrol', now);
      return Vector3.zero();
    }

    // Give up after 8 seconds of chasing
    if (now - bot.lastSeenTargetTime > 8000) {
      bot.lastSeenTargetPos = null;
      bot.setState('patrol', now);
      return Vector3.zero();
    }

    // Use momentum-based movement toward last known position
    bot.moveTarget = bot.lastSeenTargetPos;
    return this.momentumMove(bot, ctx, bot.lastSeenTargetPos);
  }

  // ATTACK state - engaging the target (player or other bot)
  static handleAttack(bot: Bot, ctx: BotThinkContext, canSeeTarget: boolean): Vector3 {
    const { now, colliders, deltaTime } = ctx;

    // Use tracked target
    const target = bot.target;
    if (!target || !target.isAlive) {
      bot.setState('patrol', now);
      return Vector3.zero();
    }

    if (!canSeeTarget) {
      // Lost sight, chase to last known position
      bot.setState('chase', now);
      return Vector3.zero();
    }

    // Check health - flee if low and not aggressive
    if (bot.health < 30 && Math.random() > bot.botConfig.aggressiveness) {
      bot.setState('flee', now);
      return Vector3.zero();
    }

    const targetPos = target.getEyePosition();
    const distance = Vector3.sub(targetPos, bot.position).length();

    // Look at target
    bot.lookAt(targetPos);

    // Get current weapon
    const weapon = bot.getCurrentWeapon();
    if (!weapon) return Vector3.zero();

    // Decide movement - strafe during combat
    let movement = Vector3.zero();
    const optimalRange = weapon.def.range * 0.5;

    if (distance > optimalRange + 5) {
      // Too far, move closer
      movement = bot.getMoveToward(targetPos, MOVE_SPEED, deltaTime);
    } else if (distance < optimalRange - 5) {
      // Too close, back up
      const awayDir = Vector3.sub(bot.position, targetPos).normalize();
      movement = Vector3.scale(awayDir, MOVE_SPEED * deltaTime);
      movement.y = 0;
    } else {
      // Good range, strafe
      const strafeDir = bot.getRight();
      const strafeSign = Math.sin(now * 0.002) > 0 ? 1 : -1; // Oscillate
      movement = Vector3.scale(strafeDir, MOVE_SPEED * 0.5 * deltaTime * strafeSign);
    }

    // Check if we need to reload
    if (weapon.currentAmmo <= 0 && weapon.reserveAmmo > 0 && !weapon.isReloading) {
      bot.reload(now);
    }

    // Try to fire - bots have a minimum fire interval based on difficulty
    // This prevents them from emptying magazines too quickly
    const minFireInterval = bot.botConfig.reactionTime; // Use reaction time as min interval
    const timeSinceLastFire = now - bot.lastFireTime;

    if (bot.canFire(now) && timeSinceLastFire >= minFireInterval) {
      // Check if within weapon range
      if (distance <= weapon.def.range) {
        bot.fire(now);
        bot.lastFireTime = now;
      }
    }

    return this.applyMovement(bot, movement, colliders, deltaTime);
  }

  // FLEE state - running away from current threat using momentum
  static handleFlee(bot: Bot, ctx: BotThinkContext, canSeeTarget: boolean): Vector3 {
    const { now } = ctx;

    // Recover courage after fleeing for a bit
    if (now - bot.stateStartTime > 3000) {
      bot.setState('patrol', now);
      return Vector3.zero();
    }

    // Run away from target (or last known position)
    let fleeFrom = bot.lastSeenTargetPos || (bot.target ? bot.target.position : null);
    if (!fleeFrom) {
      bot.setState('patrol', now);
      return Vector3.zero();
    }

    // Set velocity away from threat
    const awayDir = Vector3.sub(bot.position, fleeFrom);
    awayDir.y = 0;
    if (awayDir.length() > 0.1) {
      bot.setVelocity(awayDir, MOVE_SPEED * 1.2); // Run faster when fleeing
    }

    const fleeTarget = Vector3.add(bot.position, Vector3.scale(awayDir.normalize(), 10));
    bot.moveTarget = fleeTarget;

    return this.momentumMove(bot, ctx, fleeTarget);
  }
}
