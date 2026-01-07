// Collision detection and response for CS-CLI

import { Vector3 } from '../engine/math/Vector3.js';
import { AABB } from '../maps/MapFormat.js';

// Player collision capsule (simplified as a vertical cylinder/box)
export interface PlayerCollider {
  position: Vector3;  // Feet position
  radius: number;     // Horizontal radius
  height: number;     // Full height
}

// Collision result
export interface CollisionResult {
  collided: boolean;
  normal: Vector3;      // Surface normal at collision point
  penetration: number;  // How far we penetrated
  point: Vector3;       // Collision point
}

// Check if a point is inside an AABB
export function pointInAABB(point: Vector3, aabb: AABB): boolean {
  return (
    point.x >= aabb.min.x && point.x <= aabb.max.x &&
    point.y >= aabb.min.y && point.y <= aabb.max.y &&
    point.z >= aabb.min.z && point.z <= aabb.max.z
  );
}

// Check if two AABBs overlap
export function aabbOverlap(a: AABB, b: AABB): boolean {
  return (
    a.min.x <= b.max.x && a.max.x >= b.min.x &&
    a.min.y <= b.max.y && a.max.y >= b.min.y &&
    a.min.z <= b.max.z && a.max.z >= b.min.z
  );
}

// Get the AABB for a player at a given position
export function getPlayerAABB(position: Vector3, radius: number, height: number): AABB {
  return {
    min: new Vector3(
      position.x - radius,
      position.y,
      position.z - radius
    ),
    max: new Vector3(
      position.x + radius,
      position.y + height,
      position.z + radius
    )
  };
}

// Check player collision against world colliders and resolve
export function resolvePlayerCollision(
  position: Vector3,
  velocity: Vector3,
  radius: number,
  height: number,
  colliders: AABB[],
  deltaTime: number
): { newPosition: Vector3; newVelocity: Vector3; onGround: boolean } {
  // Start with the intended new position
  let newPos = Vector3.add(position, Vector3.scale(velocity, deltaTime));
  let newVel = velocity.clone();
  let onGround = false;

  // Get player AABB at new position
  let playerAABB = getPlayerAABB(newPos, radius, height);

  // Check against all colliders and resolve
  for (const collider of colliders) {
    if (!aabbOverlap(playerAABB, collider)) {
      continue;
    }

    // Calculate overlap on each axis
    const overlapX = Math.min(playerAABB.max.x - collider.min.x, collider.max.x - playerAABB.min.x);
    const overlapY = Math.min(playerAABB.max.y - collider.min.y, collider.max.y - playerAABB.min.y);
    const overlapZ = Math.min(playerAABB.max.z - collider.min.z, collider.max.z - playerAABB.min.z);

    // Find the axis with minimum overlap (most likely collision direction)
    if (overlapX < overlapY && overlapX < overlapZ) {
      // X-axis collision
      if (newPos.x > (collider.min.x + collider.max.x) / 2) {
        newPos.x += overlapX;
      } else {
        newPos.x -= overlapX;
      }
      newVel.x = 0;
    } else if (overlapY < overlapZ) {
      // Y-axis collision
      if (newPos.y + height / 2 > (collider.min.y + collider.max.y) / 2) {
        // Collision from above (standing on something)
        newPos.y = collider.max.y;
        onGround = true;
        newVel.y = 0;
      } else {
        // Collision from below (hitting head)
        newPos.y = collider.min.y - height;
        newVel.y = 0;
      }
    } else {
      // Z-axis collision
      if (newPos.z > (collider.min.z + collider.max.z) / 2) {
        newPos.z += overlapZ;
      } else {
        newPos.z -= overlapZ;
      }
      newVel.z = 0;
    }

    // Update player AABB for next iteration
    playerAABB = getPlayerAABB(newPos, radius, height);
  }

  // Ground check (y = 0 is the floor)
  if (newPos.y <= 0) {
    newPos.y = 0;
    newVel.y = 0;
    onGround = true;
  }

  return { newPosition: newPos, newVelocity: newVel, onGround };
}

// Step height - player can step over obstacles this tall
const STEP_HEIGHT = 0.5;

// Check if a collider actually blocks horizontal movement
// (only blocks if it's above step height relative to player feet)
function collidersBlockHorizontal(playerAABB: AABB, colliders: AABB[], feetY: number): boolean {
  for (const collider of colliders) {
    if (!aabbOverlap(playerAABB, collider)) continue;

    // Only block if the collider top is above step height
    // (i.e., it's a wall, not something we can step over/onto)
    if (collider.max.y > feetY + STEP_HEIGHT) {
      return true;
    }
  }
  return false;
}

// Debug flag for collision logging
let debugCollision = false;
export function setDebugCollision(enabled: boolean) {
  debugCollision = enabled;
}

// Flag to disable collision for testing
let collisionEnabled = true;
export function setCollisionEnabled(enabled: boolean) {
  collisionEnabled = enabled;
}

