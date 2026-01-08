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
    const edge1 = Vector3.subtract(v1, v0);
    const edge2 = Vector3.subtract(v2, v0);
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

// Ray-triangle intersection using Möller–Trumbore algorithm
export function rayTriangleIntersection(
  rayOrigin: Vector3,
  rayDirection: Vector3,
  tri: CollisionTriangle
): { hit: boolean; distance: number; point: Vector3 } {
  const EPSILON = 0.0000001;

  const edge1 = Vector3.subtract(tri.v1, tri.v0);
  const edge2 = Vector3.subtract(tri.v2, tri.v0);

  const h = Vector3.cross(rayDirection, edge2);
  const a = Vector3.dot(edge1, h);

  // Ray is parallel to triangle
  if (a > -EPSILON && a < EPSILON) {
    return { hit: false, distance: Infinity, point: Vector3.zero() };
  }

  const f = 1.0 / a;
  const s = Vector3.subtract(rayOrigin, tri.v0);
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
  // Cast ray downward from slightly above feet
  const rayOrigin = new Vector3(position.x, position.y + 0.1, position.z);
  const rayDirection = new Vector3(0, -1, 0);

  const result = raycastMesh(rayOrigin, rayDirection, mesh, maxGroundDistance + 0.2);

  if (result.hit) {
    return {
      onGround: true,
      groundY: result.point.y,
      groundNormal: result.normal,
    };
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
  const toCenter = Vector3.subtract(sphereCenter, closestPoint);
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

// Find closest point on triangle to a point
function closestPointOnTriangle(point: Vector3, tri: CollisionTriangle): Vector3 {
  const a = tri.v0;
  const b = tri.v1;
  const c = tri.v2;

  // Check if P in vertex region outside A
  const ab = Vector3.subtract(b, a);
  const ac = Vector3.subtract(c, a);
  const ap = Vector3.subtract(point, a);

  const d1 = Vector3.dot(ab, ap);
  const d2 = Vector3.dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a.clone();

  // Check if P in vertex region outside B
  const bp = Vector3.subtract(point, b);
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
  const cp = Vector3.subtract(point, c);
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
    return Vector3.add(b, Vector3.scale(Vector3.subtract(c, b), w));
  }

  // P inside face region
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return Vector3.add(a, Vector3.add(Vector3.scale(ab, v), Vector3.scale(ac, w)));
}

// Constants for player movement
const STEP_HEIGHT = 0.5;      // Max height player can step up
const SLOPE_LIMIT = 0.7;      // Dot product with up vector (cos ~45°)
const PLAYER_RADIUS = 0.4;    // Collision radius
const PLAYER_HEIGHT = 1.8;    // Full height

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

  let newPos = position.clone();
  let newVel = velocity.clone();

  // Horizontal movement
  const horizontalMove = new Vector3(velocity.x * deltaTime, 0, velocity.z * deltaTime);

  if (horizontalMove.x !== 0 || horizontalMove.z !== 0) {
    // Try to move horizontally
    let testPos = Vector3.add(newPos, horizontalMove);

    // Check collision at multiple heights (feet, middle, head)
    const heights = [0.2, PLAYER_HEIGHT / 2, PLAYER_HEIGHT - 0.2];
    let blocked = false;
    let pushOut = Vector3.zero();

    for (const h of heights) {
      const checkPos = new Vector3(testPos.x, newPos.y + h, testPos.z);

      for (const tri of mesh.triangles) {
        const collision = sphereTriangleCollision(checkPos, PLAYER_RADIUS, tri);
        if (collision.collided) {
          // Check if this is a wall (steep normal) or a slope we can walk on
          const upDot = tri.normal.y;
          if (upDot < SLOPE_LIMIT) {
            // It's a wall - push out
            blocked = true;
            pushOut = Vector3.add(pushOut, collision.pushOut);
          }
        }
      }
    }

    if (blocked) {
      // Apply push out but try to slide along walls
      testPos = Vector3.add(testPos, pushOut);

      // Zero out velocity in push direction
      if (Math.abs(pushOut.x) > 0.001) newVel.x = 0;
      if (Math.abs(pushOut.z) > 0.001) newVel.z = 0;
    }

    newPos.x = testPos.x;
    newPos.z = testPos.z;
  }

  // Vertical movement (gravity, jumping)
  newPos.y += velocity.y * deltaTime;
  newVel.y = velocity.y;

  // Ground check and snapping
  const groundCheck = checkGroundMesh(newPos, mesh, STEP_HEIGHT + 0.1);

  let onGround = false;
  if (groundCheck.onGround) {
    const groundDist = newPos.y - groundCheck.groundY;

    // Check if ground is walkable (not too steep)
    const isWalkable = groundCheck.groundNormal.y >= SLOPE_LIMIT;

    if (isWalkable) {
      if (groundDist <= STEP_HEIGHT && groundDist >= -0.5) {
        // Snap to ground if we're close enough (allows stepping up)
        newPos.y = groundCheck.groundY;
        if (newVel.y < 0) newVel.y = 0;
        onGround = true;
      } else if (groundDist < 0) {
        // We're below ground, push up
        newPos.y = groundCheck.groundY;
        if (newVel.y < 0) newVel.y = 0;
        onGround = true;
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

// Global collision mesh for the current map
let globalCollisionMesh: CollisionMesh = new CollisionMesh();

export function setGlobalCollisionMesh(mesh: CollisionMesh): void {
  globalCollisionMesh = mesh;
}

export function getGlobalCollisionMesh(): CollisionMesh {
  return globalCollisionMesh;
}
