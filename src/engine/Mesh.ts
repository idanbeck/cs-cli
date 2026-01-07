import { Vector3 } from './math/Vector3.js';
import { Color } from '../utils/Colors.js';

export interface Vertex {
  position: Vector3;
  normal?: Vector3;
  uv?: [number, number];
  color?: Color;
}

export interface Triangle {
  indices: [number, number, number]; // Indices into vertex array
  normal?: Vector3; // Face normal (computed if not provided)
}

export interface Material {
  name: string;
  color: Color;
  emissive?: boolean; // If true, not affected by lighting
}

export class Mesh {
  public vertices: Vertex[] = [];
  public triangles: Triangle[] = [];
  public material: Material;

  constructor(material?: Material) {
    this.material = material || {
      name: 'default',
      color: Color.gray(128)
    };
  }

  addVertex(position: Vector3, normal?: Vector3, uv?: [number, number], color?: Color): number {
    const index = this.vertices.length;
    this.vertices.push({ position, normal, uv, color });
    return index;
  }

  addTriangle(v0: number, v1: number, v2: number, computeNormal: boolean = true): void {
    const triangle: Triangle = {
      indices: [v0, v1, v2]
    };

    if (computeNormal) {
      triangle.normal = this.computeFaceNormal(v0, v1, v2);
    }

    this.triangles.push(triangle);
  }

  private computeFaceNormal(v0: number, v1: number, v2: number): Vector3 {
    const p0 = this.vertices[v0].position;
    const p1 = this.vertices[v1].position;
    const p2 = this.vertices[v2].position;

    const edge1 = Vector3.sub(p1, p0);
    const edge2 = Vector3.sub(p2, p0);

    return Vector3.cross(edge1, edge2).normalize();
  }

  // Compute vertex normals by averaging adjacent face normals
  computeVertexNormals(): void {
    // Initialize vertex normals to zero
    for (const vertex of this.vertices) {
      vertex.normal = Vector3.zero();
    }

    // Accumulate face normals to vertices
    for (const triangle of this.triangles) {
      const normal = triangle.normal || this.computeFaceNormal(...triangle.indices);
      for (const index of triangle.indices) {
        this.vertices[index].normal!.add(normal);
      }
    }

    // Normalize vertex normals
    for (const vertex of this.vertices) {
      vertex.normal!.normalize();
    }
  }

  // Get bounding box
  getBounds(): { min: Vector3; max: Vector3 } {
    if (this.vertices.length === 0) {
      return { min: Vector3.zero(), max: Vector3.zero() };
    }

    const min = this.vertices[0].position.clone();
    const max = this.vertices[0].position.clone();

    for (const vertex of this.vertices) {
      const p = vertex.position;
      min.x = Math.min(min.x, p.x);
      min.y = Math.min(min.y, p.y);
      min.z = Math.min(min.z, p.z);
      max.x = Math.max(max.x, p.x);
      max.y = Math.max(max.y, p.y);
      max.z = Math.max(max.z, p.z);
    }

    return { min, max };
  }

  // Get center of bounding box
  getCenter(): Vector3 {
    const bounds = this.getBounds();
    return Vector3.lerp(bounds.min, bounds.max, 0.5);
  }

  clone(): Mesh {
    const mesh = new Mesh({ ...this.material, color: this.material.color.clone() });

    for (const vertex of this.vertices) {
      mesh.vertices.push({
        position: vertex.position.clone(),
        normal: vertex.normal?.clone(),
        uv: vertex.uv ? [...vertex.uv] : undefined,
        color: vertex.color?.clone()
      });
    }

    for (const triangle of this.triangles) {
      mesh.triangles.push({
        indices: [...triangle.indices],
        normal: triangle.normal?.clone()
      });
    }

    return mesh;
  }

