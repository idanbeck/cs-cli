export class DepthBuffer {
  public width: number;
  public height: number;
  public data: Float32Array;

  private clearValue: number = Infinity;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Float32Array(width * height);
    this.clear();
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.data = new Float32Array(width * height);
    this.clear();
  }

  clear(value: number = Infinity): void {
    this.clearValue = value;
    this.data.fill(value);
  }

  get(x: number, y: number): number {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
      return this.clearValue;
    }
    return this.data[y * this.width + x];
  }

  set(x: number, y: number, depth: number): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
      return;
    }
    this.data[y * this.width + x] = depth;
  }

  // Test and set: returns true if the new depth is closer (and was written)
  testAndSet(x: number, y: number, depth: number): boolean {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
      return false;
    }

    // Reject clearly invalid depth values (far outside NDC range)
    // Allow some tolerance for interpolation precision near edges
    if (depth < -1.5 || depth > 1.5) {
      return false;
    }

    const index = y * this.width + x;

    // Depth test: closer values are smaller (-1 = near plane, 1 = far plane)
    // Use < so closer objects always win (first drawn wins at same depth)
    if (depth < this.data[index]) {
      this.data[index] = depth;
      return true;
    }

    return false;
  }

  // Get normalized depth (0 = near, 1 = far)
  getNormalized(x: number, y: number): number {
    const depth = this.get(x, y);
    if (depth === Infinity) return 1;
    if (depth === -Infinity) return 0;
    // Depth in NDC is already roughly normalized
    return Math.max(0, Math.min(1, (depth + 1) / 2));
  }

  // Get linear depth from NDC depth (requires near/far planes)
  getLinearDepth(x: number, y: number, near: number, far: number): number {
    const ndcDepth = this.get(x, y);
    if (ndcDepth === Infinity) return far;

    // Convert from NDC depth [-1, 1] to linear depth [near, far]
    // For perspective projection: linearZ = 2 * near * far / (far + near - ndcZ * (far - near))
    return (2 * near * far) / (far + near - ndcDepth * (far - near));
  }

  // For debugging: get statistics
  getStats(): { min: number; max: number; avg: number; coverage: number } {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let count = 0;

    for (let i = 0; i < this.data.length; i++) {
      const d = this.data[i];
      if (d !== Infinity && d !== -Infinity) {
        min = Math.min(min, d);
        max = Math.max(max, d);
        sum += d;
        count++;
      }
    }

    return {
      min: count > 0 ? min : 0,
      max: count > 0 ? max : 0,
      avg: count > 0 ? sum / count : 0,
      coverage: count / this.data.length
    };
  }

  // Convert depth buffer to ASCII visualization
  // Uses characters to represent depth: ' ' = nothing, '.' = far, '#' = close
  toAsciiMap(): string {
    const chars = ' .:-=+*#%@';
    const stats = this.getStats();
    const lines: string[] = [];

    // Add header with stats
    lines.push(`Depth Buffer ${this.width}x${this.height}`);
    lines.push(`Min: ${stats.min.toFixed(3)}, Max: ${stats.max.toFixed(3)}, Coverage: ${(stats.coverage * 100).toFixed(1)}%`);
    lines.push('');

    for (let y = 0; y < this.height; y++) {
      let line = '';
      for (let x = 0; x < this.width; x++) {
        const d = this.data[y * this.width + x];
        if (d === Infinity) {
          line += ' ';
        } else {
          // Normalize depth to 0-1 range based on actual min/max
          const range = stats.max - stats.min;
          const normalized = range > 0 ? (d - stats.min) / range : 0;
          // Invert so closer = denser character
          const inverted = 1 - normalized;
          const charIndex = Math.floor(inverted * (chars.length - 1));
          line += chars[Math.max(0, Math.min(chars.length - 1, charIndex))];
        }
      }
      lines.push(line);
    }

    return lines.join('\n');
  }
}
