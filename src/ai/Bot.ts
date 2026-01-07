// Bot entity - AI-controlled player
import { Vector3 } from '../engine/math/Vector3.js';
import { Player, PlayerConfig, DEFAULT_PLAYER_CONFIG } from '../game/Player.js';
import { TeamId, getTeamManager } from '../game/Team.js';
import { WEAPONS, getBuyableWeapons, WeaponDef } from '../game/Weapon.js';

export type BotState = 'idle' | 'patrol' | 'chase' | 'attack' | 'flee' | 'dead';
export type BotDifficulty = 'easy' | 'medium' | 'hard';

export interface BotConfig {
  difficulty: BotDifficulty;
  reactionTime: number;      // ms to react to seeing enemy
  accuracy: number;          // 0-1, affects aim spread
  aggressiveness: number;    // 0-1, affects chase vs flee decision
  fov: number;               // Field of view in degrees
  sightRange: number;        // How far bot can see
}

export const BOT_DIFFICULTY_CONFIGS: Record<BotDifficulty, BotConfig> = {
  easy: {
    difficulty: 'easy',
    reactionTime: 500,
    accuracy: 0.3,
    aggressiveness: 0.3,
    fov: 90,
    sightRange: 30,
  },
  medium: {
    difficulty: 'medium',
    reactionTime: 300,
    accuracy: 0.6,
    aggressiveness: 0.6,
    fov: 110,
    sightRange: 50,
  },
  hard: {
    difficulty: 'hard',
    reactionTime: 150,
    accuracy: 0.85,
    aggressiveness: 0.8,
    fov: 130,
    sightRange: 70,
  },
};

export class Bot extends Player {
  // AI state
  public state: BotState = 'idle';
  public botConfig: BotConfig;

  // Current target
  public target: Player | null = null;
  public lastSeenTargetPos: Vector3 | null = null;
  public lastSeenTargetTime: number = 0;

  // Patrol waypoints
  public patrolWaypoints: Vector3[] = [];
  public currentWaypointIndex: number = 0;

  // Timing
  public stateStartTime: number = 0;
  public lastThinkTime: number = 0;
  public thinkInterval: number = 100; // ms between AI updates
  public lastFireTime: number = 0;

  // Movement
  public moveTarget: Vector3 | null = null;
  public stuckTime: number = 0;
  public lastPosition: Vector3;

  constructor(
    difficulty: BotDifficulty = 'medium',
    playerConfig: PlayerConfig = DEFAULT_PLAYER_CONFIG
  ) {
    super(playerConfig);
    this.botConfig = BOT_DIFFICULTY_CONFIGS[difficulty];
    this.lastPosition = this.position.clone();
    this.name = this.generateBotName();
  }

  private generateBotName(): string {
    const prefixes = ['Bot', 'AI', 'CPU', 'NPC'];
    const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Fox', 'Ghost', 'Hawk'];
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
    const name = names[Math.floor(Math.random() * names.length)];
    return `${prefix}_${name}`;
  }

  setState(newState: BotState, now: number): void {
    if (this.state !== newState) {
      this.state = newState;
      this.stateStartTime = now;
    }
  }

  // Check if bot can see a position from current location
  canSeePosition(pos: Vector3): boolean {
    const toTarget = Vector3.sub(pos, this.position);
    const distance = toTarget.length();

    // Check range
    if (distance > this.botConfig.sightRange) return false;

    // Check FOV
    const forward = this.getForward();
    const toTargetNorm = toTarget.normalize();
    const dot = Vector3.dot(forward, toTargetNorm);
    const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
    const fovRad = (this.botConfig.fov / 2) * (Math.PI / 180);

    return angle <= fovRad;
  }

  // Check if bot can see a player (including line of sight check)
  canSeePlayer(player: Player, checkLineOfSight: (from: Vector3, to: Vector3) => boolean): boolean {
    if (!player.isAlive) return false;
    if (player === this) return false;

    const targetPos = player.getEyePosition();

    // Basic visibility check
    if (!this.canSeePosition(targetPos)) return false;

    // Line of sight check (raycast)
    return checkLineOfSight(this.getEyePosition(), targetPos);
  }

  // Get aim direction with bot accuracy applied
  getAimDirectionWithAccuracy(targetPos: Vector3): Vector3 {
    const toTarget = Vector3.sub(targetPos, this.getEyePosition()).normalize();

    // Add inaccuracy based on bot skill
    const inaccuracy = (1 - this.botConfig.accuracy) * 0.2; // Max ~11 degrees
    const randomYaw = (Math.random() - 0.5) * inaccuracy;
    const randomPitch = (Math.random() - 0.5) * inaccuracy;

    // Rotate direction by inaccuracy
    const yaw = Math.atan2(-toTarget.x, -toTarget.z) + randomYaw;
    const pitch = Math.asin(toTarget.y) + randomPitch;

    return new Vector3(
      -Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      -Math.cos(yaw) * Math.cos(pitch)
    ).normalize();
  }

