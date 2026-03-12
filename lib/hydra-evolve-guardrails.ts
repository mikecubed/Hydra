/**
 * Hydra Evolve Guardrails — Budget tracking, safety rules, and violation scanning
 * for autonomous self-improvement sessions.
 *
 * Adapted from hydra-nightly-guardrails.mjs with evolve-specific additions:
 * - Per-round budget tracking with reduce-scope tier
 * - Stricter protected files (cannot modify itself)
 * - Evolve-specific safety prompt
 *
 * Now uses shared modules from hydra-shared/ for git helpers, constants,
 * guardrail functions, and base budget tracking.
 */

import { loadHydraConfig } from './hydra-config.ts';
import { getSessionUsage } from './hydra-metrics.ts';
import { checkUsage } from './hydra-usage.ts';
import {
  BASE_PROTECTED_FILES,
  BASE_PROTECTED_PATTERNS,
  BLOCKED_COMMANDS as SHARED_BLOCKED_COMMANDS,
} from './hydra-shared/constants.ts';
import {
  verifyBranch as sharedVerifyBranch,
  isCleanWorkingTree as sharedIsCleanWorkingTree,
  buildSafetyPrompt as sharedBuildSafetyPrompt,
  scanBranchViolations as sharedScanBranchViolations,
} from './hydra-shared/guardrails.ts';

// ── Constants ───────────────────────────────────────────────────────────────

/** Files that evolve agents must NEVER modify (base + evolve-specific). */
export const PROTECTED_FILES = new Set([
  ...BASE_PROTECTED_FILES,
  // Evolve cannot modify itself
  'lib/hydra-evolve.ts',
  'lib/hydra-evolve-guardrails.ts',
  'lib/hydra-evolve-knowledge.ts',
  'lib/hydra-evolve-review.ts',
  'lib/hydra-evolve-investigator.ts',
  'lib/hydra-openai.ts',
  // Cannot touch nightly system
  'lib/hydra-nightly.ts',
  'lib/hydra-nightly-discovery.ts',
  'lib/hydra-nightly-review.ts',
  // Config loader off-limits
  'lib/hydra-config.ts',
  // Knowledge base is only written by hydra-evolve-knowledge.ts
  'docs/coordination/evolve/KNOWLEDGE_BASE.json',
]);

