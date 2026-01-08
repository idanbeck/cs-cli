import { Vector3 } from './math/Vector3.js';
import { Matrix4 } from './math/Matrix4.js';
import { Mesh, Triangle, Vertex } from './Mesh.js';
import { Framebuffer } from './Framebuffer.js';
import { DepthBuffer } from './DepthBuffer.js';
import { Color, getDepthShading, SHADE_CHARS } from '../utils/Colors.js';
import { clamp, edgeFunction } from './math/MathUtils.js';

export interface ClipVertex {
  position: [number, number, number, number]; // x, y, z, w in clip space
  worldPosition: Vector3;
  normal?: Vector3;
  color?: Color;
}

export interface RasterTriangle {
  v0: ClipVertex;
  v1: ClipVertex;
  v2: ClipVertex;
  material: { color: Color };
}

// MSAA sample patterns (offsets within pixel, in range [-0.5, 0.5])
const MSAA_PATTERNS = {
  'none': [[0, 0]],
  '4x': [
    [-0.25, -0.25], [0.25, -0.25],
    [-0.25, 0.25], [0.25, 0.25]
  ],
  '16x': [
    [-0.375, -0.375], [-0.125, -0.375], [0.125, -0.375], [0.375, -0.375],
    [-0.375, -0.125], [-0.125, -0.125], [0.125, -0.125], [0.375, -0.125],
    [-0.375, 0.125], [-0.125, 0.125], [0.125, 0.125], [0.375, 0.125],
    [-0.375, 0.375], [-0.125, 0.375], [0.125, 0.375], [0.375, 0.375]
  ]
};

export type MSAAMode = 'none' | '4x' | '16x';

// Sample buffer for MSAA - stores multiple color samples per pixel
interface MSAASample {
  color: Color;
  depth: number;
  covered: boolean;
}

export class Rasterizer {
  private framebuffer: Framebuffer;
  private depthBuffer: DepthBuffer;
  private width: number;
  private height: number;

  // MSAA settings
  private msaaMode: MSAAMode = 'none';
  private sampleBuffer: MSAASample[][] | null = null;
  private sampleCount: number = 1;

  // Lighting settings
  public ambientLight: number = 0.3;
  public lightDirection: Vector3 = new Vector3(0.5, 1, 0.3).normalize();
  public enableLighting: boolean = true;
  public enableDepthShading: boolean = true;
  public maxDepth: number = 50;
  public enableBackfaceCulling: boolean = true;

  // Near plane for clipping (in clip space, w = nearPlane)
  // Balance between allowing close objects and avoiding depth artifacts
  private nearPlane: number = 0.05;

  constructor(framebuffer: Framebuffer, depthBuffer: DepthBuffer) {
    this.framebuffer = framebuffer;
    this.depthBuffer = depthBuffer;
    this.width = framebuffer.width;
    this.height = framebuffer.height;
  }

  resize(framebuffer: Framebuffer, depthBuffer: DepthBuffer): void {
    this.framebuffer = framebuffer;
    this.depthBuffer = depthBuffer;
    this.width = framebuffer.width;
    this.height = framebuffer.height;
    // Rebuild sample buffer if MSAA is enabled
    if (this.msaaMode !== 'none') {
      this.initSampleBuffer();
    }
  }

  // Set MSAA mode
  setMSAAMode(mode: MSAAMode): void {
    this.msaaMode = mode;
    this.sampleCount = MSAA_PATTERNS[mode].length;
    if (mode !== 'none') {
      this.initSampleBuffer();
    } else {
      this.sampleBuffer = null;
    }
  }

  getMSAAMode(): MSAAMode {
    return this.msaaMode;
  }

  // Initialize sample buffer for MSAA
  private initSampleBuffer(): void {
    this.sampleBuffer = new Array(this.width * this.height);
    for (let i = 0; i < this.sampleBuffer.length; i++) {
      this.sampleBuffer[i] = new Array(this.sampleCount);
      for (let s = 0; s < this.sampleCount; s++) {
        this.sampleBuffer[i][s] = {
          color: Color.black(),
          depth: 1.0,
          covered: false
        };
      }
    }
  }

