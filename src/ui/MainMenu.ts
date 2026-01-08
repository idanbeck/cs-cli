// Main menu UI for CS-CLI
// Handles main menu navigation, mode selection, map selection

import { GameModeType } from '../game/GameMode.js';

// Rendering mode types
export type RenderMode = 'basic' | 'halfblock' | 'sixel';
export type MSAAMode = 'none' | '4x' | '16x';

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

// Settings configuration
export interface Settings {
  mouseSensitivity: number;  // 0.001 to 0.01 (radians per pixel)
  renderMode: RenderMode;    // Basic, half-block, or sixel
  msaaMode: MSAAMode;        // None, 4x, or 16x anti-aliasing
  sixelResolution: number;   // Sixel resolution divisor (1=full, 2=half, 4=quarter)
  targetFps: number;         // Frame rate cap (0 = uncapped, 30, 60)
}

export class MainMenu {
  private state: MainMenuState;
  private inputStatus: InputStatus = {
    mode: 'stdin',
    working: false,
    message: 'Checking input...',
  };

  // Settings
  private settings: Settings = {
    mouseSensitivity: 0.004,  // Default sensitivity
    renderMode: 'basic',      // Default render mode
    msaaMode: 'none',         // Default MSAA
    sixelResolution: 8,       // Default sixel resolution (eighth res for performance)
    targetFps: 60,            // Default frame rate cap
  };
  private onSettingsChange?: (settings: Settings) => void;

  // Render mode options for cycling (sixel kept in type for debug mode but hidden from UI)
  private renderModes: RenderMode[] = ['basic', 'halfblock'];
  private msaaModes: MSAAMode[] = ['none', '4x', '16x'];

  // Menu items for each screen
  private mainMenuItems = ['Play', 'Multiplayer', 'Help', 'Settings', 'Quit'];

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

  // Settings menu items (Sixel Quality hidden, available in debug mode)
  private settingsItems = ['Mouse Sensitivity', 'Render Mode', 'Anti-Aliasing', 'Frame Rate Cap', 'Back'];

  // Sixel resolution options (lower divisor = higher quality, slower)
  private sixelResolutions = [1, 2, 4, 8, 16];

