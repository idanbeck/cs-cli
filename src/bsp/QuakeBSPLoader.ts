// QuakeBSPLoader - Convert Quake 1 BSP v29 maps to game-usable format

import {
  QuakeBSPParser,
  ParsedQuakeBSP,
  QuakeFace,
  QuakeTexInfo,
  QuakeVertex,
  QuakeMipTex,
} from './QuakeBSPParser.js';
import { QUAKE_PALETTE } from './WAD2Parser.js';
import { Mesh, Material } from '../engine/Mesh.js';
import { Transform } from '../engine/Transform.js';
import { RenderObject } from '../engine/Renderer.js';
import { Vector3 } from '../engine/math/Vector3.js';
import { Color } from '../utils/Colors.js';
import { Texture } from '../engine/Texture.js';
import { TextureManager, getTextureManager } from '../engine/TextureManager.js';
import { AABB, SpawnPoint } from '../maps/MapFormat.js';
import { CollisionMesh } from '../physics/MeshCollision.js';

// Quake uses Z-up, engine uses Y-up
function quakeToEngine(x: number, y: number, z: number): Vector3 {
  return new Vector3(x, z, -y);
}

// Scale factor for Quake units
const QUAKE_SCALE = 0.03; // Quake units to game units

export interface QuakeBSPLoadResult {
  name: string;
  renderObjects: RenderObject[];
  colliders: AABB[];
  spawns: SpawnPoint[];
  bounds: AABB;
  skyColor: Color;
  ambientLight: number;
  textureManager: TextureManager;
}

export class QuakeBSPLoader {
  private bsp: ParsedQuakeBSP | null = null;
  private textureManager: TextureManager;
  private textures: Map<number, Texture> = new Map();
  private materials: Map<number, Material> = new Map();

  constructor(textureManager?: TextureManager) {
    this.textureManager = textureManager || getTextureManager();
  }

  async load(bspPath: string, wadPaths?: string[]): Promise<QuakeBSPLoadResult> {
    // Parse BSP
    const parser = QuakeBSPParser.fromFile(bspPath);
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

    // Load textures from BSP (Quake embeds textures in BSP)
    this.loadEmbeddedTextures();

    // Build materials from textures
    this.buildMaterials();

    // Convert faces to render objects
    const renderObjects = this.buildRenderObjects();

    // Extract spawn points from entities
    const spawns = this.parseSpawns();

    // Build colliders from models
    const colliders = this.buildColliders();

    // Compute bounds
    const bounds = this.computeBounds();

    // Get map name
    const name = bspPath.split('/').pop()?.replace('.bsp', '') || 'unknown';

    return {
      name,
      renderObjects,
      colliders,
      spawns,
      bounds,
      skyColor: new Color(80, 80, 120), // Blue-gray for Quake
      ambientLight: 0.7, // Brighter ambient light for visibility
      textureManager: this.textureManager,
    };
  }

  private loadEmbeddedTextures(): void {
    if (!this.bsp) return;

    for (let i = 0; i < this.bsp.mipTextures.length; i++) {
      const mipTex = this.bsp.mipTextures[i];
      if (!mipTex.name || mipTex.width === 0) continue;

      // Check if we already have this texture from WAD
      const existingTexture = this.textureManager.get(mipTex.name);
      if (existingTexture && existingTexture.width > 0) {
        this.textures.set(i, existingTexture);
        continue;
      }

      // Create texture from embedded miptex using Quake palette
      if (mipTex.pixels && mipTex.pixels.length > 0 && mipTex.pixels[0].length > 0) {
        const texture = this.textureManager.createTextureFromQuakeBSPMipTex(
          mipTex.name,
          mipTex.width,
          mipTex.height,
          mipTex.pixels[0]
        );
        this.textures.set(i, texture);
        this.textureManager.addTexture(mipTex.name, texture);
      } else {
        // Create placeholder
        const color = this.guessColorFromName(mipTex.name);
        const texture = Texture.solid(mipTex.name, color, mipTex.width || 64, mipTex.height || 64);
        this.textures.set(i, texture);
        this.textureManager.addTexture(mipTex.name, texture);
      }
    }
  }

  private guessColorFromName(name: string): Color {
    const lower = name.toLowerCase();

    if (lower.includes('sky')) return new Color(50, 50, 80);
    if (lower.includes('water') || lower.startsWith('*')) return new Color(64, 100, 150);
    if (lower.includes('lava')) return new Color(200, 80, 30);
    if (lower.includes('slime')) return new Color(80, 150, 50);
    if (lower.includes('wood')) return new Color(100, 70, 40);
    if (lower.includes('metal')) return new Color(100, 100, 110);
    if (lower.includes('brick')) return new Color(120, 70, 50);
    if (lower.includes('rock') || lower.includes('stone')) return new Color(90, 85, 80);
    if (lower.includes('dirt')) return new Color(80, 60, 40);
    if (lower.includes('floor')) return new Color(80, 75, 70);
    if (lower.includes('wall')) return new Color(90, 85, 80);
    if (lower.includes('door')) return new Color(70, 50, 35);
    if (lower.includes('light') || lower.includes('lamp')) return new Color(200, 180, 120);
    if (lower.includes('tech') || lower.includes('comp')) return new Color(60, 70, 80);

    // Default brownish-gray (typical Quake color)
    return new Color(85, 75, 65);
  }

