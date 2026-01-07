# CS-CLI

A terminal-based Counter-Strike clone with **true 3D mesh rendering** - not raycasting! Built entirely in TypeScript, rendering to your terminal using ANSI escape codes.

![Terminal FPS](https://img.shields.io/badge/Terminal-FPS-green)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)
![License](https://img.shields.io/badge/License-PolyForm%20NC-orange)

## Features

- **Real 3D Engine**: Software rasterizer with perspective projection, z-buffering, and triangle rendering
- **Mouse Look**: Full mouse capture with smooth sensitivity controls (SGR 1006 mode)
- **Weapons**: Knife, pistol, rifle, shotgun, and sniper with distinct behaviors
- **Bot AI**: Bots with pathfinding, combat behaviors, and difficulty levels
- **Spatial Audio**: Procedural 8-bit sound effects with stereo panning
- **Deathmatch Mode**: Kill limit, respawning, scoreboard, and kill feed
- **Debug Console**: Source-engine style console with ~ key

## Requirements

- Node.js 18+ or Bun
- A modern terminal with mouse support (iTerm2, Ghostty, Kitty, Alacritty, etc.)
- macOS, Linux, or WSL

## Installation

```bash
git clone https://github.com/idanbeck/cs-cli.git
cd cs-cli
npm install
```

## Running

```bash
# Recommended - suppresses audio library warnings
npm run play

# Or with bun for faster startup
npm run dev
```

## Controls

| Key | Action |
|-----|--------|
| `WASD` | Move |
| `Mouse` | Look around (when captured) |
| `Arrow Keys` | Look around (keyboard fallback) |
| `Click` / `C` | Capture/release mouse |
| `Space` | Jump |
| `F` | Fire weapon |
| `R` | Reload |
| `1-5` | Select weapon |
| `Tab` | Show scoreboard |
| `~` | Open debug console |
| `Esc` | Release mouse / Quit |
| `Q` | Quit |

## Console Commands

Press `~` to open the console:

| Command | Description |
|---------|-------------|
| `help` | List all commands |
| `sensitivity <0.1-10>` | Set mouse sensitivity |
| `fov <30-120>` | Set field of view |
| `bot_add [easy\|medium\|hard]` | Spawn a bot |
| `bot_kick` | Remove all bots |
| `god` | Toggle invincibility |
| `noclip` | Toggle collision |
| `tp <x> <y> <z>` | Teleport |
| `stats` | Show K/D ratio |

## Architecture

```
src/
├── engine/          # 3D rendering pipeline
│   ├── math/        # Vector3, Matrix4, Quaternion
│   ├── Camera.ts    # View/projection matrices
│   ├── Rasterizer.ts # Triangle rasterization
│   └── Renderer.ts  # Main render loop
├── game/            # Game logic
│   ├── Player.ts    # Player state
│   ├── Weapon.ts    # Weapon definitions
│   └── GameMode.ts  # Deathmatch rules
├── ai/              # Bot AI
│   ├── Bot.ts       # Bot entity
│   └── Pathfinding.ts # A* navigation
├── audio/           # Sound system
│   └── SoundEngine.ts # Procedural 8-bit audio
└── ui/              # UI components
    └── Console.ts   # Debug console
```

## How It Works

Unlike traditional terminal "3D" games that use raycasting (like the original Wolfenstein 3D), CS-CLI uses a complete 3D rendering pipeline:

1. **Mesh Geometry**: Maps and objects are defined as triangle meshes
2. **Matrix Transforms**: Model → World → View → Projection space
3. **Triangle Rasterization**: Barycentric coordinate interpolation
4. **Z-Buffer**: Proper depth sorting for overlapping geometry
5. **ANSI Output**: Converts framebuffer to terminal escape sequences

This allows for true 3D features like:
- Ramps and stairs (not just flat floors)
- Objects at any angle
- Proper perspective projection
- Billboard sprites for entities

## License

This project uses the [PolyForm Noncommercial License 1.0.0](LICENSE).

**Free for**: Personal use, education, research, hobby projects, non-profits

**Requires license for**: Commercial use, commercial products, revenue-generating applications

For commercial licensing, contact: [Idan Beck](https://github.com/idanbeck)

## Credits

Built with:
- [Ink](https://github.com/vadimdemedes/ink) - React for CLI
- [TypeScript](https://www.typescriptlang.org/)
- Lots of math and late nights
