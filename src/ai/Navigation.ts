// A* Navigation system for bot pathfinding
import { Vector3 } from '../engine/math/Vector3.js';
import { getGlobalCollisionMesh, CollisionMesh } from '../physics/MeshCollision.js';
import { debugLog } from '../utils/FileLogger.js';

// Navigation grid cell
interface NavCell {
  x: number;
  z: number;
  walkable: boolean;
  worldX: number;
  worldZ: number;
}

// A* node for pathfinding
interface AStarNode {
  x: number;
  z: number;
  g: number; // Cost from start
  h: number; // Heuristic to goal
  f: number; // Total cost
  parent: AStarNode | null;
}

// Cached path for a bot
export interface CachedPath {
  path: Vector3[];
  targetPos: Vector3;
  computedAt: number;
  currentIndex: number;
}

// Chokepoint/doorway in the nav mesh
export interface Chokepoint {
  position: Vector3;      // Center of the chokepoint
  direction: Vector3;     // Direction through the chokepoint (normalized)
  width: number;          // Width in cells
  importance: number;     // How important this chokepoint is (0-1)
}

// Navigation grid settings
const CELL_SIZE = 2.0; // Size of each nav cell in world units
const NAV_HEIGHT_CHECK = 1.0; // Height to check for obstacles
const PATH_CACHE_BASE_TIME = 2500; // Base time before path recompute (2.5 seconds)
const PATH_CACHE_STAGGER = 1000; // Random stagger range (0-1 second)
const PATH_WAYPOINT_DIST = 1.5; // Distance to consider waypoint reached
const MAX_PATH_LENGTH = 100; // Maximum path nodes to prevent infinite loops

// Chokepoint detection settings
const CHOKEPOINT_WIDTH_THRESHOLD = 3; // Max cells wide to be considered a chokepoint
const CHOKEPOINT_MIN_LENGTH = 2; // Min cells long to be a valid chokepoint

export class NavigationGrid {
  private grid: NavCell[][] = [];
  private minX: number = 0;
  private minZ: number = 0;
  private maxX: number = 0;
  private maxZ: number = 0;
  private gridWidth: number = 0;
  private gridHeight: number = 0;
  private initialized: boolean = false;
  private chokepoints: Chokepoint[] = [];

  // Build navigation grid from collision mesh
  buildFromMesh(mesh: CollisionMesh, bounds: { min: Vector3; max: Vector3 }): void {
    this.minX = Math.floor(bounds.min.x / CELL_SIZE) * CELL_SIZE;
    this.minZ = Math.floor(bounds.min.z / CELL_SIZE) * CELL_SIZE;
    this.maxX = Math.ceil(bounds.max.x / CELL_SIZE) * CELL_SIZE;
    this.maxZ = Math.ceil(bounds.max.z / CELL_SIZE) * CELL_SIZE;

    this.gridWidth = Math.ceil((this.maxX - this.minX) / CELL_SIZE);
    this.gridHeight = Math.ceil((this.maxZ - this.minZ) / CELL_SIZE);

    // Initialize grid
    this.grid = [];
    for (let x = 0; x < this.gridWidth; x++) {
      this.grid[x] = [];
      for (let z = 0; z < this.gridHeight; z++) {
        const worldX = this.minX + x * CELL_SIZE + CELL_SIZE / 2;
        const worldZ = this.minZ + z * CELL_SIZE + CELL_SIZE / 2;

        this.grid[x][z] = {
          x,
          z,
          walkable: this.isCellWalkable(worldX, worldZ, mesh, bounds),
          worldX,
          worldZ,
        };
      }
    }

    this.initialized = true;
    debugLog(`[Nav] Built ${this.gridWidth}x${this.gridHeight} grid, ${this.countWalkable()} walkable cells`);

    // Detect chokepoints after building grid
    this.detectChokepoints();
    debugLog(`[Nav] Found ${this.chokepoints.length} chokepoints`);
  }

