// Quake 1 BSP v29 Parser
// Reference: https://quakewiki.org/wiki/Quake_BSP_Format

import { readFileSync } from 'fs';

// BSP Version
export const QUAKE_BSP_VERSION = 29;

// Lump types (same order as GoldSrc)
export enum QuakeLumpType {
  ENTITIES = 0,
  PLANES = 1,
  MIPTEX = 2,
  VERTICES = 3,
  VISIBILITY = 4,
  NODES = 5,
  TEXINFO = 6,
  FACES = 7,
  LIGHTING = 8,
  CLIPNODES = 9,
  LEAVES = 10,
  MARKSURFACES = 11,
  EDGES = 12,
  SURFEDGES = 13,
  MODELS = 14,
}

export const QUAKE_LUMP_COUNT = 15;

// Data structures
export interface QuakeLump {
  offset: number;
  length: number;
}

export interface QuakeHeader {
  version: number;
  lumps: QuakeLump[];
}

export interface QuakeVertex {
  x: number;
  y: number;
  z: number;
}

export interface QuakePlane {
  normal: QuakeVertex;
  dist: number;
  type: number;
}

export interface QuakeEdge {
  v: [number, number];
}

export interface QuakeFace {
  planeNum: number;
  side: number;
  firstEdge: number;
  numEdges: number;
  texInfo: number;
  styles: [number, number, number, number];
  lightmapOffset: number;
}

export interface QuakeTexInfo {
  s: [number, number, number, number];
  t: [number, number, number, number];
  mipTexIndex: number;
  flags: number;
}

export interface QuakeMipTex {
  name: string;
  width: number;
  height: number;
  offsets: [number, number, number, number];
  // Quake embeds pixel data in miptex
  pixels?: Uint8Array[];
}

export interface QuakeModel {
  mins: QuakeVertex;
  maxs: QuakeVertex;
  origin: QuakeVertex;
  headNodes: [number, number, number, number];
  visLeafs: number;
  firstFace: number;
  numFaces: number;
}

export interface QuakeNode {
  planeNum: number;
  children: [number, number];
  mins: [number, number, number];
  maxs: [number, number, number];
  firstFace: number;
  numFaces: number;
}

export interface QuakeLeaf {
  contents: number;
  visOffset: number;
  mins: [number, number, number];
  maxs: [number, number, number];
  firstMarkSurface: number;
  numMarkSurfaces: number;
  ambientLevels: [number, number, number, number];
}

export interface QuakeClipNode {
  planeNum: number;
  children: [number, number];
}

export interface ParsedQuakeBSP {
  header: QuakeHeader;
  entities: string;
  planes: QuakePlane[];
  vertices: QuakeVertex[];
  nodes: QuakeNode[];
  texInfo: QuakeTexInfo[];
  faces: QuakeFace[];
  lighting: Uint8Array | null;
  leaves: QuakeLeaf[];
  markSurfaces: number[];
  edges: QuakeEdge[];
  surfEdges: number[];
  models: QuakeModel[];
  mipTextures: QuakeMipTex[];
  clipNodes: QuakeClipNode[];
  visibility: Uint8Array | null;
}

export class QuakeBSPParser {
  private buffer: Buffer;
  private offset: number = 0;

  constructor(data: Buffer) {
    this.buffer = data;
  }

  static fromFile(path: string): QuakeBSPParser {
    const data = readFileSync(path);
    return new QuakeBSPParser(data);
  }

  parse(): ParsedQuakeBSP {
    const header = this.parseHeader();

    if (header.version !== QUAKE_BSP_VERSION) {
      throw new Error(`Unsupported BSP version: ${header.version} (expected ${QUAKE_BSP_VERSION})`);
    }

    return {
      header,
      entities: this.parseEntities(header.lumps[QuakeLumpType.ENTITIES]),
      planes: this.parsePlanes(header.lumps[QuakeLumpType.PLANES]),
      vertices: this.parseVertices(header.lumps[QuakeLumpType.VERTICES]),
      nodes: this.parseNodes(header.lumps[QuakeLumpType.NODES]),
      texInfo: this.parseTexInfo(header.lumps[QuakeLumpType.TEXINFO]),
      faces: this.parseFaces(header.lumps[QuakeLumpType.FACES]),
      lighting: this.parseLighting(header.lumps[QuakeLumpType.LIGHTING]),
      leaves: this.parseLeaves(header.lumps[QuakeLumpType.LEAVES]),
      markSurfaces: this.parseMarkSurfaces(header.lumps[QuakeLumpType.MARKSURFACES]),
      edges: this.parseEdges(header.lumps[QuakeLumpType.EDGES]),
      surfEdges: this.parseSurfEdges(header.lumps[QuakeLumpType.SURFEDGES]),
      models: this.parseModels(header.lumps[QuakeLumpType.MODELS]),
      mipTextures: this.parseMipTextures(header.lumps[QuakeLumpType.MIPTEX]),
      clipNodes: this.parseClipNodes(header.lumps[QuakeLumpType.CLIPNODES]),
      visibility: this.parseVisibility(header.lumps[QuakeLumpType.VISIBILITY]),
    };
  }

