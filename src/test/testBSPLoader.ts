// Test BSP loading

import { MapLoader } from '../maps/MapLoader.js';
import { MapRegistry } from '../maps/MapRegistry.js';

async function testBSPLoading() {
  console.log('Testing BSP Map Loading...\n');

  // Initialize registry
  MapRegistry.initialize();

  // List available maps
  const maps = MapRegistry.getAvailableMaps();
  console.log(`Available maps: ${maps.length}`);
  for (const map of maps) {
    console.log(`  - ${map.id}: ${map.name} (${map.type})`);
  }
  console.log('');

  // Try loading e1m1 (Quake)
  try {
    console.log('Loading e1m1 (Quake 1)...');
    const e1m1 = await MapRegistry.loadMap('e1m1');
    console.log(`  Name: ${e1m1.name}`);
    console.log(`  Render objects: ${e1m1.renderObjects.length}`);
    console.log(`  Colliders: ${e1m1.colliders.length}`);
    console.log(`  Spawns: ${e1m1.spawns.length}`);
    console.log(`  Bounds: (${e1m1.bounds.min.x.toFixed(1)}, ${e1m1.bounds.min.y.toFixed(1)}, ${e1m1.bounds.min.z.toFixed(1)}) to (${e1m1.bounds.max.x.toFixed(1)}, ${e1m1.bounds.max.y.toFixed(1)}, ${e1m1.bounds.max.z.toFixed(1)})`);

    // Count total triangles
    let totalTris = 0;
    let totalVerts = 0;
    for (const obj of e1m1.renderObjects) {
      totalTris += obj.mesh.triangles.length;
      totalVerts += obj.mesh.vertices.length;
    }
    console.log(`  Total triangles: ${totalTris}`);
    console.log(`  Total vertices: ${totalVerts}`);
    console.log('  SUCCESS!\n');
  } catch (e) {
    console.error('  FAILED:', e);
  }

  // Try loading dm1 (Quake DM)
  try {
    console.log('Loading dm1 (Quake DM)...');
    const dm1 = await MapRegistry.loadMap('dm1');
    console.log(`  Name: ${dm1.name}`);
    console.log(`  Render objects: ${dm1.renderObjects.length}`);
    console.log(`  Spawns: ${dm1.spawns.length}`);

    let totalTris = 0;
    for (const obj of dm1.renderObjects) {
      totalTris += obj.mesh.triangles.length;
    }
    console.log(`  Total triangles: ${totalTris}`);
    console.log('  SUCCESS!\n');
  } catch (e) {
    console.error('  FAILED:', e);
  }

  // Try loading dm_arena (built-in)
  try {
    console.log('Loading dm_arena (built-in)...');
    const arena = await MapRegistry.loadMap('dm_arena');
    console.log(`  Name: ${arena.name}`);
    console.log(`  Render objects: ${arena.renderObjects.length}`);
    console.log(`  Spawns: ${arena.spawns.length}`);
    console.log('  SUCCESS!\n');
  } catch (e) {
    console.error('  FAILED:', e);
  }

  console.log('BSP Loading test complete!');
}

testBSPLoading().catch(console.error);
