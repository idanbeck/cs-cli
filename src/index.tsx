#!/usr/bin/env node
import React, { useState, useEffect, useRef } from 'react';
import { render, useApp, useStdout } from 'ink';
import { Renderer, RenderObject } from './engine/Renderer.js';
import { Camera } from './engine/Camera.js';
import { Mesh } from './engine/Mesh.js';
import { Transform } from './engine/Transform.js';
import { Vector3 } from './engine/math/Vector3.js';
import { Color, Materials, CURSOR_HIDE, CURSOR_SHOW, ALT_SCREEN_ON, ALT_SCREEN_OFF, RESET } from './utils/Colors.js';
import { degToRad } from './engine/math/MathUtils.js';
import { getGameLoop, PHYSICS_DT, PHYSICS_TICK_RATE, lerp, lerpAngle } from './engine/GameLoop.js';
import { MouseHandler } from './input/MouseHandler.js';
import {
  initNativeKeyboard,
  stopNativeKeyboard,
  isNativeKeyboardAvailable,
  getInputMode,
  getMovementInput as getNativeMovement,
  getLookInput as getNativeLook,
  getWeaponSlotPressed as getNativeWeaponSlot,
  isGameKeyDown,
  wasGameKeyJustPressed,
  updateNativeKeyboard,
  // Native mouse
  isNativeMouseAvailable,
  getNativeMouseDelta,
  wasMouseButtonJustPressed,
  isNativeMouseButtonDown,
  MouseButton,
  // Cursor capture
  setNativeCursorCaptured,
} from './input/NativeKeyboard.js';

// Stdin-based key state tracking with timing (fallback)
// Keys are considered "held" for a short duration after each keypress
const KEY_HOLD_MS = 120; // How long a key stays "pressed" after last stdin event
import { MapLoader, LoadedMap } from './maps/MapLoader.js';
import { MapRegistry, getDefaultMapId } from './maps/MapRegistry.js';
import { setCollisionEnabled } from './physics/Collision.js';
import { CollisionMesh, moveWithMeshCollision, checkGroundMesh, setGlobalCollisionMesh, getGlobalCollisionMesh, adjustSpawnPosition, raycastMesh } from './physics/MeshCollision.js';
import { Player } from './game/Player.js';
import { WeaponSlot } from './game/Weapon.js';
import { getWeaponSprite } from './game/WeaponSprites.js';
import { BotManager } from './ai/BotManager.js';
import { GameMode, DEFAULT_DEATHMATCH_CONFIG, DEFAULT_COMPETITIVE_CONFIG, DEFAULT_SOLO_CONFIG, GameModeType } from './game/GameMode.js';
import { getSoundEngine, playSound, playSoundAt, SoundType } from './audio/SoundEngine.js';
import { getGameConsole, consoleLog, consoleWarn, consoleError, consoleDebug } from './ui/Console.js';
import { getMainMenu, MainMenu, RenderMode, MSAAMode } from './ui/MainMenu.js';
import { getBuyMenu, BuyMenu } from './ui/BuyMenu.js';
import { VoiceManager } from './voice/VoiceManager.js';
import { VoiceSettings } from './voice/types.js';
import { getVoicePlayback } from './voice/VoicePlayback.js';
import { initializeMicCapture, getMicCapture } from './voice/MicCapture.js';
import { VocoderDebugUI } from './voice/VocoderDebugUI.js';
import { getFileLogger, enableFileLogging } from './utils/FileLogger.js';

// CLI options interface
interface CLIOptions {
  renderMode: RenderMode;
  msaaMode: MSAAMode;
  help: boolean;
  debug: boolean;
  debugMap?: string;  // Map ID for debug map mode
  listMaps: boolean;  // List available maps
  vocoderDebug: boolean;  // Vocoder loopback debug mode
}

// Graphics quality presets
type QualityPreset = 'low' | 'medium' | 'high' | 'ultra';

const QUALITY_PRESETS: Record<QualityPreset, { render: RenderMode; msaa: MSAAMode }> = {
  low:    { render: 'basic',     msaa: 'none' },
  medium: { render: 'basic',     msaa: '4x'   },
  high:   { render: 'halfblock', msaa: '4x'   },
  ultra:  { render: 'sixel',     msaa: '16x'  },
};

// Parse command line arguments
function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = {
    renderMode: 'basic',
    msaaMode: 'none',
    help: false,
    debug: false,
    listMaps: false,
    vocoderDebug: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--debug' || arg === '-d') {
      options.debug = true;
    } else if (arg === '--quality' || arg === '-q') {
      const value = args[++i]?.toLowerCase() as QualityPreset;
      if (value in QUALITY_PRESETS) {
        options.renderMode = QUALITY_PRESETS[value].render;
        options.msaaMode = QUALITY_PRESETS[value].msaa;
      }
    } else if (arg.startsWith('--quality=')) {
      const value = arg.split('=')[1]?.toLowerCase() as QualityPreset;
      if (value in QUALITY_PRESETS) {
        options.renderMode = QUALITY_PRESETS[value].render;
        options.msaaMode = QUALITY_PRESETS[value].msaa;
      }
    } else if (arg === '--low') {
      options.renderMode = QUALITY_PRESETS.low.render;
      options.msaaMode = QUALITY_PRESETS.low.msaa;
    } else if (arg === '--medium' || arg === '--med') {
      options.renderMode = QUALITY_PRESETS.medium.render;
      options.msaaMode = QUALITY_PRESETS.medium.msaa;
    } else if (arg === '--high') {
      options.renderMode = QUALITY_PRESETS.high.render;
      options.msaaMode = QUALITY_PRESETS.high.msaa;
    } else if (arg === '--ultra' || arg === '--max') {
      options.renderMode = QUALITY_PRESETS.ultra.render;
      options.msaaMode = QUALITY_PRESETS.ultra.msaa;
    } else if (arg === '--render' || arg === '-r') {
      const value = args[++i]?.toLowerCase();
      if (value === 'basic' || value === 'halfblock' || value === 'half-block' || value === 'sixel') {
        options.renderMode = value === 'half-block' ? 'halfblock' : value as RenderMode;
      }
    } else if (arg.startsWith('--render=')) {
      const value = arg.split('=')[1]?.toLowerCase();
      if (value === 'basic' || value === 'halfblock' || value === 'half-block' || value === 'sixel') {
        options.renderMode = value === 'half-block' ? 'halfblock' : value as RenderMode;
      }
    } else if (arg === '--msaa' || arg === '-m') {
      const value = args[++i]?.toLowerCase();
      if (value === 'none' || value === 'off' || value === '0') {
        options.msaaMode = 'none';
      } else if (value === '4x' || value === '4') {
        options.msaaMode = '4x';
      } else if (value === '16x' || value === '16') {
        options.msaaMode = '16x';
      }
    } else if (arg.startsWith('--msaa=')) {
      const value = arg.split('=')[1]?.toLowerCase();
      if (value === 'none' || value === 'off' || value === '0') {
        options.msaaMode = 'none';
      } else if (value === '4x' || value === '4') {
        options.msaaMode = '4x';
      } else if (value === '16x' || value === '16') {
        options.msaaMode = '16x';
      }
    } else if (arg === '--debug-map' || arg === '--map') {
      options.debugMap = args[++i];
    } else if (arg.startsWith('--debug-map=')) {
      options.debugMap = arg.split('=')[1];
    } else if (arg.startsWith('--map=')) {
      options.debugMap = arg.split('=')[1];
    } else if (arg === '--list-maps' || arg === '--maps') {
      options.listMaps = true;
    } else if (arg === '--vocoder' || arg === '--voice-debug' || arg === '--vocoder-debug') {
      options.vocoderDebug = true;
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`
CS-CLI - Terminal-based Counter-Strike

Usage: cs-cli [options]

Quality Presets:
  --low                   Basic rendering, no AA (fastest)
  --medium, --med         Basic rendering + 4x MSAA
  --high                  Half-block (2x res) + 4x MSAA
  --ultra, --max          Sixel (pixel) + 16x MSAA (best quality)
  -q, --quality <preset>  Set quality: low, medium, high, ultra

Advanced Options:
  -r, --render <mode>     Set render mode:
                            basic      - Standard character rendering (default)
                            halfblock  - 2x vertical resolution using half-blocks
                            sixel      - Pixel-level rendering (requires sixel support)
  -m, --msaa <level>      Set anti-aliasing:
                            none|off|0 - No anti-aliasing (default)
                            4x|4       - 4x MSAA
                            16x|16     - 16x MSAA

Map Debug:
  --map <id>              Load map in debug mode (noclip, no bots)
  --debug-map <id>        Same as --map
  --list-maps, --maps     List all available maps

Voice Debug:
  --vocoder               Launch vocoder debug loopback mode
  --voice-debug           Same as --vocoder

Other:
  -h, --help              Show this help message
  -d, --debug             Run debug mode (rotating cube test scene)

Examples:
  cs-cli                           # Start with defaults (low)
  cs-cli --high                    # High quality preset
  cs-cli --ultra                   # Ultra quality (sixel + 16x MSAA)
  cs-cli -q medium                 # Medium quality preset
  cs-cli --render=halfblock        # Half-block rendering only
  cs-cli -r sixel -m 4x            # Custom: sixel + 4x MSAA

In-Game Controls:
  WASD/Arrows  - Move/Look
  Mouse        - Look (click to capture)
  Space        - Jump
  F/Click      - Fire
  R            - Reload
  B            - Buy menu
  Tab          - Scoreboard
  ~            - Console
  Esc/Q        - Quit
`);
}

// Debug mode: rotating colored cube test scene
async function runDebugMode(initialRenderMode: RenderMode, initialMsaaMode: MSAAMode): Promise<void> {
  const { Renderer } = await import('./engine/Renderer.js');
  const { Mesh } = await import('./engine/Mesh.js');
  const { Transform } = await import('./engine/Transform.js');
  const { Vector3 } = await import('./engine/math/Vector3.js');
  const { Quaternion } = await import('./engine/math/Quaternion.js');
  const { Color, CURSOR_HIDE, ALT_SCREEN_ON, ALT_SCREEN_OFF, RESET } = await import('./utils/Colors.js');
  const fs = await import('fs');

  // Debug log file
  const debugLog = (msg: string) => {
    fs.appendFileSync('/tmp/cs_debug.log', `${new Date().toISOString()} ${msg}\n`);
  };
  fs.writeFileSync('/tmp/cs_debug.log', `=== Debug session started ===\n`);

  // Graphics modes (mutable for runtime switching)
  const renderModes: RenderMode[] = ['basic', 'halfblock', 'sixel'];
  const msaaModes: MSAAMode[] = ['none', '4x', '16x'];
  let renderModeIndex = renderModes.indexOf(initialRenderMode);
  let msaaModeIndex = msaaModes.indexOf(initialMsaaMode);

  // Create renderer
  const width = process.stdout.columns || 80;
  const height = process.stdout.rows ? process.stdout.rows - 2 : 22;
  const renderer = new Renderer(width, height);

  // Disable game UI features for clean debug rendering
  renderer.showCrosshair = false;
  renderer.showHUD = false;
  renderer.showStats = false;
  renderer.enableDifferentialRendering = false;

  renderer.setRenderMode(renderModes[renderModeIndex]);
  renderer.setMSAAMode(msaaModes[msaaModeIndex]);
  renderer.setClearColor(new Color(240, 240, 240)); // Light gray background

  // Update camera FOV for better cube visibility
  const camera = renderer.getCamera();
  camera.setFov(60); // 60 degrees - narrower FOV for less distortion

  // Create colored faces as separate meshes
  const faceColors = [
    new Color(255, 50, 50),    // Red
    new Color(50, 255, 50),    // Green
    new Color(50, 50, 255),    // Blue
    new Color(255, 255, 50),   // Yellow
    new Color(255, 50, 255),   // Magenta
    new Color(50, 255, 255),   // Cyan
  ];

  const meshes: { mesh: Mesh; transform: Transform }[] = [];

  // Create a simple cube with 6 colored faces
  for (let i = 0; i < 6; i++) {
    const mesh = new Mesh({ name: `face${i}`, color: faceColors[i] });

    // Create a quad for each face
    const s = 1; // half-size
    let verts: Vector3[];
    let normal: Vector3;

    switch (i) {
      case 0: // Front (+Z)
        verts = [new Vector3(-s, -s, s), new Vector3(s, -s, s), new Vector3(s, s, s), new Vector3(-s, s, s)];
        normal = new Vector3(0, 0, 1);
        break;
      case 1: // Back (-Z)
        verts = [new Vector3(s, -s, -s), new Vector3(-s, -s, -s), new Vector3(-s, s, -s), new Vector3(s, s, -s)];
        normal = new Vector3(0, 0, -1);
        break;
      case 2: // Left (-X)
        verts = [new Vector3(-s, -s, -s), new Vector3(-s, -s, s), new Vector3(-s, s, s), new Vector3(-s, s, -s)];
        normal = new Vector3(-1, 0, 0);
        break;
      case 3: // Right (+X)
        verts = [new Vector3(s, -s, s), new Vector3(s, -s, -s), new Vector3(s, s, -s), new Vector3(s, s, s)];
        normal = new Vector3(1, 0, 0);
        break;
      case 4: // Top (+Y)
        verts = [new Vector3(-s, s, s), new Vector3(s, s, s), new Vector3(s, s, -s), new Vector3(-s, s, -s)];
        normal = new Vector3(0, 1, 0);
        break;
      case 5: // Bottom (-Y)
      default:
        verts = [new Vector3(-s, -s, -s), new Vector3(s, -s, -s), new Vector3(s, -s, s), new Vector3(-s, -s, s)];
        normal = new Vector3(0, -1, 0);
        break;
    }

    for (const v of verts) {
      mesh.addVertex(v, normal);
    }
    // Counter-clockwise winding for front-facing triangles
    mesh.addTriangle(0, 2, 1);
    mesh.addTriangle(0, 3, 2);

    const transform = new Transform();
    meshes.push({ mesh, transform });
    renderer.addObject({ mesh, transform });
  }

  // Set up camera position (will be updated in loop based on cameraDistance)
  camera.lookAt(new Vector3(0, 0, 0));

  // Enter fullscreen
  process.stdout.write(ALT_SCREEN_ON + CURSOR_HIDE);

  let running = true;
  let lastTime = Date.now();

  // Current rotation as quaternion
  let currentRotation = new Quaternion();

  // Rotation velocities (radians per second) around each axis
  let velX = 0.5;
  let velY = 0.8;
  let velZ = 0.3;

  // Camera zoom (distance from cube)
  let cameraDistance = 3.0;
  const ZOOM_STEP = 0.5;
  const MIN_ZOOM = 1.5;
  const MAX_ZOOM = 10.0;

  const VELOCITY_STEP = 0.3; // How much to change velocity per keypress

  // FPS tracking
  let frameCount = 0;
  let lastFpsUpdate = Date.now();
  let currentFps = 0;

  // Sixel resolution options (1=full, 2=half, 4=quarter, 8=eighth, 16=sixteenth)
  const sixelResolutions = [1, 2, 4, 8, 16];
  let sixelResIndex = 3; // Start at 8 (eighth res)

  // Handle keyboard input
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (data) => {
    const key = data.toString();

    // Exit keys
    if (key === 'q' || key === '\x03') { // q, Ctrl+C
      running = false;
      return;
    }

    // Arrow keys (escape sequences)
    if (key === '\x1b[A') { // Up arrow - increase X rotation (pitch)
      velX += VELOCITY_STEP;
    } else if (key === '\x1b[B') { // Down arrow - decrease X rotation
      velX -= VELOCITY_STEP;
    } else if (key === '\x1b[C') { // Right arrow - increase Y rotation (yaw)
      velY += VELOCITY_STEP;
    } else if (key === '\x1b[D') { // Left arrow - decrease Y rotation
      velY -= VELOCITY_STEP;
    } else if (key === '[' || key === ']') { // [ ] for Z rotation (roll)
      velZ += key === ']' ? VELOCITY_STEP : -VELOCITY_STEP;
    } else if (key === ' ') { // Space to reset
      velX = 0.5;
      velY = 0.8;
      velZ = 0.3;
      currentRotation = new Quaternion();
    } else if (key === '0') { // 0 to stop all rotation
      velX = velY = velZ = 0;
    } else if (key === 'r' || key === 'R') { // R to cycle render mode
      const oldMode = renderModes[renderModeIndex];
      renderModeIndex = (renderModeIndex + 1) % renderModes.length;
      const newMode = renderModes[renderModeIndex];

      debugLog(`MODE SWITCH: ${oldMode} -> ${newMode}`);
      debugLog(`  BEFORE: fb=${renderer.getWidth()}x${renderer.getHeight()} cam.aspect=${camera.aspect}`);
      debugLog(`  BEFORE: cam.pos=${JSON.stringify(camera.position)} cam.fov=${camera.fov}`);
      debugLog(`  Terminal: ${process.stdout.columns}x${process.stdout.rows}`);

      // Full terminal reset: clear screen, reset sixel, home cursor
      process.stdout.write('\x1b\\\x1b[2J\x1b[H\x1b[0m');
      renderer.setRenderMode(newMode);

      debugLog(`  AFTER: fb=${renderer.getWidth()}x${renderer.getHeight()} cam.aspect=${camera.aspect}`);
      debugLog(`  AFTER: cam.pos=${JSON.stringify(camera.position)} cam.fov=${camera.fov}`);

      if (newMode === 'sixel') {
        const si = renderer.getSixelInfo();
        debugLog(`  SIXEL: resolution=1/${si.resolution} cellSize=${si.cellSize} targetPixels=${si.targetPixels}`);
        debugLog(`  SIXEL: outputScale=${renderer.getSixelOutputScale()}`);
      }

      // Log transform state
      for (let i = 0; i < meshes.length; i++) {
        const t = meshes[i].transform;
        debugLog(`  mesh[${i}] pos=${JSON.stringify(t.position)} scale=${JSON.stringify(t.scale)}`);
      }
    } else if (key === 'm' || key === 'M') { // M to cycle MSAA mode
      msaaModeIndex = (msaaModeIndex + 1) % msaaModes.length;
      debugLog(`MSAA SWITCH: -> ${msaaModes[msaaModeIndex]}`);
      // Clear when changing MSAA to reset sample buffers visually
      process.stdout.write('\x1b[2J\x1b[H');
      renderer.setMSAAMode(msaaModes[msaaModeIndex]);
    } else if (key === '=' || key === '+') { // Zoom in (closer)
      cameraDistance = Math.max(MIN_ZOOM, cameraDistance - ZOOM_STEP);
    } else if (key === '-' || key === '_') { // Zoom out (farther)
      cameraDistance = Math.min(MAX_ZOOM, cameraDistance + ZOOM_STEP);
    } else if (key === '<' || key === ',') { // Decrease sixel resolution (faster)
      sixelResIndex = Math.min(sixelResIndex + 1, sixelResolutions.length - 1);
      renderer.setSixelResolution(sixelResolutions[sixelResIndex]);
      debugLog(`SIXEL RES: ${sixelResolutions[sixelResIndex]} (fb=${renderer.getWidth()}x${renderer.getHeight()})`);
    } else if (key === '>' || key === '.') { // Increase sixel resolution (better quality)
      sixelResIndex = Math.max(sixelResIndex - 1, 0);
      renderer.setSixelResolution(sixelResolutions[sixelResIndex]);
      debugLog(`SIXEL RES: ${sixelResolutions[sixelResIndex]} (fb=${renderer.getWidth()}x${renderer.getHeight()})`);
    } else if (key === 'd' || key === 'D') { // Detect terminal pixel size
      debugLog(`DETECTING terminal pixel size...`);
      renderer.detectTerminalPixelSize().then((result) => {
        if (result) {
          debugLog(`DETECTED: ${result.width}x${result.height} pixels`);
          const cellW = Math.round(result.width / (process.stdout.columns || 80));
          const cellH = Math.round(result.height / (process.stdout.rows || 24));
          debugLog(`CELL SIZE: ${cellW}x${cellH} pixels`);
          renderer.setCellPixelSize(cellW, cellH);
        } else {
          debugLog(`DETECTION FAILED (terminal may not support CSI 14 t)`);
        }
      });
    } else if (key === 'c' || key === 'C') { // Cycle cell size presets
      const presets = [
        { w: 8, h: 16, name: '8x16 (standard)' },
        { w: 10, h: 20, name: '10x20 (medium)' },
        { w: 14, h: 28, name: '14x28 (large)' },
        { w: 16, h: 32, name: '16x32 (Retina)' },
        { w: 20, h: 40, name: '20x40 (HiDPI)' },
      ];
      const si = renderer.getSixelInfo();
      const currentCell = si.cellSize;
      let currentIdx = presets.findIndex(p => `${p.w}x${p.h}` === currentCell);
      currentIdx = (currentIdx + 1) % presets.length;
      const preset = presets[currentIdx];
      renderer.setCellPixelSize(preset.w, preset.h);
      debugLog(`CELL SIZE: ${preset.name} -> target ${renderer.getSixelInfo().targetPixels}`);
    } else if (key === 'n' || key === 'N') { // Toggle native SIMD renderer
      const wasEnabled = renderer.isUsingNativeRenderer();
      renderer.setUseNativeRenderer(!wasEnabled);
      const nowEnabled = renderer.isUsingNativeRenderer();
      const simdStatus = renderer.hasNativeSIMD() ? 'SIMD' : 'scalar';
      debugLog(`NATIVE RENDERER: ${nowEnabled ? 'ON' : 'OFF'} (${simdStatus})`);
    }
  });

  // Main loop
  const loop = () => {
    if (!running) {
      // Cleanup
      process.stdout.write(ALT_SCREEN_OFF + RESET);
      process.stdin.setRawMode(false);
      process.exit(0);
      return;
    }

    // Calculate delta time
    const now = Date.now();
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    // Apply incremental rotations using quaternion multiplication
    // This avoids gimbal lock issues with Euler angles
    if (velX !== 0) {
      const deltaRotX = Quaternion.fromAxisAngle(new Vector3(1, 0, 0), velX * dt);
      currentRotation = Quaternion.multiply(deltaRotX, currentRotation);
    }
    if (velY !== 0) {
      const deltaRotY = Quaternion.fromAxisAngle(new Vector3(0, 1, 0), velY * dt);
      currentRotation = Quaternion.multiply(deltaRotY, currentRotation);
    }
    if (velZ !== 0) {
      const deltaRotZ = Quaternion.fromAxisAngle(new Vector3(0, 0, 1), velZ * dt);
      currentRotation = Quaternion.multiply(deltaRotZ, currentRotation);
    }

    // Normalize to prevent drift
    currentRotation.normalize();

    // Apply rotation to all faces (use setRotation to mark matrix dirty)
    for (const { transform } of meshes) {
      transform.setRotation(currentRotation);
    }

    // Keep camera at fixed position looking at cube (zoom adjustable)
    camera.position = new Vector3(0, cameraDistance * 0.5, cameraDistance);
    camera.lookAt(new Vector3(0, 0, 0));

    // Render
    renderer.render();

    // Update FPS counter
    frameCount++;
    const fpsNow = Date.now();
    if (fpsNow - lastFpsUpdate >= 500) {
      currentFps = frameCount / ((fpsNow - lastFpsUpdate) / 1000);
      frameCount = 0;
      lastFpsUpdate = fpsNow;
    }

    // Draw controls overlay (after render, directly to stdout)
    // Skip text overlay in sixel mode - ANSI cursor positioning conflicts with sixel graphics
    const currentRenderMode = renderModes[renderModeIndex];
    if (currentRenderMode !== 'sixel') {
      const currentMsaaMode = msaaModes[msaaModeIndex];
      const fbW = renderer.getWidth();
      const fbH = renderer.getHeight();
      const camAspect = camera.aspect.toFixed(2);

      // Native renderer status
      const nativeStatus = renderer.isUsingNativeRenderer()
        ? (renderer.hasNativeSIMD() ? '\x1b[92mSIMD\x1b[97m' : '\x1b[93mNATIVE\x1b[97m')
        : '\x1b[90mJS\x1b[97m';

      const info = [
        `\x1b[1;1H\x1b[97m\x1b[40m ${currentRenderMode} ${currentMsaaMode} [${nativeStatus}] | FB:${fbW}×${fbH} | A:${camAspect} | Z:${cameraDistance.toFixed(1)} | ${currentFps.toFixed(0)} FPS \x1b[K`,
        `\x1b[2;1H ↑↓←→:Rot  []:Roll  +/-:Zoom  0:Stop  Space:Reset  R:Render  M:MSAA  N:Native \x1b[K`,
        `\x1b[3;1H </>:SixelRes  C:CellSize  D:DetectSize  Q:Quit \x1b[0m\x1b[K`,
      ];
      process.stdout.write(info.join(''));
    }

    // Schedule next frame
    setTimeout(loop, 16); // ~60 FPS
  };

  loop();

  // Keep process alive
  await new Promise(() => {});
}