  private parseHeader(): QuakeHeader {
    this.offset = 0;
    const version = this.readInt32();
    const lumps: QuakeLump[] = [];

    for (let i = 0; i < QUAKE_LUMP_COUNT; i++) {
      lumps.push({
        offset: this.readInt32(),
        length: this.readInt32(),
      });
    }

    return { version, lumps };
  }

  private parseEntities(lump: QuakeLump): string {
    if (lump.length === 0) return '';
    const str = this.buffer.toString('ascii', lump.offset, lump.offset + lump.length);
    return str.replace(/\0+$/, '');
  }

  private parsePlanes(lump: QuakeLump): QuakePlane[] {
    const planes: QuakePlane[] = [];
    const planeSize = 20;
    const count = Math.floor(lump.length / planeSize);

    this.offset = lump.offset;
    for (let i = 0; i < count; i++) {
      planes.push({
        normal: {
          x: this.readFloat(),
          y: this.readFloat(),
          z: this.readFloat(),
        },
        dist: this.readFloat(),
        type: this.readInt32(),
      });
    }

    return planes;
  }

  private parseVertices(lump: QuakeLump): QuakeVertex[] {
    const vertices: QuakeVertex[] = [];
    const vertexSize = 12;
    const count = Math.floor(lump.length / vertexSize);

    this.offset = lump.offset;
    for (let i = 0; i < count; i++) {
      vertices.push({
        x: this.readFloat(),
        y: this.readFloat(),
        z: this.readFloat(),
      });
    }

    return vertices;
  }

  private parseNodes(lump: QuakeLump): QuakeNode[] {
    const nodes: QuakeNode[] = [];
    const nodeSize = 24;

    this.offset = lump.offset;
    const count = Math.floor(lump.length / nodeSize);

    for (let i = 0; i < count; i++) {
      nodes.push({
        planeNum: this.readInt32(),
        children: [this.readInt16(), this.readInt16()],
        mins: [this.readInt16(), this.readInt16(), this.readInt16()],
        maxs: [this.readInt16(), this.readInt16(), this.readInt16()],
        firstFace: this.readUInt16(),
        numFaces: this.readUInt16(),
      });
    }

    return nodes;
  }

  private parseTexInfo(lump: QuakeLump): QuakeTexInfo[] {
    const texInfos: QuakeTexInfo[] = [];
    const texInfoSize = 40;

    this.offset = lump.offset;
    const count = Math.floor(lump.length / texInfoSize);

    for (let i = 0; i < count; i++) {
      texInfos.push({
        s: [this.readFloat(), this.readFloat(), this.readFloat(), this.readFloat()],
        t: [this.readFloat(), this.readFloat(), this.readFloat(), this.readFloat()],
        mipTexIndex: this.readInt32(),
        flags: this.readInt32(),
      });
    }

    return texInfos;
  }

  private parseFaces(lump: QuakeLump): QuakeFace[] {
    const faces: QuakeFace[] = [];
    const faceSize = 20;

    this.offset = lump.offset;
    const count = Math.floor(lump.length / faceSize);

    for (let i = 0; i < count; i++) {
      faces.push({
        planeNum: this.readUInt16(),
        side: this.readUInt16(),
        firstEdge: this.readInt32(),
        numEdges: this.readUInt16(),
        texInfo: this.readUInt16(),
        styles: [this.readUInt8(), this.readUInt8(), this.readUInt8(), this.readUInt8()],
        lightmapOffset: this.readInt32(),
      });
    }

    return faces;
  }

  private parseLighting(lump: QuakeLump): Uint8Array | null {
    if (lump.length === 0) return null;
    return new Uint8Array(this.buffer.buffer, this.buffer.byteOffset + lump.offset, lump.length);
  }

  private parseLeaves(lump: QuakeLump): QuakeLeaf[] {
    const leaves: QuakeLeaf[] = [];
    const leafSize = 28;

    this.offset = lump.offset;
    const count = Math.floor(lump.length / leafSize);

    for (let i = 0; i < count; i++) {
      leaves.push({
        contents: this.readInt32(),
        visOffset: this.readInt32(),
        mins: [this.readInt16(), this.readInt16(), this.readInt16()],
        maxs: [this.readInt16(), this.readInt16(), this.readInt16()],
        firstMarkSurface: this.readUInt16(),
        numMarkSurfaces: this.readUInt16(),
        ambientLevels: [this.readUInt8(), this.readUInt8(), this.readUInt8(), this.readUInt8()],
      });
    }

    return leaves;
  }

