// MapRegistry - Central registry of available maps

import { MapLoader, LoadedMap } from './MapLoader.js';
import { MapDef } from './MapFormat.js';
import { dm_arena } from './maps/dm_arena.js';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export type MapType = 'brushdef' | 'bsp';
export type MapGameMode = 'deathmatch' | 'competitive' | 'both';

export interface MapInfo {
  id: string;
  name: string;
  type: MapType;
  modes: MapGameMode;
  description?: string;

  // For brushdef maps
  def?: MapDef;

  // For BSP maps
  bspPath?: string;
  wadPaths?: string[];
}

// Built-in maps
const BUILTIN_MAPS: MapInfo[] = [
  {
    id: 'dm_arena',
    name: 'DM Arena',
    type: 'brushdef',
    modes: 'both',
    description: 'Small deathmatch arena',
    def: dm_arena,
  },
];

// BSP maps (will be loaded from assets/maps if they exist)
const BSP_MAPS: MapInfo[] = [
  // Legendary maps
  {
    id: 'facingworlds',
    name: 'Facing Worlds',
    type: 'bsp',
    modes: 'both',
    description: 'The greatest CTF map ever made (UT/Q3)',
    bspPath: 'assets/maps/facingworlds/maps/facer2d.bsp',
  },
  // Counter-Strike 1.6 Maps (user-provided)
  {
    id: 'de_dust2',
    name: 'Dust II',
    type: 'bsp',
    modes: 'both',  // Available in both deathmatch and competitive
    description: 'The legendary CS map',
    bspPath: 'assets/maps/de_dust2.bsp',
    wadPaths: ['assets/wads/cs_dust.wad', 'assets/wads/cstrike.wad', 'assets/wads/halflife.wad'],
  },
  {
    id: 'de_dust',
    name: 'Dust',
    type: 'bsp',
    modes: 'both',  // Available in both deathmatch and competitive
    description: 'The original Dust',
    bspPath: 'assets/maps/de_dust.bsp',
    wadPaths: ['assets/wads/cs_dust.wad', 'assets/wads/cstrike.wad', 'assets/wads/halflife.wad'],
  },
  {
    id: 'de_aztec',
    name: 'Aztec',
    type: 'bsp',
    modes: 'competitive',
    description: 'Classic jungle temple map',
    bspPath: 'assets/maps/de_aztec.bsp',
    wadPaths: ['assets/wads/de_aztec.wad', 'assets/wads/cstrike.wad', 'assets/wads/halflife.wad'],
  },
  {
    id: 'de_inferno',
    name: 'Inferno',
    type: 'bsp',
    modes: 'competitive',
    description: 'Italian village bombsite',
    bspPath: 'assets/maps/de_inferno.bsp',
    wadPaths: ['assets/wads/cstrike.wad', 'assets/wads/halflife.wad'],
  },
  {
    id: 'de_nuke',
    name: 'Nuke',
    type: 'bsp',
    modes: 'competitive',
    description: 'Nuclear power plant',
    bspPath: 'assets/maps/de_nuke.bsp',
    wadPaths: ['assets/wads/cstrike.wad', 'assets/wads/halflife.wad'],
  },
  {
    id: 'cs_italy',
    name: 'Italy',
    type: 'bsp',
    modes: 'competitive',
    description: 'Italian village hostage rescue',
    bspPath: 'assets/maps/cs_italy.bsp',
    wadPaths: ['assets/wads/itsitaly.wad', 'assets/wads/cstrike.wad', 'assets/wads/halflife.wad'],
  },
  {
    id: 'cs_office',
    name: 'Office',
    type: 'bsp',
    modes: 'competitive',
    description: 'Office building hostage rescue',
    bspPath: 'assets/maps/cs_office.bsp',
    wadPaths: ['assets/wads/cs_office.wad', 'assets/wads/cstrike.wad', 'assets/wads/halflife.wad'],
  },
  // Classic Quake deathmatch maps
  {
    id: 'aerowalk',
    name: 'Aerowalk',
    type: 'bsp',
    modes: 'deathmatch',
    description: 'Legendary 1v1 arena by Preacher',
    bspPath: 'assets/maps/aerowalk.bsp',
    wadPaths: ['assets/wads/base.wad', 'assets/wads/metal.wad'],
  },
  {
    id: 'ztndm3',
    name: 'Blood Run',
    type: 'bsp',
    modes: 'deathmatch',
    description: 'Classic duel map by ztn',
    bspPath: 'assets/maps/ztndm3.bsp',
    wadPaths: ['assets/wads/base.wad', 'assets/wads/metal.wad'],
  },
  // Quake 1 Maps (GPL Licensed)
  {
    id: 'e1m1',
    name: 'The Slipgate Complex',
    type: 'bsp',
    modes: 'both',
    description: 'Classic Quake episode 1 start (GPL)',
    bspPath: 'assets/maps/e1m1.bsp',
    wadPaths: ['assets/wads/base.wad', 'assets/wads/metal.wad'],
  },
  {
    id: 'e1m2',
    name: 'Castle of the Damned',
    type: 'bsp',
    modes: 'both',
    description: 'Quake episode 1 map 2 (GPL)',
    bspPath: 'assets/maps/e1m2.bsp',
    wadPaths: ['assets/wads/medieval.wad', 'assets/wads/metal.wad'],
  },
  {
    id: 'dm1',
    name: 'Place of Two Deaths',
    type: 'bsp',
    modes: 'deathmatch',
    description: 'Classic Quake DM map (GPL)',
    bspPath: 'assets/maps/dm1.bsp',
    wadPaths: ['assets/wads/base.wad', 'assets/wads/metal.wad'],
  },
  {
    id: 'dm2',
    name: 'Claustrophobopolis',
    type: 'bsp',
    modes: 'deathmatch',
    description: 'Classic Quake DM map (GPL)',
    bspPath: 'assets/maps/dm2.bsp',
    wadPaths: ['assets/wads/base.wad', 'assets/wads/metal.wad'],
  },
  {
    id: 'dm3',
    name: 'The Abandoned Base',
    type: 'bsp',
    modes: 'deathmatch',
    description: 'Classic Quake DM map (GPL)',
    bspPath: 'assets/maps/dm3.bsp',
    wadPaths: ['assets/wads/base.wad', 'assets/wads/metal.wad'],
  },
  {
    id: 'dm4',
    name: 'The Bad Place',
    type: 'bsp',
    modes: 'deathmatch',
    description: 'Classic Quake DM map (GPL)',
    bspPath: 'assets/maps/dm4.bsp',
    wadPaths: ['assets/wads/medieval.wad', 'assets/wads/wizard.wad'],
  },
  {
    id: 'dm6',
    name: 'The Dark Zone',
    type: 'bsp',
    modes: 'deathmatch',
    description: 'Classic Quake DM map (GPL)',
    bspPath: 'assets/maps/dm6.bsp',
    wadPaths: ['assets/wads/metal.wad', 'assets/wads/base.wad'],
  },
  {
    id: 'start',
    name: 'Introduction',
    type: 'bsp',
    modes: 'both',
    description: 'Quake start hub (GPL)',
    bspPath: 'assets/maps/start.bsp',
    wadPaths: ['assets/wads/start.wad', 'assets/wads/medieval.wad'],
  },
];

