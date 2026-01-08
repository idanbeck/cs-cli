// MeshCollision - Triangle-based collision for BSP maps
// Supports ground detection, wall collision, and ramps/slopes

import { Vector3 } from '../engine/math/Vector3.js';

// A collision triangle
export interface CollisionTriangle {
  v0: Vector3;
  v1: Vector3;
  v2: Vector3;
  normal: Vector3;  // Pre-computed face normal
}

// Collision mesh - collection of triangles for collision detection
export class CollisionMesh {
  triangles: CollisionTriangle[] = [];

  // Add a triangle to the collision mesh
  addTriangle(v0: Vector3, v1: Vector3, v2: Vector3): void {
    // Compute face normal
    const edge1 = Vector3.sub(v1, v0);
    const edge2 = Vector3.sub(v2, v0);
    const normal = Vector3.cross(edge1, edge2).normalize();

    // Skip degenerate triangles
    if (isNaN(normal.x) || isNaN(normal.y) || isNaN(normal.z)) {
      return;
    }

    this.triangles.push({ v0: v0.clone(), v1: v1.clone(), v2: v2.clone(), normal });
  }

  // Clear all triangles
  clear(): void {
    this.triangles = [];
  }
}

// Ray-triangle intersection using Möller–Trumbore algorithm (double-sided)
export function rayTriangleIntersection(
  rayOrigin: Vector3,
  rayDirection: Vector3,
  tri: CollisionTriangle
): { hit: boolean; distance: number; point: Vector3 } {
  const EPSILON = 0.0000001;

  const edge1 = Vector3.sub(tri.v1, tri.v0);
  const edge2 = Vector3.sub(tri.v2, tri.v0);

  const h = Vector3.cross(rayDirection, edge2);
  const a = Vector3.dot(edge1, h);

  // Ray is parallel to triangle
  if (Math.abs(a) < EPSILON) {
    return { hit: false, distance: Infinity, point: Vector3.zero() };
  }

  const f = 1.0 / a;
  const s = Vector3.sub(rayOrigin, tri.v0);
  const u = f * Vector3.dot(s, h);

  if (u < 0.0 || u > 1.0) {
    return { hit: false, distance: Infinity, point: Vector3.zero() };
  }

  const q = Vector3.cross(s, edge1);
  const v = f * Vector3.dot(rayDirection, q);

  if (v < 0.0 || u + v > 1.0) {
    return { hit: false, distance: Infinity, point: Vector3.zero() };
  }

  const t = f * Vector3.dot(edge2, q);

  if (t > EPSILON) {
    const point = Vector3.add(rayOrigin, Vector3.scale(rayDirection, t));
    return { hit: true, distance: t, point };
  }

  return { hit: false, distance: Infinity, point: Vector3.zero() };
}

// Raycast against a collision mesh
export function raycastMesh(
  rayOrigin: Vector3,
  rayDirection: Vector3,
  mesh: CollisionMesh,
  maxDistance: number = Infinity
): { hit: boolean; distance: number; point: Vector3; normal: Vector3; triangle: CollisionTriangle | null } {
  let closestHit = {
    hit: false,
    distance: Infinity,
    point: Vector3.zero(),
    normal: Vector3.zero(),
    triangle: null as CollisionTriangle | null,
  };

  for (const tri of mesh.triangles) {
    const result = rayTriangleIntersection(rayOrigin, rayDirection, tri);
    if (result.hit && result.distance < closestHit.distance && result.distance <= maxDistance) {
      closestHit = {
        hit: true,
        distance: result.distance,
        point: result.point,
        normal: tri.normal.clone(),
        triangle: tri,
      };
    }
  }

  return closestHit;
}

