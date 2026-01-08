// Q3BSPLoader - Convert Quake 3 BSP maps to game-usable format

import {
  Q3BSPParser,
  ParsedQ3BSP,
  Q3Face,
  Q3Vertex,
  Q3Texture,
  Q3FaceType,
} from './Q3BSPParser.js';
import { Mesh, Material } from '../engine/Mesh.js';
import { Transform } from '../engine/Transform.js';
import { RenderObject } from '../engine/Renderer.js';
import { Vector3 } from '../engine/math/Vector3.js';
import { Color } from '../utils/Colors.js';
import { Texture } from '../engine/Texture.js';
import { TextureManager, getTextureManager } from '../engine/TextureManager.js';
import { AABB, SpawnPoint } from '../maps/MapFormat.js';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';

// Q3 uses Z-up, engine uses Y-up
function q3ToEngine(x: number, y: number, z: number): Vector3 {
  // Q3: X=right, Y=forward, Z=up
  // Engine: X=right, Y=up, Z=forward (negated for handedness)
  return new Vector3(x, z, -y);
}

// Scale factor for Q3 units (similar to Quake 1)
const Q3_SCALE = 0.03;

export interface Q3BSPLoadResult {
  name: string;
  renderObjects: RenderObject[];
  colliders: AABB[];
  spawns: SpawnPoint[];
  bounds: AABB;
  skyColor: Color;
  ambientLight: number;
  textureManager: TextureManager;
}

export class Q3BSPLoader {
  private bsp: ParsedQ3BSP | null = null;
  private textureManager: TextureManager;
  private textures: Map<number, Texture> = new Map();
  private materials: Map<number, Material> = new Map();
  private basePath: string = '';

  constructor(textureManager?: TextureManager) {
    this.textureManager = textureManager || getTextureManager();
  }

  async load(bspPath: string): Promise<Q3BSPLoadResult> {
    // Store base path for texture loading
    this.basePath = dirname(bspPath);

    // Parse BSP
    const parser = Q3BSPParser.fromFile(bspPath);
    this.bsp = parser.parse();

    // Load textures from adjacent directories
    this.loadTextures();

    // Build materials from textures
    this.buildMaterials();

    // Convert faces to render objects
    const renderObjects = this.buildRenderObjects();

    // Extract spawn points from entities
    const spawns = this.parseSpawns();

    // Compute bounds from model 0
    const bounds = this.computeBounds();

    // Get map name
    const name = bspPath.split('/').pop()?.replace('.bsp', '') || 'unknown';

    return {
      name,
      renderObjects,
      colliders: [], // Q3 collision would need brush parsing
      spawns,
      bounds,
      skyColor: new Color(20, 20, 40), // Dark space for Facing Worlds
      ambientLight: 0.6,
      textureManager: this.textureManager,
    };
  }

  private loadTextures(): void {
    if (!this.bsp) return;

    for (let i = 0; i < this.bsp.textures.length; i++) {
      const texInfo = this.bsp.textures[i];
      const texName = texInfo.name;

      // Skip special textures
      if (texName.includes('sky') || texName.includes('clip') ||
          texName.includes('trigger') || texName.includes('hint') ||
          texName.includes('nodraw') || texName.includes('caulk')) {
        continue;
      }

      // Try to find texture file
      const texture = this.findAndLoadTexture(texName);
      if (texture) {
        this.textures.set(i, texture);
        this.textureManager.addTexture(texName, texture);
      }
    }
  }

