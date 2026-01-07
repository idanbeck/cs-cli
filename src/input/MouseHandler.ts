// Mouse handling for terminal using SGR 1006 extended mode
// Works in modern terminals: iTerm2, Ghostty, Kitty, etc.

export interface MouseState {
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  buttons: number;
  captured: boolean;
}

export interface MouseConfig {
  sensitivity: number;
  invertY: boolean;
}

// ANSI escape sequences for mouse tracking
const MOUSE_TRACKING_ON = '\x1b[?1003h';   // Enable any-event tracking
const MOUSE_SGR_ON = '\x1b[?1006h';        // Enable SGR extended mode
const MOUSE_TRACKING_OFF = '\x1b[?1003l';  // Disable any-event tracking
const MOUSE_SGR_OFF = '\x1b[?1006l';       // Disable SGR extended mode

export class MouseHandler {
  private state: MouseState = {
    x: 0,
    y: 0,
    deltaX: 0,
    deltaY: 0,
    buttons: 0,
    captured: false
  };

  private config: MouseConfig = {
    sensitivity: 1.0,  // Base sensitivity (lower for smoother control)
    invertY: false
  };

  private lastX: number = 0;
  private lastY: number = 0;
  private centerX: number = 0;
  private centerY: number = 0;
  private screenWidth: number = 80;
  private screenHeight: number = 24;
  private enabled: boolean = false;
  private releaseOnEdge: boolean = true; // Release capture when mouse hits edge

  // Smoothing for continuous mouse movement
  private smoothedDeltaX: number = 0;
  private smoothedDeltaY: number = 0;
  private smoothingFactor: number = 0.3; // How much of target to apply per frame (0-1)

  private onMove?: (deltaX: number, deltaY: number) => void;
  private onClick?: (button: number, x: number, y: number) => void;
  private onCapture?: (captured: boolean) => void;

  constructor(screenWidth: number, screenHeight: number) {
    this.screenWidth = screenWidth;
    this.screenHeight = screenHeight;
    this.centerX = Math.floor(screenWidth / 2);
    this.centerY = Math.floor(screenHeight / 2);
    this.lastX = this.centerX;
    this.lastY = this.centerY;
  }

  setSensitivity(sensitivity: number): void {
    this.config.sensitivity = sensitivity;
  }

  setInvertY(invert: boolean): void {
    this.config.invertY = invert;
  }

  setOnMove(callback: (deltaX: number, deltaY: number) => void): void {
    this.onMove = callback;
  }

  setOnClick(callback: (button: number, x: number, y: number) => void): void {
    this.onClick = callback;
  }

  setOnCapture(callback: (captured: boolean) => void): void {
    this.onCapture = callback;
  }

  // Enable mouse tracking in terminal
  enable(): void {
    if (this.enabled) return;
    process.stdout.write(MOUSE_TRACKING_ON + MOUSE_SGR_ON);
    this.enabled = true;
  }

  // Disable mouse tracking in terminal
  disable(): void {
    if (!this.enabled) return;
    process.stdout.write(MOUSE_TRACKING_OFF + MOUSE_SGR_OFF);
    this.enabled = false;
    this.state.captured = false;
  }

  // Capture mouse (lock to window for FPS-style control)
  capture(): void {
    if (!this.enabled) {
      this.enable();
    }
    this.state.captured = true;
    this.lastX = this.centerX;
    this.lastY = this.centerY;
    this.onCapture?.(true);
  }

  // Release mouse capture
  release(): void {
    this.state.captured = false;
    this.onCapture?.(false);
  }