import { getTeamManager, resetTeamManager, TeamId } from './game/Team.js';
import { getDroppedWeaponManager, resetDroppedWeaponManager } from './game/DroppedWeapon.js';
import { getServerBrowser, ServerBrowser } from './ui/ServerBrowser.js';
import { getLobbyScreen, LobbyScreen } from './ui/LobbyScreen.js';
import { getGameClient, GameClient, DEFAULT_CLIENT_CONFIG } from './network/GameClient.js';
import { getMultiplayerState, resetMultiplayerState } from './network/MultiplayerState.js';

type AppMode = 'menu' | 'playing' | 'server_browser' | 'lobby';

interface GameState {
  appMode: AppMode;
  fps: number;
  frameTime: number;
  cameraPos: Vector3;
  cameraPitch: number;
  cameraYaw: number;
  mouseCaptured: boolean;
  health: number;
  armor: number;
  ammo: number;
  reserveAmmo: number;
  weaponName: string;
  isReloading: boolean;
  money: number;
  team: TeamId;
}

interface PlayerPhysics {
  velocityY: number;
  onGround: boolean;
}

// Constants
const MOVE_SPEED = 8; // units per second
const TURN_SPEED = degToRad(120); // radians per second
const GRAVITY = 20; // units per second^2
const JUMP_VELOCITY = 8; // units per second
const GROUND_Y = 1.7; // eye height
const PLAYER_RADIUS = 0.4;
// Map debug mode: load a map and fly around with noclip
async function runMapDebugMode(mapId: string, initialRenderMode: RenderMode, initialMsaaMode: MSAAMode): Promise<void> {
  const { Renderer } = await import('./engine/Renderer.js');
  const { Vector3 } = await import('./engine/math/Vector3.js');
  const { Color, CURSOR_HIDE, ALT_SCREEN_ON, ALT_SCREEN_OFF, RESET } = await import('./utils/Colors.js');
  const { degToRad } = await import('./engine/math/MathUtils.js');
  const fs = await import('fs');

  // Debug log file
  const LOG_PATH = '/tmp/cs_map_debug.log';
  const log = (msg: string) => {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
  };
  fs.writeFileSync(LOG_PATH, `=== Map Debug Session: ${mapId} ===\n`);
  fs.appendFileSync(LOG_PATH, `Started: ${new Date().toISOString()}\n\n`);

  // Initialize map registry and load map
  MapRegistry.initialize();
  const mapInfo = MapRegistry.getMap(mapId);
  if (!mapInfo) {
    console.error(`Map not found: ${mapId}`);
    console.log('\nAvailable maps:');
    for (const m of MapRegistry.getAvailableMaps()) {
      console.log(`  ${m.id}`);
    }
    process.exit(1);
  }

  log(`Loading map: ${mapInfo.name} (${mapId})`);
  log(`  BSP path: ${mapInfo.bspPath}`);
  log(`  WAD paths: ${mapInfo.wadPaths?.join(', ') || 'none'}`);
  log(`  Type: ${mapInfo.type}`);
  log(`  Modes: ${mapInfo.modes}`);

  console.log(`Loading ${mapInfo.name}...`);
  console.log(`Log file: ${LOG_PATH}`);

  let loadedMap;
  try {
    loadedMap = await MapRegistry.loadMap(mapId);
    log(`\nMap loaded successfully:`);
    log(`  Render objects: ${loadedMap.renderObjects.length}`);
    log(`  Spawns: ${loadedMap.spawns.length}`);
    log(`  Colliders: ${loadedMap.colliders.length}`);
    log(`  Ambient light: ${loadedMap.ambientLight}`);
    log(`  Sky color: RGB(${loadedMap.skyColor.r}, ${loadedMap.skyColor.g}, ${loadedMap.skyColor.b})`);
    log(`  Bounds: (${loadedMap.bounds.min.x.toFixed(1)}, ${loadedMap.bounds.min.y.toFixed(1)}, ${loadedMap.bounds.min.z.toFixed(1)}) to (${loadedMap.bounds.max.x.toFixed(1)}, ${loadedMap.bounds.max.y.toFixed(1)}, ${loadedMap.bounds.max.z.toFixed(1)})`);
  } catch (e: any) {
    log(`\nERROR loading map: ${e.message}`);
    log(e.stack || '');
    console.error(`Failed to load map: ${e.message}`);
    process.exit(1);
  }

  // Analyze render objects
  log(`\n=== Render Objects Analysis ===`);
  let totalTris = 0;
  let totalVerts = 0;
  const materialStats: Map<string, { count: number; tris: number; hasTexture: boolean }> = new Map();

  for (let i = 0; i < loadedMap.renderObjects.length; i++) {
    const obj = loadedMap.renderObjects[i];
    const mesh = obj.mesh;
    const matName = mesh.material?.name || 'unnamed';
    const hasTexture = !!mesh.material?.texture;
    const tris = mesh.triangles.length;
    const verts = mesh.vertices.length;

    totalTris += tris;
    totalVerts += verts;

    if (!materialStats.has(matName)) {
      materialStats.set(matName, { count: 0, tris: 0, hasTexture });
    }
    const stat = materialStats.get(matName)!;
    stat.count++;
    stat.tris += tris;
  }

  log(`\nTotal triangles: ${totalTris}`);
  log(`Total vertices: ${totalVerts}`);
  log(`\nMaterials (${materialStats.size}):`);

  const sortedMats = Array.from(materialStats.entries()).sort((a, b) => b[1].tris - a[1].tris);
  let missingTextures = 0;
  for (const [name, stat] of sortedMats) {
    const texStatus = stat.hasTexture ? 'OK' : 'MISSING';
    if (!stat.hasTexture) missingTextures++;
    log(`  ${name.padEnd(30)} ${stat.tris.toString().padStart(6)} tris, ${stat.count.toString().padStart(3)} objs, tex: ${texStatus}`);
  }

  if (missingTextures > 0) {
    log(`\nWARNING: ${missingTextures} materials missing textures`);
  }

  // Analyze spawns
  log(`\n=== Spawn Points (${loadedMap.spawns.length}) ===`);
  for (let i = 0; i < loadedMap.spawns.length; i++) {
    const sp = loadedMap.spawns[i];
    log(`  ${i + 1}: pos=(${sp.position[0].toFixed(1)}, ${sp.position[1].toFixed(1)}, ${sp.position[2].toFixed(1)}) angle=${sp.angle.toFixed(0)}° team=${sp.team || 'none'}`);
  }

  console.log(`Loaded: ${loadedMap.renderObjects.length} objects, ${totalTris} tris, ${loadedMap.spawns.length} spawns`);
  if (missingTextures > 0) {
    console.log(`Warning: ${missingTextures} missing textures (see log)`);
  }

  // Create renderer
  const width = process.stdout.columns || 80;
  const height = process.stdout.rows ? process.stdout.rows - 2 : 22;
  const renderer = new Renderer(width, height);

  // Better defaults for BSP map viewing
  renderer.setRenderMode('halfblock');  // Better quality
  renderer.setMSAAMode('4x');  // Smooth edges
  renderer.showCrosshair = true;
  renderer.showHUD = false;
  renderer.showStats = true;
  renderer.setClearColor(loadedMap.skyColor);
  renderer.getRasterizer().ambientLight = loadedMap.ambientLight;
  renderer.getRasterizer().enableLighting = true;
  renderer.getRasterizer().enableDepthShading = true;
  renderer.getRasterizer().maxDepth = 500;  // Large for BSP maps
  renderer.getRasterizer().nearPlane = 0.01;  // Allow closer objects
  renderer.getRasterizer().enableBackfaceCulling = false;  // Off for BSP - geometry is complex

  // Add map objects
  for (const obj of loadedMap.renderObjects) {
    renderer.addObject(obj);
  }

  // Camera setup - start at first spawn
  const camera = renderer.getCamera();
  const spawn = loadedMap.spawns[0] || { position: [0, 2, 0], angle: 0 };
  camera.setPosition(spawn.position[0], spawn.position[1] + 1.7, spawn.position[2]);
  camera.setYaw(degToRad(spawn.angle));
  camera.setPitch(0);
  camera.fov = degToRad(90);
  camera.aspect = width / height;
  camera.near = 0.01;  // Allow closer objects for BSP
  camera.far = 500;    // Large for BSP maps

  // Create mouse handler for capture
  const mouseHandler = new MouseHandler(width, height);
  mouseHandler.setNativeMouseMode(false);  // We'll use native input if available

  log(`\n=== Debug Session Started ===`);
  log(`Initial position: (${spawn.position[0].toFixed(1)}, ${spawn.position[1].toFixed(1)}, ${spawn.position[2].toFixed(1)})`);
  log(`Render mode: ${initialRenderMode}, MSAA: ${initialMsaaMode}`);
  log(`Native renderer: available=${renderer.hasNativeRenderer()} simd=${renderer.hasNativeSIMD()} enabled=${renderer.isNativeRendererEnabled()} textures=${renderer.getRasterizer().enableTextures}`);

  // Noclip flying state
  let yaw = degToRad(spawn.angle);
  let pitch = 0;
  const flySpeed = 0.5;
  const mouseSensitivity = 0.003;
  let spawnIndex = 0;

  // Try to init native keyboard/mouse
  let useNativeInput = false;
  try {
    const nativeAvailable = await isNativeKeyboardAvailable();
    if (nativeAvailable) {
      await initNativeKeyboard();
      useNativeInput = true;
      mouseHandler.setNativeMouseMode(true);  // Skip robotjs capture, use native
      log(`Native keyboard/mouse: ENABLED`);
      console.log('Native input enabled - use mouse to look, click to capture');
    } else {
      log(`Native keyboard/mouse: NOT AVAILABLE`);
      console.log('Using keyboard only - IJKL/arrows to look');
    }
  } catch (e: any) {
    log(`Native keyboard/mouse error: ${e.message}`);
    console.log('Using keyboard only - IJKL/arrows to look');
  }

  // Enter alt screen
  process.stdout.write(ALT_SCREEN_ON + CURSOR_HIDE);

  // Enable mouse tracking in terminal (for click-to-capture and fallback mouse)
  mouseHandler.enable();

  // Raw mode for keyboard (fallback)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  let running = true;
  let escapeSequence = '';

  // Stdin key handler (fallback when native not available)
  process.stdin.on('data', (data) => {
    const str = data.toString();

    // Try to parse mouse events first
    if (mouseHandler.parseMouseEvent(str)) {
      // Mouse event handled - apply deltas if captured
      if (mouseHandler.isCaptured() && !useNativeInput) {
        const delta = mouseHandler.getPitchYawDelta();
        pitch = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, pitch + delta.pitch));
        yaw += delta.yaw;
        camera.setYaw(yaw);
        camera.setPitch(pitch);
      }
      return;
    }

    // Handle escape sequences for arrow keys (left/right inverted to match natural feel)
    if (str.startsWith('\x1b[')) {
      if (str === '\x1b[A') { pitch = Math.min(Math.PI / 2 - 0.1, pitch + 0.05); }  // Up
      else if (str === '\x1b[B') { pitch = Math.max(-Math.PI / 2 + 0.1, pitch - 0.05); }  // Down
      else if (str === '\x1b[C') { yaw -= 0.05; }  // Right arrow = turn right
      else if (str === '\x1b[D') { yaw += 0.05; }  // Left arrow = turn left
      camera.setYaw(yaw);
      camera.setPitch(pitch);
      return;
    }

    for (const char of str) {
      const code = char.charCodeAt(0);

      // Quit only on Q or Ctrl+C (not ESC alone, since arrow keys send ESC prefix)
      if (char === 'q' || char === 'Q' || code === 3) {
        running = false;
        return;
      }

      // Movement - match Camera.getForward() and getRight()
      const forward = new Vector3(
        -Math.sin(yaw) * Math.cos(pitch),
        Math.sin(pitch),
        -Math.cos(yaw) * Math.cos(pitch)
      );
      const right = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      const up = new Vector3(0, 1, 0);

      if (char === 'w' || char === 'W') {
        camera.position = camera.position.add(forward.scale(flySpeed));
      } else if (char === 's' || char === 'S') {
        camera.position = camera.position.add(forward.scale(-flySpeed));
      } else if (char === 'a' || char === 'A') {
        camera.position = camera.position.add(right.scale(-flySpeed));
      } else if (char === 'd' || char === 'D') {
        camera.position = camera.position.add(right.scale(flySpeed));
      } else if (char === ' ' || char === 'e' || char === 'E') {
        camera.position = camera.position.add(up.scale(flySpeed));
      } else if (char === 'c' || char === 'C') {
        camera.position = camera.position.add(up.scale(-flySpeed));
      }

      // Look with IJKL (J=left, L=right, I=up, K=down)
      if (char === 'j' || char === 'J') { yaw += 0.05; }  // Turn left
      else if (char === 'l' || char === 'L') { yaw -= 0.05; }  // Turn right
      else if (char === 'i' || char === 'I') { pitch = Math.min(Math.PI / 2 - 0.1, pitch + 0.05); }
      else if (char === 'k' || char === 'K') { pitch = Math.max(-Math.PI / 2 + 0.1, pitch - 0.05); }

      // Cycle spawn points
      if (char === 'n' || char === 'N') {
        spawnIndex = (spawnIndex + 1) % loadedMap.spawns.length;
        const sp = loadedMap.spawns[spawnIndex];
        camera.setPosition(sp.position[0], sp.position[1] + 1.7, sp.position[2]);
        yaw = degToRad(sp.angle);
        pitch = 0;
        log(`Teleported to spawn ${spawnIndex + 1}: (${sp.position[0].toFixed(1)}, ${sp.position[1].toFixed(1)}, ${sp.position[2].toFixed(1)})`);
      } else if (char === 'p' || char === 'P') {
        spawnIndex = (spawnIndex - 1 + loadedMap.spawns.length) % loadedMap.spawns.length;
        const sp = loadedMap.spawns[spawnIndex];
        camera.setPosition(sp.position[0], sp.position[1] + 1.7, sp.position[2]);
        yaw = degToRad(sp.angle);
        pitch = 0;
        log(`Teleported to spawn ${spawnIndex + 1}: (${sp.position[0].toFixed(1)}, ${sp.position[1].toFixed(1)}, ${sp.position[2].toFixed(1)})`);
      }

      // Render mode toggle (R)
      if (char === 'r' || char === 'R') {
        const modes: RenderMode[] = ['basic', 'halfblock'];
        const current = modes.indexOf(renderer.getRenderMode());
        const next = (current + 1) % modes.length;
        process.stdout.write('\x1b[2J\x1b[H');
        renderer.setRenderMode(modes[next]);
        log(`Render mode: ${modes[next]}`);
      }

      // MSAA toggle (M)
      if (char === 'm' || char === 'M') {
        const modes: MSAAMode[] = ['none', '4x', '16x'];
        const current = modes.indexOf(renderer.getMSAAMode());
        const next = (current + 1) % modes.length;
        renderer.setMSAAMode(modes[next]);
        log(`MSAA: ${modes[next]}`);
      }

      // Texture toggle (T)
      if (char === 't' || char === 'T') {
        const rast = renderer.getRasterizer();
        rast.enableTextures = !rast.enableTextures;
        log(`Textures: ${rast.enableTextures ? 'ON' : 'OFF'}`);
      }

      // Texture filter toggle (F)
      if (char === 'f' || char === 'F') {
        const rast = renderer.getRasterizer();
        const filters: Array<'normal' | 'pixelated' | 'blockavg'> = ['normal', 'pixelated', 'blockavg'];
        const current = filters.indexOf(rast.textureFilter);
        const next = (current + 1) % filters.length;
        rast.textureFilter = filters[next];
        log(`Texture filter: ${filters[next]}`);
      }

      // AO toggle (O)
      if (char === 'o' || char === 'O') {
        const rast = renderer.getRasterizer();
        rast.enableAmbientOcclusion = !rast.enableAmbientOcclusion;
        log(`Ambient Occlusion: ${rast.enableAmbientOcclusion ? 'ON' : 'OFF'}`);
      }

      // Backface culling toggle (B)
      if (char === 'b' || char === 'B') {
        const rast = renderer.getRasterizer();
        rast.enableBackfaceCulling = !rast.enableBackfaceCulling;
        log(`Backface culling: ${rast.enableBackfaceCulling ? 'ON' : 'OFF'}`);
      }

      // White texture mode toggle (G for "ghost" mode)
      if (char === 'g' || char === 'G') {
        const rast = renderer.getRasterizer();
        rast.whiteTextureMode = !rast.whiteTextureMode;
        log(`White texture mode: ${rast.whiteTextureMode ? 'ON' : 'OFF'}`);
      }

      // Lighting toggle (H)
      if (char === 'h' || char === 'H') {
        const rast = renderer.getRasterizer();
        rast.enableLighting = !rast.enableLighting;
        log(`Lighting: ${rast.enableLighting ? 'ON' : 'OFF'}`);
      }

      // Native/JS renderer toggle (V)
      if (char === 'v' || char === 'V') {
        const rast = renderer.getRasterizer();
        const wasEnabled = renderer.isNativeRendererEnabled();
        renderer.setUseNativeRenderer(!wasEnabled);
        const nowEnabled = renderer.isNativeRendererEnabled();
        const actuallyUsing = renderer.isUsingNativeRenderer();
        const simdStatus = renderer.hasNativeSIMD() ? 'SIMD' : 'scalar';
        const hasNative = renderer.hasNativeRenderer();
        log(`Native toggle: hasNative=${hasNative} enabled=${nowEnabled} actuallyUsing=${actuallyUsing} textures=${rast.enableTextures} simd=${simdStatus}`);
        if (nowEnabled && !actuallyUsing) {
          log(`Native renderer: ENABLED (${simdStatus}) but using JS (textures on)`);
        } else {
          log(`Native renderer: ${nowEnabled ? `ON (${simdStatus})` : 'OFF (JS)'}`);
        }
      }

      camera.setYaw(yaw);
      camera.setPitch(pitch);
    }
  });

  // Render loop
  const frameTime = 1000 / 30; // 30 FPS target
  let frameCount = 0;
  let lastFpsTime = Date.now();
  let currentFps = 0;
  let fpsFrameCount = 0;

  while (running) {
    // Update native input if available
    if (useNativeInput) {
      updateNativeKeyboard();

      // Mouse look (invert X for natural feel - moving mouse right turns view right)
      const mouseDelta = getNativeMouseDelta();
      if (mouseDelta.x !== 0 || mouseDelta.y !== 0) {
        yaw -= mouseDelta.x * mouseSensitivity;  // Inverted for natural feel
        pitch -= mouseDelta.y * mouseSensitivity;
        pitch = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, pitch));
        camera.setYaw(yaw);
        camera.setPitch(pitch);
      }

      // WASD movement via native - match Camera.getForward() and getRight()
      const forward = new Vector3(
        -Math.sin(yaw) * Math.cos(pitch),
        Math.sin(pitch),
        -Math.cos(yaw) * Math.cos(pitch)
      );
      const right = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      const up = new Vector3(0, 1, 0);

      if (isGameKeyDown('W')) camera.position = camera.position.add(forward.scale(flySpeed * 0.1));
      if (isGameKeyDown('S')) camera.position = camera.position.add(forward.scale(-flySpeed * 0.1));
      if (isGameKeyDown('A')) camera.position = camera.position.add(right.scale(-flySpeed * 0.1));
      if (isGameKeyDown('D')) camera.position = camera.position.add(right.scale(flySpeed * 0.1));
      if (isGameKeyDown('Space')) camera.position = camera.position.add(up.scale(flySpeed * 0.1));
      if (isGameKeyDown('C')) camera.position = camera.position.add(up.scale(-flySpeed * 0.1));

      // Q to quit
      if (wasGameKeyJustPressed('Q') || wasGameKeyJustPressed('Escape')) {
        running = false;
      }
    }

    // Render
    renderer.render();

    // Apply AO post-process
    renderer.getRasterizer().applyAmbientOcclusion();

    // Update FPS counter
    fpsFrameCount++;
    const now = Date.now();
    if (now - lastFpsTime >= 500) {
      currentFps = fpsFrameCount / ((now - lastFpsTime) / 1000);
      fpsFrameCount = 0;
      lastFpsTime = now;
    }

    // Get current settings for display
    const rast = renderer.getRasterizer();
    const renderMode = renderer.getRenderMode();
    const msaaMode = renderer.getMSAAMode();
    const texOn = rast.enableTextures;
    const texFilter = rast.textureFilter;
    const aoOn = rast.enableAmbientOcclusion;
    const bfcOn = rast.enableBackfaceCulling;
    const whiteMode = rast.whiteTextureMode;
    const lightOn = rast.enableLighting;

    // Native renderer status - show both enabled state and actual state
    const nativeEnabled = renderer.isNativeRendererEnabled();
    const nativeActual = renderer.isUsingNativeRenderer();
    let nativeStatus: string;
    if (nativeActual) {
      nativeStatus = renderer.hasNativeSIMD() ? 'SIMD' : 'NATIVE';
    } else if (nativeEnabled) {
      nativeStatus = 'ON→JS';  // Enabled but falling back to JS (textures)
    } else {
      nativeStatus = 'JS';
    }

    // Overlay
    const inputMode = useNativeInput ? 'NATIVE' : 'STDIN';
    const infoLines = [
      `MAP: ${loadedMap.name} | SPAWN[N/P]: ${spawnIndex + 1}/${loadedMap.spawns.length} | ${currentFps.toFixed(0)} FPS`,
      `POS: ${camera.position.x.toFixed(1)}, ${camera.position.y.toFixed(1)}, ${camera.position.z.toFixed(1)} | YAW: ${(yaw * 180 / Math.PI).toFixed(0)}° PITCH: ${(pitch * 180 / Math.PI).toFixed(0)}° | TRIS: ${totalTris}`,
      `[R]ender:${renderMode} [M]SAA:${msaaMode} [T]ex:${texOn ? 'ON' : 'OFF'} [F]ilter:${texFilter} [V]backend:${nativeStatus}`,
      `[O]AO:${aoOn ? 'ON' : 'OFF'} [B]FC:${bfcOn ? 'ON' : 'OFF'} [G]host:${whiteMode ? 'ON' : 'OFF'} Lig[H]t:${lightOn ? 'ON' : 'OFF'}`,
      `WASD=move SPACE/C=up/down IJKL/Mouse=look [Q]uit | Input:${inputMode}`,
    ];

    for (let i = 0; i < infoLines.length; i++) {
      process.stdout.write(`\x1b[${i + 1};1H\x1b[43;30m ${infoLines[i].padEnd(78)} \x1b[0m`);
    }

    frameCount++;
    await new Promise(resolve => setTimeout(resolve, frameTime));
  }

  // Cleanup
  log(`\n=== Session Ended ===`);
  log(`Total frames: ${frameCount}`);
  log(`Final position: (${camera.position.x.toFixed(1)}, ${camera.position.y.toFixed(1)}, ${camera.position.z.toFixed(1)})`);

  mouseHandler.release();
  mouseHandler.disable();
  if (useNativeInput) {
    stopNativeKeyboard();
  }
  process.stdout.write(ALT_SCREEN_OFF + RESET + '\x1b[?25h');
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();
  console.log('Map debug mode exited.');
  console.log(`Log saved to: ${LOG_PATH}`);
  process.exit(0);
}