  // Create a box mesh
  static createBox(width: number, height: number, depth: number, material?: Material): Mesh {
    const mesh = new Mesh(material);
    const hw = width / 2;
    const hh = height / 2;
    const hd = depth / 2;

    // Vertices for each face (separate vertices for proper normals)
    // Front face (z+)
    mesh.addVertex(new Vector3(-hw, -hh, hd), new Vector3(0, 0, 1));
    mesh.addVertex(new Vector3(hw, -hh, hd), new Vector3(0, 0, 1));
    mesh.addVertex(new Vector3(hw, hh, hd), new Vector3(0, 0, 1));
    mesh.addVertex(new Vector3(-hw, hh, hd), new Vector3(0, 0, 1));

    // Back face (z-)
    mesh.addVertex(new Vector3(hw, -hh, -hd), new Vector3(0, 0, -1));
    mesh.addVertex(new Vector3(-hw, -hh, -hd), new Vector3(0, 0, -1));
    mesh.addVertex(new Vector3(-hw, hh, -hd), new Vector3(0, 0, -1));
    mesh.addVertex(new Vector3(hw, hh, -hd), new Vector3(0, 0, -1));

    // Top face (y+)
    mesh.addVertex(new Vector3(-hw, hh, hd), new Vector3(0, 1, 0));
    mesh.addVertex(new Vector3(hw, hh, hd), new Vector3(0, 1, 0));
    mesh.addVertex(new Vector3(hw, hh, -hd), new Vector3(0, 1, 0));
    mesh.addVertex(new Vector3(-hw, hh, -hd), new Vector3(0, 1, 0));

    // Bottom face (y-)
    mesh.addVertex(new Vector3(-hw, -hh, -hd), new Vector3(0, -1, 0));
    mesh.addVertex(new Vector3(hw, -hh, -hd), new Vector3(0, -1, 0));
    mesh.addVertex(new Vector3(hw, -hh, hd), new Vector3(0, -1, 0));
    mesh.addVertex(new Vector3(-hw, -hh, hd), new Vector3(0, -1, 0));

    // Right face (x+)
    mesh.addVertex(new Vector3(hw, -hh, hd), new Vector3(1, 0, 0));
    mesh.addVertex(new Vector3(hw, -hh, -hd), new Vector3(1, 0, 0));
    mesh.addVertex(new Vector3(hw, hh, -hd), new Vector3(1, 0, 0));
    mesh.addVertex(new Vector3(hw, hh, hd), new Vector3(1, 0, 0));

    // Left face (x-)
    mesh.addVertex(new Vector3(-hw, -hh, -hd), new Vector3(-1, 0, 0));
    mesh.addVertex(new Vector3(-hw, -hh, hd), new Vector3(-1, 0, 0));
    mesh.addVertex(new Vector3(-hw, hh, hd), new Vector3(-1, 0, 0));
    mesh.addVertex(new Vector3(-hw, hh, -hd), new Vector3(-1, 0, 0));

    // Triangles (two per face) - reverse winding for correct culling
    for (let i = 0; i < 6; i++) {
      const base = i * 4;
      mesh.addTriangle(base, base + 2, base + 1, false);
      mesh.addTriangle(base, base + 3, base + 2, false);
    }

    return mesh;
  }