  // Detect chokepoints (narrow passages) in the grid
  // A chokepoint is a narrow walkable area that connects larger open areas
  private detectChokepoints(): void {
    this.chokepoints = [];

    // For each cell, count walkable neighbors to find constrained areas
    const constraintMap: number[][] = [];
    for (let x = 0; x < this.gridWidth; x++) {
      constraintMap[x] = [];
      for (let z = 0; z < this.gridHeight; z++) {
        if (!this.grid[x][z].walkable) {
          constraintMap[x][z] = -1;
          continue;
        }
        // Count walkable neighbors in cardinal directions
        let walkableNeighbors = 0;
        let wallsInLine = 0; // Count walls on opposite sides (corridor indicator)

        const hasNorth = this.getCell(x, z + 1)?.walkable ?? false;
        const hasSouth = this.getCell(x, z - 1)?.walkable ?? false;
        const hasEast = this.getCell(x + 1, z)?.walkable ?? false;
        const hasWest = this.getCell(x - 1, z)?.walkable ?? false;

        if (hasNorth) walkableNeighbors++;
        if (hasSouth) walkableNeighbors++;
        if (hasEast) walkableNeighbors++;
        if (hasWest) walkableNeighbors++;

        // Check for corridor pattern (walls on opposite sides)
        if (!hasNorth && !hasSouth && hasEast && hasWest) wallsInLine = 2; // E-W corridor
        if (!hasEast && !hasWest && hasNorth && hasSouth) wallsInLine = 2; // N-S corridor

        // Lower score = more constrained = potential chokepoint
        constraintMap[x][z] = walkableNeighbors - wallsInLine;
      }
    }

    // Find chokepoint candidates - cells with low constraint scores
    const visited = new Set<string>();

    for (let x = 0; x < this.gridWidth; x++) {
      for (let z = 0; z < this.gridHeight; z++) {
        const key = `${x},${z}`;
        if (visited.has(key)) continue;
        if (constraintMap[x][z] < 0 || constraintMap[x][z] > 2) continue;

        // Found a constrained cell - flood fill to find the corridor
        const corridor: { x: number; z: number }[] = [];
        const queue: { x: number; z: number }[] = [{ x, z }];

        while (queue.length > 0) {
          const cell = queue.shift()!;
          const cellKey = `${cell.x},${cell.z}`;
          if (visited.has(cellKey)) continue;
          visited.add(cellKey);

          if (constraintMap[cell.x]?.[cell.z] === undefined) continue;
          if (constraintMap[cell.x][cell.z] < 0 || constraintMap[cell.x][cell.z] > 2) continue;

          corridor.push(cell);

          // Check neighbors
          const neighbors = [
            { x: cell.x + 1, z: cell.z },
            { x: cell.x - 1, z: cell.z },
            { x: cell.x, z: cell.z + 1 },
            { x: cell.x, z: cell.z - 1 },
          ];

          for (const n of neighbors) {
            if (!visited.has(`${n.x},${n.z}`)) {
              queue.push(n);
            }
          }
        }

        // If corridor is long enough and narrow enough, it's a chokepoint
        if (corridor.length >= CHOKEPOINT_MIN_LENGTH) {
          // Calculate center and direction
          let sumX = 0, sumZ = 0;
          let minX = Infinity, maxX = -Infinity;
          let minZ = Infinity, maxZ = -Infinity;

          for (const c of corridor) {
            sumX += c.x;
            sumZ += c.z;
            minX = Math.min(minX, c.x);
            maxX = Math.max(maxX, c.x);
            minZ = Math.min(minZ, c.z);
            maxZ = Math.max(maxZ, c.z);
          }

          const centerX = sumX / corridor.length;
          const centerZ = sumZ / corridor.length;
          const width = Math.min(maxX - minX + 1, maxZ - minZ + 1);
          const length = Math.max(maxX - minX + 1, maxZ - minZ + 1);

          // Only keep narrow chokepoints
          if (width <= CHOKEPOINT_WIDTH_THRESHOLD) {
            // Direction is along the longer axis
            let dirX = 0, dirZ = 0;
            if (maxX - minX > maxZ - minZ) {
              dirX = 1; // Corridor runs E-W, flow is E-W
            } else {
              dirZ = 1; // Corridor runs N-S, flow is N-S
            }

            const worldPos = this.gridToWorld(Math.round(centerX), Math.round(centerZ));

            // Importance based on how narrow and how long
            const importance = Math.min(1, (length / 5) * (1 - width / CHOKEPOINT_WIDTH_THRESHOLD));

            this.chokepoints.push({
              position: worldPos,
              direction: new Vector3(dirX, 0, dirZ),
              width,
              importance,
            });
          }
        }
      }
    }

    // Sort by importance (most important first)
    this.chokepoints.sort((a, b) => b.importance - a.importance);

    // Limit to top chokepoints to avoid too many
    if (this.chokepoints.length > 20) {
      this.chokepoints = this.chokepoints.slice(0, 20);
    }
  }