const PLAYER_HEIGHT = 1.7;

interface GameProps {
  initialRenderMode?: RenderMode;
  initialMSAAMode?: MSAAMode;
}

function Game({ initialRenderMode = 'halfblock', initialMSAAMode = '4x' }: GameProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [renderer] = useState(() => {
    const width = stdout?.columns || 80;
    const height = stdout?.rows ? stdout.rows - 2 : 22;
    const r = new Renderer(width, height);
    // Apply initial settings from CLI
    r.setRenderMode(initialRenderMode);
    r.setMSAAMode(initialMSAAMode);
    return r;
  });

  const [gameState, setGameState] = useState<GameState>({
    appMode: 'menu',
    fps: 0,
    frameTime: 0,
    cameraPos: new Vector3(0, 2, 5),
    cameraPitch: 0,
    cameraYaw: 0,
    mouseCaptured: false,
    health: 100,
    armor: 0,
    ammo: 12,
    reserveAmmo: 36,
    weaponName: 'Pistol',
    isReloading: false,
    money: 800,
    team: 'SPECTATOR',
  });

  // App mode ref for quick access
  const appModeRef = useRef<AppMode>('menu');

  // Selected game mode type
  const gameModeTypeRef = useRef<GameModeType>('deathmatch');

  // Main menu - initialize with CLI settings
  const [mainMenu] = useState(() => {
    const menu = getMainMenu();
    menu.setInitialSettings(initialRenderMode, initialMSAAMode);
    return menu;
  });

  // Buy menu
  const [buyMenu] = useState(() => getBuyMenu());

  // Server browser
  const [serverBrowser] = useState(() => getServerBrowser());

  // Lobby screen
  const [lobbyScreen] = useState(() => getLobbyScreen());

  // Game client (network)
  const [gameClient] = useState(() => getGameClient());

  // NOTE: Device enumeration removed from early init
  // naudiodon.getDevices() can crash with segfault in some contexts
  // Devices will be enumerated lazily when settings menu is opened

  // Player ref
  const playerRef = useRef<Player>(new Player());

  // Mouse handler
  const [mouseHandler] = useState(() => {
    const width = stdout?.columns || 80;
    const height = stdout?.rows ? stdout.rows - 2 : 22;
    return new MouseHandler(width, height);
  });

  // Mouse sensitivity for native mouse input (radians per pixel)
  // Higher = faster camera movement. Default 0.004 is good for most users.
  const mouseSensitivityRef = useRef(0.004);

  // Physics state ref
  const physicsRef = useRef<PlayerPhysics>({
    velocityY: 0,
    onGround: true,
  });

  // Collision enabled ref (for debug toggle)
  const collisionEnabledRef = useRef(true);

  // Empty placeholder map until real map loads
  const EMPTY_MAP: LoadedMap = {
    name: 'Loading...',
    renderObjects: [],
    colliders: [],
    spawns: [{ position: [0, 2, 0], angle: 0, team: 'DM' as const }],
    bounds: { min: new Vector3(-100, -100, -100), max: new Vector3(100, 100, 100) },
    skyColor: new Color(50, 50, 80),
    ambientLight: 0.3,
  };

  // Map state - starts with placeholder, loaded asynchronously
  const loadedMapRef = useRef<LoadedMap>(EMPTY_MAP);
  const currentMapIdRef = useRef<string>('');
  const mapLoadingRef = useRef<boolean>(false);
  const mapLoadedRef = useRef<boolean>(false);

  // Collision mesh ref for triangle-based BSP collision
  const collisionMeshRef = useRef<CollisionMesh | null>(null);

  // Function to load a new map
  const loadMapAsync = async (mapId: string): Promise<boolean> => {
    if (mapLoadingRef.current) return false;
    mapLoadingRef.current = true;

    try {
      const newMap = await MapRegistry.loadMap(mapId);
      loadedMapRef.current = newMap;
      currentMapIdRef.current = mapId;

      // BSP maps must have a collision mesh
      if (!newMap.collisionMesh) {
        throw new Error(`Map ${mapId} has no collision mesh`);
      }
      collisionMeshRef.current = newMap.collisionMesh;
      setGlobalCollisionMesh(newMap.collisionMesh);

      // Update renderer with new map
      renderer.clearObjects();

      for (const obj of newMap.renderObjects) {
        renderer.addObject(obj);
      }

      // Update sky and lighting
      renderer.setClearColor(newMap.skyColor);
      renderer.getRasterizer().ambientLight = newMap.ambientLight;

      // Update bot spawns
      botManager.setSpawnPoints(newMap.spawns);

      mapLoadedRef.current = true;
      mapLoadingRef.current = false;
      return true;
    } catch (error) {
      consoleError(`Failed to load map ${mapId}: ${error}`);
      mapLoadingRef.current = false;
      return false;
    }
  };

  // Load default map on startup
  useEffect(() => {
    const loadDefaultMap = async () => {
      try {
        const defaultMapId = getDefaultMapId();
        consoleLog(`Loading default map: ${defaultMapId}`);
        await loadMapAsync(defaultMapId);
      } catch (error) {
        consoleError(`Failed to load default map: ${error}`);
      }
    };
    loadDefaultMap();
  }, []);

  // Bot manager (spawn points set when map loads)
  const [botManager] = useState(() => new BotManager());

  // Game mode ref (can be reconfigured when starting a new game)
  const gameModeRef = useRef<GameMode>(new GameMode({
    ...DEFAULT_DEATHMATCH_CONFIG,
    roundsToWin: 10,    // First to 10 round wins
    roundTime: 120,     // 2 minutes per round
    warmupTime: 3,      // 3 seconds warmup
  }));

  // Scoreboard visibility ref
  const showScoreboardRef = useRef(false);

  // Track player alive state for death sound
  const wasAliveRef = useRef(true);

  // Stdin-based key states (key -> last press timestamp) - fallback
  const keyTimesRef = useRef<Map<string, number>>(new Map());

  // Track if native keyboard is active
  const useNativeKeyboardRef = useRef(false);

  // Track mouse click fire request
  const mouseFireRef = useRef(false);

  // Track if we're in multiplayer mode
  const isMultiplayerRef = useRef(false);

  // Voice chat manager
  const voiceManagerRef = useRef<VoiceManager | null>(null);
  const speakingPlayersRef = useRef<Set<string>>(new Set());

  const [scene] = useState(() => {
    // Just use map objects (no ground plane - BSP maps have their own floors)
    return [...loadedMapRef.current.renderObjects];
  });

  // Set up scene
  useEffect(() => {
    for (const obj of scene) {
      renderer.addObject(obj);
    }
    renderer.showStats = true;

    // Set sky color from map
    renderer.setClearColor(loadedMapRef.current.skyColor);

    // Configure rasterizer (increased depth for larger map)
    renderer.getRasterizer().enableDepthShading = true;
    renderer.getRasterizer().enableLighting = true;
    renderer.getRasterizer().ambientLight = loadedMapRef.current.ambientLight;
    renderer.getRasterizer().maxDepth = 120;

    // Pick a random spawn point
    const spawn = loadedMapRef.current.spawns[Math.floor(Math.random() * loadedMapRef.current.spawns.length)];

    // Position camera at spawn, adjusted to valid ground
    const camera = renderer.getCamera();
    const rawSpawnPos = new Vector3(spawn.position[0], spawn.position[1], spawn.position[2]);
    const adjustedSpawn = collisionMeshRef.current
      ? adjustSpawnPosition(rawSpawnPos, collisionMeshRef.current)
      : rawSpawnPos;
    camera.setPosition(adjustedSpawn.x, adjustedSpawn.y + PLAYER_HEIGHT, adjustedSpawn.z);
    camera.setYaw(degToRad(spawn.angle));
    camera.setPitch(0);

    // Set up bot manager callbacks for tracers, kills, and player damage
    botManager.setTracerCallback((origin, endpoint) => {
      renderer.spawnTracer(origin, endpoint, 150);
    });
    botManager.setKillCallback((killer, victim, weapon, headshot) => {
      gameModeRef.current.registerKill(killer, victim, weapon, headshot, performance.now());
      consoleLog(`${killer} killed ${victim} with ${weapon}${headshot ? ' (headshot)' : ''}`);
    });
    botManager.setPlayerDamageCallback((attackerPos, damage, headshot) => {
      const player = playerRef.current;
      renderer.addDamageIndicator(attackerPos, player.position, player.yaw);
      playSound('player_hurt');
    });
    botManager.setBotSoundCallback((soundType, position) => {
      playSoundAt(soundType as SoundType, position);
    });

    // Don't spawn bots yet - wait until player starts game from menu

    // Set up main menu display (don't start game yet)
    renderer.setMainMenu(mainMenu, true);
    renderer.setBuyMenu(buyMenu);
    renderer.setServerBrowser(serverBrowser, false);
    renderer.setLobbyScreen(lobbyScreen, false);

    // Register console commands
    const gameConsole = getGameConsole();

    gameConsole.registerCommand('sensitivity', (args) => {
      if (args.length === 0) {
        return `Current sensitivity: ${mouseHandler.getState().captured ? 'captured' : 'not captured'}`;
      }
      const val = parseFloat(args[0]);
      if (isNaN(val) || val < 0.1 || val > 10) {
        return 'Usage: sensitivity <0.1-10>';
      }
      mouseHandler.setSensitivity(val);
      return `Sensitivity set to ${val}`;
    });

    gameConsole.registerCommand('fov', (args) => {
      if (args.length === 0) {
        return `Current FOV: ${Math.round(camera.fov * 180 / Math.PI)}°`;
      }
      const val = parseFloat(args[0]);
      if (isNaN(val) || val < 30 || val > 120) {
        return 'Usage: fov <30-120>';
      }
      camera.setFov(degToRad(val));
      return `FOV set to ${val}°`;
    });

    gameConsole.registerCommand('bot_add', (args) => {
      const difficulty = args[0] || 'medium';
      if (!['easy', 'medium', 'hard'].includes(difficulty)) {
        return 'Usage: bot_add [easy|medium|hard]';
      }
      botManager.spawnBots(1, difficulty as 'easy' | 'medium' | 'hard');
      return `Added 1 ${difficulty} bot`;
    });

    gameConsole.registerCommand('bot_kick', () => {
      const bots = botManager.getBots();
      if (bots.length === 0) {
        return 'No bots to kick';
      }
      botManager.clear();
      return 'All bots kicked';
    });

    gameConsole.registerCommand('god', () => {
      const player = playerRef.current;
      player.godMode = !player.godMode;
      return `God mode: ${player.godMode ? 'ON' : 'OFF'}`;
    });

    gameConsole.registerCommand('noclip', () => {
      const newState = !collisionEnabledRef.current;
      collisionEnabledRef.current = newState;
      setCollisionEnabled(newState);
      return `Noclip: ${newState ? 'OFF' : 'ON'}`;
    });

    gameConsole.registerCommand('give', (args) => {
      if (args.length === 0) {
        return 'Usage: give <knife|pistol|rifle|shotgun|sniper>';
      }
      const weapon = args[0].toLowerCase();
      const validWeapons = ['knife', 'pistol', 'rifle', 'shotgun', 'sniper'];
      if (!validWeapons.includes(weapon)) {
        return `Invalid weapon. Valid: ${validWeapons.join(', ')}`;
      }
      const player = playerRef.current;
      const slot = validWeapons.indexOf(weapon) + 1;
      player.selectWeapon(slot as WeaponSlot);
      return `Switched to ${weapon}`;
    });

    gameConsole.registerCommand('health', (args) => {
      const player = playerRef.current;
      if (args.length === 0) {
        return `Health: ${player.health}`;
      }
      const val = parseInt(args[0]);
      if (isNaN(val) || val < 0 || val > 100) {
        return 'Usage: health <0-100>';
      }
      player.health = val;
      return `Health set to ${val}`;
    });

    gameConsole.registerCommand('armor', (args) => {
      const player = playerRef.current;
      if (args.length === 0) {
        return `Armor: ${player.armor}`;
      }
      const val = parseInt(args[0]);
      if (isNaN(val) || val < 0 || val > 100) {
        return 'Usage: armor <0-100>';
      }
      player.armor = val;
      return `Armor set to ${val}`;
    });

    gameConsole.registerCommand('tp', (args) => {
      if (args.length < 3) {
        const pos = camera.position;
        return `Position: ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`;
      }
      const x = parseFloat(args[0]);
      const y = parseFloat(args[1]);
      const z = parseFloat(args[2]);
      if (isNaN(x) || isNaN(y) || isNaN(z)) {
        return 'Usage: tp <x> <y> <z>';
      }
      camera.setPosition(x, y, z);
      return `Teleported to ${x}, ${y}, ${z}`;
    });

    gameConsole.registerCommand('stats', () => {
      const player = playerRef.current;
      return `Kills: ${player.kills} | Deaths: ${player.deaths} | K/D: ${player.deaths > 0 ? (player.kills / player.deaths).toFixed(2) : player.kills}`;
    });

    gameConsole.registerCommand('bots', () => {
      const bots = botManager.getBots();
      if (bots.length === 0) {
        return 'No bots in game';
      }
      return bots.map(b => `${b.name}: ${b.health}hp, ${b.kills}K/${b.deaths}D`).join('\n');
    });

    // Log startup message
    consoleLog('CS-CLI v0.1.0 - Type "help" for commands');

    return () => {
      renderer.clearObjects();
      botManager.clear();
    };
  }, [renderer, scene, botManager]);

  // Track if we should exit
  const exitingRef = useRef(false);

  // Helper function for player fire logic
  const handlePlayerFire = (player: Player, weapon: ReturnType<Player['getCurrentWeapon']>, now: number) => {
    if (!weapon) return;

    const isKnife = weapon.def.type === 'knife';
    const eyePos = player.getEyePosition();
    const yaw = player.yaw;

    // Play weapon sound
    const weaponType = weapon.def.type;
    if (weaponType === 'pistol') playSound('shoot_pistol');
    else if (weaponType === 'rifle') playSound('shoot_rifle');
    else if (weaponType === 'shotgun') playSound('shoot_shotgun');
    else if (weaponType === 'sniper') playSound('shoot_sniper');

    if (isKnife) {
      // MELEE ATTACK
      const meleeRange = weapon.def.range;
      const spreadDir = player.getAimDirection();

      const botHit = botManager.checkPlayerHit(eyePos, spreadDir, weapon.def.damage, meleeRange);

      // Check if wall blocks the melee attack
      let wallHitDist = meleeRange + 1;
      if (collisionMeshRef.current) {
        const wallResult = raycastMesh(eyePos, spreadDir, collisionMeshRef.current, meleeRange + 1);
        if (wallResult.hit) {
          wallHitDist = wallResult.distance;
        }
      }

      if (botHit && botHit.distance <= meleeRange && botHit.distance < wallHitDist) {
        const damage = weapon.def.damage * (botHit.headshot ? weapon.def.headshotMultiplier : 1);
        const wasAlive = botHit.bot.isAlive;
        botHit.bot.takeDamage(damage, botHit.headshot);

        renderer.triggerHitMarker();
        playSound(botHit.headshot ? 'hit_headshot' : 'hit_enemy');

        if (wasAlive && !botHit.bot.isAlive) {
          // Drop bot's weapons on death
          botHit.bot.dropAllWeapons(now);
          player.kills++;
          player.awardKill(weapon.def.type);
          playSound('bot_death');
          gameModeRef.current.registerKill(player.name, botHit.bot.name, weapon.def.name, botHit.headshot, now);
          consoleLog(`You killed ${botHit.bot.name} with ${weapon.def.name}${botHit.headshot ? ' (headshot)' : ''}`);
        }
      }

      renderer.triggerMuzzleFlash(100);
    } else {
      // RANGED ATTACK
      renderer.triggerMuzzleFlash(80);

      const spreadDir = player.getAimDirection();
      const maxRange = weapon.def.range;

      const botHit = botManager.checkPlayerHit(eyePos, spreadDir, weapon.def.damage, maxRange);

      // Check wall hits FIRST using collision mesh (to not hit through walls)
      let wallHit: { distance: number; point: Vector3; normal: Vector3 } | null = null;
      if (collisionMeshRef.current) {
        const result = raycastMesh(eyePos, spreadDir, collisionMeshRef.current, maxRange);
        if (result.hit) {
          wallHit = { distance: result.distance, point: result.point, normal: result.normal };
        }
      }
      const effectiveRange = wallHit ? wallHit.distance : maxRange;

      // Check hits against remote players in lockstep mode
      // Use ray-cylinder intersection for proper hitbox detection
      let remoteHit: { playerId: string; distance: number; position: Vector3 } | null = null;
      const mpState = getMultiplayerState();
      if (mpState.isActive() && mpState.isLockstepMode()) {
        const playerRadius = 0.4; // ~40cm radius (80cm diameter)
        const playerHeight = 1.8; // ~1.8m tall

        for (const remote of mpState.getRemotePlayers()) {
          if (!remote.isAlive) continue;

          // remote.position is at eye level, calculate foot position
          const remoteFootY = remote.position.y - 1.7; // Eye height offset
          const remoteHeadY = remoteFootY + playerHeight;
          const remoteCenterXZ = new Vector3(remote.position.x, 0, remote.position.z);

          // Ray-cylinder intersection: solve for t where ray hits cylinder
          // Cylinder is infinite along Y, radius = playerRadius, centered at remote XZ
          const rayOriginXZ = new Vector3(eyePos.x, 0, eyePos.z);
          const rayDirXZ = new Vector3(spreadDir.x, 0, spreadDir.z);
          const rayDirXZLen = rayDirXZ.length();

          if (rayDirXZLen < 0.001) continue; // Ray is purely vertical

          const rayDirXZNorm = rayDirXZ.scale(1 / rayDirXZLen);
          const toCenter = Vector3.sub(remoteCenterXZ, rayOriginXZ);
          const projDist = Vector3.dot(toCenter, rayDirXZNorm);

          if (projDist < 0) continue; // Target is behind us

          const closestXZ = Vector3.add(rayOriginXZ, rayDirXZNorm.scale(projDist));
          const perpDistXZ = Vector3.distance(closestXZ, remoteCenterXZ);

          if (perpDistXZ > playerRadius) continue; // Miss - ray passes outside cylinder

          // Calculate actual 3D distance along ray
          const hitDist3D = projDist / rayDirXZLen * spreadDir.length();

          if (hitDist3D > effectiveRange) continue; // Beyond wall or max range

          // Check Y bounds - does ray hit within player height?
          const hitPoint = Vector3.add(eyePos, Vector3.scale(spreadDir, hitDist3D));
          if (hitPoint.y < remoteFootY || hitPoint.y > remoteHeadY) continue; // Above/below player

          // Valid hit!
          if (!remoteHit || hitDist3D < remoteHit.distance) {
            remoteHit = { playerId: remote.id, distance: hitDist3D, position: remote.position };
            consoleLog(`[HIT] Ray hit ${remote.id.slice(0,8)} at dist=${hitDist3D.toFixed(1)}`);
          }
        }
      }

      let hitPoint: Vector3;
      let hitWall = false;

      // Check remote player hit first (before bot and wall)
      if (remoteHit && (!botHit || remoteHit.distance < botHit.distance) && (!wallHit || remoteHit.distance < wallHit.distance)) {
        hitPoint = Vector3.add(eyePos, Vector3.scale(spreadDir, remoteHit.distance));
        renderer.triggerHitMarker();
        playSound('hit_enemy');

        // Calculate damage based on weapon and distance
        const baseDamage = weapon.def.damage;
        const damage = baseDamage; // Could add distance falloff here

        // Send hit action to server - SHOOTER determines hits
        const mpState = getMultiplayerState();
        if (mpState.isActive() && mpState.isLockstepMode()) {
          mpState.addLockstepAction({
            type: 'hit',
            data: {
              attackerId: mpState.getLocalPlayerId(),
              victimId: remoteHit.playerId,
              damage,
              headshot: false, // TODO: implement headshot detection
            },
          });
          consoleLog(`[SHOOTER] Hit ${remoteHit.playerId.slice(0, 8)} for ${damage} damage`);
        }
      } else if (botHit && (!wallHit || botHit.distance < wallHit.distance)) {
        const damage = weapon.def.damage * (botHit.headshot ? weapon.def.headshotMultiplier : 1);
        const wasAlive = botHit.bot.isAlive;
        botHit.bot.takeDamage(damage, botHit.headshot);
        hitPoint = Vector3.add(eyePos, Vector3.scale(spreadDir, botHit.distance));

        renderer.triggerHitMarker();
        playSound(botHit.headshot ? 'hit_headshot' : 'hit_enemy');

        if (wasAlive && !botHit.bot.isAlive) {
          // Drop bot's weapons on death
          botHit.bot.dropAllWeapons(now);
          player.kills++;
          player.awardKill(weapon.def.type);
          playSound('bot_death');
          gameModeRef.current.registerKill(player.name, botHit.bot.name, weapon.def.name, botHit.headshot, now);
          consoleLog(`You killed ${botHit.bot.name} with ${weapon.def.name}${botHit.headshot ? ' (headshot)' : ''}`);
        }
      } else if (wallHit) {
        hitPoint = wallHit.point;
        hitWall = true;
      } else {
        hitPoint = Vector3.add(eyePos, Vector3.scale(spreadDir, maxRange));
      }

      // Tracer
      const cosYaw = Math.cos(yaw);
      const sinYaw = Math.sin(yaw);
      const muzzlePos = new Vector3(
        eyePos.x + (-sinYaw * 0.8) + (cosYaw * 0.5),
        eyePos.y - 0.5,
        eyePos.z + (-cosYaw * 0.8) + (-sinYaw * 0.5)
      );
      renderer.spawnTracer(muzzlePos, hitPoint, 150);

      if (hitWall && wallHit) {
        renderer.spawnBulletDecal(wallHit.point, wallHit.normal);
      }
    }
  };

  // Set up raw input handling (mouse events, console, menu navigation)
  // Game input is handled by uiohook-napi KeyboardHandler for true key state
  useEffect(() => {
    const handleData = (data: Buffer) => {
      if (exitingRef.current) return;

      const physics = physicsRef.current;
      const str = data.toString();
      const now = performance.now();

      // Try to parse as mouse event first
      if (mouseHandler.parseMouseEvent(str)) {
        return;
      }

      const gameConsole = getGameConsole();

      // Toggle console with ~ or `
      if (str === '`' || str === '~') {
        gameConsole.toggle();
        if (gameConsole.getIsOpen()) {
          mouseHandler.release(); // Release mouse when console opens
        }
        return;
      }

      // If console is open, send input there
      if (gameConsole.getIsOpen()) {
        // Escape closes console
        if (str === '\x1b' && !str.startsWith('\x1b[')) {
          gameConsole.close();
          return;
        }
        gameConsole.handleKey(str);
        return;
      }

      // Main menu handling
      if (appModeRef.current === 'menu') {
        let key = str;
        // Map arrow keys
        if (str === '\x1b[A') key = 'up';
        else if (str === '\x1b[B') key = 'down';
        else if (str === '\r') key = 'enter';
        else if (str === '\x1b' && !str.startsWith('\x1b[')) key = 'escape';

        const result = mainMenu.handleKey(key);
        if (result.action === 'start_game' && result.mode && result.map) {
          // Load the selected map (async)
          const startGame = async () => {
            // Only load if different map selected
            if (result.map !== currentMapIdRef.current) {
              consoleLog(`Loading map: ${result.map}...`);
              const success = await loadMapAsync(result.map!);
              if (!success) {
                consoleError(`Failed to load map, staying on current map`);
              }
            }

            // Start the game with selected mode
            appModeRef.current = 'playing';
            gameModeTypeRef.current = result.mode!;

            // Configure game mode based on selection
            let config;
            if (result.mode === 'solo') {
              config = { ...DEFAULT_SOLO_CONFIG };
            } else if (result.mode === 'competitive') {
              config = { ...DEFAULT_COMPETITIVE_CONFIG, warmupTime: 5 };
            } else {
              config = { ...DEFAULT_DEATHMATCH_CONFIG, warmupTime: 3, freezeTime: 5 };  // Shorter times for DM
            }
            gameModeRef.current = new GameMode(config);

            // Reset team manager
            resetTeamManager();
            resetDroppedWeaponManager();

            // Spawn bots for the game (not in solo mode)
            botManager.clear();  // Clear any existing bots first
            if (result.mode !== 'solo') {
              botManager.spawnBots(6, 'medium');
            }

            // Set up teams if competitive mode
            const isTeamMode = result.mode === 'competitive';
            const isSoloMode = result.mode === 'solo';
            if (isTeamMode) {
              botManager.setTeamSpawnPoints(loadedMapRef.current.spawns);
              botManager.assignBotsToTeams(playerRef.current.name);
              const playerTeam = getTeamManager().getTeam(playerRef.current.name);
              playerRef.current.team = playerTeam || 'T';
            }

            // Respawn player at team spawn
            const player = playerRef.current;
            const spawns = isTeamMode
              ? loadedMapRef.current.spawns.filter(s => s.team === player.team || s.team === 'DM')
              : loadedMapRef.current.spawns;
            const spawn = spawns[Math.floor(Math.random() * spawns.length)];
            player.respawn(
              new Vector3(spawn.position[0], spawn.position[1], spawn.position[2]),
              degToRad(spawn.angle)
            );

            // Update camera
            const camera = renderer.getCamera();
            camera.setPosition(spawn.position[0], spawn.position[1] + PLAYER_HEIGHT, spawn.position[2]);
            camera.setYaw(degToRad(spawn.angle));
            camera.setPitch(0);

            // Respawn bots at team spawns (pass player for spread spawning)
            if (isTeamMode) {
              botManager.respawnAllBots(now, player);
            }

            // Disable respawns for round-based mode
            botManager.setRespawnEnabled(!isTeamMode);

            // Start game mode
            gameModeRef.current.startMatch(now);
          };

          startGame();

          // Hide main menu
          renderer.setMainMenu(mainMenu, false);

          // Enable mouse capture for gameplay
          mouseHandler.setAllowClickCapture(true);

          consoleLog(`Starting ${result.mode} game on ${result.map}`);
        } else if (result.action === 'multiplayer') {
          // Switch to server browser
          appModeRef.current = 'server_browser';
          renderer.setMainMenu(mainMenu, false);
          renderer.setServerBrowser(serverBrowser, true);
          serverBrowser.setConnecting();
          mouseHandler.setAllowClickCapture(false); // Disable click-to-capture in menus
          consoleLog('Opening server browser...');

          // Connect to game server
          const gameClient = getGameClient();
          const mpState = getMultiplayerState();

          gameClient.setCallbacks({
            onConnect: () => {
              serverBrowser.setConnected();
              consoleLog('Connected to server');
              gameClient.listRooms();
            },
            onDisconnect: (reason) => {
              serverBrowser.setError(`Disconnected: ${reason}`);
              consoleLog(`Disconnected: ${reason}`);
              // Deactivate multiplayer state on disconnect
              mpState.deactivate();
              isMultiplayerRef.current = false;
              // Clean up voice chat
              if (voiceManagerRef.current) {
                voiceManagerRef.current.destroy();
                voiceManagerRef.current = null;
                speakingPlayersRef.current.clear();
              }
            },
            onError: (error) => {
              serverBrowser.setError(error);
              consoleError(error);
            },
            onRoomList: (rooms) => {
              serverBrowser.updateRooms(rooms);
              consoleLog(`Found ${rooms.length} rooms`);
            },
            onRoomJoined: (roomId, playerId, room) => {
              consoleLog(`Joined room: ${room.name} as ${playerId}`);
              // Transition to lobby screen
              appModeRef.current = 'lobby';
              renderer.setServerBrowser(serverBrowser, false);
              renderer.setLobbyScreen(lobbyScreen, true);
              lobbyScreen.reset(); // Clear any previous state
              lobbyScreen.setRoomInfo(room);
              lobbyScreen.setLocalPlayerId(playerId);
              // Add ourselves to the player list
              const isHost = room.hostId === playerId; // Check actual host from server
              lobbyScreen.addPlayer(playerId, serverBrowser.getPlayerName(), isHost);

              // Initialize voice chat
              const voiceSettings = mainMenu.getSettings();
              if (voiceSettings.voiceEnabled) {
                const vm = new VoiceManager({
                  voiceEnabled: voiceSettings.voiceEnabled,
                  voiceInputVolume: voiceSettings.voiceInputVolume,
                  voiceOutputVolume: voiceSettings.voiceOutputVolume,
                  voiceInputDevice: voiceSettings.voiceInputDevice,
                  voicePTTEnabled: voiceSettings.voicePTTEnabled,
                  voicePTTKey: voiceSettings.voicePTTKey,
                  voiceVADSensitivity: voiceSettings.voiceVADSensitivity,
                  voiceMaxDistance: voiceSettings.voiceMaxDistance,
                  voiceSpatialEnabled: voiceSettings.voiceSpatialEnabled,
                });
                voiceManagerRef.current = vm;

                // Set up voice event handling
                vm.onEvent((event) => {
                  if (event.type === 'speaking-start' && event.playerId) {
                    speakingPlayersRef.current.add(event.playerId);
                  } else if (event.type === 'speaking-stop' && event.playerId) {
                    speakingPlayersRef.current.delete(event.playerId);
                  }
                });

                // Connect voice to network
                vm.setSendCallback((data) => gameClient.sendBinary(data));
                vm.setLocalPlayer(playerId);

                // Initialize and start
                vm.initialize().then(() => {
                  vm.start();
                  // Populate audio devices in settings menu
                  // NOTE: Device enumeration can crash in some contexts (naudiodon/portaudio)
                  // We defer it and wrap in try-catch - MicCapture now returns safe fallbacks
                  setTimeout(() => {
                    try {
                      mainMenu.setAudioDevices(
                        vm.getInputDevices(),
                        vm.getOutputDevices()
                      );
                    } catch (e) {
                      // Device enumeration failed - use defaults
                      mainMenu.setAudioDevices(
                        [{ id: 'default', name: 'Default Input' }],
                        [{ id: 'default', name: 'Default Output' }]
                      );
                    }
                  }, 100);  // Defer to avoid early crash
                }).catch(() => {
                  // Voice init failed - ignore
                });
              }
            },
            onRoomError: (error) => {
              serverBrowser.setError(error);
              consoleError(error);
            },
            onPlayerJoined: (playerId, playerName) => {
              lobbyScreen.addPlayer(playerId, playerName);
            },
            onPlayerLeft: (playerId, _playerName) => {
              lobbyScreen.removePlayer(playerId);
              // Remove from voice chat
              if (voiceManagerRef.current) {
                voiceManagerRef.current.removePlayer(playerId);
              }
            },
            onPlayerReady: (playerId, ready) => {
              lobbyScreen.setPlayerReady(playerId, ready);
            },
            onPlayerTeamChanged: (playerId, team) => {
              consoleLog(`[Team] Player ${playerId} changed to team ${team}`);
              lobbyScreen.setPlayerTeam(playerId, team);
            },
            onAssignedTeam: (team) => {
              lobbyScreen.setLocalTeam(team);
              playerRef.current.team = team;
              consoleLog(`Assigned to team: ${team}`);
            },
            // Game state from server (multiplayer)
            onGameState: (state) => {
              mpState.applyServerState(state);
              // Update local player's money and stats from server
              const localId = mpState.getLocalPlayerId();
              const localPlayerData = state.players.find(p => p.id === localId);
              if (localPlayerData) {
                playerRef.current.economy.setMoney(localPlayerData.money);
                playerRef.current.health = localPlayerData.health;
                playerRef.current.armor = localPlayerData.armor;
              }
              // Update voice spatial positions
              if (voiceManagerRef.current) {
                for (const player of state.players) {
                  if (player.id !== localId) {
                    voiceManagerRef.current.updatePlayerPosition(
                      player.id,
                      new Vector3(player.position.x, player.position.y, player.position.z)
                    );
                  }
                }
              }
            },
            // Input acknowledgement for client-side prediction
            onInputAck: (sequence, position) => {
              const correctedPos = mpState.acknowledgeInput(sequence, position);
              if (correctedPos) {
                // Significant drift detected - snap to server position
                const camera = renderer.getCamera();
                camera.setPosition(correctedPos.x, correctedPos.y, correctedPos.z);
                playerRef.current.position = correctedPos.clone();
              }
            },
            // Combat events for visual/audio effects
            onFireEvent: (event) => {
              mpState.queueFireEvent(event);
              // Play fire sound at position
              const pos = new Vector3(event.origin.x, event.origin.y, event.origin.z);
              const isLocal = event.playerId === mpState.getLocalPlayerId();
              if (!isLocal) {
                // Remote player fire - play sound at their position
                playSoundAt('shoot_rifle', pos);
              }
            },
            onHitEvent: (event) => {
              mpState.queueHitEvent(event);
              // If we hit someone, show hit marker
              const localId = mpState.getLocalPlayerId();
              if (event.attackerId === localId) {
                renderer.triggerHitMarker();
                playSound(event.headshot ? 'hit_headshot' : 'hit_enemy');
              }
              if (event.victimId === localId) {
                // We got hit - update health and play hurt sound
                playerRef.current.health -= event.damage;
                if (playerRef.current.health < 0) playerRef.current.health = 0;
                playSound('player_hurt');
              }
            },
            onKillEvent: (event) => {
              mpState.queueKillEvent(event);
              consoleLog(`${event.killerName} killed ${event.victimName} with ${event.weapon}${event.headshot ? ' (headshot)' : ''}`);
              // Update local player stats
              const localId = mpState.getLocalPlayerId();
              if (event.killerId === localId) {
                playerRef.current.kills++;
                playSound('bot_death');
              }
              if (event.victimId === localId) {
                // We died! Set local player state
                playerRef.current.deaths++;
                playerRef.current.health = 0;
                playerRef.current.isAlive = false;
                playSound('player_death');
              }
            },
            // Spawn event - handle respawn on new round
            onSpawnEvent: (entityId, entityType, position, team) => {
              const localId = mpState.getLocalPlayerId();
              if (entityId === localId) {
                // We respawned! Reset local player state
                const player = playerRef.current;
                player.isAlive = true;
                player.health = 100;
                player.armor = 0;
                // Update camera position
                const camera = renderer.getCamera();
                camera.setPosition(position.x, position.y, position.z);
                camera.setRoll(0);
                consoleLog(`Respawned at position (${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)})`);
              }
            },
            // Phase changes
            onPhaseChange: (phase, roundNumber, tScore, ctScore) => {
              consoleLog(`Phase: ${phase}, Round ${roundNumber} (T: ${tScore}, CT: ${ctScore})`);
            },
            // Game starting from lobby
            onGameStarting: async (countdown) => {
              consoleLog(`Game starting in ${countdown}...`);
              if (countdown <= 0) {
                // Load the map from room info
                const roomInfo = lobbyScreen.getRoomInfo();
                if (roomInfo && roomInfo.map !== currentMapIdRef.current) {
                  consoleLog(`Loading map: ${roomInfo.map}`);
                  const success = await loadMapAsync(roomInfo.map);
                  if (!success) {
                    consoleError(`Failed to load map: ${roomInfo.map}`);
                    return;
                  }
                }

                // Transition to gameplay
                appModeRef.current = 'playing';
                isMultiplayerRef.current = true;
                renderer.setLobbyScreen(lobbyScreen, false);
                mouseHandler.setAllowClickCapture(true);

                // Activate multiplayer state
                const playerId = gameClient.getPlayerId();
                if (playerId) {
                  mpState.activate(playerId);
                }

                // Clear local bots - we'll use server entities
                botManager.clear();

                consoleLog('Game started! You are now in multiplayer mode.');
              }
            },
            // Voice chat data (binary)
            onVoiceData: (data) => {
              if (voiceManagerRef.current) {
                voiceManagerRef.current.handleBinaryData(data);
              }
            },
            // Lockstep multiplayer callbacks
            onLockstepStart: (message) => {
              consoleLog(`[Lockstep] Game starting at tick ${message.tick} with ${message.players.length} players`);

              // Enable file logging for performance analysis
              const logFile = enableFileLogging();
              consoleLog(`[Logging] Performance log: ${logFile}`);
              getFileLogger().event('lockstep_start', { tick: message.tick, players: message.players.length });

              // Initialize lockstep simulation in multiplayer state
              mpState.initializeLockstep(message);

              // Each client is authoritative for their own position using their local BSP collision mesh
              if (!collisionMeshRef.current || collisionMeshRef.current.triangles.length === 0) {
                consoleError('[Lockstep] ERROR: No BSP collision mesh loaded! Cannot start lockstep.');
                return;
              }
              consoleLog(`[Lockstep] Using local BSP collision mesh (${collisionMeshRef.current.triangles.length} triangles)`);

              // Find our spawn position and set camera
              const localId = gameClient.getPlayerId();
              const localPlayer = message.players.find(p => p.id === localId);
              const playerIndex = message.players.findIndex(p => p.id === localId);
              if (localPlayer) {
                // Use BSP map's spawn points if available, otherwise fall back to server spawns
                // Server's DEFAULT_MAP spawns (Y=0.1) don't match BSP geometry
                let spawnPos: Vector3;
                let spawnYaw = localPlayer.spawnYaw;

                if (loadedMapRef.current && loadedMapRef.current.spawns.length > 0) {
                  // Use BSP map's spawn points - pick based on player index to avoid overlap
                  const bspSpawns = loadedMapRef.current.spawns;
                  const spawnIdx = playerIndex % bspSpawns.length;
                  const bspSpawn = bspSpawns[spawnIdx];

                  // BSP spawn position + eye height
                  const rawPos = new Vector3(bspSpawn.position[0], bspSpawn.position[1], bspSpawn.position[2]);
                  spawnPos = collisionMeshRef.current
                    ? adjustSpawnPosition(rawPos, collisionMeshRef.current)
                    : rawPos;
                  spawnPos.y += 1.7; // Add eye height
                  spawnYaw = bspSpawn.angle * Math.PI / 180; // Convert degrees to radians

                  consoleLog(`[Spawn] Using BSP spawn point ${spawnIdx} from ${bspSpawns.length} available`);
                } else {
                  // Fall back to server spawn position
                  const rawSpawnPos = new Vector3(
                    localPlayer.spawnPosition.x,
                    localPlayer.spawnPosition.y,
                    localPlayer.spawnPosition.z
                  );
                  spawnPos = collisionMeshRef.current
                    ? adjustSpawnPosition(rawSpawnPos, collisionMeshRef.current)
                    : rawSpawnPos;
                  consoleLog(`[Spawn] Using server spawn position (no BSP spawns available)`);
                }

                const spawnX = spawnPos.x;
                const spawnY = spawnPos.y;
                const spawnZ = spawnPos.z;

                consoleLog(`[Spawn] Local player at (${spawnX.toFixed(1)}, ${spawnY.toFixed(1)}, ${spawnZ.toFixed(1)}) team=${localPlayer.team}`);
                getFileLogger().event('spawn', {
                  x: spawnX.toFixed(1),
                  y: spawnY.toFixed(1),
                  z: spawnZ.toFixed(1),
                  team: localPlayer.team,
                });

                const camera = renderer.getCamera();
                camera.setPosition(spawnX, spawnY, spawnZ);
                camera.setYaw(spawnYaw);
                camera.setPitch(0);

                // Reset physics state for clean spawn
                physics.velocityY = 0;
                physics.onGround = true;

                // Update player ref position
                playerRef.current.position = new Vector3(spawnX, spawnY, spawnZ);
                playerRef.current.team = localPlayer.team;
                playerRef.current.isAlive = true;
                playerRef.current.health = 100;
              }
            },
            onLockstepTick: (message) => {
              // Apply tick - updates remote player positions from received data
              // (local player is authoritative for own position, handled by local physics)
              mpState.applyLockstepTick(message);

              // Debug: log tick receipt info
              const localId = mpState.getLocalPlayerId();
              const inputSummary = message.inputs.map(i =>
                `${i.playerId.slice(0, 8)}:${i.actions?.length || 0}acts`
              ).join(', ');
              const totalActions = message.inputs.reduce((sum, i) => sum + (i.actions?.length || 0), 0);
              if (totalActions > 0) {
                getFileLogger().event('tick_received', {
                  tick: message.tick,
                  inputCount: message.inputs.length,
                  totalActions,
                  inputs: inputSummary,
                  localId: localId?.slice(0, 8) || 'null',
                });
              }

              // Process fire actions from other players
              for (const playerInput of message.inputs) {
                if (playerInput.playerId === mpState.getLocalPlayerId()) continue;

                // Log remote player inputs with actions
                const actionCount = playerInput.actions?.length || 0;
                if (actionCount > 0) {
                  getFileLogger().event('remote_player_actions', {
                    from: playerInput.playerId.slice(0, 8),
                    actionCount,
                    types: playerInput.actions.map(a => a.type).join(','),
                    hasData: playerInput.actions.map(a => !!a.data).join(','),
                    rawActions: JSON.stringify(playerInput.actions),
                  });
                }

                for (const action of playerInput.actions || []) {
                  // Log ALL action types received
                  consoleLog(`[ACTION] Type=${action.type} from=${playerInput.playerId.slice(0,8)} hasData=${!!action.data}`);

                  if (action.type === 'fire') {
                    consoleLog(`[MP] Received FIRE action from ${playerInput.playerId.slice(0, 8)}`);
                    // Log what we actually received
                    getFileLogger().event('fire_action_check', {
                      type: action.type,
                      hasData: !!action.data,
                      dataKeys: action.data ? Object.keys(action.data).join(',') : 'none',
                    });
                  }
                  if (action.type === 'fire' && action.data) {
                    try {
                      const { origin, direction, weaponType } = action.data;
                      const originVec = new Vector3(origin.x, origin.y, origin.z);
                      const dirVec = new Vector3(direction.x, direction.y, direction.z);

                      // Play fire sound at remote player's position
                      if (weaponType === 'pistol') playSoundAt('shoot_pistol', originVec);
                      else if (weaponType === 'rifle') playSoundAt('shoot_rifle', originVec);
                      else if (weaponType === 'shotgun') playSoundAt('shoot_shotgun', originVec);
                      else if (weaponType === 'sniper') playSoundAt('shoot_sniper', originVec);

                      // Draw tracer from remote player
                      const tracerEndpoint = Vector3.add(originVec, Vector3.scale(dirVec.normalize(), 100));
                      renderer.spawnTracer(originVec, tracerEndpoint, 150);

                      // Log fire action received for debugging
                      getFileLogger().event('fire_received', {
                      from: playerInput.playerId.slice(0, 8),
                      origin: `${origin.x.toFixed(1)},${origin.y.toFixed(1)},${origin.z.toFixed(1)}`,
                      dir: `${direction.x.toFixed(2)},${direction.y.toFixed(2)},${direction.z.toFixed(2)}`,
                    });

                    // Note: Shooter determines hits and sends 'hit' actions
                    // Victim just plays fire sounds and shows tracers here
                    } catch (e: any) {
                      getFileLogger().event('fire_error', { error: e.message || String(e) });
                    }
                  }

                  // Handle hit action - shooter determined they hit someone
                  if (action.type === 'hit' && action.data) {
                    try {
                    const { attackerId, victimId, damage, headshot } = action.data;
                    const localId = mpState.getLocalPlayerId();

                    // Safety check - ensure we have valid data
                    if (!attackerId || !victimId || !localId) {
                      consoleLog(`[HIT-ERROR] Missing data: attackerId=${!!attackerId} victimId=${!!victimId} localId=${!!localId}`);
                      continue;
                    }

                    consoleLog(`[HIT-ACTION] Received: attacker=${attackerId.slice(0,8)} victim=${victimId.slice(0,8)} localId=${localId.slice(0,8)} damage=${damage}`);

                    // If we're the attacker, show hit marker and play hit sound
                    if (attackerId === localId) {
                      renderer.triggerHitMarker();
                      playSound(headshot ? 'hit_headshot' : 'hit_enemy');
                      consoleLog(`[HIT] Hit ${victimId.slice(0, 8)} for ${damage} damage`);
                      getFileLogger().event('hit_confirmed', {
                        victim: victimId.slice(0, 8),
                        damage,
                        headshot,
                      });
                    }

                    // If we're the victim, apply damage to ourselves
                    const isVictim = victimId === localId;
                    const isAlive = playerRef.current.isAlive;
                    consoleLog(`[HIT-ACTION] isVictim=${isVictim} isAlive=${isAlive}`);
                    if (isVictim && isAlive) {
                      const localPlayer = playerRef.current;
                      localPlayer.health -= damage;
                      playSound('player_hurt');
                      consoleLog(`[HIT] Took ${damage} damage from ${attackerId.slice(0, 8)} (health=${localPlayer.health})`);
                      getFileLogger().event('damage_received', {
                        attacker: attackerId.slice(0, 8),
                        damage,
                        health: localPlayer.health,
                      });

                      // Show damage indicator from attacker direction
                      const attackerRemote = mpState.getRemotePlayers().find(p => p.id === attackerId);
                      consoleLog(`[DAMAGE] Looking for attacker ${attackerId.slice(0,8)}, found=${!!attackerRemote}, remotePlayers=${mpState.getRemotePlayers().length}`);
                      if (attackerRemote) {
                        const attackerPos = new Vector3(
                          attackerRemote.position.x,
                          attackerRemote.position.y,
                          attackerRemote.position.z
                        );
                        const camera = renderer.getCamera();
                        renderer.addDamageIndicator(attackerPos, localPlayer.position, camera.yaw);
                        consoleLog(`[DAMAGE] Added damage indicator from (${attackerPos.x.toFixed(0)},${attackerPos.z.toFixed(0)})`);
                      } else {
                        consoleLog(`[DAMAGE] Attacker not found in remote players!`);
                      }

                      // Check if we died
                      consoleLog(`[DAMAGE] Health after damage: ${localPlayer.health}, checking death...`);
                      if (localPlayer.health <= 0) {
                        consoleLog(`[DEATH] Health <= 0, triggering death sequence!`);
                        localPlayer.health = 0;
                        localPlayer.isAlive = false;
                        localPlayer.deaths++;
                        const weaponType = 'pistol'; // TODO: get actual weapon from hit action

                        // Trigger death camera effect
                        consoleLog(`[DEATH] Calling renderer.setPlayerDead(true)`);
                        renderer.setPlayerDead(true, 0);

                        // Send death action to inform killer
                        mpState.addLockstepAction({
                          type: 'death',
                          data: {
                            killerId: attackerId,
                            victimId: localId,
                            weapon: weaponType,
                          },
                        });
                        consoleLog(`[DEATH] Killed by ${attackerId.slice(0, 8)}`);

                        // Respawn after delay
                        setTimeout(() => {
                          // Pick a random spawn point
                          let spawnPos: Vector3;
                          let spawnYaw = 0;

                          if (loadedMapRef.current && loadedMapRef.current.spawns.length > 0) {
                            const bspSpawns = loadedMapRef.current.spawns;
                            const spawnIdx = Math.floor(Math.random() * bspSpawns.length);
                            const bspSpawn = bspSpawns[spawnIdx];

                            // BSP spawn position + eye height
                            const rawPos = new Vector3(bspSpawn.position[0], bspSpawn.position[1], bspSpawn.position[2]);
                            spawnPos = collisionMeshRef.current
                              ? adjustSpawnPosition(rawPos, collisionMeshRef.current)
                              : rawPos;
                            spawnPos.y += 1.7; // Add eye height
                            spawnYaw = bspSpawn.angle * Math.PI / 180;
                          } else {
                            // Fallback to current position if no spawns available
                            spawnPos = localPlayer.position.clone();
                          }

                          // Teleport to spawn
                          localPlayer.position = spawnPos;
                          localPlayer.health = 100;
                          localPlayer.isAlive = true;

                          const camera = renderer.getCamera();
                          camera.setPosition(spawnPos.x, spawnPos.y, spawnPos.z);
                          camera.setYaw(spawnYaw);
                          camera.setPitch(0);

                          // Reset physics
                          physics.velocityY = 0;
                          physics.onGround = true;

                          // Reset death camera effect
                          renderer.setPlayerDead(false, 0);

                          consoleLog(`[RESPAWN] Respawned at (${spawnPos.x.toFixed(1)}, ${spawnPos.y.toFixed(1)}, ${spawnPos.z.toFixed(1)})`);
                        }, 3000);
                      }
                    }
                    } catch (e: any) {
                      consoleLog(`[HIT-ERROR] ${e.message || String(e)}`);
                      getFileLogger().event('hit_error', { error: e.message || String(e) });
                    }
                  }

                  // Handle death action - remote player died and is telling us who killed them
                  if (action.type === 'death' && action.data) {
                    const { killerId, victimId, weapon } = action.data;
                    const localId = mpState.getLocalPlayerId();

                    // If we're the killer, increment our kills
                    if (killerId === localId) {
                      const localPlayer = playerRef.current;
                      localPlayer.kills++;
                      playSound('bot_death'); // Kill confirmation sound
                      consoleLog(`[KILL] You killed ${victimId.slice(0, 8)} with ${weapon}!`);
                      getFileLogger().event('kill_confirmed', {
                        victim: victimId.slice(0, 8),
                        weapon,
                        totalKills: localPlayer.kills,
                      });
                    }
                  }
                }
              }

              // Update voice spatial positions for remote players
              if (voiceManagerRef.current) {
                for (const playerInput of message.inputs) {
                  if (playerInput.playerId !== mpState.getLocalPlayerId()) {
                    voiceManagerRef.current.updatePlayerPosition(
                      playerInput.playerId,
                      new Vector3(playerInput.position.x, playerInput.position.y, playerInput.position.z)
                    );
                  }
                }
              }
            },
            onLockstepDesync: (message) => {
              consoleError(`[Lockstep] DESYNC detected at tick ${message.tick}!`);
              consoleError(`  Expected: ${message.expectedHash}`);
              consoleError(`  Got: ${message.receivedHash}`);
              // TODO: Could implement resync by requesting full state from server
            },
          });

          gameClient.connect(DEFAULT_CLIENT_CONFIG.serverUrl).catch((err) => {
            serverBrowser.setError(`Failed to connect: ${err.message}`);
            consoleError(`Connection failed: ${err.message}`);
          });
        } else if (result.action === 'quit') {
          exitingRef.current = true;
          mouseHandler.disable();
          getSoundEngine().destroy();
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write(CURSOR_SHOW + ALT_SCREEN_OFF + RESET);
          process.exit(0);
        }
        return;
      }

      // Server browser handling
      if (appModeRef.current === 'server_browser') {
        let key = str;
        if (str === '\x1b[A') key = 'up';
        else if (str === '\x1b[B') key = 'down';
        else if (str === '\x1b[C') key = 'right';
        else if (str === '\x1b[D') key = 'left';
        else if (str === '\r') key = 'enter';
        else if (str === ' ') key = 'space';
        else if (str === '\x1b' && !str.startsWith('\x1b[')) key = 'escape';
        else if (str === '\x7f') key = 'backspace';

        const result = serverBrowser.handleKey(key);
        if (result.action === 'back') {
          // Go back to main menu
          appModeRef.current = 'menu';
          renderer.setServerBrowser(serverBrowser, false);
          renderer.setMainMenu(mainMenu, true);
          mainMenu.reset();
          mouseHandler.setAllowClickCapture(false); // Disable click capture in menu
          mouseHandler.release(); // Release mouse if captured
          // Disconnect from server
          const gameClient = getGameClient();
          gameClient.disconnect();
        } else if (result.action === 'create' && result.config) {
          // Create a room
          consoleLog(`Creating room: ${result.config.name}`);
          const gameClient = getGameClient();
          gameClient.createRoom(result.config);
        } else if (result.action === 'join' && result.roomId) {
          // Join a room
          consoleLog(`Joining room: ${result.roomId}`);
          const gameClient = getGameClient();
          gameClient.joinRoom(result.roomId);
        } else if (result.action === 'refresh') {
          // Refresh room list
          const gameClient = getGameClient();
          gameClient.listRooms();
        }
        return;
      }

      // Lobby handling
      if (appModeRef.current === 'lobby') {
        let key = str;
        if (str === '\r') key = 'enter';
        else if (str === '\x1b' && !str.startsWith('\x1b[')) key = 'escape';

        const result = lobbyScreen.handleKey(key);
        if (result.action === 'leave') {
          // Leave room and go back to server browser
          const gameClient = getGameClient();
          gameClient.leaveRoom();
          appModeRef.current = 'server_browser';
          renderer.setLobbyScreen(lobbyScreen, false);
          renderer.setServerBrowser(serverBrowser, true);
          lobbyScreen.reset();
          // Refresh room list
          gameClient.listRooms();
        } else if (result.action === 'ready') {
          // Toggle ready state and notify server
          const isReady = lobbyScreen.toggleReady();
          const gameClient = getGameClient();
          gameClient.setReady();
          consoleLog(isReady ? 'Ready!' : 'Unready');
        } else if (result.action === 'start') {
          // Host starts the game
          const gameClient = getGameClient();
          gameClient.startGame();
          consoleLog('Starting game...');
        } else if (result.action === 'team_t') {
          // Request team T
          const gameClient = getGameClient();
          gameClient.changeTeam('T');
          consoleLog('Requesting team T...');
        } else if (result.action === 'team_ct') {
          // Request team CT
          const gameClient = getGameClient();
          gameClient.changeTeam('CT');
          consoleLog('Requesting team CT...');
        }
        return;
      }

      // Buy menu handling (during freeze phase)
      if (buyMenu.isOpen()) {
        let key = str;
        if (str === '\x1b[A') key = 'up';
        else if (str === '\x1b[B') key = 'down';
        else if (str === '\x1b[C') key = 'right';
        else if (str === '\x1b[D') key = 'left';
        else if (str === '\r') key = 'enter';
        else if (str === '\x1b' && !str.startsWith('\x1b[')) key = 'escape';

        const result = buyMenu.handleKey(key);
        if (result.action === 'purchase' && result.result?.success) {
          consoleLog(result.result.message);
        }
        return;
      }

      // Check for quit (q key always quits, Esc releases mouse or quits if not captured)
      if (str === 'q') {
        exitingRef.current = true;
        mouseHandler.disable();
        getSoundEngine().destroy();
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write(CURSOR_SHOW + ALT_SCREEN_OFF + RESET);
        process.exit(0);
        return;
      }

      // Escape key - close buy menu, release mouse, or quit
      if (str === '\x1b' && !str.startsWith('\x1b[')) {
        if (buyMenu.isOpen()) {
          buyMenu.close();
        } else if (mouseHandler.isCaptured()) {
          mouseHandler.release();
        } else {
          exitingRef.current = true;
          mouseHandler.disable();
          getSoundEngine().destroy();
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write(CURSOR_SHOW + ALT_SCREEN_OFF + RESET);
          process.exit(0);
        }
        return;
      }

      // Track key states for game controls via stdin
      const keyTimes = keyTimesRef.current;
      const key = str.toLowerCase();

      // Movement keys (WASD + space)
      if (key === 'w' || key === 'a' || key === 's' || key === 'd' || key === ' ') {
        keyTimes.set(key, now);
      }

      // Arrow keys for look
      if (str === '\x1b[A') keyTimes.set('up', now);
      else if (str === '\x1b[B') keyTimes.set('down', now);
      else if (str === '\x1b[C') keyTimes.set('right', now);
      else if (str === '\x1b[D') keyTimes.set('left', now);

      // Fire key (F)
      if (key === 'f') {
        keyTimes.set('f', now);
      }

      // Reload (R)
      if (key === 'r') {
        const player = playerRef.current;
        if (player.reload(now)) {
          playSound('reload');
        }
      }

      // Tab for scoreboard
      if (str === '\t') {
        showScoreboardRef.current = !showScoreboardRef.current;
      }

      // B for buy menu (freeze phase only)
      const canBuyMP = isMultiplayerRef.current && getMultiplayerState().canBuy();
      const canBuySP = !isMultiplayerRef.current && gameModeRef.current.canBuy();
      if (key === 'b' && (canBuyMP || canBuySP)) {
        buyMenu.toggle(playerRef.current);
      }

      // C to toggle mouse capture (in game) or release (in menu)
      if (key === 'c') {
        if (appModeRef.current === 'playing') {
          if (mouseHandler.isCaptured()) {
            mouseHandler.release();
          } else {
            mouseHandler.capture();
          }
        } else if (mouseHandler.isCaptured()) {
          // In menu mode, only allow releasing, not capturing
          mouseHandler.release();
        }
      }

      // E for weapon pickup
      if (key === 'e') {
        const player = playerRef.current;
        const droppedWeaponManager = getDroppedWeaponManager();
        const nearby = droppedWeaponManager.getWeaponsNear(player.position, 2.5);
        if (nearby.length > 0) {
          const weaponState = droppedWeaponManager.toWeaponState(nearby[0]);
          if (weaponState) {
            // Only drop current weapon if we're not just adding ammo to same weapon type
            if (!player.wouldMergeAmmo(weaponState)) {
              player.dropWeaponInSlot(weaponState.def.slot, now);
            }
            const result = player.pickupWeapon(weaponState);
            droppedWeaponManager.removeWeapon(nearby[0].id);
            if (result === 'ammo_added') {
              consoleLog(`Picked up ammo for ${weaponState.def.name}`);
            } else {
              consoleLog(`Picked up ${weaponState.def.name}`);
            }
          }
        }
      }

      // Weapon slots (1-5)
      if (str >= '1' && str <= '5') {
        playerRef.current.selectWeapon(parseInt(str) as WeaponSlot);
      }
    };

    // Enable mouse tracking (user must click to capture)
    mouseHandler.enable();

    // Disable click-to-capture initially since we start in menu
    mouseHandler.setAllowClickCapture(false);

    // Set up mouse click handler for firing when captured
    mouseHandler.setOnClick((button, _x, _y) => {
      // Left click (button 0) fires when captured and in game
      if (button === 0 && mouseHandler.isCaptured() && appModeRef.current === 'playing') {
        mouseFireRef.current = true;
      }
    });

    // Set up capture state change handler for native cursor capture
    mouseHandler.setOnCapture((captured) => {
      // When native mouse is available, capture/release the system cursor
      if (isNativeMouseAvailable()) {
        setNativeCursorCaptured(captured);
      }
    });

    // Try to initialize native keyboard (falls back to stdin if unavailable)
    useNativeKeyboardRef.current = initNativeKeyboard();

    // Log input mode to game console and set main menu status
    const inputMode = getInputMode();
    const mainMenu = getMainMenu();

    // Set up settings change callback to update mouse sensitivity and render modes
    mainMenu.setOnSettingsChange((settings) => {
      mouseSensitivityRef.current = settings.mouseSensitivity;
      renderer.setRenderMode(settings.renderMode);
      renderer.setMSAAMode(settings.msaaMode);
      renderer.setTextureFilter(settings.textureFilter);
      renderer.setSixelResolution(settings.sixelResolution);
      renderer.setTargetFps(settings.targetFps);
      // Apply renderer backend setting (native SIMD or JavaScript)
      renderer.setUseNativeRenderer(settings.rendererBackend === 'native');
      // Update voice settings if voice manager exists
      if (voiceManagerRef.current) {
        voiceManagerRef.current.updateSettings({
          voiceEnabled: settings.voiceEnabled,
          voiceInputVolume: settings.voiceInputVolume,
          voiceOutputVolume: settings.voiceOutputVolume,
          voiceInputDevice: settings.voiceInputDevice,
          voiceVADSensitivity: settings.voiceVADSensitivity,
          voiceMaxDistance: settings.voiceMaxDistance,
          voiceSpatialEnabled: settings.voiceSpatialEnabled,
        });
      }
    });

    // Set up test audio callback
    mainMenu.setOnTestAudio(() => {
      // Play a test tone using NativeAudioPlayer (via VoicePlayback)
      const voicePlayback = getVoicePlayback();
      voicePlayback.playTestTone();
      // Reset test state after a short delay
      setTimeout(() => {
        mainMenu.setTestAudioActive(false);
      }, 600);
    });

    // Early device enumeration for audio settings
    // Initialize MicCapture to enumerate devices before joining a room
    initializeMicCapture().then((mic) => {
      const inputDevices = mic.getInputDevices();
      const outputDevices = mic.getOutputDevices();
      mainMenu.setAudioDevices(
        inputDevices.map(d => ({ id: d.id, name: d.name })),
        outputDevices.map(d => ({ id: d.id, name: d.name }))
      );
    }).catch(() => {
      // Device enumeration failed - use defaults
      mainMenu.setAudioDevices(
        [{ id: 'default', name: 'Default Input' }],
        [{ id: 'default', name: 'Default Output' }]
      );
    });

    // Apply initial settings (loaded from disk) including renderer backend
    const initialSettings = mainMenu.getSettings();
    mouseSensitivityRef.current = initialSettings.mouseSensitivity;
    renderer.setTextureFilter(initialSettings.textureFilter);
    renderer.setUseNativeRenderer(initialSettings.rendererBackend === 'native');

    if (inputMode === 'native') {
      // Enable native mouse mode - skip robotjs recentering, use CGEventTap delta
      if (isNativeMouseAvailable()) {
        mouseHandler.setNativeMouseMode(true);
      }

      mainMenu.setInputStatus({
        mode: 'native',
        working: true,
        message: 'CGEventTap active',
      });
      consoleLog('Input: Native (CGEventTap) - Ready');
    } else {
      mainMenu.setInputStatus({
        mode: 'stdin',
        working: true,
        message: 'Native unavailable',
      });
      consoleLog('Input: Stdin (fallback) - Native keyboard unavailable');
    }

    if (process.stdin.isTTY && process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', handleData);
    }

    return () => {
      mouseHandler.disable();
      setNativeCursorCaptured(false);  // Ensure cursor is released
      stopNativeKeyboard();
      if (process.stdin.isTTY && process.stdin.setRawMode) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.off('data', handleData);
      }
    };
  }, [mouseHandler]);

  // Game loop
  useEffect(() => {
    let running = true;
    let lastJumpTime = 0; // Prevent jump spam

    // Interpolation state for smooth rendering
    // We store previous and current positions, then interpolate between them
    const interpState = {
      prevX: 0, prevY: 0, prevZ: 0,
      currX: 0, currY: 0, currZ: 0,
      prevYaw: 0, currYaw: 0,
      prevPitch: 0, currPitch: 0,
    };

    // Initialize interpolation state from camera
    const initCamera = renderer.getCamera();
    interpState.prevX = interpState.currX = initCamera.position.x;
    interpState.prevY = interpState.currY = initCamera.position.y;
    interpState.prevZ = interpState.currZ = initCamera.position.z;
    interpState.prevYaw = interpState.currYaw = initCamera.yaw;
    interpState.prevPitch = interpState.currPitch = initCamera.pitch;

    // Get the GameLoop manager instance (handles fixed timestep physics)
    const gameLoopManager = getGameLoop();
    gameLoopManager.reset();

    // Helper: check if key is currently "held" via stdin (fallback)
    const isKeyHeld = (key: string, now: number): boolean => {
      const lastPress = keyTimesRef.current.get(key);
      return lastPress !== undefined && (now - lastPress) < KEY_HOLD_MS;
    };

    // ============ PHYSICS UPDATE (Fixed 60Hz) ============
    // This function runs at a fixed rate for consistent physics
    const physicsUpdate = (dt: number) => {
      // Use the fixed timestep dt for all physics calculations
      // This ensures consistent physics regardless of frame rate
      const now = performance.now();

      const camera = renderer.getCamera();
      const physics = physicsRef.current;
      const useNative = useNativeKeyboardRef.current && isNativeKeyboardAvailable();

      // Process keyboard input - native or stdin fallback
      let forward = 0;
      let strafe = 0;
      let lookYaw = 0;
      let lookPitch = 0;
      let jumpPressed = false;
      let firePressed = false;

      if (useNative) {
        // Native keyboard input (true key state)
        const movement = getNativeMovement();
        forward = movement.forward;
        strafe = movement.strafe;
        jumpPressed = movement.jump;

        const look = getNativeLook();
        lookYaw = look.yaw;
        lookPitch = look.pitch;

        // Native mouse button (left click = button 0) for firing when captured
        const nativeMouseFire = isNativeMouseAvailable() && mouseHandler.isCaptured() &&
          isNativeMouseButtonDown(MouseButton.Left);
        firePressed = isGameKeyDown('F') || mouseFireRef.current || nativeMouseFire;

        // Read native mouse delta NOW before updateNativeKeyboard() clears it
        if (isNativeMouseAvailable() && mouseHandler.isCaptured()) {
          const nativeDelta = getNativeMouseDelta();
          if (nativeDelta.x !== 0 || nativeDelta.y !== 0) {
            const yawDelta = -nativeDelta.x * mouseSensitivityRef.current;
            const pitchDelta = -nativeDelta.y * mouseSensitivityRef.current;
            camera.rotate(pitchDelta, yawDelta);
          }
        }

        // Handle weapon slots via native
        const slot = getNativeWeaponSlot();
        if (slot !== null) {
          playerRef.current.selectWeapon(slot as WeaponSlot);
        }

        // Handle other action keys via native
        if (wasGameKeyJustPressed('R')) {
          if (playerRef.current.reload(now)) {
            playSound('reload');
          }
        }

        if (wasGameKeyJustPressed('Tab')) {
          showScoreboardRef.current = !showScoreboardRef.current;
        }

        if (wasGameKeyJustPressed('B') && gameModeRef.current.canBuy()) {
          buyMenu.toggle(playerRef.current);
        }

        if (wasGameKeyJustPressed('C') && appModeRef.current === 'playing') {
          if (mouseHandler.isCaptured()) {
            mouseHandler.release();
          } else {
            mouseHandler.capture();
          }
        }

        if (wasGameKeyJustPressed('E')) {
          const player = playerRef.current;
          const droppedWeaponManager = getDroppedWeaponManager();
          const nearby = droppedWeaponManager.getWeaponsNear(player.position, 2.5);
          if (nearby.length > 0) {
            const weaponState = droppedWeaponManager.toWeaponState(nearby[0]);
            if (weaponState) {
              // Only drop current weapon if we're not just adding ammo to same weapon type
              if (!player.wouldMergeAmmo(weaponState)) {
                player.dropWeaponInSlot(weaponState.def.slot, now);
              }
              const result = player.pickupWeapon(weaponState);
              droppedWeaponManager.removeWeapon(nearby[0].id);
              if (result === 'ammo_added') {
                consoleLog(`Picked up ammo for ${weaponState.def.name}`);
              } else {
                consoleLog(`Picked up ${weaponState.def.name}`);
              }
            }
          }
        }

        // Push-to-talk voice chat (V key)
        if (voiceManagerRef.current) {
          const pttActive = isGameKeyDown('V');
          voiceManagerRef.current.setPTTActive(pttActive);
        }

        // Clear just pressed/released flags for next frame
        updateNativeKeyboard();
      } else {
        // Stdin fallback
        if (isKeyHeld('w', now)) forward += 1;
        if (isKeyHeld('s', now)) forward -= 1;
        if (isKeyHeld('a', now)) strafe -= 1;
        if (isKeyHeld('d', now)) strafe += 1;

        if (isKeyHeld('left', now)) lookYaw -= 1;
        if (isKeyHeld('right', now)) lookYaw += 1;
        if (isKeyHeld('up', now)) lookPitch += 1;
        if (isKeyHeld('down', now)) lookPitch -= 1;

        jumpPressed = isKeyHeld(' ', now);
        firePressed = isKeyHeld('f', now) || mouseFireRef.current;
      }

      // Clear mouse fire request after checking
      mouseFireRef.current = false;

      // Apply rotation from stdin mouse (fallback when native not available)
      // Native mouse is handled earlier in the native input block
      if (!isNativeMouseAvailable() && mouseHandler.isCaptured()) {
        const { pitch, yaw } = mouseHandler.getPitchYawDelta();
        if (pitch !== 0 || yaw !== 0) {
          camera.rotate(pitch, yaw);
        }
        mouseHandler.resetDelta();
      }

      // Apply rotation from keyboard (arrow keys)
      if (lookYaw !== 0) camera.rotate(0, -TURN_SPEED * dt * lookYaw);
      if (lookPitch !== 0) camera.rotate(TURN_SPEED * dt * lookPitch, 0);

      // Check if player is frozen (freeze phase in competitive mode)
      // Solo mode is never frozen
      // In multiplayer, use server-provided freeze state
      const isSoloModeMove = gameModeTypeRef.current === 'solo';
      const mpState = getMultiplayerState();
      const playerFrozen = isSoloModeMove ? false :
        (isMultiplayerRef.current && mpState.isActive() ? mpState.isPlayerFrozen() : gameModeRef.current.isPlayerFrozen());

      // Calculate movement direction (blocked during freeze phase)
      let moveForward = 0;
      let moveRight = 0;
      if (!playerFrozen) {
        moveForward = forward * MOVE_SPEED * dt;
        moveRight = strafe * MOVE_SPEED * dt;
      }

      // Handle jump (with cooldown to prevent spam from key repeat)
      if (jumpPressed && physics.onGround && (now - lastJumpTime) > 300) {
        physics.velocityY = JUMP_VELOCITY;
        physics.onGround = false;
        lastJumpTime = now;
        playSound('jump');
      }

      // Handle fire key (F) - continuous fire while held
      const gameConsole = getGameConsole();
      if (!gameConsole.getIsOpen() && appModeRef.current === 'playing') {
        const isFrozenMP = isMultiplayerRef.current && getMultiplayerState().isPlayerFrozen();
        const isFrozenSP = !isMultiplayerRef.current && !isSoloModeMove && gameModeRef.current.isPlayerFrozen();
        const isFrozen = isFrozenMP || isFrozenSP;

        if (firePressed && !isFrozen) {
          const player = playerRef.current;
          const weapon = player.getCurrentWeapon();

          if (isMultiplayerRef.current) {
            const mpState = getMultiplayerState();

            if (mpState.isLockstepMode()) {
              // Lockstep mode: add fire action and handle locally
              if (player.fire(now) && weapon) {
                // Add fire action to be sent with next tick
                const fireDir = camera.getForward();
                mpState.addLockstepAction({
                  type: 'fire',
                  data: {
                    origin: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
                    direction: { x: fireDir.x, y: fireDir.y, z: fireDir.z },
                    weaponType: weapon.def.type,
                  },
                });

                // Handle fire locally for immediate feedback
                handlePlayerFire(player, weapon, now);
              }
            } else {
              // Server-authoritative: send fire event to server
              if (player.fire(now) && weapon) {
                getGameClient().sendFire();
                // Play local fire sound immediately for responsiveness
                const weaponType = weapon.def.type;
                if (weaponType === 'pistol') playSound('shoot_pistol');
                else if (weaponType === 'rifle') playSound('shoot_rifle');
                else if (weaponType === 'shotgun') playSound('shoot_shotgun');
                else if (weaponType === 'sniper') playSound('shoot_sniper');
                renderer.triggerMuzzleFlash(80);
              }
            }
          } else {
            // Single player: handle fire locally
            if (player.fire(now) && weapon) {
              handlePlayerFire(player, weapon, now);
            }
          }
        }
      }

      // Get movement vector in world space
      const yaw = camera.yaw;
      const forwardDir = new Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const rightDir = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));

      // Build horizontal velocity (units per second)
      const horizontalSpeed = MOVE_SPEED;
      let velocityX = forwardDir.x * forward * horizontalSpeed + rightDir.x * strafe * horizontalSpeed;
      let velocityZ = forwardDir.z * forward * horizontalSpeed + rightDir.z * strafe * horizontalSpeed;

      // Apply gravity
      if (!physics.onGround) {
        physics.velocityY -= GRAVITY * dt;
      }

      // Get feet position (camera is at eye level)
      const feetPos = new Vector3(
        camera.position.x,
        camera.position.y - PLAYER_HEIGHT,
        camera.position.z
      );

      // Use BSP mesh collision (required)
      const collisionMesh = collisionMeshRef.current;
      let newFeetPos: Vector3;
      let newOnGround: boolean;

      if (collisionMesh && collisionMesh.triangles.length > 0 && collisionEnabledRef.current) {
        // Use triangle-based collision for BSP maps
        const velocity = new Vector3(velocityX, physics.velocityY, velocityZ);
        const result = moveWithMeshCollision(feetPos, velocity, collisionMesh, dt);
        newFeetPos = result.newPosition;
        physics.velocityY = result.newVelocity.y;
        newOnGround = result.onGround;
      } else {
        // No collision mesh - just apply movement directly (for loading screens, etc)
        newFeetPos = Vector3.add(feetPos, new Vector3(velocityX * dt, physics.velocityY * dt, velocityZ * dt));
        newOnGround = newFeetPos.y <= 0.1;
        if (newFeetPos.y < 0) newFeetPos.y = 0;
      }

      // Update camera position (convert feet to eye level)
      // Must use setPosition or translate to mark camera as dirty for matrix recalculation
      const newCameraY = newFeetPos.y + PLAYER_HEIGHT;
      camera.setPosition(newFeetPos.x, newCameraY, newFeetPos.z);

      // Update ground state
      const wasOnGround = physics.onGround;
      physics.onGround = newOnGround;

      // Reset vertical velocity when landing
      if (physics.onGround && !wasOnGround) {
        physics.velocityY = 0;
      }

      // Safety fallback - respawn if fell out of world
      // BSP maps can have floors at negative Y coordinates, but -50 is definitely out of bounds
      if (camera.position.y < -50) {
        // Player fell out of the world - reset to spawn
        const spawn = loadedMapRef.current.spawns[0] || { position: [0, 2, 0], angle: 0 };
        camera.setPosition(spawn.position[0], spawn.position[1] + PLAYER_HEIGHT, spawn.position[2]);
        physics.velocityY = 0;
        physics.onGround = true;
      }

      // Update player state
      const player = playerRef.current;
      player.position = camera.position.clone();
      player.yaw = camera.yaw;
      player.pitch = camera.pitch;
      player.updateWeapon(now);

      // Update sound engine listener position for spatial audio
      getSoundEngine().setListenerPosition(player.position, player.yaw);

      // Update voice chat listener position for spatial audio
      if (voiceManagerRef.current) {
        voiceManagerRef.current.updateLocalPosition(player.position, player.yaw);
      }

      // Multiplayer: send input to server and record for prediction
      const isMultiplayer = isMultiplayerRef.current;

      if (isMultiplayer && mpState.isActive()) {
        const gameClient = getGameClient();

        // Build input state
        const inputState = {
          forward: forward,
          strafe: strafe,
          yaw: camera.yaw,
          pitch: camera.pitch,
          jump: jumpPressed,
          crouch: false, // TODO: implement crouch
        };

        if (mpState.isLockstepMode()) {
          // Lockstep mode: client is authoritative for own position and health
          // Send input + our calculated position to server
          const tick = mpState.getCurrentTick();
          const actions = mpState.popPendingActions();
          if (actions.length > 0) {
            consoleLog(`[SEND] Sending ${actions.length} actions: ${actions.map(a => a.type).join(',')}, health=${player.health}`);
            getFileLogger().event('sending_actions', {
              tick,
              actionCount: actions.length,
              types: actions.map(a => a.type).join(','),
            });
          }
          gameClient.sendLockstepInput(
            tick,
            inputState,
            { x: player.position.x, y: player.position.y, z: player.position.z },
            camera.yaw,
            camera.pitch,
            player.health,
            player.isAlive,
            actions
          );
        } else {
          // Server-authoritative mode: use client-side prediction
          const sequence = mpState.getNextInputSequence();
          gameClient.sendInput(inputState);
          mpState.recordPendingInput(sequence, inputState, player.position);
          mpState.updateInterpolation(now);
        }
      }

      // Get weapon state for HUD
      const weapon = player.getCurrentWeapon();

      // Set weapon sprite (use fire sprite if muzzle flash active)
      if (weapon) {
        const weaponSprite = getWeaponSprite(weapon.def.type);
        const sprite = renderer.isMuzzleFlashActive() ? weaponSprite.fire : weaponSprite.idle;
        renderer.setWeaponSprite(sprite);
      }

      // Only run game logic when actually playing (not in menu)
      const isPlaying = appModeRef.current === 'playing';

      // Check game mode types
      const gameMode = gameModeRef.current;
      const isTeamMode = gameModeTypeRef.current === 'competitive';
      const isSoloMode = gameModeTypeRef.current === 'solo';

      // Check if player is frozen (freeze phase) - never frozen in solo mode
      const isPlayerFrozen = isSoloMode ? false : gameMode.isPlayerFrozen();
      // Bots are frozen in more phases than player (includes warmup)
      const areBotsFrozen = isSoloMode ? false : gameMode.areBotsFrozen();

      // Update bots only when playing (pass freeze and team mode info)
      // Skip all bot/game logic in solo mode - just free exploration
      if (isPlaying && !isSoloMode) {
        if (isMultiplayer && mpState.isActive()) {
          // Multiplayer mode: use server entities, skip local bot simulation
          // Game mode is handled by server, we just render what server tells us
        } else {
          // Single player mode: run local bot simulation
          // Bots use getGlobalCollisionMesh() for BSP collision, AABB param is deprecated
          botManager.update(player, [], now, dt, areBotsFrozen, isTeamMode);

          // Bot combat is now handled by BotManager.update() via callbacks

          // Update game mode
          gameMode.update(player, botManager.getBots(), now);
        }
      }

      // Handle death camera effect
      renderer.setPlayerDead(!player.isAlive, dt);
      if (!player.isAlive) {
        // Play death sound and drop weapons on transition to dead
        if (wasAliveRef.current) {
          playSound('player_death');
          wasAliveRef.current = false;

          // Drop weapons on death in competitive mode
          if (isTeamMode) {
            player.dropAllWeapons(now);
          }
        }
        // Apply death camera rotations - deliberate fall to side
        camera.setRoll(renderer.getDeathCameraRoll());

        // Apply death pitch - looking down at ground when head hits
        const deathPitch = renderer.getDeathCameraPitch();
        if (deathPitch > 0) {
          // Override pitch to look at ground (positive = looking down)
          camera.setPitch(-deathPitch);
        }

        // Lower camera toward ground with physics
        const dropAmount = renderer.getDeathCameraYDrop();
        if (dropAmount > 0) {
          const minY = 0.3; // Ground level for head
          const targetY = camera.position.y - dropAmount;
          const newY = Math.max(minY, targetY);
          camera.setPosition(camera.position.x, newY, camera.position.z);
        }
      } else {
        // Reset roll when alive
        camera.setRoll(0);
      }

      // Handle player respawn (not in solo mode - player is always alive)
      if (!isSoloMode && gameMode.shouldPlayerRespawn(player, now)) {
        // Use spread spawning - pick spawn far from bots
        const mapSpawns = loadedMapRef.current.spawns;
        const spawnPoints = mapSpawns.map(s => new Vector3(s.position[0], s.position[1], s.position[2]));
        const botPositions = botManager.getAllEntityPositions();
        const rawSpawnPos = botManager.getSpreadSpawnPoint(spawnPoints, botPositions);

        // Adjust spawn position to valid ground
        const spawnPos = collisionMeshRef.current
          ? adjustSpawnPosition(rawSpawnPos, collisionMeshRef.current)
          : rawSpawnPos;

        // Find the matching spawn point for angle
        const spawnIndex = spawnPoints.findIndex(s =>
          Math.abs(s.x - rawSpawnPos.x) < 0.1 && Math.abs(s.z - rawSpawnPos.z) < 0.1
        );
        const spawnAngle = spawnIndex >= 0 ? mapSpawns[spawnIndex].angle : 0;

        player.respawn(spawnPos, degToRad(spawnAngle));

        // Update camera position
        camera.setPosition(spawnPos.x, spawnPos.y + PLAYER_HEIGHT, spawnPos.z);
        camera.setYaw(degToRad(spawnAngle));
        camera.setPitch(0);
        camera.setRoll(0); // Reset roll on respawn

        playSound('spawn');
        wasAliveRef.current = true;
        gameMode.onPlayerRespawn();
      }

      // NOTE: interpState is updated in the render loop, not here
      // This allows proper interpolation across multiple physics ticks
    };  // End of physicsUpdate

    // Register physics callback with game loop manager
    gameLoopManager.setPhysicsCallback(physicsUpdate);

    // ============ RENDER LOOP (Variable rate with interpolation) ============
    // Performance tracking
    let frameCount = 0;
    let lastPerfLog = performance.now();

    const gameLoop = () => {
      if (!running) return;

      const now = performance.now();
      const camera = renderer.getCamera();
      const player = playerRef.current;
      const isMultiplayer = isMultiplayerRef.current;
      const mpState = getMultiplayerState();

      // Start game loop manager if not running
      if (!gameLoopManager['isRunning']) {
        gameLoopManager.start();
      }

      // Run fixed timestep physics
      // The gameLoopManager runs physicsUpdate at a fixed rate (60Hz)
      // and returns alpha for potential interpolation
      const alpha = gameLoopManager.tick();
      const physicsTicks = gameLoopManager.getPhysicsTicksThisFrame();

      // NOTE: For now, we skip interpolation because the camera is used for both
      // physics and rendering. With 60Hz physics, movement should be smooth enough.
      // Proper interpolation would require separating physics state from render state.

      // Performance logging to file (every second) and console (every 5 seconds)
      frameCount++;
      const fileLogger = getFileLogger();

      // Log to file every second for detailed analysis
      if (isMultiplayer && mpState.isActive() && fileLogger.isEnabled() && (now - lastPerfLog) > 1000) {
        const metrics = mpState.getPerformanceMetrics();
        const avgFPS = frameCount / ((now - lastPerfLog) / 1000);
        fileLogger.perf({
          fps: avgFPS,
          physicsTicks: physicsTicks,
          serverTickRate: metrics.tickRate,
          totalTicks: metrics.ticksReceived,
          frameTime: (now - lastPerfLog) / frameCount,
          alpha: alpha,
        });

        // Console log every 5 seconds
        if (metrics.ticksReceived % 300 < 60) {
          consoleDebug(`[Perf] FPS: ${avgFPS.toFixed(1)}, Physics/frame: ${physicsTicks}, Server tick rate: ${metrics.tickRate.toFixed(1)}Hz`);
        }

        frameCount = 0;
        lastPerfLog = now;
      }

      // Get delta time for render-related updates (not physics)
      const frameTime = 1 / 60; // Approximate for render updates

      // Get weapon state for HUD
      const weapon = player.getCurrentWeapon();

      // Check game mode types
      const gameMode = gameModeRef.current;
      const isTeamMode = gameModeTypeRef.current === 'competitive';
      const isSoloMode = gameModeTypeRef.current === 'solo';

      // Pass bots to renderer (use multiplayer entities or local bots)
      if (isMultiplayer && mpState.isActive()) {
        // Multiplayer: use remote entities from server
        // Interpolate lockstep positions for smooth movement
        if (mpState.isLockstepMode()) {
          mpState.interpolateLockstepPositions(frameTime);
        }
        renderer.setBots(mpState.getBotCompatibleEntities() as any);
      } else {
        // Single player: use local bots
        renderer.setBots(botManager.getBots());
      }

      // Set HUD data before rendering
      renderer.setHUD(
        player.health,
        player.armor,
        weapon?.currentAmmo ?? 0,
        weapon?.reserveAmmo ?? 0,
        weapon?.def.name ?? 'None',
        weapon?.isReloading ?? false
      );

      // Update voice chat speaking indicators
      if (voiceManagerRef.current) {
        const vm = voiceManagerRef.current;
        renderer.setMicStatus(
          vm.getMicLevel(),
          vm.isMicActive(),
          vm.getIsTransmitting()
        );
        // Use VoiceManager's speaking players directly (includes fallback names)
        const speakingPlayers = new Set(vm.getSpeakingPlayers());
        renderer.setSpeakingPlayers(speakingPlayers, vm.getIsTransmitting());
      }

      // Set game mode UI data (use multiplayer state when in multiplayer)
      if (isMultiplayer && mpState.isActive()) {
        // Multiplayer: use server-provided game state
        const scores = mpState.getScores();
        const phase = mpState.getPhase();

        // For now, skip local scoreboard in multiplayer - use server kill events
        renderer.setKillFeed([]);  // TODO: build kill feed from mpState events
        renderer.setShowScoreboard(showScoreboardRef.current);
        renderer.setGameState(
          phase,
          gameMode.formatTime(mpState.getRoundTime()),
          7,  // roundsToWin - server controlled
          null,  // matchWinner
          0,  // respawn countdown
          0   // warmup remaining
        );

        // Set freeze time from multiplayer state
        renderer.setFreezeTime(mpState.getFreezeTime());

        // Set team scores from server
        renderer.setTeamScores(scores.t, scores.ct, scores.round);
        renderer.setPlayerTeam(player.team);
        renderer.setPlayerMoney(player.economy.getMoney());
      } else if (isSoloMode) {
        // Solo mode: minimal UI, just exploration
        renderer.setKillFeed([]);
        renderer.setScoreboard([]);
        renderer.setShowScoreboard(false);
        renderer.setGameState(
          'live',  // Always live in solo
          '',      // No timer
          0,       // No rounds
          null,    // No winner
          0,       // No respawn countdown
          0        // No warmup
        );
        renderer.setFreezeTime(0);  // Never frozen
      } else {
        // Deathmatch/Competitive: use local game mode
        renderer.setKillFeed(gameMode.getKillFeed(now));
        renderer.setScoreboard(gameMode.getScoreboard(player, botManager.getBots()));
        renderer.setShowScoreboard(showScoreboardRef.current || gameMode.phase === 'match_end');
        renderer.setGameState(
          gameMode.phase,
          gameMode.formatTime(gameMode.getRoundTimeRemaining(now)),
          gameMode.config.roundsToWin,
          gameMode.matchWinner,
          gameMode.getRespawnCountdown(now),
          Math.ceil(gameMode.getWarmupRemaining(now))
        );

        // Set freeze time for ALL modes (not just competitive)
        renderer.setFreezeTime(gameMode.getFreezeTimeRemaining(now));

        // Set team-specific UI data for competitive mode
        if (isTeamMode) {
          renderer.setTeamScores(gameMode.round.tScore, gameMode.round.ctScore, gameMode.round.roundNumber);
          renderer.setPlayerTeam(player.team);
          renderer.setPlayerMoney(player.economy.getMoney());
        }
      }

      // Update dropped weapons in renderer
      const droppedWeaponManager = getDroppedWeaponManager();
      droppedWeaponManager.update(now);
      renderer.setDroppedWeapons(droppedWeaponManager.getAll());

      // Render
      const stats = renderer.render();

      // Update React state (for any React-based UI elements)
      setGameState({
        appMode: appModeRef.current,
        fps: stats.fps,
        frameTime: stats.frameTime,
        cameraPos: camera.position.clone(),
        cameraPitch: camera.pitch,
        cameraYaw: camera.yaw,
        mouseCaptured: mouseHandler.isCaptured(),
        health: player.health,
        armor: player.armor,
        ammo: weapon?.currentAmmo ?? 0,
        reserveAmmo: weapon?.reserveAmmo ?? 0,
        weaponName: weapon?.def.name ?? 'None',
        isReloading: weapon?.isReloading ?? false,
        money: player.economy.getMoney(),
        team: player.team,
      });

      // Use configurable frame rate cap from renderer
      const frameDelay = renderer.getFrameDelay();
      setTimeout(gameLoop, frameDelay || 1);
    };

    // Enter fullscreen mode
    process.stdout.write(ALT_SCREEN_ON + CURSOR_HIDE);

    gameLoop();

    return () => {
      running = false;
    };
  }, [renderer]);

  // The Ink component is just for handling input
  // Actual rendering is done directly to stdout
  return null;
}

