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

  // Sixel performance settings
  public sixelQuantLevel: number = 16;  // Color quantization (higher = fewer colors, faster)
  public sixelMaxColors: number = 256;  // Max palette size

  // Frame hash for differential rendering
  private frameHash: number = 0;
  private lastSixelOutput: string = '';

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

  // Half-block character for rendering two vertical pixels per cell
  private static readonly UPPER_HALF = '▀';
  private static readonly LOWER_HALF = '▄';
  private static readonly FULL_BLOCK = '█';

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

  // Render to half-block ANSI string (2x vertical resolution)
  // Each terminal row represents 2 framebuffer rows
  // Upper half-block (▀) with fg=top color, bg=bottom color
  // Text characters are rendered as full-block text (not half-block)

  // Check if a character is a solid pixel (for half-block combining)
  // Only solid blocks and spaces are combined into half-blocks
  // Everything else (text, box drawing, shading chars) renders as full characters
  private static isSolidPixel(char: string): boolean {
    return char === '█' || char === ' ';
  }

  toHalfBlockAnsiString(): string {
    const lines: string[] = [];
    let currentFg: string | null = null;
    let currentBg: string | null = null;

    // Process two rows at a time
    for (let y = 0; y < this.height; y += 2) {
      let line = '';

      for (let x = 0; x < this.width; x++) {
        // Top pixel (y)
        const topPixel = this.pixels[y * this.width + x];
        // Bottom pixel (y+1) - if exists, otherwise use top
        const bottomPixel = (y + 1 < this.height)
          ? this.pixels[(y + 1) * this.width + x]
          : topPixel;

        const topIsSolid = Framebuffer.isSolidPixel(topPixel.char);
        const bottomIsSolid = Framebuffer.isSolidPixel(bottomPixel.char);

        let outputChar: string;
        let fgColor: Color;
        let bgColor: Color;

        if (!topIsSolid) {
          // Top pixel is a character (text, box drawing, shading) - render as full character
          outputChar = topPixel.char;
          fgColor = topPixel.fg;
          bgColor = topPixel.bg;
        } else if (!bottomIsSolid) {
          // Bottom pixel is a character - render as full character
          outputChar = bottomPixel.char;
          fgColor = bottomPixel.fg;
          bgColor = bottomPixel.bg;
        } else {
          // Both are solid pixels (█ or space) - use half-block rendering
          // Upper half-block: foreground = top color, background = bottom color
          outputChar = Framebuffer.UPPER_HALF;
          fgColor = topPixel.bg;  // Use bg as the pixel color for solid pixels
          bgColor = bottomPixel.bg;
        }

        const fgAnsi = fgColor.toFgAnsi();
        const bgAnsi = bgColor.toBgAnsi();

        // Only emit color codes when they change
        if (fgAnsi !== currentFg || bgAnsi !== currentBg) {
          line += fgAnsi + bgAnsi;
          currentFg = fgAnsi;
          currentBg = bgAnsi;
        }

        line += outputChar;
      }

      lines.push(line);
    }

    return CURSOR_HOME + lines.join('\n') + RESET;
  }

  // Render to Sixel graphics format (true pixel rendering)
  // Sixel is supported by iTerm2, mlterm, xterm (with config), etc.
  // Optimized algorithm: process by row, track colors per column, use RLE
  toSixelString(): string {
    // Aggressive quantization to reduce colors (divide by 16 for ~16 levels per channel)
    const QUANT = 16;

    // Build color palette with aggressive quantization
    const colorMap = new Map<string, number>();
    const colors: Color[] = [];

    for (const pixel of this.pixels) {
      const qr = Math.floor(pixel.bg.r / QUANT) * QUANT;
      const qg = Math.floor(pixel.bg.g / QUANT) * QUANT;
      const qb = Math.floor(pixel.bg.b / QUANT) * QUANT;
      const key = `${qr},${qg},${qb}`;

      if (!colorMap.has(key)) {
        colorMap.set(key, colors.length);
        colors.push(new Color(qr, qg, qb));
      }
    }

    // Build sixel output
    const parts: string[] = ['\x1bPq']; // Start sixel

    // Define colors
    for (let i = 0; i < colors.length; i++) {
      const c = colors[i];
      const r = Math.round(c.r / 255 * 100);
      const g = Math.round(c.g / 255 * 100);
      const b = Math.round(c.b / 255 * 100);
      parts.push(`#${i};2;${r};${g};${b}`);
    }

    // Pre-compute color indices for all pixels
    const colorIndices = new Uint16Array(this.pixels.length);
    for (let i = 0; i < this.pixels.length; i++) {
      const c = this.pixels[i].bg;
      const qr = Math.floor(c.r / QUANT) * QUANT;
      const qg = Math.floor(c.g / QUANT) * QUANT;
      const qb = Math.floor(c.b / QUANT) * QUANT;
      colorIndices[i] = colorMap.get(`${qr},${qg},${qb}`)!;
    }

    // Process sixel rows (6 pixels high each)
    for (let y = 0; y < this.height; y += 6) {
      // Build sixel values for each column, indexed by color
      const colorData = new Map<number, Uint8Array>();

      for (let x = 0; x < this.width; x++) {
        // Get the 6 pixels in this column (or fewer at bottom edge)
        for (let dy = 0; dy < 6 && y + dy < this.height; dy++) {
          const pixelIdx = (y + dy) * this.width + x;
          const colorIdx = colorIndices[pixelIdx];

          if (!colorData.has(colorIdx)) {
            colorData.set(colorIdx, new Uint8Array(this.width));
          }
          colorData.get(colorIdx)![x] |= (1 << dy);
        }
      }

      // Output data for each color that appears in this row
      for (const [colorIdx, data] of colorData) {
        parts.push(`#${colorIdx}`);

        // Simple RLE: consecutive same values
        let i = 0;
        while (i < this.width) {
          const val = data[i];
          let count = 1;
          while (i + count < this.width && data[i + count] === val && count < 255) {
            count++;
          }

          const char = String.fromCharCode(63 + val);
          if (count > 3) {
            parts.push(`!${count}${char}`);
          } else {
            parts.push(char.repeat(count));
          }
          i += count;
        }

        parts.push('$'); // Carriage return
      }

      parts.push('-'); // New sixel row
    }

    parts.push('\x1b\\'); // End sixel
    return CURSOR_HOME + parts.join('');
  }

  // Compute a fast hash of pixel colors for change detection
  private computeFrameHash(): number {
    let hash = 0;
    // Sample pixels for fast hash (every 8th pixel)
    for (let i = 0; i < this.pixels.length; i += 8) {
      const c = this.pixels[i].bg;
      hash = ((hash << 5) - hash + c.r + (c.g << 8) + (c.b << 16)) | 0;
    }
    return hash;
  }

  // Check if frame has changed since last sixel render
  hasFrameChanged(): boolean {
    const newHash = this.computeFrameHash();
    if (newHash === this.frameHash) {
      return false;
    }
    this.frameHash = newHash;
    return true;
  }

  // Render to Sixel with output scaling (each framebuffer pixel becomes scale×scale sixel pixels)
  // Optimized with: configurable quantization, max color limit, better RLE, differential skip
  toScaledSixelString(scale: number = 2, forceFull: boolean = false): string {
    // Differential rendering: skip if frame unchanged
    if (!forceFull && !this.hasFrameChanged()) {
      return ''; // Return empty - nothing to update
    }

    const QUANT = this.sixelQuantLevel;
    const scaledWidth = this.width * scale;
    const scaledHeight = this.height * scale;

    // Build color palette with configurable quantization
    const colorMap = new Map<string, number>();
    const colors: Color[] = [];

    for (const pixel of this.pixels) {
      const qr = Math.floor(pixel.bg.r / QUANT) * QUANT;
      const qg = Math.floor(pixel.bg.g / QUANT) * QUANT;
      const qb = Math.floor(pixel.bg.b / QUANT) * QUANT;
      const key = `${qr},${qg},${qb}`;

      if (!colorMap.has(key) && colors.length < this.sixelMaxColors) {
        colorMap.set(key, colors.length);
        colors.push(new Color(qr, qg, qb));
      }
    }

    // Build sixel output
    const parts: string[] = ['\x1bPq']; // Start sixel

    // Define colors
    for (let i = 0; i < colors.length; i++) {
      const c = colors[i];
      const r = Math.round(c.r / 255 * 100);
      const g = Math.round(c.g / 255 * 100);
      const b = Math.round(c.b / 255 * 100);
      parts.push(`#${i};2;${r};${g};${b}`);
    }

    // Pre-compute color indices for all pixels (find nearest if over max)
    const colorIndices = new Uint16Array(this.pixels.length);
    for (let i = 0; i < this.pixels.length; i++) {
      const c = this.pixels[i].bg;
      const qr = Math.floor(c.r / QUANT) * QUANT;
      const qg = Math.floor(c.g / QUANT) * QUANT;
      const qb = Math.floor(c.b / QUANT) * QUANT;
      const key = `${qr},${qg},${qb}`;
      const idx = colorMap.get(key);
      colorIndices[i] = idx !== undefined ? idx : 0;
    }

    // Process sixel rows (6 pixels high each) in scaled space
    for (let scaledY = 0; scaledY < scaledHeight; scaledY += 6) {
      // Build sixel values for each column, indexed by color
      const colorData = new Map<number, Uint8Array>();

      for (let scaledX = 0; scaledX < scaledWidth; scaledX++) {
        // Map scaled coords back to framebuffer coords
        const fbX = Math.floor(scaledX / scale);

        // Get the 6 pixels in this column (or fewer at bottom edge)
        for (let dy = 0; dy < 6 && scaledY + dy < scaledHeight; dy++) {
          const fbY = Math.floor((scaledY + dy) / scale);
          const pixelIdx = fbY * this.width + fbX;
          const colorIdx = colorIndices[pixelIdx];

          if (!colorData.has(colorIdx)) {
            colorData.set(colorIdx, new Uint8Array(scaledWidth));
          }
          colorData.get(colorIdx)![scaledX] |= (1 << dy);
        }
      }

      // Output data for each color that appears in this row
      for (const [colorIdx, data] of colorData) {
        parts.push(`#${colorIdx}`);

        // Optimized RLE with extended counts
        let i = 0;
        while (i < scaledWidth) {
          const val = data[i];
          let count = 1;
          // Allow larger RLE runs (up to 32767)
          while (i + count < scaledWidth && data[i + count] === val && count < 32767) {
            count++;
          }

          const char = String.fromCharCode(63 + val);
          if (count > 3) {
            parts.push(`!${count}${char}`);
          } else {
            parts.push(char.repeat(count));
          }
          i += count;
        }

        parts.push('$'); // Carriage return
      }

      parts.push('-'); // New sixel row
    }

    parts.push('\x1b\\'); // End sixel
    this.lastSixelOutput = CURSOR_HOME + parts.join('');
    return this.lastSixelOutput;
  }

  // Get last sixel output (for async writes)
  getLastSixelOutput(): string {
    return this.lastSixelOutput;
  }

  // Reset frame hash (force next render to be full)
  invalidateFrameHash(): void {
    this.frameHash = 0;
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