  private parseMarkSurfaces(lump: QuakeLump): number[] {
    const markSurfaces: number[] = [];
    const count = Math.floor(lump.length / 2);

    this.offset = lump.offset;
    for (let i = 0; i < count; i++) {
      markSurfaces.push(this.readUInt16());
    }

    return markSurfaces;
  }

  private parseEdges(lump: QuakeLump): QuakeEdge[] {
    const edges: QuakeEdge[] = [];
    const edgeSize = 4;

    this.offset = lump.offset;
    const count = Math.floor(lump.length / edgeSize);

    for (let i = 0; i < count; i++) {
      edges.push({
        v: [this.readUInt16(), this.readUInt16()],
      });
    }

    return edges;
  }

  private parseSurfEdges(lump: QuakeLump): number[] {
    const surfEdges: number[] = [];
    const count = Math.floor(lump.length / 4);

    this.offset = lump.offset;
    for (let i = 0; i < count; i++) {
      surfEdges.push(this.readInt32());
    }

    return surfEdges;
  }

  private parseModels(lump: QuakeLump): QuakeModel[] {
    const models: QuakeModel[] = [];
    const modelSize = 64;

    this.offset = lump.offset;
    const count = Math.floor(lump.length / modelSize);

    for (let i = 0; i < count; i++) {
      models.push({
        mins: { x: this.readFloat(), y: this.readFloat(), z: this.readFloat() },
        maxs: { x: this.readFloat(), y: this.readFloat(), z: this.readFloat() },
        origin: { x: this.readFloat(), y: this.readFloat(), z: this.readFloat() },
        headNodes: [this.readInt32(), this.readInt32(), this.readInt32(), this.readInt32()],
        visLeafs: this.readInt32(),
        firstFace: this.readInt32(),
        numFaces: this.readInt32(),
      });
    }

    return models;
  }

  private parseMipTextures(lump: QuakeLump): QuakeMipTex[] {
    const textures: QuakeMipTex[] = [];
    if (lump.length === 0) return textures;

    this.offset = lump.offset;
    const numTextures = this.readInt32();

    const offsets: number[] = [];
    for (let i = 0; i < numTextures; i++) {
      offsets.push(this.readInt32());
    }

    for (let i = 0; i < numTextures; i++) {
      if (offsets[i] === -1) {
        textures.push({
          name: '',
          width: 0,
          height: 0,
          offsets: [0, 0, 0, 0],
        });
        continue;
      }

      this.offset = lump.offset + offsets[i];

      // Read 16-byte name
      const nameBytes = this.buffer.subarray(this.offset, this.offset + 16);
      const name = nameBytes.toString('ascii').replace(/\0.*$/, '');
      this.offset += 16;

      const width = this.readUInt32();
      const height = this.readUInt32();
      const mipOffsets: [number, number, number, number] = [
        this.readUInt32(),
        this.readUInt32(),
        this.readUInt32(),
        this.readUInt32(),
      ];

      // Read pixel data for mip level 0
      const pixels: Uint8Array[] = [];
      if (mipOffsets[0] > 0) {
        const dataOffset = lump.offset + offsets[i] + mipOffsets[0];
        const pixelCount = width * height;
        if (dataOffset + pixelCount <= this.buffer.length) {
          pixels.push(new Uint8Array(this.buffer.buffer, this.buffer.byteOffset + dataOffset, pixelCount));
        }
      }

      textures.push({ name, width, height, offsets: mipOffsets, pixels });
    }

    return textures;
  }

  private parseClipNodes(lump: QuakeLump): QuakeClipNode[] {
    const clipNodes: QuakeClipNode[] = [];
    const clipNodeSize = 8;

    this.offset = lump.offset;
    const count = Math.floor(lump.length / clipNodeSize);

    for (let i = 0; i < count; i++) {
      clipNodes.push({
        planeNum: this.readInt32(),
        children: [this.readInt16(), this.readInt16()],
      });
    }

    return clipNodes;
  }

  private parseVisibility(lump: QuakeLump): Uint8Array | null {
    if (lump.length === 0) return null;
    return new Uint8Array(this.buffer.buffer, this.buffer.byteOffset + lump.offset, lump.length);
  }

  // Buffer reading helpers
  private readUInt8(): number {
    const val = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return val;
  }

  private readInt16(): number {
    const val = this.buffer.readInt16LE(this.offset);
    this.offset += 2;
    return val;
  }

  private readUInt16(): number {
    const val = this.buffer.readUInt16LE(this.offset);
    this.offset += 2;
    return val;
  }

  private readInt32(): number {
    const val = this.buffer.readInt32LE(this.offset);
    this.offset += 4;
    return val;
  }

  private readUInt32(): number {
    const val = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return val;
  }

  private readFloat(): number {
    const val = this.buffer.readFloatLE(this.offset);
    this.offset += 4;
    return val;
  }
}
