/**
 * NativeRenderer - TypeScript wrapper for the native SIMD renderer.
 *
 * This module provides a high-performance rendering backend using native code.
 * Falls back gracefully to JavaScript renderer if native module is unavailable.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Debug stats from native renderer
export interface NativeDebugStats {
  frame: number;
  totalTris: number;
  nearClipped: number;
  frustumCulled: number;
  backfaceCulled: number;
  degenerate: number;
  texturesSet: number;
  trianglesWithUV: number;
  trianglesTextured: number;
  backfaceCullingEnabled: boolean;
  texturesEnabled: boolean;
  hasTexture: boolean;
  textureWidth: number;
  textureHeight: number;
}

// Interface for the native renderer module
interface NativeRendererModule {
  init(width: number, height: number, msaaSamples: number): boolean;
  clear(r: number, g: number, b: number): void;
  setOptions(backfaceCulling: boolean, texturesEnabled: boolean): void;
  setTexture(data: Uint8Array | null, width: number, height: number): void;
  renderTrianglesBatch(
    vertices: Float32Array,
    indices: Uint32Array,
    mvpMatrix: Float32Array,
    colors: Uint8Array,
    normals: Float32Array,
    uvs?: Float32Array | null
  ): number;
  resolveMSAA(): void;
  getFramebuffer(): Uint8Array;
  getDepthBuffer(): Float32Array;
  getDimensions(): { width: number; height: number };
  cleanup(): void;
  hasSIMD(): boolean;
  getDebugStats(): NativeDebugStats;
}

export class NativeRenderer {
  private module: NativeRendererModule | null = null;
  private _isAvailable: boolean = false;
  private _hasSIMD: boolean = false;
  private _width: number = 0;
  private _height: number = 0;
  private _msaaSamples: number = 1;

  constructor() {
    this.tryLoadNativeModule();
  }

  /**
   * Attempt to load the native renderer module.
   */
  private tryLoadNativeModule(): void {
    try {
      // Get the directory of this module
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);

      // Create require function for loading native modules
      const require = createRequire(import.meta.url);

      // Try to load the native renderer
      // Path is relative to the compiled dist directory
      const modulePath = join(__dirname, '../../native/build/Release/renderer.node');
      this.module = require(modulePath) as NativeRendererModule;
      this._isAvailable = true;
      this._hasSIMD = this.module.hasSIMD();
    } catch (error) {
      // Native module not available, will use JS fallback
      this.module = null;
      this._isAvailable = false;
      this._hasSIMD = false;
    }
  }

  /**
   * Check if the native renderer is available.
   */
  get isAvailable(): boolean {
    return this._isAvailable;
  }

  /**
   * Check if SIMD acceleration is available.
   */
  get hasSIMD(): boolean {
    return this._hasSIMD;
  }

  /**
   * Get current width.
   */
  get width(): number {
    return this._width;
  }

  /**
   * Get current height.
   */
  get height(): number {
    return this._height;
  }

  /**
   * Initialize the renderer with specified dimensions.
   *
   * @param width Framebuffer width
   * @param height Framebuffer height
   * @param msaaSamples Number of MSAA samples (1, 4, or 16)
   * @returns true if initialization succeeded
   */
  init(width: number, height: number, msaaSamples: number = 1): boolean {
    if (!this.module) {
      return false;
    }

    try {
      const result = this.module.init(width, height, msaaSamples);
      if (result) {
        this._width = width;
        this._height = height;
        this._msaaSamples = msaaSamples;
      }
      return result;
    } catch {
      return false;
    }
  }

  /**
   * Clear the framebuffer with a color.
   *
   * @param r Red (0-255)
   * @param g Green (0-255)
   * @param b Blue (0-255)
   */
  clear(r: number, g: number, b: number): void {
    if (!this.module) return;
    this.module.clear(r, g, b);
  }

  /**
   * Set rendering options.
   *
   * @param backfaceCulling Enable backface culling
   * @param texturesEnabled Enable texture mapping
   */
  setOptions(backfaceCulling: boolean, texturesEnabled: boolean): void {
    if (!this.module) return;
    this.module.setOptions(backfaceCulling, texturesEnabled);
  }

  /**
   * Set current texture for subsequent rendering.
   *
   * @param data RGB texture data (Uint8Array) or null to clear
   * @param width Texture width
   * @param height Texture height
   */
  setTexture(data: Uint8Array | null, width: number, height: number): void {
    if (!this.module) return;
    this.module.setTexture(data, width, height);
  }

  /**
   * Render a batch of triangles.
   *
   * @param vertices Float32Array of vertex positions (x, y, z per vertex)
   * @param indices Uint32Array of triangle indices (3 per triangle)
   * @param mvpMatrix Float32Array of 16 floats (4x4 MVP matrix, column-major)
   * @param colors Uint8Array of RGB colors per vertex
   * @param normals Float32Array of vertex normals (x, y, z per vertex)
   * @param uvs Float32Array of UV coordinates (u, v per vertex) - optional
   * @returns Number of triangles rendered
   */
  renderTrianglesBatch(
    vertices: Float32Array,
    indices: Uint32Array,
    mvpMatrix: Float32Array,
    colors: Uint8Array,
    normals: Float32Array,
    uvs?: Float32Array | null
  ): number {
    if (!this.module) return 0;
    return this.module.renderTrianglesBatch(vertices, indices, mvpMatrix, colors, normals, uvs);
  }

  /**
   * Resolve MSAA samples to final framebuffer.
   */
  resolveMSAA(): void {
    if (!this.module) return;
    this.module.resolveMSAA();
  }

  /**
   * Get the framebuffer as RGB data.
   * Returns a Uint8Array view of the internal buffer.
   */
  getFramebuffer(): Uint8Array | null {
    if (!this.module) return null;
    return this.module.getFramebuffer();
  }

  /**
   * Get the depth buffer as Float32Array.
   * Used for occlusion testing of sprites/billboards rendered in JS.
   */
  getDepthBuffer(): Float32Array | null {
    if (!this.module) return null;
    return this.module.getDepthBuffer();
  }

  /**
   * Get renderer dimensions.
   */
  getDimensions(): { width: number; height: number } {
    if (!this.module) {
      return { width: 0, height: 0 };
    }
    return this.module.getDimensions();
  }

  /**
   * Clean up renderer resources.
   */
  cleanup(): void {
    if (!this.module) return;
    this.module.cleanup();
    this._width = 0;
    this._height = 0;
  }

  /**
   * Get debug stats from native renderer.
   */
  getDebugStats(): NativeDebugStats | null {
    if (!this.module) return null;
    return this.module.getDebugStats();
  }
}

// Singleton instance
let nativeRendererInstance: NativeRenderer | null = null;

/**
 * Get the native renderer instance.
 * Creates it if it doesn't exist.
 */
export function getNativeRenderer(): NativeRenderer {
  if (!nativeRendererInstance) {
    nativeRendererInstance = new NativeRenderer();
  }
  return nativeRendererInstance;
}

/**
 * Check if native rendering is available.
 * Useful for quickly checking before trying to use it.
 */
export function isNativeRenderingAvailable(): boolean {
  return getNativeRenderer().isAvailable;
}
