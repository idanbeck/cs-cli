/**
 * Bot AI Worker - Handles expensive AI computations in a worker thread.
 *
 * Primary use: Batched line-of-sight checks for multiple bots.
 * This is the most expensive part of bot AI and benefits from parallelization.
 */

import { parentPort } from 'worker_threads';

// Vector3-like structure for serialization
interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// Triangle for collision detection
interface Triangle {
  v0: Vec3;
  v1: Vec3;
  v2: Vec3;
  normal: Vec3;
}

// Line of sight query
interface LOSQuery {
  id: number;
  from: Vec3;
  to: Vec3;
}

// Batch LOS request
interface BatchLOSRequest {
  type: 'batchLOS';
  queries: LOSQuery[];
}

// Set collision mesh
interface SetMeshRequest {
  type: 'setMesh';
  triangles: Triangle[];
}

// LOS result
interface LOSResult {
  id: number;
  visible: boolean;
}

// Batch LOS response
interface BatchLOSResponse {
  type: 'batchLOS';
  results: LOSResult[];
}

type WorkerRequest = BatchLOSRequest | SetMeshRequest;
type WorkerResponse = BatchLOSResponse | { type: 'ready' } | { type: 'meshSet' };

// Worker state
let triangles: Triangle[] = [];

// Fast ray-triangle intersection (returns true if hit within maxDist)
function fastRayTriangle(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  tri: Triangle,
  maxDist: number
): boolean {
  const EPSILON = 0.0001;

  const e1x = tri.v1.x - tri.v0.x, e1y = tri.v1.y - tri.v0.y, e1z = tri.v1.z - tri.v0.z;
  const e2x = tri.v2.x - tri.v0.x, e2y = tri.v2.y - tri.v0.y, e2z = tri.v2.z - tri.v0.z;

  const hx = dy * e2z - dz * e2y;
  const hy = dz * e2x - dx * e2z;
  const hz = dx * e2y - dy * e2x;

  const a = e1x * hx + e1y * hy + e1z * hz;
  if (a > -EPSILON && a < EPSILON) return false;

  const f = 1.0 / a;
  const sx = ox - tri.v0.x, sy = oy - tri.v0.y, sz = oz - tri.v0.z;
  const u = f * (sx * hx + sy * hy + sz * hz);
  if (u < 0.0 || u > 1.0) return false;

  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = f * (dx * qx + dy * qy + dz * qz);
  if (v < 0.0 || u + v > 1.0) return false;

  const t = f * (e2x * qx + e2y * qy + e2z * qz);
  return t > EPSILON && t < maxDist;
}

// Check line of sight between two points
function hasLineOfSight(from: Vec3, to: Vec3): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

  if (distance < 0.1) return true;

  const invDist = 1 / distance;
  const dirX = dx * invDist;
  const dirY = dy * invDist;
  const dirZ = dz * invDist;

  // Spatial bounds for culling
  const minX = Math.min(from.x, to.x) - 0.5;
  const maxX = Math.max(from.x, to.x) + 0.5;
  const minY = Math.min(from.y, to.y) - 0.5;
  const maxY = Math.max(from.y, to.y) + 0.5;
  const minZ = Math.min(from.z, to.z) - 0.5;
  const maxZ = Math.max(from.z, to.z) + 0.5;

  const checkDist = distance - 0.1;

  for (const tri of triangles) {
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
    if (fastRayTriangle(from.x, from.y, from.z, dirX, dirY, dirZ, tri, checkDist)) {
      return false; // Hit something
    }
  }

  return true;
}

// Process batch LOS queries
function processBatchLOS(queries: LOSQuery[]): LOSResult[] {
  return queries.map(query => ({
    id: query.id,
    visible: hasLineOfSight(query.from, query.to),
  }));
}

// Handle messages from main thread
if (parentPort) {
  parentPort.on('message', (message: WorkerRequest) => {
    if (message.type === 'setMesh') {
      triangles = message.triangles;
      parentPort!.postMessage({ type: 'meshSet' });
    } else if (message.type === 'batchLOS') {
      const results = processBatchLOS(message.queries);
      parentPort!.postMessage({ type: 'batchLOS', results });
    }
  });

  parentPort.postMessage({ type: 'ready' });
}
