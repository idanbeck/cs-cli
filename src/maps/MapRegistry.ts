// MapRegistry - Central registry of available maps

import { MapLoader, LoadedMap } from './MapLoader.js';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export type MapType = 'bsp';
export type MapGameMode = 'deathmatch' | 'competitive' | 'both';

export interface MapInfo {
  id: string;
  name: string;
  type: MapType;
  modes: MapGameMode;
  description?: string;

  // For BSP maps
  bspPath?: string;
  wadPaths?: string[];
}

// BSP maps - Counter-Strike 1.6 classic maps
// More maps will be added in future updates
const BSP_MAPS: MapInfo[] = [
  {
    id: 'de_dust2',
    name: 'Dust II',
    type: 'bsp',
    modes: 'both',
    description: 'The legendary CS map',
    bspPath: 'assets/maps/de_dust2.bsp',
    wadPaths: ['assets/wads/cs_dust.wad', 'assets/wads/cstrike.wad'],
  },
  {
    id: 'de_dust',
    name: 'Dust',
    type: 'bsp',
    modes: 'both',
    description: 'The original Dust',
    bspPath: 'assets/maps/de_dust.bsp',
    wadPaths: ['assets/wads/cs_dust.wad', 'assets/wads/cstrike.wad'],
  },
  {
    id: 'de_inferno',
    name: 'Inferno',
    type: 'bsp',
    modes: 'both',
    description: 'Italian village bombsite',
    bspPath: 'assets/maps/de_inferno.bsp',
    wadPaths: ['assets/wads/cstrike.wad'],
  },
  {
    id: 'cs_italy',
    name: 'Italy',
    type: 'bsp',
    modes: 'both',
    description: 'Italian village hostage rescue',
    bspPath: 'assets/maps/cs_italy.bsp',
    wadPaths: ['assets/wads/itsitaly.wad', 'assets/wads/cstrike.wad'],
  },
];

export class MapRegistry {
  private static maps: Map<string, MapInfo> = new Map();
  private static initialized = false;

  // Initialize the registry
  static initialize(): void {
    if (this.initialized) return;

    // Add BSP maps
    for (const map of BSP_MAPS) {
      if (map.bspPath && this.checkMapExists(map.bspPath)) {
        this.maps.set(map.id, map);
      }
    }

    this.initialized = true;
  }

  // Check if a map file exists
  private static checkMapExists(relativePath: string): boolean {
    try {
      // Try multiple base paths
      const possiblePaths = [
        join(process.cwd(), relativePath),
        // From dist/maps/MapRegistry.js, go up 2 dirs to package root
        join(dirname(fileURLToPath(import.meta.url)), '../..', relativePath),
      ];

      for (const path of possiblePaths) {
        if (existsSync(path)) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  // Resolve a relative path to absolute
  private static resolvePath(relativePath: string): string {
    const possiblePaths = [
      join(process.cwd(), relativePath),
      // From dist/maps/MapRegistry.js, go up 2 dirs to package root
      join(dirname(fileURLToPath(import.meta.url)), '../..', relativePath),
    ];

    for (const path of possiblePaths) {
      if (existsSync(path)) {
        return path;
      }
    }
    return possiblePaths[0]; // Return first option even if doesn't exist
  }

  // Get all available maps
  static getAvailableMaps(): MapInfo[] {
    this.initialize();
    return Array.from(this.maps.values());
  }

  // Get maps by game mode
  static getMapsByMode(mode: 'deathmatch' | 'competitive'): MapInfo[] {
    this.initialize();
    return Array.from(this.maps.values()).filter(
      map => map.modes === 'both' || map.modes === mode
    );
  }

  // Get map info by ID
  static getMap(id: string): MapInfo | undefined {
    this.initialize();
    return this.maps.get(id);
  }

  // Load a map by ID
  static async loadMap(id: string): Promise<LoadedMap> {
    this.initialize();

    const mapInfo = this.maps.get(id);
    if (!mapInfo) {
      throw new Error(`Map not found: ${id}`);
    }

    if (!mapInfo.bspPath) {
      throw new Error(`Invalid map configuration: ${id}`);
    }

    const bspPath = this.resolvePath(mapInfo.bspPath);
    const wadPaths = mapInfo.wadPaths?.map(p => this.resolvePath(p));
    return MapLoader.loadBSP(bspPath, wadPaths);
  }

  // Register a custom map
  static registerMap(map: MapInfo): void {
    this.initialize();
    this.maps.set(map.id, map);
  }

  // Register a BSP map from a file path
  static registerBSPMap(
    id: string,
    name: string,
    bspPath: string,
    wadPaths?: string[],
    modes: MapGameMode = 'both'
  ): void {
    this.initialize();
    this.maps.set(id, {
      id,
      name,
      type: 'bsp',
      modes,
      bspPath,
      wadPaths,
    });
  }
}

// Export default maps list for UI
export function getDefaultMapId(): string {
  // Default to de_dust2 or first available BSP map
  MapRegistry.initialize();
  const maps = MapRegistry.getAvailableMaps();
  if (maps.length === 0) {
    throw new Error('No BSP maps available. Please add BSP maps to assets/maps/');
  }
  // Prefer de_dust2 if available
  const dust2 = maps.find(m => m.id === 'de_dust2');
  return dust2 ? dust2.id : maps[0].id;
}

export function getMapList(): { id: string; name: string }[] {
  return MapRegistry.getAvailableMaps().map(m => ({
    id: m.id,
    name: m.name,
  }));
}
