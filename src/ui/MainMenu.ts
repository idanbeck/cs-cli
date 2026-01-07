// Main menu UI for CS-CLI
// Handles main menu navigation, mode selection, map selection

import { GameModeType } from '../game/GameMode.js';

export type MenuScreen = 'main' | 'mode_select' | 'map_select' | 'settings' | 'help';

export interface MapInfo {
  id: string;
  name: string;
  description: string;
  supportedModes: GameModeType[];
}

export interface MainMenuState {
  screen: MenuScreen;
  selectedIndex: number;
  selectedMode: GameModeType;
  selectedMap: string;
}

// Available maps
export const AVAILABLE_MAPS: MapInfo[] = [
  {
    id: 'dm_arena',
    name: 'Arena',
    description: 'Classic arena for close-quarters combat',
    supportedModes: ['deathmatch', 'competitive'],
  },
];

export type InputStatus = {
  mode: 'native' | 'stdin';
  working: boolean;
  message: string;
};

export class MainMenu {
  private state: MainMenuState;
  private inputStatus: InputStatus = {
    mode: 'stdin',
    working: false,
    message: 'Checking input...',
  };

  // Menu items for each screen
  private mainMenuItems = ['Play', 'Help', 'Settings', 'Quit'];

  // Help content
  private helpLines = [
    '=== CONTROLS ===',
    '',
    'WASD / Arrows  - Move / Look',
    'Mouse          - Look (click to capture)',
    'C              - Toggle mouse capture',
    'Space          - Jump',
    'F / Click      - Fire weapon',
    'R              - Reload',
    'E              - Pick up weapon',
    'B              - Buy menu (freeze phase)',
    '1-5            - Select weapon',
    'Tab            - Scoreboard',
    '~              - Debug console',
    'Esc            - Release mouse / Quit',
    'Q              - Quit',
    '',
    '=== TIPS ===',
    '',
    'Tap keys for fine movement',
    'Hold keys for full speed',
    '',
    'Press any key to go back...',
  ];
  private modeMenuItems: { label: string; mode: GameModeType }[] = [
    { label: 'Deathmatch (FFA)', mode: 'deathmatch' },
    { label: 'Competitive (Team)', mode: 'competitive' },
  ];

  constructor() {
    this.state = {
      screen: 'main',
      selectedIndex: 0,
      selectedMode: 'deathmatch',
      selectedMap: 'dm_arena',
    };
  }

  getState(): MainMenuState {
    return this.state;
  }

  setInputStatus(status: InputStatus): void {
    this.inputStatus = status;
  }

  getInputStatus(): InputStatus {
    return this.inputStatus;
  }

  getCurrentScreen(): MenuScreen {
    return this.state.screen;
  }

  getSelectedIndex(): number {
    return this.state.selectedIndex;
  }

  getSelectedMode(): GameModeType {
    return this.state.selectedMode;
  }

  getSelectedMap(): string {
    return this.state.selectedMap;
  }

  // Get current menu items based on screen
  getCurrentItems(): string[] {
    switch (this.state.screen) {
      case 'main':
        return this.mainMenuItems;
      case 'mode_select':
        return this.modeMenuItems.map(m => m.label);
      case 'map_select':
        return this.getAvailableMaps().map(m => m.name);
      case 'settings':
        return ['Back'];
      case 'help':
        return []; // Help screen has no selectable items
      default:
        return [];
    }
  }

  // Get help text lines
  getHelpLines(): string[] {
    return this.helpLines;
  }

  // Check if we're on the help screen
  isHelpScreen(): boolean {
    return this.state.screen === 'help';
  }

  // Get maps available for current mode
  getAvailableMaps(): MapInfo[] {
    return AVAILABLE_MAPS.filter(m =>
      m.supportedModes.includes(this.state.selectedMode)
    );
  }

  // Navigation
  moveUp(): void {
    const items = this.getCurrentItems();
    if (items.length === 0) return;
    this.state.selectedIndex = (this.state.selectedIndex - 1 + items.length) % items.length;
  }

  moveDown(): void {
    const items = this.getCurrentItems();
    if (items.length === 0) return;
    this.state.selectedIndex = (this.state.selectedIndex + 1) % items.length;
  }

  // Selection - returns true if game should start
  select(): { action: 'start_game' | 'quit' | 'navigate' | 'back'; mode?: GameModeType; map?: string } {
    switch (this.state.screen) {
      case 'main':
        return this.handleMainSelect();
      case 'mode_select':
        return this.handleModeSelect();
      case 'map_select':
        return this.handleMapSelect();
      case 'settings':
        return this.handleSettingsSelect();
      default:
        return { action: 'navigate' };
    }
  }

