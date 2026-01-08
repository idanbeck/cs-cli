// Network protocol message type definitions for CS-CLI multiplayer

// ============ Shared Types ============

export type TeamId = 'T' | 'CT' | 'SPECTATOR';
export type GameModeType = 'deathmatch' | 'competitive';
export type GamePhase =
  | 'pre_match'
  | 'warmup'
  | 'freeze'
  | 'live'
  | 'round_end'
  | 'halftime'
  | 'match_end';

export type WeaponType = 'knife' | 'pistol' | 'rifle' | 'shotgun' | 'sniper';
export type BotDifficulty = 'easy' | 'medium' | 'hard';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// ============ Room Configuration ============

export interface RoomConfig {
  name: string;
  map: string;
  mode: GameModeType;
  maxPlayers: number;
  botCount: number;
  botDifficulty: BotDifficulty;
  isPrivate: boolean;
  password?: string;
}

export interface RoomInfo {
  id: string;
  name: string;
  map: string;
  mode: GameModeType;
  playerCount: number;
  maxPlayers: number;
  botCount: number;
  isPrivate: boolean;
  phase: GamePhase;
}

// ============ Player Input ============

export interface PlayerInput {
  forward: number;   // -1 to 1
  strafe: number;    // -1 to 1 (left/right)
  yaw: number;       // Current yaw angle
  pitch: number;     // Current pitch angle
  jump: boolean;
  crouch: boolean;
}

// ============ State Snapshots ============

export interface PlayerSnapshot {
  id: string;
  name: string;
  position: Vec3;
  yaw: number;
  pitch: number;
  health: number;
  armor: number;
  team: TeamId;
  isAlive: boolean;
  currentWeapon: WeaponType;
  money: number;
  kills: number;
  deaths: number;
}

export interface BotSnapshot {
  id: string;
  name: string;
  position: Vec3;
  yaw: number;
  pitch: number;
  health: number;
  armor: number;
  team: TeamId;
  isAlive: boolean;
  currentWeapon: WeaponType;
  kills: number;
  deaths: number;
}

export interface DroppedWeaponSnapshot {
  id: string;
  weaponType: WeaponType;
  position: Vec3;
}

export interface GameStateSnapshot {
  tick: number;
  timestamp: number;
  phase: GamePhase;
  roundTime: number;
  freezeTime: number;
  players: PlayerSnapshot[];
  bots: BotSnapshot[];
  droppedWeapons: DroppedWeaponSnapshot[];
  tScore: number;
  ctScore: number;
  roundNumber: number;
}

// ============ Events ============

export interface KillEvent {
  killerId: string;
  killerName: string;
  victimId: string;
  victimName: string;
  weapon: WeaponType;
  headshot: boolean;
}

export interface HitEvent {
  attackerId: string;
  victimId: string;
  damage: number;
  headshot: boolean;
}

export interface FireEvent {
  playerId: string;
  origin: Vec3;
  direction: Vec3;
  weapon: WeaponType;
}

// ============ Client → Server Messages ============

export interface ListRoomsMessage {
  type: 'list_rooms';
}

export interface CreateRoomMessage {
  type: 'create_room';
  config: RoomConfig;
}

export interface JoinRoomMessage {
  type: 'join_room';
  roomId: string;
  playerName: string;
  password?: string;
}

export interface LeaveRoomMessage {
  type: 'leave_room';
}

export interface PlayerInputMessage {
  type: 'input';
  input: PlayerInput;
  sequence: number;  // For client-side prediction reconciliation
}

export interface FireMessage {
  type: 'fire';
}

export interface ReloadMessage {
  type: 'reload';
}

export interface BuyWeaponMessage {
  type: 'buy_weapon';
  weaponName: string;
}

export interface PickupWeaponMessage {
  type: 'pickup_weapon';
  weaponId: string;
}

export interface DropWeaponMessage {
  type: 'drop_weapon';
}

export interface SelectWeaponMessage {
  type: 'select_weapon';
  slot: number;
}

export interface ChatMessage {
  type: 'chat';
  message: string;
  teamOnly: boolean;
}

export interface ReadyMessage {
  type: 'ready';
}

