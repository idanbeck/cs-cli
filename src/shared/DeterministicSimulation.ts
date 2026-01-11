/**
 * DeterministicSimulation - Shared physics simulation for lockstep multiplayer
 *
 * This module runs identically on all clients to ensure synchronized game state.
 * All physics calculations must be deterministic (same inputs = same outputs).
 */

// ============ Types ============

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface PlayerInput {
  forward: number;   // -1 to 1
  strafe: number;    // -1 to 1
  yaw: number;
  pitch: number;
  jump: boolean;
  crouch: boolean;
}

export interface LockstepAction {
  type: 'fire' | 'reload' | 'buy' | 'drop' | 'pickup' | 'select_weapon';
  data?: any;
}

export type TeamId = 'T' | 'CT' | 'SPECTATOR';
export type WeaponType = 'knife' | 'pistol' | 'rifle' | 'shotgun' | 'sniper';
export type GamePhase = 'warmup' | 'freeze' | 'live' | 'round_end' | 'match_end';

export interface WeaponState {
  type: WeaponType;
  currentAmmo: number;
  reserveAmmo: number;
  isReloading: boolean;
  reloadStartTick: number;
  lastFireTick: number;
}

export interface SimPlayerState {
  id: string;
  name: string;
  team: TeamId;
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  pitch: number;
  health: number;
  armor: number;
  isAlive: boolean;
  currentWeapon: WeaponType;
  weapons: Map<number, WeaponState>;  // slot -> weapon
  money: number;
  kills: number;
  deaths: number;
}

export interface DroppedWeapon {
  id: string;
  weaponType: WeaponType;
  position: Vec3;
  ammo: number;
  reserveAmmo: number;
  dropTick: number;
}

export interface MapData {
  bounds: { min: Vec3; max: Vec3 };
  colliders: Array<{ min: Vec3; max: Vec3 }>;
  spawnPoints: Array<{ position: Vec3; angle: number; team: string }>;
}

export interface SimulationConfig {
  tickRate: number;
  moveSpeed: number;
  gravity: number;
  jumpVelocity: number;
  playerRadius: number;
  playerEyeHeight: number;
}

// ============ Constants ============

export const DEFAULT_SIM_CONFIG: SimulationConfig = {
  tickRate: 60,
  moveSpeed: 8.0,
  gravity: 20.0,
  jumpVelocity: 8.0,
  playerRadius: 0.4,
  playerEyeHeight: 1.7,
};

export const WEAPON_DEFS: Record<WeaponType, {
  slot: number;
  damage: number;
  headshotMultiplier: number;
  fireRate: number;
  reloadTime: number;
  magazineSize: number;
  reserveAmmo: number;
  range: number;
  spread: number;
  cost: number;
}> = {
  knife: { slot: 3, damage: 40, headshotMultiplier: 1, fireRate: 60, reloadTime: 0, magazineSize: Infinity, reserveAmmo: Infinity, range: 2, spread: 0, cost: 0 },
  pistol: { slot: 2, damage: 25, headshotMultiplier: 4, fireRate: 400, reloadTime: 2.2, magazineSize: 12, reserveAmmo: 36, range: 50, spread: 2, cost: 200 },
  rifle: { slot: 1, damage: 30, headshotMultiplier: 4, fireRate: 600, reloadTime: 3.1, magazineSize: 30, reserveAmmo: 90, range: 100, spread: 1.5, cost: 2700 },
  shotgun: { slot: 1, damage: 20, headshotMultiplier: 2, fireRate: 70, reloadTime: 5.5, magazineSize: 8, reserveAmmo: 32, range: 15, spread: 8, cost: 1800 },
  sniper: { slot: 1, damage: 100, headshotMultiplier: 2, fireRate: 40, reloadTime: 3.7, magazineSize: 5, reserveAmmo: 20, range: 200, spread: 0.5, cost: 4750 },
};

// ============ Vector Math ============

