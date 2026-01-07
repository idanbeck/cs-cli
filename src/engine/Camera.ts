import { Vector3 } from './math/Vector3.js';
import { Matrix4 } from './math/Matrix4.js';
import { Quaternion } from './math/Quaternion.js';
import { clamp, degToRad, HALF_PI } from './math/MathUtils.js';

export class Camera {
  public position: Vector3;
  public pitch: number; // Rotation around X axis (look up/down) in radians
  public yaw: number;   // Rotation around Y axis (look left/right) in radians
  public roll: number;  // Rotation around Z axis (tilt) in radians - for death effect

  public fov: number;       // Field of view in radians
  public aspect: number;    // Aspect ratio (width / height)
  public near: number;      // Near clipping plane
  public far: number;       // Far clipping plane

  private _viewMatrix: Matrix4;
  private _projectionMatrix: Matrix4;
  private _viewProjectionMatrix: Matrix4;
  private _dirty: boolean = true;

  // Pitch limits to prevent flipping
  private readonly maxPitch = HALF_PI - 0.01;
  private readonly minPitch = -HALF_PI + 0.01;

  constructor(
    fovDegrees: number = 75,
    aspect: number = 16 / 9,
    near: number = 0.1,
    far: number = 100
  ) {
    this.position = new Vector3(0, 1.7, 0); // Eye height ~1.7m
    this.pitch = 0;
    this.yaw = 0;
    this.roll = 0;

    this.fov = degToRad(fovDegrees);
    this.aspect = aspect;
    this.near = near;
    this.far = far;

    this._viewMatrix = new Matrix4();
    this._projectionMatrix = new Matrix4();
    this._viewProjectionMatrix = new Matrix4();

    this.updateProjectionMatrix();
  }

  setPosition(x: number, y: number, z: number): this {
    this.position.set(x, y, z);
    this._dirty = true;
    return this;
  }

  setPositionVec(pos: Vector3): this {
    this.position.copy(pos);
    this._dirty = true;
    return this;
  }

  translate(dx: number, dy: number, dz: number): this {
    this.position.x += dx;
    this.position.y += dy;
    this.position.z += dz;
    this._dirty = true;
    return this;
  }

  // Move in local space (relative to camera orientation)
  moveLocal(forward: number, right: number, up: number): this {
    // Get forward direction (ignore pitch for movement)
    const forwardDir = new Vector3(
      -Math.sin(this.yaw),
      0,
      -Math.cos(this.yaw)
    );

    // Get right direction
    const rightDir = new Vector3(
      Math.cos(this.yaw),
      0,
      -Math.sin(this.yaw)
    );

    // Apply movement
    this.position.add(Vector3.scale(forwardDir, forward));
    this.position.add(Vector3.scale(rightDir, right));
    this.position.y += up;

    this._dirty = true;
    return this;
  }

  // Move in the direction the camera is looking (including pitch)
  moveLookDirection(forward: number, right: number, up: number): this {
    const dir = this.getForward();
    const rightDir = this.getRight();
    const upDir = this.getUp();

    this.position.add(Vector3.scale(dir, forward));
    this.position.add(Vector3.scale(rightDir, right));
    this.position.add(Vector3.scale(upDir, up));

    this._dirty = true;
    return this;
  }

  setPitch(radians: number): this {
    this.pitch = clamp(radians, this.minPitch, this.maxPitch);
    this._dirty = true;
    return this;
  }

  setYaw(radians: number): this {
    this.yaw = radians;
    this._dirty = true;
    return this;
  }

  rotate(deltaPitch: number, deltaYaw: number): this {
    this.pitch = clamp(this.pitch + deltaPitch, this.minPitch, this.maxPitch);
    this.yaw += deltaYaw;
    this._dirty = true;
    return this;
  }

  setRoll(radians: number): this {
    this.roll = radians;
    this._dirty = true;
    return this;
  }

  lookAt(target: Vector3): this {
    const direction = Vector3.sub(target, this.position).normalize();

    this.yaw = Math.atan2(-direction.x, -direction.z);
    this.pitch = Math.asin(direction.y);
    this.pitch = clamp(this.pitch, this.minPitch, this.maxPitch);

    this._dirty = true;
    return this;
  }

  setFov(degrees: number): this {
    this.fov = degToRad(degrees);
    this.updateProjectionMatrix();
    return this;
  }

  setAspect(aspect: number): this {
    this.aspect = aspect;
    this.updateProjectionMatrix();
    return this;
  }