  private handleMainSelect(): { action: 'start_game' | 'quit' | 'navigate' | 'back'; mode?: GameModeType; map?: string } {
    const item = this.mainMenuItems[this.state.selectedIndex];
    switch (item) {
      case 'Play':
        this.state.screen = 'mode_select';
        this.state.selectedIndex = 0;
        return { action: 'navigate' };
      case 'Help':
        this.state.screen = 'help';
        this.state.selectedIndex = 0;
        return { action: 'navigate' };
      case 'Settings':
        this.state.screen = 'settings';
        this.state.selectedIndex = 0;
        return { action: 'navigate' };
      case 'Quit':
        return { action: 'quit' };
      default:
        return { action: 'navigate' };
    }
  }

  private handleModeSelect(): { action: 'start_game' | 'quit' | 'navigate' | 'back'; mode?: GameModeType; map?: string } {
    const mode = this.modeMenuItems[this.state.selectedIndex];
    if (mode) {
      this.state.selectedMode = mode.mode;
      this.state.screen = 'map_select';
      this.state.selectedIndex = 0;
    }
    return { action: 'navigate' };
  }

  private handleMapSelect(): { action: 'start_game' | 'quit' | 'navigate' | 'back'; mode?: GameModeType; map?: string } {
    const maps = this.getAvailableMaps();
    const selectedMap = maps[this.state.selectedIndex];
    if (selectedMap) {
      this.state.selectedMap = selectedMap.id;
      return {
        action: 'start_game',
        mode: this.state.selectedMode,
        map: this.state.selectedMap,
      };
    }
    return { action: 'navigate' };
  }

  private handleSettingsSelect(): { action: 'start_game' | 'quit' | 'navigate' | 'back' } {
    // Only 'Back' option for now
    this.state.screen = 'main';
    this.state.selectedIndex = 0;
    return { action: 'back' };
  }

  // Go back one screen
  back(): void {
    switch (this.state.screen) {
      case 'mode_select':
        this.state.screen = 'main';
        this.state.selectedIndex = 0;
        break;
      case 'map_select':
        this.state.screen = 'mode_select';
        this.state.selectedIndex = 0;
        break;
      case 'help':
        this.state.screen = 'main';
        this.state.selectedIndex = 1; // Help item
        break;
      case 'settings':
        this.state.screen = 'main';
        this.state.selectedIndex = 2; // Settings item
        break;
    }
  }

  // Reset to main menu
  reset(): void {
    this.state.screen = 'main';
    this.state.selectedIndex = 0;
  }

  // Get title for current screen
  getScreenTitle(): string {
    switch (this.state.screen) {
      case 'main':
        return 'CS-CLI';
      case 'mode_select':
        return 'Select Game Mode';
      case 'map_select':
        return 'Select Map';
      case 'help':
        return 'Help';
      case 'settings':
        return 'Settings';
      default:
        return '';
    }
  }

  // Get description for current selection
  getSelectionDescription(): string {
    switch (this.state.screen) {
      case 'mode_select':
        const mode = this.modeMenuItems[this.state.selectedIndex];
        if (mode) {
          if (mode.mode === 'deathmatch') {
            return 'Free-for-all - First to 10 round wins';
          } else {
            return 'Team vs Team - First to 7 round wins';
          }
        }
        break;
      case 'map_select':
        const maps = this.getAvailableMaps();
        const map = maps[this.state.selectedIndex];
        if (map) {
          return map.description;
        }
        break;
    }
    return '';
  }

  // Handle key input - returns result of selection if any
  handleKey(key: string): { action: 'start_game' | 'quit' | 'navigate' | 'back' | 'none'; mode?: GameModeType; map?: string } {
    // Help screen - any key goes back
    if (this.state.screen === 'help') {
      this.back();
      return { action: 'back' };
    }

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
      case 'escape':
      case 'backspace':
        if (this.state.screen !== 'main') {
          this.back();
          return { action: 'back' };
        }
        return { action: 'none' };
      // H key as shortcut to help from main menu
      case 'h':
      case 'H':
        if (this.state.screen === 'main') {
          this.state.screen = 'help';
          return { action: 'navigate' };
        }
        return { action: 'none' };
      default:
        return { action: 'none' };
    }
  }
}

// Singleton
let mainMenuInstance: MainMenu | null = null;

export function getMainMenu(): MainMenu {
  if (!mainMenuInstance) {
    mainMenuInstance = new MainMenu();
  }
  return mainMenuInstance;
}

export function resetMainMenu(): void {
  mainMenuInstance = new MainMenu();
}