export function vec3Add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function vec3Sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function vec3Scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function vec3Length(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

export function vec3Normalize(v: Vec3): Vec3 {
  const len = vec3Length(v);
  if (len === 0) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

export function vec3Distance(a: Vec3, b: Vec3): number {
  return vec3Length(vec3Sub(a, b));
}

export function vec3Clone(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

// ============ Events ============

export interface SimFireEvent {
  attackerId: string;
  origin: Vec3;
  direction: Vec3;
  weapon: WeaponType;
}

export interface SimHitEvent {
  attackerId: string;
  victimId: string;
  damage: number;
  headshot: boolean;
}

export interface SimKillEvent {
  killerId: string;
  killerName: string;
  victimId: string;
  victimName: string;
  weapon: WeaponType;
  headshot: boolean;
}

export interface SimulationEvents {
  onFire?: (event: SimFireEvent) => void;
  onHit?: (event: SimHitEvent) => void;
  onKill?: (event: SimKillEvent) => void;
  onPhaseChange?: (phase: GamePhase) => void;
}

// ============ Deterministic Simulation ============

export class DeterministicSimulation {
  private players: Map<string, SimPlayerState> = new Map();
  private droppedWeapons: Map<string, DroppedWeapon> = new Map();
  private currentTick = 0;
  private config: SimulationConfig;
  private mapData: MapData;
  private events: SimulationEvents;

  // Game state
  private phase: GamePhase = 'warmup';
  private phaseStartTick = 0;
  private tScore = 0;
  private ctScore = 0;
  private roundNumber = 0;

  // Deterministic random seed for weapon drops, etc.
  private randomSeed = 12345;

  constructor(
    mapData: MapData,
    config: SimulationConfig = DEFAULT_SIM_CONFIG,
    events: SimulationEvents = {}
  ) {
    this.mapData = mapData;
    this.config = config;
    this.events = events;
  }

  // ============ Player Management ============

  addPlayer(id: string, name: string, team: TeamId, spawnPosition: Vec3, spawnYaw: number): void {
    const player: SimPlayerState = {
      id,
      name,
      team,
      position: vec3Clone(spawnPosition),
      velocity: { x: 0, y: 0, z: 0 },
      yaw: spawnYaw,
      pitch: 0,
      health: 100,
      armor: 0,
      isAlive: true,
      currentWeapon: 'pistol',
      weapons: new Map([
        [2, { type: 'pistol', currentAmmo: 12, reserveAmmo: 36, isReloading: false, reloadStartTick: 0, lastFireTick: 0 }],
        [3, { type: 'knife', currentAmmo: Infinity, reserveAmmo: Infinity, isReloading: false, reloadStartTick: 0, lastFireTick: 0 }],
      ]),
      money: 800,
      kills: 0,
      deaths: 0,
    };
    this.players.set(id, player);
  }

  removePlayer(id: string): void {
    this.players.delete(id);
  }

  getPlayer(id: string): SimPlayerState | undefined {
    return this.players.get(id);
  }

  getAllPlayers(): SimPlayerState[] {
    return Array.from(this.players.values());
  }

  getCurrentTick(): number {
    return this.currentTick;
  }

  getPhase(): GamePhase {
    return this.phase;
  }

  setPhase(phase: GamePhase): void {
    this.phase = phase;
    this.phaseStartTick = this.currentTick;
    this.events.onPhaseChange?.(phase);
  }

  // ============ Main Tick ============

  /**
   * Advance simulation by one tick with given inputs.
   * This MUST be deterministic - same inputs = same outputs.
   */
  tick(inputs: Map<string, { input: PlayerInput; actions: LockstepAction[] }>): void {
    const deltaTime = 1.0 / this.config.tickRate;

    // Process players in deterministic order (sorted by ID)
    const sortedIds = Array.from(this.players.keys()).sort();

    for (const playerId of sortedIds) {
      const player = this.players.get(playerId)!;
      const playerInput = inputs.get(playerId);

      if (playerInput && player.isAlive) {
        // Process movement input
        this.processInput(player, playerInput.input, deltaTime);

        // Process actions (fire, reload, etc.)
        for (const action of playerInput.actions) {
          this.processAction(player, action);
        }
      }

      // Apply physics (gravity, etc.)
      this.applyPhysics(player, deltaTime);

      // Update reloads
      this.updateReload(player);
    }

    this.currentTick++;
  }

  private processInput(player: SimPlayerState, input: PlayerInput, deltaTime: number): void {
    // Update look direction
    player.yaw = input.yaw;
    player.pitch = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, input.pitch));

    // Can't move during freeze phase
    if (this.phase === 'freeze' || this.phase === 'round_end') {
      return;
    }

    // Calculate movement direction based on yaw
    const cosYaw = Math.cos(player.yaw);
    const sinYaw = Math.sin(player.yaw);

    // Forward direction (negative Z in our coordinate system)
    const forwardX = -sinYaw * input.forward;
    const forwardZ = -cosYaw * input.forward;

    // Right direction (strafe)
    const strafeX = cosYaw * input.strafe;
    const strafeZ = -sinYaw * input.strafe;

    // Combined movement
    let moveX = forwardX + strafeX;
    let moveZ = forwardZ + strafeZ;

    // Normalize if moving diagonally
    const moveLen = Math.sqrt(moveX * moveX + moveZ * moveZ);
    if (moveLen > 1.0) {
      moveX /= moveLen;
      moveZ /= moveLen;
    }

    // Apply movement with collision detection
    const speed = this.config.moveSpeed * deltaTime;
    const newPos = {
      x: player.position.x + moveX * speed,
      y: player.position.y,
      z: player.position.z + moveZ * speed,
    };

    // Collision detection with wall sliding
    if (!this.checkCollision(newPos)) {
      player.position = newPos;
    } else {
      // Try X-only movement
      const newPosX = { ...player.position, x: newPos.x };
      if (!this.checkCollision(newPosX)) {
        player.position = newPosX;
      } else {
        // Try Z-only movement
        const newPosZ = { ...player.position, z: newPos.z };
        if (!this.checkCollision(newPosZ)) {
          player.position = newPosZ;
        }
      }
    }

    // Jump
    if (input.jump && player.position.y <= this.config.playerEyeHeight + 0.1) {
      player.velocity.y = this.config.jumpVelocity;
    }
  }

  private applyPhysics(player: SimPlayerState, deltaTime: number): void {
    if (!player.isAlive) return;

    // Gravity
    player.velocity.y -= this.config.gravity * deltaTime;
    player.position.y += player.velocity.y * deltaTime;

    // Ground collision
    if (player.position.y < this.config.playerEyeHeight) {
      player.position.y = this.config.playerEyeHeight;
      player.velocity.y = 0;
    }

    // Clamp to map bounds
    const { bounds } = this.mapData;
    const r = this.config.playerRadius;
    player.position.x = Math.max(bounds.min.x + r, Math.min(bounds.max.x - r, player.position.x));
    player.position.z = Math.max(bounds.min.z + r, Math.min(bounds.max.z - r, player.position.z));
  }

  private processAction(player: SimPlayerState, action: LockstepAction): void {
    switch (action.type) {
      case 'fire':
        this.processFire(player);
        break;
      case 'reload':
        this.processReload(player);
        break;
      case 'buy':
        this.processBuy(player, action.data?.weaponType);
        break;
      case 'drop':
        this.processDrop(player);
        break;
      case 'pickup':
        this.processPickup(player, action.data?.weaponId);
        break;
      case 'select_weapon':
        this.processSelectWeapon(player, action.data?.slot);
        break;
    }
  }

  private processFire(player: SimPlayerState): void {
    const weaponSlot = WEAPON_DEFS[player.currentWeapon].slot;
    const weapon = player.weapons.get(weaponSlot);
    if (!weapon) return;

    const def = WEAPON_DEFS[player.currentWeapon];
    const fireInterval = Math.floor(this.config.tickRate / (def.fireRate / 60));

    // Check if can fire
    if (weapon.isReloading) return;
    if (weapon.currentAmmo <= 0) return;
    if (this.currentTick - weapon.lastFireTick < fireInterval) return;

    // Fire
    weapon.currentAmmo--;
    weapon.lastFireTick = this.currentTick;

    // Calculate fire direction with spread
    const direction = this.getAimDirection(player, def.spread);

    // Emit fire event
    this.events.onFire?.({
      attackerId: player.id,
      origin: vec3Clone(player.position),
      direction,
      weapon: player.currentWeapon,
    });

    // Perform hit detection
    this.performHitDetection(player, direction, def);
  }

  private processReload(player: SimPlayerState): void {
    const weaponSlot = WEAPON_DEFS[player.currentWeapon].slot;
    const weapon = player.weapons.get(weaponSlot);
    if (!weapon) return;

    const def = WEAPON_DEFS[player.currentWeapon];
    if (weapon.isReloading) return;
    if (weapon.currentAmmo >= def.magazineSize) return;
    if (weapon.reserveAmmo <= 0) return;

    weapon.isReloading = true;
    weapon.reloadStartTick = this.currentTick;
  }

  private processBuy(player: SimPlayerState, weaponType: WeaponType): void {
    if (!weaponType) return;
    if (this.phase !== 'freeze' && this.phase !== 'warmup') return;

    const def = WEAPON_DEFS[weaponType];
    if (!def) return;
    if (player.money < def.cost) return;

    player.money -= def.cost;
    player.weapons.set(def.slot, {
      type: weaponType,
      currentAmmo: def.magazineSize,
      reserveAmmo: def.reserveAmmo,
      isReloading: false,
      reloadStartTick: 0,
      lastFireTick: 0,
    });
    player.currentWeapon = weaponType;
  }

  private processDrop(player: SimPlayerState): void {
    const weaponSlot = WEAPON_DEFS[player.currentWeapon].slot;
    const weapon = player.weapons.get(weaponSlot);
    if (!weapon || weapon.type === 'knife') return;

    // Create dropped weapon
    const dropId = `drop_${this.currentTick}_${player.id.slice(0, 4)}`;
    const dropped: DroppedWeapon = {
      id: dropId,
      weaponType: weapon.type,
      position: { ...player.position, y: player.position.y - this.config.playerEyeHeight },
      ammo: weapon.currentAmmo,
      reserveAmmo: weapon.reserveAmmo,
      dropTick: this.currentTick,
    };
    this.droppedWeapons.set(dropId, dropped);

    // Remove from player
    player.weapons.delete(weaponSlot);
    player.currentWeapon = player.weapons.has(2) ? 'pistol' : 'knife';
  }

  private processPickup(player: SimPlayerState, weaponId: string): void {
    if (!weaponId) return;
    const dropped = this.droppedWeapons.get(weaponId);
    if (!dropped) return;

    // Check distance
    const dist = vec3Distance(player.position, { ...dropped.position, y: player.position.y });
    if (dist > 3) return;

    // Pick up
    const def = WEAPON_DEFS[dropped.weaponType];
    player.weapons.set(def.slot, {
      type: dropped.weaponType,
      currentAmmo: dropped.ammo,
      reserveAmmo: dropped.reserveAmmo,
      isReloading: false,
      reloadStartTick: 0,
      lastFireTick: 0,
    });
    player.currentWeapon = dropped.weaponType;

    this.droppedWeapons.delete(weaponId);
  }

  private processSelectWeapon(player: SimPlayerState, slot: number): void {
    if (slot === undefined) return;
    const weapon = player.weapons.get(slot);
    if (weapon) {
      player.currentWeapon = weapon.type;
    }
  }

  private updateReload(player: SimPlayerState): void {
    for (const weapon of player.weapons.values()) {
      if (weapon.isReloading) {
        const def = WEAPON_DEFS[weapon.type];
        const reloadTicks = Math.floor(def.reloadTime * this.config.tickRate);
        if (this.currentTick - weapon.reloadStartTick >= reloadTicks) {
          const ammoNeeded = def.magazineSize - weapon.currentAmmo;
          const ammoToAdd = Math.min(ammoNeeded, weapon.reserveAmmo);
          weapon.currentAmmo += ammoToAdd;
          weapon.reserveAmmo -= ammoToAdd;
          weapon.isReloading = false;
        }
      }
    }
  }

  // ============ Combat ============

  private performHitDetection(
    attacker: SimPlayerState,
    direction: Vec3,
    weaponDef: typeof WEAPON_DEFS[WeaponType]
  ): void {
    // Check against all enemies
    for (const player of this.players.values()) {
      if (!player.isAlive || player.team === attacker.team || player.id === attacker.id) continue;

      const hit = this.checkRayHit(attacker.position, direction, player.position, weaponDef.range);
      if (hit) {
        const damage = hit.isHeadshot
          ? weaponDef.damage * weaponDef.headshotMultiplier
          : weaponDef.damage;
        this.damagePlayer(player, damage, hit.isHeadshot, attacker);
      }
    }
  }

  private checkRayHit(
    origin: Vec3,
    direction: Vec3,
    targetPos: Vec3,
    maxDist: number
  ): { isHeadshot: boolean } | null {
    const toTarget = vec3Sub(targetPos, origin);
    const dist = vec3Length(toTarget);
    if (dist > maxDist) return null;

    // Project target onto ray
    const dot = toTarget.x * direction.x + toTarget.y * direction.y + toTarget.z * direction.z;
    if (dot < 0) return null;

    // Distance from ray to target
    const closestPoint = vec3Add(origin, vec3Scale(direction, dot));
    const distToRay = vec3Distance(closestPoint, targetPos);

    if (distToRay < this.config.playerRadius * 2) {
      // Hit! Check if headshot
      const hitY = closestPoint.y - (targetPos.y - this.config.playerEyeHeight);
      const isHeadshot = hitY > 1.5;
      return { isHeadshot };
    }

    return null;
  }

  private damagePlayer(
    victim: SimPlayerState,
    damage: number,
    isHeadshot: boolean,
    attacker: SimPlayerState
  ): void {
    // Apply armor absorption
    let actualDamage = damage;
    if (victim.armor > 0) {
      const absorbed = Math.min(victim.armor, damage * 0.5);
      victim.armor -= absorbed;
      actualDamage = damage - absorbed * 0.5;
    }

    victim.health -= actualDamage;

    this.events.onHit?.({
      attackerId: attacker.id,
      victimId: victim.id,
      damage: actualDamage,
      headshot: isHeadshot,
    });

    if (victim.health <= 0) {
      victim.health = 0;
      victim.isAlive = false;
      victim.deaths++;
      attacker.kills++;

      this.events.onKill?.({
        killerId: attacker.id,
        killerName: attacker.name,
        victimId: victim.id,
        victimName: victim.name,
        weapon: attacker.currentWeapon,
        headshot: isHeadshot,
      });
    }
  }

  // ============ Collision Detection ============

  private checkCollision(pos: Vec3): boolean {
    const { bounds, colliders } = this.mapData;
    const r = this.config.playerRadius;

    // Check map bounds
    if (
      pos.x < bounds.min.x + r ||
      pos.x > bounds.max.x - r ||
      pos.z < bounds.min.z + r ||
      pos.z > bounds.max.z - r
    ) {
      return true;
    }

    // Check colliders (AABB vs sphere)
    for (const collider of colliders) {
      const minX = collider.min.x - r;
      const maxX = collider.max.x + r;
      const minZ = collider.min.z - r;
      const maxZ = collider.max.z + r;
      const maxY = collider.max.y;

      if (
        pos.x >= minX && pos.x <= maxX &&
        pos.z >= minZ && pos.z <= maxZ &&
        (pos.y - this.config.playerEyeHeight) < maxY
      ) {
        return true;
      }
    }

    return false;
  }

  // ============ Utility ============

  private getAimDirection(player: SimPlayerState, spread: number): Vec3 {
    // Use deterministic random for spread
    const spreadRad = (spread * Math.PI) / 180;
    const randYaw = (this.nextRandom() - 0.5) * spreadRad;
    const randPitch = (this.nextRandom() - 0.5) * spreadRad;

    return vec3Normalize({
      x: -Math.sin(player.yaw + randYaw) * Math.cos(player.pitch + randPitch),
      y: Math.sin(player.pitch + randPitch),
      z: -Math.cos(player.yaw + randYaw) * Math.cos(player.pitch + randPitch),
    });
  }

  // Deterministic pseudo-random number generator
  private nextRandom(): number {
    this.randomSeed = (this.randomSeed * 1103515245 + 12345) & 0x7fffffff;
    return this.randomSeed / 0x7fffffff;
  }

  /**
   * Get a deterministic hash of the current state for sync verification
   */
  getStateHash(): string {
    const players = Array.from(this.players.values())
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(p => `${p.id}:${p.position.x.toFixed(4)},${p.position.y.toFixed(4)},${p.position.z.toFixed(4)},${p.health},${p.isAlive}`)
      .join('|');
    return `tick${this.currentTick}:${players}`;
  }

  /**
   * Serialize state for debugging
   */
  getState(): {
    tick: number;
    phase: GamePhase;
    players: SimPlayerState[];
    droppedWeapons: DroppedWeapon[];
    tScore: number;
    ctScore: number;
    roundNumber: number;
  } {
    return {
      tick: this.currentTick,
      phase: this.phase,
      players: this.getAllPlayers(),
      droppedWeapons: Array.from(this.droppedWeapons.values()),
      tScore: this.tScore,
      ctScore: this.ctScore,
      roundNumber: this.roundNumber,
    };
  }
}
