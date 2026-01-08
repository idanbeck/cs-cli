// BSPLoader - Convert GoldSrc BSP v30 maps to game-usable format

import {
  BSPParser,
  ParsedBSP,
  BSPFace,
  BSPTexInfo,
  BSPVertex,
  BSPMipTex,
} from './BSPParser.js';
import { WAD3Parser, MipTexture } from './WAD3Parser.js';
import { Mesh, Material } from '../engine/Mesh.js';
import { Transform } from '../engine/Transform.js';
import { RenderObject } from '../engine/Renderer.js';
import { Vector3 } from '../engine/math/Vector3.js';
import { Color } from '../utils/Colors.js';
import { Texture } from '../engine/Texture.js';
import { TextureManager, getTextureManager } from '../engine/TextureManager.js';
import { AABB, SpawnPoint } from '../maps/MapFormat.js';
import { CollisionMesh } from '../physics/MeshCollision.js';

// BSP uses Z-up, engine uses Y-up
function bspToEngine(x: number, y: number, z: number): Vector3 {
  // BSP: X=right, Y=forward, Z=up
  // Engine: X=right, Y=up, Z=forward
  return new Vector3(x, z, -y);
}

// Scale factor for BSP units (typically 1 unit = 1 inch, convert to meters-ish)
const BSP_SCALE = 0.0254; // 1 inch to meters, adjust as needed for game scale

export interface BSPLoadResult {
  name: string;
  renderObjects: RenderObject[];
  colliders: AABB[];
  collisionMesh: CollisionMesh;  // Triangle-based collision
  spawns: SpawnPoint[];
  bounds: AABB;
  skyColor: Color;
  ambientLight: number;
  textureManager: TextureManager;
}

export class BSPLoader {
  private bsp: ParsedBSP | null = null;
  private textureManager: TextureManager;
  private textures: Map<number, Texture> = new Map();
  private materials: Map<number, Material> = new Map();

  constructor(textureManager?: TextureManager) {
    this.textureManager = textureManager || getTextureManager();
  }

  // Load a BSP file with optional WAD files for textures
  async load(bspPath: string, wadPaths?: string[]): Promise<BSPLoadResult> {
    // Parse BSP
    const parser = BSPParser.fromFile(bspPath);
    this.bsp = parser.parse();

    // Load WAD textures if provided
    if (wadPaths) {
      for (const wadPath of wadPaths) {
        try {
          this.textureManager.loadWAD(wadPath);
        } catch (e) {
          console.warn(`Failed to load WAD ${wadPath}:`, e);
        }
      }
    }

    // Load embedded textures from BSP
    this.loadEmbeddedTextures();

    // Build materials from textures
    this.buildMaterials();

    // Convert faces to render objects
    const renderObjects = this.buildRenderObjects();

    // Extract spawn points from entities
    const spawns = this.parseSpawns();

    // Build colliders from models
    const colliders = this.buildColliders();

    // Build collision mesh from all solid faces
    const collisionMesh = this.buildCollisionMesh();

    // Compute bounds from model 0 (the world)
    const bounds = this.computeBounds();

    // Extract sky color from worldspawn entity or use default
    const skyColor = this.extractSkyColor();

    // Get map name from bsp path
    const name = bspPath.split('/').pop()?.replace('.bsp', '') || 'unknown';

    return {
      name,
      renderObjects,
      colliders,
      collisionMesh,
      spawns,
      bounds,
      skyColor,
      ambientLight: 0.7, // Brighter ambient light for visibility
      textureManager: this.textureManager,
    };
  }

  // Load textures embedded in BSP file
  private loadEmbeddedTextures(): void {
    if (!this.bsp) return;

    for (let i = 0; i < this.bsp.mipTextures.length; i++) {
      const mipTex = this.bsp.mipTextures[i];
      if (!mipTex.name || mipTex.width === 0) continue;

      // Check if texture is external (offsets all 0)
      if (mipTex.offsets[0] === 0) {
        // External texture - try to get from WAD
        const wadTexture = this.textureManager.get(mipTex.name);
        if (wadTexture) {
          this.textures.set(i, wadTexture);
        }
        continue;
      }

      // Embedded texture - load from BSP data
      // For embedded textures, we need to parse the pixel data
      // This is complex, so for now we'll rely on WAD textures
      // and create a placeholder for embedded ones
      const existingTexture = this.textureManager.get(mipTex.name);
      if (existingTexture) {
        this.textures.set(i, existingTexture);
      } else {
        // Create a solid color placeholder based on texture name
        const color = this.guessColorFromName(mipTex.name);
        const texture = Texture.solid(mipTex.name, color, mipTex.width, mipTex.height);
        this.textures.set(i, texture);
        this.textureManager.addTexture(mipTex.name, texture);
      }
    }
  }

