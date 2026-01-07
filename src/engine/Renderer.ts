import { Vector3 } from './math/Vector3.js';
import { Matrix4 } from './math/Matrix4.js';
import { Camera } from './Camera.js';
import { Mesh } from './Mesh.js';
import { Transform } from './Transform.js';
import { Framebuffer } from './Framebuffer.js';
import { DepthBuffer } from './DepthBuffer.js';
import { Rasterizer } from './Rasterizer.js';
import { Color, CURSOR_HIDE, CURSOR_SHOW, ALT_SCREEN_ON, ALT_SCREEN_OFF, RESET } from '../utils/Colors.js';
import { DecalPool, Decal } from '../game/Decal.js';
import { TracerPool, getTracerChar } from '../game/Tracer.js';
import { Bot } from '../ai/Bot.js';
import { KillEvent, ScoreEntry, GamePhase } from '../game/GameMode.js';
import { getGameConsole, ConsoleMessage } from '../ui/Console.js';
import { MainMenu, MainMenuState } from '../ui/MainMenu.js';
import { BuyMenu, BuyMenuItem } from '../ui/BuyMenu.js';
import { TeamId, TEAMS } from '../game/Team.js';
import { DroppedWeapon } from '../game/DroppedWeapon.js';

export interface RenderObject {
  mesh: Mesh;
  transform: Transform;
  visible?: boolean;
}

export interface RenderStats {
  triangles: number;
  vertices: number;
  objects: number;
  frameTime: number;
  fps: number;
}

export class Renderer {
  private framebuffer: Framebuffer;
  private prevFramebuffer: Framebuffer;
  private depthBuffer: DepthBuffer;
  private rasterizer: Rasterizer;

  private width: number;
  private height: number;

  private objects: RenderObject[] = [];
  private camera: Camera;

  private clearColor: Color = new Color(135, 206, 235); // Sky blue
  private lastFrameTime: number = 0;
  private frameCount: number = 0;
  private fpsUpdateInterval: number = 500;
  private lastFpsUpdate: number = 0;
  private currentFps: number = 0;

  public enableDifferentialRendering: boolean = true;
  public showStats: boolean = false;
  public showCrosshair: boolean = true;
  public showHUD: boolean = true;

  // HUD state
  private hudData: {
    health: number;
    armor: number;
    ammo: number;
    reserveAmmo: number;
    weaponName: string;
    isReloading: boolean;
  } | null = null;

  // Weapon sprite state
  private weaponSprite: string[] | null = null;
  private muzzleFlashUntil: number = 0;

  // Decal pool for bullet holes, etc.
  private decalPool: DecalPool = new DecalPool(64);

  // Tracer pool for bullet trails
  private tracerPool: TracerPool = new TracerPool(32);

  // Bots to render
  private bots: Bot[] = [];

  // Game state display
  private killFeed: KillEvent[] = [];
  private scoreboard: ScoreEntry[] = [];
  private showScoreboard: boolean = false;
  private gamePhase: GamePhase = 'live';
  private gameTimer: string = '';
  private winner: string | null = null;
  private respawnCountdown: number = 0;
  private warmupCountdown: number = 0;
  private killLimit: number = 0;

  // Hit feedback
  private hitMarkerUntil: number = 0;
  private hitMarkerDuration: number = 150;

  // Damage direction indicator (angles in radians, 0 = front)
  private damageIndicators: { angle: number; until: number }[] = [];
  private damageIndicatorDuration: number = 500;

  // Death camera effect
  private deathCameraRoll: number = 0;
  private deathCameraY: number = 0;
  private isPlayerDead: boolean = false;

  // Team-based display data
  private playerTeam: TeamId = 'SPECTATOR';
  private tScore: number = 0;
  private ctScore: number = 0;
  private playerMoney: number = 0;
  private freezeTimeRemaining: number = 0;
  private roundNumber: number = 0;

  // Main menu state
  private mainMenu: MainMenu | null = null;
  private showMainMenu: boolean = false;

  // Buy menu state
  private buyMenu: BuyMenu | null = null;

  // Dropped weapons to render
  private droppedWeapons: DroppedWeapon[] = [];

  constructor(width?: number, height?: number) {
    // Get terminal size if not specified
    this.width = width || process.stdout.columns || 80;
    // Terminal characters are roughly 2:1 aspect ratio, so halve the rows
    this.height = height || Math.floor((process.stdout.rows || 24));

    this.framebuffer = new Framebuffer(this.width, this.height);
    this.prevFramebuffer = new Framebuffer(this.width, this.height);
    this.depthBuffer = new DepthBuffer(this.width, this.height);
    this.rasterizer = new Rasterizer(this.framebuffer, this.depthBuffer);

    // Set up camera with correct aspect ratio
    // Terminal characters are roughly 2x taller than wide
    // So if we have 100 columns x 50 rows, the visual aspect is roughly 100 / (50 * 2) = 1.0
    const aspect = this.width / (this.height * 2);
    this.camera = new Camera(75, aspect, 0.01, 100); // Near plane very close to avoid floor clipping
  }

  getWidth(): number {
    return this.width;
  }

  getHeight(): number {
    return this.height;
  }

  getCamera(): Camera {
    return this.camera;
  }

  setCamera(camera: Camera): void {
    this.camera = camera;
  }

  setClearColor(color: Color): void {
    this.clearColor = color;
  }

  addObject(object: RenderObject): void {
    this.objects.push(object);
  }

  removeObject(object: RenderObject): void {
    const index = this.objects.indexOf(object);
    if (index !== -1) {
      this.objects.splice(index, 1);
    }
  }

  clearObjects(): void {
    this.objects = [];
  }

  resize(width?: number, height?: number): void {
    this.width = width || process.stdout.columns || 80;
    this.height = height || Math.floor((process.stdout.rows || 24));

    this.framebuffer.resize(this.width, this.height);
    this.prevFramebuffer.resize(this.width, this.height);
    this.depthBuffer.resize(this.width, this.height);
    this.rasterizer.resize(this.framebuffer, this.depthBuffer);

    // Update camera aspect ratio
    const aspect = this.width / (this.height * 2);
    this.camera.setAspect(aspect);
  }

  private clear(): void {
    // Use full block for sky so it's visible (fg color is the sky)
    this.framebuffer.clear('█', this.clearColor, Color.black());
    this.depthBuffer.clear();
  }

