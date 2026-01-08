// TextureManager - Load and cache textures from WAD files

import { Color } from '../utils/Colors.js';
import { Texture } from './Texture.js';
import { WAD3Parser, MipTexture, ParsedWAD3 } from '../bsp/WAD3Parser.js';
import { WAD2Parser, QuakeMipTexture, ParsedWAD2, QUAKE_PALETTE } from '../bsp/WAD2Parser.js';
import { readFileSync } from 'fs';

export class TextureManager {
  private textures: Map<string, Texture> = new Map();
  private loadedWads: Map<string, ParsedWAD3> = new Map();
  private missingTexture: Texture;

  constructor() {
    // Create default missing texture (magenta/black checkerboard)
    this.missingTexture = Texture.checkerboard(
      '__missing__',
      new Color(255, 0, 255),
      new Color(0, 0, 0),
      32,
      8
    );
  }

  // Load a WAD file and add all its textures (auto-detect WAD2 vs WAD3)
  loadWAD(path: string): void {
    try {
      // Read file and check magic
      const data = readFileSync(path);
      const magic = data.toString('ascii', 0, 4);

      if (magic === 'WAD3') {
        this.loadWAD3(path, data);
      } else if (magic === 'WAD2') {
        this.loadWAD2(path, data);
      } else {
        console.error(`Unknown WAD format: ${magic}`);
      }
    } catch (e) {
      console.error(`Failed to load WAD ${path}:`, e);
    }
  }

  // Load WAD3 format (GoldSrc/Half-Life)
  private loadWAD3(path: string, data: Buffer): void {
    const parser = new WAD3Parser(data);
    const parsed = parser.parse();

    this.loadedWads.set(path, parsed);

    // Convert all miptextures to Texture objects
    for (const [name, mipTex] of parsed.textures) {
      const texture = Texture.fromMipTexture(mipTex);
      this.textures.set(name.toLowerCase(), texture);
    }

    console.log(`Loaded WAD3: ${path} (${parsed.textures.size} textures)`);
  }

  // Load WAD2 format (Quake 1)
  private loadWAD2(path: string, data: Buffer): void {
    const parser = new WAD2Parser(data);
    const parsed = parser.parse();

    // Convert all miptextures to Texture objects using Quake palette
    for (const [name, mipTex] of parsed.textures) {
      const texture = this.createTextureFromQuakeMipTex(mipTex);
      this.textures.set(name.toLowerCase(), texture);
    }

    console.log(`Loaded WAD2: ${path} (${parsed.textures.size} textures)`);
  }

  // Create texture from Quake miptex using shared palette
  private createTextureFromQuakeMipTex(mipTex: QuakeMipTexture): Texture {
    const pixels: Color[] = [];
    const mip0 = mipTex.pixels[0];

    for (let i = 0; i < mipTex.width * mipTex.height; i++) {
      const paletteIndex = mip0[i] || 0;
      if (paletteIndex < QUAKE_PALETTE.length) {
        pixels.push(QUAKE_PALETTE[paletteIndex].clone());
      } else {
        pixels.push(new Color(255, 0, 255));
      }
    }

    return new Texture(mipTex.name, mipTex.width, mipTex.height, pixels);
  }

  // Create texture from Quake BSP embedded miptex
  createTextureFromQuakeBSPMipTex(name: string, width: number, height: number, pixels: Uint8Array): Texture {
    const colorPixels: Color[] = [];

    for (let i = 0; i < width * height; i++) {
      const paletteIndex = pixels[i] || 0;
      if (paletteIndex < QUAKE_PALETTE.length) {
        colorPixels.push(QUAKE_PALETTE[paletteIndex].clone());
      } else {
        colorPixels.push(new Color(255, 0, 255));
      }
    }

    return new Texture(name, width, height, colorPixels);
  }

  // Load multiple WAD files
  loadWADs(paths: string[]): void {
    for (const path of paths) {
      this.loadWAD(path);
    }
  }

  // Get texture by name (case-insensitive)
  get(name: string): Texture {
    const texture = this.textures.get(name.toLowerCase());
    if (texture) {
      return texture;
    }
    return this.missingTexture;
  }

  // Check if texture exists
  has(name: string): boolean {
    return this.textures.has(name.toLowerCase());
  }

  // Add a texture manually (for embedded BSP textures)
  addTexture(name: string, texture: Texture): void {
    this.textures.set(name.toLowerCase(), texture);
  }

  // Add texture from MipTexture data (from BSP embedded textures)
  addMipTexture(mipTex: MipTexture): void {
    const texture = Texture.fromMipTexture(mipTex);
    this.textures.set(mipTex.name.toLowerCase(), texture);
  }

  // Create a solid color texture as fallback
  createSolidTexture(name: string, color: Color): Texture {
    const texture = Texture.solid(name, color);
    this.textures.set(name.toLowerCase(), texture);
    return texture;
  }

  // Get all loaded texture names
  getTextureNames(): string[] {
    return Array.from(this.textures.keys());
  }

  // Get count of loaded textures
  getCount(): number {
    return this.textures.size;
  }

  // Clear all loaded textures
  clear(): void {
    this.textures.clear();
    this.loadedWads.clear();
  }

  // Get missing/error texture
  getMissingTexture(): Texture {
    return this.missingTexture;
  }

  // Debug: list all loaded textures
  listTextures(): void {
    console.log(`TextureManager: ${this.textures.size} textures loaded`);
    for (const [name, tex] of this.textures) {
      console.log(`  ${name}: ${tex.width}x${tex.height}`);
    }
  }

  // Get texture info for debugging
  getTextureInfo(name: string): { width: number; height: number; found: boolean } | null {
    const texture = this.textures.get(name.toLowerCase());
    if (texture) {
      return { width: texture.width, height: texture.height, found: true };
    }
    return { width: 0, height: 0, found: false };
  }
}

// Global texture manager instance
let globalTextureManager: TextureManager | null = null;

export function getTextureManager(): TextureManager {
  if (!globalTextureManager) {
    globalTextureManager = new TextureManager();
  }
  return globalTextureManager;
}

export function resetTextureManager(): void {
  if (globalTextureManager) {
    globalTextureManager.clear();
  }
  globalTextureManager = null;
}
