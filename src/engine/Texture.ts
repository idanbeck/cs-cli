// Texture class for BSP/WAD texture sampling

import { Color } from '../utils/Colors.js';
import { MipTexture } from '../bsp/WAD3Parser.js';

export class Texture {
  public readonly name: string;
  public readonly width: number;
  public readonly height: number;
  private pixels: Color[];

  constructor(name: string, width: number, height: number, pixels: Color[]) {
    this.name = name;
    this.width = width;
    this.height = height;
    this.pixels = pixels;
  }

  // Sample texture at UV coordinates (0-1 range, wrapping)
  sample(u: number, v: number): Color {
    // Wrap UVs to 0-1 range
    u = u - Math.floor(u);
    v = v - Math.floor(v);

    // Convert to pixel coordinates (nearest-neighbor)
    const x = Math.floor(u * this.width) % this.width;
    const y = Math.floor(v * this.height) % this.height;

    const index = y * this.width + x;
    if (index >= 0 && index < this.pixels.length) {
      return this.pixels[index].clone();
    }

    return new Color(255, 0, 255); // Magenta for missing/error
  }

  // Sample with pixelation (lower effective resolution for retro 8-bit look)
  // pixelSize: how many texture pixels to average together (e.g., 4 = 4x4 block averaging)
  samplePixelated(u: number, v: number, pixelSize: number = 4): Color {
    // Wrap UVs to 0-1 range
    u = u - Math.floor(u);
    v = v - Math.floor(v);

    // Snap UV to lower resolution grid
    const effectiveWidth = Math.max(1, Math.floor(this.width / pixelSize));
    const effectiveHeight = Math.max(1, Math.floor(this.height / pixelSize));

    // Find which "big pixel" we're in
    const bigX = Math.floor(u * effectiveWidth);
    const bigY = Math.floor(v * effectiveHeight);

    // Sample the center of this big pixel block (or average if desired)
    const centerX = Math.floor((bigX + 0.5) * pixelSize) % this.width;
    const centerY = Math.floor((bigY + 0.5) * pixelSize) % this.height;

    const index = centerY * this.width + centerX;
    if (index >= 0 && index < this.pixels.length) {
      return this.pixels[index].clone();
    }

    return new Color(255, 0, 255);
  }

  // Sample with block averaging (mean pooling) for smooth retro look
  sampleBlockAverage(u: number, v: number, blockSize: number = 4): Color {
    // Wrap UVs
    u = u - Math.floor(u);
    v = v - Math.floor(v);

    // Find which block we're in
    const effectiveWidth = Math.max(1, Math.floor(this.width / blockSize));
    const effectiveHeight = Math.max(1, Math.floor(this.height / blockSize));

    const blockX = Math.floor(u * effectiveWidth);
    const blockY = Math.floor(v * effectiveHeight);

    // Average all pixels in this block
    let r = 0, g = 0, b = 0;
    let count = 0;

    const startX = blockX * blockSize;
    const startY = blockY * blockSize;

    for (let dy = 0; dy < blockSize && startY + dy < this.height; dy++) {
      for (let dx = 0; dx < blockSize && startX + dx < this.width; dx++) {
        const index = (startY + dy) * this.width + (startX + dx);
        if (index >= 0 && index < this.pixels.length) {
          const pixel = this.pixels[index];
          r += pixel.r;
          g += pixel.g;
          b += pixel.b;
          count++;
        }
      }
    }

    if (count > 0) {
      return new Color(
        Math.round(r / count),
        Math.round(g / count),
        Math.round(b / count)
      );
    }

    return new Color(255, 0, 255);
  }

