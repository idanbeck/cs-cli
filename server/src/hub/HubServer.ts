// Hub Server - Central registry and routing for federated game servers
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, IncomingMessage } from 'http';
import { PoolRegistry, RegisteredPool } from './PoolRegistry.js';
import {
  parsePoolToHubMessage,
  parseClientToHubMessage,
  serializeHubToPoolMessage,
  serializeHubToClientMessage,
  PoolToHubMessage,
  ClientToHubMessage,
  RoomConfig,
} from '../protocol.js';

// Connection types
type ConnectionType = 'unknown' | 'pool' | 'client';

interface Connection {
  ws: WebSocket;
  type: ConnectionType;
  poolId?: string;  // Set if this is a pool server connection
}

export interface HubServerConfig {
  port: number;
  builtInPoolEndpoint?: string;  // If set, treat this as built-in pool
}

export class HubServer {
  private wss: WebSocketServer | null = null;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private poolRegistry: PoolRegistry;
  private connections: Map<WebSocket, Connection> = new Map();
  private config: HubServerConfig;
  private tokenMap: Map<string, { roomId: string; endpoint: string; expires: number }> = new Map();

  constructor(config: HubServerConfig) {
    this.config = config;
    this.poolRegistry = new PoolRegistry();
  }

  // Start the hub server
  start(): void {
    this.httpServer = createServer();
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req);
    });

    this.httpServer.listen(this.config.port, () => {
      console.log(`[HubServer] Listening on port ${this.config.port}`);
    });

    // Clean up expired tokens periodically
    setInterval(() => this.cleanupExpiredTokens(), 60000);
  }

  // Stop the hub server
  stop(): void {
    this.poolRegistry.stop();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }

    this.connections.clear();
    this.tokenMap.clear();
  }

  // Handle new WebSocket connection
  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const connection: Connection = {
      ws,
      type: 'unknown',
    };
    this.connections.set(ws, connection);

    console.log(`[HubServer] New connection from ${req.socket.remoteAddress}`);

    ws.on('message', (data: Buffer) => {
      this.handleMessage(ws, data.toString());
    });

    ws.on('close', () => {
      this.handleDisconnect(ws);
    });

    ws.on('error', (error) => {
      console.error(`[HubServer] WebSocket error:`, error);
      this.handleDisconnect(ws);
    });
  }

  // Handle incoming message
  private handleMessage(ws: WebSocket, data: string): void {
    const connection = this.connections.get(ws);
    if (!connection) return;

    // Try to parse as pool server message
    const poolMsg = parsePoolToHubMessage(data);
    if (poolMsg) {
      this.handlePoolMessage(ws, connection, poolMsg);
      return;
    }

    // Try to parse as client message
    const clientMsg = parseClientToHubMessage(data);
    if (clientMsg) {
      this.handleClientMessage(ws, connection, clientMsg);
      return;
    }

    console.warn(`[HubServer] Unknown message type:`, data.substring(0, 100));
  }

  // Handle pool server messages
  private handlePoolMessage(ws: WebSocket, connection: Connection, msg: PoolToHubMessage): void {
    switch (msg.type) {
      case 'pool_register':
        this.handlePoolRegister(ws, connection, msg.serverName, msg.endpoint, msg.maxRooms);
        break;

      case 'pool_heartbeat':
        if (connection.poolId) {
          this.poolRegistry.updatePoolHeartbeat(
            connection.poolId,
            msg.rooms,
            msg.playerCount,
            msg.load
          );
        }
        break;

      case 'pool_room_created':
        if (connection.poolId) {
          this.poolRegistry.handleRoomCreated(connection.poolId, msg.room);
          console.log(`[HubServer] Room created on pool ${connection.poolId}: ${msg.room.name}`);
        }
        break;

      case 'pool_room_closed':
        if (connection.poolId) {
          this.poolRegistry.handleRoomClosed(connection.poolId, msg.roomId);
          console.log(`[HubServer] Room closed on pool ${connection.poolId}: ${msg.roomId}`);
        }
        break;

      case 'pool_unregister':
        if (connection.poolId) {
          this.poolRegistry.unregisterPool(connection.poolId);
          connection.type = 'unknown';
          connection.poolId = undefined;
        }
        break;
    }
  }

  // Handle pool server registration
  private handlePoolRegister(
    ws: WebSocket,
    connection: Connection,
    serverName: string,
    endpoint: string,
    maxRooms: number
  ): void {
    // Validate
    if (!serverName || !endpoint) {
      ws.send(serializeHubToPoolMessage({
        type: 'pool_rejected',
        reason: 'Missing serverName or endpoint',
      }));
      return;
    }

    // Register the pool
    const poolId = this.poolRegistry.registerPool(ws, serverName, endpoint, maxRooms);

    connection.type = 'pool';
    connection.poolId = poolId;

    ws.send(serializeHubToPoolMessage({
      type: 'pool_accepted',
      poolId,
    }));

    console.log(`[HubServer] Pool ${serverName} registered with ID ${poolId}`);
  }

  // Handle client messages
  private handleClientMessage(ws: WebSocket, connection: Connection, msg: ClientToHubMessage): void {
    connection.type = 'client';

    switch (msg.type) {
      case 'hub_list_rooms':
        this.handleListRooms(ws);
        break;

      case 'hub_get_endpoint':
        this.handleGetEndpoint(ws, msg.roomId);
        break;

      case 'hub_create_room':
        this.handleCreateRoom(ws, msg.config, msg.preferredPool);
        break;
    }
  }

  // Handle room list request
  private handleListRooms(ws: WebSocket): void {
    const rooms = this.poolRegistry.getAggregatedRooms();
    const pools = this.poolRegistry.getPoolSummaries();

    ws.send(serializeHubToClientMessage({
      type: 'hub_room_list',
      rooms,
      pools,
    }));
  }

  // Handle get endpoint request (client wants to join a room)
  private handleGetEndpoint(ws: WebSocket, roomId: string): void {
    const pool = this.poolRegistry.getPoolForRoom(roomId);

    if (!pool) {
      ws.send(serializeHubToClientMessage({
        type: 'hub_room_not_found',
        roomId,
      }));
      return;
    }

    // Generate a join token
    const token = this.generateToken();
    this.tokenMap.set(token, {
      roomId,
      endpoint: pool.info.endpoint,
      expires: Date.now() + 60000,  // 1 minute expiry
    });

    ws.send(serializeHubToClientMessage({
      type: 'hub_room_endpoint',
      roomId,
      endpoint: pool.info.endpoint,
      token,
    }));
  }

  // Handle create room request
  private handleCreateRoom(ws: WebSocket, config: RoomConfig, preferredPool?: string): void {
    // Find a pool to create the room on
    let pool: RegisteredPool | undefined;

    if (preferredPool) {
      pool = this.poolRegistry.getPool(preferredPool);
      // Check if pool has capacity
      if (pool && pool.info.currentRooms >= pool.info.maxRooms) {
        pool = undefined;
      }
    }

    if (!pool) {
      pool = this.poolRegistry.getLeastLoadedPool();
    }

    if (!pool) {
      ws.send(serializeHubToClientMessage({
        type: 'hub_error',
        error: 'No available pool servers',
      }));
      return;
    }

    // For now, we just tell the client to connect to the pool and create there
    // The pool will report the room back to us via pool_room_created
    const token = this.generateToken();
    const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

    this.tokenMap.set(token, {
      roomId,
      endpoint: pool.info.endpoint,
      expires: Date.now() + 60000,
    });

    ws.send(serializeHubToClientMessage({
      type: 'hub_room_created',
      roomId,
      endpoint: pool.info.endpoint,
      token,
    }));

    console.log(`[HubServer] Directing room creation to pool ${pool.info.name}`);
  }

  // Handle disconnection
  private handleDisconnect(ws: WebSocket): void {
    const connection = this.connections.get(ws);

    if (connection) {
      if (connection.type === 'pool' && connection.poolId) {
        this.poolRegistry.unregisterPool(connection.poolId);
        console.log(`[HubServer] Pool ${connection.poolId} disconnected`);
      }
      this.connections.delete(ws);
    }
  }

  // Generate a random token
  private generateToken(): string {
    return `token_${Date.now()}_${Math.random().toString(36).substr(2, 16)}`;
  }

  // Clean up expired tokens
  private cleanupExpiredTokens(): void {
    const now = Date.now();
    for (const [token, info] of this.tokenMap) {
      if (info.expires < now) {
        this.tokenMap.delete(token);
      }
    }
  }

  // Validate a join token (called by pool servers)
  validateToken(token: string): { roomId: string; endpoint: string } | null {
    const info = this.tokenMap.get(token);
    if (info && info.expires > Date.now()) {
      this.tokenMap.delete(token);  // One-time use
      return { roomId: info.roomId, endpoint: info.endpoint };
    }
    return null;
  }

  // Get registry for external access
  getPoolRegistry(): PoolRegistry {
    return this.poolRegistry;
  }

  // Get stats
  getStats(): { pools: number; rooms: number; players: number } {
    return {
      pools: this.poolRegistry.getPoolCount(),
      rooms: this.poolRegistry.getAggregatedRooms().length,
      players: this.poolRegistry.getTotalPlayerCount(),
    };
  }
}
