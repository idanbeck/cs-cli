// GoldSrc BSP v30 Parser for Counter-Strike 1.6 maps
// Reference: https://developer.valvesoftware.com/wiki/BSP_(GoldSrc)

import { readFileSync } from 'fs';

// BSP Version
export const BSP_VERSION = 30;

// Lump types
export enum LumpType {
  ENTITIES = 0,
  PLANES = 1,
  TEXTURES = 2,
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

export const LUMP_COUNT = 15;

// Data structures
export interface BSPLump {
  offset: number;
  length: number;
}

export interface BSPHeader {
  version: number;
  lumps: BSPLump[];
}

export interface BSPVertex {
  x: number;
  y: number;
  z: number;
}

export interface BSPPlane {
  normal: BSPVertex;
  dist: number;
  type: number;
}

export interface BSPEdge {
  v: [number, number]; // Vertex indices
}

export interface BSPFace {
  planeNum: number;
  side: number;
  firstEdge: number;
  numEdges: number;
  texInfo: number;
  styles: [number, number, number, number];
  lightmapOffset: number;
}

export interface BSPTexInfo {
  s: [number, number, number, number]; // S vector + offset
  t: [number, number, number, number]; // T vector + offset
  mipTexIndex: number;
  flags: number;
}

export interface BSPMipTexHeader {
  numTextures: number;
  offsets: number[];
}

export interface BSPMipTex {
  name: string;
  width: number;
  height: number;
  offsets: [number, number, number, number]; // Offsets to 4 mip levels
}

export interface BSPModel {
  mins: BSPVertex;
  maxs: BSPVertex;
  origin: BSPVertex;
  headNodes: [number, number, number, number];
  visLeafs: number;
  firstFace: number;
  numFaces: number;
}

export interface BSPNode {
  planeNum: number;
  children: [number, number];
  mins: [number, number, number];
  maxs: [number, number, number];
  firstFace: number;
  numFaces: number;
}

export interface BSPLeaf {
  contents: number;
  visOffset: number;
  mins: [number, number, number];
  maxs: [number, number, number];
  firstMarkSurface: number;
  numMarkSurfaces: number;
  ambientLevels: [number, number, number, number];
}

export interface BSPClipNode {
  planeNum: number;
  children: [number, number];
}

export interface ParsedBSP {
  header: BSPHeader;
  entities: string;
  planes: BSPPlane[];
  vertices: BSPVertex[];
  nodes: BSPNode[];
  texInfo: BSPTexInfo[];
  faces: BSPFace[];
  lighting: Uint8Array | null;
  leaves: BSPLeaf[];
  markSurfaces: number[];
  edges: BSPEdge[];
  surfEdges: number[];
  models: BSPModel[];
  mipTexHeader: BSPMipTexHeader;
  mipTextures: BSPMipTex[];
  clipNodes: BSPClipNode[];
  visibility: Uint8Array | null;
}

export class BSPParser {
  private buffer: Buffer;
  private offset: number = 0;

  constructor(data: Buffer) {
    this.buffer = data;
  }

  static fromFile(path: string): BSPParser {
    const data = readFileSync(path);
    return new BSPParser(data);
  }

  parse(): ParsedBSP {
    const header = this.parseHeader();

    if (header.version !== BSP_VERSION) {
      throw new Error(`Unsupported BSP version: ${header.version} (expected ${BSP_VERSION})`);
    }

    return {
      header,
      entities: this.parseEntities(header.lumps[LumpType.ENTITIES]),
      planes: this.parsePlanes(header.lumps[LumpType.PLANES]),
      vertices: this.parseVertices(header.lumps[LumpType.VERTICES]),
      nodes: this.parseNodes(header.lumps[LumpType.NODES]),
      texInfo: this.parseTexInfo(header.lumps[LumpType.TEXINFO]),
      faces: this.parseFaces(header.lumps[LumpType.FACES]),
      lighting: this.parseLighting(header.lumps[LumpType.LIGHTING]),
      leaves: this.parseLeaves(header.lumps[LumpType.LEAVES]),
      markSurfaces: this.parseMarkSurfaces(header.lumps[LumpType.MARKSURFACES]),
      edges: this.parseEdges(header.lumps[LumpType.EDGES]),
      surfEdges: this.parseSurfEdges(header.lumps[LumpType.SURFEDGES]),
      models: this.parseModels(header.lumps[LumpType.MODELS]),
      mipTexHeader: this.parseMipTexHeader(header.lumps[LumpType.TEXTURES]),
      mipTextures: this.parseMipTextures(header.lumps[LumpType.TEXTURES]),
      clipNodes: this.parseClipNodes(header.lumps[LumpType.CLIPNODES]),
      visibility: this.parseVisibility(header.lumps[LumpType.VISIBILITY]),
    };
  }

