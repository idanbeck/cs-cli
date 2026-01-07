// Player entity for CS-CLI

import { Vector3 } from '../engine/math/Vector3.js';
import { WeaponState, WeaponSlot, createWeaponState, canFireWeapon, fireWeapon, startReload, updateReload } from './Weapon.js';

export interface PlayerConfig {
  maxHealth: number;
  maxArmor: number;
  moveSpeed: number;
  eyeHeight: number;
  radius: number;
  height: number;
}

export const DEFAULT_PLAYER_CONFIG: PlayerConfig = {
  maxHealth: 100,
  maxArmor: 100,
  moveSpeed: 8,
  eyeHeight: 1.7,
  radius: 0.4,
  height: 1.8,
};

export class Player {
  // Position and physics
  public position: Vector3;
  public velocity: Vector3;
  public yaw: number;
  public pitch: number;

  // Stats
  public health: number;
  public armor: number;
  public isAlive: boolean;

  // Weapons (slots 1-5)
  public weapons: Map<WeaponSlot, WeaponState>;
  public currentSlot: WeaponSlot;

  // Config
  public config: PlayerConfig;

  // Combat stats
  public kills: number = 0;
  public deaths: number = 0;

  // Team
  public team: string = 'DM';
  public name: string = 'Player';

  // Cheats
  public godMode: boolean = false;

  constructor(config: PlayerConfig = DEFAULT_PLAYER_CONFIG) {
    this.config = config;
    this.position = new Vector3(0, config.eyeHeight, 0);
    this.velocity = Vector3.zero();
    this.yaw = 0;
    this.pitch = 0;

    this.health = config.maxHealth;
    this.armor = 0;
    this.isAlive = true;

    // Start with knife and pistol
    this.weapons = new Map();
    this.weapons.set(2, createWeaponState('pistol'));
    this.weapons.set(3, createWeaponState('knife'));
    this.currentSlot = 2; // Start with pistol
  }

  getCurrentWeapon(): WeaponState | undefined {
    return this.weapons.get(this.currentSlot);
  }

  selectWeapon(slot: WeaponSlot): boolean {
    if (this.weapons.has(slot)) {
      this.currentSlot = slot;
      return true;
    }
    return false;
  }

  giveWeapon(weaponName: string): boolean {
    const weapon = createWeaponState(weaponName);
    const slot = weapon.def.slot;

    // Replace weapon in that slot
    this.weapons.set(slot, weapon);
    return true;
  }

  canFire(now: number): boolean {
    const weapon = this.getCurrentWeapon();
    if (!weapon) return false;
    return canFireWeapon(weapon, now);
  }

  fire(now: number): boolean {
    const weapon = this.getCurrentWeapon();
    if (!weapon) return false;
    return fireWeapon(weapon, now);
  }

  reload(now: number): boolean {
    const weapon = this.getCurrentWeapon();
    if (!weapon) return false;
    return startReload(weapon, now);
  }

  updateWeapon(now: number): void {
    const weapon = this.getCurrentWeapon();
    if (weapon) {
      updateReload(weapon, now);
    }
  }

  takeDamage(damage: number, isHeadshot: boolean = false): number {
    if (!this.isAlive) return 0;
    if (this.godMode) return 0;

    let actualDamage = damage;

    // Armor absorbs some damage
    if (this.armor > 0) {
      const armorAbsorption = Math.min(this.armor, damage * 0.5);
      this.armor -= armorAbsorption;
      actualDamage = damage - armorAbsorption * 0.5;
    }

    this.health -= actualDamage;

    if (this.health <= 0) {
      this.health = 0;
      this.die();
    }

    return actualDamage;
  }

  die(): void {
    this.isAlive = false;
    this.deaths++;
  }

  respawn(spawnPosition: Vector3, spawnAngle: number): void {
    this.position = spawnPosition.clone();
    this.position.y += this.config.eyeHeight;
    this.yaw = spawnAngle;
    this.pitch = 0;
    this.velocity = Vector3.zero();

    this.health = this.config.maxHealth;
    this.armor = 0;
    this.isAlive = true;

    // Reset ammo
    this.weapons.forEach(weapon => {
      weapon.currentAmmo = weapon.def.magazineSize;
      weapon.reserveAmmo = weapon.def.reserveAmmo;
      weapon.isReloading = false;
    });
  }

  getEyePosition(): Vector3 {
    return this.position.clone();
  }

  getFeetPosition(): Vector3 {
    return new Vector3(
      this.position.x,
      this.position.y - this.config.eyeHeight,
      this.position.z
    );
  }

  getForward(): Vector3 {
    return new Vector3(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch)
    ).normalize();
  }

  getRight(): Vector3 {
    return new Vector3(
      Math.cos(this.yaw),
      0,
      -Math.sin(this.yaw)
    ).normalize();
  }

  // Get aim direction with weapon spread applied
  getAimDirection(spreadMultiplier: number = 1): Vector3 {
    const weapon = this.getCurrentWeapon();
    if (!weapon) return this.getForward();

    const spread = weapon.def.spread * spreadMultiplier;
    if (spread === 0) return this.getForward();

    // Add random spread
    const spreadRad = (spread * Math.PI) / 180;
    const randomYaw = (Math.random() - 0.5) * spreadRad;
    const randomPitch = (Math.random() - 0.5) * spreadRad;

    return new Vector3(
      -Math.sin(this.yaw + randomYaw) * Math.cos(this.pitch + randomPitch),
      Math.sin(this.pitch + randomPitch),
      -Math.cos(this.yaw + randomYaw) * Math.cos(this.pitch + randomPitch)
    ).normalize();
  }
}