  render(): RenderStats {
    const startTime = performance.now();

    // Swap buffers for differential rendering
    if (this.enableDifferentialRendering) {
      this.framebuffer.copyTo(this.prevFramebuffer);
    }

    // Clear buffers
    this.clear();

    // Get camera matrices
    const viewProjection = this.camera.viewProjectionMatrix;

    let totalTriangles = 0;
    let totalVertices = 0;
    let visibleObjects = 0;

    // Render all objects
    for (const obj of this.objects) {
      if (obj.visible === false) continue;

      visibleObjects++;
      totalTriangles += obj.mesh.triangles.length;
      totalVertices += obj.mesh.vertices.length;

      // Compute MVP matrix
      const modelMatrix = obj.transform.matrix;
      const mvpMatrix = Matrix4.multiply(viewProjection, modelMatrix);

      // Rasterize the mesh
      this.rasterizer.rasterizeMesh(obj.mesh, mvpMatrix, modelMatrix);
    }

    // Render decals (bullet holes, etc.)
    this.renderDecals(viewProjection);

    // Render bots as billboards
    this.renderBots(viewProjection);

    // Render bullet tracers
    this.renderTracers(viewProjection);

    // Draw stats overlay if enabled
    if (this.showStats) {
      this.drawStats(totalTriangles, totalVertices, visibleObjects);
    }

    // Draw crosshair at center
    if (this.showCrosshair) {
      this.drawCrosshair();
    }

    // Draw weapon sprite
    this.drawWeaponSprite();

    // Draw HUD if enabled and data is set
    if (this.showHUD && this.hudData) {
      this.drawHUD(
        this.hudData.health,
        this.hudData.armor,
        this.hudData.ammo,
        this.hudData.reserveAmmo,
        this.hudData.weaponName,
        this.hudData.isReloading
      );
    }

    // Draw game state UI elements
    this.drawGameTimer();
    this.drawKillFeed();

    // Draw hit marker (when player hits enemy)
    this.drawHitMarker();

    // Draw damage direction indicators
    this.drawDamageIndicators();

    // Draw death effect (red vignette when dead)
    this.drawDeathEffect();

    // Draw overlays (on top of everything)
    this.drawWarmupOverlay();
    this.drawRespawnOverlay();
    this.drawScoreboardOverlay();
    this.drawGameOverOverlay();
    this.drawFreezeTimeOverlay();
    this.drawBuyMenuOverlay();
    this.drawMainMenuOverlay();
    this.drawConsoleOverlay();

    // Output to terminal
    if (this.enableDifferentialRendering) {
      process.stdout.write(this.framebuffer.toDiffAnsiString(this.prevFramebuffer));
    } else {
      this.framebuffer.render();
    }

    // Calculate timing
    const endTime = performance.now();
    const frameTime = endTime - startTime;
    this.lastFrameTime = frameTime;
    this.frameCount++;

    // Update FPS counter
    if (endTime - this.lastFpsUpdate > this.fpsUpdateInterval) {
      this.currentFps = this.frameCount / ((endTime - this.lastFpsUpdate) / 1000);
      this.frameCount = 0;
      this.lastFpsUpdate = endTime;
    }

    return {
      triangles: totalTriangles,
      vertices: totalVertices,
      objects: visibleObjects,
      frameTime,
      fps: this.currentFps
    };
  }

  private drawStats(triangles: number, vertices: number, objects: number): void {
    const fg = Color.white();
    const bg = new Color(0, 0, 0, 0.7);

    const lines = [
      `FPS: ${this.currentFps.toFixed(1)}`,
      `Frame: ${this.lastFrameTime.toFixed(1)}ms`,
      `Tri: ${triangles}`,
      `Vert: ${vertices}`,
      `Obj: ${objects}`,
      `Res: ${this.width}x${this.height}`
    ];

    for (let i = 0; i < lines.length; i++) {
      this.framebuffer.drawText(1, 1 + i, lines[i], fg, bg);
    }
  }

  private drawCrosshair(): void {
    const centerX = Math.floor(this.width / 2);
    const centerY = Math.floor(this.height / 2);
    const fg = Color.white();
    const bg = new Color(0, 0, 0, 0); // Transparent background

    // Draw a simple + crosshair
    // Horizontal line
    this.framebuffer.setPixel(centerX - 2, centerY, '-', fg, bg);
    this.framebuffer.setPixel(centerX - 1, centerY, '-', fg, bg);
    this.framebuffer.setPixel(centerX, centerY, '+', fg, bg);
    this.framebuffer.setPixel(centerX + 1, centerY, '-', fg, bg);
    this.framebuffer.setPixel(centerX + 2, centerY, '-', fg, bg);

    // Vertical line (terminal chars are ~2:1, so use fewer)
    this.framebuffer.setPixel(centerX, centerY - 1, '|', fg, bg);
    this.framebuffer.setPixel(centerX, centerY + 1, '|', fg, bg);
  }

  // Set HUD data (will be drawn on next render)
  setHUD(health: number, armor: number, ammo: number, reserveAmmo: number, weaponName: string, isReloading: boolean): void {
    this.hudData = { health, armor, ammo, reserveAmmo, weaponName, isReloading };
  }

  // Set kill feed data
  setKillFeed(kills: KillEvent[]): void {
    this.killFeed = kills;
  }

  // Set scoreboard data
  setScoreboard(scores: ScoreEntry[]): void {
    this.scoreboard = scores;
  }

  // Toggle scoreboard visibility
  setShowScoreboard(show: boolean): void {
    this.showScoreboard = show;
  }

  // Set game phase and related data
  setGameState(
    phase: GamePhase,
    timer: string,
    killLimit: number,
    winner: string | null = null,
    respawnCountdown: number = 0,
    warmupCountdown: number = 0
  ): void {
    this.gamePhase = phase;
    this.gameTimer = timer;
    this.killLimit = killLimit;
    this.winner = winner;
    this.respawnCountdown = respawnCountdown;
    this.warmupCountdown = warmupCountdown;
  }

  // Trigger hit marker (when player hits an enemy)
  triggerHitMarker(): void {
    this.hitMarkerUntil = performance.now() + this.hitMarkerDuration;
    // Play hit sound (different from muzzle flash bell)
    process.stdout.write('\x1b[10;800]\x07\x1b[10;440]'); // Higher pitch beep
  }

  // Check if hit marker should be shown
  isHitMarkerActive(): boolean {
    return performance.now() < this.hitMarkerUntil;
  }

  // Add damage indicator from a direction (attackerPos is world position of attacker)
  addDamageIndicator(attackerPos: Vector3, playerPos: Vector3, playerYaw: number): void {
    // Calculate angle from player to attacker relative to player's facing direction
    const toAttacker = Vector3.sub(attackerPos, playerPos);
    const attackAngle = Math.atan2(-toAttacker.x, -toAttacker.z);
    const relativeAngle = attackAngle - playerYaw;

    this.damageIndicators.push({
      angle: relativeAngle,
      until: performance.now() + this.damageIndicatorDuration,
    });

    // Limit to 4 indicators
    if (this.damageIndicators.length > 4) {
      this.damageIndicators.shift();
    }
  }

  // Set player death state for camera effect
  setPlayerDead(isDead: boolean, deltaTime: number = 0): void {
    if (isDead && !this.isPlayerDead) {
      // Just died - start the topple
      this.deathCameraRoll = 0;
      this.deathCameraY = 0;
    }

    this.isPlayerDead = isDead;

    if (isDead) {
      // Animate the death camera roll (topple to the side)
      const targetRoll = Math.PI / 2; // 90 degrees
      const rollSpeed = 3; // radians per second
      this.deathCameraRoll = Math.min(targetRoll, this.deathCameraRoll + rollSpeed * deltaTime);

      // Drop camera Y
      const dropSpeed = 2; // units per second
      this.deathCameraY = Math.min(1.5, this.deathCameraY + dropSpeed * deltaTime);
    } else {
      this.deathCameraRoll = 0;
      this.deathCameraY = 0;
    }
  }

  // Get death camera roll for external use
  getDeathCameraRoll(): number {
    return this.deathCameraRoll;
  }

  getDeathCameraYDrop(): number {
    return this.deathCameraY;
  }

  // Set weapon sprite to display
  setWeaponSprite(sprite: string[]): void {
    this.weaponSprite = sprite;
  }

  // Trigger muzzle flash effect
  triggerMuzzleFlash(durationMs: number = 80): void {
    this.muzzleFlashUntil = performance.now() + durationMs;
    // Terminal bell for sound effect
    process.stdout.write('\x07');
  }

  // Check if muzzle flash is active
  isMuzzleFlashActive(): boolean {
    return performance.now() < this.muzzleFlashUntil;
  }

  // Spawn a bullet hole decal at the given position
  spawnBulletDecal(position: Vector3, normal: Vector3): void {
    this.decalPool.spawn(position, normal, 'bullet_hole');
  }

  // Get the decal pool (for external access if needed)
  getDecalPool(): DecalPool {
    return this.decalPool;
  }

