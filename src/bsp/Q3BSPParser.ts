// Q3BSPParser - Parse Quake 3 BSP (IBSP v46) format
// Used by Quake 3 Arena, and many community maps

import { readFileSync } from 'fs';

// Quake 3 BSP header
const Q3BSP_MAGIC = 0x50534249; // "IBSP" in little-endian
const Q3BSP_VERSION = 46;

// Lump indices
enum Q3Lump {
  ENTITIES = 0,
  TEXTURES = 1,
  PLANES = 2,
  NODES = 3,
  LEAFS = 4,
  LEAFFACES = 5,
  LEAFBRUSHES = 6,
  MODELS = 7,
  BRUSHES = 8,
  BRUSHSIDES = 9,
  VERTICES = 10,
  MESHVERTS = 11,
  EFFECTS = 12,
  FACES = 13,
  LIGHTMAPS = 14,
  LIGHTVOLS = 15,
  VISDATA = 16,
}

const NUM_LUMPS = 17;

// Face types
export enum Q3FaceType {
  POLYGON = 1,
  PATCH = 2,
  MESH = 3,
  BILLBOARD = 4,
}

// Parsed structures
export interface Q3Vertex {
  position: { x: number; y: number; z: number };
  texCoord: [number, number];      // Texture UV
  lightmapCoord: [number, number]; // Lightmap UV
  normal: { x: number; y: number; z: number };
  color: [number, number, number, number]; // RGBA
}

export interface Q3Face {
  textureIndex: number;
  effectIndex: number;
  type: Q3FaceType;
  firstVertex: number;
  numVertices: number;
  firstMeshVert: number;
  numMeshVerts: number;
  lightmapIndex: number;
  lightmapStart: [number, number];
  lightmapSize: [number, number];
  lightmapOrigin: { x: number; y: number; z: number };
  lightmapVecs: [{ x: number; y: number; z: number }, { x: number; y: number; z: number }];
  normal: { x: number; y: number; z: number };
  patchSize: [number, number]; // For bezier patches
}

export interface Q3Texture {
  name: string;
  flags: number;
  contents: number;
}

export interface Q3Plane {
  normal: { x: number; y: number; z: number };
  dist: number;
}

export interface Q3Model {
  mins: { x: number; y: number; z: number };
  maxs: { x: number; y: number; z: number };
  firstFace: number;
  numFaces: number;
  firstBrush: number;
  numBrushes: number;
}

export interface Q3Lightmap {
  data: Uint8Array; // 128x128 RGB
}

export interface ParsedQ3BSP {
  entities: string;
  textures: Q3Texture[];
  planes: Q3Plane[];
  vertices: Q3Vertex[];
  meshVerts: number[]; // Triangle indices
  faces: Q3Face[];
  models: Q3Model[];
  lightmaps: Q3Lightmap[];
}

export class Q3BSPParser {
  private buffer: Buffer;
  private lumps: { offset: number; length: number }[] = [];

  private constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  static fromFile(path: string): Q3BSPParser {
    const buffer = readFileSync(path);
    return new Q3BSPParser(buffer);
  }

  static fromBuffer(buffer: Buffer): Q3BSPParser {
    return new Q3BSPParser(buffer);
  }

  parse(): ParsedQ3BSP {
    this.parseHeader();

    return {
      entities: this.parseEntities(),
      textures: this.parseTextures(),
      planes: this.parsePlanes(),
      vertices: this.parseVertices(),
      meshVerts: this.parseMeshVerts(),
      faces: this.parseFaces(),
      models: this.parseModels(),
      lightmaps: this.parseLightmaps(),
    };
  }

