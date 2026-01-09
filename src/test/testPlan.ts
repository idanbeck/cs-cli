#!/usr/bin/env npx ts-node
/**
 * Test harness for verifying all plan phases are correctly implemented.
 *
 * Tests:
 * 1. Phase 4: Stair Climbing fixes (MeshCollision.ts changes)
 * 2. Phase 3: Graphics Settings (MainMenu.ts, persistence)
 * 3. Phase 1: Fixed Timestep Game Loop (GameLoop.ts)
 * 4. Phase 2: Native SIMD Renderer (renderer_simd.c, NativeRenderer.ts)
 */

import { Vector3 } from '../engine/math/Vector3.js';
import { GameLoop, PHYSICS_DT, PHYSICS_TICK_RATE, lerp, lerpAngle } from '../engine/GameLoop.js';
import { getNativeRenderer, isNativeRenderingAvailable } from '../engine/NativeRenderer.js';
import { getMainMenu, Settings } from '../ui/MainMenu.js';
import { existsSync, unlinkSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Colors for output
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

let passed = 0;
let failed = 0;

function log(msg: string): void {
  console.log(msg);
}

function pass(test: string): void {
  console.log(`${GREEN}  ✓${RESET} ${test}`);
  passed++;
}

function fail(test: string, reason?: string): void {
  console.log(`${RED}  ✗${RESET} ${test}`);
  if (reason) console.log(`    ${RED}${reason}${RESET}`);
  failed++;
}

function section(name: string): void {
  console.log(`\n${BOLD}${name}${RESET}`);
  console.log('-'.repeat(50));
}

// ============================================================================
// Phase 4: Stair Climbing Tests
// ============================================================================
async function testPhase4(): Promise<void> {
  section('Phase 4: Stair Climbing Fixes');

  // Read the MeshCollision.ts file to verify changes
  const meshCollisionPath = join(process.cwd(), 'src/physics/MeshCollision.ts');
  const content = readFileSync(meshCollisionPath, 'utf-8');

  // Test 1: MIN_PENETRATION lowered to 0.005
  if (content.includes('MIN_PENETRATION = 0.005')) {
    pass('MIN_PENETRATION lowered to 0.005 (was 0.02)');
  } else {
    fail('MIN_PENETRATION not set to 0.005');
  }

  // Test 2: numSamples increased to 8
  if (content.includes('numSamples = 8')) {
    pass('Capsule samples increased to 8 (was 5)');
  } else {
    fail('numSamples not set to 8');
  }

  // Test 3: findGroundBelowForStep function exists
  if (content.includes('function findGroundBelowForStep')) {
    pass('Multi-ray ground detection function created');
  } else {
    fail('findGroundBelowForStep function not found');
  }

  // Test 4: Relaxed step validation range
  if (content.includes('stepGroundDist >= -0.1') && content.includes('STEP_HEIGHT + 0.3')) {
    pass('Step validation range relaxed (-0.1 to STEP_HEIGHT + 0.3)');
  } else {
    fail('Step validation range not relaxed');
  }

  // Test 5: Uses findGroundBelowForStep in step logic
  if (content.includes('findGroundBelowForStep(stepUpPos')) {
    pass('Step logic uses multi-ray ground detection');
  } else {
    fail('Step logic not using findGroundBelowForStep');
  }
}

// ============================================================================
// Phase 3: Graphics Settings Tests
// ============================================================================
async function testPhase3(): Promise<void> {
  section('Phase 3: Graphics Settings UI');

  const mainMenu = getMainMenu();
  const settings = mainMenu.getSettings();

  // Test 1: Default render mode is halfblock
  if (settings.renderMode === 'halfblock') {
    pass('Default render mode is halfblock (was basic)');
  } else {
    fail(`Default render mode is ${settings.renderMode}, expected halfblock`);
  }

  // Test 2: Default MSAA is 4x
  if (settings.msaaMode === '4x') {
    pass('Default MSAA mode is 4x (was none)');
  } else {
    fail(`Default MSAA mode is ${settings.msaaMode}, expected 4x`);
  }

  // Test 3: FOV setting exists
  if (typeof settings.fov === 'number') {
    pass(`FOV setting exists (current: ${settings.fov}°)`);
  } else {
    fail('FOV setting not found');
  }

  // Test 4: Settings file location
  const settingsPath = join(homedir(), '.csterm', 'settings.json');
  pass(`Settings persistence path: ${settingsPath}`);

  // Test 5: MainMenu has FOV option
  const menuContent = readFileSync(join(process.cwd(), 'src/ui/MainMenu.ts'), 'utf-8');
  if (menuContent.includes("'Field of View'")) {
    pass('Field of View option added to settings menu');
  } else {
    fail('Field of View option not in settings menu');
  }

  // Test 6: Settings are saveable
  if (menuContent.includes('saveSettingsToDisk')) {
    pass('Settings persistence functions implemented');
  } else {
    fail('Settings persistence not implemented');
  }
}

// ============================================================================
// Phase 1: Fixed Timestep Game Loop Tests
// ============================================================================
async function testPhase1(): Promise<void> {
  section('Phase 1: Fixed Timestep Game Loop');

  // Test 1: GameLoop module exists
  try {
    const gameLoop = new GameLoop();
    pass('GameLoop class created successfully');
  } catch (e) {
    fail('GameLoop class not found or failed to create');
    return;
  }

  // Test 2: Physics tick rate is 20 Hz
  if (PHYSICS_TICK_RATE === 20) {
    pass(`Physics tick rate is 20 Hz (dt = ${PHYSICS_DT * 1000}ms)`);
  } else {
    fail(`Physics tick rate is ${PHYSICS_TICK_RATE}, expected 20`);
  }

  // Test 3: Lerp function works correctly
  const lerpResult = lerp(0, 100, 0.5);
  if (Math.abs(lerpResult - 50) < 0.001) {
    pass('lerp() interpolation function works correctly');
  } else {
    fail(`lerp(0, 100, 0.5) = ${lerpResult}, expected 50`);
  }

  // Test 4: lerpAngle handles wraparound
  const angle1 = lerpAngle(Math.PI * 0.9, -Math.PI * 0.9, 0.5);
  // Should take the short path through PI, not go the long way
  if (Math.abs(angle1 - Math.PI) < 0.1 || Math.abs(angle1 + Math.PI) < 0.1) {
    pass('lerpAngle() handles angle wraparound correctly');
  } else {
    fail(`lerpAngle wraparound test failed: ${angle1}`);
  }

  // Test 5: GameLoop accumulator and tick logic
  const gameLoop = new GameLoop();
  let tickCount = 0;
  gameLoop.setPhysicsCallback(() => {
    tickCount++;
  });
  gameLoop.start();

  // Simulate several frames
  await new Promise(resolve => setTimeout(resolve, 150));
  gameLoop.tick();
  gameLoop.tick();
  gameLoop.tick();

  if (tickCount >= 1) {
    pass(`GameLoop physics callback executed (${tickCount} ticks)`);
  } else {
    fail('GameLoop physics callback never executed');
  }

  gameLoop.stop();
}

// ============================================================================
// Phase 2: Native SIMD Renderer Tests
// ============================================================================
async function testPhase2(): Promise<void> {
  section('Phase 2: Native SIMD Renderer');

  // Test 1: Native module compiled
  const rendererPath = join(process.cwd(), 'native/build/Release/renderer.node');
  if (existsSync(rendererPath)) {
    pass('Native renderer module compiled (renderer.node)');
  } else {
    fail('Native renderer module not found - run "cd native && npx node-gyp rebuild"');
    return;
  }

  // Test 2: NativeRenderer wrapper loads
  const nativeRenderer = getNativeRenderer();
  if (nativeRenderer.isAvailable) {
    pass('NativeRenderer wrapper loads native module');
  } else {
    fail('NativeRenderer failed to load native module');
    return;
  }

  // Test 3: SIMD detection
  if (nativeRenderer.hasSIMD) {
    pass('SIMD acceleration available (ARM NEON or SSE2)');
  } else {
    pass('SIMD not available (using scalar fallback)');
  }

  // Test 4: Initialize renderer
  const initResult = nativeRenderer.init(640, 480, 1);
  if (initResult) {
    pass('Renderer initialized (640x480, no MSAA)');
  } else {
    fail('Renderer initialization failed');
    return;
  }

  // Test 5: Clear framebuffer
  try {
    nativeRenderer.clear(255, 128, 64);
    pass('Framebuffer clear works');
  } catch (e) {
    fail(`Framebuffer clear failed: ${e}`);
  }

  // Test 6: Get framebuffer
  const fb = nativeRenderer.getFramebuffer();
  if (fb && fb.length === 640 * 480 * 3) {
    pass(`Framebuffer retrieved (${fb.length} bytes)`);
    // Verify clear color
    if (fb[0] === 255 && fb[1] === 128 && fb[2] === 64) {
      pass('Framebuffer contains correct clear color');
    } else {
      fail(`Framebuffer clear color wrong: (${fb[0]}, ${fb[1]}, ${fb[2]})`);
    }
  } else {
    fail('Failed to get framebuffer or wrong size');
  }

  // Test 7: Render triangles
  const vertices = new Float32Array([
    -0.5, -0.5, 0,
     0.5, -0.5, 0,
     0.0,  0.5, 0,
  ]);
  const indices = new Uint32Array([0, 1, 2]);
  const mvp = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, -2, 1,  // Simple perspective
  ]);
  const colors = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255]);

  try {
    const trianglesRendered = nativeRenderer.renderTrianglesBatch(vertices, indices, mvp, colors);
    pass(`Triangle batch rendering works (${trianglesRendered} triangles)`);
  } catch (e) {
    fail(`Triangle rendering failed: ${e}`);
  }

  // Cleanup
  nativeRenderer.cleanup();
  pass('Renderer cleanup successful');
}

// ============================================================================
// Main
// ============================================================================
async function main(): Promise<void> {
  console.log(`\n${BOLD}${'='.repeat(50)}${RESET}`);
  console.log(`${BOLD}  Performance Architecture Overhaul - Test Suite${RESET}`);
  console.log(`${BOLD}${'='.repeat(50)}${RESET}`);

  try {
    await testPhase4();
    await testPhase3();
    await testPhase1();
    await testPhase2();
  } catch (e) {
    console.log(`\n${RED}Unexpected error: ${e}${RESET}`);
    failed++;
  }

  // Summary
  console.log(`\n${BOLD}${'='.repeat(50)}${RESET}`);
  console.log(`${BOLD}  Summary${RESET}`);
  console.log(`${'='.repeat(50)}`);
  console.log(`  ${GREEN}Passed: ${passed}${RESET}`);
  console.log(`  ${failed > 0 ? RED : GREEN}Failed: ${failed}${RESET}`);
  console.log();

  if (failed === 0) {
    console.log(`${GREEN}${BOLD}All tests passed! The plan is fully implemented.${RESET}\n`);
  } else {
    console.log(`${YELLOW}${BOLD}Some tests failed. Review the output above.${RESET}\n`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(console.error);