// Ground check - raycast downward from feet position
export function checkGroundMesh(
  position: Vector3,
  mesh: CollisionMesh,
  maxGroundDistance: number = 0.3
): { onGround: boolean; groundY: number; groundNormal: Vector3 } {
  // Cast ray downward from well above feet to catch ground even if we're inside it
  const rayOrigin = new Vector3(position.x, position.y + 1.0, position.z);
  const rayDirection = new Vector3(0, -1, 0);

  // Search further down to find ground
  const result = raycastMesh(rayOrigin, rayDirection, mesh, maxGroundDistance + 2.0);

  if (result.hit) {
    // Check if ground is within reasonable distance from feet
    const groundDist = position.y - result.point.y;
    if (groundDist < maxGroundDistance + 0.5 && groundDist > -1.0) {
      return {
        onGround: true,
        groundY: result.point.y,
        groundNormal: result.normal,
      };
    }
  }

  return {
    onGround: false,
    groundY: -Infinity,
    groundNormal: new Vector3(0, 1, 0),
  };
}

// Sphere-triangle collision (for player collision)
export function sphereTriangleCollision(
  sphereCenter: Vector3,
  sphereRadius: number,
  tri: CollisionTriangle
): { collided: boolean; penetration: number; pushOut: Vector3 } {
  // Find closest point on triangle to sphere center
  const closestPoint = closestPointOnTriangle(sphereCenter, tri);
  const toCenter = Vector3.sub(sphereCenter, closestPoint);
  const distSq = toCenter.x * toCenter.x + toCenter.y * toCenter.y + toCenter.z * toCenter.z;
  const dist = Math.sqrt(distSq);

  if (dist < sphereRadius) {
    const penetration = sphereRadius - dist;
    // Push out along direction from closest point to center
    const pushDir = dist > 0.0001 ? Vector3.scale(toCenter, 1 / dist) : tri.normal.clone();
    const pushOut = Vector3.scale(pushDir, penetration);
    return { collided: true, penetration, pushOut };
  }

  return { collided: false, penetration: 0, pushOut: Vector3.zero() };
}

// Closest point on line segment to a point
function closestPointOnSegment(segStart: Vector3, segEnd: Vector3, point: Vector3): Vector3 {
  const seg = Vector3.sub(segEnd, segStart);
  const segLenSq = Vector3.dot(seg, seg);

  if (segLenSq < 0.0001) return segStart.clone(); // Degenerate segment

  const t = Math.max(0, Math.min(1, Vector3.dot(Vector3.sub(point, segStart), seg) / segLenSq));
  return Vector3.add(segStart, Vector3.scale(seg, t));
}

// Capsule-triangle collision
// Capsule defined by two endpoints (bottom, top) and radius
export function capsuleTriangleCollision(
  capsuleBottom: Vector3,
  capsuleTop: Vector3,
  capsuleRadius: number,
  tri: CollisionTriangle
): { collided: boolean; penetration: number; pushOut: Vector3 } {
  // Find closest point on triangle to the capsule's line segment
  // This is done by finding the closest point on the segment to the triangle,
  // then finding the closest point on the triangle to that point

  // First, find the closest point on the capsule segment to the triangle plane
  const triCenter = Vector3.scale(Vector3.add(Vector3.add(tri.v0, tri.v1), tri.v2), 1/3);

  // Check multiple points along the capsule segment for best collision
  // Use more samples for better coverage on complex geometry
  let bestCollision = { collided: false, penetration: 0, pushOut: Vector3.zero() };

  const numSamples = 5;  // Balanced coverage without catching archways
  const capsuleDir = Vector3.sub(capsuleTop, capsuleBottom);

  for (let i = 0; i <= numSamples; i++) {
    const t = i / numSamples;
    const samplePoint = Vector3.add(capsuleBottom, Vector3.scale(capsuleDir, t));

    const closestOnTri = closestPointOnTriangle(samplePoint, tri);
    const toSample = Vector3.sub(samplePoint, closestOnTri);
    const dist = Math.sqrt(Vector3.dot(toSample, toSample));

    // Check if within radius
    if (dist < capsuleRadius) {
      const penetration = capsuleRadius - dist;
      if (penetration > bestCollision.penetration) {
        const pushDir = dist > 0.0001 ? Vector3.scale(toSample, 1 / dist) : tri.normal.clone();
        bestCollision = {
          collided: true,
          penetration,
          pushOut: Vector3.scale(pushDir, penetration)
        };
      }
    }
  }

  return bestCollision;
}

