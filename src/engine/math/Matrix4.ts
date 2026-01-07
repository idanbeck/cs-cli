import { Vector3 } from './Vector3.js';

export class Matrix4 {
  // Column-major order (like OpenGL)
  // m[col][row] but stored as flat array: m[col * 4 + row]
  public elements: Float32Array;

  constructor() {
    this.elements = new Float32Array(16);
    this.identity();
  }

  identity(): this {
    const e = this.elements;
    e[0] = 1; e[4] = 0; e[8] = 0;  e[12] = 0;
    e[1] = 0; e[5] = 1; e[9] = 0;  e[13] = 0;
    e[2] = 0; e[6] = 0; e[10] = 1; e[14] = 0;
    e[3] = 0; e[7] = 0; e[11] = 0; e[15] = 1;
    return this;
  }

  static identity(): Matrix4 {
    return new Matrix4();
  }

  clone(): Matrix4 {
    const m = new Matrix4();
    m.elements.set(this.elements);
    return m;
  }

  copy(m: Matrix4): this {
    this.elements.set(m.elements);
    return this;
  }

  set(
    m00: number, m01: number, m02: number, m03: number,
    m10: number, m11: number, m12: number, m13: number,
    m20: number, m21: number, m22: number, m23: number,
    m30: number, m31: number, m32: number, m33: number
  ): this {
    const e = this.elements;
    // Column-major: first index is column
    e[0] = m00; e[4] = m01; e[8] = m02;  e[12] = m03;
    e[1] = m10; e[5] = m11; e[9] = m12;  e[13] = m13;
    e[2] = m20; e[6] = m21; e[10] = m22; e[14] = m23;
    e[3] = m30; e[7] = m31; e[11] = m32; e[15] = m33;
    return this;
  }

  multiply(m: Matrix4): this {
    return this.multiplyMatrices(this, m);
  }

  premultiply(m: Matrix4): this {
    return this.multiplyMatrices(m, this);
  }

  multiplyMatrices(a: Matrix4, b: Matrix4): this {
    const ae = a.elements;
    const be = b.elements;
    const te = this.elements;

    const a11 = ae[0], a12 = ae[4], a13 = ae[8], a14 = ae[12];
    const a21 = ae[1], a22 = ae[5], a23 = ae[9], a24 = ae[13];
    const a31 = ae[2], a32 = ae[6], a33 = ae[10], a34 = ae[14];
    const a41 = ae[3], a42 = ae[7], a43 = ae[11], a44 = ae[15];

    const b11 = be[0], b12 = be[4], b13 = be[8], b14 = be[12];
    const b21 = be[1], b22 = be[5], b23 = be[9], b24 = be[13];
    const b31 = be[2], b32 = be[6], b33 = be[10], b34 = be[14];
    const b41 = be[3], b42 = be[7], b43 = be[11], b44 = be[15];

    te[0] = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41;
    te[4] = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42;
    te[8] = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43;
    te[12] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44;

    te[1] = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41;
    te[5] = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42;
    te[9] = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43;
    te[13] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44;

    te[2] = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41;
    te[6] = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42;
    te[10] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43;
    te[14] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44;

    te[3] = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41;
    te[7] = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42;
    te[11] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43;
    te[15] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44;

    return this;
  }

  static multiply(a: Matrix4, b: Matrix4): Matrix4 {
    return new Matrix4().multiplyMatrices(a, b);
  }

  determinant(): number {
    const e = this.elements;

    const n11 = e[0], n12 = e[4], n13 = e[8], n14 = e[12];
    const n21 = e[1], n22 = e[5], n23 = e[9], n24 = e[13];
    const n31 = e[2], n32 = e[6], n33 = e[10], n34 = e[14];
    const n41 = e[3], n42 = e[7], n43 = e[11], n44 = e[15];

    return (
      n41 * (
        + n14 * n23 * n32
        - n13 * n24 * n32
        - n14 * n22 * n33
        + n12 * n24 * n33
        + n13 * n22 * n34
        - n12 * n23 * n34
      ) +
      n42 * (
        + n11 * n23 * n34
        - n11 * n24 * n33
        + n14 * n21 * n33
        - n13 * n21 * n34
        + n13 * n24 * n31
        - n14 * n23 * n31
      ) +
      n43 * (
        + n11 * n24 * n32
        - n11 * n22 * n34
        - n14 * n21 * n32
        + n12 * n21 * n34
        + n14 * n22 * n31
        - n12 * n24 * n31
      ) +
      n44 * (
        - n13 * n22 * n31
        - n11 * n23 * n32
        + n11 * n22 * n33
        + n13 * n21 * n32
        - n12 * n21 * n33
        + n12 * n23 * n31
      )
    );
  }