  // Get all chokepoints
  getChokepoints(): Chokepoint[] {
    return this.chokepoints;
  }

  // Get nearest chokepoint to a position (optionally in a specific direction)
  getNearestChokepoint(pos: Vector3, preferDirection?: Vector3): Chokepoint | null {
    if (this.chokepoints.length === 0) return null;

    let best: Chokepoint | null = null;
    let bestScore = -Infinity;

    for (const cp of this.chokepoints) {
      const dx = cp.position.x - pos.x;
      const dz = cp.position.z - pos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      // Base score is inverse distance weighted by importance
      let score = cp.importance / (1 + dist * 0.1);

      // Bonus if chokepoint is in preferred direction
      if (preferDirection && dist > 1) {
        const toCP = new Vector3(dx / dist, 0, dz / dist);
        const dot = toCP.x * preferDirection.x + toCP.z * preferDirection.z;
        if (dot > 0) {
          score *= 1 + dot; // Boost score for chokepoints in our direction
        } else {
          score *= 0.3; // Penalize chokepoints behind us
        }
      }

      if (score > bestScore) {
        bestScore = score;
        best = cp;
      }
    }

    return best;
  }

  // Get a random chokepoint weighted by importance
  getRandomChokepoint(): Chokepoint | null {
    if (this.chokepoints.length === 0) return null;

    // Weight by importance
    const totalWeight = this.chokepoints.reduce((sum, cp) => sum + cp.importance, 0);
    let rand = Math.random() * totalWeight;

    for (const cp of this.chokepoints) {
      rand -= cp.importance;
      if (rand <= 0) return cp;
    }

    return this.chokepoints[0];
  }

  // Check if a cell is walkable (has ground, no obstacles)
  private isCellWalkable(worldX: number, worldZ: number, mesh: CollisionMesh, bounds: { min: Vector3; max: Vector3 }): boolean {
    // Check if there's ground below
    const groundY = this.findGroundAt(worldX, worldZ, mesh, bounds);
    if (groundY === null) return false;

    // Check if there's an obstacle at waist height
    const checkPos = new Vector3(worldX, groundY + NAV_HEIGHT_CHECK, worldZ);
    if (this.hasObstacleAt(checkPos, mesh)) return false;

    return true;
  }

  // Find ground Y at position
  private findGroundAt(x: number, z: number, mesh: CollisionMesh, bounds: { min: Vector3; max: Vector3 }): number | null {
    let bestY = -Infinity;
    let found = false;

    for (const tri of mesh.triangles) {
      // Only check floor-like triangles
      if (tri.normal.y < 0.5) continue;

      // Quick bounds check
      const triMinX = Math.min(tri.v0.x, tri.v1.x, tri.v2.x);
      const triMaxX = Math.max(tri.v0.x, tri.v1.x, tri.v2.x);
      const triMinZ = Math.min(tri.v0.z, tri.v1.z, tri.v2.z);
      const triMaxZ = Math.max(tri.v0.z, tri.v1.z, tri.v2.z);

      if (x < triMinX - 0.5 || x > triMaxX + 0.5) continue;
      if (z < triMinZ - 0.5 || z > triMaxZ + 0.5) continue;

      // Point in triangle test (2D)
      if (this.pointInTriXZ(x, z, tri)) {
        const y = this.triangleYAtXZ(x, z, tri);
        if (y !== null && y > bestY && y < bounds.max.y) {
          bestY = y;
          found = true;
        }
      }
    }

    return found ? bestY : null;
  }

