/**
 * VoiceRelay - Server-side voice frame relay
 *
 * Relays binary voice frames between clients in a room.
 * Handles team filtering and position tracking for spatial audio.
 */

import { WebSocket } from 'ws';
import { TeamId } from './protocol.js';
import { ConnectedClient } from './types.js';

// Voice protocol constants (matching client)
const VOICE_FRAME_TYPE = 0x01;
const VOICE_FLAG_TEAM_ONLY = 0x02;

/**
 * Extract sender ID from voice frame (bytes 2-5)
 */
function getSenderIdFromFrame(data: Uint8Array): number {
  if (data.length < 6) return 0;
  return data[2] | (data[3] << 8) | (data[4] << 16) | (data[5] << 24);
}

/**
 * Get flags from voice frame (byte 1)
 */
function getFrameFlags(data: Uint8Array): number {
  if (data.length < 2) return 0;
  return data[1];
}

/**
 * Check if data is a voice frame
 */
export function isVoiceFrame(data: Buffer | ArrayBuffer | Uint8Array): boolean {
  if (data instanceof ArrayBuffer) {
    data = new Uint8Array(data);
  } else if (Buffer.isBuffer(data)) {
    data = new Uint8Array(data.buffer, data.byteOffset, data.length);
  }
  return data.length >= 1 && data[0] === VOICE_FRAME_TYPE;
}

/**
 * Voice position tracking for a player
 */
interface VoicePosition {
  x: number;
  y: number;
  z: number;
  lastUpdate: number;
}

/**
 * Voice relay state for a room
 */
export class VoiceRelay {
  private positions: Map<string, VoicePosition> = new Map();
  private senderIdToPlayerId: Map<number, string> = new Map();
  private playerIdToSenderId: Map<string, number> = new Map();

  /**
   * Register a player's sender ID
   */
  registerPlayer(playerId: string, senderId: number): void {
    this.senderIdToPlayerId.set(senderId, playerId);
    this.playerIdToSenderId.set(playerId, senderId);
  }

  /**
   * Unregister a player
   */
  unregisterPlayer(playerId: string): void {
    const senderId = this.playerIdToSenderId.get(playerId);
    if (senderId !== undefined) {
      this.senderIdToPlayerId.delete(senderId);
    }
    this.playerIdToSenderId.delete(playerId);
    this.positions.delete(playerId);
  }

  /**
   * Update a player's position (for spatial audio)
   */
  updatePosition(playerId: string, x: number, y: number, z: number): void {
    this.positions.set(playerId, {
      x, y, z,
      lastUpdate: Date.now(),
    });
  }

  /**
   * Get player ID from sender ID
   */
  getPlayerId(senderId: number): string | undefined {
    return this.senderIdToPlayerId.get(senderId);
  }

  // Track relay stats
  private relayCount = 0;

  /**
   * Relay a voice frame to room members
   *
   * @param data Binary voice frame
   * @param senderClientId Client ID of sender
   * @param clients Map of all clients in room
   * @param teamAssignments Map of client ID to team
   */
  relayVoiceFrame(
    data: Uint8Array,
    senderClientId: string,
    clients: Map<string, ConnectedClient>,
    teamAssignments: Map<string, TeamId>
  ): void {
    const flags = getFrameFlags(data);
    const teamOnly = (flags & VOICE_FLAG_TEAM_ONLY) !== 0;
    const senderTeam = teamAssignments.get(senderClientId);
    const senderId = getSenderIdFromFrame(data);

    // Log relay periodically
    this.relayCount++;
    if (this.relayCount % 50 === 0) {
      console.log(`[VoiceRelay] Relaying frame from ${senderId.toString(16)} to ${clients.size - 1} clients`);
    }

    // Relay to all other clients (optionally filtered by team)
    let relayedTo = 0;
    for (const [clientId, client] of clients) {
      // Don't send back to sender
      if (clientId === senderClientId) continue;

      // Check team filter
      if (teamOnly && senderTeam) {
        const clientTeam = teamAssignments.get(clientId);
        if (clientTeam !== senderTeam) continue;
      }

      // Send binary frame
      if (client.socket.readyState === WebSocket.OPEN) {
        try {
          client.socket.send(data);
          relayedTo++;
        } catch {
          // Ignore send errors
        }
      }
    }
  }

  /**
   * Cleanup old positions
   */
  cleanup(maxAgeMs: number = 10000): void {
    const now = Date.now();
    for (const [playerId, pos] of this.positions) {
      if (now - pos.lastUpdate > maxAgeMs) {
        this.positions.delete(playerId);
      }
    }
  }

  /**
   * Clear all state
   */
  clear(): void {
    this.positions.clear();
    this.senderIdToPlayerId.clear();
    this.playerIdToSenderId.clear();
  }
}

// Room voice relays
const roomRelays: Map<string, VoiceRelay> = new Map();

/**
 * Get or create voice relay for a room
 */
export function getVoiceRelay(roomId: string): VoiceRelay {
  let relay = roomRelays.get(roomId);
  if (!relay) {
    relay = new VoiceRelay();
    roomRelays.set(roomId, relay);
  }
  return relay;
}

/**
 * Remove voice relay for a room
 */
export function removeVoiceRelay(roomId: string): void {
  const relay = roomRelays.get(roomId);
  if (relay) {
    relay.clear();
    roomRelays.delete(roomId);
  }
}
