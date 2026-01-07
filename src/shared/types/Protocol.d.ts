export type TeamId = 'T' | 'CT' | 'SPECTATOR';
export type GameModeType = 'deathmatch' | 'competitive';
export type GamePhase = 'pre_match' | 'warmup' | 'freeze' | 'live' | 'round_end' | 'halftime' | 'match_end';
export type WeaponType = 'knife' | 'pistol' | 'rifle' | 'shotgun' | 'sniper';
export type BotDifficulty = 'easy' | 'medium' | 'hard';
export interface Vec3 {
    x: number;
    y: number;
    z: number;
}
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
export interface PlayerInput {
    forward: number;
    strafe: number;
    yaw: number;
    pitch: number;
    jump: boolean;
    crouch: boolean;
}
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
    sequence: number;
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
export type ClientMessage = ListRoomsMessage | CreateRoomMessage | JoinRoomMessage | LeaveRoomMessage | PlayerInputMessage | FireMessage | ReloadMessage | BuyWeaponMessage | PickupWeaponMessage | DropWeaponMessage | SelectWeaponMessage | ChatMessage | ReadyMessage | StartGameMessage;
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
export type ServerMessage = RoomListMessage | RoomJoinedMessage | RoomErrorMessage | PlayerJoinedMessage | PlayerLeftMessage | GameStateMessage | PhaseChangeMessage | FireEventMessage | HitEventMessage | KillEventMessage | SpawnEventMessage | WeaponDroppedMessage | WeaponPickedUpMessage | ChatReceivedMessage | PlayerReadyMessage | GameStartingMessage | AssignedTeamMessage | InputAckMessage;
export declare function isClientMessage(msg: unknown): msg is ClientMessage;
export declare function parseClientMessage(data: string): ClientMessage | null;
export declare function serializeServerMessage(msg: ServerMessage): string;
