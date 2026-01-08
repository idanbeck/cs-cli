// Bot AI decision making
import { Vector3 } from '../engine/math/Vector3.js';
import { Bot, BotState } from './Bot.js';
import { Player } from '../game/Player.js';
import { AABB } from '../maps/MapFormat.js';
import { rayAABBIntersection, moveAndSlide, checkOnGround } from '../physics/Collision.js';
import { getGlobalCollisionMesh, moveWithMeshCollision, checkGroundMesh, raycastMesh, findGroundBelow, sphereTriangleCollision, capsuleTriangleCollision, CollisionMesh } from '../physics/MeshCollision.js';

const MOVE_SPEED = 6; // Slightly slower than player
const GRAVITY = 20;
const BOT_RADIUS = 1.0;      // Large radius to prevent falling through crevices
const BOT_HEIGHT = 1.8;
const SLOPE_LIMIT = 0.5;     // More forgiving slope detection
const MAX_LOS_DISTANCE = 40; // Skip LOS checks beyond this distance

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

    // Find closest visible target (player or other bot), respecting team mode
    const { target: visibleTarget, canSee } = this.findClosestTarget(bot, player, allBots, colliders, teamMode);

    // Update target tracking
    if (canSee && visibleTarget) {
      bot.target = visibleTarget;
      bot.lastSeenTargetPos = visibleTarget.getEyePosition().clone();
      bot.lastSeenTargetTime = now;
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
          // Only do FOV check, skip expensive raycast if player is close
          if (bot.canSeePosition(player.getEyePosition())) {
            // Only do LOS check if within reasonable distance
            if (dist < MAX_LOS_DISTANCE) {
              if (this.hasLineOfSight(bot.getEyePosition(), player.getEyePosition(), colliders)) {
                closestDistance = dist;
                closestTarget = player;
              }
            } else {
              // Far away, assume visible if in FOV (skip raycast)
              closestDistance = dist;
              closestTarget = player;
            }
          }
        }
      }
    }

    // Only check bot-vs-bot if team mode AND not too many bots (performance)
    // Skip bot-vs-bot entirely in non-team mode to focus on player
    if (teamMode && allBots.length <= 8) {
      for (const otherBot of allBots) {
        if (otherBot === bot || !otherBot.isAlive) continue;
        if (!bot.isEnemy(otherBot)) continue;

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
  static continueMovement(bot: Bot, colliders: AABB[], deltaTime: number): Vector3 {
    if (!bot.moveTarget) return Vector3.zero();

    const movement = bot.getMoveToward(bot.moveTarget, MOVE_SPEED, deltaTime);
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

        // Check if movement is blocked - if so, don't move horizontally
        if (this.isMovementBlocked(feetPos, newFeetPos, collisionMesh)) {
          newFeetPos.x = feetPos.x;
          newFeetPos.z = feetPos.z;
        } else {
          // Resolve any wall penetrations
          newFeetPos = this.resolveWallCollision(newFeetPos, collisionMesh);
        }
      }

      // Ground detection using fast method
      const groundCheck = this.fastFindGround(newFeetPos, collisionMesh);

      if (groundCheck.found) {
        const groundDist = newFeetPos.y - groundCheck.groundY;

        // Snap to ground if within reasonable distance
        if (groundDist <= 1.5 && groundDist >= -1.0) {
          newFeetPos.y = groundCheck.groundY;
          bot.verticalVelocity = 0;
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

  // IDLE state - just spawned or nothing to do
  static handleIdle(bot: Bot, ctx: BotThinkContext, canSeePlayer: boolean): Vector3 {
    const { now, colliders, deltaTime } = ctx;

    if (canSeePlayer) {
      // React after reaction time
      if (now - bot.stateStartTime > bot.botConfig.reactionTime) {
        bot.setState('attack', now);
      }
      return Vector3.zero();
    }

    // Start patrolling after a short delay
    if (now - bot.stateStartTime > 500) {
      bot.setState('patrol', now);
    }

    return Vector3.zero();
  }

  // PATROL state - moving between waypoints
  static handlePatrol(bot: Bot, ctx: BotThinkContext, canSeePlayer: boolean): Vector3 {
    const { now, colliders, deltaTime } = ctx;

    if (canSeePlayer) {
      bot.setState('attack', now);
      return Vector3.zero();
    }

    // Check if we remember seeing player recently
    if (bot.lastSeenTargetPos && now - bot.lastSeenTargetTime < 5000) {
      bot.setState('chase', now);
      bot.moveTarget = bot.lastSeenTargetPos;
      return Vector3.zero();
    }

    // Get next waypoint
    const waypoint = bot.getNextWaypoint();
    if (!waypoint) {
      // No waypoints, just stand still
      return Vector3.zero();
    }

    bot.moveTarget = waypoint;
    bot.lookAt(waypoint);

    const movement = bot.getMoveToward(waypoint, MOVE_SPEED, deltaTime);
    return this.applyMovement(bot, movement, colliders, deltaTime);
  }

  // CHASE state - moving to last known player position
  static handleChase(bot: Bot, ctx: BotThinkContext, canSeePlayer: boolean): Vector3 {
    const { now, colliders, deltaTime } = ctx;

    if (canSeePlayer) {
      bot.setState('attack', now);
      return Vector3.zero();
    }

    if (!bot.lastSeenTargetPos) {
      bot.setState('patrol', now);
      return Vector3.zero();
    }

    // Check if reached last seen position
    const distanceToTarget = Vector3.sub(bot.lastSeenTargetPos, bot.position).length();
    if (distanceToTarget < 2) {
      // Lost them, go back to patrol
      bot.lastSeenTargetPos = null;
      bot.setState('patrol', now);
      return Vector3.zero();
    }

    // Give up after 10 seconds
    if (now - bot.lastSeenTargetTime > 10000) {
      bot.lastSeenTargetPos = null;
      bot.setState('patrol', now);
      return Vector3.zero();
    }

    bot.moveTarget = bot.lastSeenTargetPos;
    bot.lookAt(bot.lastSeenTargetPos);

    const movement = bot.getMoveToward(bot.lastSeenTargetPos, MOVE_SPEED, deltaTime);
    return this.applyMovement(bot, movement, colliders, deltaTime);
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

  // FLEE state - running away from current threat
  static handleFlee(bot: Bot, ctx: BotThinkContext, canSeeTarget: boolean): Vector3 {
    const { now, colliders, deltaTime } = ctx;

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

    const awayDir = Vector3.sub(bot.position, fleeFrom);
    awayDir.y = 0;
    awayDir.normalize();

    const fleeTarget = Vector3.add(bot.position, Vector3.scale(awayDir, 10));
    bot.moveTarget = fleeTarget;

    const movement = Vector3.scale(awayDir, MOVE_SPEED * 1.2 * deltaTime); // Run faster

    return this.applyMovement(bot, movement, colliders, deltaTime);
  }
}