/** Path patterns that evolve agents must not touch (base + evolve-specific). */
export const PROTECTED_PATTERNS = [...BASE_PROTECTED_PATTERNS, /^bin\//];

/** Shell commands that evolve agents must never execute. */
export const BLOCKED_COMMANDS = [...SHARED_BLOCKED_COMMANDS, 'git checkout master'];

// ── Budget Config ───────────────────────────────────────────────────────────

function getEvolveBudgetConfig() {
  const cfg = loadHydraConfig();
  const evolve = cfg.evolve ?? {};
  const budget = evolve.budget ?? {};
  return {
    softLimit: budget.softLimit ?? 600_000,
    hardLimit: budget.hardLimit ?? 800_000,
    perRoundEstimate: budget.perRoundEstimate ?? 200_000,
    warnThreshold: budget.warnThreshold ?? 0.6,
    reduceScopeThreshold: budget.reduceScopeThreshold ?? 0.75,
    softStopThreshold: budget.softStopThreshold ?? 0.85,
    hardStopThreshold: budget.hardStopThreshold ?? 0.95,
  };
}

// ── Evolve Budget Tracker ───────────────────────────────────────────────────

/**
 * Tracks cumulative token usage across an evolve session with
 * per-round granularity and evolve-specific escalation tiers.
 *
 * Actions (in priority order):
 *   hard_stop     - Interrupt immediately, save progress
 *   soft_stop     - Finish current phase, don't start new rounds
 *   reduce_scope  - Skip implement phase, research-only rounds
 *   warn          - Log warning, continue
 *   continue      - All good
 */
export class EvolveBudgetTracker {
  softLimit: number;
  hardLimit: number;
  perRoundEstimate: number;
  warnThreshold: number;
  reduceScopeThreshold: number;
  softStopThreshold: number;
  hardStopThreshold: number;
  startTokens: number;
  currentTokens: number;
  roundDeltas: Array<{ round: unknown; area: unknown; tokens: number; durationMs: unknown }>;
  _startedAt: number;

  constructor(budgetOverrides: Record<string, unknown> = {}) {
    const defaults = getEvolveBudgetConfig();
    this.softLimit = (budgetOverrides['softLimit'] as number | undefined) ?? defaults.softLimit;
    this.hardLimit = (budgetOverrides['hardLimit'] as number | undefined) ?? defaults.hardLimit;
    this.perRoundEstimate =
      (budgetOverrides['perRoundEstimate'] as number | undefined) ?? defaults.perRoundEstimate;
    this.warnThreshold =
      (budgetOverrides['warnThreshold'] as number | undefined) ?? defaults.warnThreshold;
    this.reduceScopeThreshold =
      (budgetOverrides['reduceScopeThreshold'] as number | undefined) ??
      defaults.reduceScopeThreshold;
    this.softStopThreshold =
      (budgetOverrides['softStopThreshold'] as number | undefined) ?? defaults.softStopThreshold;
    this.hardStopThreshold =
      (budgetOverrides['hardStopThreshold'] as number | undefined) ?? defaults.hardStopThreshold;

    this.startTokens = 0;
    this.currentTokens = 0;
    this.roundDeltas = []; // [{ round, area, tokens, durationMs }]
    this._startedAt = Date.now();
  }

  /** Record initial token state at start of session. */
  recordStart(): void {
    const session = getSessionUsage();
    this.startTokens = session.totalTokens;
    this.currentTokens = this.startTokens;
  }

  /**
   * Snapshot current tokens after a round completes.
   * @returns {{ tokens: number }} Delta for this round
   */
  recordRoundEnd(round: unknown, area: unknown, durationMs: unknown): { tokens: number } {
    const session = getSessionUsage();
    const now = session.totalTokens;
    const delta = now - this.currentTokens;
    this.currentTokens = now;
    this.roundDeltas.push({ round, area, tokens: delta, durationMs });
    return { tokens: delta };
  }

  /** Total tokens consumed in this evolve session. */
  get consumed(): number {
    return this.currentTokens - this.startTokens;
  }

  /** Budget usage as a fraction (0-1). */
  get percentUsed(): number {
    return this.hardLimit > 0 ? this.consumed / this.hardLimit : 0;
  }

  /** Rolling average tokens per round. */
  get avgTokensPerRound(): number {
    if (this.roundDeltas.length === 0) return this.perRoundEstimate;
    const sum = this.roundDeltas.reduce((s: number, d: { tokens: number }) => s + d.tokens, 0);
    return Math.round(sum / this.roundDeltas.length);
  }

  /**
   * Check budget state and return an action recommendation.
   */
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types -- complex action union return
  check() {
    let externalCritical = false;
    try {
      const usage = checkUsage();
      if (usage.level === 'critical') externalCritical = true;
    } catch {
      /* usage monitor may not have data */
    }

    const consumed = this.consumed;
    const pct = this.percentUsed;
    const remaining = this.hardLimit - consumed;
    const avg = this.avgTokensPerRound;
    const canFitNextRound = remaining > avg * 1.2;

    const base = { consumed, percentUsed: pct, remaining, canFitNextRound, avgPerRound: avg };

    if (externalCritical || pct >= this.hardStopThreshold) {
      return {
        ...base,
        action: 'hard_stop',
        reason: externalCritical
          ? 'External usage monitor reports critical level'
          : `Hard limit reached: ${String(Math.round(pct * 100))}% of budget used`,
      };
    }

    if (pct >= this.softStopThreshold || consumed >= this.softLimit) {
      return {
        ...base,
        action: 'soft_stop',
        reason: `Soft limit reached: ${String(Math.round(pct * 100))}% budget (${consumed.toLocaleString()} tokens)`,
      };
    }

    if (pct >= this.reduceScopeThreshold) {
      return {
        ...base,
        action: 'reduce_scope',
        reason: `${String(Math.round(pct * 100))}% budget — switching to research-only rounds (no implement phase)`,
      };
    }

    if (pct >= this.warnThreshold) {
      return {
        ...base,
        action: 'warn',
        reason: `${String(Math.round(pct * 100))}% budget used (${consumed.toLocaleString()} tokens)`,
      };
    }

    return { ...base, action: 'continue', reason: 'Budget OK' };
  }

  /** Serialize tracker state for checkpoint persistence. */
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types -- serialization object
  serialize() {
    return {
      startTokens: this.startTokens,
      currentTokens: this.currentTokens,
      roundDeltas: this.roundDeltas,
      softLimit: this.softLimit,
      hardLimit: this.hardLimit,
      _startedAt: this._startedAt,
    };
  }

  /** Restore a tracker from serialized checkpoint data. */
  static deserialize(data: Record<string, unknown>): EvolveBudgetTracker {
    const tracker = new EvolveBudgetTracker({
      softLimit: data['softLimit'],
      hardLimit: data['hardLimit'],
    });
    tracker.startTokens = (data['startTokens'] as number | undefined) ?? 0;
    tracker.currentTokens = (data['currentTokens'] as number | undefined) ?? 0;
    tracker.roundDeltas = (data['roundDeltas'] as typeof tracker.roundDeltas | undefined) ?? [];
    tracker._startedAt = (data['_startedAt'] as number | undefined) ?? Date.now();
    return tracker;
  }

  /** Summary for the session report. */
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types -- summary object
  getSummary() {
    return {
      startTokens: this.startTokens,
      endTokens: this.currentTokens,
      consumed: this.consumed,
      hardLimit: this.hardLimit,
      softLimit: this.softLimit,
      percentUsed: this.percentUsed,
      roundDeltas: [...this.roundDeltas],
      avgPerRound: this.avgTokensPerRound,
      durationMs: Date.now() - this._startedAt,
    };
  }
}

// ── Safety Prompt (delegates to shared) ─────────────────────────────────────

/**
 * Build the safety rules block injected into every evolve agent prompt.
 * @param {string} branchName
 * @param {string} [agentName] - Agent executing the task (for commit attribution)
 */
export function buildEvolveSafetyPrompt(branchName: string, agentName?: string): string {
  return sharedBuildSafetyPrompt(branchName, {
    runner: 'evolve runner',
    reportName: 'session report',
    protectedFiles: PROTECTED_FILES,
    blockedCommands: BLOCKED_COMMANDS,
    extraRules: [
      'Do NOT modify the evolve system itself (self-modification is blocked)',
      'Do NOT delete existing test files',
    ],
    attribution: { pipeline: 'hydra-evolve', agent: agentName ?? undefined },
  });
}

// ── Violation Scanner (delegates to shared) ─────────────────────────────────

/**
 * Scan an evolve branch's diff against the base branch for guardrail violations.
 * @param {string} projectRoot
 * @param {string} branchName
 * @param {string} [baseBranch='dev']
 * @returns {Array<{type: string, detail: string, severity: string}>}
 */
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types -- shared helper return
export function scanBranchViolations(projectRoot: string, branchName: string, baseBranch = 'dev') {
  return sharedScanBranchViolations(projectRoot, branchName, {
    baseBranch,
    protectedFiles: PROTECTED_FILES,
    protectedPatterns: PROTECTED_PATTERNS,
    checkDeletedTests: true,
  });
}

// ── Git Helpers (delegates to shared) ───────────────────────────────────────

/** Verify the current git branch matches the expected branch. */
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types -- shared helper return
export function verifyBranch(projectRoot: string, expectedBranch: string) {
  return sharedVerifyBranch(projectRoot, expectedBranch);
}

/** Check if working tree is clean. */
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types -- shared helper return
export function isCleanWorkingTree(projectRoot: string) {
  return sharedIsCleanWorkingTree(projectRoot);
}
