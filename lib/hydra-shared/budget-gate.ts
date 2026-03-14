/**
 * IBudgetGate — interface and default implementation for agent budget threshold checks.
 *
 * Consolidates the duplicated `(dailyPct > threshold || weeklyPct > threshold)` pattern
 * used across hydra-agents.ts and related modules.
 */

export interface IBudgetGate {
  /** Returns true if either usage value strictly exceeds its configured threshold. */
  isExceeded(dailyPct: number, weeklyPct: number): boolean;
  /** Returns the configured thresholds. */
  getThresholds(): { dailyPct: number; weeklyPct: number };
}

const DEFAULT_DAILY_PCT = 80;
const DEFAULT_WEEKLY_PCT = 75;

export class DefaultBudgetGate implements IBudgetGate {
  readonly #dailyPct: number;
  readonly #weeklyPct: number;

  constructor({ dailyPct = DEFAULT_DAILY_PCT, weeklyPct = DEFAULT_WEEKLY_PCT }: Partial<{ dailyPct: number; weeklyPct: number }> = {}) {
    this.#dailyPct = dailyPct;
    this.#weeklyPct = weeklyPct;
  }

  isExceeded(dailyPct: number, weeklyPct: number): boolean {
    return dailyPct > this.#dailyPct || weeklyPct > this.#weeklyPct;
  }

  getThresholds(): { dailyPct: number; weeklyPct: number } {
    return { dailyPct: this.#dailyPct, weeklyPct: this.#weeklyPct };
  }
}