  // Check if there's an obstacle at position
  private hasObstacleAt(pos: Vector3, mesh: CollisionMesh): boolean {
    const checkRadius = CELL_SIZE * 0.4;

    for (const tri of mesh.triangles) {
      // Skip floor/ceiling
      if (Math.abs(tri.normal.y) > 0.5) continue;

      // Quick bounds check
      const triMinX = Math.min(tri.v0.x, tri.v1.x, tri.v2.x);
      const triMaxX = Math.max(tri.v0.x, tri.v1.x, tri.v2.x);
      const triMinZ = Math.min(tri.v0.z, tri.v1.z, tri.v2.z);
      const triMaxZ = Math.max(tri.v0.z, tri.v1.z, tri.v2.z);
      const triMinY = Math.min(tri.v0.y, tri.v1.y, tri.v2.y);
      const triMaxY = Math.max(tri.v0.y, tri.v1.y, tri.v2.y);

      if (pos.x < triMinX - checkRadius || pos.x > triMaxX + checkRadius) continue;
      if (pos.z < triMinZ - checkRadius || pos.z > triMaxZ + checkRadius) continue;
      if (pos.y < triMinY - 1 || pos.y > triMaxY + 1) continue;

      // Simple distance check to triangle plane
      const dist = this.pointToTriangleDist(pos, tri);
      if (dist < checkRadius) return true;
    }

    return false;
  }

  // Simple point to triangle distance
  private pointToTriangleDist(p: Vector3, tri: { v0: Vector3; v1: Vector3; v2: Vector3; normal: Vector3 }): number {
    // Distance to plane
    const d = tri.normal.x * (p.x - tri.v0.x) +
              tri.normal.y * (p.y - tri.v0.y) +
              tri.normal.z * (p.z - tri.v0.z);
    return Math.abs(d);
  }

  // Point in triangle (XZ projection)
  private pointInTriXZ(px: number, pz: number, tri: { v0: Vector3; v1: Vector3; v2: Vector3 }): boolean {
    const v0x = tri.v2.x - tri.v0.x, v0z = tri.v2.z - tri.v0.z;
    const v1x = tri.v1.x - tri.v0.x, v1z = tri.v1.z - tri.v0.z;
    const v2x = px - tri.v0.x, v2z = pz - tri.v0.z;

    const dot00 = v0x * v0x + v0z * v0z;
    const dot01 = v0x * v1x + v0z * v1z;
    const dot02 = v0x * v2x + v0z * v2z;
    const dot11 = v1x * v1x + v1z * v1z;
    const dot12 = v1x * v2x + v1z * v2z;

    const denom = dot00 * dot11 - dot01 * dot01;
    if (Math.abs(denom) < 0.0001) return false;

    const invDenom = 1 / denom;
    const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
    const v = (dot00 * dot12 - dot01 * dot02) * invDenom;

    return (u >= -0.01) && (v >= -0.01) && (u + v <= 1.01);
  }

  // Get Y at XZ on triangle
  private triangleYAtXZ(px: number, pz: number, tri: { v0: Vector3; v1: Vector3; v2: Vector3; normal: Vector3 }): number | null {
    if (Math.abs(tri.normal.y) < 0.01) return null;
    return tri.v0.y - (tri.normal.x * (px - tri.v0.x) + tri.normal.z * (pz - tri.v0.z)) / tri.normal.y;
  }

  // Count walkable cells
  private countWalkable(): number {
    let count = 0;
    for (let x = 0; x < this.gridWidth; x++) {
      for (let z = 0; z < this.gridHeight; z++) {
        if (this.grid[x][z].walkable) count++;
      }
    }
    return count;
  }

  // Convert world position to grid coordinates
  worldToGrid(worldX: number, worldZ: number): { x: number; z: number } | null {
    const x = Math.floor((worldX - this.minX) / CELL_SIZE);
    const z = Math.floor((worldZ - this.minZ) / CELL_SIZE);

    if (x < 0 || x >= this.gridWidth || z < 0 || z >= this.gridHeight) {
      return null;
    }
    return { x, z };
  }

  // Convert grid coordinates to world position
  gridToWorld(gridX: number, gridZ: number): Vector3 {
    return new Vector3(
      this.minX + gridX * CELL_SIZE + CELL_SIZE / 2,
      0,
      this.minZ + gridZ * CELL_SIZE + CELL_SIZE / 2
    );
  }

  // Get cell at grid position
  getCell(x: number, z: number): NavCell | null {
    if (x < 0 || x >= this.gridWidth || z < 0 || z >= this.gridHeight) {
      return null;
    }
    return this.grid[x][z];
  }