  // Guess a color from texture name for placeholder textures
  private guessColorFromName(name: string): Color {
    const lower = name.toLowerCase();

    if (lower.includes('sky')) return new Color(135, 206, 235);
    if (lower.includes('water')) return new Color(64, 164, 223);
    if (lower.includes('lava')) return new Color(255, 100, 50);
    if (lower.includes('slime')) return new Color(100, 200, 50);
    if (lower.includes('wood')) return new Color(139, 90, 43);
    if (lower.includes('metal')) return new Color(140, 145, 150);
    if (lower.includes('brick')) return new Color(140, 80, 60);
    if (lower.includes('sand')) return new Color(194, 178, 128);
    if (lower.includes('grass')) return new Color(76, 115, 60);
    if (lower.includes('dirt')) return new Color(101, 67, 33);
    if (lower.includes('concrete') || lower.includes('cement')) return new Color(128, 128, 128);
    if (lower.includes('tile')) return new Color(180, 170, 160);
    if (lower.includes('white')) return new Color(220, 220, 220);
    if (lower.includes('black')) return new Color(40, 40, 40);
    if (lower.includes('red')) return new Color(180, 50, 50);
    if (lower.includes('blue')) return new Color(50, 80, 180);
    if (lower.includes('green')) return new Color(50, 150, 50);
    if (lower.includes('yellow')) return new Color(200, 180, 50);

    // Default gray
    return new Color(128, 128, 128);
  }

  // Build materials from loaded textures
  private buildMaterials(): void {
    if (!this.bsp) return;

    for (let i = 0; i < this.bsp.mipTextures.length; i++) {
      const mipTex = this.bsp.mipTextures[i];
      const texture = this.textures.get(i);

      // Get average color from texture or guess from name
      const color = texture
        ? texture.getAverageColor()
        : this.guessColorFromName(mipTex.name);

      this.materials.set(i, {
        name: mipTex.name || `texture_${i}`,
        color,
        texture,
      });
    }
  }

  // Build render objects from BSP faces
  private buildRenderObjects(): RenderObject[] {
    if (!this.bsp) return [];

    const renderObjects: RenderObject[] = [];

    // Group faces by texture for better batching
    const facesByTexture: Map<number, number[]> = new Map();

    for (let faceIdx = 0; faceIdx < this.bsp.faces.length; faceIdx++) {
      const face = this.bsp.faces[faceIdx];
      const texInfo = this.bsp.texInfo[face.texInfo];
      const texIndex = texInfo.mipTexIndex;

      // Skip special textures that shouldn't be rendered
      const mipTex = this.bsp.mipTextures[texIndex];
      const texName = mipTex?.name?.toLowerCase() || '';

      // Skip sky, triggers, clips, and other tool textures
      if (texName.startsWith('sky')) continue;
      if (texName.includes('trigger')) continue;  // aaatrigger, trigger
      if (texName === 'clip') continue;
      if (texName === 'origin') continue;
      if (texName === 'null') continue;
      if (texName.startsWith('skip')) continue;
      if (texName.startsWith('hint')) continue;
      if (texName === 'bevel') continue;
      // Bomb target textures (visible markers in game but not solid geometry)
      if (texName.includes('tgt') || texName.includes('target')) continue;
      if (texName.includes('bombsite') || texName.includes('bomb')) continue;

      if (!facesByTexture.has(texIndex)) {
        facesByTexture.set(texIndex, []);
      }
      facesByTexture.get(texIndex)!.push(faceIdx);
    }

    // Create a mesh for each texture group
    for (const [texIndex, faceIndices] of facesByTexture) {
      const material = this.materials.get(texIndex) || {
        name: 'default',
        color: new Color(128, 128, 128),
      };

      const mipTex = this.bsp!.mipTextures[texIndex];
      const texWidth = mipTex?.width || 64;
      const texHeight = mipTex?.height || 64;

      const mesh = new Mesh(material);

      for (const faceIdx of faceIndices) {
        this.addFaceToMesh(mesh, faceIdx, texWidth, texHeight);
      }

      if (mesh.vertices.length > 0) {
        const transform = new Transform(Vector3.zero());
        renderObjects.push({
          mesh,
          transform,
          visible: true,
        });
      }
    }

    return renderObjects;
  }

