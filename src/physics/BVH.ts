/**
 * Bounding Volume Hierarchy (BVH) for accelerated collision queries.
 * Reduces raycast complexity from O(n) to O(log n).
 */

import { Vector3 } from '../engine/math/Vector3.js';
import { Triangle } from '../engine/Mesh.js';
import { CollisionTriangle } from './MeshCollision.js';

// Axis-Aligned Bounding Box
export interface AABB {
  min: Vector3;
  max: Vector3;
}

// BVH Node
export interface BVHNode {
  bounds: AABB;
  left: BVHNode | null;
  right: BVHNode | null;
  triangles: Triangle[] | null;  // Only leaf nodes have triangles
  triangleIndices: number[] | null;  // Original indices for reference
}

// Ray for intersection testing
export interface Ray {
  origin: Vector3;
  direction: Vector3;
  invDirection: Vector3;  // Precomputed 1/direction for fast AABB test
}

// Configuration
const MAX_TRIANGLES_PER_LEAF = 4;  // Leaf node threshold
const MAX_DEPTH = 32;  // Prevent degenerate trees

/**
 * Build a BVH from a triangle array.
 * Uses Surface Area Heuristic (SAH) for optimal splits.
 */
export function buildBVH(triangles: Triangle[]): BVHNode | null {
  if (triangles.length === 0) return null;

  // Create indices array
  const indices = triangles.map((_, i) => i);

  // Precompute triangle centroids and bounds
  const triangleBounds: AABB[] = triangles.map(tri => computeTriangleBounds(tri));
  const centroids: Vector3[] = triangles.map(tri => computeTriangleCentroid(tri));

  return buildBVHNode(triangles, indices, triangleBounds, centroids, 0);
}

function buildBVHNode(
  triangles: Triangle[],
  indices: number[],
  triangleBounds: AABB[],
  centroids: Vector3[],
  depth: number
): BVHNode {
  // Compute bounds for all triangles in this node
  const bounds = computeBoundsForIndices(indices, triangleBounds);

  // Create leaf node if few triangles or max depth reached
  if (indices.length <= MAX_TRIANGLES_PER_LEAF || depth >= MAX_DEPTH) {
    return {
      bounds,
      left: null,
      right: null,
      triangles: indices.map(i => triangles[i]),
      triangleIndices: indices,
    };
  }

  // Find best split using SAH
  const split = findBestSplit(indices, triangleBounds, centroids, bounds);

  if (!split) {
    // Couldn't find good split, make leaf
    return {
      bounds,
      left: null,
      right: null,
      triangles: indices.map(i => triangles[i]),
      triangleIndices: indices,
    };
  }

  // Partition triangles
  const leftIndices: number[] = [];
  const rightIndices: number[] = [];

  for (const idx of indices) {
    const centroid = centroids[idx];
    const value = split.axis === 0 ? centroid.x : split.axis === 1 ? centroid.y : centroid.z;
    if (value < split.position) {
      leftIndices.push(idx);
    } else {
      rightIndices.push(idx);
    }
  }

  // Handle edge case where all triangles end up on one side
  if (leftIndices.length === 0 || rightIndices.length === 0) {
    // Split in half
    const mid = Math.floor(indices.length / 2);
    leftIndices.length = 0;
    rightIndices.length = 0;
    for (let i = 0; i < indices.length; i++) {
      if (i < mid) leftIndices.push(indices[i]);
      else rightIndices.push(indices[i]);
    }
  }

  return {
    bounds,
    left: buildBVHNode(triangles, leftIndices, triangleBounds, centroids, depth + 1),
    right: buildBVHNode(triangles, rightIndices, triangleBounds, centroids, depth + 1),
    triangles: null,
    triangleIndices: null,
  };
}

interface Split {
  axis: number;  // 0=x, 1=y, 2=z
  position: number;
  cost: number;
}