  // Clear sample buffer
  private clearSampleBuffer(clearColor: Color): void {
    if (!this.sampleBuffer) return;
    for (let i = 0; i < this.sampleBuffer.length; i++) {
      for (let s = 0; s < this.sampleCount; s++) {
        this.sampleBuffer[i][s].color.copy(clearColor);
        this.sampleBuffer[i][s].depth = 1.0;
        this.sampleBuffer[i][s].covered = false;
      }
    }
  }

  // Resolve MSAA samples to framebuffer (average colors)
  resolveMSAA(): void {
    if (!this.sampleBuffer || this.msaaMode === 'none') return;

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const index = y * this.width + x;
        const samples = this.sampleBuffer[index];

        // Average all sample colors
        let r = 0, g = 0, b = 0;
        for (const sample of samples) {
          r += sample.color.r;
          g += sample.color.g;
          b += sample.color.b;
        }

        r = Math.round(r / this.sampleCount);
        g = Math.round(g / this.sampleCount);
        b = Math.round(b / this.sampleCount);

        // Write to both fg and bg (fg for basic mode, bg for halfblock/sixel)
        const resolvedColor = new Color(r, g, b);
        this.framebuffer.setPixel(x, y, '█', resolvedColor, resolvedColor);
      }
    }
  }

  clear(): void {
    this.framebuffer.clear(' ', Color.white(), Color.black());
    this.depthBuffer.clear();
    // Clear MSAA sample buffer if enabled
    if (this.sampleBuffer) {
      this.clearSampleBuffer(Color.black());
    }
  }

  clearWithColor(clearColor: Color): void {
    this.framebuffer.clear(' ', Color.white(), clearColor);
    this.depthBuffer.clear();
    if (this.sampleBuffer) {
      this.clearSampleBuffer(clearColor);
    }
  }

  // Clear only the MSAA sample buffer (used when framebuffer is cleared separately)
  clearMSAASamples(clearColor: Color): void {
    if (this.sampleBuffer) {
      this.clearSampleBuffer(clearColor);
    }
  }

  // Interpolate between two clip vertices at parameter t
  private lerpClipVertex(a: ClipVertex, b: ClipVertex, t: number): ClipVertex {
    return {
      position: [
        a.position[0] + (b.position[0] - a.position[0]) * t,
        a.position[1] + (b.position[1] - a.position[1]) * t,
        a.position[2] + (b.position[2] - a.position[2]) * t,
        a.position[3] + (b.position[3] - a.position[3]) * t
      ],
      worldPosition: Vector3.lerp(a.worldPosition, b.worldPosition, t),
      normal: a.normal && b.normal
        ? Vector3.lerp(a.normal, b.normal, t).normalize()
        : a.normal || b.normal,
      color: a.color && b.color
        ? Color.lerp(a.color, b.color, t)
        : a.color || b.color
    };
  }

  // Clip a triangle against the near plane (w = nearPlane)
  // Returns 0, 1, or 2 triangles
  private clipTriangleNearPlane(tri: RasterTriangle): RasterTriangle[] {
    const vertices = [tri.v0, tri.v1, tri.v2];
    const inside: ClipVertex[] = [];
    const outside: ClipVertex[] = [];

    // Classify vertices
    for (const v of vertices) {
      if (v.position[3] >= this.nearPlane) {
        inside.push(v);
      } else {
        outside.push(v);
      }
    }

    // All inside - no clipping needed
    if (inside.length === 3) {
      return [tri];
    }

    // All outside - cull entire triangle
    if (inside.length === 0) {
      return [];
    }

    // Partially inside - need to clip
    if (inside.length === 1) {
      // One vertex inside, two outside - creates one smaller triangle
      const v0 = inside[0];
      const v1 = outside[0];
      const v2 = outside[1];

      // Find intersection points
      const t1 = (this.nearPlane - v0.position[3]) / (v1.position[3] - v0.position[3]);
      const t2 = (this.nearPlane - v0.position[3]) / (v2.position[3] - v0.position[3]);

      const newV1 = this.lerpClipVertex(v0, v1, t1);
      const newV2 = this.lerpClipVertex(v0, v2, t2);

      return [{
        v0: v0,
        v1: newV1,
        v2: newV2,
        material: tri.material
      }];
    }

    // Two vertices inside, one outside - creates two triangles (quad)
    const v0 = inside[0];
    const v1 = inside[1];
    const v2 = outside[0];

    // Find which edges cross the plane
    // We need to find where v0->v2 and v1->v2 intersect the near plane
    const t02 = (this.nearPlane - v0.position[3]) / (v2.position[3] - v0.position[3]);
    const t12 = (this.nearPlane - v1.position[3]) / (v2.position[3] - v1.position[3]);

    const newV02 = this.lerpClipVertex(v0, v2, t02);
    const newV12 = this.lerpClipVertex(v1, v2, t12);

    // Create two triangles from the quad (v0, v1, newV12, newV02)
    return [
      { v0: v0, v1: v1, v2: newV12, material: tri.material },
      { v0: v0, v1: newV12, v2: newV02, material: tri.material }
    ];
  }

  // Transform vertex from clip space to screen space
  private clipToScreen(clipPos: [number, number, number, number]): { x: number; y: number; z: number; w: number } | null {
    const [x, y, z, w] = clipPos;

    // Behind camera or at camera
    if (w <= 0) return null;

    // Perspective divide to get NDC
    const ndcX = x / w;
    const ndcY = y / w;
    const ndcZ = z / w;

    // Clipping check (in NDC space)
    if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1 || ndcZ < -1 || ndcZ > 1) {
      // This vertex is outside, but we might still need to clip the triangle
      // For now, we'll handle this at the triangle level
    }

    // Convert to screen coordinates
    // NDC: x,y in [-1, 1], screen: x in [0, width], y in [0, height]
    // Note: Y is flipped (NDC +Y is up, screen +Y is down)
    return {
      x: (ndcX + 1) * 0.5 * this.width,
      y: (1 - ndcY) * 0.5 * this.height,
      z: ndcZ,
      w: w
    };
  }

  // Rasterize a single triangle (with near-plane clipping)
  rasterizeTriangle(tri: RasterTriangle): void {
    // Clip triangle against near plane - may produce 0, 1, or 2 triangles
    const clippedTris = this.clipTriangleNearPlane(tri);

    // Rasterize each resulting triangle
    for (const clippedTri of clippedTris) {
      this.rasterizeTriangleInternal(clippedTri);
    }
  }

  // Internal rasterization (assumes triangle is already clipped)
  private rasterizeTriangleInternal(tri: RasterTriangle): void {
    // Transform vertices to screen space
    const s0 = this.clipToScreen(tri.v0.position);
    const s1 = this.clipToScreen(tri.v1.position);
    const s2 = this.clipToScreen(tri.v2.position);

    // All vertices should be valid after clipping, but check anyway
    if (!s0 || !s1 || !s2) return;

    // Compute triangle area (2x area for edge functions)
    const area = edgeFunction(s0.x, s0.y, s1.x, s1.y, s2.x, s2.y);

    // Skip degenerate triangles (very small threshold to allow thin triangles at grazing angles)
    if (Math.abs(area) < 0.0001) return;

    // Backface culling: negative area means triangle is facing away from camera
    // (in screen space with Y-down, clockwise winding = front face = positive area)
    if (this.enableBackfaceCulling && area < 0) {
      return;
    }

    // Handle negative area if backface culling is disabled
    let v0 = s0, v1 = s1, v2 = s2;
    let tv0 = tri.v0, tv1 = tri.v1, tv2 = tri.v2;
    let finalArea = area;
    if (area < 0) {
      finalArea = -area;
      v1 = s2;
      v2 = s1;
      tv1 = tri.v2;
      tv2 = tri.v1;
    }

    // Compute bounding box using final vertices
    const minX = Math.max(0, Math.floor(Math.min(v0.x, v1.x, v2.x)));
    const maxX = Math.min(this.width - 1, Math.ceil(Math.max(v0.x, v1.x, v2.x)));
    const minY = Math.max(0, Math.floor(Math.min(v0.y, v1.y, v2.y)));
    const maxY = Math.min(this.height - 1, Math.ceil(Math.max(v0.y, v1.y, v2.y)));

    // Skip degenerate triangles
    if (minX > maxX || minY > maxY) return;

    const invArea = 1 / finalArea;

    // Precompute edge function deltas for incremental calculation
    const A01 = v0.y - v1.y, B01 = v1.x - v0.x;
    const A12 = v1.y - v2.y, B12 = v2.x - v1.x;
    const A20 = v2.y - v0.y, B20 = v0.x - v2.x;

    // Starting point edge values
    const px = minX + 0.5;
    const py = minY + 0.5;

    let w0_row = edgeFunction(v1.x, v1.y, v2.x, v2.y, px, py);
    let w1_row = edgeFunction(v2.x, v2.y, v0.x, v0.y, px, py);
    let w2_row = edgeFunction(v0.x, v0.y, v1.x, v1.y, px, py);

    // Compute lighting (per-triangle for simplicity)
    let lightFactor = 1.0;
    if (this.enableLighting) {
      // Use the first vertex's normal or compute face normal
      const faceNormal = tv0.normal ||
        Vector3.cross(
          Vector3.sub(tv1.worldPosition, tv0.worldPosition),
          Vector3.sub(tv2.worldPosition, tv0.worldPosition)
        ).normalize();

      const nDotL = Math.max(0, Vector3.dot(faceNormal, this.lightDirection));
      lightFactor = this.ambientLight + (1 - this.ambientLight) * nDotL;
    }

    // Base color with lighting
    const baseColor = tri.material.color.clone().multiply(lightFactor);

    // Get MSAA sample pattern
    const samplePattern = MSAA_PATTERNS[this.msaaMode];
    const useMSAA = this.msaaMode !== 'none' && this.sampleBuffer;

    // Rasterize
    for (let y = minY; y <= maxY; y++) {
      let w0 = w0_row;
      let w1 = w1_row;
      let w2 = w2_row;

      for (let x = minX; x <= maxX; x++) {
        const pixelIndex = y * this.width + x;

        if (useMSAA && this.sampleBuffer) {
          // MSAA mode: test each sample point
          let minSampleDepth = 1.0;  // Track minimum depth for main depth buffer
          let anySampleCovered = false;

          for (let s = 0; s < this.sampleCount; s++) {
            const [sx, sy] = samplePattern[s];

            // Compute edge functions at sample point
            const sampleX = x + 0.5 + sx;
            const sampleY = y + 0.5 + sy;

            const sw0 = edgeFunction(v1.x, v1.y, v2.x, v2.y, sampleX, sampleY);
            const sw1 = edgeFunction(v2.x, v2.y, v0.x, v0.y, sampleX, sampleY);
            const sw2 = edgeFunction(v0.x, v0.y, v1.x, v1.y, sampleX, sampleY);

            // Check if sample is inside triangle
            if (sw0 >= 0 && sw1 >= 0 && sw2 >= 0) {
              // Compute barycentric coordinates for this sample
              const sb0 = sw0 * invArea;
              const sb1 = sw1 * invArea;
              const sb2 = sw2 * invArea;

              // Interpolate depth at sample
              const sampleDepth = sb0 * v0.z + sb1 * v1.z + sb2 * v2.z;

              // Depth test for this sample
              const sample = this.sampleBuffer[pixelIndex][s];
              if (sampleDepth < sample.depth) {
                sample.depth = sampleDepth;
                sample.covered = true;
                anySampleCovered = true;

                // Track minimum depth across all samples for main depth buffer
                if (sampleDepth < minSampleDepth) {
                  minSampleDepth = sampleDepth;
                }

                // Compute shaded color
                const worldZ = sb0 * tv0.worldPosition.z + sb1 * tv1.worldPosition.z + sb2 * tv2.worldPosition.z;
                const distance = Math.sqrt(
                  tv0.worldPosition.x * tv0.worldPosition.x +
                  tv0.worldPosition.y * tv0.worldPosition.y +
                  worldZ * worldZ
                );

                if (this.enableDepthShading) {
                  const shading = getDepthShading(baseColor, distance, this.maxDepth);
                  sample.color.copy(shading.color);
                } else {
                  sample.color.copy(baseColor);
                }
              }
            }
          }

          // Also update main depth buffer with minimum sample depth
          // This allows bots/tracers/decals to properly depth-test against geometry
          if (anySampleCovered) {
            this.depthBuffer.testAndSet(x, y, minSampleDepth);
          }
        } else {
          // Standard mode: test center point only
          if (w0 >= 0 && w1 >= 0 && w2 >= 0) {
            // Compute barycentric coordinates
            const b0 = w0 * invArea;
            const b1 = w1 * invArea;
            const b2 = w2 * invArea;

            // Linear interpolation of NDC z for depth buffer
            const depth = b0 * v0.z + b1 * v1.z + b2 * v2.z;

            // Depth test
            if (this.depthBuffer.testAndSet(x, y, depth)) {
              // Compute linear depth for shading
              const worldZ = b0 * tv0.worldPosition.z + b1 * tv1.worldPosition.z + b2 * tv2.worldPosition.z;
              const distance = Math.sqrt(
                tv0.worldPosition.x * tv0.worldPosition.x +
                tv0.worldPosition.y * tv0.worldPosition.y +
                worldZ * worldZ
              );

              let finalColor = baseColor;
              let char = '█';

              if (this.enableDepthShading) {
                const shading = getDepthShading(baseColor, distance, this.maxDepth);
                finalColor = shading.color;
                char = shading.char;
              }

              // Set both fg (for basic mode) and bg (for half-block/sixel modes)
              this.framebuffer.setPixel(x, y, char, finalColor, finalColor);
            }
          }
        }

        // Step right
        w0 += A12;
        w1 += A20;
        w2 += A01;
      }

      // Step down
      w0_row += B12;
      w1_row += B20;
      w2_row += B01;
    }
  }

  // Rasterize a mesh with a given MVP matrix
  rasterizeMesh(mesh: Mesh, mvpMatrix: Matrix4, modelMatrix: Matrix4): void {
    const transformedVertices: ClipVertex[] = [];

    // Transform all vertices
    for (const vertex of mesh.vertices) {
      const clipPos = mvpMatrix.transformVector4(
        vertex.position.x,
        vertex.position.y,
        vertex.position.z,
        1
      );

      const worldPos = modelMatrix.transformPoint(vertex.position);
      const worldNormal = vertex.normal
        ? modelMatrix.transformDirection(vertex.normal).normalize()
        : undefined;

      transformedVertices.push({
        position: clipPos,
        worldPosition: worldPos,
        normal: worldNormal,
        color: vertex.color
      });
    }

    // Rasterize all triangles
    for (const triangle of mesh.triangles) {
      const [i0, i1, i2] = triangle.indices;

      this.rasterizeTriangle({
        v0: transformedVertices[i0],
        v1: transformedVertices[i1],
        v2: transformedVertices[i2],
        material: mesh.material
      });
    }
  }

  // Get the framebuffer for rendering
  getFramebuffer(): Framebuffer {
    return this.framebuffer;
  }

  // Get the depth buffer for debugging
  getDepthBuffer(): DepthBuffer {
    return this.depthBuffer;
  }
}
