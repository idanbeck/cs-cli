import { Vector3 } from './math/Vector3.js';
import { Matrix4 } from './math/Matrix4.js';
import { Quaternion } from './math/Quaternion.js';

export class Transform {
  public position: Vector3;
  public rotation: Quaternion;
  public scale: Vector3;

  private _matrix: Matrix4;
  private _dirty: boolean = true;

  constructor(
    position?: Vector3,
    rotation?: Quaternion,
    scale?: Vector3
  ) {
    this.position = position || Vector3.zero();
    this.rotation = rotation || Quaternion.identity();
    this.scale = scale || Vector3.one();
    this._matrix = new Matrix4();
  }

  static identity(): Transform {
    return new Transform();
  }

  clone(): Transform {
    return new Transform(
      this.position.clone(),
      this.rotation.clone(),
      this.scale.clone()
    );
  }

  copy(t: Transform): this {
    this.position.copy(t.position);
    this.rotation.copy(t.rotation);
    this.scale.copy(t.scale);
    this._dirty = true;
    return this;
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

  translate(x: number, y: number, z: number): this {
    this.position.x += x;
    this.position.y += y;
    this.position.z += z;
    this._dirty = true;
    return this;
  }

  translateVec(v: Vector3): this {
    this.position.add(v);
    this._dirty = true;
    return this;
  }

  setRotation(q: Quaternion): this {
    this.rotation.copy(q);
    this._dirty = true;
    return this;
  }

  setRotationEuler(pitch: number, yaw: number, roll: number): this {
    this.rotation = Quaternion.fromEuler(pitch, yaw, roll);
    this._dirty = true;
    return this;
  }

  rotate(q: Quaternion): this {
    this.rotation.multiply(q);
    this._dirty = true;
    return this;
  }

  rotateEuler(pitch: number, yaw: number, roll: number): this {
    const q = Quaternion.fromEuler(pitch, yaw, roll);
    this.rotation.multiply(q);
    this._dirty = true;
    return this;
  }

  rotateAroundAxis(axis: Vector3, angle: number): this {
    const q = Quaternion.fromAxisAngle(axis, angle);
    this.rotation.multiply(q);
    this._dirty = true;
    return this;
  }

  setScale(x: number, y: number, z: number): this {
    this.scale.set(x, y, z);
    this._dirty = true;
    return this;
  }

  setUniformScale(s: number): this {
    this.scale.set(s, s, s);
    this._dirty = true;
    return this;
  }

  scaleBy(x: number, y: number, z: number): this {
    this.scale.x *= x;
    this.scale.y *= y;
    this.scale.z *= z;
    this._dirty = true;
    return this;
  }

  lookAt(target: Vector3, up: Vector3 = Vector3.up()): this {
    const forward = Vector3.sub(target, this.position).normalize();
    const right = Vector3.cross(up, forward).normalize();
    const newUp = Vector3.cross(forward, right);

    // Build rotation matrix and convert to quaternion
    const m = new Matrix4();
    const e = m.elements;

    e[0] = right.x;    e[4] = newUp.x;    e[8] = -forward.x;
    e[1] = right.y;    e[5] = newUp.y;    e[9] = -forward.y;
    e[2] = right.z;    e[6] = newUp.z;    e[10] = -forward.z;

    this.rotation = Quaternion.fromMatrix4(m);
    this._dirty = true;
    return this;
  }

  getForward(): Vector3 {
    return this.rotation.getForward();
  }

  getRight(): Vector3 {
    return this.rotation.getRight();
  }

  getUp(): Vector3 {
    return this.rotation.getUp();
  }

  private updateMatrix(): void {
    if (!this._dirty) return;

    // Build matrix: T * R * S
    const rotMatrix = this.rotation.toMatrix4();
    this._matrix.copy(rotMatrix);
    this._matrix.scale(this.scale.x, this.scale.y, this.scale.z);
    this._matrix.elements[12] = this.position.x;
    this._matrix.elements[13] = this.position.y;
    this._matrix.elements[14] = this.position.z;

    this._dirty = false;
  }

  get matrix(): Matrix4 {
    this.updateMatrix();
    return this._matrix;
  }

  // Transform a point from local space to world space
  transformPoint(point: Vector3): Vector3 {
    return this.matrix.transformPoint(point);
  }

  // Transform a direction from local space to world space (ignores translation)
  transformDirection(direction: Vector3): Vector3 {
    return this.rotation.rotateVector(direction);
  }

  // Get the inverse transform matrix
  getInverseMatrix(): Matrix4 {
    return Matrix4.invert(this.matrix);
  }

  // Transform a point from world space to local space
  inverseTransformPoint(point: Vector3): Vector3 {
    return this.getInverseMatrix().transformPoint(point);
  }

  toString(): string {
    return `Transform(pos: ${this.position}, rot: ${this.rotation}, scale: ${this.scale})`;
  }
}