  isCaptured(): boolean {
    return this.state.captured;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getState(): MouseState {
    return { ...this.state };
  }

  // Reset delta values (call after processing each frame)
  resetDelta(): void {
    this.state.deltaX = 0;
    this.state.deltaY = 0;
  }

  // Parse SGR mouse event from stdin data
  // Format: \x1b[<button;x;y;M or \x1b[<button;x;y;m
  // M = press/move, m = release
  parseMouseEvent(data: string): boolean {
    // SGR extended mode format: \x1b[<Cb;Cx;CyM or \x1b[<Cb;Cx;Cym
    const sgrMatch = data.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    if (sgrMatch) {
      const button = parseInt(sgrMatch[1], 10);
      const x = parseInt(sgrMatch[2], 10);
      const y = parseInt(sgrMatch[3], 10);
      const isRelease = sgrMatch[4] === 'm';

      this.handleMouseEvent(button, x, y, isRelease);
      return true;
    }

    // Legacy X10/normal mode fallback: \x1b[M<button><x><y>
    const legacyMatch = data.match(/\x1b\[M(.)(.)(.)/);
    if (legacyMatch) {
      const button = legacyMatch[1].charCodeAt(0) - 32;
      const x = legacyMatch[2].charCodeAt(0) - 32;
      const y = legacyMatch[3].charCodeAt(0) - 32;

      this.handleMouseEvent(button, x, y, false);
      return true;
    }

    return false;
  }

  private handleMouseEvent(buttonCode: number, x: number, y: number, isRelease: boolean): void {
    // Button codes in SGR mode:
    // 0 = left button
    // 1 = middle button
    // 2 = right button
    // 32 = motion with no button
    // 64 = scroll up
    // 65 = scroll down
    // Add 32 for motion events (e.g., 32 = motion, 33 = motion+left button)

    const isMotion = (buttonCode & 32) !== 0;
    const actualButton = buttonCode & 3; // Bottom 2 bits for button number

    // Update position
    this.state.x = x;
    this.state.y = y;

    // Check if mouse has left the terminal area (release capture)
    if (this.state.captured && this.releaseOnEdge && this.isAtEdge(x, y)) {
      this.release();
      // Reset last position to center so next capture doesn't jump
      this.lastX = this.centerX;
      this.lastY = this.centerY;
      return;
    }

    if (this.state.captured) {
      // In captured mode, calculate delta from last position
      const rawDeltaX = x - this.lastX;
      const rawDeltaY = y - this.lastY;

      // Apply sensitivity
      this.state.deltaX += rawDeltaX * this.config.sensitivity;
      this.state.deltaY += rawDeltaY * this.config.sensitivity * (this.config.invertY ? -1 : 1);

      // Notify callback
      if ((rawDeltaX !== 0 || rawDeltaY !== 0) && this.onMove) {
        this.onMove(
          rawDeltaX * this.config.sensitivity,
          rawDeltaY * this.config.sensitivity * (this.config.invertY ? -1 : 1)
        );
      }
    }

    this.lastX = x;
    this.lastY = y;

    // Handle button events
    if (!isMotion && !isRelease) {
      // Button press
      if (actualButton === 0) {
        this.state.buttons |= 1; // Left
        if (!this.state.captured) {
          // Click to capture
          this.capture();
        }
        this.onClick?.(0, x, y);
      } else if (actualButton === 1) {
        this.state.buttons |= 2; // Middle
        this.onClick?.(1, x, y);
      } else if (actualButton === 2) {
        this.state.buttons |= 4; // Right
        this.onClick?.(2, x, y);
      }
    } else if (isRelease) {
      // Button release
      if (actualButton === 0) {
        this.state.buttons &= ~1;
      } else if (actualButton === 1) {
        this.state.buttons &= ~2;
      } else if (actualButton === 2) {
        this.state.buttons &= ~4;
      }
    }

    // Handle scroll wheel
    if (buttonCode === 64) {
      // Scroll up
      this.onClick?.(3, x, y);
    } else if (buttonCode === 65) {
      // Scroll down
      this.onClick?.(4, x, y);
    }
  }

  // Update screen dimensions (call on resize)
  updateScreenSize(width: number, height: number): void {
    this.screenWidth = width;
    this.screenHeight = height;
    this.centerX = Math.floor(width / 2);
    this.centerY = Math.floor(height / 2);
  }

  // Enable/disable release-on-edge behavior
  setReleaseOnEdge(enabled: boolean): void {
    this.releaseOnEdge = enabled;
  }

  // Check if position is at terminal edge
  private isAtEdge(x: number, y: number): boolean {
    // Terminal coordinates are 1-based
    // Check if at or beyond edges (with small margin)
    return x <= 1 || x >= this.screenWidth || y <= 1 || y >= this.screenHeight;
  }

  // Get accumulated pitch/yaw changes for camera (in radians)
  // Uses smoothing for continuous movement instead of discrete jumps
  getPitchYawDelta(): { pitch: number; yaw: number } {
    // Apply smoothing - interpolate toward target delta
    // This spreads mouse movement over multiple frames for smoother rotation
    const targetDeltaX = this.state.deltaX;
    const targetDeltaY = this.state.deltaY;

    // Lerp toward target
    this.smoothedDeltaX += (targetDeltaX - this.smoothedDeltaX) * this.smoothingFactor;
    this.smoothedDeltaY += (targetDeltaY - this.smoothedDeltaY) * this.smoothingFactor;

    // Convert to radians with sensitivity
    // Use smaller base value for finer control
    const radiansPerUnit = 0.015 * this.config.sensitivity;

    const result = {
      pitch: -this.smoothedDeltaY * radiansPerUnit, // Negative because screen Y is inverted
      yaw: -this.smoothedDeltaX * radiansPerUnit    // Negative for natural mouse feel
    };

    // Decay the accumulated deltas (consume the smoothed movement)
    this.state.deltaX *= (1 - this.smoothingFactor);
    this.state.deltaY *= (1 - this.smoothingFactor);

    // Clear very small residual values to prevent drift
    if (Math.abs(this.state.deltaX) < 0.01) this.state.deltaX = 0;
    if (Math.abs(this.state.deltaY) < 0.01) this.state.deltaY = 0;

    return result;
  }

  // Set smoothing factor (0 = no smoothing/instant, 1 = very smooth/slow)
  setSmoothing(factor: number): void {
    this.smoothingFactor = Math.max(0.1, Math.min(1.0, factor));
  }

  // Reset smoothing state (call when capturing)
  resetSmoothing(): void {
    this.smoothedDeltaX = 0;
    this.smoothedDeltaY = 0;
    this.state.deltaX = 0;
    this.state.deltaY = 0;
  }
}

export default MouseHandler;