// Simpler collision check for movement (slide along walls)
export function moveAndSlide(
  position: Vector3,
  movement: Vector3,
  radius: number,
  height: number,
  colliders: AABB[]
): Vector3 {
  let newPos = position.clone();
  const feetY = position.y;

  // If no movement, return early
  if (movement.x === 0 && movement.y === 0 && movement.z === 0) {
    return newPos;
  }

  // If collision is disabled, just apply movement directly
  if (!collisionEnabled) {
    return Vector3.add(position, movement);
  }

  // Try to move on each axis separately for sliding behavior
  // X axis
  if (movement.x !== 0) {
    const testX = new Vector3(position.x + movement.x, position.y, position.z);
    const playerAABBX = getPlayerAABB(testX, radius, height);
    if (!collidersBlockHorizontal(playerAABBX, colliders, feetY)) {
      newPos.x = testX.x;
    } else if (debugCollision) {
      console.log(`X blocked at ${testX.x}`);
    }
  }

  // Z axis
  if (movement.z !== 0) {
    const testZ = new Vector3(newPos.x, position.y, position.z + movement.z);
    const playerAABBZ = getPlayerAABB(testZ, radius, height);
    if (!collidersBlockHorizontal(playerAABBZ, colliders, feetY)) {
      newPos.z = testZ.z;
    } else if (debugCollision) {
      console.log(`Z blocked at ${testZ.z}`);
    }
  }

  // Y axis (vertical movement)
  if (movement.y !== 0) {
    const testY = new Vector3(newPos.x, position.y + movement.y, newPos.z);
    let blockedY = false;
    const playerAABBY = getPlayerAABB(testY, radius, height);
    for (const collider of colliders) {
      if (aabbOverlap(playerAABBY, collider)) {
        blockedY = true;
        break;
      }
    }
    if (!blockedY) {
      newPos.y = testY.y;
    }
  }

  // Enforce world floor at y=0 (feet position can't go below 0)
  if (newPos.y < 0) {
    newPos.y = 0;
  }

  return newPos;
}

// Check if player is on ground
export function checkOnGround(
  position: Vector3,
  radius: number,
  colliders: AABB[],
  groundThreshold: number = 0.1
): boolean {
  // Check slightly below feet
  const feetCheck = getPlayerAABB(
    new Vector3(position.x, position.y - groundThreshold, position.z),
    radius,
    groundThreshold
  );

  for (const collider of colliders) {
    if (aabbOverlap(feetCheck, collider)) {
      return true;
    }
  }

  // Also check against y=0 (world floor)
  return position.y <= groundThreshold;
}

// Ray-AABB intersection for shooting/line of sight
export function rayAABBIntersection(
  rayOrigin: Vector3,
  rayDirection: Vector3,
  aabb: AABB
): { hit: boolean; distance: number; point: Vector3; normal: Vector3 } {
  const invDir = new Vector3(
    1 / rayDirection.x,
    1 / rayDirection.y,
    1 / rayDirection.z
  );

  const t1 = (aabb.min.x - rayOrigin.x) * invDir.x;
  const t2 = (aabb.max.x - rayOrigin.x) * invDir.x;
  const t3 = (aabb.min.y - rayOrigin.y) * invDir.y;
  const t4 = (aabb.max.y - rayOrigin.y) * invDir.y;
  const t5 = (aabb.min.z - rayOrigin.z) * invDir.z;
  const t6 = (aabb.max.z - rayOrigin.z) * invDir.z;

  const tmin = Math.max(
    Math.max(Math.min(t1, t2), Math.min(t3, t4)),
    Math.min(t5, t6)
  );
  const tmax = Math.min(
    Math.min(Math.max(t1, t2), Math.max(t3, t4)),
    Math.max(t5, t6)
  );

  // No intersection
  if (tmax < 0 || tmin > tmax) {
    return {
      hit: false,
      distance: Infinity,
      point: Vector3.zero(),
      normal: Vector3.zero()
    };
  }

  const distance = tmin >= 0 ? tmin : tmax;
  const point = Vector3.add(rayOrigin, Vector3.scale(rayDirection, distance));

  // Determine hit normal
  let normal = Vector3.zero();
  const epsilon = 0.001;
  if (Math.abs(point.x - aabb.min.x) < epsilon) normal = new Vector3(-1, 0, 0);
  else if (Math.abs(point.x - aabb.max.x) < epsilon) normal = new Vector3(1, 0, 0);
  else if (Math.abs(point.y - aabb.min.y) < epsilon) normal = new Vector3(0, -1, 0);
  else if (Math.abs(point.y - aabb.max.y) < epsilon) normal = new Vector3(0, 1, 0);
  else if (Math.abs(point.z - aabb.min.z) < epsilon) normal = new Vector3(0, 0, -1);
  else if (Math.abs(point.z - aabb.max.z) < epsilon) normal = new Vector3(0, 0, 1);

  return { hit: true, distance, point, normal };
}