function findBestSplit(
  indices: number[],
  triangleBounds: AABB[],
  centroids: Vector3[],
  nodeBounds: AABB
): Split | null {
  let bestSplit: Split | null = null;
  let bestCost = Infinity;

  const nodeArea = computeSurfaceArea(nodeBounds);
  const numTriangles = indices.length;

  // Try each axis
  for (let axis = 0; axis < 3; axis++) {
    // Get centroid values along this axis
    const values: { idx: number; value: number }[] = indices.map(idx => ({
      idx,
      value: axis === 0 ? centroids[idx].x : axis === 1 ? centroids[idx].y : centroids[idx].z,
    }));

    // Sort by centroid position
    values.sort((a, b) => a.value - b.value);

    // Try splitting at each position (simplified: try median and quartiles)
    const positions = [
      Math.floor(numTriangles * 0.25),
      Math.floor(numTriangles * 0.5),
      Math.floor(numTriangles * 0.75),
    ];

    for (const splitIdx of positions) {
      if (splitIdx <= 0 || splitIdx >= numTriangles) continue;

      const splitPos = (values[splitIdx - 1].value + values[splitIdx].value) / 2;

      // Compute bounds and costs for each side
      const leftIndices = values.slice(0, splitIdx).map(v => v.idx);
      const rightIndices = values.slice(splitIdx).map(v => v.idx);

      const leftBounds = computeBoundsForIndices(leftIndices, triangleBounds);
      const rightBounds = computeBoundsForIndices(rightIndices, triangleBounds);

      const leftArea = computeSurfaceArea(leftBounds);
      const rightArea = computeSurfaceArea(rightBounds);

      // SAH cost: traversal cost + intersection cost * probability
      const cost = 1 + (leftArea / nodeArea) * leftIndices.length +
                       (rightArea / nodeArea) * rightIndices.length;

      if (cost < bestCost) {
        bestCost = cost;
        bestSplit = { axis, position: splitPos, cost };
      }
    }
  }

  // Only split if it's better than making a leaf
  const leafCost = numTriangles;
  if (bestSplit && bestCost < leafCost) {
    return bestSplit;
  }

  return null;
}

function computeTriangleBounds(tri: Triangle): AABB {
  const v0 = tri.v0.position;
  const v1 = tri.v1.position;
  const v2 = tri.v2.position;

  return {
    min: new Vector3(
      Math.min(v0.x, v1.x, v2.x),
      Math.min(v0.y, v1.y, v2.y),
      Math.min(v0.z, v1.z, v2.z)
    ),
    max: new Vector3(
      Math.max(v0.x, v1.x, v2.x),
      Math.max(v0.y, v1.y, v2.y),
      Math.max(v0.z, v1.z, v2.z)
    ),
  };
}

function computeTriangleCentroid(tri: Triangle): Vector3 {
  const v0 = tri.v0.position;
  const v1 = tri.v1.position;
  const v2 = tri.v2.position;

  return new Vector3(
    (v0.x + v1.x + v2.x) / 3,
    (v0.y + v1.y + v2.y) / 3,
    (v0.z + v1.z + v2.z) / 3
  );
}

function computeBoundsForIndices(indices: number[], triangleBounds: AABB[]): AABB {
  if (indices.length === 0) {
    return { min: new Vector3(0, 0, 0), max: new Vector3(0, 0, 0) };
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const idx of indices) {
    const b = triangleBounds[idx];
    minX = Math.min(minX, b.min.x);
    minY = Math.min(minY, b.min.y);
    minZ = Math.min(minZ, b.min.z);
    maxX = Math.max(maxX, b.max.x);
    maxY = Math.max(maxY, b.max.y);
    maxZ = Math.max(maxZ, b.max.z);
  }

  return {
    min: new Vector3(minX, minY, minZ),
    max: new Vector3(maxX, maxY, maxZ),
  };
}

function computeSurfaceArea(bounds: AABB): number {
  const dx = bounds.max.x - bounds.min.x;
  const dy = bounds.max.y - bounds.min.y;
  const dz = bounds.max.z - bounds.min.z;
  return 2 * (dx * dy + dy * dz + dz * dx);
}