  // Render all active decals as 3D points
  private renderDecals(viewProjection: Matrix4): void {
    const decals = this.decalPool.getActiveDecals();

    for (const decal of decals) {
      // Offset slightly along normal to prevent z-fighting
      const offsetPos = Vector3.add(decal.position, Vector3.scale(decal.normal, 0.02));

      // Get distance from camera (for culling and character selection)
      const toCam = Vector3.sub(offsetPos, this.camera.position);
      const distance = toCam.length();

      // Skip if too close (likely behind camera)
      if (distance < 0.1) continue;

      // Transform to NDC (transformPoint does perspective divide)
      const ndc = viewProjection.transformPoint(offsetPos);

      // Skip if outside screen (NDC ranges from -1 to 1)
      if (ndc.x < -1 || ndc.x > 1 || ndc.y < -1 || ndc.y > 1) continue;

      // Skip if behind camera (z > 1 means behind far plane, z < -1 means behind near)
      if (ndc.z < -1 || ndc.z > 1) continue;

      // Convert to screen coordinates
      const screenX = Math.floor((ndc.x + 1) * 0.5 * this.width);
      const screenY = Math.floor((1 - ndc.y) * 0.5 * this.height);

      // Clamp to screen bounds
      if (screenX < 0 || screenX >= this.width || screenY < 0 || screenY >= this.height) continue;

      // Depth test
      if (!this.depthBuffer.testAndSet(screenX, screenY, ndc.z)) continue;

      // Choose character based on distance
      const char = distance > 15 ? '·' : distance > 8 ? '•' : '○';

      // Draw the decal
      this.framebuffer.setPixel(screenX, screenY, char, decal.color, new Color(0, 0, 0, 0));
    }
  }

  // Spawn a bullet tracer from origin to endpoint
  spawnTracer(origin: Vector3, endpoint: Vector3, duration: number = 80): void {
    this.tracerPool.spawn(origin, endpoint, duration);
  }

  // Get the tracer pool
  getTracerPool(): TracerPool {
    return this.tracerPool;
  }

  // Render all active tracers as 3D lines with streak effect
  private renderTracers(viewProjection: Matrix4): void {
    const now = performance.now();
    this.tracerPool.update(now);

    const activeTracers = this.tracerPool.getActiveTracers(now);

    for (const { tracer, fade } of activeTracers) {
      // Transform both endpoints to NDC
      const ndcStart = viewProjection.transformPoint(tracer.origin);
      const ndcEnd = viewProjection.transformPoint(tracer.endpoint);

      // Skip if both points are behind camera
      if (ndcStart.z < -1 && ndcEnd.z < -1) continue;
      if (ndcStart.z > 1 && ndcEnd.z > 1) continue;

      // Convert to screen coordinates
      const x0 = Math.floor((ndcStart.x + 1) * 0.5 * this.width);
      const y0 = Math.floor((1 - ndcStart.y) * 0.5 * this.height);
      const x1 = Math.floor((ndcEnd.x + 1) * 0.5 * this.width);
      const y1 = Math.floor((1 - ndcEnd.y) * 0.5 * this.height);

      // Draw line using Bresenham's algorithm with streak effect
      this.drawTracerLine(x0, y0, ndcStart.z, x1, y1, ndcEnd.z, tracer.color, fade);
    }
  }

  // Draw a tracer line with streak/blur effect
  private drawTracerLine(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    color: Color, fade: number
  ): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const totalDist = Math.sqrt(dx * dx + dy * dy);
    if (totalDist < 1) return;

    // Number of points to draw along the line (high density for smooth streak)
    const numPoints = Math.ceil(totalDist * 1.5);

