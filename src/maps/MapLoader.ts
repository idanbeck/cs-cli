// Map loader - converts map definitions to game objects

import { MapDef, BrushDef, AABB, MATERIALS, SpawnPoint } from './MapFormat.js';
import { Mesh } from '../engine/Mesh.js';
import { Transform } from '../engine/Transform.js';
import { RenderObject } from '../engine/Renderer.js';
import { Vector3 } from '../engine/math/Vector3.js';
import { Color } from '../utils/Colors.js';
import { BSPLoader, BSPLoadResult } from '../bsp/BSPLoader.js';
import { QuakeBSPLoader, QuakeBSPLoadResult } from '../bsp/QuakeBSPLoader.js';
import { Q3BSPLoader, Q3BSPLoadResult } from '../bsp/Q3BSPLoader.js';
import { TextureManager } from '../engine/TextureManager.js';
import { readFileSync } from 'fs';

// Q3 BSP magic number "IBSP" in little-endian
const Q3BSP_MAGIC = 0x50534249;

export interface LoadedMap {
  name: string;
  renderObjects: RenderObject[];
  colliders: AABB[];
  spawns: SpawnPoint[];
  bounds: AABB;
  skyColor: Color;
  ambientLight: number;
  source?: 'bsp' | 'brushdef';
  textureManager?: TextureManager;
}

export class MapLoader {
  // Load a map from a MapDef
  static load(mapDef: MapDef): LoadedMap {
    const renderObjects: RenderObject[] = [];
    const colliders: AABB[] = [];

    // Process each brush
    for (const brush of mapDef.brushes) {
      const { renderObject, collider } = this.processBrush(brush);
      renderObjects.push(renderObject);

      if (collider) {
        colliders.push(collider);
      }
    }

    // Convert bounds
    const bounds: AABB = {
      min: new Vector3(...mapDef.bounds.min),
      max: new Vector3(...mapDef.bounds.max)
    };

    // Get sky color
    const skyColor = new Color(...mapDef.environment.skyColor);

    return {
      name: mapDef.name,
      renderObjects,
      colliders,
      spawns: mapDef.spawns,
      bounds,
      skyColor,
      ambientLight: mapDef.environment.ambientLight,
      source: 'brushdef',
    };
  }

  private static processBrush(brush: BrushDef): { renderObject: RenderObject; collider: AABB | null } {
    const [px, py, pz] = brush.position;
    const [sx, sy, sz] = brush.size;

    // Get material color
    const materialColor = MATERIALS[brush.material] || MATERIALS['concrete'];
    const color = new Color(...materialColor);

    // Create mesh
    const mesh = Mesh.createBox(sx, sy, sz, {
      name: brush.material,
      color
    });

    // Create transform (position is center of brush)
    const transform = new Transform(new Vector3(px, py, pz));

    // Create render object
    const renderObject: RenderObject = {
      mesh,
      transform,
      visible: true
    };

    // Create collider if collision is enabled (default true)
    let collider: AABB | null = null;
    if (brush.collision !== false) {
      collider = {
        min: new Vector3(px - sx / 2, py - sy / 2, pz - sz / 2),
        max: new Vector3(px + sx / 2, py + sy / 2, pz + sz / 2)
      };
    }

    return { renderObject, collider };
  }

  // Create a ground plane (separate from brushes for potentially different rendering)
  static createGroundPlane(
    width: number,
    depth: number,
    material: string = 'concrete',
    subdivisions: number = 16
  ): RenderObject {
    const materialColor = MATERIALS[material] || MATERIALS['concrete'];
    const color = new Color(...materialColor);

    const mesh = Mesh.createPlane(width, depth, {
      name: 'ground',
      color
    }, subdivisions);

    const transform = new Transform(new Vector3(0, 0, 0));

    return {
      mesh,
      transform,
      visible: true
    };
  }

  // Load a map from a BSP file (auto-detects format: v29 Quake, v30 GoldSrc, or IBSP Q3)
  static async loadBSP(bspPath: string, wadPaths?: string[]): Promise<LoadedMap> {
    // Read first 8 bytes to detect BSP format
    const data = readFileSync(bspPath);
    const magic = data.readUInt32LE(0);
    const version = data.readInt32LE(4);

    let result: BSPLoadResult | QuakeBSPLoadResult | Q3BSPLoadResult;

    if (magic === Q3BSP_MAGIC) {
      // Quake 3 BSP (IBSP)
      console.log(`Loading Quake 3 BSP: ${bspPath} (version ${version})`);
      const loader = new Q3BSPLoader();
      result = await loader.load(bspPath);
    } else if (magic === 29) {
      // Quake 1 BSP (version number is first, not magic)
      console.log(`Loading Quake 1 BSP: ${bspPath}`);
      const loader = new QuakeBSPLoader();
      result = await loader.load(bspPath, wadPaths);
    } else if (magic === 30) {
      // GoldSrc BSP (Half-Life/CS) - version number is first
      console.log(`Loading GoldSrc BSP: ${bspPath}`);
      const loader = new BSPLoader();
      result = await loader.load(bspPath, wadPaths);
    } else {
      throw new Error(`Unsupported BSP format: magic=0x${magic.toString(16)}`);
    }

    return {
      name: result.name,
      renderObjects: result.renderObjects,
      colliders: result.colliders,
      spawns: result.spawns,
      bounds: result.bounds,
      skyColor: result.skyColor,
      ambientLight: result.ambientLight,
      source: 'bsp',
      textureManager: result.textureManager,
    };
  }
}
