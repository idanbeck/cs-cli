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
} from './input/NativeKeyboard.js';

// Stdin-based key state tracking with timing (fallback)
// Keys are considered "held" for a short duration after each keypress
const KEY_HOLD_MS = 120; // How long a key stays "pressed" after last stdin event
import { MapLoader, LoadedMap } from './maps/MapLoader.js';
import { dm_arena } from './maps/maps/dm_arena.js';
import { AABB } from './maps/MapFormat.js';
import { moveAndSlide, checkOnGround, setCollisionEnabled, rayAABBIntersection } from './physics/Collision.js';
import { Player } from './game/Player.js';
import { WeaponSlot } from './game/Weapon.js';
import { getWeaponSprite } from './game/WeaponSprites.js';
import { BotManager } from './ai/BotManager.js';
import { GameMode, DEFAULT_DEATHMATCH_CONFIG, DEFAULT_COMPETITIVE_CONFIG, GameModeType } from './game/GameMode.js';
import { getSoundEngine, playSound, playSoundAt, SoundType } from './audio/SoundEngine.js';
import { getGameConsole, consoleLog, consoleWarn, consoleError, consoleDebug } from './ui/Console.js';
import { getMainMenu, MainMenu } from './ui/MainMenu.js';
import { getBuyMenu, BuyMenu } from './ui/BuyMenu.js';
import { getTeamManager, resetTeamManager, TeamId } from './game/Team.js';
import { getDroppedWeaponManager, resetDroppedWeaponManager } from './game/DroppedWeapon.js';

type AppMode = 'menu' | 'playing';

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
const PLAYER_HEIGHT = 1.7;

