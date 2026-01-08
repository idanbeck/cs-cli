// Pool Client - Connects a game server to the central hub
import WebSocket from 'ws';
import {
  RoomInfo,
  serializePoolToHubMessage,
  HubToPoolMessage,
} from '../protocol.js';

export interface PoolClientConfig {
  hubUrl: string;
  serverName: string;
  endpoint: string;      // Public endpoint clients use to connect to this pool
  maxRooms: number;
  reconnectInterval?: number;
  heartbeatInterval?: number;
}

export type PoolClientStatus = 'disconnected' | 'connecting' | 'connected' | 'registered';

export interface PoolClientEvents {
  onStatusChange?: (status: PoolClientStatus) => void;
  onRegistered?: (poolId: string) => void;
  onRejected?: (reason: string) => void;
  onError?: (error: Error) => void;
}

export class PoolClient {
  private config: PoolClientConfig;
  private events: PoolClientEvents;
  private ws: WebSocket | null = null;
  private status: PoolClientStatus = 'disconnected';
  private poolId: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private getRoomsCallback: (() => RoomInfo[]) | null = null;
  private getPlayerCountCallback: (() => number) | null = null;
  private getLoadCallback: (() => number) | null = null;

  constructor(config: PoolClientConfig, events: PoolClientEvents = {}) {
    this.config = {
      reconnectInterval: 5000,
      heartbeatInterval: 10000,
      ...config,
    };
    this.events = events;
  }

  // Set callbacks for getting current state
  setStateCallbacks(
    getRooms: () => RoomInfo[],
    getPlayerCount: () => number,
    getLoad: () => number
  ): void {
    this.getRoomsCallback = getRooms;
    this.getPlayerCountCallback = getPlayerCount;
    this.getLoadCallback = getLoad;
  }

  // Connect to the hub
  connect(): void {
    if (this.ws) {
      this.ws.close();
    }

    this.setStatus('connecting');
    console.log(`[PoolClient] Connecting to hub at ${this.config.hubUrl}`);

    this.ws = new WebSocket(this.config.hubUrl);

    this.ws.on('open', () => {
      this.handleOpen();
    });

    this.ws.on('message', (data: Buffer) => {
      this.handleMessage(data.toString());
    });

    this.ws.on('close', () => {
      this.handleClose();
    });

    this.ws.on('error', (error) => {
      this.handleError(error);
    });
  }

  // Disconnect from the hub
  disconnect(): void {
    this.stopHeartbeat();
    this.stopReconnect();

    if (this.ws) {
      // Send unregister message
      if (this.status === 'registered') {
        this.send({ type: 'pool_unregister' });
      }
      this.ws.close();
      this.ws = null;
    }

    this.poolId = null;
    this.setStatus('disconnected');
  }

  // Notify hub of a new room
  notifyRoomCreated(room: RoomInfo): void {
    if (this.status === 'registered') {
      this.send({
        type: 'pool_room_created',
        room,
      });
    }
  }

  // Notify hub of a closed room
  notifyRoomClosed(roomId: string): void {
    if (this.status === 'registered') {
      this.send({
        type: 'pool_room_closed',
        roomId,
      });
    }
  }

  // Get current status
  getStatus(): PoolClientStatus {
    return this.status;
  }

  // Get assigned pool ID
  getPoolId(): string | null {
    return this.poolId;
  }

  // Check if connected and registered
  isRegistered(): boolean {
    return this.status === 'registered';
  }

  // Handle WebSocket open
  private handleOpen(): void {
    console.log(`[PoolClient] Connected to hub, registering...`);
    this.setStatus('connected');

    // Send registration
    this.send({
      type: 'pool_register',
      serverName: this.config.serverName,
      endpoint: this.config.endpoint,
      maxRooms: this.config.maxRooms,
    });
  }

  // Handle incoming message
  private handleMessage(data: string): void {
    try {
      const msg = JSON.parse(data) as HubToPoolMessage;

      switch (msg.type) {
        case 'pool_accepted':
          this.poolId = msg.poolId;
          this.setStatus('registered');
          this.startHeartbeat();
          console.log(`[PoolClient] Registered with hub as ${msg.poolId}`);
          this.events.onRegistered?.(msg.poolId);
          break;

        case 'pool_rejected':
          console.error(`[PoolClient] Registration rejected: ${msg.reason}`);
          this.events.onRejected?.(msg.reason);
          this.ws?.close();
          break;

        case 'pool_ping':
          // Hub is checking if we're alive - respond with heartbeat
          this.sendHeartbeat();
          break;
      }
    } catch (error) {
      console.error(`[PoolClient] Error parsing message:`, error);
    }
  }

  // Handle WebSocket close
  private handleClose(): void {
    console.log(`[PoolClient] Disconnected from hub`);
    this.stopHeartbeat();
    this.ws = null;
    this.poolId = null;

    if (this.status !== 'disconnected') {
      this.setStatus('disconnected');
      this.scheduleReconnect();
    }
  }

  // Handle WebSocket error
  private handleError(error: Error): void {
    console.error(`[PoolClient] WebSocket error:`, error.message);
    this.events.onError?.(error);
  }

  // Send a message to the hub
  private send(msg: { type: string; [key: string]: unknown }): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(serializePoolToHubMessage(msg as any));
    }
  }

  // Start heartbeat timer
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, this.config.heartbeatInterval!);
  }

  // Stop heartbeat timer
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // Send heartbeat with current state
  private sendHeartbeat(): void {
    const rooms = this.getRoomsCallback?.() ?? [];
    const playerCount = this.getPlayerCountCallback?.() ?? 0;
    const load = this.getLoadCallback?.() ?? 0;

    this.send({
      type: 'pool_heartbeat',
      rooms,
      playerCount,
      load,
    });
  }

  // Schedule reconnection
  private scheduleReconnect(): void {
    this.stopReconnect();
    console.log(`[PoolClient] Reconnecting in ${this.config.reconnectInterval}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.config.reconnectInterval!);
  }

  // Stop reconnection timer
  private stopReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // Update status and notify
  private setStatus(status: PoolClientStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.events.onStatusChange?.(status);
    }
  }
}