  private buildMaterials(): void {
    if (!this.bsp) return;

    for (let i = 0; i < this.bsp.mipTextures.length; i++) {
      const mipTex = this.bsp.mipTextures[i];
      const texture = this.textures.get(i);

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

  private buildRenderObjects(): RenderObject[] {
    if (!this.bsp) return [];

    const renderObjects: RenderObject[] = [];

    // Group faces by texture
    const facesByTexture: Map<number, number[]> = new Map();

    for (let faceIdx = 0; faceIdx < this.bsp.faces.length; faceIdx++) {
      const face = this.bsp.faces[faceIdx];
      const texInfo = this.bsp.texInfo[face.texInfo];
      const texIndex = texInfo.mipTexIndex;

      // Skip special textures that shouldn't be rendered
      const mipTex = this.bsp.mipTextures[texIndex];
      const texName = mipTex?.name?.toLowerCase() || '';

      if (texName.startsWith('sky')) continue;
      if (texName.includes('trigger')) continue;
      if (texName === 'clip') continue;
      if (texName === 'origin') continue;
      if (texName === 'null') continue;
      if (texName.startsWith('skip')) continue;
      if (texName.startsWith('hint')) continue;

      if (!facesByTexture.has(texIndex)) {
        facesByTexture.set(texIndex, []);
      }
      facesByTexture.get(texIndex)!.push(faceIdx);
    }

    // Create mesh for each texture group
    for (const [texIndex, faceIndices] of facesByTexture) {
      const material = this.materials.get(texIndex) || {
        name: 'default',
        color: new Color(85, 75, 65),
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

  private addFaceToMesh(mesh: Mesh, faceIdx: number, texWidth: number, texHeight: number): void {
    if (!this.bsp) return;

    const face = this.bsp.faces[faceIdx];
    const texInfo = this.bsp.texInfo[face.texInfo];
    const plane = this.bsp.planes[face.planeNum];

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

      const quakeVert = this.bsp.vertices[vertIdx];
      const engineVert = quakeToEngine(quakeVert.x, quakeVert.y, quakeVert.z).scale(QUAKE_SCALE);
      vertices.push(engineVert);

      // Calculate UV from texinfo
      const u = (
        quakeVert.x * texInfo.s[0] +
        quakeVert.y * texInfo.s[1] +
        quakeVert.z * texInfo.s[2] +
        texInfo.s[3]
      ) / texWidth;

      const v = (
        quakeVert.x * texInfo.t[0] +
        quakeVert.y * texInfo.t[1] +
        quakeVert.z * texInfo.t[2] +
        texInfo.t[3]
      ) / texHeight;

      uvs.push([u, v]);
    }

    if (vertices.length < 3) return;

    // Compute face normal
    const quakeNormal = plane.normal;
    const engineNormal = quakeToEngine(quakeNormal.x, quakeNormal.y, quakeNormal.z).normalize();
    // Flip normal if face is on back side of plane
    // Also negate because we reverse winding below for handedness correction
    const faceNormal = face.side ? engineNormal : engineNormal.clone().negate();

    // Add vertices to mesh
    const baseIndex = mesh.vertices.length;
    for (let i = 0; i < vertices.length; i++) {
      mesh.addVertex(vertices[i], faceNormal.clone(), uvs[i]);
    }

    // Triangulate with fan method
    // Reverse winding to account for coordinate system handedness change
    for (let i = 1; i < vertices.length - 1; i++) {
      mesh.addTriangle(baseIndex, baseIndex + i + 1, baseIndex + i, false);
    }
  }

  private parseSpawns(): SpawnPoint[] {
    if (!this.bsp) return [];

    const spawns: SpawnPoint[] = [];
    const entities = this.parseEntities();

    for (const ent of entities) {
      let team: 'T' | 'CT' | 'DM' | undefined;

      switch (ent.classname) {
        case 'info_player_start':
          team = 'DM';
          break;
        case 'info_player_deathmatch':
          team = 'DM';
          break;
        case 'info_player_coop':
          team = 'CT'; // Map coop spawns to CT
          break;
        default:
          continue;
      }

      if (ent.origin) {
        const [x, y, z] = ent.origin.split(' ').map(Number);
        const pos = quakeToEngine(x, y, z).scale(QUAKE_SCALE);

        const angle = ent.angle ? parseFloat(ent.angle) : 0;

        spawns.push({
          position: [pos.x, pos.y, pos.z],
          angle: angle * Math.PI / 180,
          team,
        });
      }
    }

    // If no spawns found, create default spawns
    if (spawns.length === 0) {
      spawns.push({
        position: [0, 1, 0],
        angle: 0,
        team: 'DM',
      });
    }

    return spawns;
  }

  private parseEntities(): Record<string, string>[] {
    if (!this.bsp) return [];

    const entities: Record<string, string>[] = [];
    const entityStr = this.bsp.entities;

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
        const match = trimmed.match(/"([^"]+)"\s+"([^"]*)"/);
        if (match) {
          currentEntity[match[1]] = match[2];
        }
      }
    }

    return entities;
  }

  private buildColliders(): AABB[] {
    if (!this.bsp) return [];

    // Skip collision for BSP maps - Model 0 encompasses entire world
    // and would block all movement. Proper BSP collision requires
    // clipnodes or per-face collision detection.
    // For now, return empty to allow free exploration.
    // TODO: Implement proper BSP collision
    return [];
  }

  private computeBounds(): AABB {
    if (!this.bsp || this.bsp.models.length === 0) {
      return {
        min: new Vector3(-100, -100, -100),
        max: new Vector3(100, 100, 100),
      };
    }

    const model = this.bsp.models[0];
    const min = quakeToEngine(model.mins.x, model.mins.y, model.mins.z).scale(QUAKE_SCALE);
    const max = quakeToEngine(model.maxs.x, model.maxs.y, model.maxs.z).scale(QUAKE_SCALE);

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
}