    for (let i = 0; i <= numPoints; i++) {
      const t = i / numPoints; // 0 = start (muzzle), 1 = end (hit)

      // Interpolate position along line
      const x = Math.floor(x0 + dx * t);
      const y = Math.floor(y0 + dy * t);

      // Check bounds
      if (x < 0 || x >= this.width || y < 0 || y >= this.height) continue;

      // Interpolate depth
      const z = z0 + (z1 - z0) * t;
      if (z < -1 || z > 1) continue;

      // Intensity calculation:
      // - Brighter toward the END (hit point) - this is the bullet tip
      // - Fades from tail to tip
      // - Also fades over time (fade parameter)
      const tipIntensity = t; // 0 at muzzle, 1 at hit
      const intensity = (0.3 + tipIntensity * 0.7) * fade;

      // Core (bright center) vs glow (dimmer sides)
      // Draw the main tracer pixel
      const coreChar = this.getTracerCharForIntensity(intensity, dx, dy);
      const coreColor = new Color(
        Math.floor(255 * intensity),
        Math.floor(255 * intensity * 0.9),
        Math.floor(150 * intensity)
      );
      this.framebuffer.setPixel(x, y, coreChar, coreColor, new Color(0, 0, 0, 0));

      // Add glow effect - draw dimmer pixels adjacent to the main line
      // Only for high-intensity parts (near the tip)
      if (intensity > 0.5) {
        const glowIntensity = intensity * 0.4;
        const glowColor = new Color(
          Math.floor(255 * glowIntensity),
          Math.floor(200 * glowIntensity),
          Math.floor(100 * glowIntensity)
        );
        const glowChar = '░';

        // Perpendicular glow (thickens the line)
        if (Math.abs(dx) > Math.abs(dy)) {
          // More horizontal - add glow above/below
          if (y - 1 >= 0) this.framebuffer.setPixel(x, y - 1, glowChar, glowColor, new Color(0, 0, 0, 0));
          if (y + 1 < this.height) this.framebuffer.setPixel(x, y + 1, glowChar, glowColor, new Color(0, 0, 0, 0));
        } else {
          // More vertical - add glow left/right
          if (x - 1 >= 0) this.framebuffer.setPixel(x - 1, y, glowChar, glowColor, new Color(0, 0, 0, 0));
          if (x + 1 < this.width) this.framebuffer.setPixel(x + 1, y, glowChar, glowColor, new Color(0, 0, 0, 0));
        }
      }
    }
  }

  // Get appropriate character for tracer based on intensity and direction
  private getTracerCharForIntensity(intensity: number, dx: number, dy: number): string {
    // Bright tip gets solid block
    if (intensity > 0.85) return '█';
    if (intensity > 0.7) return '▓';
    if (intensity > 0.5) return '▒';

    // Dimmer parts use directional characters
    const angle = Math.atan2(dy, dx);
    const absAngle = Math.abs(angle);

    if (absAngle < Math.PI / 6 || absAngle > 5 * Math.PI / 6) {
      return '─'; // Horizontal
    } else if (absAngle > Math.PI / 3 && absAngle < 2 * Math.PI / 3) {
      return '│'; // Vertical
    } else if ((angle > 0 && angle < Math.PI / 2) || (angle < -Math.PI / 2)) {
      return '\\'; // Diagonal down-right or up-left
    } else {
      return '/'; // Diagonal up-right or down-left
    }
  }

  // Set bots to render
  setBots(bots: Bot[]): void {
    this.bots = bots;
  }

  // Render bots as solid rectangular hitboxes
  private renderBots(viewProjection: Matrix4): void {
    for (const bot of this.bots) {
      // Bot hitbox dimensions (in world units)
      const hitboxWidth = 0.8;   // ~0.4 radius * 2
      const hitboxHeight = 1.8;  // Full height

      // Get bot feet position and calculate top/bottom
      const feetY = bot.position.y - bot.config.eyeHeight;
      const headY = feetY + hitboxHeight;
      const centerY = (feetY + headY) / 2;

      // Bot center position
      const botCenter = new Vector3(bot.position.x, centerY, bot.position.z);

      // Check distance from camera
      const toBot = Vector3.sub(botCenter, this.camera.position);
      const distance = toBot.length();

      // Skip if too close or too far
      if (distance < 0.5 || distance > 60) continue;

      // Project the four corners of the hitbox to screen space
      // (billboard facing camera)
      const cameraRight = this.camera.getRight();

      // Calculate corner positions in world space
      const halfWidth = hitboxWidth / 2;
      const topLeft = new Vector3(
        bot.position.x - cameraRight.x * halfWidth,
        headY,
        bot.position.z - cameraRight.z * halfWidth
      );
      const topRight = new Vector3(
        bot.position.x + cameraRight.x * halfWidth,
        headY,
        bot.position.z + cameraRight.z * halfWidth
      );
      const bottomLeft = new Vector3(
        bot.position.x - cameraRight.x * halfWidth,
        feetY,
        bot.position.z - cameraRight.z * halfWidth
      );
      const bottomRight = new Vector3(
        bot.position.x + cameraRight.x * halfWidth,
        feetY,
        bot.position.z + cameraRight.z * halfWidth
      );

      // Transform corners to NDC
      const ndcTL = viewProjection.transformPoint(topLeft);
      const ndcTR = viewProjection.transformPoint(topRight);
      const ndcBL = viewProjection.transformPoint(bottomLeft);
      const ndcBR = viewProjection.transformPoint(bottomRight);

      // Skip if behind camera
      if (ndcTL.z < -1 && ndcTR.z < -1 && ndcBL.z < -1 && ndcBR.z < -1) continue;
      if (ndcTL.z > 1 && ndcTR.z > 1 && ndcBL.z > 1 && ndcBR.z > 1) continue;

      // Convert to screen coordinates
      const screenTLx = Math.floor((ndcTL.x + 1) * 0.5 * this.width);
      const screenTLy = Math.floor((1 - ndcTL.y) * 0.5 * this.height);
      const screenBRx = Math.floor((ndcBR.x + 1) * 0.5 * this.width);
      const screenBRy = Math.floor((1 - ndcBR.y) * 0.5 * this.height);

      // Calculate bounding box on screen
      const minX = Math.max(0, Math.min(screenTLx, screenBRx) - 1);
      const maxX = Math.min(this.width - 1, Math.max(screenTLx, screenBRx) + 1);
      const minY = Math.max(0, Math.min(screenTLy, screenBRy));
      const maxY = Math.min(this.height - 1, Math.max(screenTLy, screenBRy));

      // Use center depth for depth testing
      const ndcCenter = viewProjection.transformPoint(botCenter);
      const depth = ndcCenter.z;

      // Color based on state and health
      let bodyColor: Color;
      let outlineColor: Color;
      if (!bot.isAlive) {
        bodyColor = new Color(80, 80, 80);
        outlineColor = new Color(60, 60, 60);
      } else if (bot.state === 'attack') {
        bodyColor = new Color(200, 50, 50);
        outlineColor = new Color(255, 100, 100);
      } else if (bot.health < 50) {
        bodyColor = new Color(200, 150, 50);
        outlineColor = new Color(255, 200, 100);
      } else {
        bodyColor = new Color(180, 60, 60);
        outlineColor = new Color(255, 80, 80);
      }

      // Draw filled hitbox rectangle
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          // Depth test
          if (!this.depthBuffer.testAndSet(x, y, depth)) continue;

          // Check if on border (outline)
          const isOutline = x === minX || x === maxX || y === minY || y === maxY;

          // Choose character based on position
          let char: string;
          let color: Color;

          if (isOutline) {
            // Border
            if (y === minY && x === minX) char = '┌';
            else if (y === minY && x === maxX) char = '┐';
            else if (y === maxY && x === minX) char = '└';
            else if (y === maxY && x === maxX) char = '┘';
            else if (y === minY || y === maxY) char = '─';
            else char = '│';
            color = outlineColor;
          } else {
            // Fill - use shading based on "depth" within hitbox for 3D effect
            const relY = (y - minY) / Math.max(1, maxY - minY);
            if (relY < 0.15) {
              char = '░'; // Head area - lighter
            } else if (relY < 0.5) {
              char = '▒'; // Torso
            } else {
              char = '░'; // Legs
            }
            color = bodyColor;
          }

          this.framebuffer.setPixel(x, y, char, color, new Color(0, 0, 0, 0));
        }
      }

      // Draw name tag above hitbox
      if (bot.isAlive) {
        const nameY = minY - 2;
        if (nameY >= 0) {
          const name = bot.name.substring(0, 12);
          const nameX = Math.floor((minX + maxX) / 2) - Math.floor(name.length / 2);
          this.framebuffer.drawText(nameX, nameY, name, Color.white(), new Color(0, 0, 0, 0.7));
        }
      }

      // Always draw health bar (above name tag)
      if (bot.isAlive) {
        const barY = minY - 1;
        if (barY >= 0) {
          const healthPercent = bot.health / 100;
          const barWidth = Math.max(5, maxX - minX + 1);
          const filledWidth = Math.floor(barWidth * healthPercent);
          const barStartX = Math.floor((minX + maxX) / 2) - Math.floor(barWidth / 2);

          for (let i = 0; i < barWidth; i++) {
            const x = barStartX + i;
            if (x < 0 || x >= this.width) continue;

            const char = i < filledWidth ? '█' : '░';
            const barColor = healthPercent > 0.5
              ? new Color(100, 255, 100)
              : healthPercent > 0.25
                ? new Color(255, 255, 100)
                : new Color(255, 100, 100);

            this.framebuffer.setPixel(x, barY, char, barColor, new Color(0, 0, 0, 0));
          }
        }
      }
    }
  }

  // Draw weapon sprite at bottom center of screen
  private drawWeaponSprite(): void {
    if (!this.weaponSprite || this.weaponSprite.length === 0) return;

    const sprite = this.weaponSprite;
    const spriteHeight = sprite.length;

    // Find max width of sprite
    let maxWidth = 0;
    for (const line of sprite) {
      maxWidth = Math.max(maxWidth, line.length);
    }

    // Position at bottom RIGHT (where the gun is held, matching tracer origin)
    const startX = Math.floor(this.width * 0.55); // Right of center
    const startY = this.height - spriteHeight - 3; // Above HUD

    // Muzzle flash color effect
    const isFlash = this.isMuzzleFlashActive();
    const fg = isFlash ? new Color(255, 200, 50) : new Color(180, 180, 180);
    const bg = new Color(0, 0, 0, 0);

    for (let i = 0; i < spriteHeight; i++) {
      const line = sprite[i];
      for (let j = 0; j < line.length; j++) {
        const char = line[j];
        if (char !== ' ') {
          const x = startX + j;
          const y = startY + i;
          if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
            // Flash effect for muzzle flash characters
            const charColor = (isFlash && (char === '*' || char === '/' || char === '\\' || char === '|'))
              ? new Color(255, 255, 100)
              : fg;
            this.framebuffer.setPixel(x, y, char, charColor, bg);
          }
        }
      }
    }
  }

  // Draw HUD overlay (health, ammo, weapon)
  private drawHUD(health: number, armor: number, ammo: number, reserveAmmo: number, weaponName: string, isReloading: boolean): void {
    const fg = Color.white();
    const bgDark = new Color(0, 0, 0, 0.8);

    // Health (bottom left)
    const healthColor = health > 50 ? Color.white() : (health > 25 ? new Color(255, 255, 0) : new Color(255, 0, 0));
    this.framebuffer.drawText(2, this.height - 2, `HP: ${health}`, healthColor, bgDark);
    if (armor > 0) {
      this.framebuffer.drawText(2, this.height - 3, `AR: ${armor}`, new Color(100, 150, 255), bgDark);
    }

    // Money (bottom left, above health)
    if (this.playerMoney > 0) {
      const moneyText = `$${this.playerMoney}`;
      const moneyColor = new Color(100, 255, 100);
      this.framebuffer.drawText(2, this.height - 4, moneyText, moneyColor, bgDark);
    }

    // Ammo (bottom right)
    const ammoText = isReloading ? 'RELOADING...' : `${ammo} / ${reserveAmmo}`;
    const ammoColor = isReloading ? new Color(255, 200, 0) : (ammo > 0 ? Color.white() : new Color(255, 0, 0));
    this.framebuffer.drawText(this.width - ammoText.length - 2, this.height - 2, ammoText, ammoColor, bgDark);

    // Weapon name (bottom center)
    const weaponX = Math.floor((this.width - weaponName.length) / 2);
    this.framebuffer.drawText(weaponX, this.height - 2, weaponName, fg, bgDark);

    // Team scores (top center) if in team mode
    if (this.tScore > 0 || this.ctScore > 0 || this.roundNumber > 0) {
      this.drawTeamScores();
    }
  }

  // Draw team scores at top center
  private drawTeamScores(): void {
    const bgDark = new Color(0, 0, 0, 0.8);
    const tColor = new Color(255, 180, 80);  // Orange for T
    const ctColor = new Color(100, 150, 255); // Blue for CT

    // Format: T 3 : 5 CT  Round 8
    const scoreText = `T ${this.tScore} : ${this.ctScore} CT`;
    const roundText = `Round ${this.roundNumber}`;
    const fullText = `${scoreText}  ${roundText}`;

    const startX = Math.floor((this.width - fullText.length) / 2);

    // Draw with colors
    let x = startX;
    this.framebuffer.drawText(x, 1, 'T', tColor, bgDark);
    x += 2;
    this.framebuffer.drawText(x, 1, `${this.tScore}`, this.playerTeam === 'T' ? new Color(255, 255, 100) : tColor, bgDark);
    x += this.tScore.toString().length + 1;
    this.framebuffer.drawText(x, 1, ':', Color.white(), bgDark);
    x += 2;
    this.framebuffer.drawText(x, 1, `${this.ctScore}`, this.playerTeam === 'CT' ? new Color(255, 255, 100) : ctColor, bgDark);
    x += this.ctScore.toString().length + 1;
    this.framebuffer.drawText(x, 1, 'CT', ctColor, bgDark);
    x += 4;
    this.framebuffer.drawText(x, 1, roundText, new Color(200, 200, 200), bgDark);
  }

  // Draw kill feed (top right corner)
  private drawKillFeed(): void {
    if (this.killFeed.length === 0) return;

    const bgDark = new Color(0, 0, 0, 0.7);
    const killerColor = new Color(255, 100, 100);
    const victimColor = new Color(100, 150, 255);
    const weaponColor = new Color(200, 200, 200);
    const headshotColor = new Color(255, 215, 0); // Gold for headshot

    for (let i = 0; i < this.killFeed.length; i++) {
      const kill = this.killFeed[i];
      const hsMarker = kill.headshot ? ' [HS]' : '';
      const text = `${kill.killer} [${kill.weapon}] ${kill.victim}${hsMarker}`;
      const x = this.width - text.length - 2;
      const y = 1 + i;

      // Draw with color coding
      let xPos = x;
      this.framebuffer.drawText(xPos, y, kill.killer, killerColor, bgDark);
      xPos += kill.killer.length;
      this.framebuffer.drawText(xPos, y, ` [${kill.weapon}] `, weaponColor, bgDark);
      xPos += kill.weapon.length + 4;
      this.framebuffer.drawText(xPos, y, kill.victim, victimColor, bgDark);
      if (kill.headshot) {
        xPos += kill.victim.length;
        this.framebuffer.drawText(xPos, y, ' [HS]', headshotColor, bgDark);
      }
    }
  }

  // Draw hit marker (X at crosshair when hitting enemy)
  private drawHitMarker(): void {
    if (!this.isHitMarkerActive()) return;

    const centerX = Math.floor(this.width / 2);
    const centerY = Math.floor(this.height / 2);
    const hitColor = new Color(255, 50, 50);

    // Draw X pattern around crosshair
    this.framebuffer.setPixel(centerX - 2, centerY - 1, '\\', hitColor, new Color(0, 0, 0, 0));
    this.framebuffer.setPixel(centerX + 2, centerY - 1, '/', hitColor, new Color(0, 0, 0, 0));
    this.framebuffer.setPixel(centerX - 2, centerY + 1, '/', hitColor, new Color(0, 0, 0, 0));
    this.framebuffer.setPixel(centerX + 2, centerY + 1, '\\', hitColor, new Color(0, 0, 0, 0));
  }

  // Draw damage direction indicators (red flashes on screen edges)
  private drawDamageIndicators(): void {
    const now = performance.now();

    // Clean up expired indicators
    this.damageIndicators = this.damageIndicators.filter(ind => now < ind.until);

    if (this.damageIndicators.length === 0) return;

    const damageColor = new Color(255, 0, 0);

    for (const indicator of this.damageIndicators) {
      // Calculate fade based on time remaining
      const remaining = indicator.until - now;
      const fade = Math.min(1, remaining / this.damageIndicatorDuration);
      const fadeColor = new Color(
        Math.floor(255 * fade),
        0,
        0
      );

      // Normalize angle to -PI to PI
      let angle = indicator.angle;
      while (angle > Math.PI) angle -= 2 * Math.PI;
      while (angle < -Math.PI) angle += 2 * Math.PI;

      // Determine which edge to flash based on angle
      // 0 = in front (top), PI/-PI = behind (bottom), PI/2 = right, -PI/2 = left
      const absAngle = Math.abs(angle);

      // Draw indicator bars on appropriate edge
      const barLength = Math.floor(this.width * 0.3);
      const barHeight = 2;

      if (absAngle < Math.PI / 4) {
        // Front (top of screen)
        const startX = Math.floor((this.width - barLength) / 2);
        for (let i = 0; i < barLength; i++) {
          for (let j = 0; j < barHeight; j++) {
            this.framebuffer.setPixel(startX + i, j, '▄', fadeColor, new Color(0, 0, 0, 0));
          }
        }
      } else if (absAngle > 3 * Math.PI / 4) {
        // Behind (bottom of screen)
        const startX = Math.floor((this.width - barLength) / 2);
        const startY = this.height - barHeight;
        for (let i = 0; i < barLength; i++) {
          for (let j = 0; j < barHeight; j++) {
            this.framebuffer.setPixel(startX + i, startY + j, '▀', fadeColor, new Color(0, 0, 0, 0));
          }
        }
      } else if (angle > 0) {
        // Right side
        const startY = Math.floor((this.height - barLength / 3) / 2);
        const startX = this.width - barHeight;
        for (let i = 0; i < barLength / 3; i++) {
          for (let j = 0; j < barHeight; j++) {
            if (startY + i < this.height) {
              this.framebuffer.setPixel(startX + j, startY + i, '█', fadeColor, new Color(0, 0, 0, 0));
            }
          }
        }
      } else {
        // Left side
        const startY = Math.floor((this.height - barLength / 3) / 2);
        for (let i = 0; i < barLength / 3; i++) {
          for (let j = 0; j < barHeight; j++) {
            if (startY + i < this.height) {
              this.framebuffer.setPixel(j, startY + i, '█', fadeColor, new Color(0, 0, 0, 0));
            }
          }
        }
      }
    }
  }

  // Draw death screen effect (red tint and "YOU DIED" text)
  private drawDeathEffect(): void {
    if (!this.isPlayerDead) return;

    // Add red vignette effect around edges
    const vignetteColor = new Color(100, 0, 0);
    const edgeWidth = 3;

    // Top and bottom edges
    for (let x = 0; x < this.width; x++) {
      for (let y = 0; y < edgeWidth; y++) {
        this.framebuffer.setPixel(x, y, '░', vignetteColor, new Color(0, 0, 0, 0));
        this.framebuffer.setPixel(x, this.height - 1 - y, '░', vignetteColor, new Color(0, 0, 0, 0));
      }
    }

    // Left and right edges
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < edgeWidth; x++) {
        this.framebuffer.setPixel(x, y, '░', vignetteColor, new Color(0, 0, 0, 0));
        this.framebuffer.setPixel(this.width - 1 - x, y, '░', vignetteColor, new Color(0, 0, 0, 0));
      }
    }
  }

  // Draw game timer (top center)
  private drawGameTimer(): void {
    const fg = Color.white();
    const bgDark = new Color(0, 0, 0, 0.7);

    // Timer display
    const timerX = Math.floor((this.width - this.gameTimer.length) / 2);
    this.framebuffer.drawText(timerX, 0, this.gameTimer, fg, bgDark);

    // Kill limit if set
    if (this.killLimit > 0) {
      const limitText = `First to ${this.killLimit}`;
      const limitX = Math.floor((this.width - limitText.length) / 2);
      this.framebuffer.drawText(limitX, 1, limitText, new Color(200, 200, 200), bgDark);
    }
  }

  // Draw scoreboard overlay (covers center of screen)
  private drawScoreboardOverlay(): void {
    if (!this.showScoreboard || this.scoreboard.length === 0) return;

    const bgDark = new Color(0, 0, 0, 0.9);
    const headerColor = new Color(255, 215, 0); // Gold
    const playerColor = new Color(100, 255, 100); // Green for player
    const botColor = new Color(200, 200, 200); // Gray for bots
    const deadColor = new Color(150, 150, 150);

    // Calculate dimensions
    const boxWidth = 40;
    const boxHeight = Math.min(this.scoreboard.length + 4, this.height - 4);
    const startX = Math.floor((this.width - boxWidth) / 2);
    const startY = Math.floor((this.height - boxHeight) / 2);

    // Draw background
    for (let y = startY; y < startY + boxHeight; y++) {
      for (let x = startX; x < startX + boxWidth; x++) {
        if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
          this.framebuffer.setPixel(x, y, ' ', Color.white(), bgDark);
        }
      }
    }

    // Draw header
    const header = '   SCOREBOARD';
    this.framebuffer.drawText(startX + 2, startY + 1, header, headerColor, bgDark);

    const columnHeader = 'Name                 K    D';
    this.framebuffer.drawText(startX + 2, startY + 2, columnHeader, new Color(150, 150, 150), bgDark);

    // Draw separator
    const separator = '-'.repeat(boxWidth - 4);
    this.framebuffer.drawText(startX + 2, startY + 3, separator, new Color(100, 100, 100), bgDark);

    // Draw entries
    for (let i = 0; i < this.scoreboard.length && i < boxHeight - 5; i++) {
      const entry = this.scoreboard[i];
      const y = startY + 4 + i;

      // Format: rank, name, kills, deaths
      const rank = `${i + 1}.`;
      const name = entry.name.substring(0, 16).padEnd(16);
      const kills = entry.kills.toString().padStart(4);
      const deaths = entry.deaths.toString().padStart(4);

      const line = `${rank.padEnd(3)} ${name} ${kills} ${deaths}`;

      // Choose color based on player/bot and alive status
      let color: Color;
      if (entry.isPlayer) {
        color = entry.isAlive ? playerColor : new Color(100, 200, 100);
      } else {
        color = entry.isAlive ? botColor : deadColor;
      }

      this.framebuffer.drawText(startX + 2, y, line, color, bgDark);
    }
  }

  // Draw warmup countdown
  private drawWarmupOverlay(): void {
    if (this.gamePhase !== 'warmup' || this.warmupCountdown <= 0) return;

    const centerX = Math.floor(this.width / 2);
    const centerY = Math.floor(this.height / 2);
    const bgDark = new Color(0, 0, 0, 0.8);

    const title = 'WARMUP';
    const countdown = `Game starts in ${this.warmupCountdown}...`;

    this.framebuffer.drawText(centerX - Math.floor(title.length / 2), centerY - 1, title, new Color(255, 255, 100), bgDark);
    this.framebuffer.drawText(centerX - Math.floor(countdown.length / 2), centerY + 1, countdown, Color.white(), bgDark);
  }

  // Draw respawn countdown
  private drawRespawnOverlay(): void {
    if (this.respawnCountdown <= 0) return;

    const centerX = Math.floor(this.width / 2);
    const centerY = Math.floor(this.height / 2);
    const bgDark = new Color(0, 0, 0, 0.8);

    const title = 'YOU DIED';
    const countdown = `Respawning in ${this.respawnCountdown}...`;

    this.framebuffer.drawText(centerX - Math.floor(title.length / 2), centerY - 1, title, new Color(255, 50, 50), bgDark);
    this.framebuffer.drawText(centerX - Math.floor(countdown.length / 2), centerY + 1, countdown, Color.white(), bgDark);
  }

  // Draw game over screen
  private drawGameOverOverlay(): void {
    if (this.gamePhase !== 'match_end') return;

    const centerX = Math.floor(this.width / 2);
    const centerY = Math.floor(this.height / 2);
    const bgDark = new Color(0, 0, 0, 0.9);

    // Draw background box
    const boxWidth = 30;
    const boxHeight = 8;
    const startX = centerX - Math.floor(boxWidth / 2);
    const startY = centerY - Math.floor(boxHeight / 2);

    for (let y = startY; y < startY + boxHeight; y++) {
      for (let x = startX; x < startX + boxWidth; x++) {
        if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
          this.framebuffer.setPixel(x, y, ' ', Color.white(), bgDark);
        }
      }
    }

    const title = 'GAME OVER';
    const winnerText = this.winner ? `Winner: ${this.winner}` : 'Time ran out!';
    const restartText = 'Press N for new game';
    const quitText = 'Press Q to quit';

    this.framebuffer.drawText(centerX - Math.floor(title.length / 2), centerY - 2, title, new Color(255, 215, 0), bgDark);
    this.framebuffer.drawText(centerX - Math.floor(winnerText.length / 2), centerY, winnerText, Color.white(), bgDark);
    this.framebuffer.drawText(centerX - Math.floor(restartText.length / 2), centerY + 2, restartText, new Color(100, 255, 100), bgDark);
    this.framebuffer.drawText(centerX - Math.floor(quitText.length / 2), centerY + 3, quitText, new Color(200, 200, 200), bgDark);
  }

  // Draw debug console overlay
  private drawConsoleOverlay(): void {
    const gameConsole = getGameConsole();
    if (!gameConsole.getIsOpen()) return;

    const consoleHeight = Math.floor(this.height * 0.4); // 40% of screen
    const bgDark = new Color(30, 30, 35);
    const borderColor = new Color(100, 100, 110);

    // Draw background
    for (let y = 0; y < consoleHeight; y++) {
      for (let x = 0; x < this.width; x++) {
        this.framebuffer.setPixel(x, y, ' ', Color.white(), bgDark);
      }
    }

    // Draw top border
    for (let x = 0; x < this.width; x++) {
      this.framebuffer.setPixel(x, 0, '─', borderColor, bgDark);
    }

    // Draw title
    const title = ' CS-CLI Console (~ to close, PgUp/PgDn to scroll) ';
    this.framebuffer.drawText(2, 0, title, new Color(255, 220, 100), bgDark);

    // Draw separator after title
    for (let x = 0; x < this.width; x++) {
      this.framebuffer.setPixel(x, 1, '─', borderColor, bgDark);
    }

    // Draw messages
    const visibleMessages = gameConsole.getVisibleMessages(consoleHeight - 4);
    let y = 2;
    for (const msg of visibleMessages) {
      let color: Color;
      let prefix = '';
      switch (msg.type) {
        case 'error':
          color = new Color(255, 100, 100);
          prefix = '[ERROR] ';
          break;
        case 'warn':
          color = new Color(255, 220, 100);
          prefix = '[WARN] ';
          break;
        case 'debug':
          color = new Color(100, 200, 255);
          prefix = '[DEBUG] ';
          break;
        case 'command':
          color = new Color(100, 255, 100);
          break;
        case 'result':
          color = new Color(200, 200, 200);
          break;
        default:
          color = Color.white();
      }

      const text = prefix + msg.text;
      const truncated = text.length > this.width - 2 ? text.slice(0, this.width - 5) + '...' : text;
      this.framebuffer.drawText(1, y, truncated, color, bgDark);
      y++;
      if (y >= consoleHeight - 2) break;
    }

    // Draw input line separator
    for (let x = 0; x < this.width; x++) {
      this.framebuffer.setPixel(x, consoleHeight - 2, '─', borderColor, bgDark);
    }

    // Draw input prompt and buffer
    const prompt = '> ';
    const inputBuffer = gameConsole.getInputBuffer();
    const maxInputLen = this.width - 4;
    const displayInput = inputBuffer.slice(-maxInputLen);
    this.framebuffer.drawText(1, consoleHeight - 1, prompt, new Color(100, 255, 100), bgDark);
    this.framebuffer.drawText(3, consoleHeight - 1, displayInput, Color.white(), bgDark);
    // Draw cursor
    this.framebuffer.setPixel(3 + displayInput.length, consoleHeight - 1, '█', new Color(100, 255, 100), bgDark);
  }

  // Draw freeze time overlay (during buy phase)
  private drawFreezeTimeOverlay(): void {
    if (this.freezeTimeRemaining <= 0) return;
    if (this.showMainMenu) return; // Don't show when main menu is open

    const bgDark = new Color(0, 0, 0, 0.8);
    const centerX = Math.floor(this.width / 2);

    // Draw freeze time countdown
    const timeText = `FREEZE TIME: ${this.freezeTimeRemaining}s`;
    const buyHint = 'Press B to open Buy Menu';

    this.framebuffer.drawText(centerX - Math.floor(timeText.length / 2), 3, timeText, new Color(100, 200, 255), bgDark);
    this.framebuffer.drawText(centerX - Math.floor(buyHint.length / 2), 4, buyHint, new Color(200, 200, 200), bgDark);
  }

  // Draw buy menu overlay
  private drawBuyMenuOverlay(): void {
    if (!this.buyMenu || !this.buyMenu.isOpen()) return;

    const bgDark = new Color(20, 20, 30);
    const borderColor = new Color(100, 100, 150);
    const selectedColor = new Color(255, 215, 0);  // Gold
    const affordColor = new Color(100, 255, 100);  // Green
    const cantAffordColor = new Color(150, 150, 150);  // Gray
    const ownedColor = new Color(100, 200, 255);  // Cyan

    // Menu dimensions
    const menuWidth = 50;
    const menuHeight = 18;
    const startX = Math.floor((this.width - menuWidth) / 2);
    const startY = Math.floor((this.height - menuHeight) / 2);

    // Draw background
    for (let y = startY; y < startY + menuHeight; y++) {
      for (let x = startX; x < startX + menuWidth; x++) {
        if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
          this.framebuffer.setPixel(x, y, ' ', Color.white(), bgDark);
        }
      }
    }

    // Draw border
    for (let x = startX; x < startX + menuWidth; x++) {
      this.framebuffer.setPixel(x, startY, '─', borderColor, bgDark);
      this.framebuffer.setPixel(x, startY + menuHeight - 1, '─', borderColor, bgDark);
    }
    for (let y = startY; y < startY + menuHeight; y++) {
      this.framebuffer.setPixel(startX, y, '│', borderColor, bgDark);
      this.framebuffer.setPixel(startX + menuWidth - 1, y, '│', borderColor, bgDark);
    }
    // Corners
    this.framebuffer.setPixel(startX, startY, '┌', borderColor, bgDark);
    this.framebuffer.setPixel(startX + menuWidth - 1, startY, '┐', borderColor, bgDark);
    this.framebuffer.setPixel(startX, startY + menuHeight - 1, '└', borderColor, bgDark);
    this.framebuffer.setPixel(startX + menuWidth - 1, startY + menuHeight - 1, '┘', borderColor, bgDark);

    // Title
    const title = 'BUY MENU';
    this.framebuffer.drawText(startX + Math.floor((menuWidth - title.length) / 2), startY + 1, title, selectedColor, bgDark);

    // Money display
    const moneyText = `Money: $${this.buyMenu.getPlayerMoney()}`;
    this.framebuffer.drawText(startX + 2, startY + 2, moneyText, affordColor, bgDark);

    // Category tabs
    const categories = this.buyMenu.getCategoriesWithCounts();
    let tabX = startX + 2;
    for (const cat of categories) {
      const tabText = `[${cat.label}]`;
      const tabColor = cat.isSelected ? selectedColor : new Color(150, 150, 150);
      this.framebuffer.drawText(tabX, startY + 4, tabText, tabColor, bgDark);
      tabX += tabText.length + 2;
    }

    // Separator
    for (let x = startX + 1; x < startX + menuWidth - 1; x++) {
      this.framebuffer.setPixel(x, startY + 5, '─', borderColor, bgDark);
    }

    // Weapon list
    const items = this.buyMenu.getMenuItems();
    const selectedIndex = this.buyMenu.getState().selectedItem;

    for (let i = 0; i < items.length && i < 8; i++) {
      const item = items[i];
      const y = startY + 6 + i;
      const isSelected = i === selectedIndex;

      // Format: [n] WeaponName    $cost  [OWNED/status]
      const prefix = isSelected ? '>' : ' ';
      const numKey = `${i + 1}`;
      const name = item.def.name.padEnd(15);
      const cost = `$${item.def.cost}`.padStart(6);
      const status = item.owned ? '[OWNED]' : (item.canAfford ? '' : '[$$]');

      let lineColor: Color;
      if (item.owned) {
        lineColor = ownedColor;
      } else if (item.canAfford) {
        lineColor = isSelected ? selectedColor : affordColor;
      } else {
        lineColor = cantAffordColor;
      }

      const line = `${prefix}${numKey}. ${name} ${cost} ${status}`;
      this.framebuffer.drawText(startX + 2, y, line, lineColor, bgDark);
    }

    // Controls hint
    const hint = 'Arrow keys: navigate | Enter: buy | B/Esc: close';
    this.framebuffer.drawText(startX + 2, startY + menuHeight - 2, hint, new Color(150, 150, 150), bgDark);
  }

  // Draw main menu overlay
  private drawMainMenuOverlay(): void {
    if (!this.showMainMenu || !this.mainMenu) return;

    const bgDark = new Color(15, 15, 25);
    const borderColor = new Color(80, 80, 120);
    const titleColor = new Color(255, 215, 0);  // Gold
    const selectedColor = new Color(100, 255, 100);  // Green
    const normalColor = new Color(200, 200, 200);
    const descColor = new Color(150, 150, 150);

    // Full screen background
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        this.framebuffer.setPixel(x, y, ' ', Color.white(), bgDark);
      }
    }

    // ASCII art title (simple)
    const titleLines = [
      '  ██████╗███████╗     ██████╗██╗     ██╗',
      ' ██╔════╝██╔════╝    ██╔════╝██║     ██║',
      ' ██║     ███████╗    ██║     ██║     ██║',
      ' ██║     ╚════██║    ██║     ██║     ██║',
      ' ╚██████╗███████║    ╚██████╗███████╗██║',
      '  ╚═════╝╚══════╝     ╚═════╝╚══════╝╚═╝',
    ];

    const titleStartY = 3;
    for (let i = 0; i < titleLines.length; i++) {
      const line = titleLines[i];
      const x = Math.floor((this.width - line.length) / 2);
      this.framebuffer.drawText(x, titleStartY + i, line, titleColor, bgDark);
    }

    // Screen title
    const screenTitle = this.mainMenu.getScreenTitle();
    const titleY = titleStartY + titleLines.length + 2;
    this.framebuffer.drawText(
      Math.floor((this.width - screenTitle.length) / 2),
      titleY,
      screenTitle,
      normalColor,
      bgDark
    );

    // Menu items
    const items = this.mainMenu.getCurrentItems();
    const selectedIndex = this.mainMenu.getSelectedIndex();
    const itemsStartY = titleY + 3;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const isSelected = i === selectedIndex;
      const prefix = isSelected ? '> ' : '  ';
      const text = prefix + item;
      const color = isSelected ? selectedColor : normalColor;
      const x = Math.floor((this.width - text.length) / 2);
      this.framebuffer.drawText(x, itemsStartY + i * 2, text, color, bgDark);
    }

    // Description for selected item
    const description = this.mainMenu.getSelectionDescription();
    if (description) {
      const descY = itemsStartY + items.length * 2 + 2;
      this.framebuffer.drawText(
        Math.floor((this.width - description.length) / 2),
        descY,
        description,
        descColor,
        bgDark
      );
    }

    // Controls hint
    const hint = 'W/S or Arrow keys: navigate | Enter: select | Esc: back';
    const hintY = this.height - 3;
    this.framebuffer.drawText(
      Math.floor((this.width - hint.length) / 2),
      hintY,
      hint,
      descColor,
      bgDark
    );
  }

  // Set team-based display data
  setTeamScores(tScore: number, ctScore: number, roundNumber: number): void {
    this.tScore = tScore;
    this.ctScore = ctScore;
    this.roundNumber = roundNumber;
  }

  setPlayerTeam(team: TeamId): void {
    this.playerTeam = team;
  }

  setPlayerMoney(money: number): void {
    this.playerMoney = money;
  }

  setFreezeTime(seconds: number): void {
    this.freezeTimeRemaining = seconds;
  }

  // Main menu
  setMainMenu(menu: MainMenu | null, show: boolean): void {
    this.mainMenu = menu;
    this.showMainMenu = show;
  }

  isMainMenuShown(): boolean {
    return this.showMainMenu;
  }

  // Buy menu
  setBuyMenu(menu: BuyMenu | null): void {
    this.buyMenu = menu;
  }

  // Dropped weapons
  setDroppedWeapons(weapons: DroppedWeapon[]): void {
    this.droppedWeapons = weapons;
  }

  // Enter fullscreen mode
  static enterFullscreen(): void {
    process.stdout.write(ALT_SCREEN_ON + CURSOR_HIDE);
  }

  // Exit fullscreen mode
  static exitFullscreen(): void {
    process.stdout.write(CURSOR_SHOW + ALT_SCREEN_OFF + RESET);
  }

  // Get the rasterizer for advanced configuration
  getRasterizer(): Rasterizer {
    return this.rasterizer;
  }

  // Get framebuffer for direct manipulation
  getFramebuffer(): Framebuffer {
    return this.framebuffer;
  }

  // Render a single frame without the full pipeline (for UI overlays, etc.)
  renderDirect(): void {
    if (this.enableDifferentialRendering) {
      process.stdout.write(this.framebuffer.toDiffAnsiString(this.prevFramebuffer));
    } else {
      this.framebuffer.render();
    }
  }

  // === DEBUG FEATURES ===

  // Render a frame to buffer without outputting (for inspection)
  renderToBuffer(): {
    ansi: string;
    ascii: string;
    debugAscii: string;
    stats: RenderStats;
    depthMap: string;
  } {
    const startTime = performance.now();

    // Clear buffers
    this.clear();

    // Get camera matrices
    const viewProjection = this.camera.viewProjectionMatrix;

    let totalTriangles = 0;
    let totalVertices = 0;
    let visibleObjects = 0;

    // Render all objects
    for (const obj of this.objects) {
      if (obj.visible === false) continue;

      visibleObjects++;
      totalTriangles += obj.mesh.triangles.length;
      totalVertices += obj.mesh.vertices.length;

      const modelMatrix = obj.transform.matrix;
      const mvpMatrix = Matrix4.multiply(viewProjection, modelMatrix);
      this.rasterizer.rasterizeMesh(obj.mesh, mvpMatrix, modelMatrix);
    }

    const endTime = performance.now();
    const frameTime = endTime - startTime;

    return {
      ansi: this.framebuffer.toAnsiString(),
      ascii: this.framebuffer.toAsciiString(),
      debugAscii: this.framebuffer.toDebugAsciiString(),
      stats: {
        triangles: totalTriangles,
        vertices: totalVertices,
        objects: visibleObjects,
        frameTime,
        fps: 1000 / frameTime
      },
      depthMap: this.depthBuffer.toAsciiMap()
    };
  }

  // Render and save debug output to files
  async renderDebugFrame(basePath: string = './debug_frame'): Promise<void> {
    const frame = this.renderToBuffer();
    const fs = await import('fs');

    // Save ANSI colored output
    fs.writeFileSync(`${basePath}_ansi.txt`, frame.ansi);

    // Save plain ASCII (no colors)
    fs.writeFileSync(`${basePath}_ascii.txt`, frame.ascii);

    // Save debug ASCII (colors as characters)
    fs.writeFileSync(`${basePath}_debug.txt`, frame.debugAscii);

    // Save depth map visualization
    fs.writeFileSync(`${basePath}_depth.txt`, frame.depthMap);

    // Save stats as JSON
    fs.writeFileSync(`${basePath}_stats.json`, JSON.stringify({
      ...frame.stats,
      width: this.width,
      height: this.height,
      cameraPosition: {
        x: this.camera.position.x,
        y: this.camera.position.y,
        z: this.camera.position.z
      },
      cameraPitch: this.camera.pitch,
      cameraYaw: this.camera.yaw
    }, null, 2));

    console.log(`Debug frame saved to ${basePath}_*.txt`);
  }

  // Print a single debug frame to console (useful for quick inspection)
  debugPrint(): void {
    const frame = this.renderToBuffer();
    console.log('=== RENDERED FRAME (Debug ASCII: R=red, G=green, B=blue, .=gray, space=sky) ===');
    console.log(frame.debugAscii);
    console.log('=== STATS ===');
    console.log(`Objects: ${frame.stats.objects}, Triangles: ${frame.stats.triangles}, Vertices: ${frame.stats.vertices}`);
    console.log(`Frame time: ${frame.stats.frameTime.toFixed(2)}ms`);
    console.log(`Resolution: ${this.width}x${this.height}`);
    console.log(`Camera: (${this.camera.position.x.toFixed(2)}, ${this.camera.position.y.toFixed(2)}, ${this.camera.position.z.toFixed(2)})`);
    console.log(`Pitch: ${(this.camera.pitch * 180 / Math.PI).toFixed(1)}°, Yaw: ${(this.camera.yaw * 180 / Math.PI).toFixed(1)}°`);
  }

  // Get camera info for debugging
  debugCameraInfo(): string {
    const pos = this.camera.position;
    const fwd = this.camera.getForward();
    return [
      `Camera Position: (${pos.x.toFixed(3)}, ${pos.y.toFixed(3)}, ${pos.z.toFixed(3)})`,
      `Camera Forward: (${fwd.x.toFixed(3)}, ${fwd.y.toFixed(3)}, ${fwd.z.toFixed(3)})`,
      `Pitch: ${(this.camera.pitch * 180 / Math.PI).toFixed(1)}°`,
      `Yaw: ${(this.camera.yaw * 180 / Math.PI).toFixed(1)}°`,
      `FOV: ${this.camera.fov}°`,
      `Near: ${this.camera.near}, Far: ${this.camera.far}`
    ].join('\n');
  }
}