  // A* pathfinding
  findPath(startWorld: Vector3, endWorld: Vector3): Vector3[] | null {
    if (!this.initialized) return null;

    const startGrid = this.worldToGrid(startWorld.x, startWorld.z);
    const endGrid = this.worldToGrid(endWorld.x, endWorld.z);

    if (!startGrid || !endGrid) return null;

    // If start or end not walkable, find nearest walkable
    const start = this.findNearestWalkable(startGrid.x, startGrid.z);
    const end = this.findNearestWalkable(endGrid.x, endGrid.z);

    if (!start || !end) return null;
    if (start.x === end.x && start.z === end.z) {
      return [this.gridToWorld(end.x, end.z)];
    }

    // A* algorithm
    const openSet: AStarNode[] = [];
    const closedSet = new Set<string>();

    const startNode: AStarNode = {
      x: start.x,
      z: start.z,
      g: 0,
      h: this.heuristic(start.x, start.z, end.x, end.z),
      f: 0,
      parent: null,
    };
    startNode.f = startNode.g + startNode.h;
    openSet.push(startNode);

    let iterations = 0;

    while (openSet.length > 0 && iterations < MAX_PATH_LENGTH * 10) {
      iterations++;

      // Get node with lowest f
      openSet.sort((a, b) => a.f - b.f);
      const current = openSet.shift()!;

      // Check if reached goal
      if (current.x === end.x && current.z === end.z) {
        return this.reconstructPath(current);
      }

      closedSet.add(`${current.x},${current.z}`);

      // Check neighbors (8 directions)
      const neighbors = [
        { dx: 0, dz: 1, cost: 1 },
        { dx: 1, dz: 0, cost: 1 },
        { dx: 0, dz: -1, cost: 1 },
        { dx: -1, dz: 0, cost: 1 },
        { dx: 1, dz: 1, cost: 1.414 },
        { dx: 1, dz: -1, cost: 1.414 },
        { dx: -1, dz: 1, cost: 1.414 },
        { dx: -1, dz: -1, cost: 1.414 },
      ];

      for (const n of neighbors) {
        const nx = current.x + n.dx;
        const nz = current.z + n.dz;

        // Skip if out of bounds or not walkable
        const cell = this.getCell(nx, nz);
        if (!cell || !cell.walkable) continue;

        // Skip if in closed set
        if (closedSet.has(`${nx},${nz}`)) continue;

        // Check diagonal movement (don't cut corners)
        if (n.dx !== 0 && n.dz !== 0) {
          const cell1 = this.getCell(current.x + n.dx, current.z);
          const cell2 = this.getCell(current.x, current.z + n.dz);
          if (!cell1?.walkable || !cell2?.walkable) continue;
        }

        const g = current.g + n.cost;
        const h = this.heuristic(nx, nz, end.x, end.z);
        const f = g + h;

        // Check if already in open set with better score
        const existing = openSet.find(node => node.x === nx && node.z === nz);
        if (existing) {
          if (g < existing.g) {
            existing.g = g;
            existing.f = f;
            existing.parent = current;
          }
          continue;
        }

        openSet.push({
          x: nx,
          z: nz,
          g,
          h,
          f,
          parent: current,
        });
      }
    }

    return null; // No path found
  }

  // Heuristic (Euclidean distance)
  private heuristic(x1: number, z1: number, x2: number, z2: number): number {
    const dx = x2 - x1;
    const dz = z2 - z1;
    return Math.sqrt(dx * dx + dz * dz);
  }

  // Reconstruct path from end node
  private reconstructPath(endNode: AStarNode): Vector3[] {
    const path: Vector3[] = [];
    let current: AStarNode | null = endNode;

    while (current) {
      path.unshift(this.gridToWorld(current.x, current.z));
      current = current.parent;
    }

    // Simplify path by removing unnecessary waypoints
    return this.simplifyPath(path);
  }

  // Find nearest walkable cell
  private findNearestWalkable(x: number, z: number): { x: number; z: number } | null {
    const cell = this.getCell(x, z);
    if (cell?.walkable) return { x, z };

    // Search in expanding radius
    for (let r = 1; r <= 5; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const c = this.getCell(x + dx, z + dz);
          if (c?.walkable) return { x: x + dx, z: z + dz };
        }
      }
    }
    return null;
  }

  // Simplify path by removing collinear points
  private simplifyPath(path: Vector3[]): Vector3[] {
    if (path.length <= 2) return path;

    const simplified: Vector3[] = [path[0]];

    for (let i = 1; i < path.length - 1; i++) {
      const prev = simplified[simplified.length - 1];
      const curr = path[i];
      const next = path[i + 1];

      // Check if curr is on line from prev to next
      const dx1 = curr.x - prev.x;
      const dz1 = curr.z - prev.z;
      const dx2 = next.x - curr.x;
      const dz2 = next.z - curr.z;

      // Cross product to check collinearity
      const cross = dx1 * dz2 - dz1 * dx2;
      if (Math.abs(cross) > 0.1) {
        simplified.push(curr);
      }
    }

    simplified.push(path[path.length - 1]);
    return simplified;
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}

