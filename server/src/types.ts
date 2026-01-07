// Server-specific type definitions for CS-CLI multiplayer

import { WebSocket } from 'ws';
import {
  RoomConfig,
  TeamId,
  Vec3,
  PlayerInput,
  GamePhase,
  WeaponType,
  BotDifficulty
} from './protocol.js';

// ============ Server Configuration ============

export interface ServerConfig {
  port: number;
  tickRate: number;           // Game logic Hz (default: 60)
  broadcastRate: number;      // State sync Hz (default: 20)
  maxRooms: number;           // Maximum concurrent rooms
  maxPlayersPerRoom: number;  // Maximum players per room
  roomIdleTimeout: number;    // Ms before empty room is removed
}

export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  port: 8080,
  tickRate: 60,
  broadcastRate: 20,
  maxRooms: 100,
  maxPlayersPerRoom: 10,
  roomIdleTimeout: 300000,  // 5 minutes
};

// ============ Connected Client ============

export interface ConnectedClient {
  id: string;
  socket: WebSocket;
  name: string | null;
  roomId: string | null;
  isReady: boolean;
  lastActivity: number;
  // Pending inputs for reconciliation
  pendingInputs: Array<{ sequence: number; input: PlayerInput }>;
}

// ============ Server Player State ============

export interface ServerPlayerState {
  id: string;
  name: string;
  team: TeamId;

  // Position and physics
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  pitch: number;

  // Stats
  health: number;
  armor: number;
  isAlive: boolean;

  // Weapons
  currentWeapon: WeaponType;
  weapons: Map<number, ServerWeaponState>;

  // Economy
  money: number;

  // Combat stats
  kills: number;
  deaths: number;

  // Last acknowledged input sequence
  lastInputSequence: number;
}

export interface ServerWeaponState {
  type: WeaponType;
  currentAmmo: number;
  reserveAmmo: number;
  isReloading: boolean;
  reloadStartTime: number;
  lastFireTime: number;
}

// ============ Server Bot State ============

export interface ServerBotState {
  id: string;
  name: string;
  team: TeamId;
  difficulty: BotDifficulty;

  // Position and physics
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  pitch: number;

  // Stats
  health: number;
  armor: number;
  isAlive: boolean;

  // Weapons
  currentWeapon: WeaponType;

  // Combat stats
  kills: number;
  deaths: number;

  // AI state
  targetId: string | null;
  lastTargetSeen: number;
  wanderAngle: number;
  nextFireTime: number;
}

// ============ Dropped Weapon ============

export interface ServerDroppedWeapon {
  id: string;
  weaponType: WeaponType;
  position: Vec3;
  ammo: number;
  reserveAmmo: number;
  dropTime: number;
}

// ============ Spawn Points ============

export interface SpawnPoint {
  position: Vec3;
  angle: number;
  team: TeamId | 'DM';  // DM = deathmatch (any team)
}

// ============ Map Data ============

export interface MapCollider {
  min: Vec3;
  max: Vec3;
}

export interface MapData {
  id: string;
  name: string;
  spawnPoints: SpawnPoint[];
  colliders: MapCollider[];
  bounds: {
    min: Vec3;
    max: Vec3;
  };
}

// ============ Game State ============

export interface ServerGameState {
  phase: GamePhase;
  phaseStartTime: number;

  // Round state
  roundNumber: number;
  tScore: number;
  ctScore: number;
  roundWinner: TeamId | null;

  // Players and bots
  players: Map<string, ServerPlayerState>;
  bots: Map<string, ServerBotState>;
  droppedWeapons: Map<string, ServerDroppedWeapon>;

  // Timing
  tick: number;
  lastBroadcastTick: number;
}

// ============ Room State ============

export interface RoomState {
  id: string;
  config: RoomConfig;
  hostId: string;
  createdAt: number;
  lastActivity: number;

  // Connected players
  clients: Map<string, ConnectedClient>;

  // Game state
  gameState: ServerGameState | null;
  gameLoopInterval: ReturnType<typeof setInterval> | null;
  broadcastInterval: ReturnType<typeof setInterval> | null;