// Find closest point on triangle to a point
function closestPointOnTriangle(point: Vector3, tri: CollisionTriangle): Vector3 {
  const a = tri.v0;
  const b = tri.v1;
  const c = tri.v2;

  // Check if P in vertex region outside A
  const ab = Vector3.sub(b, a);
  const ac = Vector3.sub(c, a);
  const ap = Vector3.sub(point, a);

  const d1 = Vector3.dot(ab, ap);
  const d2 = Vector3.dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a.clone();

  // Check if P in vertex region outside B
  const bp = Vector3.sub(point, b);
  const d3 = Vector3.dot(ab, bp);
  const d4 = Vector3.dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b.clone();

  // Check if P in edge region of AB
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return Vector3.add(a, Vector3.scale(ab, v));
  }

  // Check if P in vertex region outside C
  const cp = Vector3.sub(point, c);
  const d5 = Vector3.dot(ab, cp);
  const d6 = Vector3.dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c.clone();

  // Check if P in edge region of AC
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return Vector3.add(a, Vector3.scale(ac, w));
  }

  // Check if P in edge region of BC
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return Vector3.add(b, Vector3.scale(Vector3.sub(c, b), w));
  }

  // P inside face region
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return Vector3.add(a, Vector3.add(Vector3.scale(ab, v), Vector3.scale(ac, w)));
}

// Constants for player movement
const STEP_HEIGHT = 0.5;      // Max height player can step up
const SLOPE_LIMIT = 0.6;      // Dot product with up vector - lower = more forgiving on slopes
const PLAYER_RADIUS = 0.4;    // Collision radius
const PLAYER_HEIGHT = 1.8;    // Full height
const MIN_PENETRATION = 0.02; // Ignore tiny penetrations (stair edges, etc)
const MAX_SUBSTEPS = 3;       // Maximum sub-steps for large movements

// Check if a position is blocked by walls at a given height
function checkPositionBlocked(
  pos: Vector3,
  feetHeight: number,
  mesh: CollisionMesh,
  radius: number
): { blocked: boolean; pushOut: Vector3 } {
  // Check above step height to avoid stair geometry
  const checkPos = new Vector3(pos.x, feetHeight + STEP_HEIGHT + 0.2, pos.z);
  let blocked = false;
  let maxPenetration = 0;
  let bestPushOut = Vector3.zero();

  for (const tri of mesh.triangles) {
    const collision = sphereTriangleCollision(checkPos, radius, tri);
    // Only react to significant penetrations
    if (collision.collided && collision.penetration > MIN_PENETRATION) {
      const upDot = Math.abs(tri.normal.y);
      if (upDot < SLOPE_LIMIT) {
        blocked = true;
        if (collision.penetration > maxPenetration) {
          maxPenetration = collision.penetration;
          bestPushOut = collision.pushOut.clone();
        }
      }
    }
  }

  return { blocked, pushOut: bestPushOut };
}