// Main entry point
async function main() {
  // Parse command line arguments
  const options = parseArgs();

  // Handle --help
  if (options.help) {
    printHelp();
    process.exit(0);
  }

  // Handle --debug
  if (options.debug) {
    console.log(`Debug mode: render=${options.renderMode}, msaa=${options.msaaMode}`);
    await runDebugMode(options.renderMode, options.msaaMode);
    return;
  }

  // Handle --list-maps
  if (options.listMaps) {
    MapRegistry.initialize();
    const maps = MapRegistry.getAvailableMaps();
    console.log('\nAvailable maps:\n');
    for (const map of maps) {
      const modes = map.modes === 'both' ? 'DM/Comp' : map.modes === 'deathmatch' ? 'DM' : 'Comp';
      console.log(`  ${map.id.padEnd(15)} ${map.name.padEnd(25)} [${modes.padEnd(7)}] ${map.type}`);
    }
    console.log(`\nTotal: ${maps.length} maps`);
    console.log('\nUsage: cs-cli --map <id>');
    process.exit(0);
  }

  // Handle --debug-map / --map
  if (options.debugMap) {
    console.log(`Map debug mode: ${options.debugMap}`);
    await runMapDebugMode(options.debugMap, options.renderMode, options.msaaMode);
    return;
  }

  // Handle --vocoder / --voice-debug
  if (options.vocoderDebug) {
    console.log('Vocoder debug loopback mode');
    console.log('Press SPACE to record, ESC to exit');
    const { waitUntilExit } = render(
      <VocoderDebugUI onExit={() => process.exit(0)} />
    );
    await waitUntilExit();
    return;
  }

  // Log startup settings if non-default
  if (options.renderMode !== 'basic' || options.msaaMode !== 'none') {
    console.log(`Starting with: render=${options.renderMode}, msaa=${options.msaaMode}`);
  }

  // Start the game with CLI options
  const { waitUntilExit } = render(
    <Game
      initialRenderMode={options.renderMode}
      initialMSAAMode={options.msaaMode}
    />
  );
  await waitUntilExit();
}

main().catch(console.error);