  // Create a plane mesh (lying in XZ plane by default)
  // Subdivided into tiles to avoid clipping issues when camera is on the plane
  static createPlane(width: number, depth: number, material?: Material, subdivisions: number = 8): Mesh {
    const mesh = new Mesh(material);
    const hw = width / 2;
    const hd = depth / 2;
    const stepX = width / subdivisions;
    const stepZ = depth / subdivisions;

    // Create vertices in a grid
    for (let z = 0; z <= subdivisions; z++) {
      for (let x = 0; x <= subdivisions; x++) {
        const px = -hw + x * stepX;
        const pz = -hd + z * stepZ;
        mesh.addVertex(new Vector3(px, 0, pz), new Vector3(0, 1, 0));
      }
    }

    // Create triangles for each cell
    // Vertex layout (looking from +Y, Z+ is "forward"/bottom of grid):
    //   topLeft --- topRight       (back, -Z)
    //      |           |
    //   bottomLeft - bottomRight   (front, +Z)
    //
    // Box uses (0,2,1) and (0,3,2) where 0=front-left, 1=front-right, 2=back-right, 3=back-left
    // Mapping: bottomLeft=0, bottomRight=1, topRight=2, topLeft=3
    const cols = subdivisions + 1;
    for (let z = 0; z < subdivisions; z++) {
      for (let x = 0; x < subdivisions; x++) {
        const topLeft = z * cols + x;
        const topRight = topLeft + 1;
        const bottomLeft = (z + 1) * cols + x;
        const bottomRight = bottomLeft + 1;

        // Match box winding: (0,2,1) and (0,3,2)
        mesh.addTriangle(bottomLeft, topRight, bottomRight, false);
        mesh.addTriangle(bottomLeft, topLeft, topRight, false);
      }
    }

    return mesh;
  }

  // Create a ramp mesh
  static createRamp(width: number, height: number, depth: number, material?: Material): Mesh {
    const mesh = new Mesh(material);
    const hw = width / 2;

    // Bottom-back edge at y=0, z=-depth/2
    // Top-front edge at y=height, z=depth/2

    // Vertices
    // Bottom face
    mesh.addVertex(new Vector3(-hw, 0, -depth / 2), new Vector3(0, -1, 0)); // 0
    mesh.addVertex(new Vector3(hw, 0, -depth / 2), new Vector3(0, -1, 0));  // 1
    mesh.addVertex(new Vector3(hw, 0, depth / 2), new Vector3(0, -1, 0));   // 2
    mesh.addVertex(new Vector3(-hw, 0, depth / 2), new Vector3(0, -1, 0));  // 3

    // Ramp surface normal
    const rampNormal = new Vector3(0, depth, height).normalize();

    // Top/ramp face
    mesh.addVertex(new Vector3(-hw, 0, -depth / 2), rampNormal);     // 4
    mesh.addVertex(new Vector3(hw, 0, -depth / 2), rampNormal);      // 5
    mesh.addVertex(new Vector3(hw, height, depth / 2), rampNormal);  // 6
    mesh.addVertex(new Vector3(-hw, height, depth / 2), rampNormal); // 7

    // Front face (vertical)
    mesh.addVertex(new Vector3(-hw, 0, depth / 2), new Vector3(0, 0, 1));     // 8
    mesh.addVertex(new Vector3(hw, 0, depth / 2), new Vector3(0, 0, 1));      // 9
    mesh.addVertex(new Vector3(hw, height, depth / 2), new Vector3(0, 0, 1)); // 10
    mesh.addVertex(new Vector3(-hw, height, depth / 2), new Vector3(0, 0, 1));// 11

    // Left side
    const leftNormal = new Vector3(-1, 0, 0);
    mesh.addVertex(new Vector3(-hw, 0, -depth / 2), leftNormal);     // 12
    mesh.addVertex(new Vector3(-hw, 0, depth / 2), leftNormal);      // 13
    mesh.addVertex(new Vector3(-hw, height, depth / 2), leftNormal); // 14

    // Right side
    const rightNormal = new Vector3(1, 0, 0);
    mesh.addVertex(new Vector3(hw, 0, depth / 2), rightNormal);     // 15
    mesh.addVertex(new Vector3(hw, 0, -depth / 2), rightNormal);    // 16
    mesh.addVertex(new Vector3(hw, height, depth / 2), rightNormal);// 17

    // Triangles
    // Bottom
    mesh.addTriangle(0, 2, 1, false);
    mesh.addTriangle(0, 3, 2, false);

    // Ramp surface
    mesh.addTriangle(4, 5, 6, false);
    mesh.addTriangle(4, 6, 7, false);

    // Front
    mesh.addTriangle(8, 9, 10, false);
    mesh.addTriangle(8, 10, 11, false);

    // Left side (triangle)
    mesh.addTriangle(12, 13, 14, false);

    // Right side (triangle)
    mesh.addTriangle(15, 16, 17, false);

    return mesh;
  }