// Iteratively resolve wall collisions using capsule collision (handles corners)
function resolveWallCollisions(
  pos: Vector3,
  feetHeight: number,
  playerHeight: number,
  mesh: CollisionMesh,
  radius: number
): Vector3 {
  const MAX_ITERATIONS = 6;  // Reduced iterations
  let currentPos = pos.clone();

  // Capsule: start above step height to avoid stair geometry, end at chest
  const capsuleBottomOffset = STEP_HEIGHT + 0.1;  // Above stairs
  const capsuleTopOffset = playerHeight - 0.6;    // Chest height

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let totalPush = Vector3.zero();
    let collisionCount = 0;

    const capsuleBottom = new Vector3(currentPos.x, feetHeight + capsuleBottomOffset, currentPos.z);
    const capsuleTop = new Vector3(currentPos.x, feetHeight + capsuleTopOffset, currentPos.z);

    for (const tri of mesh.triangles) {
      const collision = capsuleTriangleCollision(capsuleBottom, capsuleTop, radius, tri);
      // Only react to significant penetrations
      if (collision.collided && collision.penetration > MIN_PENETRATION) {
        const upDot = Math.abs(tri.normal.y);
        if (upDot < SLOPE_LIMIT) {
          // Only horizontal push for walls
          totalPush.x += collision.pushOut.x;
          totalPush.z += collision.pushOut.z;
          collisionCount++;
        }
      }
    }

    if (collisionCount === 0) break;

    // Apply push with small margin
    currentPos.x += totalPush.x * 1.02;
    currentPos.z += totalPush.z * 1.02;
  }

  return currentPos;
}