  invert(): this {
    const e = this.elements;
    const n11 = e[0], n21 = e[1], n31 = e[2], n41 = e[3];
    const n12 = e[4], n22 = e[5], n32 = e[6], n42 = e[7];
    const n13 = e[8], n23 = e[9], n33 = e[10], n43 = e[11];
    const n14 = e[12], n24 = e[13], n34 = e[14], n44 = e[15];

    const t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44;
    const t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44;
    const t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44;
    const t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;

    const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;

    if (det === 0) {
      return this.identity();
    }

    const detInv = 1 / det;

    e[0] = t11 * detInv;
    e[1] = (n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44) * detInv;
    e[2] = (n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44) * detInv;
    e[3] = (n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43) * detInv;

    e[4] = t12 * detInv;
    e[5] = (n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44) * detInv;
    e[6] = (n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44) * detInv;
    e[7] = (n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43) * detInv;

    e[8] = t13 * detInv;
    e[9] = (n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44) * detInv;
    e[10] = (n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44) * detInv;
    e[11] = (n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43) * detInv;

    e[12] = t14 * detInv;
    e[13] = (n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34) * detInv;
    e[14] = (n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34) * detInv;
    e[15] = (n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33) * detInv;

    return this;
  }

  static invert(m: Matrix4): Matrix4 {
    return m.clone().invert();
  }

  transpose(): this {
    const e = this.elements;
    let tmp: number;

    tmp = e[1]; e[1] = e[4]; e[4] = tmp;
    tmp = e[2]; e[2] = e[8]; e[8] = tmp;
    tmp = e[6]; e[6] = e[9]; e[9] = tmp;
    tmp = e[3]; e[3] = e[12]; e[12] = tmp;
    tmp = e[7]; e[7] = e[13]; e[13] = tmp;
    tmp = e[11]; e[11] = e[14]; e[14] = tmp;

    return this;
  }

  // Transform a Vector3 by this matrix (assumes w=1, returns w-divided result)
  transformPoint(v: Vector3): Vector3 {
    const e = this.elements;
    const x = v.x, y = v.y, z = v.z;
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    const invW = w !== 0 ? 1 / w : 1;

    return new Vector3(
      (e[0] * x + e[4] * y + e[8] * z + e[12]) * invW,
      (e[1] * x + e[5] * y + e[9] * z + e[13]) * invW,
      (e[2] * x + e[6] * y + e[10] * z + e[14]) * invW
    );
  }

  // Transform a direction (ignores translation, no w-divide)
  transformDirection(v: Vector3): Vector3 {
    const e = this.elements;
    const x = v.x, y = v.y, z = v.z;

    return new Vector3(
      e[0] * x + e[4] * y + e[8] * z,
      e[1] * x + e[5] * y + e[9] * z,
      e[2] * x + e[6] * y + e[10] * z
    );
  }

  // Transform and return [x, y, z, w] without dividing by w
  transformVector4(x: number, y: number, z: number, w: number): [number, number, number, number] {
    const e = this.elements;
    return [
      e[0] * x + e[4] * y + e[8] * z + e[12] * w,
      e[1] * x + e[5] * y + e[9] * z + e[13] * w,
      e[2] * x + e[6] * y + e[10] * z + e[14] * w,
      e[3] * x + e[7] * y + e[11] * z + e[15] * w
    ];
  }

  // Translation matrix
  static translation(x: number, y: number, z: number): Matrix4 {
    const m = new Matrix4();
    m.elements[12] = x;
    m.elements[13] = y;
    m.elements[14] = z;
    return m;
  }

  translate(x: number, y: number, z: number): this {
    this.elements[12] += x;
    this.elements[13] += y;
    this.elements[14] += z;
    return this;
  }

  // Scaling matrix
  static scaling(x: number, y: number, z: number): Matrix4 {
    const m = new Matrix4();
    m.elements[0] = x;
    m.elements[5] = y;
    m.elements[10] = z;
    return m;
  }

  scale(x: number, y: number, z: number): this {
    const e = this.elements;
    e[0] *= x; e[4] *= y; e[8] *= z;
    e[1] *= x; e[5] *= y; e[9] *= z;
    e[2] *= x; e[6] *= y; e[10] *= z;
    e[3] *= x; e[7] *= y; e[11] *= z;
    return this;
  }

  // Rotation around X axis
  static rotationX(radians: number): Matrix4 {
    const m = new Matrix4();
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    m.elements[5] = c;
    m.elements[6] = s;
    m.elements[9] = -s;
    m.elements[10] = c;
    return m;
  }

  // Rotation around Y axis
  static rotationY(radians: number): Matrix4 {
    const m = new Matrix4();
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    m.elements[0] = c;
    m.elements[2] = -s;
    m.elements[8] = s;
    m.elements[10] = c;
    return m;
  }