  // Add a BSP face to a mesh (triangulating if necessary)
  private addFaceToMesh(mesh: Mesh, faceIdx: number, texWidth: number, texHeight: number): void {
    if (!this.bsp) return;

    const face = this.bsp.faces[faceIdx];
    const texInfo = this.bsp.texInfo[face.texInfo];
    const plane = this.bsp.planes[face.planeNum];

    // Get face vertices using edges
    const vertices: Vector3[] = [];
    const uvs: [number, number][] = [];

    for (let i = 0; i < face.numEdges; i++) {
      const surfEdgeIdx = face.firstEdge + i;
      const edgeIdx = this.bsp.surfEdges[surfEdgeIdx];

      let vertIdx: number;
      if (edgeIdx >= 0) {
        vertIdx = this.bsp.edges[edgeIdx].v[0];
      } else {
        vertIdx = this.bsp.edges[-edgeIdx].v[1];
      }

      const bspVert = this.bsp.vertices[vertIdx];

      // Convert to engine coordinates and scale
      const engineVert = bspToEngine(bspVert.x, bspVert.y, bspVert.z).scale(BSP_SCALE);
      vertices.push(engineVert);

      // Calculate UV from texinfo
      // u = dot(vertex, S.xyz) + S.w
      // v = dot(vertex, T.xyz) + T.w
      const u = (
        bspVert.x * texInfo.s[0] +
        bspVert.y * texInfo.s[1] +
        bspVert.z * texInfo.s[2] +
        texInfo.s[3]
      ) / texWidth;

      const v = (
        bspVert.x * texInfo.t[0] +
        bspVert.y * texInfo.t[1] +
        bspVert.z * texInfo.t[2] +
        texInfo.t[3]
      ) / texHeight;

      uvs.push([u, v]);
    }

    if (vertices.length < 3) return;

    // Compute face normal in engine space
    const bspNormal = plane.normal;
    const engineNormal = bspToEngine(bspNormal.x, bspNormal.y, bspNormal.z).normalize();

    // Flip normal if face is on back side of plane
    // Also negate because we reverse winding below for handedness correction
    const faceNormal = face.side ? engineNormal : engineNormal.clone().negate();

    // Add vertices to mesh
    const baseIndex = mesh.vertices.length;
    for (let i = 0; i < vertices.length; i++) {
      mesh.addVertex(vertices[i], faceNormal.clone(), uvs[i]);
    }

    // Triangulate using fan method (BSP faces are convex)
    // Reverse winding to account for coordinate system handedness change
    for (let i = 1; i < vertices.length - 1; i++) {
      mesh.addTriangle(baseIndex, baseIndex + i + 1, baseIndex + i, false);
    }
  }

  // Parse spawn points from entity lump
  private parseSpawns(): SpawnPoint[] {
    if (!this.bsp) return [];

    const spawns: SpawnPoint[] = [];
    const entities = this.parseEntities();

    for (const ent of entities) {
      let team: 'T' | 'CT' | 'DM' | undefined;

      switch (ent.classname) {
        case 'info_player_terrorist':
          team = 'T';
          break;
        case 'info_player_counterterrorist':
          team = 'CT';
          break;
        case 'info_player_deathmatch':
        case 'info_player_start':
          team = 'DM';
          break;
        default:
          continue;
      }

      if (ent.origin) {
        const [x, y, z] = ent.origin.split(' ').map(Number);
        const pos = bspToEngine(x, y, z).scale(BSP_SCALE);

        // Parse angle (yaw)
        const angle = ent.angle ? parseFloat(ent.angle) : 0;

        spawns.push({
          position: [pos.x, pos.y, pos.z],
          angle: angle * Math.PI / 180, // Convert to radians
          team,
        });
      }
    }

    return spawns;
  }

