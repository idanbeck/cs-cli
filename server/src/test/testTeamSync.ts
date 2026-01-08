#!/usr/bin/env npx ts-node
// Test script to verify team synchronization between players
// Run with: npx ts-node server/src/test/testTeamSync.ts

import { HeadlessClient, delay } from './HeadlessClient.js';

async function testTeamSync() {
  console.log('=== Team Sync Test ===\n');

  // Create two clients
  const host = new HeadlessClient('Host');
  const joiner = new HeadlessClient('Joiner');

  try {
    // Connect host
    console.log('1. Connecting host...');
    await host.connect();
    await delay(100);

    // Host creates room
    console.log('2. Host creating room...');
    host.createRoom({ name: 'Test Room', botCount: 0 });
    await delay(500);

    // Get room ID
    const roomId = host.getRoomId();
    if (!roomId) {
      throw new Error('Host failed to create room');
    }
    console.log(`   Room created: ${roomId}`);
    console.log(`   Host team: ${host.getTeam()}`);

    // Host changes team to T
    console.log('3. Host changing team to T...');
    host.changeTeam('T');
    await delay(200);
    console.log(`   Host team after change: ${host.getTeam()}`);

    // Connect joiner
    console.log('4. Connecting joiner...');
    await joiner.connect();
    await delay(100);

    // Track team changes received by joiner
    let receivedTeamChanges: { playerId: string; team: string }[] = [];
    joiner.setCallbacks({
      onPlayerTeamChanged: (playerId, team) => {
        receivedTeamChanges.push({ playerId, team });
      },
    });

    // Joiner joins the room
    console.log('5. Joiner joining room...');
    joiner.joinRoom(roomId);
    await delay(500);

    // Check what joiner received
    console.log('\n=== Results ===');
    console.log(`Joiner received ${receivedTeamChanges.length} team change messages:`);
    for (const change of receivedTeamChanges) {
      console.log(`  - Player ${change.playerId} -> ${change.team}`);
    }

    // Check if host's team was received
    const hostId = host.getPlayerId();
    const hostTeamReceived = receivedTeamChanges.find(c => c.playerId === hostId);
    if (hostTeamReceived) {
      console.log(`\n✓ SUCCESS: Joiner received host's team (${hostTeamReceived.team})`);
    } else {
      console.log(`\n✗ FAILURE: Joiner did NOT receive host's team`);
      console.log(`  Host ID: ${hostId}`);
      console.log(`  Messages in joiner log: ${joiner.getMessageLog().map(m => m.type).join(', ')}`);
    }

    // Print full message log for debugging
    console.log('\n=== Joiner Message Log ===');
    for (const msg of joiner.getMessageLog()) {
      if (msg.type !== 'game_state') {
        console.log(`  ${msg.type}: ${JSON.stringify(msg).substring(0, 100)}`);
      }
    }

  } catch (error) {
    console.error('Test failed:', error);
  } finally {
    // Cleanup
    host.disconnect();
    joiner.disconnect();
    console.log('\n=== Test Complete ===');
  }
}

// Run the test
testTeamSync().catch(console.error);