export class MapRegistry {
  private static maps: Map<string, MapInfo> = new Map();
  private static initialized = false;

  // Initialize the registry
  static initialize(): void {
    if (this.initialized) return;

    // Add BSP maps first (so dust2 appears at top of list)
    for (const map of BSP_MAPS) {
      if (map.bspPath && this.checkMapExists(map.bspPath)) {
        this.maps.set(map.id, map);
      }
    }

    // Add built-in maps after BSP maps
    for (const map of BUILTIN_MAPS) {
      this.maps.set(map.id, map);
    }

    this.initialized = true;
  }

  // Check if a map file exists
  private static checkMapExists(relativePath: string): boolean {
    try {
      // Try multiple base paths
      const possiblePaths = [
        join(process.cwd(), relativePath),
        join(dirname(fileURLToPath(import.meta.url)), '../../..', relativePath),
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
      join(dirname(fileURLToPath(import.meta.url)), '../../..', relativePath),
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

    if (mapInfo.type === 'brushdef' && mapInfo.def) {
      return MapLoader.load(mapInfo.def);
    } else if (mapInfo.type === 'bsp' && mapInfo.bspPath) {
      const bspPath = this.resolvePath(mapInfo.bspPath);
      const wadPaths = mapInfo.wadPaths?.map(p => this.resolvePath(p));
      return MapLoader.loadBSP(bspPath, wadPaths);
    }

    throw new Error(`Invalid map configuration: ${id}`);
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
  return 'dm_arena';
}

export function getMapList(): { id: string; name: string }[] {
  return MapRegistry.getAvailableMaps().map(m => ({
    id: m.id,
    name: m.name,
  }));
}