  // Parse entity lump into key-value objects
  private parseEntities(): Record<string, string>[] {
    if (!this.bsp) return [];

    const entities: Record<string, string>[] = [];
    const entityStr = this.bsp.entities;

    // Simple entity parser
    let currentEntity: Record<string, string> | null = null;

    const lines = entityStr.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed === '{') {
        currentEntity = {};
      } else if (trimmed === '}') {
        if (currentEntity) {
          entities.push(currentEntity);
          currentEntity = null;
        }
      } else if (currentEntity && trimmed.startsWith('"')) {
        // Parse "key" "value"
        const match = trimmed.match(/"([^"]+)"\s+"([^"]*)"/);
        if (match) {
          currentEntity[match[1]] = match[2];
        }
      }
    }

    return entities;
  }

  // Build collision AABBs from BSP models
  private buildColliders(): AABB[] {
    if (!this.bsp) return [];

    const colliders: AABB[] = [];

    // Skip Model 0 - it's the entire world and its AABB would block everything
    // Models 1+ are brush entities like doors, platforms, etc.
    // For proper BSP collision, we'd need to use clipnodes or per-face collision
    // For now, skip all models to allow free movement (BSP maps are complex)
    // TODO: Implement proper BSP collision using clipnodes or face-based collision

    // Just return empty for now - the map geometry provides visual but not collision
    // This lets the player explore the map freely
    return colliders;
  }

  // Compute world bounds from model 0
  private computeBounds(): AABB {
    if (!this.bsp || this.bsp.models.length === 0) {
      return {
        min: new Vector3(-100, -100, -100),
        max: new Vector3(100, 100, 100),
      };
    }

    const model = this.bsp.models[0];
    const min = bspToEngine(model.mins.x, model.mins.y, model.mins.z).scale(BSP_SCALE);
    const max = bspToEngine(model.maxs.x, model.maxs.y, model.maxs.z).scale(BSP_SCALE);

    return {
      min: new Vector3(
        Math.min(min.x, max.x),
        Math.min(min.y, max.y),
        Math.min(min.z, max.z)
      ),
      max: new Vector3(
        Math.max(min.x, max.x),
        Math.max(min.y, max.y),
        Math.max(min.z, max.z)
      ),
    };
  }

  // Extract sky color from worldspawn
  private extractSkyColor(): Color {
    if (!this.bsp) return new Color(135, 206, 235);

    const entities = this.parseEntities();
    const worldspawn = entities.find(e => e.classname === 'worldspawn');

    if (worldspawn?.skyname) {
      // Could load sky texture here, for now return default
      return new Color(135, 206, 235);
    }

    // Try to get sky color from light environment
    const light_env = entities.find(e => e.classname === 'light_environment');
    if (light_env?._light) {
      const parts = light_env._light.split(' ').map(Number);
      if (parts.length >= 3) {
        return new Color(parts[0], parts[1], parts[2]);
      }
    }

    return new Color(135, 206, 235); // Default sky blue
  }

  // Build collision mesh from BSP faces (for triangle-based collision)
  private buildCollisionMesh(): CollisionMesh {
    const mesh = new CollisionMesh();
    if (!this.bsp) return mesh;

    // Iterate through all faces and add collision triangles
    for (let faceIdx = 0; faceIdx < this.bsp.faces.length; faceIdx++) {
      const face = this.bsp.faces[faceIdx];
      const texInfo = this.bsp.texInfo[face.texInfo];
      const texIndex = texInfo.mipTexIndex;

      // Get texture name to filter non-solid surfaces
      const mipTex = this.bsp.mipTextures[texIndex];
      const texName = mipTex?.name?.toLowerCase() || '';

      // Skip non-solid textures (sky, triggers, clips, etc.)
      if (texName.startsWith('sky')) continue;
      if (texName.includes('trigger')) continue;
      if (texName === 'clip') continue;
      if (texName === 'origin') continue;
      if (texName === 'null') continue;
      if (texName.startsWith('skip')) continue;
      if (texName.startsWith('hint')) continue;
      if (texName === 'bevel') continue;
      // Water, lava, slime - skip for collision (they have special handling)
      if (texName.startsWith('!') || texName.startsWith('*')) continue;
      if (texName.includes('water')) continue;
      if (texName.includes('lava')) continue;
      if (texName.includes('slime')) continue;

      // Get face vertices using edges
      const vertices: Vector3[] = [];

      for (let i = 0; i < face.numEdges; i++) {
        const surfEdgeIdx = face.firstEdge + i;
        const edgeIdx = this.bsp.surfEdges[surfEdgeIdx];

        let vertIdx: number;
        if (edgeIdx >= 0) {
          vertIdx = this.bsp.edges[edgeIdx].v[0];
        } else {
          vertIdx = this.bsp.edges[-edgeIdx].v[1];
        }

        const bspVert = this.bsp.vertices[vertIdx];

        // Convert to engine coordinates and scale
        const engineVert = bspToEngine(bspVert.x, bspVert.y, bspVert.z).scale(BSP_SCALE);
        vertices.push(engineVert);
      }

      if (vertices.length < 3) continue;

      // Triangulate using fan method (BSP faces are convex)
      // Use same winding as render mesh
      for (let i = 1; i < vertices.length - 1; i++) {
        mesh.addTriangle(vertices[0], vertices[i + 1], vertices[i]);
      }
    }

    console.log(`Built collision mesh with ${mesh.triangles.length} triangles`);
    return mesh;
  }
}
