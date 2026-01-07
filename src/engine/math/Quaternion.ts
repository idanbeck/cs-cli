import { Vector3 } from './Vector3.js';
import { Matrix4 } from './Matrix4.js';

export class Quaternion {
  constructor(
    public x: number = 0,
    public y: number = 0,
    public z: number = 0,
    public w: number = 1
  ) {}

  static identity(): Quaternion {
    return new Quaternion(0, 0, 0, 1);
  }

  clone(): Quaternion {
    return new Quaternion(this.x, this.y, this.z, this.w);
  }

  copy(q: Quaternion): this {
    this.x = q.x;
    this.y = q.y;
    this.z = q.z;
    this.w = q.w;
    return this;
  }

  set(x: number, y: number, z: number, w: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
    return this;
  }

  // Create quaternion from Euler angles (in radians, Y-X-Z order)
  static fromEuler(pitch: number, yaw: number, roll: number): Quaternion {
    const c1 = Math.cos(yaw / 2);
    const s1 = Math.sin(yaw / 2);
    const c2 = Math.cos(pitch / 2);
    const s2 = Math.sin(pitch / 2);
    const c3 = Math.cos(roll / 2);
    const s3 = Math.sin(roll / 2);

    return new Quaternion(
      s1 * c2 * c3 + c1 * s2 * s3,
      c1 * s2 * c3 - s1 * c2 * s3,
      c1 * c2 * s3 + s1 * s2 * c3,
      c1 * c2 * c3 - s1 * s2 * s3
    );
  }

  // Create quaternion from axis and angle
  static fromAxisAngle(axis: Vector3, angle: number): Quaternion {
    const halfAngle = angle / 2;
    const s = Math.sin(halfAngle);
    return new Quaternion(
      axis.x * s,
      axis.y * s,
      axis.z * s,
      Math.cos(halfAngle)
    );
  }

  // Convert to Euler angles (Y-X-Z order, returns [pitch, yaw, roll])
  toEuler(): Vector3 {
    const sinr_cosp = 2 * (this.w * this.x + this.y * this.z);
    const cosr_cosp = 1 - 2 * (this.x * this.x + this.y * this.y);
    const pitch = Math.atan2(sinr_cosp, cosr_cosp);

    const sinp = 2 * (this.w * this.y - this.z * this.x);
    let yaw: number;
    if (Math.abs(sinp) >= 1) {
      yaw = Math.sign(sinp) * Math.PI / 2;
    } else {
      yaw = Math.asin(sinp);
    }

    const siny_cosp = 2 * (this.w * this.z + this.x * this.y);
    const cosy_cosp = 1 - 2 * (this.y * this.y + this.z * this.z);
    const roll = Math.atan2(siny_cosp, cosy_cosp);

    return new Vector3(pitch, yaw, roll);
  }

  // Multiply quaternions (combines rotations)
  multiply(q: Quaternion): this {
    const ax = this.x, ay = this.y, az = this.z, aw = this.w;
    const bx = q.x, by = q.y, bz = q.z, bw = q.w;

    this.x = ax * bw + aw * bx + ay * bz - az * by;
    this.y = ay * bw + aw * by + az * bx - ax * bz;
    this.z = az * bw + aw * bz + ax * by - ay * bx;
    this.w = aw * bw - ax * bx - ay * by - az * bz;

    return this;
  }

  static multiply(a: Quaternion, b: Quaternion): Quaternion {
    return a.clone().multiply(b);
  }

  // Rotate a vector by this quaternion
  rotateVector(v: Vector3): Vector3 {
    const qx = this.x, qy = this.y, qz = this.z, qw = this.w;
    const vx = v.x, vy = v.y, vz = v.z;

    // t = 2 * cross(q.xyz, v)
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);

