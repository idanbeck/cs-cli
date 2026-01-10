// Room lifecycle management for CS-CLI multiplayer server

import { v4 as uuidv4 } from 'uuid';
import { WebSocket } from 'ws';
import { Room } from './Room.js';
import {
  RoomConfig,
  RoomInfo,
  ClientMessage,
  ServerMessage,
  serializeServerMessage,
} from './protocol.js';
import { ConnectedClient, ServerConfig, DEFAULT_SERVER_CONFIG } from './types.js';

export class RoomManager {
  private rooms: Map<string, Room> = new Map();
  private clients: Map<string, ConnectedClient> = new Map();
  private config: ServerConfig;

  // Cleanup interval
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  // Event callbacks (for hub notification)
  onRoomCreated?: (room: RoomInfo) => void;
  onRoomClosed?: (roomId: string) => void;

  constructor(config: Partial<ServerConfig> = {}) {
    this.config = { ...DEFAULT_SERVER_CONFIG, ...config };

    // Start cleanup interval (every 30 seconds)
    this.cleanupInterval = setInterval(() => this.cleanup(), 30000);
  }

  // ============ Client Management ============

  addClient(socket: WebSocket): string {
    const clientId = uuidv4();
    const client: ConnectedClient = {
      id: clientId,
      socket,
      name: null,
      roomId: null,
      isReady: false,
      lastActivity: Date.now(),
      pendingInputs: [],
    };
    this.clients.set(clientId, client);

    console.log(`Client connected: ${clientId}`);
    return clientId;
  }

  removeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Leave room if in one
    if (client.roomId) {
      this.leaveRoom(clientId);
    }

