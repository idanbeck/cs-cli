// Tracer/projectile system for visible bullet trails
// Uses pooling similar to decals

import { Vector3 } from '../engine/math/Vector3.js';
import { Color } from '../utils/Colors.js';

export interface Tracer {
  origin: Vector3;       // Start point (muzzle)
  endpoint: Vector3;     // End point (hit or max range)
  createdAt: number;     // Timestamp
  duration: number;      // How long the tracer lasts (ms)
  color: Color;
  active: boolean;
}

export class TracerPool {
  private tracers: Tracer[] = [];
  private maxTracers: number;
  private nextIndex: number = 0;

  constructor(maxTracers: number = 32) {
    this.maxTracers = maxTracers;

    // Pre-allocate pool
    for (let i = 0; i < maxTracers; i++) {
      this.tracers.push({
        origin: Vector3.zero(),
        endpoint: Vector3.zero(),
        createdAt: 0,
        duration: 100,
        color: new Color(255, 255, 200),
        active: false,
      });
    }
  }

  // Spawn a new tracer
  spawn(
    origin: Vector3,
    endpoint: Vector3,
    duration: number = 80,
    color?: Color
  ): Tracer {
    const tracer = this.tracers[this.nextIndex];

    tracer.origin = origin.clone();
    tracer.endpoint = endpoint.clone();
    tracer.createdAt = performance.now();
    tracer.duration = duration;
    tracer.color = color || new Color(255, 255, 150); // Yellow-white
    tracer.active = true;

    this.nextIndex = (this.nextIndex + 1) % this.maxTracers;
    return tracer;
  }

  // Update tracers - deactivate expired ones
  update(now: number): void {
    for (const tracer of this.tracers) {
      if (tracer.active) {
        const age = now - tracer.createdAt;
        if (age >= tracer.duration) {
          tracer.active = false;
        }
      }
    }
  }

  // Get all active tracers with their current fade amount
  getActiveTracers(now: number): Array<{ tracer: Tracer; fade: number }> {
    const result: Array<{ tracer: Tracer; fade: number }> = [];

    for (const tracer of this.tracers) {
      if (tracer.active) {
        const age = now - tracer.createdAt;
        const fade = 1 - (age / tracer.duration); // 1.0 = fresh, 0.0 = expired
        if (fade > 0) {
          result.push({ tracer, fade });
        }
      }
    }

    return result;
  }

  clear(): void {
    for (const tracer of this.tracers) {
      tracer.active = false;
    }
    this.nextIndex = 0;
  }
}

// Characters for tracer rendering based on angle
// Horizontal, vertical, and diagonal
export const TRACER_CHARS = {
  horizontal: '─',
  vertical: '│',
  diagUp: '/',
  diagDown: '\\',
  dot: '•',
  bright: '█',
};

// Get the best character for a line segment based on its angle
export function getTracerChar(dx: number, dy: number): string {
  if (dx === 0 && dy === 0) return TRACER_CHARS.dot;

  const angle = Math.atan2(dy, dx);
  const absAngle = Math.abs(angle);

  // Horizontal (close to 0 or π)
  if (absAngle < Math.PI / 6 || absAngle > 5 * Math.PI / 6) {
    return TRACER_CHARS.horizontal;
  }
  // Vertical (close to π/2)
  if (absAngle > Math.PI / 3 && absAngle < 2 * Math.PI / 3) {
    return TRACER_CHARS.vertical;
  }
  // Diagonals
  if (angle > 0) {
    return TRACER_CHARS.diagDown; // Going down-right or up-left
  } else {
    return TRACER_CHARS.diagUp; // Going up-right or down-left
  }
}

// Global tracer pool
export const tracerPool = new TracerPool(32);
