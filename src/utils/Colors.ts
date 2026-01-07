// ANSI escape codes for terminal colors

export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';
export const ITALIC = '\x1b[3m';
export const UNDERLINE = '\x1b[4m';
export const BLINK = '\x1b[5m';
export const REVERSE = '\x1b[7m';
export const HIDDEN = '\x1b[8m';

// Standard foreground colors
export const FG_BLACK = '\x1b[30m';
export const FG_RED = '\x1b[31m';
export const FG_GREEN = '\x1b[32m';
export const FG_YELLOW = '\x1b[33m';
export const FG_BLUE = '\x1b[34m';
export const FG_MAGENTA = '\x1b[35m';
export const FG_CYAN = '\x1b[36m';
export const FG_WHITE = '\x1b[37m';

// Bright foreground colors
export const FG_BRIGHT_BLACK = '\x1b[90m';
export const FG_BRIGHT_RED = '\x1b[91m';
export const FG_BRIGHT_GREEN = '\x1b[92m';
export const FG_BRIGHT_YELLOW = '\x1b[93m';
export const FG_BRIGHT_BLUE = '\x1b[94m';
export const FG_BRIGHT_MAGENTA = '\x1b[95m';
export const FG_BRIGHT_CYAN = '\x1b[96m';
export const FG_BRIGHT_WHITE = '\x1b[97m';

// Standard background colors
export const BG_BLACK = '\x1b[40m';
export const BG_RED = '\x1b[41m';
export const BG_GREEN = '\x1b[42m';
export const BG_YELLOW = '\x1b[43m';
export const BG_BLUE = '\x1b[44m';
export const BG_MAGENTA = '\x1b[45m';
export const BG_CYAN = '\x1b[46m';
export const BG_WHITE = '\x1b[47m';

// Bright background colors
export const BG_BRIGHT_BLACK = '\x1b[100m';
export const BG_BRIGHT_RED = '\x1b[101m';
export const BG_BRIGHT_GREEN = '\x1b[102m';
export const BG_BRIGHT_YELLOW = '\x1b[103m';
export const BG_BRIGHT_BLUE = '\x1b[104m';
export const BG_BRIGHT_MAGENTA = '\x1b[105m';
export const BG_BRIGHT_CYAN = '\x1b[106m';
export const BG_BRIGHT_WHITE = '\x1b[107m';

// 256-color mode
export function fg256(code: number): string {
  return `\x1b[38;5;${code}m`;
}

export function bg256(code: number): string {
  return `\x1b[48;5;${code}m`;
}

// True color (24-bit RGB)
export function fgRGB(r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}

export function bgRGB(r: number, g: number, b: number): string {
  return `\x1b[48;2;${r};${g};${b}m`;
}

// Color class for manipulation
export class Color {
  constructor(
    public r: number = 0,
    public g: number = 0,
    public b: number = 0,
    public a: number = 1
  ) {}

  static black(): Color {
    return new Color(0, 0, 0);
  }

  static white(): Color {
    return new Color(255, 255, 255);
  }

  static red(): Color {
    return new Color(255, 0, 0);
  }

  static green(): Color {
    return new Color(0, 255, 0);
  }

  static blue(): Color {
    return new Color(0, 0, 255);
  }

  static yellow(): Color {
    return new Color(255, 255, 0);
  }

  static cyan(): Color {
    return new Color(0, 255, 255);
  }

  static magenta(): Color {
    return new Color(255, 0, 255);
  }

  static gray(value: number = 128): Color {
    return new Color(value, value, value);
  }

  static fromHex(hex: string): Color {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (result) {
      return new Color(
        parseInt(result[1], 16),
        parseInt(result[2], 16),
        parseInt(result[3], 16)
      );
    }
    return new Color();
  }

  static fromHSL(h: number, s: number, l: number): Color {
    let r: number, g: number, b: number;

    if (s === 0) {
      r = g = b = l;
    } else {
      const hue2rgb = (p: number, q: number, t: number) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };

      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }

    return new Color(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255));
  }

  clone(): Color {
    return new Color(this.r, this.g, this.b, this.a);
  }

  copy(c: Color): this {
    this.r = c.r;
    this.g = c.g;
    this.b = c.b;
    this.a = c.a;
    return this;
  }

  set(r: number, g: number, b: number, a: number = 1): this {
    this.r = r;
    this.g = g;
    this.b = b;
    this.a = a;
    return this;
  }

  lerp(c: Color, t: number): this {
    this.r = Math.round(this.r + (c.r - this.r) * t);
    this.g = Math.round(this.g + (c.g - this.g) * t);
    this.b = Math.round(this.b + (c.b - this.b) * t);
    this.a = this.a + (c.a - this.a) * t;
    return this;
  }

  static lerp(a: Color, b: Color, t: number): Color {
    return a.clone().lerp(b, t);
  }

  multiply(factor: number): this {
    this.r = Math.min(255, Math.round(this.r * factor));
    this.g = Math.min(255, Math.round(this.g * factor));
    this.b = Math.min(255, Math.round(this.b * factor));
    return this;
  }

  add(c: Color): this {
    this.r = Math.min(255, this.r + c.r);
    this.g = Math.min(255, this.g + c.g);
    this.b = Math.min(255, this.b + c.b);
    return this;
  }

  toFgAnsi(): string {
    return fgRGB(this.r, this.g, this.b);
  }

  toBgAnsi(): string {
    return bgRGB(this.r, this.g, this.b);
  }

  toHex(): string {
    const toHex = (n: number) => n.toString(16).padStart(2, '0');
    return `#${toHex(this.r)}${toHex(this.g)}${toHex(this.b)}`;
  }

  brightness(): number {
    return (this.r * 299 + this.g * 587 + this.b * 114) / 1000;
  }

  // Get a grayscale version
  grayscale(): Color {
    const gray = Math.round(this.brightness());
    return new Color(gray, gray, gray, this.a);
  }

  equals(c: Color): boolean {
    return this.r === c.r && this.g === c.g && this.b === c.b && this.a === c.a;
  }

  toString(): string {
    return `Color(${this.r}, ${this.g}, ${this.b}, ${this.a})`;
  }
}

// Material colors for game surfaces
export const Materials = {
  concrete: new Color(128, 128, 128),
  concreteLight: new Color(180, 180, 180),
  concreteDark: new Color(80, 80, 80),
  brick: new Color(178, 102, 76),
  brickDark: new Color(139, 69, 49),
  metal: new Color(160, 170, 180),
  metalDark: new Color(100, 110, 120),
  wood: new Color(139, 90, 43),
  woodDark: new Color(101, 67, 33),
  sand: new Color(194, 178, 128),
  grass: new Color(86, 125, 70),
  water: new Color(64, 164, 223),
  glass: new Color(200, 220, 255),
  crate: new Color(160, 120, 60),
  floor: new Color(100, 100, 100),
  ceiling: new Color(60, 60, 60),
  sky: new Color(135, 206, 235),
  // Team colors
  terrorist: new Color(180, 60, 50),
  counterTerrorist: new Color(50, 80, 180),
  // UI colors
  health: new Color(0, 200, 0),
  healthLow: new Color(200, 50, 0),
  armor: new Color(50, 120, 200),
  ammo: new Color(200, 180, 50),
  money: new Color(50, 200, 50),
  crosshair: new Color(0, 255, 0),
};

// Shading characters for depth
export const SHADE_CHARS = ['█', '▓', '▒', '░', '·', ' '];

// Get shade character based on depth (0 = close, 1 = far)
export function getShadeChar(depth: number): string {
  const index = Math.floor(depth * (SHADE_CHARS.length - 1));
  return SHADE_CHARS[Math.min(index, SHADE_CHARS.length - 1)];
}

// Get shade character and darken color based on depth
export function getDepthShading(color: Color, depth: number, maxDepth: number = 50): { char: string; color: Color } {
  const normalizedDepth = Math.min(depth / maxDepth, 1);
  const darkenFactor = 1 - normalizedDepth * 0.8; // Don't go fully black
  const shadedColor = color.clone().multiply(darkenFactor);
  const char = getShadeChar(normalizedDepth);
  return { char, color: shadedColor };
}

// Cursor control
export const CURSOR_UP = (n: number = 1) => `\x1b[${n}A`;
export const CURSOR_DOWN = (n: number = 1) => `\x1b[${n}B`;
export const CURSOR_FORWARD = (n: number = 1) => `\x1b[${n}C`;
export const CURSOR_BACK = (n: number = 1) => `\x1b[${n}D`;
export const CURSOR_POSITION = (row: number, col: number) => `\x1b[${row};${col}H`;
export const CURSOR_HOME = '\x1b[H';
export const CURSOR_HIDE = '\x1b[?25l';
export const CURSOR_SHOW = '\x1b[?25h';
export const CLEAR_SCREEN = '\x1b[2J';
export const CLEAR_LINE = '\x1b[2K';
export const SAVE_CURSOR = '\x1b[s';
export const RESTORE_CURSOR = '\x1b[u';

// Alternative screen buffer (for fullscreen apps)
export const ALT_SCREEN_ON = '\x1b[?1049h';
export const ALT_SCREEN_OFF = '\x1b[?1049l';