// Singleton navigation grid
let navGridInstance: NavigationGrid | null = null;

export function getNavGrid(): NavigationGrid {
  if (!navGridInstance) {
    navGridInstance = new NavigationGrid();
  }
  return navGridInstance;
}

// Initialize navigation grid from current map
export function initNavGrid(bounds: { min: Vector3; max: Vector3 }): void {
  const mesh = getGlobalCollisionMesh();
  if (!mesh || mesh.triangles.length === 0) {
    debugLog('[Nav] No collision mesh available');
    return;
  }

  const grid = getNavGrid();
  grid.buildFromMesh(mesh, bounds);
}

// Get all chokepoints from the nav grid
export function getChokepoints(): Chokepoint[] {
  return getNavGrid().getChokepoints();
}

// Get nearest chokepoint to a position
export function getNearestChokepoint(pos: Vector3, preferDirection?: Vector3): Chokepoint | null {
  return getNavGrid().getNearestChokepoint(pos, preferDirection);
}

// Get a random chokepoint weighted by importance
export function getRandomChokepoint(): Chokepoint | null {
  return getNavGrid().getRandomChokepoint();
}

// Path cache for bots (keyed by bot name)
const pathCache = new Map<string, CachedPath>();

// Stagger offset cache (so each bot has consistent stagger)
const staggerOffsets = new Map<string, number>();

// Get stagger offset for a bot (consistent per bot name)
function getStaggerOffset(botName: string): number {
  let offset = staggerOffsets.get(botName);
  if (offset === undefined) {
    // Generate consistent offset based on bot name hash
    let hash = 0;
    for (let i = 0; i < botName.length; i++) {
      hash = ((hash << 5) - hash) + botName.charCodeAt(i);
      hash |= 0;
    }
    offset = Math.abs(hash % PATH_CACHE_STAGGER);
    staggerOffsets.set(botName, offset);
  }
  return offset;
}

// Get or compute path for a bot (staggered recalculation)
export function getBotPath(botName: string, startPos: Vector3, targetPos: Vector3, now: number): CachedPath | null {
  const grid = getNavGrid();
  if (!grid.isInitialized()) {
    // Nav grid not ready - this is expected before map loads
    return null;
  }

  // Get bot's stagger offset for distributed recalculation
  const stagger = getStaggerOffset(botName);
  const cacheTime = PATH_CACHE_BASE_TIME + stagger;

  // Check cache
  const cached = pathCache.get(botName);
  if (cached) {
    // Check if target changed significantly or cache expired
    const targetDist = Vector3.sub(cached.targetPos, targetPos).length();
    const age = now - cached.computedAt;

    // Keep using cached path if target hasn't moved much and cache is fresh
    if (targetDist < 5 && age < cacheTime && cached.path.length > 0) {
      return cached;
    }
  }

  // Compute new path
  const path = grid.findPath(startPos, targetPos);
  if (!path || path.length === 0) {
    return null;
  }

  const newCache: CachedPath = {
    path,
    targetPos: targetPos.clone(),
    computedAt: now,
    currentIndex: 0,
  };

  pathCache.set(botName, newCache);
  return newCache;
}

// Get next waypoint for a bot following a path
export function getNextPathWaypoint(botName: string, currentPos: Vector3): Vector3 | null {
  const cached = pathCache.get(botName);
  if (!cached || cached.path.length === 0) return null;

  // Check if we've reached current waypoint
  while (cached.currentIndex < cached.path.length) {
    const waypoint = cached.path[cached.currentIndex];
    const dist = Math.sqrt(
      (currentPos.x - waypoint.x) ** 2 +
      (currentPos.z - waypoint.z) ** 2
    );

    if (dist < PATH_WAYPOINT_DIST) {
      cached.currentIndex++;
    } else {
      return waypoint;
    }
  }

  return null; // Reached end of path
}

// Clear path cache for a bot
export function clearBotPath(botName: string): void {
  pathCache.delete(botName);
}
