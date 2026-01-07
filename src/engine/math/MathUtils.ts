export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;
export const PI = Math.PI;
export const TWO_PI = Math.PI * 2;
export const HALF_PI = Math.PI / 2;

export function degToRad(degrees: number): number {
  return degrees * DEG_TO_RAD;
}

export function radToDeg(radians: number): number {
  return radians * RAD_TO_DEG;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function inverseLerp(a: number, b: number, value: number): number {
  if (a === b) return 0;
  return (value - a) / (b - a);
}

export function remap(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  const t = inverseLerp(inMin, inMax, value);
  return lerp(outMin, outMax, t);
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

export function sign(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

export function fract(x: number): number {
  return x - Math.floor(x);
}

export function step(edge: number, x: number): number {
  return x < edge ? 0 : 1;
}

export function mix(a: number, b: number, t: number): number {
  return lerp(a, b, t);
}

export function saturate(x: number): number {
  return clamp(x, 0, 1);
}

export function approximately(a: number, b: number, epsilon: number = 0.0001): boolean {
  return Math.abs(a - b) < epsilon;
}

export function isPowerOfTwo(value: number): boolean {
  return (value & (value - 1)) === 0 && value !== 0;
}

export function nextPowerOfTwo(value: number): number {
  value--;
  value |= value >> 1;
  value |= value >> 2;
  value |= value >> 4;
  value |= value >> 8;
  value |= value >> 16;
  value++;
  return value;
}

export function wrapAngle(angle: number): number {
  angle = mod(angle, TWO_PI);
  if (angle > PI) angle -= TWO_PI;
  return angle;
}

export function angleDifference(a: number, b: number): number {
  const diff = mod(b - a + PI, TWO_PI) - PI;
  return diff;
}

export function lerpAngle(a: number, b: number, t: number): number {
  const diff = angleDifference(a, b);
  return a + diff * t;
}

export function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function randomInt(min: number, max: number): number {
  return Math.floor(randomRange(min, max + 1));
}

// Barycentric coordinates for a point p in triangle (a, b, c)
export function barycentric(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number
): [number, number, number] {
  const v0x = cx - ax;
  const v0y = cy - ay;
  const v1x = bx - ax;
  const v1y = by - ay;
  const v2x = px - ax;
  const v2y = py - ay;

  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot02 = v0x * v2x + v0y * v2y;
  const dot11 = v1x * v1x + v1y * v1y;
  const dot12 = v1x * v2x + v1y * v2y;

  const invDenom = 1 / (dot00 * dot11 - dot01 * dot01);
  const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
  const v = (dot00 * dot12 - dot01 * dot02) * invDenom;

  return [1 - u - v, v, u];
}

// Edge function for triangle rasterization
// Returns positive if C is to the left of the line from A to B
// (counter-clockwise winding in Y-up coords, clockwise in Y-down/screen coords)
export function edgeFunction(
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number
): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

// Check if point is inside triangle using edge functions
export function pointInTriangle(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number
): boolean {
  const w0 = edgeFunction(bx, by, cx, cy, px, py);
  const w1 = edgeFunction(cx, cy, ax, ay, px, py);
  const w2 = edgeFunction(ax, ay, bx, by, px, py);
  return w0 >= 0 && w1 >= 0 && w2 >= 0;
}
