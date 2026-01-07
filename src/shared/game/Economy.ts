// Economy system for CS-style game
// Handles credits, kill rewards, round bonuses

export interface EconomyConfig {
  startingMoney: number;
  maxMoney: number;
  killReward: Record<string, number>;
  roundWinBonus: number;
  roundLossBonus: number[];  // Indexed by loss streak (0-4)
  teamKillPenalty: number;
}

export const DEFAULT_ECONOMY_CONFIG: EconomyConfig = {
  startingMoney: 800,
  maxMoney: 16000,
  killReward: {
    knife: 1500,
    pistol: 300,
    rifle: 300,
    shotgun: 900,
    sniper: 100,
    smg: 600,
  },
  roundWinBonus: 3250,
  roundLossBonus: [1400, 1900, 2400, 2900, 3400],
  teamKillPenalty: 300,
};

export class PlayerEconomy {
  private money: number;
  private lossStreak: number = 0;
  private config: EconomyConfig;

  constructor(config: EconomyConfig = DEFAULT_ECONOMY_CONFIG) {
    this.config = config;
    this.money = config.startingMoney;
  }

  getMoney(): number {
    return this.money;
  }

  getLossStreak(): number {
    return this.lossStreak;
  }

  canAfford(cost: number): boolean {
    return this.money >= cost;
  }

  addMoney(amount: number): void {
    this.money = Math.min(this.config.maxMoney, this.money + amount);
  }

  spendMoney(amount: number): boolean {
    if (!this.canAfford(amount)) {
      return false;
    }
    this.money -= amount;
    return true;
  }

  // Award kill reward based on weapon type
  awardKill(weaponType: string): number {
    const reward = this.config.killReward[weaponType] ?? 300;
    this.addMoney(reward);
    return reward;
  }

  // Apply team kill penalty
  applyTeamKillPenalty(): void {
    this.money = Math.max(0, this.money - this.config.teamKillPenalty);
  }

  // Called when player's team wins the round
  awardRoundWin(): number {
    this.lossStreak = 0;
    this.addMoney(this.config.roundWinBonus);
    return this.config.roundWinBonus;
  }

  // Called when player's team loses the round
  awardRoundLoss(): number {
    const streakIndex = Math.min(this.lossStreak, this.config.roundLossBonus.length - 1);
    const bonus = this.config.roundLossBonus[streakIndex];
    this.lossStreak = Math.min(this.lossStreak + 1, this.config.roundLossBonus.length - 1);
    this.addMoney(bonus);
    return bonus;
  }

  // Reset for new match
  resetForMatch(): void {
    this.money = this.config.startingMoney;
    this.lossStreak = 0;
  }

  // Reset for halftime (keep money, reset loss streak)
  resetForHalftime(): void {
    this.lossStreak = 0;
  }

  // Get current loss bonus amount (for UI display)
  getCurrentLossBonus(): number {
    const streakIndex = Math.min(this.lossStreak, this.config.roundLossBonus.length - 1);
    return this.config.roundLossBonus[streakIndex];
  }
}

// Utility to get kill reward for a weapon
export function getKillReward(weaponType: string, config: EconomyConfig = DEFAULT_ECONOMY_CONFIG): number {
  return config.killReward[weaponType] ?? 300;
}
