/**
 * Collision Worker - Handles collision queries in a worker thread.
 * Processes batched raycast and sphere collision queries.
 */

import { parentPort, workerData } from 'worker_threads';
import { Vector3 } from '../shared/math/Vector3.js';
import {
  CollisionBVHNode,
  createRay,
  queryCollisionBVH,
  queryCollisionBVHSphere,
  sphereAABBIntersect,
} from './BVH.js';

// Worker message types
export interface RaycastQuery {
  type: 'raycast';
  id: number;
  origin: { x: number; y: number; z: number };
  direction: { x: number; y: number; z: number };
  maxDistance: number;
}

export interface SphereQuery {
  type: 'sphere';
  id: number;
  center: { x: number; y: number; z: number };
  radius: number;
}

export interface BatchQuery {
  type: 'batch';
  queries: (RaycastQuery | SphereQuery)[];
}

export interface SetBVHMessage {
  type: 'setBVH';
  triangles: {
    v0: { x: number; y: number; z: number };
    v1: { x: number; y: number; z: number };
    v2: { x: number; y: number; z: number };
    normal: { x: number; y: number; z: number };
  }[];
}

export interface RaycastResult {
  type: 'raycast';
  id: number;
  hit: boolean;
  distance: number;
  point: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
}

export interface SphereResult {
  type: 'sphere';
  id: number;
  candidateCount: number;
}

export interface BatchResult {
  type: 'batch';
  results: (RaycastResult | SphereResult)[];
}

export type WorkerMessage = RaycastQuery | SphereQuery | BatchQuery | SetBVHMessage;
export type WorkerResult = RaycastResult | SphereResult | BatchResult | { type: 'ready' } | { type: 'bvhSet' };

// Worker state
interface CollisionTriangle {
  v0: Vector3;
  v1: Vector3;
  v2: Vector3;
  normal: Vector3;
}

let triangles: CollisionTriangle[] = [];
let bvh: CollisionBVHNode | null = null;

// Rebuild BVH from triangles (simplified version for worker)
function buildWorkerBVH(): void {
  if (triangles.length === 0) {
    bvh = null;
    return;
  }

  // Import buildCollisionBVH dynamically since we have the triangles
  // For simplicity, we'll use a simple spatial structure here
  // The main BVH is maintained in the main thread and we query it
  bvh = null;  // Workers receive pre-serialized data for queries
}

// Ray-triangle intersection (Moller-Trumbore)
function rayTriangleIntersection(
  origin: Vector3,
  direction: Vector3,
  tri: CollisionTriangle
): { hit: boolean; distance: number; point: Vector3 } {
  const EPSILON = 0.0000001;

  const edge1 = Vector3.sub(tri.v1, tri.v0);
  const edge2 = Vector3.sub(tri.v2, tri.v0);

  const h = Vector3.cross(direction, edge2);
  const a = Vector3.dot(edge1, h);

  if (Math.abs(a) < EPSILON) {
    return { hit: false, distance: Infinity, point: Vector3.zero() };
  }

  const f = 1.0 / a;
  const s = Vector3.sub(origin, tri.v0);
  const u = f * Vector3.dot(s, h);

  if (u < 0.0 || u > 1.0) {
    return { hit: false, distance: Infinity, point: Vector3.zero() };
  }

  const q = Vector3.cross(s, edge1);
  const v = f * Vector3.dot(direction, q);

  if (v < 0.0 || u + v > 1.0) {
    return { hit: false, distance: Infinity, point: Vector3.zero() };
  }

  const t = f * Vector3.dot(edge2, q);

  if (t > EPSILON) {
    const point = Vector3.add(origin, Vector3.scale(direction, t));
    return { hit: true, distance: t, point };
  }

  return { hit: false, distance: Infinity, point: Vector3.zero() };
}

// Process raycast query
function processRaycast(query: RaycastQuery): RaycastResult {
  const origin = new Vector3(query.origin.x, query.origin.y, query.origin.z);
  const direction = new Vector3(query.direction.x, query.direction.y, query.direction.z);

  let closestHit = {
    hit: false,
    distance: Infinity,
    point: Vector3.zero(),
    normal: Vector3.zero(),
  };

  // Linear search through triangles (BVH would be better but requires serialization)
  for (const tri of triangles) {
    const result = rayTriangleIntersection(origin, direction, tri);
    if (result.hit && result.distance < closestHit.distance && result.distance <= query.maxDistance) {
      closestHit = {
        hit: true,
        distance: result.distance,
        point: result.point,
        normal: tri.normal,
      };
    }
  }

  return {
    type: 'raycast',
    id: query.id,
    hit: closestHit.hit,
    distance: closestHit.distance,
    point: { x: closestHit.point.x, y: closestHit.point.y, z: closestHit.point.z },
    normal: { x: closestHit.normal.x, y: closestHit.normal.y, z: closestHit.normal.z },
  };
}

// Process sphere query
function processSphere(query: SphereQuery): SphereResult {
  const center = new Vector3(query.center.x, query.center.y, query.center.z);
  let candidateCount = 0;

  // Count triangles within sphere
  for (const tri of triangles) {
    // Simple distance check to triangle centroid
    const centroid = new Vector3(
      (tri.v0.x + tri.v1.x + tri.v2.x) / 3,
      (tri.v0.y + tri.v1.y + tri.v2.y) / 3,
      (tri.v0.z + tri.v1.z + tri.v2.z) / 3
    );
    const dist = Vector3.sub(center, centroid).length();
    if (dist <= query.radius + 2.0) {  // Add margin for triangle size
      candidateCount++;
    }
  }

  return {
    type: 'sphere',
    id: query.id,
    candidateCount,
  };
}

// Handle messages from main thread
if (parentPort) {
  parentPort.on('message', (message: WorkerMessage) => {
    if (message.type === 'setBVH') {
      // Receive triangle data from main thread
      triangles = message.triangles.map(t => ({
        v0: new Vector3(t.v0.x, t.v0.y, t.v0.z),
        v1: new Vector3(t.v1.x, t.v1.y, t.v1.z),
        v2: new Vector3(t.v2.x, t.v2.y, t.v2.z),
        normal: new Vector3(t.normal.x, t.normal.y, t.normal.z),
      }));
      buildWorkerBVH();
      parentPort!.postMessage({ type: 'bvhSet' });
    } else if (message.type === 'batch') {
      const results: (RaycastResult | SphereResult)[] = [];
      for (const query of message.queries) {
        if (query.type === 'raycast') {
          results.push(processRaycast(query));
        } else {
          results.push(processSphere(query));
        }
      }
      parentPort!.postMessage({ type: 'batch', results });
    } else if (message.type === 'raycast') {
      parentPort!.postMessage(processRaycast(message));
    } else if (message.type === 'sphere') {
      parentPort!.postMessage(processSphere(message));
    }
  });

  // Signal ready
  parentPort.postMessage({ type: 'ready' });
}