  private findAndLoadTexture(texName: string): Texture | null {
    // Try different extensions and paths
    const extensions = ['.tga', '.jpg', '.jpeg', '.png'];
    const searchPaths = [
      this.basePath,
      join(this.basePath, '..'),
      join(this.basePath, '..', 'textures'),
    ];

    for (const searchPath of searchPaths) {
      for (const ext of extensions) {
        const fullPath = join(searchPath, texName + ext);
        if (existsSync(fullPath)) {
          try {
            return this.loadTextureFile(fullPath);
          } catch (e) {
            console.warn(`Failed to load texture ${fullPath}:`, e);
          }
        }
      }
    }

    // Try with 'textures/' prefix stripped
    const stripped = texName.replace(/^textures\//, '');
    for (const searchPath of searchPaths) {
      for (const ext of extensions) {
        const fullPath = join(searchPath, 'textures', stripped + ext);
        if (existsSync(fullPath)) {
          try {
            return this.loadTextureFile(fullPath);
          } catch (e) {
            console.warn(`Failed to load texture ${fullPath}:`, e);
          }
        }
      }
    }

    return null;
  }

  private loadTextureFile(path: string): Texture {
    const ext = path.toLowerCase().split('.').pop();

    if (ext === 'tga') {
      return this.loadTGA(path);
    } else if (ext === 'jpg' || ext === 'jpeg') {
      return this.loadJPG(path);
    }

    throw new Error(`Unsupported texture format: ${ext}`);
  }

  private loadTGA(path: string): Texture {
    const buffer = readFileSync(path);

    // TGA header
    const idLength = buffer.readUInt8(0);
    const colorMapType = buffer.readUInt8(1);
    const imageType = buffer.readUInt8(2);
    const width = buffer.readUInt16LE(12);
    const height = buffer.readUInt16LE(14);
    const bpp = buffer.readUInt8(16);
    const descriptor = buffer.readUInt8(17);

    // Only support uncompressed true-color (type 2) or RLE (type 10)
    if (imageType !== 2 && imageType !== 10) {
      throw new Error(`Unsupported TGA type: ${imageType}`);
    }

    const bytesPerPixel = bpp / 8;
    const dataOffset = 18 + idLength + (colorMapType ? buffer.readUInt16LE(5) * buffer.readUInt8(7) / 8 : 0);

    const pixels: Color[] = new Array(width * height);
    const flipY = (descriptor & 0x20) === 0; // Origin in bottom-left if bit 5 is 0

    if (imageType === 2) {
      // Uncompressed
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const srcY = flipY ? (height - 1 - y) : y;
          const srcIdx = dataOffset + (srcY * width + x) * bytesPerPixel;
          const dstIdx = y * width + x;

          const b = buffer.readUInt8(srcIdx);
          const g = buffer.readUInt8(srcIdx + 1);
          const r = buffer.readUInt8(srcIdx + 2);

          pixels[dstIdx] = new Color(r, g, b);
        }
      }
    } else {
      // RLE compressed
      let srcIdx = dataOffset;
      let pixelIdx = 0;

      while (pixelIdx < width * height) {
        const packet = buffer.readUInt8(srcIdx++);
        const count = (packet & 0x7F) + 1;

        if (packet & 0x80) {
          // RLE packet
          const b = buffer.readUInt8(srcIdx);
          const g = buffer.readUInt8(srcIdx + 1);
          const r = buffer.readUInt8(srcIdx + 2);
          srcIdx += bytesPerPixel;

          const color = new Color(r, g, b);
          for (let i = 0; i < count; i++) {
            pixels[pixelIdx++] = color;
          }
        } else {
          // Raw packet
          for (let i = 0; i < count; i++) {
            const b = buffer.readUInt8(srcIdx);
            const g = buffer.readUInt8(srcIdx + 1);
            const r = buffer.readUInt8(srcIdx + 2);
            srcIdx += bytesPerPixel;
            pixels[pixelIdx++] = new Color(r, g, b);
          }
        }
      }

      // Flip Y if needed
      if (flipY) {
        for (let y = 0; y < height / 2; y++) {
          for (let x = 0; x < width; x++) {
            const top = y * width + x;
            const bottom = (height - 1 - y) * width + x;
            [pixels[top], pixels[bottom]] = [pixels[bottom], pixels[top]];
          }
        }
      }
    }

