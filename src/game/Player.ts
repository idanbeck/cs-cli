// Player entity for CS-CLI

import { Vector3 } from '../engine/math/Vector3.js';
import { WeaponState, WeaponSlot, createWeaponState, canFireWeapon, fireWeapon, startReload, updateReload, WEAPONS } from './Weapon.js';
import { TeamId } from './Team.js';
import { PlayerEconomy, DEFAULT_ECONOMY_CONFIG } from './Economy.js';
import { getDroppedWeaponManager } from './DroppedWeapon.js';

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
  public team: TeamId = 'SPECTATOR';
  public name: string = 'Player';

  // Economy
  public economy: PlayerEconomy;

  // Saved inventory for round transitions
  private savedWeapons: Map<WeaponSlot, WeaponState> | null = null;

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

    // Initialize economy
    this.economy = new PlayerEconomy(DEFAULT_ECONOMY_CONFIG);

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

  respawn(spawnPosition: Vector3, spawnAngle: number, keepInventory: boolean = false): void {
    this.position = spawnPosition.clone();
    this.position.y += this.config.eyeHeight;
    this.yaw = spawnAngle;
    this.pitch = 0;
    this.velocity = Vector3.zero();

    this.health = this.config.maxHealth;
    this.armor = 0;
    this.isAlive = true;

    if (keepInventory && this.savedWeapons) {
      // Restore saved inventory
      this.weapons = new Map(this.savedWeapons);
      this.savedWeapons = null;
    } else if (!keepInventory) {
      // Reset to default loadout
      this.weapons.clear();
      this.weapons.set(2, createWeaponState('pistol'));
      this.weapons.set(3, createWeaponState('knife'));
    }

    // Reset ammo and reload state
    this.weapons.forEach(weapon => {
      weapon.currentAmmo = weapon.def.magazineSize;
      weapon.reserveAmmo = weapon.def.reserveAmmo;
      weapon.isReloading = false;
    });

    // Switch to best weapon
    if (this.weapons.has(1)) {
      this.currentSlot = 1;
    } else {
      this.currentSlot = 2;
    }
  }

  // Save current inventory (for round transitions when alive)
  saveInventory(): void {
    this.savedWeapons = new Map();
    for (const [slot, weapon] of this.weapons) {
      // Clone the weapon state
      this.savedWeapons.set(slot, {
        ...weapon,
        def: weapon.def,
      });
    }
  }

  // Clear saved inventory
  clearSavedInventory(): void {
    this.savedWeapons = null;
  }

  // Clear current inventory to defaults
  resetInventory(): void {
    this.weapons.clear();
    this.weapons.set(2, createWeaponState('pistol'));
    this.weapons.set(3, createWeaponState('knife'));
    this.currentSlot = 2;
  }

  // Drop current weapon at position (returns true if dropped)
  dropCurrentWeapon(now: number): boolean {
    const weapon = this.getCurrentWeapon();
    if (!weapon) return false;

    // Can't drop knife
    if (weapon.def.type === 'knife') return false;

    const slot = weapon.def.slot;
    const dropPos = this.getFeetPosition();

    // Drop the weapon
    getDroppedWeaponManager().dropWeaponState(weapon, dropPos, now);

    // Remove from inventory
    this.weapons.delete(slot);

    // Switch to another weapon
    if (this.weapons.has(2)) {
      this.currentSlot = 2;
    } else {
      this.currentSlot = 3;
    }

    return true;
  }

  // Drop all droppable weapons on death
  dropAllWeapons(now: number): void {
    const dropPos = this.getFeetPosition();
    const dropManager = getDroppedWeaponManager();

    for (const [slot, weapon] of this.weapons) {
      // Don't drop knife
      if (weapon.def.type === 'knife') continue;

      dropManager.dropWeaponState(weapon, dropPos, now);
    }
  }

  // Drop weapon in a specific slot (for picking up a weapon in that slot)
  dropWeaponInSlot(slot: WeaponSlot, now: number): boolean {
    const weapon = this.weapons.get(slot);
    if (!weapon) return false;

    // Can't drop knife
    if (weapon.def.type === 'knife') return false;

    const dropPos = this.getFeetPosition();
    getDroppedWeaponManager().dropWeaponState(weapon, dropPos, now);
    this.weapons.delete(slot);
    return true;
  }

  // Pick up a weapon (add to inventory)
  pickupWeapon(weapon: WeaponState): void {
    this.weapons.set(weapon.def.slot, weapon);
    this.currentSlot = weapon.def.slot;
  }

  // Check if player can afford a weapon
  canAfford(weaponName: string): boolean {
    const weapon = WEAPONS[weaponName.toLowerCase()];
    if (!weapon) return false;
    return this.economy.canAfford(weapon.cost);
  }

  // Buy a weapon (returns true if purchased)
  buyWeapon(weaponName: string): boolean {
    const weaponDef = WEAPONS[weaponName.toLowerCase()];
    if (!weaponDef) return false;

    if (!this.economy.spendMoney(weaponDef.cost)) {
      return false;
    }

    this.giveWeapon(weaponName);
    return true;
  }

  // Award kill credits
  awardKill(weaponType: string): number {
    this.kills++;
    return this.economy.awardKill(weaponType);
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
