// Pool Server Registry - Tracks connected pool servers for the hub
import { WebSocket } from 'ws';
import {
  PoolServerInfo,
  RoomInfo,
  AggregatedRoomInfo,
  serializeHubToPoolMessage,
} from '../protocol.js';

export interface RegisteredPool {
  info: PoolServerInfo;
  ws: WebSocket;
  isAlive: boolean;
}

export class PoolRegistry {
  private pools: Map<string, RegisteredPool> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private readonly HEARTBEAT_INTERVAL = 10000;  // 10 seconds
  private readonly DEAD_POOL_TIMEOUT = 30000;   // 30 seconds

  constructor() {
    this.startHeartbeatChecker();
  }

  // Register a new pool server
  registerPool(
    ws: WebSocket,
    serverName: string,
    endpoint: string,
    maxRooms: number
  ): string {
    const poolId = this.generatePoolId();

    const poolInfo: PoolServerInfo = {
      id: poolId,
      name: serverName,
      endpoint,
      maxRooms,
      currentRooms: 0,
      playerCount: 0,
      load: 0,
      lastHeartbeat: Date.now(),
      rooms: [],
    };

    this.pools.set(poolId, {
      info: poolInfo,
      ws,
      isAlive: true,
    });

    console.log(`[PoolRegistry] Pool registered: ${serverName} (${poolId}) at ${endpoint}`);
    return poolId;
  }

  // Unregister a pool server
  unregisterPool(poolId: string): void {
    const pool = this.pools.get(poolId);
    if (pool) {
      console.log(`[PoolRegistry] Pool unregistered: ${pool.info.name} (${poolId})`);
      this.pools.delete(poolId);
    }
  }

  // Find pool by WebSocket connection
  findPoolByWs(ws: WebSocket): RegisteredPool | undefined {
    for (const pool of this.pools.values()) {
      if (pool.ws === ws) {
        return pool;
      }
    }
    return undefined;
  }

  // Update pool heartbeat with current state
  updatePoolHeartbeat(
    poolId: string,
    rooms: RoomInfo[],
    playerCount: number,
    load: number
  ): void {
    const pool = this.pools.get(poolId);
    if (pool) {
      pool.info.rooms = rooms;
      pool.info.currentRooms = rooms.length;
      pool.info.playerCount = playerCount;
      pool.info.load = load;
      pool.info.lastHeartbeat = Date.now();
      pool.isAlive = true;
    }
  }

  // Handle room created event from pool
  handleRoomCreated(poolId: string, room: RoomInfo): void {
    const pool = this.pools.get(poolId);
    if (pool) {
      // Add to pool's room list if not already there
      const existingIndex = pool.info.rooms.findIndex(r => r.id === room.id);
      if (existingIndex >= 0) {
        pool.info.rooms[existingIndex] = room;
      } else {
        pool.info.rooms.push(room);
      }
      pool.info.currentRooms = pool.info.rooms.length;
    }
  }

  // Handle room closed event from pool
  handleRoomClosed(poolId: string, roomId: string): void {
    const pool = this.pools.get(poolId);
    if (pool) {
      pool.info.rooms = pool.info.rooms.filter(r => r.id !== roomId);
      pool.info.currentRooms = pool.info.rooms.length;
    }
  }

  // Get all rooms aggregated from all pools
  getAggregatedRooms(): AggregatedRoomInfo[] {
    const rooms: AggregatedRoomInfo[] = [];

    for (const pool of this.pools.values()) {
      for (const room of pool.info.rooms) {
        rooms.push({
          ...room,
          poolId: pool.info.id,
          poolName: pool.info.name,
          poolEndpoint: pool.info.endpoint,
        });
      }
    }

    return rooms;
  }

  // Get pool info for a specific room
  getPoolForRoom(roomId: string): RegisteredPool | undefined {
    for (const pool of this.pools.values()) {
      if (pool.info.rooms.some(r => r.id === roomId)) {
        return pool;
      }
    }
    return undefined;
  }

  // Get all pool summaries (for client display)
  getPoolSummaries(): { id: string; name: string; playerCount: number }[] {
    return Array.from(this.pools.values()).map(pool => ({
      id: pool.info.id,
      name: pool.info.name,
      playerCount: pool.info.playerCount,
    }));
  }

  // Get pool with lowest load for room creation
  getLeastLoadedPool(): RegisteredPool | undefined {
    let leastLoaded: RegisteredPool | undefined;
    let lowestLoad = Infinity;

    for (const pool of this.pools.values()) {
      // Check if pool has capacity
      if (pool.info.currentRooms < pool.info.maxRooms && pool.info.load < lowestLoad) {
        lowestLoad = pool.info.load;
        leastLoaded = pool;
      }
    }

    return leastLoaded;
  }

  // Get specific pool by ID
  getPool(poolId: string): RegisteredPool | undefined {
    return this.pools.get(poolId);
  }

  // Get all pools
  getAllPools(): RegisteredPool[] {
    return Array.from(this.pools.values());
  }

  // Get pool count
  getPoolCount(): number {
    return this.pools.size;
  }

  // Get total player count across all pools
  getTotalPlayerCount(): number {
    let total = 0;
    for (const pool of this.pools.values()) {
      total += pool.info.playerCount;
    }
    return total;
  }

  // Start heartbeat checker to detect dead pools
  private startHeartbeatChecker(): void {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();

      for (const [poolId, pool] of this.pools) {
        // Send ping to pool
        if (pool.ws.readyState === WebSocket.OPEN) {
          pool.ws.send(serializeHubToPoolMessage({ type: 'pool_ping' }));
        }

        // Check for dead pools
        if (now - pool.info.lastHeartbeat > this.DEAD_POOL_TIMEOUT) {
          console.log(`[PoolRegistry] Pool ${pool.info.name} (${poolId}) timed out - removing`);
          pool.ws.close();
          this.pools.delete(poolId);
        }
      }
    }, this.HEARTBEAT_INTERVAL);
  }

  // Stop the registry
  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Close all pool connections
    for (const pool of this.pools.values()) {
      pool.ws.close();
    }
    this.pools.clear();
  }

  // Generate unique pool ID
  private generatePoolId(): string {
    return `pool_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
