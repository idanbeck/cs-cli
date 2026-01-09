// GameLoop - Fixed timestep game loop with accumulator-based physics
// Separates game logic/physics from rendering for consistent gameplay

/**
 * Fixed timestep game loop implementation.
 *
 * Physics runs at a fixed rate (20Hz = 50ms per tick) regardless of frame rate.
 * Rendering runs at variable rate, using interpolation for smooth visuals.
 *
 * Key concepts:
 * - accumulator: Tracks time that hasn't been simulated yet
 * - gameTime: Total simulated game time
 * - alpha: Interpolation factor for smooth rendering (0-1)
 */

export const PHYSICS_TICK_RATE = 20;  // 20 Hz = 50ms per tick
export const PHYSICS_DT = 1 / PHYSICS_TICK_RATE;
const MAX_FRAME_TIME = 0.25;  // Prevent spiral of death (250ms max)

export interface InterpolatableState {
  prevX: number;
  prevY: number;
  prevZ: number;
  currX: number;
  currY: number;
  currZ: number;
  prevYaw: number;
  currYaw: number;
  prevPitch?: number;
  currPitch?: number;
}

export class GameLoop {
  private accumulator: number = 0;
  private gameTime: number = 0;
  private lastFrameTime: number = 0;
  private isRunning: boolean = false;

  // Callback for physics updates
  private physicsUpdate?: (dt: number) => void;

  // Debug stats
  private physicsTicksThisFrame: number = 0;
  private totalPhysicsTicks: number = 0;

  constructor() {
    this.lastFrameTime = performance.now() / 1000;
  }

  /**
   * Set the physics update callback.
   * This function will be called at a fixed rate (PHYSICS_TICK_RATE Hz).
   * @param callback Function that updates physics/game logic with fixed dt
   */
  setPhysicsCallback(callback: (dt: number) => void): void {
    this.physicsUpdate = callback;
  }

  /**
   * Start the game loop.
   */
  start(): void {
    this.isRunning = true;
    this.lastFrameTime = performance.now() / 1000;
    this.accumulator = 0;
  }

  /**
   * Stop the game loop.
   */
  stop(): void {
    this.isRunning = false;
  }

  /**
   * Process one frame of the game loop.
   * Call this from your render loop.
   *
   * @returns alpha - Interpolation factor for rendering (0-1)
   */
  tick(): number {
    if (!this.isRunning) {
      return 0;
    }

    const currentTime = performance.now() / 1000;
    let frameTime = currentTime - this.lastFrameTime;
    this.lastFrameTime = currentTime;

    // Clamp frame time to prevent spiral of death
    // (If game lags badly, don't try to catch up with too many physics ticks)
    if (frameTime > MAX_FRAME_TIME) {
      frameTime = MAX_FRAME_TIME;
    }

    this.accumulator += frameTime;
    this.physicsTicksThisFrame = 0;

    // Run fixed timestep physics updates
    while (this.accumulator >= PHYSICS_DT) {
      if (this.physicsUpdate) {
        this.physicsUpdate(PHYSICS_DT);
      }
      this.gameTime += PHYSICS_DT;
      this.accumulator -= PHYSICS_DT;
      this.physicsTicksThisFrame++;
      this.totalPhysicsTicks++;
    }

    // Return interpolation factor for smooth rendering
    // alpha = how far we are between the last physics tick and the next
    const alpha = this.accumulator / PHYSICS_DT;
    return alpha;
  }

  /**
   * Get the current game time (simulated time, not real time).
   */
  getGameTime(): number {
    return this.gameTime;
  }

  /**
   * Get how many physics ticks ran in the last frame.
   * Useful for debugging.
   */
  getPhysicsTicksThisFrame(): number {
    return this.physicsTicksThisFrame;
  }

  /**
   * Get total physics ticks since start.
   */
  getTotalPhysicsTicks(): number {
    return this.totalPhysicsTicks;
  }

  /**
   * Reset the game loop state.
   */
  reset(): void {
    this.accumulator = 0;
    this.gameTime = 0;
    this.lastFrameTime = performance.now() / 1000;
    this.physicsTicksThisFrame = 0;
    this.totalPhysicsTicks = 0;
  }

  /**
   * Get the fixed physics timestep (dt).
   */
  getPhysicsDt(): number {
    return PHYSICS_DT;
  }

  /**
   * Get the physics tick rate in Hz.
   */
  getPhysicsTickRate(): number {
    return PHYSICS_TICK_RATE;
  }
}

/**
 * Interpolate between previous and current state for smooth rendering.
 *
 * @param prev Previous state value
 * @param curr Current state value
 * @param alpha Interpolation factor (0-1)
 * @returns Interpolated value
 */
export function lerp(prev: number, curr: number, alpha: number): number {
  return prev + (curr - prev) * alpha;
}

/**
 * Interpolate angles (handles wraparound at 2*PI).
 *
 * @param prev Previous angle in radians
 * @param curr Current angle in radians
 * @param alpha Interpolation factor (0-1)
 * @returns Interpolated angle
 */
export function lerpAngle(prev: number, curr: number, alpha: number): number {
  // Find the shortest path around the circle
  let delta = curr - prev;

  // Normalize delta to -PI to PI
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;

  return prev + delta * alpha;
}

/**
 * Get interpolated position from an interpolatable state.
 */
export function getInterpolatedPosition(
  state: InterpolatableState,
  alpha: number
): { x: number; y: number; z: number } {
  return {
    x: lerp(state.prevX, state.currX, alpha),
    y: lerp(state.prevY, state.currY, alpha),
    z: lerp(state.prevZ, state.currZ, alpha),
  };
}

/**
 * Get interpolated yaw from an interpolatable state.
 */
export function getInterpolatedYaw(state: InterpolatableState, alpha: number): number {
  return lerpAngle(state.prevYaw, state.currYaw, alpha);
}

/**
 * Get interpolated pitch from an interpolatable state (if available).
 */
export function getInterpolatedPitch(state: InterpolatableState, alpha: number): number {
  if (state.prevPitch !== undefined && state.currPitch !== undefined) {
    return lerp(state.prevPitch, state.currPitch, alpha);
  }
  return state.currPitch ?? 0;
}

// Singleton instance
let gameLoopInstance: GameLoop | null = null;

export function getGameLoop(): GameLoop {
  if (!gameLoopInstance) {
    gameLoopInstance = new GameLoop();
  }
  return gameLoopInstance;
}

export function resetGameLoop(): void {
  if (gameLoopInstance) {
    gameLoopInstance.reset();
  }
}