/**
 * Create a ray with precomputed inverse direction.
 */
export function createRay(origin: Vector3, direction: Vector3): Ray {
  return {
    origin,
    direction,
    invDirection: new Vector3(
      direction.x !== 0 ? 1 / direction.x : Infinity,
      direction.y !== 0 ? 1 / direction.y : Infinity,
      direction.z !== 0 ? 1 / direction.z : Infinity
    ),
  };
}

/**
 * Fast ray-AABB intersection test using slab method.
 */
export function rayAABBIntersect(ray: Ray, bounds: AABB, maxDist: number): boolean {
  const t1 = (bounds.min.x - ray.origin.x) * ray.invDirection.x;
  const t2 = (bounds.max.x - ray.origin.x) * ray.invDirection.x;
  const t3 = (bounds.min.y - ray.origin.y) * ray.invDirection.y;
  const t4 = (bounds.max.y - ray.origin.y) * ray.invDirection.y;
  const t5 = (bounds.min.z - ray.origin.z) * ray.invDirection.z;
  const t6 = (bounds.max.z - ray.origin.z) * ray.invDirection.z;

  const tmin = Math.max(Math.max(Math.min(t1, t2), Math.min(t3, t4)), Math.min(t5, t6));
  const tmax = Math.min(Math.min(Math.max(t1, t2), Math.max(t3, t4)), Math.max(t5, t6));

  // If tmax < 0, ray is behind AABB
  // If tmin > tmax, ray misses AABB
  // If tmin > maxDist, AABB is too far
  return tmax >= 0 && tmin <= tmax && tmin <= maxDist;
}

/**
 * Traverse BVH and collect triangles that the ray might intersect.
 * Uses a stack-based traversal to avoid recursion overhead.
 */
export function queryBVH(
  root: BVHNode | null,
  ray: Ray,
  maxDist: number = Infinity
): Triangle[] {
  if (!root) return [];

  const result: Triangle[] = [];
  const stack: BVHNode[] = [root];

  while (stack.length > 0) {
    const node = stack.pop()!;

    // Test ray against node bounds
    if (!rayAABBIntersect(ray, node.bounds, maxDist)) {
      continue;
    }

    // Leaf node - add triangles
    if (node.triangles) {
      for (const tri of node.triangles) {
        result.push(tri);
      }
      continue;
    }

    // Interior node - traverse children
    if (node.left) stack.push(node.left);
    if (node.right) stack.push(node.right);
  }

  return result;
}

/**
 * Point-in-AABB test for sphere collision queries.
 */
export function pointInAABB(point: Vector3, bounds: AABB, margin: number = 0): boolean {
  return point.x >= bounds.min.x - margin && point.x <= bounds.max.x + margin &&
         point.y >= bounds.min.y - margin && point.y <= bounds.max.y + margin &&
         point.z >= bounds.min.z - margin && point.z <= bounds.max.z + margin;
}

/**
 * Sphere-AABB intersection test.
 */
export function sphereAABBIntersect(center: Vector3, radius: number, bounds: AABB): boolean {
  // Find closest point on AABB to sphere center
  const closestX = Math.max(bounds.min.x, Math.min(center.x, bounds.max.x));
  const closestY = Math.max(bounds.min.y, Math.min(center.y, bounds.max.y));
  const closestZ = Math.max(bounds.min.z, Math.min(center.z, bounds.max.z));

  // Check distance from closest point to center
  const dx = closestX - center.x;
  const dy = closestY - center.y;
  const dz = closestZ - center.z;

  return (dx * dx + dy * dy + dz * dz) <= (radius * radius);
}

/**
 * Query BVH for triangles that might intersect a sphere.
 */
