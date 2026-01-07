// Map loader - converts map definitions to game objects

import { MapDef, BrushDef, AABB, MATERIALS, SpawnPoint } from './MapFormat.js';
import { Mesh } from '../engine/Mesh.js';
import { Transform } from '../engine/Transform.js';
import { RenderObject } from '../engine/Renderer.js';
import { Vector3 } from '../engine/math/Vector3.js';
import { Color } from '../utils/Colors.js';

export interface LoadedMap {
  name: string;
  renderObjects: RenderObject[];
  colliders: AABB[];
  spawns: SpawnPoint[];
  bounds: AABB;
  skyColor: Color;
  ambientLight: number;
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
      ambientLight: mapDef.environment.ambientLight
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
}
