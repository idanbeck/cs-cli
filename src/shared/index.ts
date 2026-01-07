// Shared code re-exports for CS-CLI
// This module provides common types, utilities, and game logic
// that can be used by both client and server

// Math utilities
export * from './math/Vector3.js';
export * from './math/Matrix4.js';
export * from './math/Quaternion.js';
export * from './math/MathUtils.js';

// Types
export * from './types/GameTypes.js';
export * from './types/MapFormat.js';
export * from './types/Protocol.js';

// Game logic
export * from './game/Weapon.js';
export * from './game/Economy.js';
export * from './game/Team.js';
export * from './game/DroppedWeapon.js';
export * from './game/MatchState.js';

// Physics
export * from './physics/Collision.js';
