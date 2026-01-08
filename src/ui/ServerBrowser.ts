// Server browser UI for CS-CLI multiplayer
// Displays available rooms and allows creating/joining games

import { RoomInfo, RoomConfig, GameModeType, BotDifficulty } from '../shared/types/Protocol.js';

export type ServerBrowserScreen = 'connecting' | 'room_list' | 'create_room' | 'joining' | 'error';

export interface ServerBrowserState {
  screen: ServerBrowserScreen;
  selectedIndex: number;
  rooms: RoomInfo[];
  error: string | null;
  serverUrl: string;

  // Create room form state
  createRoomConfig: RoomConfig;
  createRoomField: number;  // Which field is selected (0-6)
}

// Default room configuration
const DEFAULT_ROOM_CONFIG: RoomConfig = {
  name: 'My Game',
  map: 'dm_arena',
  mode: 'deathmatch',
  maxPlayers: 8,
  botCount: 0,
  botDifficulty: 'medium',
  isPrivate: false,
};

export class ServerBrowser {
  private state: ServerBrowserState;
  private playerName: string = 'Player';

  // Create room field labels
  private createRoomFields = [
    'Room Name',
    'Map',
    'Mode',
    'Max Players',
    'Bots',
    'Bot Difficulty',
    'Private',
  ];

  // Available options
  private maps = ['dm_arena'];
  private modes: GameModeType[] = ['deathmatch', 'competitive'];
  private difficulties: BotDifficulty[] = ['easy', 'medium', 'hard'];
  private maxPlayerOptions = [2, 4, 6, 8, 10];
  private botCountOptions = [0, 1, 2, 3, 4, 5, 6, 7, 8];

  constructor() {
    this.state = {
      screen: 'connecting',
      selectedIndex: 0,
      rooms: [],
      error: null,
      serverUrl: 'ws://localhost:8080',
      createRoomConfig: { ...DEFAULT_ROOM_CONFIG },
      createRoomField: 0,
    };
  }

  getState(): ServerBrowserState {
    return this.state;
  }

  setPlayerName(name: string): void {
    this.playerName = name;
  }

  getPlayerName(): string {
    return this.playerName;
  }

  // ============ State Transitions ============

  setConnecting(): void {
    this.state.screen = 'connecting';
    this.state.error = null;
  }

  setConnected(): void {
    this.state.screen = 'room_list';
    this.state.error = null;
  }

  setError(error: string): void {
    this.state.screen = 'error';
    this.state.error = error;
  }

  setJoining(): void {
    this.state.screen = 'joining';
    this.state.error = null;
  }

  updateRooms(rooms: RoomInfo[]): void {
    this.state.rooms = rooms;
    // Clamp selected index
    if (this.state.selectedIndex >= rooms.length) {
      this.state.selectedIndex = Math.max(0, rooms.length - 1);
    }
  }

  // ============ Navigation ============

  getCurrentScreen(): ServerBrowserScreen {
    return this.state.screen;
  }

  getSelectedIndex(): number {
    return this.state.selectedIndex;
  }

  getRooms(): RoomInfo[] {
    return this.state.rooms;
  }

  getSelectedRoom(): RoomInfo | null {
    if (this.state.screen !== 'room_list' || this.state.rooms.length === 0) {
      return null;
    }
    return this.state.rooms[this.state.selectedIndex] || null;
  }

  getCreateRoomConfig(): RoomConfig {
    return this.state.createRoomConfig;
  }

  getCreateRoomField(): number {
    return this.state.createRoomField;
  }

  getCreateRoomFields(): string[] {
    return this.createRoomFields;
  }

  getError(): string | null {
    return this.state.error;
  }

  // ============ Room List Actions ============

  moveUp(): void {
    if (this.state.screen === 'room_list') {
      if (this.state.rooms.length > 0) {
        this.state.selectedIndex = (this.state.selectedIndex - 1 + this.state.rooms.length) % this.state.rooms.length;
      }
    } else if (this.state.screen === 'create_room') {
      this.state.createRoomField = (this.state.createRoomField - 1 + this.createRoomFields.length) % this.createRoomFields.length;
    }
  }

  moveDown(): void {
    if (this.state.screen === 'room_list') {
      if (this.state.rooms.length > 0) {
        this.state.selectedIndex = (this.state.selectedIndex + 1) % this.state.rooms.length;
      }
    } else if (this.state.screen === 'create_room') {
      this.state.createRoomField = (this.state.createRoomField + 1) % this.createRoomFields.length;
    }
  }

  // Cycle through options for create room fields
  cycleLeft(): void {
    if (this.state.screen !== 'create_room') return;
    this.cycleCreateRoomField(-1);
  }

  cycleRight(): void {
    if (this.state.screen !== 'create_room') return;
    this.cycleCreateRoomField(1);
  }

  private cycleCreateRoomField(direction: number): void {
    const config = this.state.createRoomConfig;
    const field = this.state.createRoomField;

    switch (field) {
      case 1: // Map
        const mapIdx = this.maps.indexOf(config.map);
        config.map = this.maps[(mapIdx + direction + this.maps.length) % this.maps.length];
        break;
      case 2: // Mode
        const modeIdx = this.modes.indexOf(config.mode);
        config.mode = this.modes[(modeIdx + direction + this.modes.length) % this.modes.length];
        break;
      case 3: // Max Players
        const playerIdx = this.maxPlayerOptions.indexOf(config.maxPlayers);
        config.maxPlayers = this.maxPlayerOptions[(playerIdx + direction + this.maxPlayerOptions.length) % this.maxPlayerOptions.length];
        break;
      case 4: // Bots
        const botIdx = this.botCountOptions.indexOf(config.botCount);
        config.botCount = this.botCountOptions[(botIdx + direction + this.botCountOptions.length) % this.botCountOptions.length];
        break;
      case 5: // Bot Difficulty
        const diffIdx = this.difficulties.indexOf(config.botDifficulty);
        config.botDifficulty = this.difficulties[(diffIdx + direction + this.difficulties.length) % this.difficulties.length];
        break;
      case 6: // Private
        config.isPrivate = !config.isPrivate;
        break;
    }
  }

