// Bot AI decision making
import { Vector3 } from '../engine/math/Vector3.js';
import { Bot, BotState } from './Bot.js';
import { Player } from '../game/Player.js';
import { AABB } from '../maps/MapFormat.js';
import { rayAABBIntersection, moveAndSlide, checkOnGround } from '../physics/Collision.js';

const MOVE_SPEED = 6; // Slightly slower than player
const GRAVITY = 20;
const PLAYER_RADIUS = 0.4;
const PLAYER_HEIGHT = 1.7;

export interface BotThinkContext {
  player: Player;              // The human player (target)
  allBots: Bot[];              // All bots (for bot vs bot combat)
  colliders: AABB[];           // Map collision
  now: number;                 // Current timestamp
  deltaTime: number;           // Time since last frame
}

export class BotBrain {
  // Main think function - called every frame for each bot
  static think(bot: Bot, ctx: BotThinkContext): Vector3 {
    const { player, allBots, colliders, now, deltaTime } = ctx;

    // Don't think if dead
    if (!bot.isAlive) {
      bot.setState('dead', now);
      return Vector3.zero();
    }

    // Throttle AI updates for performance
    if (now - bot.lastThinkTime < bot.thinkInterval) {
      // Still apply movement toward current target
      return this.continueMovement(bot, colliders, deltaTime);
    }
    bot.lastThinkTime = now;

    // Find closest visible target (player or other bot)
    const { target: visibleTarget, canSee } = this.findClosestTarget(bot, player, allBots, colliders);

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
  static findClosestTarget(
    bot: Bot,
    player: Player,
    allBots: Bot[],
    colliders: AABB[]
  ): { target: Player | null; canSee: boolean } {
    let closestTarget: Player | null = null;
    let closestDistance = Infinity;

    // Check player
    if (player.isAlive) {
      const canSeePlayer = bot.canSeePlayer(player, (from, to) => {
        return this.hasLineOfSight(from, to, colliders);
      });
      if (canSeePlayer) {
        const dist = Vector3.sub(player.position, bot.position).length();
        if (dist < closestDistance) {
          closestDistance = dist;
          closestTarget = player;
        }
      }
    }

    // Check other bots
    for (const otherBot of allBots) {
      if (otherBot === bot || !otherBot.isAlive) continue;

      const canSeeBot = bot.canSeePlayer(otherBot, (from, to) => {
        return this.hasLineOfSight(from, to, colliders);
      });
      if (canSeeBot) {
        const dist = Vector3.sub(otherBot.position, bot.position).length();
        if (dist < closestDistance) {
          closestDistance = dist;
          closestTarget = otherBot;
        }
      }
    }

    return { target: closestTarget, canSee: closestTarget !== null };
  }

  // Check line of sight between two points
  static hasLineOfSight(from: Vector3, to: Vector3, colliders: AABB[]): boolean {
    const direction = Vector3.sub(to, from);
    const distance = direction.length();
    const dir = direction.normalize();

    for (const collider of colliders) {
      const result = rayAABBIntersection(from, dir, collider);
      if (result.hit && result.distance < distance - 0.1) {
        return false; // Something is in the way
      }
    }
    return true;
  }

  // Continue current movement without full AI update
  static continueMovement(bot: Bot, colliders: AABB[], deltaTime: number): Vector3 {
    if (!bot.moveTarget) return Vector3.zero();

    const movement = bot.getMoveToward(bot.moveTarget, MOVE_SPEED, deltaTime);
    return this.applyMovement(bot, movement, colliders, deltaTime);
  }

  // Apply movement with collision
  static applyMovement(bot: Bot, movement: Vector3, colliders: AABB[], deltaTime: number): Vector3 {
    // Apply gravity if not on ground
    const feetPos = bot.getFeetPosition();
    const onGround = checkOnGround(feetPos, PLAYER_RADIUS, colliders);

    if (!onGround) {
      movement.y -= GRAVITY * deltaTime;
    }

    // Move with collision
    const newFeetPos = moveAndSlide(
      feetPos,
      movement,
      PLAYER_RADIUS,
      PLAYER_HEIGHT,
      colliders
    );

    // Update bot position (convert feet to eye level)
    const newPos = new Vector3(
      newFeetPos.x,
      newFeetPos.y + bot.config.eyeHeight,
      newFeetPos.z
    );

    return newPos;
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

    // Try to fire
    if (bot.canFire(now)) {
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
