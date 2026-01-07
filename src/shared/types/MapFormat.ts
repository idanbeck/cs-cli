// Map format definitions for CS-CLI

import { Vector3 } from '../math/Vector3.js';

// Axis-Aligned Bounding Box for collision
export interface AABB {
  min: Vector3;
  max: Vector3;
}

// A brush is a convex solid - the basic building block of maps
export interface BrushDef {
  position: [number, number, number];
  size: [number, number, number];
  material: string;
  collision?: boolean;  // Default true
}

// Spawn point definition
export interface SpawnPoint {
  position: [number, number, number];
  angle: number;  // Yaw in degrees
  team?: 'T' | 'CT' | 'DM';  // Team for team-based modes, DM for deathmatch
}

// Light definition (for future use)
export interface LightDef {
  position: [number, number, number];
  color: [number, number, number];
  intensity: number;
  radius: number;
}

// Buy zone definition - area where players can purchase weapons
export interface BuyZoneDef {
  position: [number, number, number];
  size: [number, number, number];
  team: 'T' | 'CT';
}

// Game mode type
export type MapGameMode = 'deathmatch' | 'competitive';

// Complete map definition
export interface MapDef {
  name: string;
  author?: string;
  description?: string;

  // Supported game modes
  supportedModes?: MapGameMode[];

  // World bounds (for AI navigation, etc.)
  bounds: {
    min: [number, number, number];
    max: [number, number, number];
  };

  // Sky/ambient settings
  environment: {
    skyColor: [number, number, number];
    ambientLight: number;
    fogDistance?: number;
  };

  // Geometry
  brushes: BrushDef[];

  // Spawn points
  spawns: SpawnPoint[];

  // Buy zones (optional, for competitive mode)
  buyZones?: BuyZoneDef[];

  // Lights (optional)
  lights?: LightDef[];
}

// Material definitions with colors
export const MATERIALS: Record<string, [number, number, number]> = {
  // Floors
  'concrete': [100, 100, 100],
  'concrete_light': [140, 140, 140],
  'concrete_dark': [60, 60, 60],
  'tile': [180, 170, 160],
  'metal_floor': [120, 125, 130],
  'wood': [139, 90, 43],
  'dirt': [101, 67, 33],
  'grass': [76, 115, 60],
  'sand': [194, 178, 128],

  // Walls
  'brick': [140, 80, 60],
  'brick_dark': [100, 55, 40],
  'plaster': [200, 195, 185],
  'metal': [140, 145, 150],
  'metal_rust': [150, 90, 60],

  // Objects
  'crate': [160, 120, 60],
  'crate_dark': [120, 90, 45],
  'barrel': [80, 85, 90],

  // Special
  'red': [180, 50, 50],
  'green': [50, 150, 50],
  'blue': [50, 80, 180],
  'yellow': [200, 180, 50],
  'orange': [200, 120, 40],
};
