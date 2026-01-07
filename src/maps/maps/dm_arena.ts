// DM Arena - A large deathmatch map for CS-CLI

import { MapDef } from '../MapFormat.js';

export const dm_arena: MapDef = {
  name: 'DM Arena',
  author: 'CS-CLI',
  description: 'A large deathmatch arena with cover and elevated positions',

  bounds: {
    min: [-60, 0, -60],
    max: [60, 20, 60]
  },

  environment: {
    skyColor: [135, 206, 235],  // Sky blue
    ambientLight: 0.4,
    fogDistance: 120
  },

  brushes: [
    // === OUTER WALLS ===
    // North wall
    { position: [0, 6, -58], size: [120, 12, 2], material: 'brick' },
    // South wall
    { position: [0, 6, 58], size: [120, 12, 2], material: 'brick' },
    // East wall
    { position: [58, 6, 0], size: [2, 12, 116], material: 'brick' },
    // West wall
    { position: [-58, 6, 0], size: [2, 12, 116], material: 'brick' },

    // === CORNER TOWERS ===
    { position: [-54, 5, -54], size: [6, 10, 6], material: 'concrete_dark' },
    { position: [54, 5, -54], size: [6, 10, 6], material: 'concrete_dark' },
    { position: [-54, 5, 54], size: [6, 10, 6], material: 'concrete_dark' },
    { position: [54, 5, 54], size: [6, 10, 6], material: 'concrete_dark' },

    // === CENTER STRUCTURE ===
    // Central raised platform
    { position: [0, 1, 0], size: [20, 2, 20], material: 'metal_floor' },
    // Central pillar/cover
    { position: [0, 4, 0], size: [5, 8, 5], material: 'concrete' },

    // === QUADRANT BUILDINGS (4 small buildings in each quadrant) ===
    // Northwest building
    { position: [-35, 3, -35], size: [12, 6, 10], material: 'concrete' },
    { position: [-35, 6.5, -35], size: [14, 1, 12], material: 'metal_floor' }, // Roof
    // Northeast building
    { position: [35, 3, -35], size: [10, 6, 12], material: 'concrete' },
    { position: [35, 6.5, -35], size: [12, 1, 14], material: 'metal_floor' },
    // Southwest building
    { position: [-35, 3, 35], size: [10, 6, 12], material: 'concrete' },
    { position: [-35, 6.5, 35], size: [12, 1, 14], material: 'metal_floor' },
    // Southeast building
    { position: [35, 3, 35], size: [12, 6, 10], material: 'concrete' },
    { position: [35, 6.5, 35], size: [14, 1, 12], material: 'metal_floor' },

    // === CRATE CLUSTERS (spread around the map) ===
    // NW crates
    { position: [-20, 1, -20], size: [3, 2, 3], material: 'crate' },
    { position: [-20, 3, -20], size: [2, 2, 2], material: 'crate' },
    { position: [-17, 1, -18], size: [2, 2, 2], material: 'crate_dark' },

    // NE crates
    { position: [20, 1, -20], size: [3, 2, 3], material: 'crate' },
    { position: [18, 1, -17], size: [2, 2, 2], material: 'crate_dark' },

    // SW crates
    { position: [-20, 1, 20], size: [3, 2, 3], material: 'crate' },
    { position: [-17, 1, 18], size: [2, 2, 2], material: 'crate_dark' },

    // SE crates
    { position: [20, 1, 20], size: [3, 2, 3], material: 'crate' },
    { position: [20, 3, 20], size: [2, 2, 2], material: 'crate' },
    { position: [17, 1, 18], size: [2, 2, 2], material: 'crate_dark' },

    // Far corner crates
    { position: [-45, 1, -20], size: [3, 2, 3], material: 'crate' },
    { position: [45, 1, -20], size: [3, 2, 3], material: 'crate' },
    { position: [-45, 1, 20], size: [3, 2, 3], material: 'crate' },
    { position: [45, 1, 20], size: [3, 2, 3], material: 'crate' },

    // === COVER WALLS (spread around map) ===
    // Inner ring of cover walls
    { position: [-15, 2, 0], size: [1, 4, 10], material: 'concrete' },
    { position: [15, 2, 0], size: [1, 4, 10], material: 'concrete' },
    { position: [0, 2, -15], size: [10, 4, 1], material: 'concrete' },
    { position: [0, 2, 15], size: [10, 4, 1], material: 'concrete' },

    // Mid ring of cover walls
    { position: [-30, 2, 0], size: [1, 4, 8], material: 'brick' },
    { position: [30, 2, 0], size: [1, 4, 8], material: 'brick' },
    { position: [0, 2, -30], size: [8, 4, 1], material: 'brick' },
    { position: [0, 2, 30], size: [8, 4, 1], material: 'brick' },

    // Diagonal cover walls
    { position: [-25, 2, -25], size: [6, 4, 1], material: 'concrete' },
    { position: [25, 2, -25], size: [6, 4, 1], material: 'concrete' },
    { position: [-25, 2, 25], size: [6, 4, 1], material: 'concrete' },
    { position: [25, 2, 25], size: [6, 4, 1], material: 'concrete' },

    // === ELEVATED PLATFORMS ===
    // North platform
    { position: [0, 2, -42], size: [16, 4, 8], material: 'metal_floor' },
    // Ramp to north platform
    { position: [12, 1, -42], size: [6, 2, 6], material: 'metal' },

    // South platform
    { position: [0, 2, 42], size: [16, 4, 8], material: 'metal_floor' },
    // Ramp to south platform
    { position: [-12, 1, 42], size: [6, 2, 6], material: 'metal' },

    // East platform
    { position: [42, 2, 0], size: [8, 4, 16], material: 'metal_floor' },
    // Ramp to east platform
    { position: [42, 1, 12], size: [6, 2, 6], material: 'metal' },

    // West platform
    { position: [-42, 2, 0], size: [8, 4, 16], material: 'metal_floor' },
    // Ramp to west platform
    { position: [-42, 1, -12], size: [6, 2, 6], material: 'metal' },

    // === BARRELS (scattered) ===
    { position: [-40, 1, 10], size: [1.5, 2, 1.5], material: 'barrel' },
    { position: [-41, 1, 12], size: [1.5, 2, 1.5], material: 'barrel' },
    { position: [40, 1, -10], size: [1.5, 2, 1.5], material: 'barrel' },
    { position: [41, 1, -12], size: [1.5, 2, 1.5], material: 'barrel' },
    { position: [-10, 1, 40], size: [1.5, 2, 1.5], material: 'barrel' },
    { position: [10, 1, -40], size: [1.5, 2, 1.5], material: 'barrel' },

    // === COLORED MARKERS (for orientation) ===
    // Red marker - north
    { position: [0, 0.3, -50], size: [3, 0.5, 3], material: 'red', collision: false },
    // Blue marker - south
    { position: [0, 0.3, 50], size: [3, 0.5, 3], material: 'blue', collision: false },
    // Green marker - west
    { position: [-50, 0.3, 0], size: [3, 0.5, 3], material: 'green', collision: false },
    // Yellow marker - east
    { position: [50, 0.3, 0], size: [3, 0.5, 3], material: 'yellow', collision: false },
  ],

  spawns: [
    // Corner spawns
    { position: [-48, 0.1, -48], angle: 45, team: 'DM' },
    { position: [48, 0.1, -48], angle: 135, team: 'DM' },
    { position: [-48, 0.1, 48], angle: -45, team: 'DM' },
    { position: [48, 0.1, 48], angle: -135, team: 'DM' },

    // Quadrant spawns (near buildings)
    { position: [-28, 0.1, -28], angle: 45, team: 'DM' },
    { position: [28, 0.1, -28], angle: 135, team: 'DM' },
    { position: [-28, 0.1, 28], angle: -45, team: 'DM' },
    { position: [28, 0.1, 28], angle: -135, team: 'DM' },

    // Cardinal direction spawns
    { position: [0, 0.1, -35], angle: 180, team: 'DM' },
    { position: [0, 0.1, 35], angle: 0, team: 'DM' },
    { position: [-35, 0.1, 0], angle: 90, team: 'DM' },
    { position: [35, 0.1, 0], angle: -90, team: 'DM' },

    // Mid-range spawns
    { position: [-18, 0.1, -10], angle: 60, team: 'DM' },
    { position: [18, 0.1, -10], angle: 120, team: 'DM' },
    { position: [-18, 0.1, 10], angle: -60, team: 'DM' },
    { position: [18, 0.1, 10], angle: -120, team: 'DM' },

    // Platform spawns
    { position: [0, 4.1, -42], angle: 180, team: 'DM' },
    { position: [0, 4.1, 42], angle: 0, team: 'DM' },
    { position: [42, 4.1, 0], angle: -90, team: 'DM' },
    { position: [-42, 4.1, 0], angle: 90, team: 'DM' },

    // Center area spawns
    { position: [-8, 0.1, -8], angle: 45, team: 'DM' },
    { position: [8, 0.1, 8], angle: -135, team: 'DM' },
  ]
};

export default dm_arena;
