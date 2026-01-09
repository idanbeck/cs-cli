/**
 * CollisionWorkerPool - Manages a pool of worker threads for parallel collision queries.
 *
 * Useful for:
 * - Bot line-of-sight checks (raycasts)
 * - Multi-bot collision detection
 * - Parallel physics simulation
 */

import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Vector3 } from '../engine/math/Vector3.js';
import { CollisionTriangle, CollisionMesh } from './MeshCollision.js';
import {
  RaycastQuery,
  SphereQuery,
  BatchQuery,
  RaycastResult,
  SphereResult,
  BatchResult,
  WorkerResult,
  SetBVHMessage,
} from './CollisionWorker.js';

export interface PendingQuery {
  resolve: (result: RaycastResult | SphereResult) => void;
  reject: (error: Error) => void;
}

export interface PooledRaycastResult {
  hit: boolean;
  distance: number;
  point: Vector3;
  normal: Vector3;
}

export class CollisionWorkerPool {
  private workers: Worker[] = [];
  private workerReady: boolean[] = [];
  private pendingQueries: Map<number, PendingQuery> = new Map();
  private queryIdCounter = 0;
  private roundRobinIndex = 0;
  private _isInitialized = false;
  private numWorkers: number;

  constructor(numWorkers: number = 4) {
    this.numWorkers = Math.max(1, Math.min(numWorkers, 8));
  }

  /**
   * Initialize the worker pool.
   */
  async initialize(): Promise<void> {
    if (this._isInitialized) return;

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const workerPath = join(__dirname, 'CollisionWorker.js');

    const initPromises: Promise<void>[] = [];

    for (let i = 0; i < this.numWorkers; i++) {
      const worker = new Worker(workerPath);
      this.workers.push(worker);
      this.workerReady.push(false);

      // Handle messages from worker
      worker.on('message', (message: WorkerResult) => {
        this.handleWorkerMessage(i, message);
      });

      worker.on('error', (error) => {
        console.error(`[CollisionWorkerPool] Worker ${i} error:`, error);
      });

      worker.on('exit', (code) => {
        if (code !== 0) {
          console.error(`[CollisionWorkerPool] Worker ${i} exited with code ${code}`);
        }
      });

      // Wait for worker to be ready
      initPromises.push(
        new Promise((resolve) => {
          const checkReady = () => {
            if (this.workerReady[i]) {
              resolve();
            } else {
              setTimeout(checkReady, 10);
            }
          };
          checkReady();
        })
      );
    }

    await Promise.all(initPromises);
    this._isInitialized = true;
    console.log(`[CollisionWorkerPool] Initialized with ${this.numWorkers} workers`);
  }

  /**
   * Handle message from a worker.
   */
  private handleWorkerMessage(workerIndex: number, message: WorkerResult): void {
    if (message.type === 'ready') {
      this.workerReady[workerIndex] = true;
    } else if (message.type === 'bvhSet') {
      // BVH set confirmation
    } else if (message.type === 'batch') {
      const batchResult = message as BatchResult;
      for (const result of batchResult.results) {
        const pending = this.pendingQueries.get(result.id);
        if (pending) {
          pending.resolve(result);
          this.pendingQueries.delete(result.id);
        }
      }
    } else if (message.type === 'raycast' || message.type === 'sphere') {
      const result = message as RaycastResult | SphereResult;
      const pending = this.pendingQueries.get(result.id);
      if (pending) {
        pending.resolve(result);
        this.pendingQueries.delete(result.id);
      }
    }
  }

  /**
   * Update workers with collision mesh data.
   */
  updateCollisionMesh(mesh: CollisionMesh): void {
    if (!this._isInitialized || mesh.triangles.length === 0) return;

    // Serialize triangles for workers
    const triangleData = mesh.triangles.map((tri) => ({
      v0: { x: tri.v0.x, y: tri.v0.y, z: tri.v0.z },
      v1: { x: tri.v1.x, y: tri.v1.y, z: tri.v1.z },
      v2: { x: tri.v2.x, y: tri.v2.y, z: tri.v2.z },
      normal: { x: tri.normal.x, y: tri.normal.y, z: tri.normal.z },
    }));

    const message: SetBVHMessage = {
      type: 'setBVH',
      triangles: triangleData,
    };

    // Send to all workers
    for (const worker of this.workers) {
      worker.postMessage(message);
    }
  }