export function queryBVHSphere(
  root: BVHNode | null,
  center: Vector3,
  radius: number
): Triangle[] {
  if (!root) return [];

  const result: Triangle[] = [];
  const stack: BVHNode[] = [root];

  while (stack.length > 0) {
    const node = stack.pop()!;

    // Test sphere against node bounds
    if (!sphereAABBIntersect(center, radius, node.bounds)) {
      continue;
    }

    // Leaf node - add triangles
    if (node.triangles) {
      for (const tri of node.triangles) {
        result.push(tri);
      }
      continue;
    }

    // Interior node - traverse children
    if (node.left) stack.push(node.left);
    if (node.right) stack.push(node.right);
  }

  return result;
}

/**
 * Get BVH statistics for debugging.
 */
export function getBVHStats(root: BVHNode | null): {
  nodeCount: number;
  leafCount: number;
  maxDepth: number;
  avgTrianglesPerLeaf: number;
} {
  if (!root) {
    return { nodeCount: 0, leafCount: 0, maxDepth: 0, avgTrianglesPerLeaf: 0 };
  }

  let nodeCount = 0;
  let leafCount = 0;
  let maxDepth = 0;
  let totalTriangles = 0;

  function traverse(node: BVHNode, depth: number) {
    nodeCount++;
    maxDepth = Math.max(maxDepth, depth);

    if (node.triangles) {
      leafCount++;
      totalTriangles += node.triangles.length;
    } else {
      if (node.left) traverse(node.left, depth + 1);
      if (node.right) traverse(node.right, depth + 1);
    }
  }

  traverse(root, 1);

  return {
    nodeCount,
    leafCount,
    maxDepth,
    avgTrianglesPerLeaf: leafCount > 0 ? totalTriangles / leafCount : 0,
  };
}

// ========================================
// CollisionTriangle-specific BVH functions
// ========================================

// BVH Node for CollisionTriangles
export interface CollisionBVHNode {
  bounds: AABB;
  left: CollisionBVHNode | null;
  right: CollisionBVHNode | null;
  triangles: CollisionTriangle[] | null;
  triangleIndices: number[] | null;
}

/**
 * Build a BVH from a CollisionTriangle array.
 */
export function buildCollisionBVH(triangles: CollisionTriangle[]): CollisionBVHNode | null {
  if (triangles.length === 0) return null;

  const indices = triangles.map((_, i) => i);
  const triangleBounds: AABB[] = triangles.map(tri => computeCollisionTriangleBounds(tri));
  const centroids: Vector3[] = triangles.map(tri => computeCollisionTriangleCentroid(tri));

  return buildCollisionBVHNode(triangles, indices, triangleBounds, centroids, 0);
}

function buildCollisionBVHNode(
  triangles: CollisionTriangle[],
  indices: number[],
  triangleBounds: AABB[],
  centroids: Vector3[],
  depth: number
): CollisionBVHNode {
  const bounds = computeBoundsForIndices(indices, triangleBounds);

  if (indices.length <= MAX_TRIANGLES_PER_LEAF || depth >= MAX_DEPTH) {
    return {
      bounds,
      left: null,
      right: null,
      triangles: indices.map(i => triangles[i]),
      triangleIndices: indices,
    };
  }

  const split = findBestSplit(indices, triangleBounds, centroids, bounds);

  if (!split) {
    return {
      bounds,
      left: null,
      right: null,
      triangles: indices.map(i => triangles[i]),
      triangleIndices: indices,
    };
  }

  const leftIndices: number[] = [];
  const rightIndices: number[] = [];

  for (const idx of indices) {
    const centroid = centroids[idx];
    const value = split.axis === 0 ? centroid.x : split.axis === 1 ? centroid.y : centroid.z;
    if (value < split.position) {
      leftIndices.push(idx);
    } else {
      rightIndices.push(idx);
    }
  }

  if (leftIndices.length === 0 || rightIndices.length === 0) {
    const mid = Math.floor(indices.length / 2);
    leftIndices.length = 0;
    rightIndices.length = 0;
    for (let i = 0; i < indices.length; i++) {
      if (i < mid) leftIndices.push(indices[i]);
      else rightIndices.push(indices[i]);
    }
  }

  return {
    bounds,
    left: buildCollisionBVHNode(triangles, leftIndices, triangleBounds, centroids, depth + 1),
    right: buildCollisionBVHNode(triangles, rightIndices, triangleBounds, centroids, depth + 1),
    triangles: null,
    triangleIndices: null,
  };
}