  // Look toward a position
  lookAt(targetPos: Vector3): void {
    const toTarget = Vector3.sub(targetPos, this.getEyePosition());
    this.yaw = Math.atan2(-toTarget.x, -toTarget.z);
    this.pitch = Math.asin(toTarget.y / toTarget.length());

    // Clamp pitch
    this.pitch = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, this.pitch));
  }

  // Move toward a position, returns movement vector
  getMoveToward(targetPos: Vector3, speed: number, deltaTime: number): Vector3 {
    const toTarget = Vector3.sub(targetPos, this.position);
    toTarget.y = 0; // Only move horizontally
    const distance = toTarget.length();

    if (distance < 0.5) {
      return Vector3.zero(); // Close enough
    }

    const direction = toTarget.normalize();
    return Vector3.scale(direction, speed * deltaTime);
  }

  // Check if stuck (hasn't moved much recently)
  checkStuck(now: number): boolean {
    const moved = Vector3.sub(this.position, this.lastPosition).length();
    if (moved < 0.1) {
      this.stuckTime += now - this.lastThinkTime;
    } else {
      this.stuckTime = 0;
    }
    this.lastPosition = this.position.clone();
    return this.stuckTime > 1000; // Stuck for 1 second
  }

  // Get next patrol waypoint
  getNextWaypoint(): Vector3 | null {
    if (this.patrolWaypoints.length === 0) return null;

    const waypoint = this.patrolWaypoints[this.currentWaypointIndex];
    const distance = Vector3.sub(waypoint, this.position).length();

    // If close to current waypoint, move to next
    if (distance < 1.5) {
      this.currentWaypointIndex = (this.currentWaypointIndex + 1) % this.patrolWaypoints.length;
      return this.patrolWaypoints[this.currentWaypointIndex];
    }

    return waypoint;
  }

  // Set patrol route from spawn points
  setPatrolRoute(waypoints: Vector3[]): void {
    this.patrolWaypoints = waypoints.map(w => w.clone());
    // Shuffle for variety
    for (let i = this.patrolWaypoints.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.patrolWaypoints[i], this.patrolWaypoints[j]] =
        [this.patrolWaypoints[j], this.patrolWaypoints[i]];
    }
  }

  // Check if another player is an enemy
  isEnemy(other: Player): boolean {
    // Same entity check
    if (other === this) return false;

    // Use team manager for team mode
    const teamManager = getTeamManager();
    return teamManager.areEnemies(this.name, other.name);
  }

  // Check if another player is a teammate
  isTeammate(other: Player): boolean {
    if (other === this) return false;
    const teamManager = getTeamManager();
    return teamManager.areTeammates(this.name, other.name);
  }

  // Make buy decision based on money and current loadout
  decidePurchase(): string | null {
    const money = this.economy.getMoney();

    // Check if we already have a primary weapon (slot 1)
    const hasPrimary = this.weapons.has(1);

    // Get buyable weapons sorted by cost descending
    const weapons = getBuyableWeapons()
      .filter(w => w.slot === 1) // Only primary weapons
      .sort((a, b) => b.cost - a.cost);

    // Buy strategy based on difficulty
    if (!hasPrimary) {
      // Need a primary weapon
      // Hard bots: buy best affordable
      // Medium bots: buy mid-tier
      // Easy bots: random affordable weapon

      let candidates: WeaponDef[];

      switch (this.botConfig.difficulty) {
        case 'hard':
          // Buy the best weapon we can afford
          candidates = weapons.filter(w => w.cost <= money);
          break;

        case 'medium':
          // Prefer mid-tier weapons (rifle, shotgun)
          candidates = weapons.filter(w => w.cost <= money && w.cost <= 3000);
          if (candidates.length === 0) {
            candidates = weapons.filter(w => w.cost <= money);
          }
          break;

        case 'easy':
        default:
          // Random affordable weapon, prefer cheaper
          candidates = weapons.filter(w => w.cost <= money && w.cost <= 1500);
          if (candidates.length === 0) {
            candidates = weapons.filter(w => w.cost <= money);
          }
          break;
      }

      if (candidates.length > 0) {
        // Pick from candidates (favor better weapons for harder bots)
        const index = this.botConfig.difficulty === 'hard' ? 0 :
                      Math.floor(Math.random() * candidates.length);
        return candidates[index].name.toLowerCase();
      }
    }

    return null; // No purchase
  }

  // Execute buy decision
  executeBuyPhase(): void {
    const weaponToBuy = this.decidePurchase();
    if (weaponToBuy) {
      this.buyWeapon(weaponToBuy);
    }
  }
}