  // Frame rate options
  private fpsOptions = [0, 30, 60, 120];  // 0 = uncapped

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
        return this.settingsItems;
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
  select(): { action: 'start_game' | 'quit' | 'navigate' | 'back' | 'multiplayer'; mode?: GameModeType; map?: string } {
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

  private handleMainSelect(): { action: 'start_game' | 'quit' | 'navigate' | 'back' | 'multiplayer'; mode?: GameModeType; map?: string } {
    const item = this.mainMenuItems[this.state.selectedIndex];
    switch (item) {
      case 'Play':
        this.state.screen = 'mode_select';
        this.state.selectedIndex = 0;
        return { action: 'navigate' };
      case 'Multiplayer':
        return { action: 'multiplayer' };
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
    const item = this.settingsItems[this.state.selectedIndex];
    if (item === 'Back') {
      this.state.screen = 'main';
      this.state.selectedIndex = 3; // Settings index in main menu
      return { action: 'back' };
    }
    // Other settings items are adjusted with left/right, not selected
    return { action: 'navigate' };
  }

  // Settings methods
  getSettings(): Settings {
    return { ...this.settings };
  }

  // Set initial settings (from CLI args, doesn't trigger callback)
  setInitialSettings(renderMode: RenderMode, msaaMode: MSAAMode): void {
    this.settings.renderMode = renderMode;
    this.settings.msaaMode = msaaMode;
  }

  setOnSettingsChange(callback: (settings: Settings) => void): void {
    this.onSettingsChange = callback;
  }

  getMouseSensitivity(): number {
    return this.settings.mouseSensitivity;
  }

  setMouseSensitivity(value: number): void {
    this.settings.mouseSensitivity = Math.max(0.001, Math.min(0.01, value));
    this.onSettingsChange?.(this.settings);
  }

  // Adjust current setting (for left/right keys)
  adjustCurrentSetting(direction: 'left' | 'right'): void {
    if (this.state.screen !== 'settings') return;

    const item = this.settingsItems[this.state.selectedIndex];
    const delta = direction === 'right' ? 1 : -1;

    switch (item) {
      case 'Mouse Sensitivity':
        this.setMouseSensitivity(this.settings.mouseSensitivity + delta * 0.001);
        break;
      case 'Render Mode':
        this.cycleRenderMode(delta);
        break;
      case 'Anti-Aliasing':
        this.cycleMSAAMode(delta);
        break;
      case 'Sixel Quality':
        this.cycleSixelResolution(delta);
        break;
      case 'Frame Rate Cap':
        this.cycleFps(delta);
        break;
    }
  }

  private cycleRenderMode(delta: number): void {
    const currentIndex = this.renderModes.indexOf(this.settings.renderMode);
    const newIndex = (currentIndex + delta + this.renderModes.length) % this.renderModes.length;
    this.settings.renderMode = this.renderModes[newIndex];
    this.onSettingsChange?.(this.settings);
  }

  private cycleMSAAMode(delta: number): void {
    const currentIndex = this.msaaModes.indexOf(this.settings.msaaMode);
    const newIndex = (currentIndex + delta + this.msaaModes.length) % this.msaaModes.length;
    this.settings.msaaMode = this.msaaModes[newIndex];
    this.onSettingsChange?.(this.settings);
  }

  private cycleSixelResolution(delta: number): void {
    const currentIndex = this.sixelResolutions.indexOf(this.settings.sixelResolution);
    let idx = currentIndex >= 0 ? currentIndex : 1; // Default to half res
    const newIndex = (idx + delta + this.sixelResolutions.length) % this.sixelResolutions.length;
    this.settings.sixelResolution = this.sixelResolutions[newIndex];
    this.onSettingsChange?.(this.settings);
  }

  getSixelResolution(): number {
    return this.settings.sixelResolution;
  }

  private cycleFps(delta: number): void {
    const currentIndex = this.fpsOptions.indexOf(this.settings.targetFps);
    let idx = currentIndex >= 0 ? currentIndex : 2; // Default to 60fps index
    const newIndex = (idx + delta + this.fpsOptions.length) % this.fpsOptions.length;
    this.settings.targetFps = this.fpsOptions[newIndex];
    this.onSettingsChange?.(this.settings);
  }

  getTargetFps(): number {
    return this.settings.targetFps;
  }

  getRenderMode(): RenderMode {
    return this.settings.renderMode;
  }

  getMSAAMode(): MSAAMode {
    return this.settings.msaaMode;
  }

  // Get display value for a settings item
  getSettingsValue(item: string): string {
    switch (item) {
      case 'Mouse Sensitivity':
        // Display as a percentage-like value (1-10 scale)
        const val = Math.round((this.settings.mouseSensitivity / 0.001));
        return `${'█'.repeat(val)}${'░'.repeat(10 - val)} ${val}`;
      case 'Render Mode':
        const modeNames: Record<RenderMode, string> = {
          'basic': 'Basic (1 char)',
          'halfblock': 'Half-Block (2x)',
          'sixel': 'Sixel (pixel)',
        };
        return `< ${modeNames[this.settings.renderMode]} >`;
      case 'Anti-Aliasing':
        const msaaNames: Record<MSAAMode, string> = {
          'none': 'Off',
          '4x': '4x MSAA',
          '16x': '16x MSAA',
        };
        return `< ${msaaNames[this.settings.msaaMode]} >`;
      case 'Sixel Quality':
        // Show resolution with quality indicator (lower divisor = higher quality)
        const res = this.settings.sixelResolution;
        const qualityNames: Record<number, string> = {
          1: 'Full', 2: 'Half', 4: 'Quarter', 8: 'Eighth', 16: 'Sixteenth'
        };
        const quality = qualityNames[res] || `1/${res}`;
        return `< 1/${res} (${quality}) >`;
      case 'Frame Rate Cap':
        const fps = this.settings.targetFps;
        return `< ${fps === 0 ? 'Uncapped' : fps + ' FPS'} >`;
      default:
        return '';
    }
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
  handleKey(key: string): { action: 'start_game' | 'quit' | 'navigate' | 'back' | 'none' | 'multiplayer'; mode?: GameModeType; map?: string } {
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
      case 'left':
      case 'a':
        if (this.state.screen === 'settings') {
          this.adjustCurrentSetting('left');
        }
        return { action: 'none' };
      case 'right':
      case 'd':
        if (this.state.screen === 'settings') {
          this.adjustCurrentSetting('right');
        }
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
        // ESC on main menu = quit
        return { action: 'quit' };
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