  private parseHeader(): void {
    const magic = this.buffer.readUInt32LE(0);
    const version = this.buffer.readUInt32LE(4);

    if (magic !== Q3BSP_MAGIC) {
      throw new Error(`Invalid Q3 BSP magic: expected IBSP, got 0x${magic.toString(16)}`);
    }

    if (version !== Q3BSP_VERSION) {
      console.warn(`Q3 BSP version ${version}, expected ${Q3BSP_VERSION}`);
    }

    // Parse lump directory (17 lumps, 8 bytes each)
    for (let i = 0; i < NUM_LUMPS; i++) {
      const offset = 8 + i * 8;
      this.lumps.push({
        offset: this.buffer.readUInt32LE(offset),
        length: this.buffer.readUInt32LE(offset + 4),
      });
    }
  }

  private parseEntities(): string {
    const lump = this.lumps[Q3Lump.ENTITIES];
    return this.buffer.toString('utf8', lump.offset, lump.offset + lump.length - 1);
  }

  private parseTextures(): Q3Texture[] {
    const lump = this.lumps[Q3Lump.TEXTURES];
    const textures: Q3Texture[] = [];
    const TEXTURE_SIZE = 72; // 64 bytes name + 4 flags + 4 contents

    for (let i = 0; i < lump.length / TEXTURE_SIZE; i++) {
      const offset = lump.offset + i * TEXTURE_SIZE;

      // Read null-terminated string (64 bytes max)
      let nameEnd = offset;
      while (nameEnd < offset + 64 && this.buffer[nameEnd] !== 0) {
        nameEnd++;
      }
      const name = this.buffer.toString('utf8', offset, nameEnd);

      textures.push({
        name,
        flags: this.buffer.readInt32LE(offset + 64),
        contents: this.buffer.readInt32LE(offset + 68),
      });
    }

    return textures;
  }

  private parsePlanes(): Q3Plane[] {
    const lump = this.lumps[Q3Lump.PLANES];
    const planes: Q3Plane[] = [];
    const PLANE_SIZE = 16; // 3 floats normal + 1 float dist

    for (let i = 0; i < lump.length / PLANE_SIZE; i++) {
      const offset = lump.offset + i * PLANE_SIZE;
      planes.push({
        normal: {
          x: this.buffer.readFloatLE(offset),
          y: this.buffer.readFloatLE(offset + 4),
          z: this.buffer.readFloatLE(offset + 8),
        },
        dist: this.buffer.readFloatLE(offset + 12),
      });
    }

    return planes;
  }

  private parseVertices(): Q3Vertex[] {
    const lump = this.lumps[Q3Lump.VERTICES];
    const vertices: Q3Vertex[] = [];
    const VERTEX_SIZE = 44; // position(12) + texCoord(8) + lightmapCoord(8) + normal(12) + color(4)

    for (let i = 0; i < lump.length / VERTEX_SIZE; i++) {
      const offset = lump.offset + i * VERTEX_SIZE;
      vertices.push({
        position: {
          x: this.buffer.readFloatLE(offset),
          y: this.buffer.readFloatLE(offset + 4),
          z: this.buffer.readFloatLE(offset + 8),
        },
        texCoord: [
          this.buffer.readFloatLE(offset + 12),
          this.buffer.readFloatLE(offset + 16),
        ],
        lightmapCoord: [
          this.buffer.readFloatLE(offset + 20),
          this.buffer.readFloatLE(offset + 24),
        ],
        normal: {
          x: this.buffer.readFloatLE(offset + 28),
          y: this.buffer.readFloatLE(offset + 32),
          z: this.buffer.readFloatLE(offset + 36),
        },
        color: [
          this.buffer.readUInt8(offset + 40),
          this.buffer.readUInt8(offset + 41),
          this.buffer.readUInt8(offset + 42),
          this.buffer.readUInt8(offset + 43),
        ],
      });
    }

    return vertices;
  }

  private parseMeshVerts(): number[] {
    const lump = this.lumps[Q3Lump.MESHVERTS];
    const meshVerts: number[] = [];

    for (let i = 0; i < lump.length / 4; i++) {
      meshVerts.push(this.buffer.readInt32LE(lump.offset + i * 4));
    }

    return meshVerts;
  }

