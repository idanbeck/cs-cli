// Decal system for wall hits, bullet holes, etc.
// Uses a pool design where oldest decals get recycled

import { Vector3 } from '../engine/math/Vector3.js';
import { Color } from '../utils/Colors.js';

export interface Decal {
  position: Vector3;
  normal: Vector3;      // Surface normal (for orientation)
  type: DecalType;
  size: number;
  color: Color;
  createdAt: number;    // Timestamp for aging/fading
  active: boolean;
}

export type DecalType = 'bullet_hole' | 'blood' | 'scorch';

// Decal visual definitions
export const DECAL_CHARS: Record<DecalType, string[]> = {
  bullet_hole: ['•', '∘', '○'],  // Different sizes
  blood: ['*', '✱', '✸'],
  scorch: ['░', '▒', '▓'],
};

export class DecalPool {
  private decals: Decal[] = [];
  private maxDecals: number;
  private nextIndex: number = 0;  // Circular buffer index

  constructor(maxDecals: number = 64) {
    this.maxDecals = maxDecals;

    // Pre-allocate pool
    for (let i = 0; i < maxDecals; i++) {
      this.decals.push({
        position: Vector3.zero(),
        normal: new Vector3(0, 1, 0),
        type: 'bullet_hole',
        size: 1,
        color: Color.white(),
        createdAt: 0,
        active: false,
      });
    }
  }

  // Spawn a new decal, recycling oldest if pool is full
  spawn(
    position: Vector3,
    normal: Vector3,
    type: DecalType = 'bullet_hole',
    color?: Color
  ): Decal {
    const decal = this.decals[this.nextIndex];

    decal.position = position.clone();
    decal.normal = normal.clone();
    decal.type = type;
    decal.size = 0.1 + Math.random() * 0.1;  // Slight size variation
    decal.color = color || this.getDefaultColor(type);
    decal.createdAt = performance.now();
    decal.active = true;

    // Move to next slot (circular)
    this.nextIndex = (this.nextIndex + 1) % this.maxDecals;

    return decal;
  }

  private getDefaultColor(type: DecalType): Color {
    switch (type) {
      case 'bullet_hole':
        return new Color(40, 40, 40);  // Dark gray/black
      case 'blood':
        return new Color(150, 20, 20); // Dark red
      case 'scorch':
        return new Color(60, 50, 40);  // Burnt brown
      default:
        return Color.white();
    }
  }

  // Get all active decals for rendering
  getActiveDecals(): Decal[] {
    return this.decals.filter(d => d.active);
  }

  // Clear all decals
  clear(): void {
    for (const decal of this.decals) {
      decal.active = false;
    }
    this.nextIndex = 0;
  }

  // Get decal character based on type and distance
  static getChar(decal: Decal, distance: number): string {
    const chars = DECAL_CHARS[decal.type];
    // Use smaller char for distant decals
    if (distance > 20) return chars[0];
    if (distance > 10) return chars[1];
    return chars[2];
  }
}

// Global decal pool instance
export const decalPool = new DecalPool(64);
