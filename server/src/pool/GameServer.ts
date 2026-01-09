// Game Server - Handles actual game rooms and client connections
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, IncomingMessage, Server as HttpServer } from 'http';
import { RoomManager } from '../RoomManager.js';
import { PoolClient } from './PoolClient.js';
import { parseClientMessage, RoomInfo } from '../protocol.js';
import { ServerConfig, DEFAULT_SERVER_CONFIG } from '../types.js';

export interface GameServerConfig extends ServerConfig {
  serverName: string;
  publicEndpoint: string;  // URL clients use to connect
  hubUrl?: string;         // If set, connect to hub as pool server
}

export class GameServer {
  private config: GameServerConfig;
  private wss: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private roomManager: RoomManager;
  private poolClient: PoolClient | null = null;
  private socketToClientId = new WeakMap<WebSocket, string>();

  constructor(config: Partial<GameServerConfig> = {}) {
    this.config = {
      ...DEFAULT_SERVER_CONFIG,
      serverName: 'CS-CLI Server',
      publicEndpoint: `ws://localhost:${config.port || DEFAULT_SERVER_CONFIG.port}`,
      ...config,
    };
    this.roomManager = new RoomManager(this.config);

    // Set up room event handlers for hub notifications
    this.roomManager.onRoomCreated = (room: RoomInfo) => {
      this.poolClient?.notifyRoomCreated(room);
    };
    this.roomManager.onRoomClosed = (roomId: string) => {
      this.poolClient?.notifyRoomClosed(roomId);
    };
  }

  // Start the game server
  start(): void {
    this.httpServer = createServer();
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
      this.handleConnection(socket, request);
    });

    this.wss.on('error', (error) => {
      console.error('[GameServer] WebSocket server error:', error);
    });

    this.httpServer.listen(this.config.port, () => {
      this.printBanner();
    });

    // Connect to hub if configured
    if (this.config.hubUrl) {
      this.connectToHub();
    }

    // Stats logging
    setInterval(() => {
      const stats = this.roomManager.getStats();
      if (stats.clients > 0 || stats.rooms > 0) {
        console.log(`[GameServer] Stats: ${stats.clients} clients, ${stats.rooms} rooms`);
      }
    }, 60000);
  }

  // Stop the game server
  stop(): void {
    console.log('[GameServer] Shutting down...');

    // Disconnect from hub
    this.poolClient?.disconnect();

    // Close all client connections
    if (this.wss) {
      this.wss.clients.forEach((socket) => {
        socket.close(1001, 'Server shutting down');
      });
      this.wss.close();
      this.wss = null;
    }

    // Stop room manager
    this.roomManager.shutdown();

    // Close HTTP server
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
  }

  // Handle new client connection
  private handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const clientIp = request.socket.remoteAddress || 'unknown';
    const clientId = this.roomManager.addClient(socket);
    this.socketToClientId.set(socket, clientId);

    console.log(`[GameServer] New connection from ${clientIp} (${clientId})`);

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      try {
        // Check for binary voice frames (first byte 0x01)
        if (isBinary || (data.length > 0 && data[0] === 0x01)) {
          // Route to room's binary handler
          this.roomManager.handleBinaryData(clientId, data);
          return;
        }

        const message = parseClientMessage(data.toString());
        if (message) {
          this.roomManager.handleMessage(clientId, message);
        } else {
          console.warn(`[GameServer] Invalid message from ${clientId}`);
        }
      } catch (error) {
        console.error(`[GameServer] Error processing message from ${clientId}:`, error);
      }
    });

    socket.on('close', (code) => {
      console.log(`[GameServer] Connection closed: ${clientId} (code: ${code})`);
      this.roomManager.removeClient(clientId);
    });

    socket.on('error', (error) => {
      console.error(`[GameServer] Socket error for ${clientId}:`, error.message);
    });

    // Send initial room list
    socket.send(JSON.stringify({
      type: 'room_list',
      rooms: this.roomManager.listRooms(),
    }));
  }

  // Connect to hub as a pool server
  private connectToHub(): void {
    if (!this.config.hubUrl) return;

    console.log(`[GameServer] Connecting to hub at ${this.config.hubUrl}`);

    this.poolClient = new PoolClient({
      hubUrl: this.config.hubUrl,
      serverName: this.config.serverName,
      endpoint: this.config.publicEndpoint,
      maxRooms: this.config.maxRooms,
    }, {
      onStatusChange: (status) => {
        console.log(`[GameServer] Hub connection status: ${status}`);
      },
      onRegistered: (poolId) => {
        console.log(`[GameServer] Registered with hub as ${poolId}`);
      },
      onRejected: (reason) => {
        console.error(`[GameServer] Hub rejected registration: ${reason}`);
      },
      onError: (error) => {
        console.error(`[GameServer] Hub connection error:`, error.message);
      },
    });

    // Set up state callbacks
    this.poolClient.setStateCallbacks(
      () => this.roomManager.listRooms(),
      () => this.roomManager.getStats().clients,
      () => this.calculateLoad()
    );

    this.poolClient.connect();
  }

  // Calculate server load (0-100)
  private calculateLoad(): number {
    const stats = this.roomManager.getStats();
    const roomLoad = (stats.rooms / this.config.maxRooms) * 100;
    return Math.min(100, Math.round(roomLoad));
  }

  // Get room manager for external access
  getRoomManager(): RoomManager {
    return this.roomManager;
  }

  // Get stats
  getStats(): { clients: number; rooms: number; hubConnected: boolean } {
    const stats = this.roomManager.getStats();
    return {
      ...stats,
      hubConnected: this.poolClient?.isRegistered() ?? false,
    };
  }

  // Check if connected to hub
  isHubConnected(): boolean {
    return this.poolClient?.isRegistered() ?? false;
  }

  // Print startup banner
  private printBanner(): void {
    const hubStatus = this.config.hubUrl ? `Connecting to ${this.config.hubUrl}` : 'Standalone';

    console.log(`
  ╔═══════════════════════════════════════════════════╗
  ║                                                   ║
  ║   CS-CLI Game Server                              ║
  ║                                                   ║
  ║   Name: ${this.config.serverName.padEnd(40)}║
  ║   Port: ${this.config.port.toString().padEnd(40)}║
  ║   Endpoint: ${this.config.publicEndpoint.substring(0, 36).padEnd(36)}║
  ║   Max Rooms: ${this.config.maxRooms.toString().padEnd(36)}║
  ║   Hub: ${hubStatus.substring(0, 41).padEnd(41)}║
  ║                                                   ║
  ║   Server is running...                            ║
  ║                                                   ║
  ╚═══════════════════════════════════════════════════╝
`);
  }
}
