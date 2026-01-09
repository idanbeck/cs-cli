// Main menu UI for CS-CLI
// Handles main menu navigation, mode selection, map selection

import { GameModeType } from '../game/GameMode.js';
import { MapRegistry, MapInfo as RegistryMapInfo } from '../maps/MapRegistry.js';

// Rendering mode types
export type RenderMode = 'basic' | 'halfblock' | 'sixel';
export type MSAAMode = 'none' | '4x' | '16x';
export type TextureFilterMode = 'normal' | 'pixelated' | 'blockavg';

// Settings tab types
export type SettingsTab = 'controls' | 'graphics' | 'audio';

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

// Get available maps from registry
function getAvailableMapsFromRegistry(): MapInfo[] {
  MapRegistry.initialize();
  const registryMaps = MapRegistry.getAvailableMaps();

  return registryMaps.map(m => {
    // All maps support solo mode
    const modes: GameModeType[] = ['solo'];
    if (m.modes === 'both' || m.modes === 'deathmatch') {
      modes.push('deathmatch');
    }
    if (m.modes === 'both' || m.modes === 'competitive') {
      modes.push('competitive');
    }
    return {
      id: m.id,
      name: m.name,
      description: m.description || `${m.name} (${m.type})`,
      supportedModes: modes,
    };
  });
}

// Available maps (loaded from registry)
export const AVAILABLE_MAPS: MapInfo[] = getAvailableMapsFromRegistry();

export type InputStatus = {
  mode: 'native' | 'stdin';
  working: boolean;
  message: string;
};

// Renderer backend types
export type RendererBackend = 'native' | 'js';

// Settings configuration
export interface Settings {
  // Controls
  mouseSensitivity: number;  // 0.001 to 0.01 (radians per pixel)

  // Graphics
  renderMode: RenderMode;    // Basic, half-block, or sixel
  msaaMode: MSAAMode;        // None, 4x, or 16x anti-aliasing
  textureFilter: TextureFilterMode; // Texture filtering mode
  sixelResolution: number;   // Sixel resolution divisor (1=full, 2=half, 4=quarter)
  targetFps: number;         // Frame rate cap (0 = uncapped, 30, 60)
  fov: number;               // Field of view (70-120 degrees)
  rendererBackend: RendererBackend; // Native SIMD or JavaScript renderer

  // Audio/Voice
  voiceEnabled: boolean;
  voiceInputVolume: number;    // 0-100
  voiceOutputVolume: number;   // 0-100
  voiceInputDevice: string;    // Device ID or 'default'
  voiceOutputDevice: string;   // Device ID or 'default'
  voicePTTEnabled: boolean;    // true = push-to-talk, false = VAD
  voicePTTKey: string;
  voiceVADSensitivity: number; // 1-10
  voiceMaxDistance: number;    // Game units
  voiceSpatialEnabled: boolean;
}

// Settings persistence path
import { homedir } from 'os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const SETTINGS_DIR = join(homedir(), '.csterm');
const SETTINGS_FILE = join(SETTINGS_DIR, 'settings.json');