  // Sample with bilinear filtering (smoother but slower)
  sampleBilinear(u: number, v: number): Color {
    // Wrap UVs
    u = u - Math.floor(u);
    v = v - Math.floor(v);

    // Convert to pixel coordinates
    const px = u * this.width;
    const py = v * this.height;

    const x0 = Math.floor(px) % this.width;
    const y0 = Math.floor(py) % this.height;
    const x1 = (x0 + 1) % this.width;
    const y1 = (y0 + 1) % this.height;

    const fx = px - Math.floor(px);
    const fy = py - Math.floor(py);

    // Get 4 neighboring pixels
    const c00 = this.pixels[y0 * this.width + x0];
    const c10 = this.pixels[y0 * this.width + x1];
    const c01 = this.pixels[y1 * this.width + x0];
    const c11 = this.pixels[y1 * this.width + x1];

    // Bilinear interpolation
    const r = Math.round(
      c00.r * (1 - fx) * (1 - fy) +
      c10.r * fx * (1 - fy) +
      c01.r * (1 - fx) * fy +
      c11.r * fx * fy
    );
    const g = Math.round(
      c00.g * (1 - fx) * (1 - fy) +
      c10.g * fx * (1 - fy) +
      c01.g * (1 - fx) * fy +
      c11.g * fx * fy
    );
    const b = Math.round(
      c00.b * (1 - fx) * (1 - fy) +
      c10.b * fx * (1 - fy) +
      c01.b * (1 - fx) * fy +
      c11.b * fx * fy
    );

    return new Color(r, g, b);
  }

  // Get raw pixel at coordinates
  getPixel(x: number, y: number): Color {
    x = ((x % this.width) + this.width) % this.width;
    y = ((y % this.height) + this.height) % this.height;
    return this.pixels[y * this.width + x].clone();
  }

  // Create texture from WAD3 MipTexture
  static fromMipTexture(mipTex: MipTexture): Texture {
    const pixels: Color[] = [];
    const mip0 = mipTex.pixels[0]; // Use highest resolution mip level

    for (let i = 0; i < mipTex.width * mipTex.height; i++) {
      const paletteIndex = mip0[i];
      if (paletteIndex < mipTex.palette.length) {
        pixels.push(mipTex.palette[paletteIndex].clone());
      } else {
        pixels.push(new Color(255, 0, 255)); // Magenta for invalid
      }
    }

    return new Texture(mipTex.name, mipTex.width, mipTex.height, pixels);
  }

  // Create solid color texture (for fallback/debug)
  static solid(name: string, color: Color, width: number = 16, height: number = 16): Texture {
    const pixels: Color[] = [];
    for (let i = 0; i < width * height; i++) {
      pixels.push(color.clone());
    }
    return new Texture(name, width, height, pixels);
  }

  // Create checkerboard texture (for debug/missing textures)
  static checkerboard(
    name: string,
    color1: Color = new Color(255, 0, 255),
    color2: Color = new Color(0, 0, 0),
    size: number = 16,
    checkSize: number = 4
  ): Texture {
    const pixels: Color[] = [];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const cx = Math.floor(x / checkSize);
        const cy = Math.floor(y / checkSize);
        const isCheck = (cx + cy) % 2 === 0;
        pixels.push(isCheck ? color1.clone() : color2.clone());
      }
    }
    return new Texture(name, size, size, pixels);
  }

  // Get raw RGB data as Uint8Array (for native renderer)
  getRawRGB(): Uint8Array {
    const data = new Uint8Array(this.width * this.height * 3);
    for (let i = 0; i < this.pixels.length; i++) {
      const pixel = this.pixels[i];
      data[i * 3] = pixel.r;
      data[i * 3 + 1] = pixel.g;
      data[i * 3 + 2] = pixel.b;
    }
    return data;
  }

  // Get average color of texture (useful for distance rendering)
  getAverageColor(): Color {
    let r = 0, g = 0, b = 0;
    for (const pixel of this.pixels) {
      r += pixel.r;
      g += pixel.g;
      b += pixel.b;
    }
    const count = this.pixels.length;
    return new Color(
      Math.round(r / count),
      Math.round(g / count),
      Math.round(b / count)
    );
  }

  // Check if texture name indicates a special texture
  isSky(): boolean {
    return this.name.toLowerCase().startsWith('sky');
  }

  isTransparent(): boolean {
    // In GoldSrc, textures starting with { are transparent
    return this.name.startsWith('{');
  }

  isAnimated(): boolean {
    // Animated textures start with +
    return this.name.startsWith('+');
  }

  isLiquid(): boolean {
    const lower = this.name.toLowerCase();
    return lower.startsWith('!') || lower.includes('water') || lower.includes('slime') || lower.includes('lava');
  }
}