  private parseHeader(): BSPHeader {
    this.offset = 0;
    const version = this.readInt32();
    const lumps: BSPLump[] = [];

    for (let i = 0; i < LUMP_COUNT; i++) {
      lumps.push({
        offset: this.readInt32(),
        length: this.readInt32(),
      });
    }

    return { version, lumps };
  }

  private parseEntities(lump: BSPLump): string {
    if (lump.length === 0) return '';
    // Entity string is null-terminated
    const str = this.buffer.toString('ascii', lump.offset, lump.offset + lump.length);
    return str.replace(/\0+$/, '');
  }

  private parsePlanes(lump: BSPLump): BSPPlane[] {
    const planes: BSPPlane[] = [];
    const planeSize = 20; // 3 floats + 1 float + 1 int = 20 bytes
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

  private parseVertices(lump: BSPLump): BSPVertex[] {
    const vertices: BSPVertex[] = [];
    const vertexSize = 12; // 3 floats = 12 bytes
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

  private parseNodes(lump: BSPLump): BSPNode[] {
    const nodes: BSPNode[] = [];
    const nodeSize = 24; // int + 2 shorts + 6 shorts + ushort + ushort = 24 bytes

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

  private parseTexInfo(lump: BSPLump): BSPTexInfo[] {
    const texInfos: BSPTexInfo[] = [];
    const texInfoSize = 40; // 8 floats + 2 ints = 40 bytes

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

  private parseFaces(lump: BSPLump): BSPFace[] {
    const faces: BSPFace[] = [];
    const faceSize = 20; // short + short + int + short + short + 4 bytes + int = 20 bytes

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

  private parseLighting(lump: BSPLump): Uint8Array | null {
    if (lump.length === 0) return null;
    return new Uint8Array(this.buffer.buffer, this.buffer.byteOffset + lump.offset, lump.length);
  }

  private parseLeaves(lump: BSPLump): BSPLeaf[] {
    const leaves: BSPLeaf[] = [];
    const leafSize = 28; // int + int + 6 shorts + ushort + ushort + 4 bytes = 28 bytes

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

  private parseMarkSurfaces(lump: BSPLump): number[] {
    const markSurfaces: number[] = [];
    const count = Math.floor(lump.length / 2);

    this.offset = lump.offset;
    for (let i = 0; i < count; i++) {
      markSurfaces.push(this.readUInt16());
    }

    return markSurfaces;
  }

  private parseEdges(lump: BSPLump): BSPEdge[] {
    const edges: BSPEdge[] = [];
    const edgeSize = 4; // 2 unsigned shorts = 4 bytes

    this.offset = lump.offset;
    const count = Math.floor(lump.length / edgeSize);

    for (let i = 0; i < count; i++) {
      edges.push({
        v: [this.readUInt16(), this.readUInt16()],
      });
    }

    return edges;
  }

  private parseSurfEdges(lump: BSPLump): number[] {
    const surfEdges: number[] = [];
    const count = Math.floor(lump.length / 4);

    this.offset = lump.offset;
    for (let i = 0; i < count; i++) {
      surfEdges.push(this.readInt32());
    }

    return surfEdges;
  }

  private parseModels(lump: BSPLump): BSPModel[] {
    const models: BSPModel[] = [];
    const modelSize = 64; // 9 floats + 4 ints + int + int + int = 64 bytes

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

  private parseMipTexHeader(lump: BSPLump): BSPMipTexHeader {
    if (lump.length === 0) {
      return { numTextures: 0, offsets: [] };
    }

    this.offset = lump.offset;
    const numTextures = this.readInt32();
    const offsets: number[] = [];

    for (let i = 0; i < numTextures; i++) {
      offsets.push(this.readInt32());
    }

    return { numTextures, offsets };
  }

  private parseMipTextures(lump: BSPLump): BSPMipTex[] {
    const textures: BSPMipTex[] = [];
    if (lump.length === 0) return textures;

    this.offset = lump.offset;
    const numTextures = this.readInt32();

    const offsets: number[] = [];
    for (let i = 0; i < numTextures; i++) {
      offsets.push(this.readInt32());
    }

    for (let i = 0; i < numTextures; i++) {
      if (offsets[i] === -1) {
        // External texture
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

      textures.push({ name, width, height, offsets: mipOffsets });
    }

    return textures;
  }

  private parseClipNodes(lump: BSPLump): BSPClipNode[] {
    const clipNodes: BSPClipNode[] = [];
    const clipNodeSize = 8; // int + 2 shorts = 8 bytes

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

  private parseVisibility(lump: BSPLump): Uint8Array | null {
    if (lump.length === 0) return null;
    return new Uint8Array(this.buffer.buffer, this.buffer.byteOffset + lump.offset, lump.length);
  }

  // Buffer reading helpers
  private readInt8(): number {
    const val = this.buffer.readInt8(this.offset);
    this.offset += 1;
    return val;
  }

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