function computeCollisionTriangleBounds(tri: CollisionTriangle): AABB {
  return {
    min: new Vector3(
      Math.min(tri.v0.x, tri.v1.x, tri.v2.x),
      Math.min(tri.v0.y, tri.v1.y, tri.v2.y),
      Math.min(tri.v0.z, tri.v1.z, tri.v2.z)
    ),
    max: new Vector3(
      Math.max(tri.v0.x, tri.v1.x, tri.v2.x),
      Math.max(tri.v0.y, tri.v1.y, tri.v2.y),
      Math.max(tri.v0.z, tri.v1.z, tri.v2.z)
    ),
  };
}

function computeCollisionTriangleCentroid(tri: CollisionTriangle): Vector3 {
  return new Vector3(
    (tri.v0.x + tri.v1.x + tri.v2.x) / 3,
    (tri.v0.y + tri.v1.y + tri.v2.y) / 3,
    (tri.v0.z + tri.v1.z + tri.v2.z) / 3
  );
}

/**
 * Query CollisionBVH for triangles that might intersect a ray.
 */
export function queryCollisionBVH(
  root: CollisionBVHNode | null,
  ray: Ray,
  maxDist: number = Infinity
): CollisionTriangle[] {
  if (!root) return [];

  const result: CollisionTriangle[] = [];
  const stack: CollisionBVHNode[] = [root];

  while (stack.length > 0) {
    const node = stack.pop()!;

    if (!rayAABBIntersect(ray, node.bounds, maxDist)) {
      continue;
    }

    if (node.triangles) {
      for (const tri of node.triangles) {
        result.push(tri);
      }
      continue;
    }

    if (node.left) stack.push(node.left);
    if (node.right) stack.push(node.right);
  }

  return result;
}

/**
 * Query CollisionBVH for triangles that might intersect a sphere.
 */
export function queryCollisionBVHSphere(
  root: CollisionBVHNode | null,
  center: Vector3,
  radius: number
): CollisionTriangle[] {
  if (!root) return [];

  const result: CollisionTriangle[] = [];
  const stack: CollisionBVHNode[] = [root];

  while (stack.length > 0) {
    const node = stack.pop()!;

    if (!sphereAABBIntersect(center, radius, node.bounds)) {
      continue;
    }

    if (node.triangles) {
      for (const tri of node.triangles) {
        result.push(tri);
      }
      continue;
    }

    if (node.left) stack.push(node.left);
    if (node.right) stack.push(node.right);
  }

  return result;
}

/**
 * Get CollisionBVH statistics.
 */
export function getCollisionBVHStats(root: CollisionBVHNode | null): {
  nodeCount: number;
  leafCount: number;
  maxDepth: number;
  avgTrianglesPerLeaf: number;
} {
  if (!root) {
    return { nodeCount: 0, leafCount: 0, maxDepth: 0, avgTrianglesPerLeaf: 0 };
  }

  let nodeCount = 0;
  let leafCount = 0;
  let maxDepth = 0;
  let totalTriangles = 0;

  function traverse(node: CollisionBVHNode, depth: number) {
    nodeCount++;
    maxDepth = Math.max(maxDepth, depth);

    if (node.triangles) {
      leafCount++;
      totalTriangles += node.triangles.length;
    } else {
      if (node.left) traverse(node.left, depth + 1);
      if (node.right) traverse(node.right, depth + 1);
    }
  }

  traverse(root, 1);

  return {
    nodeCount,
    leafCount,
    maxDepth,
    avgTrianglesPerLeaf: leafCount > 0 ? totalTriangles / leafCount : 0,
  };
}
