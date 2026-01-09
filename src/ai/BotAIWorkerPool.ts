/**
 * BotAIWorkerPool - Manages worker threads for parallel bot AI computations.
 *
 * Primary optimization: Batch line-of-sight checks across multiple bots.
 * Each worker maintains its own copy of the collision mesh for fast LOS queries.
 */

import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Vector3 } from '../engine/math/Vector3.js';
import { CollisionMesh } from '../physics/MeshCollision.js';

interface LOSQuery {
  id: number;
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
}

interface LOSResult {
  id: number;
  visible: boolean;
}

interface PendingBatch {
  resolve: (results: Map<number, boolean>) => void;
  reject: (error: Error) => void;
  queryCount: number;
  results: Map<number, boolean>;
  completedWorkers: number;
  totalWorkers: number;
}

export class BotAIWorkerPool {
  private workers: Worker[] = [];
  private workerReady: boolean[] = [];
  private meshReady: boolean[] = [];
  private pendingBatch: PendingBatch | null = null;
  private _isInitialized = false;
  private numWorkers: number;

  constructor(numWorkers: number = 2) {
    // Bot AI benefits from 2-4 workers (diminishing returns beyond that)
    this.numWorkers = Math.max(1, Math.min(numWorkers, 4));
  }

  /**
   * Initialize the worker pool.
   */
  async initialize(): Promise<void> {
    if (this._isInitialized) return;

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const workerPath = join(__dirname, 'BotAIWorker.js');

    const initPromises: Promise<void>[] = [];

    for (let i = 0; i < this.numWorkers; i++) {
      try {
        const worker = new Worker(workerPath);
        this.workers.push(worker);
        this.workerReady.push(false);
        this.meshReady.push(false);

        worker.on('message', (message) => {
          this.handleWorkerMessage(i, message);
        });

        worker.on('error', (error) => {
          console.error(`[BotAIWorkerPool] Worker ${i} error:`, error);
        });

        worker.on('exit', (code) => {
          if (code !== 0) {
            console.error(`[BotAIWorkerPool] Worker ${i} exited with code ${code}`);
          }
        });

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
      } catch (error) {
        console.error(`[BotAIWorkerPool] Failed to create worker ${i}:`, error);
      }
    }

    await Promise.all(initPromises);
    this._isInitialized = this.workers.length > 0;

    if (this._isInitialized) {
      console.log(`[BotAIWorkerPool] Initialized with ${this.workers.length} workers`);
    }
  }

  /**
   * Handle message from worker.
   */
  private handleWorkerMessage(workerIndex: number, message: any): void {
    if (message.type === 'ready') {
      this.workerReady[workerIndex] = true;
    } else if (message.type === 'meshSet') {
      this.meshReady[workerIndex] = true;
    } else if (message.type === 'batchLOS') {
      // Merge results into pending batch
      if (this.pendingBatch) {
        for (const result of message.results) {
          this.pendingBatch.results.set(result.id, result.visible);
        }
        this.pendingBatch.completedWorkers++;

        // Check if all workers have completed
        if (this.pendingBatch.completedWorkers >= this.pendingBatch.totalWorkers) {
          this.pendingBatch.resolve(this.pendingBatch.results);
          this.pendingBatch = null;
        }
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

    // Reset mesh ready flags
    for (let i = 0; i < this.meshReady.length; i++) {
      this.meshReady[i] = false;
    }

    // Send to all workers
    for (const worker of this.workers) {
      worker.postMessage({
        type: 'setMesh',
        triangles: triangleData,
      });
    }
  }

  /**
   * Wait for mesh to be set on all workers.
   */
  async waitForMesh(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.meshReady.every(r => r)) {
          resolve();
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });
  }

  /**
   * Perform batched line-of-sight checks.
   * Distributes queries across workers and returns results as a Map.
   *
   * @param queries Array of LOS queries (from, to positions)
   * @returns Map of query index -> visibility result
   */
  async batchLineOfSight(
    queries: Array<{ from: Vector3; to: Vector3 }>
  ): Promise<Map<number, boolean>> {
    if (!this._isInitialized || queries.length === 0) {
      return new Map();
    }

    // If only a few queries, process synchronously (overhead not worth it)
    if (queries.length < 4 || this.workers.length === 0) {
      // Return empty map - caller should fall back to sync processing
      return new Map();
    }

    return new Promise((resolve, reject) => {
      // Distribute queries across workers
      const queriesPerWorker = Math.ceil(queries.length / this.workers.length);
      let queryId = 0;

      this.pendingBatch = {
        resolve,
        reject,
        queryCount: queries.length,
        results: new Map(),
        completedWorkers: 0,
        totalWorkers: Math.min(this.workers.length, Math.ceil(queries.length / queriesPerWorker)),
      };

      for (let w = 0; w < this.workers.length; w++) {
        const start = w * queriesPerWorker;
        const end = Math.min(start + queriesPerWorker, queries.length);
        if (start >= queries.length) break;

        const workerQueries: LOSQuery[] = [];
        for (let i = start; i < end; i++) {
          workerQueries.push({
            id: i,
            from: { x: queries[i].from.x, y: queries[i].from.y, z: queries[i].from.z },
            to: { x: queries[i].to.x, y: queries[i].to.y, z: queries[i].to.z },
          });
        }

        this.workers[w].postMessage({
          type: 'batchLOS',
          queries: workerQueries,
        });
      }

      // Timeout to prevent hanging
      setTimeout(() => {
        if (this.pendingBatch) {
          this.pendingBatch.reject(new Error('LOS batch timeout'));
          this.pendingBatch = null;
        }
      }, 1000);
    });
  }

  /**
   * Check if pool is initialized.
   */
  get isInitialized(): boolean {
    return this._isInitialized;
  }

  /**
   * Check if mesh is ready on all workers.
   */
  get isMeshReady(): boolean {
    return this.meshReady.every(r => r);
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
    this.meshReady = [];
    this.pendingBatch = null;
    this._isInitialized = false;
    console.log('[BotAIWorkerPool] Shutdown complete');
  }
}

// Singleton instance
let poolInstance: BotAIWorkerPool | null = null;

/**
 * Get the bot AI worker pool instance.
 */
export function getBotAIWorkerPool(numWorkers?: number): BotAIWorkerPool {
  if (!poolInstance) {
    poolInstance = new BotAIWorkerPool(numWorkers);
  }
  return poolInstance;
}

/**
 * Initialize the bot AI worker pool.
 */
export async function initializeBotAIWorkerPool(numWorkers: number = 2): Promise<BotAIWorkerPool> {
  const pool = getBotAIWorkerPool(numWorkers);
  await pool.initialize();
  return pool;
}

/**
 * Shutdown the bot AI worker pool.
 */
export async function shutdownBotAIWorkerPool(): Promise<void> {
  if (poolInstance) {
    await poolInstance.shutdown();
    poolInstance = null;
  }
}
