// Buy menu UI for CS-CLI
// Visual grid menu for purchasing weapons during freeze phase

import { Player } from '../game/Player.js';
import { WEAPONS, WeaponDef, WeaponSlot, getBuyableWeapons } from '../game/Weapon.js';

export type BuyCategory = 'pistols' | 'rifles' | 'heavy';

export interface BuyMenuItem {
  weaponName: string;
  def: WeaponDef;
  owned: boolean;
  canAfford: boolean;
}

export interface BuyMenuState {
  isOpen: boolean;
  selectedCategory: number;
  selectedItem: number;
  categories: BuyCategory[];
}

export class BuyMenu {
  private state: BuyMenuState;
  private player: Player | null = null;

  // Category definitions
  private categories: { id: BuyCategory; label: string; slot: WeaponSlot }[] = [
    { id: 'pistols', label: 'Pistols', slot: 2 },
    { id: 'rifles', label: 'Rifles', slot: 1 },
    { id: 'heavy', label: 'Heavy', slot: 1 },
  ];

  constructor() {
    this.state = {
      isOpen: false,
      selectedCategory: 0,
      selectedItem: 0,
      categories: ['pistols', 'rifles', 'heavy'],
    };
  }

  getState(): BuyMenuState {
    return this.state;
  }

  isOpen(): boolean {
    return this.state.isOpen;
  }

  open(player: Player): void {
    this.player = player;
    this.state.isOpen = true;
    this.state.selectedCategory = 0;
    this.state.selectedItem = 0;
  }

  close(): void {
    this.state.isOpen = false;
    this.player = null;
  }

  toggle(player: Player): void {
    if (this.state.isOpen) {
      this.close();
    } else {
      this.open(player);
    }
  }

  // Get weapons for a category
  getWeaponsForCategory(category: BuyCategory): WeaponDef[] {
    const allWeapons = getBuyableWeapons();

    switch (category) {
      case 'pistols':
        return allWeapons.filter(w => w.slot === 2);
      case 'rifles':
        return allWeapons.filter(w => w.slot === 1 && (w.type === 'rifle' || w.type === 'sniper'));
      case 'heavy':
        return allWeapons.filter(w => w.slot === 1 && w.type === 'shotgun');
      default:
        return [];
    }
  }

  // Get menu items for current category
  getMenuItems(): BuyMenuItem[] {
    if (!this.player) return [];

    const category = this.state.categories[this.state.selectedCategory];
    const weapons = this.getWeaponsForCategory(category);

    return weapons.map(def => ({
      weaponName: def.name.toLowerCase(),
      def,
      owned: this.playerOwnsWeapon(def),
      canAfford: this.player!.economy.canAfford(def.cost),
    }));
  }

  // Check if player owns a weapon
  private playerOwnsWeapon(def: WeaponDef): boolean {
    if (!this.player) return false;

    const weapon = this.player.weapons.get(def.slot);
    if (!weapon) return false;

    return weapon.def.name.toLowerCase() === def.name.toLowerCase();
  }

  // Get current category info
  getCurrentCategory(): { id: BuyCategory; label: string } {
    const cat = this.categories[this.state.selectedCategory];
    return { id: cat.id, label: cat.label };
  }

  // Get selected item
  getSelectedItem(): BuyMenuItem | null {
    const items = this.getMenuItems();
    if (this.state.selectedItem >= items.length) return null;
    return items[this.state.selectedItem];
  }

  // Navigation
  moveLeft(): void {
    this.state.selectedCategory = (this.state.selectedCategory - 1 + this.categories.length) % this.categories.length;
    this.state.selectedItem = 0; // Reset item selection when changing category
  }

  moveRight(): void {
    this.state.selectedCategory = (this.state.selectedCategory + 1) % this.categories.length;
    this.state.selectedItem = 0;
  }

  moveUp(): void {
    const items = this.getMenuItems();
    if (items.length === 0) return;
    this.state.selectedItem = (this.state.selectedItem - 1 + items.length) % items.length;
  }

  moveDown(): void {
    const items = this.getMenuItems();
    if (items.length === 0) return;
    this.state.selectedItem = (this.state.selectedItem + 1) % items.length;
  }

  // Purchase selected weapon
  purchase(): { success: boolean; message: string; weaponName?: string } {
    if (!this.player) {
      return { success: false, message: 'No player' };
    }

    const item = this.getSelectedItem();
    if (!item) {
      return { success: false, message: 'No weapon selected' };
    }

    if (item.owned) {
      return { success: false, message: 'Already owned' };
    }

    if (!item.canAfford) {
      return { success: false, message: 'Not enough money' };
    }

    // Attempt purchase
    if (this.player.buyWeapon(item.weaponName)) {
      return {
        success: true,
        message: `Purchased ${item.def.name}`,
        weaponName: item.weaponName,
      };
    }

    return { success: false, message: 'Purchase failed' };
  }

  // Handle key input
  handleKey(key: string): { action: 'close' | 'purchase' | 'navigate' | 'none'; result?: { success: boolean; message: string } } {
    if (!this.state.isOpen) return { action: 'none' };

    switch (key) {
      case 'left':
      case 'a':
        this.moveLeft();
        return { action: 'navigate' };
      case 'right':
      case 'd':
        this.moveRight();
        return { action: 'navigate' };
      case 'up':
      case 'w':
        this.moveUp();
        return { action: 'navigate' };
      case 'down':
      case 's':
        this.moveDown();
        return { action: 'navigate' };
      case 'enter':
      case 'space':
        const result = this.purchase();
        return { action: 'purchase', result };
      case 'escape':
      case 'b':
        this.close();
        return { action: 'close' };
      default:
        // Number keys for quick buy
        if (key >= '1' && key <= '9') {
          const index = parseInt(key) - 1;
          const items = this.getMenuItems();
          if (index < items.length) {
            this.state.selectedItem = index;
            const result = this.purchase();
            return { action: 'purchase', result };
          }
        }
        return { action: 'none' };
    }
  }

  // Get player's current money
  getPlayerMoney(): number {
    return this.player?.economy.getMoney() ?? 0;
  }

  // Get all categories with their items count
  getCategoriesWithCounts(): { id: BuyCategory; label: string; count: number; isSelected: boolean }[] {
    return this.categories.map((cat, index) => ({
      id: cat.id,
      label: cat.label,
      count: this.getWeaponsForCategory(cat.id).length,
      isSelected: index === this.state.selectedCategory,
    }));
  }
}

// Singleton
let buyMenuInstance: BuyMenu | null = null;

export function getBuyMenu(): BuyMenu {
  if (!buyMenuInstance) {
    buyMenuInstance = new BuyMenu();
  }
  return buyMenuInstance;
}

export function resetBuyMenu(): void {
  buyMenuInstance = new BuyMenu();
}
