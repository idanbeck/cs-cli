// Dropped weapon system for CS-style game
// Handles weapon drops on death and pickups

import { Vector3 } from '../engine/math/Vector3.js';
import { WeaponState, WeaponSlot, createWeaponState, WEAPONS } from './Weapon.js';

export interface DroppedWeapon {
  id: string;
  weaponName: string;
  slot: WeaponSlot;
  position: Vector3;
  currentAmmo: number;
  reserveAmmo: number;
  dropTime: number;
  despawnTime: number;
}

// Lifetime of dropped weapons in milliseconds (60 seconds)
const WEAPON_DESPAWN_TIME = 60000;

// Pickup radius
const PICKUP_RADIUS = 2.0;

// Counter for unique IDs
let dropIdCounter = 0;

export class DroppedWeaponManager {
  private weapons: DroppedWeapon[] = [];

  // Drop a weapon at a position
  dropWeapon(
    weaponName: string,
    slot: WeaponSlot,
    position: Vector3,
    currentAmmo: number,
    reserveAmmo: number,
    now: number
  ): DroppedWeapon {
    const dropped: DroppedWeapon = {
      id: `drop_${dropIdCounter++}`,
      weaponName,
      slot,
      position: position.clone(),
      currentAmmo,
      reserveAmmo,
      dropTime: now,
      despawnTime: now + WEAPON_DESPAWN_TIME,
    };

    this.weapons.push(dropped);
    return dropped;
  }

  // Drop a weapon from a WeaponState
  dropWeaponState(weapon: WeaponState, position: Vector3, now: number): DroppedWeapon {
    return this.dropWeapon(
      weapon.def.name,
      weapon.def.slot,
      position,
      weapon.currentAmmo,
      weapon.reserveAmmo,
      now
    );
  }

  // Get all dropped weapons
  getAll(): DroppedWeapon[] {
    return this.weapons;
  }

  // Get weapons near a position
  getWeaponsNear(position: Vector3, radius: number = PICKUP_RADIUS): DroppedWeapon[] {
    return this.weapons.filter(w => {
      const dx = w.position.x - position.x;
      const dy = w.position.y - position.y;
      const dz = w.position.z - position.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      return distSq <= radius * radius;
    });
  }

  // Get closest weapon near a position
  getClosestWeapon(position: Vector3, radius: number = PICKUP_RADIUS): DroppedWeapon | null {
    const nearby = this.getWeaponsNear(position, radius);
    if (nearby.length === 0) return null;

    let closest: DroppedWeapon | null = null;
    let closestDistSq = Infinity;

    for (const w of nearby) {
      const dx = w.position.x - position.x;
      const dy = w.position.y - position.y;
      const dz = w.position.z - position.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq < closestDistSq) {
        closestDistSq = distSq;
        closest = w;
      }
    }

    return closest;
  }

  // Remove a weapon by ID (when picked up)
  removeWeapon(id: string): DroppedWeapon | null {
    const index = this.weapons.findIndex(w => w.id === id);
    if (index === -1) return null;
    return this.weapons.splice(index, 1)[0];
  }

  // Convert dropped weapon back to WeaponState for pickup
  toWeaponState(dropped: DroppedWeapon): WeaponState | null {
    const def = WEAPONS[dropped.weaponName.toLowerCase()];
    if (!def) return null;

    const state = createWeaponState(dropped.weaponName);
    if (!state) return null;

    state.currentAmmo = dropped.currentAmmo;
    state.reserveAmmo = dropped.reserveAmmo;
    return state;
  }

  // Update: remove expired weapons
  update(now: number): void {
    this.weapons = this.weapons.filter(w => now < w.despawnTime);
  }

  // Clear all dropped weapons (round reset)
  clearAll(): void {
    this.weapons = [];
  }

  // Get count of dropped weapons
  getCount(): number {
    return this.weapons.length;
  }
}

// Singleton instance
let droppedWeaponManagerInstance: DroppedWeaponManager | null = null;

export function getDroppedWeaponManager(): DroppedWeaponManager {
  if (!droppedWeaponManagerInstance) {
    droppedWeaponManagerInstance = new DroppedWeaponManager();
  }
  return droppedWeaponManagerInstance;
}

export function resetDroppedWeaponManager(): void {
  droppedWeaponManagerInstance = new DroppedWeaponManager();
}