  /**
   * Perform a raycast using a worker.
   */
  async raycast(
    origin: Vector3,
    direction: Vector3,
    maxDistance: number = Infinity
  ): Promise<PooledRaycastResult> {
    if (!this._isInitialized) {
      throw new Error('CollisionWorkerPool not initialized');
    }

    const queryId = this.queryIdCounter++;
    const query: RaycastQuery = {
      type: 'raycast',
      id: queryId,
      origin: { x: origin.x, y: origin.y, z: origin.z },
      direction: { x: direction.x, y: direction.y, z: direction.z },
      maxDistance,
    };

    return new Promise((resolve, reject) => {
      this.pendingQueries.set(queryId, {
        resolve: (result) => {
          const rayResult = result as RaycastResult;
          resolve({
            hit: rayResult.hit,
            distance: rayResult.distance,
            point: new Vector3(rayResult.point.x, rayResult.point.y, rayResult.point.z),
            normal: new Vector3(rayResult.normal.x, rayResult.normal.y, rayResult.normal.z),
          });
        },
        reject,
      });

      // Round-robin worker selection
      const workerIndex = this.roundRobinIndex % this.workers.length;
      this.roundRobinIndex++;
      this.workers[workerIndex].postMessage(query);
    });
  }

  /**
   * Perform multiple raycasts in batch.
   */
  async raycastBatch(
    queries: Array<{ origin: Vector3; direction: Vector3; maxDistance?: number }>
  ): Promise<PooledRaycastResult[]> {
    if (!this._isInitialized) {
      throw new Error('CollisionWorkerPool not initialized');
    }

    if (queries.length === 0) return [];

    // Distribute queries across workers
    const queriesPerWorker = Math.ceil(queries.length / this.workers.length);
    const workerPromises: Promise<PooledRaycastResult[]>[] = [];

    for (let w = 0; w < this.workers.length; w++) {
      const start = w * queriesPerWorker;
      const end = Math.min(start + queriesPerWorker, queries.length);
      if (start >= queries.length) break;

      const workerQueries: RaycastQuery[] = [];
      const queryIds: number[] = [];

      for (let i = start; i < end; i++) {
        const queryId = this.queryIdCounter++;
        queryIds.push(queryId);
        workerQueries.push({
          type: 'raycast',
          id: queryId,
          origin: { x: queries[i].origin.x, y: queries[i].origin.y, z: queries[i].origin.z },
          direction: { x: queries[i].direction.x, y: queries[i].direction.y, z: queries[i].direction.z },
          maxDistance: queries[i].maxDistance ?? Infinity,
        });
      }

      const batchQuery: BatchQuery = {
        type: 'batch',
        queries: workerQueries,
      };

      const workerPromise = new Promise<PooledRaycastResult[]>((resolve) => {
        const results: PooledRaycastResult[] = new Array(queryIds.length);
        let completed = 0;

        for (let i = 0; i < queryIds.length; i++) {
          const idx = i;
          this.pendingQueries.set(queryIds[i], {
            resolve: (result) => {
              const rayResult = result as RaycastResult;
              results[idx] = {
                hit: rayResult.hit,
                distance: rayResult.distance,
                point: new Vector3(rayResult.point.x, rayResult.point.y, rayResult.point.z),
                normal: new Vector3(rayResult.normal.x, rayResult.normal.y, rayResult.normal.z),
              };
              completed++;
              if (completed === queryIds.length) {
                resolve(results);
              }
            },
            reject: () => {
              results[idx] = {
                hit: false,
                distance: Infinity,
                point: Vector3.zero(),
                normal: Vector3.zero(),
              };
              completed++;
              if (completed === queryIds.length) {
                resolve(results);
              }
            },
          });
        }

        this.workers[w].postMessage(batchQuery);
      });

      workerPromises.push(workerPromise);
    }

    const allResults = await Promise.all(workerPromises);
    return allResults.flat();
  }

  /**
   * Check if pool is initialized.
   */
  get isInitialized(): boolean {
    return this._isInitialized;
  }

  /**
   * Get number of workers.
   */
  get workerCount(): number {
    return this.workers.length;
  }

  /**
   * Shutdown all workers.
   */
  async shutdown(): Promise<void> {
    for (const worker of this.workers) {
      await worker.terminate();
    }
    this.workers = [];
    this.workerReady = [];
    this.pendingQueries.clear();
    this._isInitialized = false;
    console.log('[CollisionWorkerPool] Shutdown complete');
  }
}

// Singleton instance
let poolInstance: CollisionWorkerPool | null = null;

/**
 * Get the collision worker pool instance.
 */
export function getCollisionWorkerPool(numWorkers?: number): CollisionWorkerPool {
  if (!poolInstance) {
    poolInstance = new CollisionWorkerPool(numWorkers);
  }
  return poolInstance;
}

/**
 * Initialize the collision worker pool.
 */
export async function initializeCollisionWorkerPool(numWorkers: number = 4): Promise<CollisionWorkerPool> {
  const pool = getCollisionWorkerPool(numWorkers);
  await pool.initialize();
  return pool;
}

/**
 * Shutdown the collision worker pool.
 */
export async function shutdownCollisionWorkerPool(): Promise<void> {
  if (poolInstance) {
    await poolInstance.shutdown();
    poolInstance = null;
  }
}