// Move player with mesh collision, supporting ramps and stairs
export function moveWithMeshCollision(
  position: Vector3,
  velocity: Vector3,
  mesh: CollisionMesh,
  deltaTime: number
): { newPosition: Vector3; newVelocity: Vector3; onGround: boolean } {
  if (mesh.triangles.length === 0) {
    // No collision mesh, just move freely but with basic floor
    const newPos = Vector3.add(position, Vector3.scale(velocity, deltaTime));
    if (newPos.y < 0) newPos.y = 0;
    return { newPosition: newPos, newVelocity: velocity.clone(), onGround: newPos.y <= 0.01 };
  }

  let newVel = velocity.clone();

  // STEP 1: Depenetrate from current position FIRST
  // This ensures we start from a clean state before applying any movement
  let newPos = resolveWallCollisions(position, position.y, PLAYER_HEIGHT, mesh, PLAYER_RADIUS);
  // Keep the original Y since resolveWallCollisions only handles horizontal
  newPos.y = position.y;

  // STEP 2: Apply horizontal movement with sub-stepping to prevent tunneling
  const totalHorizontalMove = new Vector3(velocity.x * deltaTime, 0, velocity.z * deltaTime);
  const moveDistance = Math.sqrt(totalHorizontalMove.x * totalHorizontalMove.x + totalHorizontalMove.z * totalHorizontalMove.z);

  if (moveDistance > 0.001) {
    // Sub-step if movement is large enough to potentially tunnel through walls
    // Safe step size should be less than half the collision radius
    const safeStepSize = PLAYER_RADIUS * 0.4;
    const numSubSteps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(moveDistance / safeStepSize)));

    const subMove = Vector3.scale(totalHorizontalMove, 1 / numSubSteps);

    for (let step = 0; step < numSubSteps; step++) {
      let testPos = Vector3.add(newPos, subMove);
      let finalY = newPos.y;

      // Check collision at multiple heights
      const feetBlocked = checkPositionBlocked(testPos, newPos.y, mesh, PLAYER_RADIUS);
      const midBlocked = checkPositionBlocked(testPos, newPos.y + PLAYER_HEIGHT / 2, mesh, PLAYER_RADIUS);
      const headBlocked = checkPositionBlocked(testPos, newPos.y + PLAYER_HEIGHT - 0.2, mesh, PLAYER_RADIUS);

      if (feetBlocked.blocked && !midBlocked.blocked && !headBlocked.blocked) {
        // Only feet blocked - potential step
        const stepUpPos = new Vector3(testPos.x, newPos.y + STEP_HEIGHT, testPos.z);
        const stepUpFeetBlocked = checkPositionBlocked(stepUpPos, newPos.y + STEP_HEIGHT, mesh, PLAYER_RADIUS);
        const stepUpMidBlocked = checkPositionBlocked(stepUpPos, newPos.y + STEP_HEIGHT + PLAYER_HEIGHT / 2, mesh, PLAYER_RADIUS);

        if (!stepUpFeetBlocked.blocked && !stepUpMidBlocked.blocked) {
          const stepGroundCheck = findGroundBelow(stepUpPos, mesh);
          if (stepGroundCheck.found) {
            const stepGroundDist = (newPos.y + STEP_HEIGHT) - stepGroundCheck.groundY;
            if (stepGroundDist >= 0 && stepGroundDist <= STEP_HEIGHT + 0.1) {
              testPos = stepUpPos;
              finalY = stepGroundCheck.groundY;
            } else {
              // Wall slide
              testPos = Vector3.add(newPos, subMove);
              testPos = Vector3.add(testPos, Vector3.scale(feetBlocked.pushOut, 1.02));
              if (Math.abs(feetBlocked.pushOut.x) > 0.001) newVel.x = 0;
              if (Math.abs(feetBlocked.pushOut.z) > 0.001) newVel.z = 0;
            }
          } else {
            testPos = Vector3.add(newPos, subMove);
            testPos = Vector3.add(testPos, Vector3.scale(feetBlocked.pushOut, 1.02));
            if (Math.abs(feetBlocked.pushOut.x) > 0.001) newVel.x = 0;
            if (Math.abs(feetBlocked.pushOut.z) > 0.001) newVel.z = 0;
          }
        } else {
          testPos = Vector3.add(newPos, subMove);
          testPos = Vector3.add(testPos, Vector3.scale(feetBlocked.pushOut, 1.02));
          if (Math.abs(feetBlocked.pushOut.x) > 0.001) newVel.x = 0;
          if (Math.abs(feetBlocked.pushOut.z) > 0.001) newVel.z = 0;
        }
      } else if (feetBlocked.blocked || midBlocked.blocked || headBlocked.blocked) {
        // Full body blocked - wall slide
        const totalPush = Vector3.add(
          Vector3.add(feetBlocked.pushOut, midBlocked.pushOut),
          headBlocked.pushOut
        );
        testPos = Vector3.add(newPos, subMove);
        testPos = Vector3.add(testPos, Vector3.scale(totalPush, 1.02));
        if (Math.abs(totalPush.x) > 0.001) newVel.x = 0;
        if (Math.abs(totalPush.z) > 0.001) newVel.z = 0;
      }

      // Update position for this sub-step
      newPos.x = testPos.x;
      newPos.z = testPos.z;
      if (finalY !== newPos.y) {
        newPos.y = finalY;
      }

      // Resolve any remaining collisions after each sub-step
      const resolvedPos = resolveWallCollisions(newPos, newPos.y, PLAYER_HEIGHT, mesh, PLAYER_RADIUS);
      newPos.x = resolvedPos.x;
      newPos.z = resolvedPos.z;
    }
  }

  // Vertical movement (gravity, jumping)
  // Clamp falling speed to prevent tunneling through floors
  const maxFallSpeed = -20;  // Max downward velocity
  let clampedVelY = Math.max(velocity.y, maxFallSpeed);
  newPos.y += clampedVelY * deltaTime;
  newVel.y = clampedVelY;

  // Ground check after movement - check from multiple points for reliability
  const groundCheck = findGroundBelow(newPos, mesh);

  // Also check from slightly in front of movement direction for better detection
  let bestGroundY = groundCheck.found ? groundCheck.groundY : -Infinity;
  let bestGroundNormal = groundCheck.groundNormal;
  let groundFound = groundCheck.found;

  // If we were moving down significantly, do an extra check from where we started
  if (velocity.y < -1) {
    const startGroundCheck = findGroundBelow(position, mesh);
    if (startGroundCheck.found && startGroundCheck.groundY > bestGroundY) {
      // The floor we came from is higher - we may have passed through it
      if (newPos.y < startGroundCheck.groundY && position.y >= startGroundCheck.groundY - 0.1) {
        // We crossed through the floor - snap to it
        bestGroundY = startGroundCheck.groundY;
        bestGroundNormal = startGroundCheck.groundNormal;
        groundFound = true;
      }
    }
  }

  let onGround = false;
  if (groundFound) {
    const groundDist = newPos.y - bestGroundY;

    // Check if ground is walkable (not too steep)
    const isWalkable = Math.abs(bestGroundNormal.y) >= SLOPE_LIMIT;

    if (isWalkable) {
      // Only snap to ground when:
      // 1. We're falling (velocity.y <= 0) or moving slowly up
      // 2. We're close enough to ground
      // Don't snap when jumping up with significant velocity
      const isJumping = velocity.y > 2.0;  // Threshold for "actively jumping"

      if (!isJumping && groundDist <= STEP_HEIGHT && groundDist >= -1.0) {
        newPos.y = bestGroundY;
        if (newVel.y < 0) newVel.y = 0;
        onGround = true;
      } else if (groundDist < 0) {
        // Below ground - always push up (penetration recovery)
        newPos.y = bestGroundY;
        if (newVel.y < 0) newVel.y = 0;
        onGround = true;
      } else if (groundDist <= 0.1) {
        // Very close to ground - consider grounded
        onGround = true;
        if (newVel.y < 0) {
          newPos.y = bestGroundY;
          newVel.y = 0;
        }
      }
    }
  }

  // Ceiling check
  const ceilingCheck = raycastMesh(
    new Vector3(newPos.x, newPos.y + PLAYER_HEIGHT, newPos.z),
    new Vector3(0, 1, 0),
    mesh,
    0.2
  );
  if (ceilingCheck.hit && newVel.y > 0) {
    newVel.y = 0;
    newPos.y = ceilingCheck.point.y - PLAYER_HEIGHT - 0.01;
  }

  return { newPosition: newPos, newVelocity: newVel, onGround };
}

