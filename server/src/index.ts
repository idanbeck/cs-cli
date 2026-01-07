// CS-CLI Multiplayer Game Server
// WebSocket server for handling multiplayer game rooms

import { WebSocketServer, WebSocket } from 'ws';
import { RoomManager } from './RoomManager.js';
import { parseClientMessage } from './protocol.js';
import { DEFAULT_SERVER_CONFIG, ServerConfig } from './types.js';

// Server configuration from environment or defaults
const config: ServerConfig = {
  ...DEFAULT_SERVER_CONFIG,
  port: parseInt(process.env.PORT || '8080', 10),
  tickRate: parseInt(process.env.TICK_RATE || '60', 10),
  broadcastRate: parseInt(process.env.BROADCAST_RATE || '20', 10),
  maxRooms: parseInt(process.env.MAX_ROOMS || '100', 10),
  maxPlayersPerRoom: parseInt(process.env.MAX_PLAYERS || '10', 10),
};

// Create room manager
const roomManager = new RoomManager(config);

// Client ID tracking (WebSocket -> clientId)
const socketToClientId = new WeakMap<WebSocket, string>();

// Create WebSocket server
const wss = new WebSocketServer({
  port: config.port,
  perMessageDeflate: false, // Disable compression for lower latency
});

console.log(`
  ╔═══════════════════════════════════════════════════╗
  ║                                                   ║
  ║   CS-CLI Multiplayer Server                       ║
  ║                                                   ║
  ║   Port: ${config.port.toString().padEnd(41)}║
  ║   Tick Rate: ${config.tickRate.toString().padEnd(36)}║
  ║   Broadcast Rate: ${config.broadcastRate.toString().padEnd(31)}║
  ║   Max Rooms: ${config.maxRooms.toString().padEnd(36)}║
  ║   Max Players/Room: ${config.maxPlayersPerRoom.toString().padEnd(28)}║
  ║                                                   ║
  ║   Server is running...                            ║
  ║                                                   ║
  ╚═══════════════════════════════════════════════════╝
`);

// Handle new connections
wss.on('connection', (socket, request) => {
  const clientIp = request.socket.remoteAddress || 'unknown';
  const clientId = roomManager.addClient(socket);
  socketToClientId.set(socket, clientId);

  console.log(`New connection from ${clientIp} (${clientId})`);

  // Handle messages
  socket.on('message', (data) => {
    try {
      const message = parseClientMessage(data.toString());
      if (message) {
        roomManager.handleMessage(clientId, message);
      } else {
        console.warn(`Invalid message from ${clientId}:`, data.toString().substring(0, 100));
      }
    } catch (error) {
      console.error(`Error processing message from ${clientId}:`, error);
    }
  });

  // Handle disconnection
  socket.on('close', (code, reason) => {
    console.log(`Connection closed: ${clientId} (code: ${code})`);
    roomManager.removeClient(clientId);
  });

  // Handle errors
  socket.on('error', (error) => {
    console.error(`Socket error for ${clientId}:`, error.message);
  });

  // Send welcome message (optional)
  socket.send(JSON.stringify({
    type: 'room_list',
    rooms: roomManager.listRooms(),
  }));
});

// Handle server errors
wss.on('error', (error) => {
  console.error('WebSocket server error:', error);
});

// Graceful shutdown
function shutdown() {
  console.log('\nShutting down server...');

  // Close all connections
  wss.clients.forEach((socket) => {
    socket.close(1001, 'Server shutting down');
  });

  // Stop room manager
  roomManager.shutdown();

  // Close server
  wss.close(() => {
    console.log('Server closed');
    process.exit(0);
  });

  // Force exit after 5 seconds
  setTimeout(() => {
    console.log('Force exit');
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Stats logging
setInterval(() => {
  const stats = roomManager.getStats();
  if (stats.clients > 0 || stats.rooms > 0) {
    console.log(`Stats: ${stats.clients} clients, ${stats.rooms} rooms`);
  }
}, 60000); // Log every minute

// Export for testing
export { wss, roomManager, config };
