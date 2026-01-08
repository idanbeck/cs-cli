// WAD3 Texture File Parser for Half-Life/Counter-Strike
// Reference: https://developer.valvesoftware.com/wiki/WAD

import { readFileSync } from 'fs';
import { Color } from '../utils/Colors.js';

// WAD3 magic number
export const WAD3_MAGIC = 'WAD3';

// Entry types
export const MIPTEX_TYPE = 0x43; // 'C' - MipTex type

export interface WAD3Header {
  magic: string;
  numEntries: number;
  dirOffset: number;
}

export interface WAD3Entry {
  offset: number;
  diskSize: number;
  size: number;
  type: number;
  compression: number;
  padding: number;
  name: string;
}

export interface MipTexture {
  name: string;
  width: number;
  height: number;
  pixels: Uint8Array[];  // 4 mip levels
  palette: Color[];      // 256 colors
}

export interface ParsedWAD3 {
  header: WAD3Header;
  entries: WAD3Entry[];
  textures: Map<string, MipTexture>;
}

export class WAD3Parser {
  private buffer: Buffer;
  private offset: number = 0;

  constructor(data: Buffer) {
    this.buffer = data;
  }

  static fromFile(path: string): WAD3Parser {
    const data = readFileSync(path);
    return new WAD3Parser(data);
  }

  parse(): ParsedWAD3 {
    const header = this.parseHeader();

    if (header.magic !== WAD3_MAGIC) {
      throw new Error(`Invalid WAD file: expected ${WAD3_MAGIC}, got ${header.magic}`);
    }

    const entries = this.parseDirectory(header);
    const textures = this.parseTextures(entries);

    return { header, entries, textures };
  }

  private parseHeader(): WAD3Header {
    this.offset = 0;
    const magic = this.buffer.toString('ascii', 0, 4);
    this.offset = 4;
    const numEntries = this.readInt32();
    const dirOffset = this.readInt32();

    return { magic, numEntries, dirOffset };
  }

  private parseDirectory(header: WAD3Header): WAD3Entry[] {
    const entries: WAD3Entry[] = [];
    this.offset = header.dirOffset;

    // Directory entry size: 32 bytes
    // int offset, int diskSize, int size, char type, char compression, short padding, char[16] name
    for (let i = 0; i < header.numEntries; i++) {
      const entryOffset = this.readInt32();
      const diskSize = this.readInt32();
      const size = this.readInt32();
      const type = this.readUInt8();
      const compression = this.readUInt8();
      const padding = this.readUInt16();

      // Read 16-byte name
      const nameBytes = this.buffer.subarray(this.offset, this.offset + 16);
      const name = nameBytes.toString('ascii').replace(/\0.*$/, '').toLowerCase();
      this.offset += 16;

      entries.push({
        offset: entryOffset,
        diskSize,
        size,
        type,
        compression,
        padding,
        name,
      });
    }

    return entries;
  }

  private parseTextures(entries: WAD3Entry[]): Map<string, MipTexture> {
    const textures = new Map<string, MipTexture>();

    for (const entry of entries) {
      if (entry.type !== MIPTEX_TYPE) continue;
      if (entry.compression !== 0) {
        console.warn(`Skipping compressed texture: ${entry.name}`);
        continue;
      }

      try {
        const texture = this.parseMipTexture(entry);
        if (texture) {
          textures.set(entry.name.toLowerCase(), texture);
        }
      } catch (e) {
        console.warn(`Failed to parse texture ${entry.name}:`, e);
      }
    }

    return textures;
  }

  private parseMipTexture(entry: WAD3Entry): MipTexture | null {
    this.offset = entry.offset;

    // MipTex header
    const nameBytes = this.buffer.subarray(this.offset, this.offset + 16);
    const name = nameBytes.toString('ascii').replace(/\0.*$/, '');
    this.offset += 16;

    const width = this.readUInt32();
    const height = this.readUInt32();

    // Offsets to 4 mip levels (relative to start of miptex)
    const mipOffsets = [
      this.readUInt32(),
      this.readUInt32(),
      this.readUInt32(),
      this.readUInt32(),
    ];

    // Validate dimensions
    if (width === 0 || height === 0 || width > 4096 || height > 4096) {
      return null;
    }

    // Read pixel data for each mip level
    const pixels: Uint8Array[] = [];
    let mipWidth = width;
    let mipHeight = height;

    for (let i = 0; i < 4; i++) {
      if (mipOffsets[i] === 0) {
        // No data for this mip level
        pixels.push(new Uint8Array(0));
      } else {
        const dataOffset = entry.offset + mipOffsets[i];
        const pixelCount = mipWidth * mipHeight;
        pixels.push(new Uint8Array(this.buffer.buffer, this.buffer.byteOffset + dataOffset, pixelCount));
      }
      mipWidth = Math.max(1, Math.floor(mipWidth / 2));
      mipHeight = Math.max(1, Math.floor(mipHeight / 2));
    }

    // Palette is located after all mip data
    // Calculate palette offset: after mip3 data + 2 bytes (padding)
    const mip0Size = width * height;
    const mip1Size = Math.floor(width / 2) * Math.floor(height / 2);
    const mip2Size = Math.floor(width / 4) * Math.floor(height / 4);
    const mip3Size = Math.floor(width / 8) * Math.floor(height / 8);
    const totalMipSize = mip0Size + mip1Size + mip2Size + mip3Size;

    const paletteOffset = entry.offset + mipOffsets[0] + totalMipSize + 2; // +2 for padding/count

    // Read 256-color palette (768 bytes = 256 * 3)
    const palette: Color[] = [];
    this.offset = paletteOffset;

    for (let i = 0; i < 256; i++) {
      if (this.offset + 3 > this.buffer.length) {
        // Palette truncated, fill with default
        palette.push(new Color(128, 128, 128));
      } else {
        const r = this.readUInt8();
        const g = this.readUInt8();
        const b = this.readUInt8();
        palette.push(new Color(r, g, b));
      }
    }

    return { name, width, height, pixels, palette };
  }

  // Get a specific texture by name
  getTexture(name: string): MipTexture | undefined {
    const parsed = this.parse();
    return parsed.textures.get(name.toLowerCase());
  }

  // Buffer reading helpers
  private readUInt8(): number {
    const val = this.buffer.readUInt8(this.offset);
    this.offset += 1;
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
}