// Find ground directly below a position (searches further than checkGroundMesh)
export function findGroundBelow(
  position: Vector3,
  mesh: CollisionMesh
): { found: boolean; groundY: number; groundNormal: Vector3 } {
  // Cast ray from well above the position to catch any ground
  const rayOrigin = new Vector3(position.x, position.y + 2.0, position.z);
  const rayDirection = new Vector3(0, -1, 0);

  // Search a large distance to find ground
  const result = raycastMesh(rayOrigin, rayDirection, mesh, 10.0);

  if (result.hit) {
    return {
      found: true,
      groundY: result.point.y,
      groundNormal: result.normal,
    };
  }

  return {
    found: false,
    groundY: -Infinity,
    groundNormal: new Vector3(0, 1, 0),
  };
}

// Global collision mesh for the current map
let globalCollisionMesh: CollisionMesh = new CollisionMesh();

export function setGlobalCollisionMesh(mesh: CollisionMesh): void {
  globalCollisionMesh = mesh;
}

export function getGlobalCollisionMesh(): CollisionMesh {
  return globalCollisionMesh;
}

// Adjust a spawn position to be on valid ground (not clipping geometry)
export function adjustSpawnPosition(
  spawnPos: Vector3,
  mesh: CollisionMesh
): Vector3 {
  if (mesh.triangles.length === 0) {
    return spawnPos.clone();
  }

  // Cast ray down from above spawn to find ground
  const groundCheck = findGroundBelow(spawnPos, mesh);

  if (groundCheck.found) {
    // Position player on the ground
    return new Vector3(spawnPos.x, groundCheck.groundY, spawnPos.z);
  }

  // Try casting from higher up in case spawn is inside geometry
  const highCheck = findGroundBelow(
    new Vector3(spawnPos.x, spawnPos.y + 5.0, spawnPos.z),
    mesh
  );

  if (highCheck.found) {
    return new Vector3(spawnPos.x, highCheck.groundY, spawnPos.z);
  }

  // No ground found, return original
  return spawnPos.clone();
}