    // v + w * t + cross(q.xyz, t)
    return new Vector3(
      vx + qw * tx + (qy * tz - qz * ty),
      vy + qw * ty + (qz * tx - qx * tz),
      vz + qw * tz + (qx * ty - qy * tx)
    );
  }

  // Get the forward direction (negative Z in local space)
  getForward(): Vector3 {
    return this.rotateVector(new Vector3(0, 0, -1));
  }

  // Get the right direction (positive X in local space)
  getRight(): Vector3 {
    return this.rotateVector(new Vector3(1, 0, 0));
  }

  // Get the up direction (positive Y in local space)
  getUp(): Vector3 {
    return this.rotateVector(new Vector3(0, 1, 0));
  }

  length(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w);
  }

  normalize(): this {
    const len = this.length();
    if (len > 0) {
      const invLen = 1 / len;
      this.x *= invLen;
      this.y *= invLen;
      this.z *= invLen;
      this.w *= invLen;
    }
    return this;
  }

  conjugate(): this {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    return this;
  }

  invert(): this {
    return this.conjugate().normalize();
  }

  static invert(q: Quaternion): Quaternion {
    return q.clone().invert();
  }

  // Spherical linear interpolation
  static slerp(a: Quaternion, b: Quaternion, t: number): Quaternion {
    let cosHalfTheta = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;

    // If negative dot, negate one quaternion to take shorter path
    const bx = cosHalfTheta < 0 ? -b.x : b.x;
    const by = cosHalfTheta < 0 ? -b.y : b.y;
    const bz = cosHalfTheta < 0 ? -b.z : b.z;
    const bw = cosHalfTheta < 0 ? -b.w : b.w;
    cosHalfTheta = Math.abs(cosHalfTheta);

    if (cosHalfTheta >= 1.0) {
      return a.clone();
    }

    const halfTheta = Math.acos(cosHalfTheta);
    const sinHalfTheta = Math.sqrt(1.0 - cosHalfTheta * cosHalfTheta);

    if (Math.abs(sinHalfTheta) < 0.001) {
      return new Quaternion(
        a.x * 0.5 + bx * 0.5,
        a.y * 0.5 + by * 0.5,
        a.z * 0.5 + bz * 0.5,
        a.w * 0.5 + bw * 0.5
      );
    }

    const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
    const ratioB = Math.sin(t * halfTheta) / sinHalfTheta;

    return new Quaternion(
      a.x * ratioA + bx * ratioB,
      a.y * ratioA + by * ratioB,
      a.z * ratioA + bz * ratioB,
      a.w * ratioA + bw * ratioB
    );
  }

  // Convert to rotation matrix
  toMatrix4(): Matrix4 {
    const m = new Matrix4();
    const e = m.elements;

    const x2 = this.x + this.x;
    const y2 = this.y + this.y;
    const z2 = this.z + this.z;

    const xx = this.x * x2;
    const xy = this.x * y2;
    const xz = this.x * z2;
    const yy = this.y * y2;
    const yz = this.y * z2;
    const zz = this.z * z2;
    const wx = this.w * x2;
    const wy = this.w * y2;
    const wz = this.w * z2;

    e[0] = 1 - (yy + zz);
    e[1] = xy + wz;
    e[2] = xz - wy;
    e[3] = 0;

    e[4] = xy - wz;
    e[5] = 1 - (xx + zz);
    e[6] = yz + wx;
    e[7] = 0;

    e[8] = xz + wy;
    e[9] = yz - wx;
    e[10] = 1 - (xx + yy);
    e[11] = 0;

    e[12] = 0;
    e[13] = 0;
    e[14] = 0;
    e[15] = 1;

    return m;
  }

  // Create from rotation matrix
  static fromMatrix4(m: Matrix4): Quaternion {
    const e = m.elements;
    const trace = e[0] + e[5] + e[10];
    const q = new Quaternion();

    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1.0);
      q.w = 0.25 / s;
      q.x = (e[6] - e[9]) * s;
      q.y = (e[8] - e[2]) * s;
      q.z = (e[1] - e[4]) * s;
    } else if (e[0] > e[5] && e[0] > e[10]) {
      const s = 2.0 * Math.sqrt(1.0 + e[0] - e[5] - e[10]);
      q.w = (e[6] - e[9]) / s;
      q.x = 0.25 * s;
      q.y = (e[4] + e[1]) / s;
      q.z = (e[8] + e[2]) / s;
    } else if (e[5] > e[10]) {
      const s = 2.0 * Math.sqrt(1.0 + e[5] - e[0] - e[10]);
      q.w = (e[8] - e[2]) / s;
      q.x = (e[4] + e[1]) / s;
      q.y = 0.25 * s;
      q.z = (e[9] + e[6]) / s;
    } else {
      const s = 2.0 * Math.sqrt(1.0 + e[10] - e[0] - e[5]);
      q.w = (e[1] - e[4]) / s;
      q.x = (e[8] + e[2]) / s;
      q.y = (e[9] + e[6]) / s;
      q.z = 0.25 * s;
    }

    return q.normalize();
  }

  dot(q: Quaternion): number {
    return this.x * q.x + this.y * q.y + this.z * q.z + this.w * q.w;
  }

  equals(q: Quaternion, epsilon: number = 0.0001): boolean {
    return (
      Math.abs(this.x - q.x) < epsilon &&
      Math.abs(this.y - q.y) < epsilon &&
      Math.abs(this.z - q.z) < epsilon &&
      Math.abs(this.w - q.w) < epsilon
    );
  }

  toString(): string {
    return `Quaternion(${this.x.toFixed(3)}, ${this.y.toFixed(3)}, ${this.z.toFixed(3)}, ${this.w.toFixed(3)})`;
  }
}