    this.clients.delete(clientId);
    console.log(`Client disconnected: ${clientId}`);
  }

  getClient(clientId: string): ConnectedClient | undefined {
    return this.clients.get(clientId);
  }

  // ============ Room Management ============

  createRoom(clientId: string, config: RoomConfig): string | null {
    const client = this.clients.get(clientId);
    if (!client) return null;

    // Check room limit
    if (this.rooms.size >= this.config.maxRooms) {
      this.sendToClient(clientId, {
        type: 'room_error',
        error: 'Server is full. Cannot create more rooms.',
      });
      return null;
    }

    // Validate config
    if (config.maxPlayers > this.config.maxPlayersPerRoom) {
      config.maxPlayers = this.config.maxPlayersPerRoom;
    }
    if (config.maxPlayers < 1) config.maxPlayers = 1;
    if (config.botCount < 0) config.botCount = 0;
    if (config.botCount > 8) config.botCount = 8;

    const roomId = uuidv4().substring(0, 8);
    const room = new Room(roomId, config, clientId, this.config);
    this.rooms.set(roomId, room);

    console.log(`Room created: ${roomId} by ${clientId} (${config.name})`);

    // Notify hub if callback is set
    this.onRoomCreated?.(room.getInfo());

    // Auto-join the creator
    this.joinRoom(clientId, roomId, client.name || 'Host');

    return roomId;
  }

  joinRoom(
    clientId: string,
    roomId: string,
    playerName: string,
    password?: string
  ): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;

    // Leave current room first
    if (client.roomId) {
      this.leaveRoom(clientId);
    }

    const room = this.rooms.get(roomId);
    if (!room) {
      this.sendToClient(clientId, {
        type: 'room_error',
        error: 'Room not found.',
      });
      return false;
    }

    // Check password
    if (room.config.password && room.config.password !== password) {
      this.sendToClient(clientId, {
        type: 'room_error',
        error: 'Incorrect password.',
      });
      return false;
    }

    // Check capacity
    if (room.getPlayerCount() >= room.config.maxPlayers) {
      this.sendToClient(clientId, {
        type: 'room_error',
        error: 'Room is full.',
      });
      return false;
    }

    // Join the room
    client.name = playerName;
    client.roomId = roomId;
    client.isReady = false;

    // IMPORTANT: Send join confirmation BEFORE addPlayer
    // addPlayer sends existing player info, and client resets lobby on room_joined
    // So room_joined must come first, otherwise existing players get cleared
    this.sendToClient(clientId, {
      type: 'room_joined',
      roomId,
      playerId: clientId,
      room: room.getInfo(),
    });

    // Now add player - this sends existing player info to new joiner
    room.addPlayer(clientId, client);

    // Notify other players (this is also done in room.addPlayer, so remove duplicate)
    // Note: room.addPlayer already broadcasts to other clients

    console.log(`${playerName} (${clientId}) joined room ${roomId}`);
    return true;
  }

  leaveRoom(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client || !client.roomId) return;

    const room = this.rooms.get(client.roomId);
    if (room) {
      const playerName = client.name || 'Unknown';
      room.removePlayer(clientId);

      // Notify remaining players
      room.broadcast({
        type: 'player_left',
        playerId: clientId,
        playerName,
      });

      console.log(`${playerName} (${clientId}) left room ${room.id}`);

      // Remove room if empty
      if (room.getPlayerCount() === 0) {
        this.removeRoom(room.id);
      }
    }

    client.roomId = null;
    client.isReady = false;
  }

  removeRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.stop();
    this.rooms.delete(roomId);
    console.log(`Room removed: ${roomId}`);

    // Notify hub if callback is set
    this.onRoomClosed?.(roomId);
  }

  listRooms(): RoomInfo[] {
    const rooms: RoomInfo[] = [];
    for (const room of this.rooms.values()) {
      // Don't list private rooms
      if (!room.config.isPrivate) {
        rooms.push(room.getInfo());
      }
    }
    return rooms;
  }

  // ============ Message Handling ============

  handleMessage(clientId: string, message: ClientMessage): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    client.lastActivity = Date.now();

    switch (message.type) {
      case 'list_rooms':
        this.sendToClient(clientId, {
          type: 'room_list',
          rooms: this.listRooms(),
        });
        break;

      case 'create_room':
        this.createRoom(clientId, message.config);
        break;

      case 'join_room':
        this.joinRoom(
          clientId,
          message.roomId,
          message.playerName,
          message.password
        );
        break;

      case 'leave_room':
        this.leaveRoom(clientId);
        break;

      default:
        // Forward game messages to the room
        if (client.roomId) {
          const room = this.rooms.get(client.roomId);
          if (room) {
            room.handleMessage(clientId, message);
          }
        }
        break;
    }
  }

  // ============ Binary Data (Voice) ============

  handleBinaryData(clientId: string, data: Buffer): void {
    const client = this.clients.get(clientId);
    if (!client || !client.roomId) return;

    const room = this.rooms.get(client.roomId);
    if (room) {
      room.handleBinaryData(clientId, data);
    }
  }

  // ============ Utility ============

  sendToClient(clientId: string, message: ServerMessage): void {
    const client = this.clients.get(clientId);
    if (!client || client.socket.readyState !== WebSocket.OPEN) return;

    try {
      client.socket.send(serializeServerMessage(message));
    } catch (e) {
      console.error(`Failed to send to client ${clientId}:`, e);
    }
  }

  cleanup(): void {
    const now = Date.now();

    // Remove idle rooms
    for (const [roomId, room] of this.rooms) {
      if (room.getPlayerCount() === 0) {
        const idleTime = now - room.lastActivity;
        if (idleTime > this.config.roomIdleTimeout) {
          this.removeRoom(roomId);
        }
      }
    }

    // Note: Client cleanup handled by WebSocket close events
  }

  shutdown(): void {
    // Stop cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Stop all rooms
    for (const room of this.rooms.values()) {
      room.stop();
    }
    this.rooms.clear();

    // Close all client connections
    for (const client of this.clients.values()) {
      try {
        client.socket.close(1001, 'Server shutting down');
      } catch (e) {
        // Ignore close errors
      }
    }
    this.clients.clear();

    console.log('RoomManager shutdown complete');
  }

  // ============ Stats ============

  getStats(): { rooms: number; clients: number } {
    return {
      rooms: this.rooms.size,
      clients: this.clients.size,
    };
  }
}