function Game() {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [renderer] = useState(() => {
    const width = stdout?.columns || 80;
    const height = stdout?.rows ? stdout.rows - 2 : 22;
    return new Renderer(width, height);
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

  // Main menu
  const [mainMenu] = useState(() => getMainMenu());

  // Buy menu
  const [buyMenu] = useState(() => getBuyMenu());

  // Player ref
  const playerRef = useRef<Player>(new Player());

  // Mouse handler
  const [mouseHandler] = useState(() => {
    const width = stdout?.columns || 80;
    const height = stdout?.rows ? stdout.rows - 2 : 22;
    return new MouseHandler(width, height);
  });

  // Physics state ref
  const physicsRef = useRef<PlayerPhysics>({
    velocityY: 0,
    onGround: true,
  });

  // Collision enabled ref (for debug toggle)
  const collisionEnabledRef = useRef(true);

  // Load map
  const [loadedMap] = useState<LoadedMap>(() => {
    return MapLoader.load(dm_arena);
  });

  // Colliders ref for physics
  const collidersRef = useRef<AABB[]>(loadedMap.colliders);

  // Bot manager
  const [botManager] = useState(() => {
    const manager = new BotManager();
    manager.setSpawnPoints(loadedMap.spawns);
    return manager;
  });

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

  const [scene] = useState(() => {
    const objects: RenderObject[] = [];

    // Add ground plane (larger for expanded map)
    const ground = MapLoader.createGroundPlane(140, 140, 'concrete_light', 32);
    objects.push(ground);

    // Add all map objects
    objects.push(...loadedMap.renderObjects);

    return objects;
  });

  // Set up scene
  useEffect(() => {
    for (const obj of scene) {
      renderer.addObject(obj);
    }
    renderer.showStats = true;

    // Set sky color from map
    renderer.setClearColor(loadedMap.skyColor);

    // Configure rasterizer (increased depth for larger map)
    renderer.getRasterizer().enableDepthShading = true;
    renderer.getRasterizer().enableLighting = true;
    renderer.getRasterizer().ambientLight = loadedMap.ambientLight;
    renderer.getRasterizer().maxDepth = 120;

    // Pick a random spawn point
    const spawn = loadedMap.spawns[Math.floor(Math.random() * loadedMap.spawns.length)];

    // Position camera at spawn
    const camera = renderer.getCamera();
    camera.setPosition(spawn.position[0], spawn.position[1] + PLAYER_HEIGHT, spawn.position[2]);
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
  }, [renderer, scene, loadedMap, botManager]);

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

      let wallHitDist = meleeRange + 1;
      for (const collider of collidersRef.current) {
        const result = rayAABBIntersection(eyePos, spreadDir, collider);
        if (result.hit && result.distance < wallHitDist) {
          wallHitDist = result.distance;
        }
      }

      if (botHit && botHit.distance <= meleeRange && botHit.distance < wallHitDist) {
        const damage = weapon.def.damage * (botHit.headshot ? weapon.def.headshotMultiplier : 1);
        const wasAlive = botHit.bot.isAlive;
        botHit.bot.takeDamage(damage, botHit.headshot);

        renderer.triggerHitMarker();
        playSound(botHit.headshot ? 'hit_headshot' : 'hit_enemy');

        if (wasAlive && !botHit.bot.isAlive) {
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

      let wallHit: { distance: number; point: Vector3; normal: Vector3 } | null = null;
      for (const collider of collidersRef.current) {
        const result = rayAABBIntersection(eyePos, spreadDir, collider);
        if (result.hit && (!wallHit || result.distance < wallHit.distance)) {
          wallHit = { distance: result.distance, point: result.point, normal: result.normal };
        }
      }

      let hitPoint: Vector3;
      let hitWall = false;

      if (botHit && (!wallHit || botHit.distance < wallHit.distance)) {
        const damage = weapon.def.damage * (botHit.headshot ? weapon.def.headshotMultiplier : 1);
        const wasAlive = botHit.bot.isAlive;
        botHit.bot.takeDamage(damage, botHit.headshot);
        hitPoint = Vector3.add(eyePos, Vector3.scale(spreadDir, botHit.distance));

        renderer.triggerHitMarker();
        playSound(botHit.headshot ? 'hit_headshot' : 'hit_enemy');

        if (wasAlive && !botHit.bot.isAlive) {
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
          // Start the game with selected mode
          appModeRef.current = 'playing';
          gameModeTypeRef.current = result.mode;

          // Configure game mode based on selection
          const config = result.mode === 'competitive'
            ? { ...DEFAULT_COMPETITIVE_CONFIG, warmupTime: 5 }
            : { ...DEFAULT_DEATHMATCH_CONFIG, warmupTime: 3, freezeTime: 5 };  // Shorter times for DM
          gameModeRef.current = new GameMode(config);

          // Reset team manager
          resetTeamManager();
          resetDroppedWeaponManager();

          // Spawn bots for the game
          botManager.clear();  // Clear any existing bots first
          botManager.spawnBots(6, 'medium');

          // Set up teams if competitive mode
          const isTeamMode = result.mode === 'competitive';
          if (isTeamMode) {
            botManager.setTeamSpawnPoints(loadedMap.spawns);
            botManager.assignBotsToTeams(playerRef.current.name);
            const playerTeam = getTeamManager().getTeam(playerRef.current.name);
            playerRef.current.team = playerTeam || 'T';
          }

          // Respawn player at team spawn
          const player = playerRef.current;
          const spawns = isTeamMode
            ? loadedMap.spawns.filter(s => s.team === player.team || s.team === 'DM')
            : loadedMap.spawns;
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

          // Respawn bots at team spawns
          if (isTeamMode) {
            botManager.respawnAllBots(now);
          }

          // Disable respawns for round-based mode
          botManager.setRespawnEnabled(!isTeamMode);

          // Start game mode
          gameModeRef.current.startMatch(now);

          // Hide main menu
          renderer.setMainMenu(mainMenu, false);

          consoleLog(`Starting ${result.mode} game on ${result.map}`);
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
      if (key === 'b' && gameModeRef.current.canBuy()) {
        buyMenu.toggle(playerRef.current);
      }

      // C to toggle mouse capture
      if (key === 'c') {
        if (mouseHandler.isCaptured()) {
          mouseHandler.release();
        } else {
          mouseHandler.capture();
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
            player.dropWeaponInSlot(weaponState.def.slot, now);
            player.pickupWeapon(weaponState);
            droppedWeaponManager.removeWeapon(nearby[0].id);
            consoleLog(`Picked up ${weaponState.def.name}`);
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

    // Try to initialize native keyboard (falls back to stdin if unavailable)
    useNativeKeyboardRef.current = initNativeKeyboard();

    // Log input mode to game console and set main menu status
    const inputMode = getInputMode();
    const mainMenu = getMainMenu();

    if (inputMode === 'native') {
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

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', handleData);

    return () => {
      mouseHandler.disable();
      stopNativeKeyboard();
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', handleData);
    };
  }, [mouseHandler]);

  // Game loop
  useEffect(() => {
    let running = true;
    let lastTime = performance.now();
    let lastJumpTime = 0; // Prevent jump spam

    // Helper: check if key is currently "held" via stdin (fallback)
    const isKeyHeld = (key: string, now: number): boolean => {
      const lastPress = keyTimesRef.current.get(key);
      return lastPress !== undefined && (now - lastPress) < KEY_HOLD_MS;
    };

    const gameLoop = () => {
      if (!running) return;

      const now = performance.now();
      const deltaTime = (now - lastTime) / 1000; // Convert to seconds
      lastTime = now;

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

        firePressed = isGameKeyDown('F');

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

        if (wasGameKeyJustPressed('C')) {
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
              player.dropWeaponInSlot(weaponState.def.slot, now);
              player.pickupWeapon(weaponState);
              droppedWeaponManager.removeWeapon(nearby[0].id);
              consoleLog(`Picked up ${weaponState.def.name}`);
            }
          }
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
        firePressed = isKeyHeld('f', now);
      }

      // Apply rotation from mouse (if captured)
      if (mouseHandler.isCaptured()) {
        const { pitch, yaw } = mouseHandler.getPitchYawDelta();
        if (pitch !== 0 || yaw !== 0) {
          camera.rotate(pitch, yaw);
        }
        mouseHandler.resetDelta();
      }

      // Apply rotation from keyboard (arrow keys)
      if (lookYaw !== 0) camera.rotate(0, -TURN_SPEED * deltaTime * lookYaw);
      if (lookPitch !== 0) camera.rotate(TURN_SPEED * deltaTime * lookPitch, 0);

      // Check if player is frozen (freeze phase in competitive mode)
      const playerFrozen = gameModeRef.current.isPlayerFrozen();

      // Calculate movement direction (blocked during freeze phase)
      let moveForward = 0;
      let moveRight = 0;
      if (!playerFrozen) {
        moveForward = forward * MOVE_SPEED * deltaTime;
        moveRight = strafe * MOVE_SPEED * deltaTime;
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
        if (firePressed && !gameModeRef.current.isPlayerFrozen()) {
          const player = playerRef.current;
          const weapon = player.getCurrentWeapon();
          if (player.fire(now) && weapon) {
            handlePlayerFire(player, weapon, now);
          }
        }
      }

      // Get movement vector in world space
      const yaw = camera.yaw;
      const forwardDir = new Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const rightDir = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));

      let movement = Vector3.zero();
      movement = Vector3.add(movement, Vector3.scale(forwardDir, moveForward));
      movement = Vector3.add(movement, Vector3.scale(rightDir, moveRight));

      // Apply gravity
      if (!physics.onGround) {
        physics.velocityY -= GRAVITY * deltaTime;
      }
      movement.y = physics.velocityY * deltaTime;

      // Get feet position (camera is at eye level)
      const feetPos = new Vector3(
        camera.position.x,
        camera.position.y - PLAYER_HEIGHT,
        camera.position.z
      );

      // Apply collision detection
      const newFeetPos = moveAndSlide(
        feetPos,
        movement,
        PLAYER_RADIUS,
        PLAYER_HEIGHT,
        collidersRef.current
      );

      // Update camera position (convert feet to eye level)
      // Must use setPosition or translate to mark camera as dirty for matrix recalculation
      const newCameraY = camera.position.y + (newFeetPos.y - feetPos.y);
      camera.setPosition(newFeetPos.x, newCameraY, newFeetPos.z);

      // Check if on ground
      const wasOnGround = physics.onGround;
      physics.onGround = checkOnGround(
        new Vector3(camera.position.x, camera.position.y - PLAYER_HEIGHT, camera.position.z),
        PLAYER_RADIUS,
        collidersRef.current
      );

      // Reset vertical velocity when landing
      if (physics.onGround && !wasOnGround) {
        physics.velocityY = 0;
      }

      // Clamp to ground level
      if (camera.position.y < PLAYER_HEIGHT) {
        camera.setPosition(camera.position.x, PLAYER_HEIGHT, camera.position.z);
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

      // Check if player is frozen (freeze phase)
      const gameMode = gameModeRef.current;
      const isTeamMode = gameModeTypeRef.current === 'competitive';
      const isFrozen = gameMode.isPlayerFrozen();

      // Update bots only when playing (pass freeze and team mode info)
      if (isPlaying) {
        botManager.update(player, collidersRef.current, now, deltaTime, isFrozen, isTeamMode);

        // Bot combat is now handled by BotManager.update() via callbacks

        // Update game mode
        gameMode.update(player, botManager.getBots(), now);
      }

      // Handle death camera effect
      renderer.setPlayerDead(!player.isAlive, deltaTime);
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
        // Apply death camera roll
        camera.setRoll(renderer.getDeathCameraRoll());

        // Lower camera toward ground
        const dropAmount = renderer.getDeathCameraYDrop();
        if (dropAmount > 0) {
          const minY = 0.3; // Ground level for head
          const newY = Math.max(minY, camera.position.y - dropAmount * deltaTime * 2);
          camera.setPosition(camera.position.x, newY, camera.position.z);
        }
      } else {
        // Reset roll when alive
        camera.setRoll(0);
      }

      // Handle player respawn
      if (gameMode.shouldPlayerRespawn(player, now)) {
        const spawn = loadedMap.spawns[Math.floor(Math.random() * loadedMap.spawns.length)];
        player.respawn(
          new Vector3(spawn.position[0], spawn.position[1], spawn.position[2]),
          degToRad(spawn.angle)
        );

        // Update camera position
        camera.setPosition(spawn.position[0], spawn.position[1] + PLAYER_HEIGHT, spawn.position[2]);
        camera.setYaw(degToRad(spawn.angle));
        camera.setPitch(0);
        camera.setRoll(0); // Reset roll on respawn

        playSound('spawn');
        wasAliveRef.current = true;
        gameMode.onPlayerRespawn();
      }

      // Pass bots to renderer
      renderer.setBots(botManager.getBots());

      // Set HUD data before rendering
      renderer.setHUD(
        player.health,
        player.armor,
        weapon?.currentAmmo ?? 0,
        weapon?.reserveAmmo ?? 0,
        weapon?.def.name ?? 'None',
        weapon?.isReloading ?? false
      );

      // Set game mode UI data
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

      // Target ~60 FPS for smoother input
      const targetFrameTime = 1000 / 60;
      const sleepTime = Math.max(0, targetFrameTime - (performance.now() - now));
      setTimeout(gameLoop, sleepTime);
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
  // Go straight to GUI - press H in main menu for help
  const { waitUntilExit } = render(<Game />);
  await waitUntilExit();
}

main().catch(console.error);
