// CS-CLI Multiplayer Server
// Supports multiple startup modes:
//   Default: Hub + built-in pool server (standalone)
//   --hub-only: Hub only (no games, just routing)
//   --pool --hub=URL: Pool server that connects to external hub

import { HubServer } from './hub/HubServer.js';
import { GameServer } from './pool/GameServer.js';
import { DEFAULT_SERVER_CONFIG } from './types.js';

// Parse command line arguments
function parseArgs(): {
  mode: 'standalone' | 'hub-only' | 'pool';
  hubUrl?: string;
  serverName: string;
  port: number;
  hubPort: number;
  maxRooms: number;
} {
  const args = process.argv.slice(2);
  const parsed: ReturnType<typeof parseArgs> = {
    mode: 'standalone',
    serverName: 'CS-CLI Server',
    port: parseInt(process.env.PORT || '8080', 10),
    hubPort: parseInt(process.env.HUB_PORT || '8081', 10),
    maxRooms: parseInt(process.env.MAX_ROOMS || '100', 10),
  };

  for (const arg of args) {
    if (arg === '--hub-only') {
      parsed.mode = 'hub-only';
    } else if (arg === '--pool') {
      parsed.mode = 'pool';
    } else if (arg.startsWith('--hub=')) {
      parsed.hubUrl = arg.substring(6);
    } else if (arg.startsWith('--name=')) {
      parsed.serverName = arg.substring(7);
    } else if (arg.startsWith('--port=')) {
      parsed.port = parseInt(arg.substring(7), 10);
    } else if (arg.startsWith('--hub-port=')) {
      parsed.hubPort = parseInt(arg.substring(11), 10);
    } else if (arg.startsWith('--max-rooms=')) {
      parsed.maxRooms = parseInt(arg.substring(12), 10);
    }
  }

  // Pool mode requires hub URL
  if (parsed.mode === 'pool' && !parsed.hubUrl) {
    console.error('Error: Pool mode requires --hub=URL');
    process.exit(1);
  }

  return parsed;
}

const config = parseArgs();

// Track servers for shutdown
let hubServer: HubServer | null = null;
let gameServer: GameServer | null = null;

// Start based on mode
switch (config.mode) {
  case 'standalone':
    // Run hub + built-in pool server
    console.log(`
  ╔═══════════════════════════════════════════════════╗
  ║                                                   ║
  ║   CS-CLI Server (Standalone Mode)                 ║
  ║                                                   ║
  ║   Hub Port: ${config.hubPort.toString().padEnd(37)}║
  ║   Game Port: ${config.port.toString().padEnd(36)}║
  ║   Max Rooms: ${config.maxRooms.toString().padEnd(36)}║
  ║                                                   ║
  ╚═══════════════════════════════════════════════════╝
`);

    // Start hub server
    hubServer = new HubServer({
      port: config.hubPort,
    });
    hubServer.start();

    // Start built-in game server that connects to hub
    gameServer = new GameServer({
      ...DEFAULT_SERVER_CONFIG,
      port: config.port,
      maxRooms: config.maxRooms,
      serverName: config.serverName,
      publicEndpoint: `ws://localhost:${config.port}`,
      hubUrl: `ws://localhost:${config.hubPort}`,
    });
    gameServer.start();
    break;

  case 'hub-only':
    // Run only the hub server
    console.log(`
  ╔═══════════════════════════════════════════════════╗
  ║                                                   ║
  ║   CS-CLI Hub Server (Hub-Only Mode)               ║
  ║                                                   ║
  ║   Port: ${config.hubPort.toString().padEnd(41)}║
  ║                                                   ║
  ║   Waiting for pool servers to connect...          ║
  ║                                                   ║
  ╚═══════════════════════════════════════════════════╝
`);

    hubServer = new HubServer({
      port: config.hubPort,
    });
    hubServer.start();
    break;

  case 'pool':
    // Run game server that connects to external hub
    console.log(`
  ╔═══════════════════════════════════════════════════╗
  ║                                                   ║
  ║   CS-CLI Pool Server                              ║
  ║                                                   ║
  ║   Name: ${config.serverName.substring(0, 40).padEnd(40)}║
  ║   Port: ${config.port.toString().padEnd(41)}║
  ║   Hub: ${config.hubUrl!.substring(0, 42).padEnd(42)}║
  ║   Max Rooms: ${config.maxRooms.toString().padEnd(36)}║
  ║                                                   ║
  ╚═══════════════════════════════════════════════════╝
`);

    gameServer = new GameServer({
      ...DEFAULT_SERVER_CONFIG,
      port: config.port,
      maxRooms: config.maxRooms,
      serverName: config.serverName,
      publicEndpoint: `ws://localhost:${config.port}`,
      hubUrl: config.hubUrl,
    });
    gameServer.start();
    break;
}

// Graceful shutdown
function shutdown() {
  console.log('\nShutting down server...');

  if (gameServer) {
    gameServer.stop();
  }

  if (hubServer) {
    hubServer.stop();
  }

  // Force exit after 5 seconds
  setTimeout(() => {
    console.log('Force exit');
    process.exit(1);
  }, 5000);

  setTimeout(() => {
    console.log('Server closed');
    process.exit(0);
  }, 1000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Stats logging
setInterval(() => {
  if (hubServer) {
    const stats = hubServer.getStats();
    if (stats.pools > 0 || stats.rooms > 0 || stats.players > 0) {
      console.log(`[Hub] ${stats.pools} pools, ${stats.rooms} rooms, ${stats.players} players`);
    }
  }
  if (gameServer) {
    const stats = gameServer.getStats();
    if (stats.clients > 0 || stats.rooms > 0) {
      console.log(`[Game] ${stats.clients} clients, ${stats.rooms} rooms, hub: ${stats.hubConnected}`);
    }
  }
}, 60000);

// Export for testing
export { hubServer, gameServer, config };