  // Get the direction the camera is facing
  getForward(): Vector3 {
    return new Vector3(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch)
    ).normalize();
  }

  // Get the camera's right direction
  getRight(): Vector3 {
    return new Vector3(
      Math.cos(this.yaw),
      0,
      -Math.sin(this.yaw)
    ).normalize();
  }

  // Get the camera's up direction
  getUp(): Vector3 {
    const forward = this.getForward();
    const right = this.getRight();
    return Vector3.cross(right, forward).normalize();
  }

  // Get the rotation as a quaternion
  getRotation(): Quaternion {
    // Apply yaw first, then pitch
    const yawQ = Quaternion.fromAxisAngle(Vector3.up(), this.yaw);
    const pitchQ = Quaternion.fromAxisAngle(Vector3.right(), this.pitch);
    return Quaternion.multiply(yawQ, pitchQ);
  }

  private updateProjectionMatrix(): void {
    this._projectionMatrix = Matrix4.perspective(
      this.fov,
      this.aspect,
      this.near,
      this.far
    );
    this._dirty = true;
  }

  private updateViewMatrix(): void {
    // Build view matrix using lookAt
    // Camera looks in the direction determined by pitch and yaw
    const forward = this.getForward();
    const target = Vector3.add(this.position, forward);

    // Calculate up vector with roll applied
    let up = Vector3.up();
    if (this.roll !== 0) {
      // Rotate up vector around forward axis by roll amount
      const cosRoll = Math.cos(this.roll);
      const sinRoll = Math.sin(this.roll);
      const right = this.getRight();
      // up' = up * cos(roll) + right * sin(roll)
      up = new Vector3(
        up.x * cosRoll + right.x * sinRoll,
        up.y * cosRoll + right.y * sinRoll,
        up.z * cosRoll + right.z * sinRoll
      ).normalize();
    }

    this._viewMatrix = Matrix4.lookAt(this.position, target, up);
  }

  private updateMatrices(): void {
    if (!this._dirty) return;

    this.updateViewMatrix();
    this._viewProjectionMatrix.multiplyMatrices(this._projectionMatrix, this._viewMatrix);
    this._dirty = false;
  }

  get viewMatrix(): Matrix4 {
    this.updateMatrices();
    return this._viewMatrix;
  }

  get projectionMatrix(): Matrix4 {
    return this._projectionMatrix;
  }

  get viewProjectionMatrix(): Matrix4 {
    this.updateMatrices();
    return this._viewProjectionMatrix;
  }

  // Transform a world-space point to clip space
  worldToClip(point: Vector3): [number, number, number, number] {
    this.updateMatrices();
    return this._viewProjectionMatrix.transformVector4(point.x, point.y, point.z, 1);
  }

  // Transform a world-space point to normalized device coordinates (after perspective divide)
  worldToNDC(point: Vector3): Vector3 | null {
    const [x, y, z, w] = this.worldToClip(point);

    // Behind camera
    if (w <= 0) return null;

    return new Vector3(x / w, y / w, z / w);
  }

  // Transform a world-space point to screen coordinates
  worldToScreen(point: Vector3, screenWidth: number, screenHeight: number): { x: number; y: number; depth: number } | null {
    const ndc = this.worldToNDC(point);
    if (!ndc) return null;

    // NDC is [-1, 1], convert to [0, width/height]
    // Note: Y is flipped (NDC +Y is up, screen +Y is down)
    return {
      x: (ndc.x + 1) * 0.5 * screenWidth,
      y: (1 - ndc.y) * 0.5 * screenHeight,
      depth: ndc.z
    };
  }

  // Check if a point is in front of the camera
  isInFront(point: Vector3): boolean {
    const toPoint = Vector3.sub(point, this.position);
    const forward = this.getForward();
    return Vector3.dot(toPoint, forward) > 0;
  }

  // Get frustum planes for culling (returns 6 planes in world space)
  // Each plane is [nx, ny, nz, d] where nx*x + ny*y + nz*z + d = 0
  getFrustumPlanes(): [number, number, number, number][] {
    this.updateMatrices();
    const m = this._viewProjectionMatrix.elements;
    const planes: [number, number, number, number][] = [];

    // Left plane
    planes.push([
      m[3] + m[0],
      m[7] + m[4],
      m[11] + m[8],
      m[15] + m[12]
    ]);

    // Right plane
    planes.push([
      m[3] - m[0],
      m[7] - m[4],
      m[11] - m[8],
      m[15] - m[12]
    ]);

    // Bottom plane
    planes.push([
      m[3] + m[1],
      m[7] + m[5],
      m[11] + m[9],
      m[15] + m[13]
    ]);

    // Top plane
    planes.push([
      m[3] - m[1],
      m[7] - m[5],
      m[11] - m[9],
      m[15] - m[13]
    ]);

    // Near plane
    planes.push([
      m[3] + m[2],
      m[7] + m[6],
      m[11] + m[10],
      m[15] + m[14]
    ]);

    // Far plane
    planes.push([
      m[3] - m[2],
      m[7] - m[6],
      m[11] - m[10],
      m[15] - m[14]
    ]);

    // Normalize planes
    for (const plane of planes) {
      const len = Math.sqrt(plane[0] * plane[0] + plane[1] * plane[1] + plane[2] * plane[2]);
      if (len > 0) {
        plane[0] /= len;
        plane[1] /= len;
        plane[2] /= len;
        plane[3] /= len;
      }
    }

    return planes;
  }

  toString(): string {
    return `Camera(pos: ${this.position}, pitch: ${(this.pitch * 180 / Math.PI).toFixed(1)}°, yaw: ${(this.yaw * 180 / Math.PI).toFixed(1)}°)`;
  }
}