  // Get display value for create room field
  getFieldValue(fieldIndex: number): string {
    const config = this.state.createRoomConfig;
    switch (fieldIndex) {
      case 0: return config.name;
      case 1: return config.map;
      case 2: return config.mode === 'deathmatch' ? 'Deathmatch' : 'Competitive';
      case 3: return config.maxPlayers.toString();
      case 4: return config.botCount.toString();
      case 5: return config.botDifficulty.charAt(0).toUpperCase() + config.botDifficulty.slice(1);
      case 6: return config.isPrivate ? 'Yes' : 'No';
      default: return '';
    }
  }

  // Set room name (text input)
  setRoomName(name: string): void {
    this.state.createRoomConfig.name = name;
  }

  // ============ Actions ============

  // Returns action to perform
  select(): { action: 'join' | 'create' | 'back' | 'refresh' | 'none'; roomId?: string; config?: RoomConfig } {
    if (this.state.screen === 'room_list') {
      const room = this.getSelectedRoom();
      if (room) {
        return { action: 'join', roomId: room.id };
      }
      return { action: 'none' };
    } else if (this.state.screen === 'create_room') {
      return { action: 'create', config: this.state.createRoomConfig };
    }
    return { action: 'none' };
  }

  openCreateRoom(): void {
    this.state.screen = 'create_room';
    this.state.createRoomField = 0;
    this.state.createRoomConfig = { ...DEFAULT_ROOM_CONFIG };
  }

  back(): boolean {
    if (this.state.screen === 'create_room') {
      this.state.screen = 'room_list';
      return false; // Don't exit browser
    } else if (this.state.screen === 'error') {
      this.state.screen = 'room_list';
      return false;
    }
    return true; // Exit browser
  }

  // Handle key input
  handleKey(key: string): { action: 'join' | 'create' | 'back' | 'refresh' | 'none'; roomId?: string; config?: RoomConfig } {
    // Universal back
    if (key === 'escape' || key === 'backspace') {
      if (this.back()) {
        return { action: 'back' };
      }
      return { action: 'none' };
    }

    switch (this.state.screen) {
      case 'room_list':
        return this.handleRoomListKey(key);
      case 'create_room':
        return this.handleCreateRoomKey(key);
      case 'error':
        if (key === 'enter' || key === 'space') {
          this.state.screen = 'room_list';
        }
        return { action: 'none' };
      default:
        return { action: 'none' };
    }
  }

  private handleRoomListKey(key: string): { action: 'join' | 'create' | 'back' | 'refresh' | 'none'; roomId?: string } {
    switch (key) {
      case 'up':
      case 'w':
        this.moveUp();
        return { action: 'none' };
      case 'down':
      case 's':
        this.moveDown();
        return { action: 'none' };
      case 'enter':
      case 'space':
        return this.select();
      case 'c':
      case 'C':
        this.openCreateRoom();
        return { action: 'none' };
      case 'r':
      case 'R':
        return { action: 'refresh' };
      default:
        return { action: 'none' };
    }
  }

  private handleCreateRoomKey(key: string): { action: 'create' | 'none'; config?: RoomConfig } {
    switch (key) {
      case 'up':
      case 'w':
        this.moveUp();
        return { action: 'none' };
      case 'down':
      case 's':
        this.moveDown();
        return { action: 'none' };
      case 'left':
      case 'a':
        this.cycleLeft();
        return { action: 'none' };
      case 'right':
      case 'd':
        this.cycleRight();
        return { action: 'none' };
      case 'enter':
        if (this.state.createRoomField === 0) {
          // Room name field - could trigger text input
          return { action: 'none' };
        }
        return { action: 'create', config: this.state.createRoomConfig };
      default:
        return { action: 'none' };
    }
  }

  // ============ Screen Titles ============

  getScreenTitle(): string {
    switch (this.state.screen) {
      case 'connecting':
        return 'Connecting...';
      case 'room_list':
        return 'Server Browser';
      case 'create_room':
        return 'Create Room';
      case 'joining':
        return 'Joining...';
      case 'error':
        return 'Error';
      default:
        return '';
    }
  }

  getHelpText(): string {
    switch (this.state.screen) {
      case 'room_list':
        return '[R] Refresh | [C] Create Room | [Enter] Join | [Esc] Back';
      case 'create_room':
        return '[W/S] Select | [A/D] Change | [Enter] Create | [Esc] Back';
      default:
        return '[Esc] Back';
    }
  }
}

// Singleton
let serverBrowserInstance: ServerBrowser | null = null;

export function getServerBrowser(): ServerBrowser {
  if (!serverBrowserInstance) {
    serverBrowserInstance = new ServerBrowser();
  }
  return serverBrowserInstance;
}

export function resetServerBrowser(): void {
  serverBrowserInstance = new ServerBrowser();
}