  // Map data
  mapData: MapData;
}

// ============ Hit Detection ============

export interface RaycastHit {
  entityId: string;
  entityType: 'player' | 'bot';
  distance: number;
  hitPoint: Vec3;
  isHeadshot: boolean;
}

// ============ Economy Config ============

export interface ServerEconomyConfig {
  startMoney: number;
  maxMoney: number;
  roundWinBonus: number;
  roundLoseBonus: number;
  roundLoseStreakBonus: number;
  maxLoseStreak: number;
  killReward: Record<WeaponType, number>;
}

export const DEFAULT_ECONOMY_CONFIG: ServerEconomyConfig = {
  startMoney: 800,
  maxMoney: 16000,
  roundWinBonus: 3250,
  roundLoseBonus: 1400,
  roundLoseStreakBonus: 500,
  maxLoseStreak: 4,
  killReward: {
    knife: 1500,
    pistol: 300,
    rifle: 300,
    shotgun: 900,
    sniper: 100,
  },
};

// ============ Weapon Definitions ============

export interface ServerWeaponDef {
  type: WeaponType;
  name: string;
  slot: number;
  damage: number;
  fireRate: number;
  reloadTime: number;
  magazineSize: number;
  reserveAmmo: number;
  spread: number;
  range: number;
  moveSpeed: number;
  pellets: number;
  isAutomatic: boolean;
  headshotMultiplier: number;
  cost: number;
}

export const WEAPON_DEFS: Record<WeaponType, ServerWeaponDef> = {
  knife: {
    type: 'knife',
    name: 'Knife',
    slot: 3,
    damage: 40,
    fireRate: 60,
    reloadTime: 0,
    magazineSize: Infinity,
    reserveAmmo: Infinity,
    spread: 0,
    range: 2,
    moveSpeed: 1.0,
    pellets: 1,
    isAutomatic: false,
    headshotMultiplier: 1.0,
    cost: 0,
  },
  pistol: {
    type: 'pistol',
    name: 'Pistol',
    slot: 2,
    damage: 25,
    fireRate: 400,
    reloadTime: 2.2,
    magazineSize: 12,
    reserveAmmo: 36,
    spread: 2,
    range: 50,
    moveSpeed: 1.0,
    pellets: 1,
    isAutomatic: false,
    headshotMultiplier: 2.0,
    cost: 200,
  },
  rifle: {
    type: 'rifle',
    name: 'Rifle',
    slot: 1,
    damage: 30,
    fireRate: 600,
    reloadTime: 2.5,
    magazineSize: 30,
    reserveAmmo: 90,
    spread: 3,
    range: 80,
    moveSpeed: 0.9,
    pellets: 1,
    isAutomatic: true,
    headshotMultiplier: 2.5,
    cost: 2700,
  },
  shotgun: {
    type: 'shotgun',
    name: 'Shotgun',
    slot: 1,
    damage: 20,
    fireRate: 70,
    reloadTime: 0.5,
    magazineSize: 8,
    reserveAmmo: 32,
    spread: 8,
    range: 20,
    moveSpeed: 0.9,
    pellets: 8,
    isAutomatic: false,
    headshotMultiplier: 1.5,
    cost: 1200,
  },
  sniper: {
    type: 'sniper',
    name: 'Sniper',
    slot: 1,
    damage: 100,
    fireRate: 40,
    reloadTime: 3.5,
    magazineSize: 5,
    reserveAmmo: 20,
    spread: 0.5,
    range: 150,
    moveSpeed: 0.8,
    pellets: 1,
    isAutomatic: false,
    headshotMultiplier: 4.0,
    cost: 4750,
  },
};

// ============ Utility Functions ============

export function createVec3(x: number = 0, y: number = 0, z: number = 0): Vec3 {
  return { x, y, z };
}

export function vec3Add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function vec3Sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function vec3Scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function vec3Length(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

export function vec3Normalize(v: Vec3): Vec3 {
  const len = vec3Length(v);
  if (len === 0) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

export function vec3Distance(a: Vec3, b: Vec3): number {
  return vec3Length(vec3Sub(a, b));
}

export function vec3Dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