  // Rotation around Z axis
  static rotationZ(radians: number): Matrix4 {
    const m = new Matrix4();
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    m.elements[0] = c;
    m.elements[1] = s;
    m.elements[4] = -s;
    m.elements[5] = c;
    return m;
  }

  // Perspective projection matrix
  static perspective(fovRadians: number, aspect: number, near: number, far: number): Matrix4 {
    const m = new Matrix4();
    const e = m.elements;
    const f = 1.0 / Math.tan(fovRadians / 2);
    const rangeInv = 1 / (near - far);

    e[0] = f / aspect;
    e[1] = 0;
    e[2] = 0;
    e[3] = 0;

    e[4] = 0;
    e[5] = f;
    e[6] = 0;
    e[7] = 0;

    e[8] = 0;
    e[9] = 0;
    e[10] = (near + far) * rangeInv;
    e[11] = -1;

    e[12] = 0;
    e[13] = 0;
    e[14] = near * far * rangeInv * 2;
    e[15] = 0;

    return m;
  }

  // Orthographic projection matrix
  static orthographic(left: number, right: number, bottom: number, top: number, near: number, far: number): Matrix4 {
    const m = new Matrix4();
    const e = m.elements;
    const w = 1.0 / (right - left);
    const h = 1.0 / (top - bottom);
    const p = 1.0 / (far - near);

    e[0] = 2 * w;
    e[5] = 2 * h;
    e[10] = -2 * p;
    e[12] = -(right + left) * w;
    e[13] = -(top + bottom) * h;
    e[14] = -(far + near) * p;

    return m;
  }

  // LookAt matrix (view matrix)
  static lookAt(eye: Vector3, target: Vector3, up: Vector3): Matrix4 {
    const m = new Matrix4();
    const e = m.elements;

    const zAxis = Vector3.sub(eye, target).normalize();
    const xAxis = Vector3.cross(up, zAxis).normalize();
    const yAxis = Vector3.cross(zAxis, xAxis);

    e[0] = xAxis.x;
    e[1] = yAxis.x;
    e[2] = zAxis.x;
    e[3] = 0;

    e[4] = xAxis.y;
    e[5] = yAxis.y;
    e[6] = zAxis.y;
    e[7] = 0;

    e[8] = xAxis.z;
    e[9] = yAxis.z;
    e[10] = zAxis.z;
    e[11] = 0;

    e[12] = -Vector3.dot(xAxis, eye);
    e[13] = -Vector3.dot(yAxis, eye);
    e[14] = -Vector3.dot(zAxis, eye);
    e[15] = 1;

    return m;
  }

  // Create from position, rotation (euler angles), and scale
  static compose(position: Vector3, rotationYXZ: Vector3, scale: Vector3): Matrix4 {
    const m = new Matrix4();

    // Apply rotations in Y-X-Z order (common for FPS games)
    const rotY = Matrix4.rotationY(rotationYXZ.y);
    const rotX = Matrix4.rotationX(rotationYXZ.x);
    const rotZ = Matrix4.rotationZ(rotationYXZ.z);

    m.multiplyMatrices(rotY, rotX).multiply(rotZ);
    m.scale(scale.x, scale.y, scale.z);
    m.elements[12] = position.x;
    m.elements[13] = position.y;
    m.elements[14] = position.z;

    return m;
  }

  // Extract position from matrix
  getPosition(): Vector3 {
    return new Vector3(this.elements[12], this.elements[13], this.elements[14]);
  }

  // Extract scale from matrix (assumes no shearing)
  getScale(): Vector3 {
    const e = this.elements;
    return new Vector3(
      Math.sqrt(e[0] * e[0] + e[1] * e[1] + e[2] * e[2]),
      Math.sqrt(e[4] * e[4] + e[5] * e[5] + e[6] * e[6]),
      Math.sqrt(e[8] * e[8] + e[9] * e[9] + e[10] * e[10])
    );
  }

  toString(): string {
    const e = this.elements;
    return `Matrix4(\n  ${e[0].toFixed(3)}, ${e[4].toFixed(3)}, ${e[8].toFixed(3)}, ${e[12].toFixed(3)}\n  ${e[1].toFixed(3)}, ${e[5].toFixed(3)}, ${e[9].toFixed(3)}, ${e[13].toFixed(3)}\n  ${e[2].toFixed(3)}, ${e[6].toFixed(3)}, ${e[10].toFixed(3)}, ${e[14].toFixed(3)}\n  ${e[3].toFixed(3)}, ${e[7].toFixed(3)}, ${e[11].toFixed(3)}, ${e[15].toFixed(3)}\n)`;
  }
}