export interface StartGameMessage {
  type: 'start_game';
}

export interface ChangeTeamMessage {
  type: 'change_team';
  team: TeamId;
}

export type ClientMessage =
  | ListRoomsMessage
  | CreateRoomMessage
  | JoinRoomMessage
  | LeaveRoomMessage
  | PlayerInputMessage
  | FireMessage
  | ReloadMessage
  | BuyWeaponMessage
  | PickupWeaponMessage
  | DropWeaponMessage
  | SelectWeaponMessage
  | ChatMessage
  | ReadyMessage
  | StartGameMessage
  | ChangeTeamMessage;

// ============ Server → Client Messages ============

export interface RoomListMessage {
  type: 'room_list';
  rooms: RoomInfo[];
}

export interface RoomJoinedMessage {
  type: 'room_joined';
  roomId: string;
  playerId: string;
  room: RoomInfo;
}

export interface RoomErrorMessage {
  type: 'room_error';
  error: string;
}

export interface PlayerJoinedMessage {
  type: 'player_joined';
  playerId: string;
  playerName: string;
}

export interface PlayerLeftMessage {
  type: 'player_left';
  playerId: string;
  playerName: string;
}

export interface GameStateMessage {
  type: 'game_state';
  state: GameStateSnapshot;
}

export interface PhaseChangeMessage {
  type: 'phase_change';
  phase: GamePhase;
  roundNumber: number;
  tScore: number;
  ctScore: number;
}

export interface FireEventMessage {
  type: 'fire_event';
  event: FireEvent;
}

export interface HitEventMessage {
  type: 'hit_event';
  event: HitEvent;
}

export interface KillEventMessage {
  type: 'kill_event';
  event: KillEvent;
}

export interface SpawnEventMessage {
  type: 'spawn_event';
  entityId: string;
  entityType: 'player' | 'bot';
  position: Vec3;
  team: TeamId;
}

export interface WeaponDroppedMessage {
  type: 'weapon_dropped';
  weaponId: string;
  weaponType: WeaponType;
  position: Vec3;
}

export interface WeaponPickedUpMessage {
  type: 'weapon_picked_up';
  weaponId: string;
  playerId: string;
}

export interface ChatReceivedMessage {
  type: 'chat_received';
  senderId: string;
  senderName: string;
  message: string;
  teamOnly: boolean;
}

export interface PlayerReadyMessage {
  type: 'player_ready';
  playerId: string;
  ready: boolean;
}

export interface GameStartingMessage {
  type: 'game_starting';
  countdown: number;
}

export interface AssignedTeamMessage {
  type: 'assigned_team';
  team: TeamId;
}

export interface InputAckMessage {
  type: 'input_ack';
  sequence: number;
  position: Vec3;
}

export type ServerMessage =
  | RoomListMessage
  | RoomJoinedMessage
  | RoomErrorMessage
  | PlayerJoinedMessage
  | PlayerLeftMessage
  | GameStateMessage
  | PhaseChangeMessage
  | FireEventMessage
  | HitEventMessage
  | KillEventMessage
  | SpawnEventMessage
  | WeaponDroppedMessage
  | WeaponPickedUpMessage
  | ChatReceivedMessage
  | PlayerReadyMessage
  | GameStartingMessage
  | AssignedTeamMessage
  | InputAckMessage;

// ============ Pool Server Info ============

export interface PoolServerInfo {
  id: string;
  name: string;
  endpoint: string;         // WebSocket URL for direct client connections
  maxRooms: number;
  currentRooms: number;
  playerCount: number;
  load: number;             // 0-100 percentage
  lastHeartbeat: number;    // Timestamp
  rooms: RoomInfo[];
}

export interface AggregatedRoomInfo extends RoomInfo {
  poolId: string;           // Which pool server hosts this room
  poolName: string;         // Display name of pool server
  poolEndpoint: string;     // Direct connection URL
}

// ============ Pool Server → Hub Messages ============

export interface PoolRegisterMessage {
  type: 'pool_register';
  serverName: string;
  endpoint: string;         // Public endpoint for client connections
  maxRooms: number;
}

