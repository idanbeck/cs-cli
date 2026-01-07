// Weapon system for CS-CLI

export type WeaponType = 'knife' | 'pistol' | 'rifle' | 'shotgun' | 'sniper';
export type WeaponSlot = 1 | 2 | 3 | 4 | 5;

export interface WeaponDef {
  name: string;
  type: WeaponType;
  slot: WeaponSlot;
  damage: number;
  fireRate: number;      // Rounds per minute
  reloadTime: number;    // Seconds
  magazineSize: number;
  reserveAmmo: number;
  spread: number;        // Degrees of inaccuracy
  range: number;         // Max effective range
  moveSpeed: number;     // Movement speed multiplier (1.0 = normal)
  pellets?: number;      // For shotgun
  isAutomatic: boolean;
  headshotMultiplier: number;
}

export interface WeaponState {
  def: WeaponDef;
  currentAmmo: number;
  reserveAmmo: number;
  isReloading: boolean;
  reloadStartTime: number;
  lastFireTime: number;
  canFire: boolean;
}

// Weapon definitions
export const WEAPONS: Record<string, WeaponDef> = {
  knife: {
    name: 'Knife',
    type: 'knife',
    slot: 3,
    damage: 40,
    fireRate: 60,
    reloadTime: 0,
    magazineSize: Infinity,
    reserveAmmo: Infinity,
    spread: 0,
    range: 2,
    moveSpeed: 1.0,
    isAutomatic: false,
    headshotMultiplier: 1.0,
  },

  pistol: {
    name: 'Pistol',
    type: 'pistol',
    slot: 2,
    damage: 25,
    fireRate: 400,
    reloadTime: 2.2,
    magazineSize: 12,
    reserveAmmo: 36,
    spread: 2,
    range: 50,
    moveSpeed: 1.0,
    isAutomatic: false,
    headshotMultiplier: 2.0,
  },

  rifle: {
    name: 'Rifle',
    type: 'rifle',
    slot: 1,
    damage: 30,
    fireRate: 600,
    reloadTime: 2.5,
    magazineSize: 30,
    reserveAmmo: 90,
    spread: 3,
    range: 80,
    moveSpeed: 0.9,
    isAutomatic: true,
    headshotMultiplier: 2.5,
  },

  shotgun: {
    name: 'Shotgun',
    type: 'shotgun',
    slot: 1,
    damage: 20,
    fireRate: 70,
    reloadTime: 0.5, // Per shell
    magazineSize: 8,
    reserveAmmo: 32,
    spread: 8,
    range: 20,
    moveSpeed: 0.9,
    pellets: 8,
    isAutomatic: false,
    headshotMultiplier: 1.5,
  },

  sniper: {
    name: 'Sniper',
    type: 'sniper',
    slot: 1,
    damage: 100,
    fireRate: 40,
    reloadTime: 3.5,
    magazineSize: 5,
    reserveAmmo: 20,
    spread: 0.5,
    range: 150,
    moveSpeed: 0.8,
    isAutomatic: false,
    headshotMultiplier: 4.0,
  },
};

export function createWeaponState(weaponName: string): WeaponState {
  const def = WEAPONS[weaponName];
  if (!def) {
    throw new Error(`Unknown weapon: ${weaponName}`);
  }

  return {
    def,
    currentAmmo: def.magazineSize,
    reserveAmmo: def.reserveAmmo,
    isReloading: false,
    reloadStartTime: 0,
    lastFireTime: 0,
    canFire: true,
  };
}

export function canFireWeapon(weapon: WeaponState, now: number): boolean {
  if (weapon.isReloading) return false;
  if (weapon.currentAmmo <= 0) return false;

  const fireInterval = 60000 / weapon.def.fireRate; // ms between shots
  return (now - weapon.lastFireTime) >= fireInterval;
}

export function fireWeapon(weapon: WeaponState, now: number): boolean {
  if (!canFireWeapon(weapon, now)) return false;

  weapon.currentAmmo--;
  weapon.lastFireTime = now;
  return true;
}

export function startReload(weapon: WeaponState, now: number): boolean {
  if (weapon.isReloading) return false;
  if (weapon.currentAmmo >= weapon.def.magazineSize) return false;
  if (weapon.reserveAmmo <= 0) return false;

  weapon.isReloading = true;
  weapon.reloadStartTime = now;
  return true;
}

export function updateReload(weapon: WeaponState, now: number): boolean {
  if (!weapon.isReloading) return false;

  const elapsed = (now - weapon.reloadStartTime) / 1000;
  if (elapsed >= weapon.def.reloadTime) {
    // Reload complete
    const ammoNeeded = weapon.def.magazineSize - weapon.currentAmmo;
    const ammoToAdd = Math.min(ammoNeeded, weapon.reserveAmmo);
    weapon.currentAmmo += ammoToAdd;
    weapon.reserveAmmo -= ammoToAdd;
    weapon.isReloading = false;
    return true;
  }
  return false;
}

export function getReloadProgress(weapon: WeaponState, now: number): number {
  if (!weapon.isReloading) return 1;
  const elapsed = (now - weapon.reloadStartTime) / 1000;
  return Math.min(1, elapsed / weapon.def.reloadTime);
}
