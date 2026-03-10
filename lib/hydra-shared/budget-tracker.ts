/**
 * Shared Budget Tracker — Base class with configurable thresholds and actions.
 *
 * Both nightly and evolve use this base class with their own threshold configs.
 *
 * Thresholds are evaluated in priority order (highest pct first):
 *   hard_stop → soft_stop → (pipeline-specific action) → warn → continue
 */

import { checkUsage } from '../hydra-usage.mjs';
import { getSessionUsage } from '../hydra-metrics.ts';

export interface Threshold {
  /** Percentage trigger (0–1) */
  pct: number;
  /** Action name (e.g., 'hard_stop', 'warn', 'handoff_codex') */
  action: string;
  /** Template string with {pct} and {consumed} placeholders */
  reason: string;
  /** Only fire once per session */
  once?: boolean;
}

export interface UnitDelta {
  label: string;
  tokens: number;
  durationMs: number;
  [key: string]: unknown;
}

export interface BudgetCheckResult {
  consumed: number;
  percentUsed: number;
  remaining: number;
  action: string;
  reason: string;
  [key: string]: unknown;
}

export interface BudgetTrackerOpts {
  softLimit: number;
  hardLimit: number;
  unitEstimate: number;
  unitLabel?: string;
  thresholds?: Threshold[];
}

export interface BudgetTrackerData {
  startTokens: number;
  currentTokens: number;
  unitDeltas?: UnitDelta[];
  softLimit: number;
  hardLimit: number;
  unitEstimate: number;
  unitLabel?: string;
  _startedAt: number;
  _firedOnce?: string[];
}

/**
 * Base budget tracker. Subclass or configure with pipeline-specific thresholds.
 */
export class BudgetTracker {
  softLimit: number;
  hardLimit: number;
  unitEstimate: number;
  unitLabel: string;
  thresholds: Threshold[];
  startTokens: number;
  currentTokens: number;
  unitDeltas: UnitDelta[];
  _startedAt: number;
  _firedOnce: Set<string>;

  constructor({ softLimit, hardLimit, unitEstimate, unitLabel = 'task', thresholds = [] }: BudgetTrackerOpts) {
    this.softLimit = softLimit;
    this.hardLimit = hardLimit;
    this.unitEstimate = unitEstimate;
    this.unitLabel = unitLabel;
    this.thresholds = thresholds;

    this.startTokens = 0;
    this.currentTokens = 0;
    this.unitDeltas = [];
    this._startedAt = Date.now();
    this._firedOnce = new Set();
  }

  /** Record initial token state at start of run. */
  recordStart(): void {
    const session = getSessionUsage();
    this.startTokens = session.totalTokens || 0;
    this.currentTokens = this.startTokens;
  }

  /**
   * Snapshot current tokens after a unit completes.
   * @param {string} label - Unit identifier (slug, round number, etc.)
   * @param {number} durationMs
   * @param {object} [extra] - Additional fields to store (e.g., { area })
   * @returns {{ tokens: number }}
   */
  recordUnitEnd(label: string, durationMs: number, extra: Record<string, unknown> = {}): { tokens: number } {
    const session = getSessionUsage();
    const now = session.totalTokens || 0;
    const delta = now - this.currentTokens;
    this.currentTokens = now;
    this.unitDeltas.push({ label, tokens: delta, durationMs, ...extra });
    return { tokens: delta };
  }

  /** Total tokens consumed in this session. */
  get consumed(): number {
    return this.currentTokens - this.startTokens;
  }

  /** Budget usage as a fraction (0–1). */
  get percentUsed(): number {
    return this.hardLimit > 0 ? this.consumed / this.hardLimit : 0;
  }

  /** Rolling average tokens per unit. */
  get avgTokensPerUnit(): number {
    if (this.unitDeltas.length === 0) return this.unitEstimate;
    const sum = this.unitDeltas.reduce((s, d) => s + d.tokens, 0);
    return Math.round(sum / this.unitDeltas.length);
  }

  /**
   * Check budget state and return an action recommendation.
   * Evaluates thresholds in priority order (highest pct first),
   * then falls back to soft limit check using external usage.
   */
  check(): BudgetCheckResult {
    let externalCritical = false;
    try {
      const usage = checkUsage() as { level?: string };
      if (usage.level === 'critical') externalCritical = true;
    } catch {
      /* usage monitor may not have data */
    }

    const consumed = this.consumed;
    const pct = this.percentUsed;
    const remaining = this.hardLimit - consumed;
    const avg = this.avgTokensPerUnit;
    const canFitNext = remaining > avg * 1.2;

    const base = {
      consumed,
      percentUsed: pct,
      remaining,
      [`canFitNext${this.unitLabel.charAt(0).toUpperCase() + this.unitLabel.slice(1)}`]: canFitNext,
      [`avgPer${this.unitLabel.charAt(0).toUpperCase() + this.unitLabel.slice(1)}`]: avg,
    };

    // External critical override
    if (externalCritical) {
      return {
        ...base,
        action: 'hard_stop',
        reason: 'External usage monitor reports critical level',
      };
    }

    // Evaluate thresholds in order
    for (const threshold of this.thresholds) {
      if (pct >= threshold.pct) {
        if (threshold.once && this._firedOnce.has(threshold.action)) {
          continue;
        }
        if (threshold.once) {
          this._firedOnce.add(threshold.action);
        }
        const reason = threshold.reason
          .replace('{pct}', String(Math.round(pct * 100)))
          .replace('{consumed}', consumed.toLocaleString());
        return { ...base, action: threshold.action, reason };
      }
    }

    return { ...base, action: 'continue', reason: 'Budget OK' };
  }

  /** Summary for reports. */
  getSummary(): Record<string, unknown> {
    return {
      startTokens: this.startTokens,
      endTokens: this.currentTokens,
      consumed: this.consumed,
      hardLimit: this.hardLimit,
      softLimit: this.softLimit,
      percentUsed: this.percentUsed,
      [`${this.unitLabel}Deltas`]: [...this.unitDeltas],
      [`avgPer${this.unitLabel.charAt(0).toUpperCase() + this.unitLabel.slice(1)}`]:
        this.avgTokensPerUnit,
      durationMs: Date.now() - this._startedAt,
    };
  }

  /** Serialize tracker state for checkpoint persistence. */
  serialize(): BudgetTrackerData {
    return {
      startTokens: this.startTokens,
      currentTokens: this.currentTokens,
      unitDeltas: this.unitDeltas,
      softLimit: this.softLimit,
      hardLimit: this.hardLimit,
      unitEstimate: this.unitEstimate,
      unitLabel: this.unitLabel,
      _startedAt: this._startedAt,
      _firedOnce: [...this._firedOnce],
    };
  }

  /** Restore a tracker from serialized checkpoint data. */
  static deserialize(data: BudgetTrackerData, thresholds: Threshold[] = []): BudgetTracker {
    const tracker = new BudgetTracker({
      softLimit: data.softLimit,
      hardLimit: data.hardLimit,
      unitEstimate: data.unitEstimate,
      unitLabel: data.unitLabel ?? 'task',
      thresholds,
    });
    tracker.startTokens = data.startTokens;
    tracker.currentTokens = data.currentTokens;
    tracker.unitDeltas = data.unitDeltas ?? [];
    tracker._startedAt = data._startedAt;
    tracker._firedOnce = new Set(data._firedOnce ?? []);
    return tracker;
  }
}