  // Create stairs
  static createStairs(width: number, height: number, depth: number, steps: number, material?: Material): Mesh {
    const mesh = new Mesh(material);
    const hw = width / 2;
    const stepHeight = height / steps;
    const stepDepth = depth / steps;

    for (let i = 0; i < steps; i++) {
      const y0 = i * stepHeight;
      const y1 = (i + 1) * stepHeight;
      const z0 = -depth / 2 + i * stepDepth;
      const z1 = -depth / 2 + (i + 1) * stepDepth;

      // Top of step
      const topBase = mesh.vertices.length;
      mesh.addVertex(new Vector3(-hw, y1, z0), new Vector3(0, 1, 0));
      mesh.addVertex(new Vector3(hw, y1, z0), new Vector3(0, 1, 0));
      mesh.addVertex(new Vector3(hw, y1, z1), new Vector3(0, 1, 0));
      mesh.addVertex(new Vector3(-hw, y1, z1), new Vector3(0, 1, 0));
      mesh.addTriangle(topBase, topBase + 1, topBase + 2, false);
      mesh.addTriangle(topBase, topBase + 2, topBase + 3, false);

      // Front of step (riser)
      const frontBase = mesh.vertices.length;
      mesh.addVertex(new Vector3(-hw, y0, z0), new Vector3(0, 0, -1));
      mesh.addVertex(new Vector3(hw, y0, z0), new Vector3(0, 0, -1));
      mesh.addVertex(new Vector3(hw, y1, z0), new Vector3(0, 0, -1));
      mesh.addVertex(new Vector3(-hw, y1, z0), new Vector3(0, 0, -1));
      mesh.addTriangle(frontBase, frontBase + 1, frontBase + 2, false);
      mesh.addTriangle(frontBase, frontBase + 2, frontBase + 3, false);
    }

    // Side walls
    // Left side
    for (let i = 0; i < steps; i++) {
      const y0 = i * stepHeight;
      const y1 = (i + 1) * stepHeight;
      const z0 = -depth / 2 + i * stepDepth;
      const z1 = -depth / 2 + (i + 1) * stepDepth;

      const leftBase = mesh.vertices.length;
      mesh.addVertex(new Vector3(-hw, 0, z0), new Vector3(-1, 0, 0));
      mesh.addVertex(new Vector3(-hw, 0, z1), new Vector3(-1, 0, 0));
      mesh.addVertex(new Vector3(-hw, y1, z1), new Vector3(-1, 0, 0));
      mesh.addVertex(new Vector3(-hw, y1, z0), new Vector3(-1, 0, 0));
      mesh.addTriangle(leftBase, leftBase + 1, leftBase + 2, false);
      mesh.addTriangle(leftBase, leftBase + 2, leftBase + 3, false);
    }

    // Right side
    for (let i = 0; i < steps; i++) {
      const y0 = i * stepHeight;
      const y1 = (i + 1) * stepHeight;
      const z0 = -depth / 2 + i * stepDepth;
      const z1 = -depth / 2 + (i + 1) * stepDepth;

      const rightBase = mesh.vertices.length;
      mesh.addVertex(new Vector3(hw, 0, z1), new Vector3(1, 0, 0));
      mesh.addVertex(new Vector3(hw, 0, z0), new Vector3(1, 0, 0));
      mesh.addVertex(new Vector3(hw, y1, z0), new Vector3(1, 0, 0));
      mesh.addVertex(new Vector3(hw, y1, z1), new Vector3(1, 0, 0));
      mesh.addTriangle(rightBase, rightBase + 1, rightBase + 2, false);
      mesh.addTriangle(rightBase, rightBase + 2, rightBase + 3, false);
    }

    return mesh;
  }
}
