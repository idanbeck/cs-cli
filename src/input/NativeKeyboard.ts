// Native keyboard input using CGEventTap on macOS
// Falls back to stdin-based input if native module unavailable

// macOS virtual key codes
export const MacKeyCode = {
  // Letters
  A: 0, S: 1, D: 2, F: 3, H: 4, G: 5, Z: 6, X: 7, C: 8, V: 9,
  B: 11, Q: 12, W: 13, E: 14, R: 15, Y: 16, T: 17,
  O: 31, U: 32, I: 34, P: 35, L: 37, J: 38, K: 40, N: 45, M: 46,

  // Numbers
  Num1: 18, Num2: 19, Num3: 20, Num4: 21, Num5: 23,
  Num6: 22, Num7: 26, Num8: 28, Num9: 25, Num0: 29,

  // Special
  Space: 49,
  Return: 36,
  Tab: 48,
  Delete: 51,
  Escape: 53,
  Backquote: 50, // ` ~

  // Arrows
  Left: 123,
  Right: 124,
  Down: 125,
  Up: 126,

  // Modifiers
  Shift: 56,
  RightShift: 60,
  Control: 59,
  Option: 58,
  Command: 55,
} as const;

export type MacKeyName = keyof typeof MacKeyCode;

// Game key mapping
export const GameKeyMap = {
  // Movement
  W: MacKeyCode.W,
  A: MacKeyCode.A,
  S: MacKeyCode.S,
  D: MacKeyCode.D,
  Space: MacKeyCode.Space,

  // Look (arrow keys)
  ArrowUp: MacKeyCode.Up,
  ArrowDown: MacKeyCode.Down,
  ArrowLeft: MacKeyCode.Left,
  ArrowRight: MacKeyCode.Right,

  // Actions
  F: MacKeyCode.F,         // Fire
  R: MacKeyCode.R,         // Reload
  E: MacKeyCode.E,         // Pickup/Use
  B: MacKeyCode.B,         // Buy menu
  C: MacKeyCode.C,         // Toggle mouse capture
  Tab: MacKeyCode.Tab,     // Scoreboard
  Escape: MacKeyCode.Escape,
  Q: MacKeyCode.Q,         // Quit

  // Weapon selection
  Num1: MacKeyCode.Num1,
  Num2: MacKeyCode.Num2,
  Num3: MacKeyCode.Num3,
  Num4: MacKeyCode.Num4,
  Num5: MacKeyCode.Num5,

  // Debug
  Backquote: MacKeyCode.Backquote,

  // Menu
  Enter: MacKeyCode.Return,
  H: MacKeyCode.H,
} as const;

export type GameKeyName = keyof typeof GameKeyMap;

// Native module interface
interface NativeKeyboardModule {
  start(): boolean;
  stop(): boolean;
  isKeyDown(keycode: number): boolean;
  wasKeyJustPressed(keycode: number): boolean;
  wasKeyJustReleased(keycode: number): boolean;
  update(): void;
  isRunning(): boolean;
}

let nativeModule: NativeKeyboardModule | null = null;
let useNative = false;

// Try to load native module
export function initNativeKeyboard(): boolean {
  if (nativeModule) return useNative;

  try {
    // Dynamic import of native module
    const path = require('path');
    const fs = require('fs');

    // __dirname in compiled JS is dist/input, so go up to project root
    const projectRoot = path.resolve(__dirname, '../..');
    const modulePath = path.join(projectRoot, 'native/build/Release/keyboard.node');

    if (!fs.existsSync(modulePath)) {
      console.warn(`Native keyboard module not found at: ${modulePath}`);
      return false;
    }

    nativeModule = require(modulePath) as NativeKeyboardModule;

    if (nativeModule.start()) {
      useNative = true;
      return true;
    } else {
      console.warn('Native keyboard failed to start (need accessibility permissions?)');
      return false;
    }
  } catch (e: any) {
    console.warn('Native keyboard error:', e.message);
    return false;
  }
}

export function stopNativeKeyboard(): void {
  if (nativeModule && useNative) {
    nativeModule.stop();
    useNative = false;
  }
}

export function isNativeKeyboardAvailable(): boolean {
  return useNative && nativeModule !== null;
}

export function getInputMode(): 'native' | 'stdin' {
  return useNative && nativeModule !== null ? 'native' : 'stdin';
}

// Check if a key is currently held
export function isKeyDown(keycode: number): boolean {
  if (!useNative || !nativeModule) return false;
  return nativeModule.isKeyDown(keycode);
}

// Check if a key was just pressed this frame
export function wasKeyJustPressed(keycode: number): boolean {
  if (!useNative || !nativeModule) return false;
  return nativeModule.wasKeyJustPressed(keycode);
}

// Check if a key was just released this frame
export function wasKeyJustReleased(keycode: number): boolean {
  if (!useNative || !nativeModule) return false;
  return nativeModule.wasKeyJustReleased(keycode);
}

// Clear just pressed/released flags (call once per frame)
export function updateNativeKeyboard(): void {
  if (useNative && nativeModule) {
    nativeModule.update();
  }
}

// Convenience: check game key by name
export function isGameKeyDown(key: GameKeyName): boolean {
  return isKeyDown(GameKeyMap[key]);
}

export function wasGameKeyJustPressed(key: GameKeyName): boolean {
  return wasKeyJustPressed(GameKeyMap[key]);
}

export function wasGameKeyJustReleased(key: GameKeyName): boolean {
  return wasKeyJustReleased(GameKeyMap[key]);
}

// Get movement input
export function getMovementInput(): { forward: number; strafe: number; jump: boolean } {
  if (!useNative || !nativeModule) {
    return { forward: 0, strafe: 0, jump: false };
  }

  let forward = 0;
  let strafe = 0;

  if (nativeModule.isKeyDown(MacKeyCode.W)) forward += 1;
  if (nativeModule.isKeyDown(MacKeyCode.S)) forward -= 1;
  if (nativeModule.isKeyDown(MacKeyCode.A)) strafe -= 1;
  if (nativeModule.isKeyDown(MacKeyCode.D)) strafe += 1;

  return {
    forward,
    strafe,
    jump: nativeModule.isKeyDown(MacKeyCode.Space),
  };
}

// Get look input from arrow keys
export function getLookInput(): { yaw: number; pitch: number } {
  if (!useNative || !nativeModule) {
    return { yaw: 0, pitch: 0 };
  }

  let yaw = 0;
  let pitch = 0;

  if (nativeModule.isKeyDown(MacKeyCode.Left)) yaw -= 1;
  if (nativeModule.isKeyDown(MacKeyCode.Right)) yaw += 1;
  if (nativeModule.isKeyDown(MacKeyCode.Up)) pitch += 1;
  if (nativeModule.isKeyDown(MacKeyCode.Down)) pitch -= 1;

  return { yaw, pitch };
}

// Get weapon slot pressed (1-5)
export function getWeaponSlotPressed(): number | null {
  if (!useNative || !nativeModule) return null;

  if (nativeModule.wasKeyJustPressed(MacKeyCode.Num1)) return 1;
  if (nativeModule.wasKeyJustPressed(MacKeyCode.Num2)) return 2;
  if (nativeModule.wasKeyJustPressed(MacKeyCode.Num3)) return 3;
  if (nativeModule.wasKeyJustPressed(MacKeyCode.Num4)) return 4;
  if (nativeModule.wasKeyJustPressed(MacKeyCode.Num5)) return 5;

  return null;
}