export interface PoolHeartbeatMessage {
  type: 'pool_heartbeat';
  rooms: RoomInfo[];
  playerCount: number;
  load: number;
}

export interface PoolRoomCreatedMessage {
  type: 'pool_room_created';
  room: RoomInfo;
}

export interface PoolRoomClosedMessage {
  type: 'pool_room_closed';
  roomId: string;
}

export interface PoolUnregisterMessage {
  type: 'pool_unregister';
}

export type PoolToHubMessage =
  | PoolRegisterMessage
  | PoolHeartbeatMessage
  | PoolRoomCreatedMessage
  | PoolRoomClosedMessage
  | PoolUnregisterMessage;

// ============ Hub → Pool Server Messages ============

export interface PoolAcceptedMessage {
  type: 'pool_accepted';
  poolId: string;
}

export interface PoolRejectedMessage {
  type: 'pool_rejected';
  reason: string;
}

export interface PoolPingMessage {
  type: 'pool_ping';
}

export type HubToPoolMessage =
  | PoolAcceptedMessage
  | PoolRejectedMessage
  | PoolPingMessage;

// ============ Client → Hub Messages ============

export interface HubListRoomsMessage {
  type: 'hub_list_rooms';
}

export interface HubGetEndpointMessage {
  type: 'hub_get_endpoint';
  roomId: string;
}

export interface HubCreateRoomMessage {
  type: 'hub_create_room';
  config: RoomConfig;
  preferredPool?: string;   // Optional: prefer specific pool server
}

export type ClientToHubMessage =
  | HubListRoomsMessage
  | HubGetEndpointMessage
  | HubCreateRoomMessage;

// ============ Hub → Client Messages ============

export interface HubRoomListMessage {
  type: 'hub_room_list';
  rooms: AggregatedRoomInfo[];
  pools: { id: string; name: string; playerCount: number }[];
}

export interface HubRoomEndpointMessage {
  type: 'hub_room_endpoint';
  roomId: string;
  endpoint: string;
  token: string;            // Auth token for joining
}

export interface HubRoomNotFoundMessage {
  type: 'hub_room_not_found';
  roomId: string;
}

export interface HubRoomCreatedMessage {
  type: 'hub_room_created';
  roomId: string;
  endpoint: string;
  token: string;
}

export interface HubErrorMessage {
  type: 'hub_error';
  error: string;
}

export type HubToClientMessage =
  | HubRoomListMessage
  | HubRoomEndpointMessage
  | HubRoomNotFoundMessage
  | HubRoomCreatedMessage
  | HubErrorMessage;

// ============ Helpers ============

export function isClientMessage(msg: unknown): msg is ClientMessage {
  return typeof msg === 'object' && msg !== null && 'type' in msg;
}

export function parseClientMessage(data: string): ClientMessage | null {
  try {
    const msg = JSON.parse(data);
    if (isClientMessage(msg)) {
      return msg;
    }
    return null;
  } catch {
    return null;
  }
}

export function serializeServerMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}

export function isPoolToHubMessage(msg: unknown): msg is PoolToHubMessage {
  return typeof msg === 'object' && msg !== null && 'type' in msg;
}

export function parsePoolToHubMessage(data: string): PoolToHubMessage | null {
  try {
    const msg = JSON.parse(data);
    if (isPoolToHubMessage(msg)) {
      return msg;
    }
    return null;
  } catch {
    return null;
  }
}

export function isClientToHubMessage(msg: unknown): msg is ClientToHubMessage {
  return typeof msg === 'object' && msg !== null && 'type' in msg;
}

export function parseClientToHubMessage(data: string): ClientToHubMessage | null {
  try {
    const msg = JSON.parse(data);
    if (isClientToHubMessage(msg)) {
      return msg;
    }
    return null;
  } catch {
    return null;
  }
}

export function serializeHubToPoolMessage(msg: HubToPoolMessage): string {
  return JSON.stringify(msg);
}

export function serializeHubToClientMessage(msg: HubToClientMessage): string {
  return JSON.stringify(msg);
}

export function serializePoolToHubMessage(msg: PoolToHubMessage): string {
  return JSON.stringify(msg);
}