// Load settings from disk
function loadSettingsFromDisk(): Partial<Settings> {
  try {
    if (existsSync(SETTINGS_FILE)) {
      const data = readFileSync(SETTINGS_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      // Validate and return only valid settings fields
      const settings: Partial<Settings> = {};
      // Controls
      if (typeof parsed.mouseSensitivity === 'number') settings.mouseSensitivity = parsed.mouseSensitivity;
      // Graphics
      if (['basic', 'halfblock', 'sixel'].includes(parsed.renderMode)) settings.renderMode = parsed.renderMode;
      if (['none', '4x', '16x'].includes(parsed.msaaMode)) settings.msaaMode = parsed.msaaMode;
      if (['normal', 'pixelated', 'blockavg'].includes(parsed.textureFilter)) settings.textureFilter = parsed.textureFilter;
      if (typeof parsed.sixelResolution === 'number') settings.sixelResolution = parsed.sixelResolution;
      if (typeof parsed.targetFps === 'number') settings.targetFps = parsed.targetFps;
      if (typeof parsed.fov === 'number') settings.fov = parsed.fov;
      if (['native', 'js'].includes(parsed.rendererBackend)) settings.rendererBackend = parsed.rendererBackend;
      // Audio/Voice
      if (typeof parsed.voiceEnabled === 'boolean') settings.voiceEnabled = parsed.voiceEnabled;
      if (typeof parsed.voiceInputVolume === 'number') settings.voiceInputVolume = parsed.voiceInputVolume;
      if (typeof parsed.voiceOutputVolume === 'number') settings.voiceOutputVolume = parsed.voiceOutputVolume;
      if (typeof parsed.voiceInputDevice === 'string') settings.voiceInputDevice = parsed.voiceInputDevice;
      if (typeof parsed.voiceOutputDevice === 'string') settings.voiceOutputDevice = parsed.voiceOutputDevice;
      if (typeof parsed.voicePTTEnabled === 'boolean') settings.voicePTTEnabled = parsed.voicePTTEnabled;
      if (typeof parsed.voicePTTKey === 'string') settings.voicePTTKey = parsed.voicePTTKey;
      if (typeof parsed.voiceVADSensitivity === 'number') settings.voiceVADSensitivity = parsed.voiceVADSensitivity;
      if (typeof parsed.voiceMaxDistance === 'number') settings.voiceMaxDistance = parsed.voiceMaxDistance;
      if (typeof parsed.voiceSpatialEnabled === 'boolean') settings.voiceSpatialEnabled = parsed.voiceSpatialEnabled;
      return settings;
    }
  } catch {
    // Ignore errors, use defaults
  }
  return {};
}

// Save settings to disk
function saveSettingsToDisk(settings: Settings): void {
  try {
    if (!existsSync(SETTINGS_DIR)) {
      mkdirSync(SETTINGS_DIR, { recursive: true });
    }
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
  } catch {
    // Ignore errors silently
  }
}

export class MainMenu {
  private state: MainMenuState;
  private scrollOffset: number = 0;  // For scrolling long lists
  private maxVisibleItems: number = 6;  // Updated by renderer based on screen size
  private inputStatus: InputStatus = {
    mode: 'stdin',
    working: false,
    message: 'Checking input...',
  };

  // Default settings (halfblock + 4x MSAA as per plan)
  private settings: Settings = {
    // Controls
    mouseSensitivity: 0.004,  // Default sensitivity
    // Graphics
    renderMode: 'halfblock',  // Default: half-block (2x res) - was 'basic'
    msaaMode: '4x',           // Default: 4x MSAA - was 'none'
    textureFilter: 'blockavg', // Default: block averaging for smooth retro look
    sixelResolution: 8,       // Default sixel resolution (eighth res for performance)
    targetFps: 60,            // Default frame rate cap
    fov: 90,                  // Default field of view
    rendererBackend: 'native', // Default: Native SIMD renderer
    // Audio/Voice
    voiceEnabled: true,
    voiceInputVolume: 100,
    voiceOutputVolume: 100,
    voiceInputDevice: 'default',
    voiceOutputDevice: 'default',
    voicePTTEnabled: false,   // Default: VAD mode
    voicePTTKey: 'v',
    voiceVADSensitivity: 5,
    voiceMaxDistance: 50,
    voiceSpatialEnabled: true,
  };
  private onSettingsChange?: (settings: Settings) => void;

  // Current settings tab
  private currentSettingsTab: SettingsTab = 'controls';

  // Render mode options for cycling (sixel kept in type for debug mode but hidden from UI)
  private renderModes: RenderMode[] = ['basic', 'halfblock'];
  private msaaModes: MSAAMode[] = ['none', '4x', '16x'];
  private textureFilterModes: TextureFilterMode[] = ['normal', 'pixelated', 'blockavg'];

  // FOV options
  private fovOptions = [70, 80, 90, 100, 110, 120];

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
    { label: 'Solo (Explore)', mode: 'solo' },
    { label: 'Deathmatch (FFA)', mode: 'deathmatch' },
    { label: 'Competitive (Team)', mode: 'competitive' },
  ];

  // Settings menu items organized by tab
  private settingsTabs: SettingsTab[] = ['controls', 'graphics', 'audio'];
  private settingsItemsByTab: Record<SettingsTab, string[]> = {
    controls: ['Mouse Sensitivity', 'Back'],
    graphics: ['Render Mode', 'Anti-Aliasing', 'Texture Filter', 'Renderer Backend', 'Frame Rate Cap', 'Field of View', 'Back'],
    audio: ['Voice Enabled', 'Input Volume', 'Output Volume', 'Input Device', 'Output Device', 'Voice Mode', 'VAD Sensitivity', 'Max Distance', 'Spatial Audio', 'Back'],
  };

  // Available audio devices (populated dynamically)
  private inputDevices: { id: string; name: string }[] = [{ id: 'default', name: 'Default' }];
  private outputDevices: { id: string; name: string }[] = [{ id: 'default', name: 'Default' }];
  // Flat list for backward compatibility (will be replaced by tab-specific items)
  private settingsItems = ['Mouse Sensitivity', 'Render Mode', 'Anti-Aliasing', 'Texture Filter', 'Renderer Backend', 'Frame Rate Cap', 'Field of View', 'Back'];

  // Renderer backend options
  private rendererBackends: RendererBackend[] = ['js', 'native'];

  // Sixel resolution options (lower divisor = higher quality, slower)
  private sixelResolutions = [1, 2, 4, 8, 16];

  // Frame rate options
  private fpsOptions = [0, 30, 60, 120];  // 0 = uncapped

  constructor() {
    this.state = {
      screen: 'main',
      selectedIndex: 0,
      selectedMode: 'solo',  // Default to solo for easier testing
      selectedMap: 'de_dust2',  // Default to dust2 if available
    };
    // Load persisted settings from disk
    const savedSettings = loadSettingsFromDisk();
    this.settings = { ...this.settings, ...savedSettings };
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
        return this.settingsItemsByTab[this.currentSettingsTab];
      case 'help':
        return []; // Help screen has no selectable items
      default:
        return [];
    }
  }

  // Get current settings tab
  getCurrentSettingsTab(): SettingsTab {
    return this.currentSettingsTab;
  }

  // Get all settings tabs for rendering
  getSettingsTabs(): SettingsTab[] {
    return this.settingsTabs;
  }

  // Get tab display name
  getTabDisplayName(tab: SettingsTab): string {
    const names: Record<SettingsTab, string> = {
      controls: 'Controls',
      graphics: 'Graphics',
      audio: 'Audio',
    };
    return names[tab];
  }

  // Switch to next/prev settings tab
  switchSettingsTab(direction: 'left' | 'right'): void {
    const currentIndex = this.settingsTabs.indexOf(this.currentSettingsTab);
    const delta = direction === 'right' ? 1 : -1;
    const newIndex = (currentIndex + delta + this.settingsTabs.length) % this.settingsTabs.length;
    this.currentSettingsTab = this.settingsTabs[newIndex];
    this.state.selectedIndex = 0;
    this.scrollOffset = 0;
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

  // Set max visible items (called by renderer based on screen size)
  setMaxVisibleItems(count: number): void {
    this.maxVisibleItems = Math.max(3, count);
    // Re-adjust scroll after changing visible count
    this.adjustScrollForSelection();
  }

  // Navigation
  moveUp(): void {
    const items = this.getCurrentItems();
    if (items.length === 0) return;
    this.state.selectedIndex = (this.state.selectedIndex - 1 + items.length) % items.length;
    this.adjustScrollForSelection();
  }

  moveDown(): void {
    const items = this.getCurrentItems();
    if (items.length === 0) return;
    this.state.selectedIndex = (this.state.selectedIndex + 1) % items.length;
    this.adjustScrollForSelection();
  }

  // Adjust scroll offset to keep selected item visible
  private adjustScrollForSelection(): void {
    const items = this.getCurrentItems();
    const maxVisible = this.maxVisibleItems;

    if (items.length <= maxVisible) {
      this.scrollOffset = 0;
      return;
    }

    // Keep selection visible within the window
    if (this.state.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.state.selectedIndex;
    } else if (this.state.selectedIndex >= this.scrollOffset + maxVisible) {
      this.scrollOffset = this.state.selectedIndex - maxVisible + 1;
    }

    // Clamp scroll offset
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, items.length - maxVisible));
  }

  // Get scroll info for rendering
  getScrollInfo(): { offset: number; total: number; visible: number; hasMore: boolean; hasPrev: boolean } {
    const items = this.getCurrentItems();
    const maxVisible = this.maxVisibleItems;
    const visible = Math.min(items.length, maxVisible);
    return {
      offset: this.scrollOffset,
      total: items.length,
      visible,
      hasMore: this.scrollOffset + visible < items.length,
      hasPrev: this.scrollOffset > 0,
    };
  }

  // Get visible items for rendering (with scroll)
  getVisibleItems(): { items: string[]; startIndex: number } {
    const allItems = this.getCurrentItems();
    const maxVisible = this.maxVisibleItems;
    if (allItems.length <= maxVisible) {
      return { items: allItems, startIndex: 0 };
    }
    const endIndex = Math.min(this.scrollOffset + maxVisible, allItems.length);
    return {
      items: allItems.slice(this.scrollOffset, endIndex),
      startIndex: this.scrollOffset,
    };
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
        this.scrollOffset = 0;
        return { action: 'navigate' };
      case 'Multiplayer':
        return { action: 'multiplayer' };
      case 'Help':
        this.state.screen = 'help';
        this.state.selectedIndex = 0;
        this.scrollOffset = 0;
        return { action: 'navigate' };
      case 'Settings':
        this.state.screen = 'settings';
        this.state.selectedIndex = 0;
        this.scrollOffset = 0;
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
      this.scrollOffset = 0;
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
    const items = this.settingsItemsByTab[this.currentSettingsTab];
    const item = items[this.state.selectedIndex];
    if (item === 'Back') {
      this.state.screen = 'main';
      this.state.selectedIndex = 3; // Settings index in main menu
      this.currentSettingsTab = 'controls'; // Reset to first tab
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
    saveSettingsToDisk(this.settings);
  }

  // Adjust current setting (for left/right keys)
  adjustCurrentSetting(direction: 'left' | 'right'): void {
    if (this.state.screen !== 'settings') return;

    const items = this.settingsItemsByTab[this.currentSettingsTab];
    const item = items[this.state.selectedIndex];
    const delta = direction === 'right' ? 1 : -1;

    switch (item) {
      // Controls
      case 'Mouse Sensitivity':
        this.setMouseSensitivity(this.settings.mouseSensitivity + delta * 0.001);
        break;
      // Graphics
      case 'Render Mode':
        this.cycleRenderMode(delta);
        break;
      case 'Anti-Aliasing':
        this.cycleMSAAMode(delta);
        break;
      case 'Texture Filter':
        this.cycleTextureFilter(delta);
        break;
      case 'Sixel Quality':
        this.cycleSixelResolution(delta);
        break;
      case 'Frame Rate Cap':
        this.cycleFps(delta);
        break;
      case 'Field of View':
        this.cycleFov(delta);
        break;
      case 'Renderer Backend':
        this.cycleRendererBackend(delta);
        break;
      // Audio
      case 'Voice Enabled':
        this.cycleVoiceEnabled();
        break;
      case 'Input Volume':
        this.adjustVoiceInputVolume(delta);
        break;
      case 'Output Volume':
        this.adjustVoiceOutputVolume(delta);
        break;
      case 'Voice Mode':
        this.cycleVoiceMode();
        break;
      case 'VAD Sensitivity':
        this.adjustVADSensitivity(delta);
        break;
      case 'Max Distance':
        this.adjustVoiceMaxDistance(delta);
        break;
      case 'Spatial Audio':
        this.cycleVoiceSpatial();
        break;
      case 'Input Device':
        this.cycleInputDevice(delta);
        break;
      case 'Output Device':
        this.cycleOutputDevice(delta);
        break;
    }
  }

  private cycleRenderMode(delta: number): void {
    const currentIndex = this.renderModes.indexOf(this.settings.renderMode);
    const newIndex = (currentIndex + delta + this.renderModes.length) % this.renderModes.length;
    this.settings.renderMode = this.renderModes[newIndex];
    this.onSettingsChange?.(this.settings);
    saveSettingsToDisk(this.settings);
  }

  private cycleMSAAMode(delta: number): void {
    const currentIndex = this.msaaModes.indexOf(this.settings.msaaMode);
    const newIndex = (currentIndex + delta + this.msaaModes.length) % this.msaaModes.length;
    this.settings.msaaMode = this.msaaModes[newIndex];
    this.onSettingsChange?.(this.settings);
    saveSettingsToDisk(this.settings);
  }

  private cycleTextureFilter(delta: number): void {
    const currentIndex = this.textureFilterModes.indexOf(this.settings.textureFilter);
    const newIndex = (currentIndex + delta + this.textureFilterModes.length) % this.textureFilterModes.length;
    this.settings.textureFilter = this.textureFilterModes[newIndex];
    this.onSettingsChange?.(this.settings);
    saveSettingsToDisk(this.settings);
  }

  private cycleSixelResolution(delta: number): void {
    const currentIndex = this.sixelResolutions.indexOf(this.settings.sixelResolution);
    let idx = currentIndex >= 0 ? currentIndex : 1; // Default to half res
    const newIndex = (idx + delta + this.sixelResolutions.length) % this.sixelResolutions.length;
    this.settings.sixelResolution = this.sixelResolutions[newIndex];
    this.onSettingsChange?.(this.settings);
    saveSettingsToDisk(this.settings);
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
    saveSettingsToDisk(this.settings);
  }

  private cycleFov(delta: number): void {
    const currentIndex = this.fovOptions.indexOf(this.settings.fov);
    let idx = currentIndex >= 0 ? currentIndex : 2; // Default to 90 index
    const newIndex = (idx + delta + this.fovOptions.length) % this.fovOptions.length;
    this.settings.fov = this.fovOptions[newIndex];
    this.onSettingsChange?.(this.settings);
    saveSettingsToDisk(this.settings);
  }

  private cycleRendererBackend(delta: number): void {
    const currentIndex = this.rendererBackends.indexOf(this.settings.rendererBackend);
    const newIndex = (currentIndex + delta + this.rendererBackends.length) % this.rendererBackends.length;
    this.settings.rendererBackend = this.rendererBackends[newIndex];
    this.onSettingsChange?.(this.settings);
    saveSettingsToDisk(this.settings);
  }

  // Voice/Audio settings methods
  private cycleVoiceEnabled(): void {
    this.settings.voiceEnabled = !this.settings.voiceEnabled;
    this.onSettingsChange?.(this.settings);
    saveSettingsToDisk(this.settings);
  }

  private adjustVoiceInputVolume(delta: number): void {
    this.settings.voiceInputVolume = Math.max(0, Math.min(100, this.settings.voiceInputVolume + delta * 10));
    this.onSettingsChange?.(this.settings);
    saveSettingsToDisk(this.settings);
  }

  private adjustVoiceOutputVolume(delta: number): void {
    this.settings.voiceOutputVolume = Math.max(0, Math.min(100, this.settings.voiceOutputVolume + delta * 10));
    this.onSettingsChange?.(this.settings);
    saveSettingsToDisk(this.settings);
  }

  private cycleVoiceMode(): void {
    this.settings.voicePTTEnabled = !this.settings.voicePTTEnabled;
    this.onSettingsChange?.(this.settings);
    saveSettingsToDisk(this.settings);
  }

  private adjustVADSensitivity(delta: number): void {
    this.settings.voiceVADSensitivity = Math.max(1, Math.min(10, this.settings.voiceVADSensitivity + delta));
    this.onSettingsChange?.(this.settings);
    saveSettingsToDisk(this.settings);
  }

  private adjustVoiceMaxDistance(delta: number): void {
    this.settings.voiceMaxDistance = Math.max(10, Math.min(200, this.settings.voiceMaxDistance + delta * 10));
    this.onSettingsChange?.(this.settings);
    saveSettingsToDisk(this.settings);
  }

  private cycleVoiceSpatial(): void {
    this.settings.voiceSpatialEnabled = !this.settings.voiceSpatialEnabled;
    this.onSettingsChange?.(this.settings);
    saveSettingsToDisk(this.settings);
  }

  private cycleInputDevice(delta: number): void {
    if (this.inputDevices.length === 0) return;
    const currentIndex = this.inputDevices.findIndex(d => d.id === this.settings.voiceInputDevice);
    const idx = currentIndex >= 0 ? currentIndex : 0;
    const newIndex = (idx + delta + this.inputDevices.length) % this.inputDevices.length;
    this.settings.voiceInputDevice = this.inputDevices[newIndex].id;
    this.onSettingsChange?.(this.settings);
    saveSettingsToDisk(this.settings);
  }

  private cycleOutputDevice(delta: number): void {
    if (this.outputDevices.length === 0) return;
    const currentIndex = this.outputDevices.findIndex(d => d.id === this.settings.voiceOutputDevice);
    const idx = currentIndex >= 0 ? currentIndex : 0;
    const newIndex = (idx + delta + this.outputDevices.length) % this.outputDevices.length;
    this.settings.voiceOutputDevice = this.outputDevices[newIndex].id;
    this.onSettingsChange?.(this.settings);
    saveSettingsToDisk(this.settings);
  }

  // Set available audio devices (called from VoiceManager)
  setAudioDevices(input: { id: string; name: string }[], output: { id: string; name: string }[]): void {
    this.inputDevices = input.length > 0 ? input : [{ id: 'default', name: 'Default' }];
    this.outputDevices = output.length > 0 ? output : [{ id: 'default', name: 'Default' }];
  }

  // Voice settings getters
  getVoiceEnabled(): boolean {
    return this.settings.voiceEnabled;
  }

  getVoiceInputVolume(): number {
    return this.settings.voiceInputVolume;
  }

  getVoiceOutputVolume(): number {
    return this.settings.voiceOutputVolume;
  }

  getVoicePTTEnabled(): boolean {
    return this.settings.voicePTTEnabled;
  }

  getVoicePTTKey(): string {
    return this.settings.voicePTTKey;
  }

  getVoiceVADSensitivity(): number {
    return this.settings.voiceVADSensitivity;
  }

  getVoiceMaxDistance(): number {
    return this.settings.voiceMaxDistance;
  }

  getVoiceSpatialEnabled(): boolean {
    return this.settings.voiceSpatialEnabled;
  }

  getFov(): number {
    return this.settings.fov;
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
      case 'Texture Filter':
        const filterNames: Record<TextureFilterMode, string> = {
          'normal': 'Normal',
          'pixelated': 'Pixelated',
          'blockavg': 'Block Avg',
        };
        return `< ${filterNames[this.settings.textureFilter]} >`;
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
      case 'Field of View':
        return `< ${this.settings.fov}° >`;
      case 'Renderer Backend':
        const backendNames: Record<RendererBackend, string> = {
          'js': 'JavaScript',
          'native': 'Native SIMD',
        };
        return `< ${backendNames[this.settings.rendererBackend]} >`;
      // Audio settings
      case 'Voice Enabled':
        return `< ${this.settings.voiceEnabled ? 'On' : 'Off'} >`;
      case 'Input Volume':
        const inVol = Math.round(this.settings.voiceInputVolume / 10);
        return `${'█'.repeat(inVol)}${'░'.repeat(10 - inVol)} ${this.settings.voiceInputVolume}%`;
      case 'Output Volume':
        const outVol = Math.round(this.settings.voiceOutputVolume / 10);
        return `${'█'.repeat(outVol)}${'░'.repeat(10 - outVol)} ${this.settings.voiceOutputVolume}%`;
      case 'Voice Mode':
        return `< ${this.settings.voicePTTEnabled ? 'Push-to-Talk' : 'Voice Activity'} >`;
      case 'VAD Sensitivity':
        const vadSens = this.settings.voiceVADSensitivity;
        return `${'█'.repeat(vadSens)}${'░'.repeat(10 - vadSens)} ${vadSens}`;
      case 'Max Distance':
        return `< ${this.settings.voiceMaxDistance} units >`;
      case 'Spatial Audio':
        return `< ${this.settings.voiceSpatialEnabled ? 'On' : 'Off'} >`;
      case 'Input Device': {
        const inputDevice = this.inputDevices.find(d => d.id === this.settings.voiceInputDevice);
        const inputName = inputDevice?.name || this.settings.voiceInputDevice;
        // Truncate long names
        const truncatedIn = inputName.length > 20 ? inputName.slice(0, 18) + '..' : inputName;
        return `< ${truncatedIn} >`;
      }
      case 'Output Device': {
        const outputDevice = this.outputDevices.find(d => d.id === this.settings.voiceOutputDevice);
        const outputName = outputDevice?.name || this.settings.voiceOutputDevice;
        // Truncate long names
        const truncatedOut = outputName.length > 20 ? outputName.slice(0, 18) + '..' : outputName;
        return `< ${truncatedOut} >`;
      }
      default:
        return '';
    }
  }

  // Go back one screen
  back(): void {
    this.scrollOffset = 0;  // Reset scroll when changing screens
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
        this.state.selectedIndex = 2; // Help item
        break;
      case 'settings':
        this.state.screen = 'main';
        this.state.selectedIndex = 3; // Settings item
        this.currentSettingsTab = 'controls'; // Reset to first tab
        break;
    }
  }

  // Reset to main menu
  reset(): void {
    this.state.screen = 'main';
    this.state.selectedIndex = 0;
    this.scrollOffset = 0;
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
      // Tab switching in settings (Q/E or Tab/Shift+Tab)
      case 'q':
      case 'Q':
      case 'pageup':
        if (this.state.screen === 'settings') {
          this.switchSettingsTab('left');
          return { action: 'navigate' };
        }
        return { action: 'none' };
      case 'e':
      case 'E':
      case 'pagedown':
      case 'tab':
        if (this.state.screen === 'settings') {
          this.switchSettingsTab('right');
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