    return new Texture(path.split('/').pop() || 'texture', width, height, pixels);
  }

  private loadJPG(path: string): Texture {
    // For now, create a placeholder - full JPEG decoding is complex
    // In a real implementation, you'd use a JPEG library
    const name = path.split('/').pop() || 'texture';

    // Try to guess color from filename
    const lower = name.toLowerCase();
    let color = new Color(128, 128, 128);

    if (lower.includes('red') || lower.includes('ctf')) color = new Color(180, 60, 60);
    else if (lower.includes('blue')) color = new Color(60, 60, 180);
    else if (lower.includes('wood')) color = new Color(139, 90, 43);
    else if (lower.includes('stone') || lower.includes('rock')) color = new Color(100, 95, 90);
    else if (lower.includes('dirt')) color = new Color(101, 67, 33);
    else if (lower.includes('metal')) color = new Color(140, 145, 150);

    return Texture.solid(name, color, 64, 64);
  }

  private guessColorFromName(name: string): Color {
    const lower = name.toLowerCase();

    if (lower.includes('sky') || lower.includes('space')) return new Color(20, 20, 40);
    if (lower.includes('red') || lower.includes('ctf')) return new Color(180, 60, 60);
    if (lower.includes('blue')) return new Color(60, 60, 180);
    if (lower.includes('wood')) return new Color(139, 90, 43);
    if (lower.includes('stone') || lower.includes('rock')) return new Color(100, 95, 90);
    if (lower.includes('metal')) return new Color(140, 145, 150);
    if (lower.includes('dirt') || lower.includes('earth')) return new Color(101, 67, 33);
    if (lower.includes('sun') || lower.includes('light')) return new Color(255, 220, 150);
    if (lower.includes('nebula')) return new Color(80, 40, 120);

    return new Color(100, 100, 100);
  }

  private buildMaterials(): void {
    if (!this.bsp) return;

    for (let i = 0; i < this.bsp.textures.length; i++) {
      const texInfo = this.bsp.textures[i];
      const texture = this.textures.get(i);

      const color = texture
        ? texture.getAverageColor()
        : this.guessColorFromName(texInfo.name);

      this.materials.set(i, {
        name: texInfo.name || `texture_${i}`,
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
      const texIndex = face.textureIndex;

      // Skip invalid textures
      if (texIndex < 0 || texIndex >= this.bsp.textures.length) continue;

      const texName = this.bsp.textures[texIndex]?.name?.toLowerCase() || '';

      // Skip special textures
      if (texName.includes('sky')) continue;
      if (texName.includes('clip')) continue;
      if (texName.includes('trigger')) continue;
      if (texName.includes('hint')) continue;
      if (texName.includes('nodraw')) continue;
      if (texName.includes('caulk')) continue;

      // Only handle polygon and mesh faces for now (skip patches)
      if (face.type !== Q3FaceType.POLYGON && face.type !== Q3FaceType.MESH) {
        continue;
      }

      if (!facesByTexture.has(texIndex)) {
        facesByTexture.set(texIndex, []);
      }
      facesByTexture.get(texIndex)!.push(faceIdx);
    }

    // Create mesh for each texture group
    for (const [texIndex, faceIndices] of facesByTexture) {
      const material = this.materials.get(texIndex) || {
        name: 'default',
        color: new Color(100, 100, 100),
      };

      const mesh = new Mesh(material);

      for (const faceIdx of faceIndices) {
        this.addFaceToMesh(mesh, faceIdx);
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

  private addFaceToMesh(mesh: Mesh, faceIdx: number): void {
    if (!this.bsp) return;

    const face = this.bsp.faces[faceIdx];

    if (face.type === Q3FaceType.POLYGON || face.type === Q3FaceType.MESH) {
      // For polygons and meshes, use meshverts for triangle indices
      const baseIndex = mesh.vertices.length;

      // Add all vertices for this face
      for (let i = 0; i < face.numVertices; i++) {
        const vertIdx = face.firstVertex + i;
        const q3Vert = this.bsp.vertices[vertIdx];

        const pos = q3ToEngine(
          q3Vert.position.x,
          q3Vert.position.y,
          q3Vert.position.z
        ).scale(Q3_SCALE);

        const normal = q3ToEngine(
          q3Vert.normal.x,
          q3Vert.normal.y,
          q3Vert.normal.z
        ).normalize();

        mesh.addVertex(pos, normal, q3Vert.texCoord);
      }

      // Add triangles using meshverts
      for (let i = 0; i < face.numMeshVerts; i += 3) {
        const mv0 = this.bsp.meshVerts[face.firstMeshVert + i];
        const mv1 = this.bsp.meshVerts[face.firstMeshVert + i + 1];
        const mv2 = this.bsp.meshVerts[face.firstMeshVert + i + 2];

        // Reverse winding for coordinate system change
        mesh.addTriangle(
          baseIndex + mv0,
          baseIndex + mv2,
          baseIndex + mv1,
          false
        );
      }
    }
  }

  private parseSpawns(): SpawnPoint[] {
    if (!this.bsp) return [];

    const spawns: SpawnPoint[] = [];
    const entities = this.parseEntities();

    for (const ent of entities) {
      let team: 'T' | 'CT' | 'DM' | undefined;

      // Q3/UT spawn point class names
      switch (ent.classname) {
        case 'info_player_deathmatch':
        case 'info_player_start':
          team = 'DM';
          break;
        case 'team_CTF_redspawn':
        case 'info_player_team1':
          team = 'T';  // Red = T
          break;
        case 'team_CTF_bluespawn':
        case 'info_player_team2':
          team = 'CT'; // Blue = CT
          break;
        default:
          continue;
      }

      if (ent.origin) {
        const [x, y, z] = ent.origin.split(' ').map(Number);
        const pos = q3ToEngine(x, y, z).scale(Q3_SCALE);

        const angle = ent.angle ? parseFloat(ent.angle) : 0;

        spawns.push({
          position: [pos.x, pos.y, pos.z],
          angle: angle * Math.PI / 180,
          team,
        });
      }
    }

    // If no spawns found, create defaults
    if (spawns.length === 0) {
      spawns.push({ position: [0, 2, 0], angle: 0, team: 'DM' });
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

  private computeBounds(): AABB {
    if (!this.bsp || this.bsp.models.length === 0) {
      return {
        min: new Vector3(-100, -100, -100),
        max: new Vector3(100, 100, 100),
      };
    }

    const model = this.bsp.models[0];
    const min = q3ToEngine(model.mins.x, model.mins.y, model.mins.z).scale(Q3_SCALE);
    const max = q3ToEngine(model.maxs.x, model.maxs.y, model.maxs.z).scale(Q3_SCALE);

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
