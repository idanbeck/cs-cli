import { Color, RESET, CURSOR_HOME, CURSOR_HIDE, ALT_SCREEN_ON, ALT_SCREEN_OFF, CLEAR_SCREEN } from '../utils/Colors.js';

export interface Pixel {
  char: string;
  fg: Color;
  bg: Color;
}

export class Framebuffer {
  public width: number;
  public height: number;
  public pixels: Pixel[];

  private defaultChar: string = ' ';
  private defaultFg: Color = Color.white();
  private defaultBg: Color = Color.black();

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.pixels = new Array(width * height);
    this.clear();
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.pixels = new Array(width * height);
    this.clear();
  }

  clear(char?: string, fg?: Color, bg?: Color): void {
    const clearChar = char ?? this.defaultChar;
    const clearFg = fg ?? this.defaultFg;
    const clearBg = bg ?? this.defaultBg;

    for (let i = 0; i < this.pixels.length; i++) {
      this.pixels[i] = {
        char: clearChar,
        fg: clearFg.clone(),
        bg: clearBg.clone()
      };
    }
  }

  setDefaultColors(char: string, fg: Color, bg: Color): void {
    this.defaultChar = char;
    this.defaultFg = fg;
    this.defaultBg = bg;
  }

  getPixel(x: number, y: number): Pixel | null {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
      return null;
    }
    return this.pixels[y * this.width + x];
  }

  setPixel(x: number, y: number, char: string, fg: Color, bg?: Color): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
      return;
    }

    const index = y * this.width + x;
    const pixel = this.pixels[index];
    pixel.char = char;
    pixel.fg = fg;
    if (bg) {
      pixel.bg = bg;
    }
  }

  setPixelChar(x: number, y: number, char: string): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
      return;
    }
    this.pixels[y * this.width + x].char = char;
  }

  setPixelFg(x: number, y: number, fg: Color): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
      return;
    }
    this.pixels[y * this.width + x].fg = fg;
  }

  setPixelBg(x: number, y: number, bg: Color): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
      return;
    }
    this.pixels[y * this.width + x].bg = bg;
  }

  // Draw a horizontal line
  drawHLine(x: number, y: number, length: number, char: string, fg: Color, bg?: Color): void {
    for (let i = 0; i < length; i++) {
      this.setPixel(x + i, y, char, fg, bg);
    }
  }

  // Draw a vertical line
  drawVLine(x: number, y: number, length: number, char: string, fg: Color, bg?: Color): void {
    for (let i = 0; i < length; i++) {
      this.setPixel(x, y + i, char, fg, bg);
    }
  }

  // Draw a rectangle outline
  drawRect(x: number, y: number, width: number, height: number, char: string, fg: Color, bg?: Color): void {
    this.drawHLine(x, y, width, char, fg, bg);
    this.drawHLine(x, y + height - 1, width, char, fg, bg);
    this.drawVLine(x, y, height, char, fg, bg);
    this.drawVLine(x + width - 1, y, height, char, fg, bg);
  }

  // Fill a rectangle
  fillRect(x: number, y: number, width: number, height: number, char: string, fg: Color, bg?: Color): void {
    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        this.setPixel(x + dx, y + dy, char, fg, bg);
      }
    }
  }

  // Draw text
  drawText(x: number, y: number, text: string, fg: Color, bg?: Color): void {
    for (let i = 0; i < text.length; i++) {
      this.setPixel(x + i, y, text[i], fg, bg);
    }
  }

  // Draw centered text
  drawTextCentered(y: number, text: string, fg: Color, bg?: Color): void {
    const x = Math.floor((this.width - text.length) / 2);
    this.drawText(x, y, text, fg, bg);
  }

  // Render to ANSI string (optimized with color batching)
  toAnsiString(): string {
    const lines: string[] = [];
    let currentFg: string | null = null;
    let currentBg: string | null = null;

    for (let y = 0; y < this.height; y++) {
      let line = '';

      for (let x = 0; x < this.width; x++) {
        const pixel = this.pixels[y * this.width + x];
        const fgAnsi = pixel.fg.toFgAnsi();
        const bgAnsi = pixel.bg.toBgAnsi();

        // Only emit color codes when they change
        if (fgAnsi !== currentFg || bgAnsi !== currentBg) {
          line += fgAnsi + bgAnsi;
          currentFg = fgAnsi;
          currentBg = bgAnsi;
        }

        line += pixel.char;
      }

      lines.push(line);
    }

    return CURSOR_HOME + lines.join('\n') + RESET;
  }

  // Render with differential update (only changed pixels)
  // Returns cursor positioning commands for changed pixels
  toDiffAnsiString(previous: Framebuffer): string {
    if (previous.width !== this.width || previous.height !== this.height) {
      return this.toAnsiString();
    }

    let output = '';
    let lastX = -1;
    let lastY = -1;
    let currentFg: string | null = null;
    let currentBg: string | null = null;

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const index = y * this.width + x;
        const pixel = this.pixels[index];
        const prevPixel = previous.pixels[index];

        // Skip unchanged pixels
        if (
          pixel.char === prevPixel.char &&
          pixel.fg.equals(prevPixel.fg) &&
          pixel.bg.equals(prevPixel.bg)
        ) {
          continue;
        }

        // Position cursor if needed
        if (y !== lastY || x !== lastX + 1) {
          output += `\x1b[${y + 1};${x + 1}H`;
        }

        // Set colors if changed
        const fgAnsi = pixel.fg.toFgAnsi();
        const bgAnsi = pixel.bg.toBgAnsi();
        if (fgAnsi !== currentFg || bgAnsi !== currentBg) {
          output += fgAnsi + bgAnsi;
          currentFg = fgAnsi;
          currentBg = bgAnsi;
        }

        output += pixel.char;
        lastX = x;
        lastY = y;
      }
    }

    return output + RESET;
  }

  // Copy to another framebuffer
  copyTo(target: Framebuffer): void {
    for (let i = 0; i < this.pixels.length && i < target.pixels.length; i++) {
      target.pixels[i].char = this.pixels[i].char;
      target.pixels[i].fg.copy(this.pixels[i].fg);
      target.pixels[i].bg.copy(this.pixels[i].bg);
    }
  }

  // Static methods for terminal setup
  static enterFullscreen(): void {
    process.stdout.write(ALT_SCREEN_ON + CURSOR_HIDE + CLEAR_SCREEN);
  }

  static exitFullscreen(): void {
    process.stdout.write(ALT_SCREEN_OFF + RESET);
  }

  // Write framebuffer to stdout
  render(): void {
    process.stdout.write(this.toAnsiString());
  }

  // Convert to plain ASCII string (no colors, just characters)
  toAsciiString(): string {
    const lines: string[] = [];
    for (let y = 0; y < this.height; y++) {
      let line = '';
      for (let x = 0; x < this.width; x++) {
        line += this.pixels[y * this.width + x].char;
      }
      lines.push(line);
    }
    return lines.join('\n');
  }

  // Convert to debug ASCII string where colors are represented as different characters
  toDebugAsciiString(): string {
    const lines: string[] = [];
    for (let y = 0; y < this.height; y++) {
      let line = '';
      for (let x = 0; x < this.width; x++) {
        const pixel = this.pixels[y * this.width + x];
        // Map color to a character for debugging
        line += this.colorToDebugChar(pixel.fg);
      }
      lines.push(line);
    }
    return lines.join('\n');
  }

  // Map a color to a debug character based on its dominant channel
  private colorToDebugChar(c: Color): string {
    // Sky blue (135, 206, 235)
    if (c.b > 200 && c.g > 180 && c.r > 100 && c.r < 180) return ' ';

    // Gray (floor/walls) - all channels similar
    const avg = (c.r + c.g + c.b) / 3;
    const variance = Math.abs(c.r - avg) + Math.abs(c.g - avg) + Math.abs(c.b - avg);
    if (variance < 30) {
      // Grayscale - use intensity-based char
      if (avg < 50) return '#';
      if (avg < 100) return '%';
      if (avg < 150) return '=';
      return '.';
    }

    // Red dominant
    if (c.r > c.g && c.r > c.b) return 'R';
    // Green dominant
    if (c.g > c.r && c.g > c.b) return 'G';
    // Blue dominant
    if (c.b > c.r && c.b > c.g) return 'B';

    // Mixed/other
    return '?';
  }
}