  private parseFaces(): Q3Face[] {
    const lump = this.lumps[Q3Lump.FACES];
    const faces: Q3Face[] = [];
    const FACE_SIZE = 104;

    for (let i = 0; i < lump.length / FACE_SIZE; i++) {
      const offset = lump.offset + i * FACE_SIZE;
      faces.push({
        textureIndex: this.buffer.readInt32LE(offset),
        effectIndex: this.buffer.readInt32LE(offset + 4),
        type: this.buffer.readInt32LE(offset + 8) as Q3FaceType,
        firstVertex: this.buffer.readInt32LE(offset + 12),
        numVertices: this.buffer.readInt32LE(offset + 16),
        firstMeshVert: this.buffer.readInt32LE(offset + 20),
        numMeshVerts: this.buffer.readInt32LE(offset + 24),
        lightmapIndex: this.buffer.readInt32LE(offset + 28),
        lightmapStart: [
          this.buffer.readInt32LE(offset + 32),
          this.buffer.readInt32LE(offset + 36),
        ],
        lightmapSize: [
          this.buffer.readInt32LE(offset + 40),
          this.buffer.readInt32LE(offset + 44),
        ],
        lightmapOrigin: {
          x: this.buffer.readFloatLE(offset + 48),
          y: this.buffer.readFloatLE(offset + 52),
          z: this.buffer.readFloatLE(offset + 56),
        },
        lightmapVecs: [
          {
            x: this.buffer.readFloatLE(offset + 60),
            y: this.buffer.readFloatLE(offset + 64),
            z: this.buffer.readFloatLE(offset + 68),
          },
          {
            x: this.buffer.readFloatLE(offset + 72),
            y: this.buffer.readFloatLE(offset + 76),
            z: this.buffer.readFloatLE(offset + 80),
          },
        ],
        normal: {
          x: this.buffer.readFloatLE(offset + 84),
          y: this.buffer.readFloatLE(offset + 88),
          z: this.buffer.readFloatLE(offset + 92),
        },
        patchSize: [
          this.buffer.readInt32LE(offset + 96),
          this.buffer.readInt32LE(offset + 100),
        ],
      });
    }

    return faces;
  }

  private parseModels(): Q3Model[] {
    const lump = this.lumps[Q3Lump.MODELS];
    const models: Q3Model[] = [];
    const MODEL_SIZE = 40;

    for (let i = 0; i < lump.length / MODEL_SIZE; i++) {
      const offset = lump.offset + i * MODEL_SIZE;
      models.push({
        mins: {
          x: this.buffer.readFloatLE(offset),
          y: this.buffer.readFloatLE(offset + 4),
          z: this.buffer.readFloatLE(offset + 8),
        },
        maxs: {
          x: this.buffer.readFloatLE(offset + 12),
          y: this.buffer.readFloatLE(offset + 16),
          z: this.buffer.readFloatLE(offset + 20),
        },
        firstFace: this.buffer.readInt32LE(offset + 24),
        numFaces: this.buffer.readInt32LE(offset + 28),
        firstBrush: this.buffer.readInt32LE(offset + 32),
        numBrushes: this.buffer.readInt32LE(offset + 36),
      });
    }

    return models;
  }

  private parseLightmaps(): Q3Lightmap[] {
    const lump = this.lumps[Q3Lump.LIGHTMAPS];
    const lightmaps: Q3Lightmap[] = [];
    const LIGHTMAP_SIZE = 128 * 128 * 3; // 128x128 RGB

    for (let i = 0; i < lump.length / LIGHTMAP_SIZE; i++) {
      const offset = lump.offset + i * LIGHTMAP_SIZE;
      const data = new Uint8Array(LIGHTMAP_SIZE);
      for (let j = 0; j < LIGHTMAP_SIZE; j++) {
        data[j] = this.buffer.readUInt8(offset + j);
      }
      lightmaps.push({ data });
    }

    return lightmaps;
  }
}
