#!/usr/bin/env node
/**
 * Native Renderer Demo
 * Demonstrates the C SIMD renderer is working by rendering a spinning cube
 * and outputting to terminal using half-block characters.
 */

import { getNativeRenderer } from '../engine/NativeRenderer.js';

const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
const CLEAR = '\x1b[2J\x1b[H';
const RESET = '\x1b[0m';

// Cube vertices
const cubeVertices = new Float32Array([
  // Front face
  -1, -1,  1,   1, -1,  1,   1,  1,  1,  -1,  1,  1,
  // Back face
  -1, -1, -1,  -1,  1, -1,   1,  1, -1,   1, -1, -1,
  // Top face
  -1,  1, -1,  -1,  1,  1,   1,  1,  1,   1,  1, -1,
  // Bottom face
  -1, -1, -1,   1, -1, -1,   1, -1,  1,  -1, -1,  1,
  // Right face
   1, -1, -1,   1,  1, -1,   1,  1,  1,   1, -1,  1,
  // Left face
  -1, -1, -1,  -1, -1,  1,  -1,  1,  1,  -1,  1, -1,
]);

// Cube indices (2 triangles per face)
const cubeIndices = new Uint32Array([
  0,  1,  2,   0,  2,  3,   // Front
  4,  5,  6,   4,  6,  7,   // Back
  8,  9,  10,  8,  10, 11,  // Top
  12, 13, 14,  12, 14, 15,  // Bottom
  16, 17, 18,  16, 18, 19,  // Right
  20, 21, 22,  20, 22, 23,  // Left
]);

// Face colors (RGB per vertex, 4 vertices per face)
const cubeColors = new Uint8Array([
  // Front - Red
  255, 80, 80, 255, 80, 80, 255, 80, 80, 255, 80, 80,
  // Back - Green
  80, 255, 80, 80, 255, 80, 80, 255, 80, 80, 255, 80,
  // Top - Blue
  80, 80, 255, 80, 80, 255, 80, 80, 255, 80, 80, 255,
  // Bottom - Yellow
  255, 255, 80, 255, 255, 80, 255, 255, 80, 255, 255, 80,
  // Right - Magenta
  255, 80, 255, 255, 80, 255, 255, 80, 255, 255, 80, 255,
  // Left - Cyan
  80, 255, 255, 80, 255, 255, 80, 255, 255, 80, 255, 255,
]);

// Matrix multiplication helpers
function multiplyMatrices(a: number[], b: number[]): number[] {
  const result = new Array(16).fill(0);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      for (let i = 0; i < 4; i++) {
        result[col * 4 + row] += a[i * 4 + row] * b[col * 4 + i];
      }
    }
  }
  return result;
}

function perspectiveMatrix(fov: number, aspect: number, near: number, far: number): number[] {
  const f = 1.0 / Math.tan(fov / 2);
  const nf = 1 / (near - far);
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ];
}

function rotationYMatrix(angle: number): number[] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    c, 0, -s, 0,
    0, 1, 0, 0,
    s, 0, c, 0,
    0, 0, 0, 1,
  ];
}

function rotationXMatrix(angle: number): number[] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    1, 0, 0, 0,
    0, c, s, 0,
    0, -s, c, 0,
    0, 0, 0, 1,
  ];
}

function translationMatrix(x: number, y: number, z: number): number[] {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, y, z, 1,
  ];
}

// Convert RGB framebuffer to half-block terminal output
function framebufferToHalfBlock(fb: Uint8Array, width: number, height: number): string {
  const lines: string[] = [];

  // Process two rows at a time (top and bottom half of each character)
  for (let y = 0; y < height; y += 2) {
    let line = '';
    for (let x = 0; x < width; x++) {
      const topIdx = (y * width + x) * 3;
      const botIdx = ((y + 1) * width + x) * 3;

      const tr = fb[topIdx], tg = fb[topIdx + 1], tb = fb[topIdx + 2];
      const br = fb[botIdx] ?? tr, bg = fb[botIdx + 1] ?? tg, bb = fb[botIdx + 2] ?? tb;

      // Use half-block character with foreground (top) and background (bottom) colors
      line += `\x1b[38;2;${tr};${tg};${tb}m\x1b[48;2;${br};${bg};${bb}m▀`;
    }
    lines.push(line + RESET);
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  const renderer = getNativeRenderer();

  if (!renderer.isAvailable) {
    console.error('Native renderer not available!');
    console.error('Run: cd native && npx node-gyp rebuild');
    process.exit(1);
  }

  console.log(`Native Renderer Demo`);
  console.log(`SIMD: ${renderer.hasSIMD ? 'YES (ARM NEON)' : 'No (scalar)'}`);
  console.log(`Press Ctrl+C to exit\n`);

  await new Promise(resolve => setTimeout(resolve, 1500));

  // Initialize renderer
  const width = Math.min(process.stdout.columns || 80, 120);
  const height = Math.min((process.stdout.rows || 24) * 2, 60);

  renderer.init(width, height, 1);

  // Setup
  process.stdout.write(CURSOR_HIDE);

  const aspect = width / height;
  const proj = perspectiveMatrix(Math.PI / 3, aspect, 0.1, 100);
  const view = translationMatrix(0, 0, -5);

  let angleY = 0;
  let angleX = 0;
  let frameCount = 0;
  const startTime = Date.now();

  const render = () => {
    // Clear with dark gray
    renderer.clear(40, 40, 50);

    // Build MVP matrix
    const rotY = rotationYMatrix(angleY);
    const rotX = rotationXMatrix(angleX);
    const model = multiplyMatrices(rotY, rotX);
    const modelView = multiplyMatrices(view, model);
    const mvp = multiplyMatrices(proj, modelView);

    // Render cube
    const triangles = renderer.renderTrianglesBatch(
      cubeVertices,
      cubeIndices,
      new Float32Array(mvp),
      cubeColors
    );

    // Get framebuffer and display
    const fb = renderer.getFramebuffer();
    if (fb) {
      const output = framebufferToHalfBlock(fb, width, height);
      process.stdout.write(CLEAR + output);

      // Stats
      frameCount++;
      const elapsed = (Date.now() - startTime) / 1000;
      const fps = Math.round(frameCount / elapsed);
      process.stdout.write(`\n\x1b[1mNative C Renderer | ${width}x${height} | ${triangles} tris | ${fps} FPS | SIMD: ${renderer.hasSIMD ? 'ON' : 'OFF'}\x1b[0m`);
    }

    // Update rotation
    angleY += 0.03;
    angleX += 0.01;
  };

  // Run at ~30 FPS
  const interval = setInterval(render, 33);

  // Cleanup on exit
  process.on('SIGINT', () => {
    clearInterval(interval);
    renderer.cleanup();
    process.stdout.write(CURSOR_SHOW + CLEAR);
    console.log('Demo ended.');
    process.exit(0);
  });
}

main().catch(console.error);
