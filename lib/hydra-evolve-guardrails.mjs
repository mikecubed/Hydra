#!/usr/bin/env node
/**
 * Hydra Evolve Guardrails — Budget tracking, safety rules, and violation scanning
 * for autonomous self-improvement sessions.
 *
 * Adapted from hydra-nightly-guardrails.mjs with evolve-specific additions:
 * - Per-round budget tracking with reduce-scope tier
 * - Stricter protected files (cannot modify itself)
 * - Evolve-specific safety prompt
 */

import { spawnSync } from 'child_process';
import { checkUsage } from './hydra-usage.mjs';
import { getSessionUsage } from './hydra-metrics.mjs';
import { loadHydraConfig } from './hydra-config.mjs';

// ── Constants ───────────────────────────────────────────────────────────────

/** Files that evolve agents must NEVER modify. */
export const PROTECTED_FILES = new Set([
  'CLAUDE.md',
  'TODO.md',
  'package.json',
  'package-lock.json',
  'app.json',
  'nightly-queue.md',
  // Evolve cannot modify itself
  'lib/hydra-evolve.mjs',
  'lib/hydra-evolve-guardrails.mjs',
  'lib/hydra-evolve-knowledge.mjs',
  'lib/hydra-evolve-review.mjs',
  // Cannot touch nightly system
  'lib/hydra-nightly.mjs',
  'lib/hydra-nightly-guardrails.mjs',
  'lib/hydra-nightly-queue.mjs',
  'lib/hydra-nightly-review.mjs',
  // Config loader off-limits
  'lib/hydra-config.mjs',
  // Knowledge base is only written by hydra-evolve-knowledge.mjs
  'docs/coordination/evolve/KNOWLEDGE_BASE.json',
  // Session logs
  'docs/sessions/CHANGELOG_2026.md',
  'docs/TODO.md',
]);

/** Path patterns that evolve agents must not touch. */
export const PROTECTED_PATTERNS = [
  /^\.github\//,
  /^\.env/,
  /^supabase\/migrations\//,
  /^scripts\/release/,
  /^bin\//,
];

/** Shell commands that evolve agents must never execute. */
export const BLOCKED_COMMANDS = [
  'git push',
  'git checkout dev',
  'git checkout staging',
  'git checkout main',
  'git checkout master',
  'git merge',
  'git rebase',
  'DROP TABLE',
  'TRUNCATE',
  'DELETE FROM',
  'rm -rf',
  'rm -r /',
  'npm publish',
  'eas build',
  'npx supabase db push',
  'npx supabase migration',
];

// ── Budget Config ───────────────────────────────────────────────────────────

function getEvolveBudgetConfig() {
  const cfg = loadHydraConfig();
  const evolve = cfg.evolve || {};
  const budget = evolve.budget || {};
  return {
    softLimit: budget.softLimit || 600_000,
    hardLimit: budget.hardLimit || 800_000,
    perRoundEstimate: budget.perRoundEstimate || 200_000,
    warnThreshold: budget.warnThreshold || 0.60,
    reduceScopeThreshold: budget.reduceScopeThreshold || 0.75,
    softStopThreshold: budget.softStopThreshold || 0.85,
    hardStopThreshold: budget.hardStopThreshold || 0.95,
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
  constructor(budgetOverrides = {}) {
    const defaults = getEvolveBudgetConfig();
    this.softLimit = budgetOverrides.softLimit || defaults.softLimit;
    this.hardLimit = budgetOverrides.hardLimit || defaults.hardLimit;
    this.perRoundEstimate = budgetOverrides.perRoundEstimate || defaults.perRoundEstimate;
    this.warnThreshold = budgetOverrides.warnThreshold || defaults.warnThreshold;
    this.reduceScopeThreshold = budgetOverrides.reduceScopeThreshold || defaults.reduceScopeThreshold;
    this.softStopThreshold = budgetOverrides.softStopThreshold || defaults.softStopThreshold;
    this.hardStopThreshold = budgetOverrides.hardStopThreshold || defaults.hardStopThreshold;

    this.startTokens = 0;
    this.currentTokens = 0;
    this.roundDeltas = [];    // [{ round, area, tokens, durationMs }]
    this._startedAt = Date.now();
  }

  /** Record initial token state at start of session. */
  recordStart() {
    const session = getSessionUsage();
    this.startTokens = session.totalTokens || 0;
    this.currentTokens = this.startTokens;
  }

  /**
   * Snapshot current tokens after a round completes.
   * @returns {{ tokens: number }} Delta for this round
   */
  recordRoundEnd(round, area, durationMs) {
    const session = getSessionUsage();
    const now = session.totalTokens || 0;
    const delta = now - this.currentTokens;
    this.currentTokens = now;
    this.roundDeltas.push({ round, area, tokens: delta, durationMs });
    return { tokens: delta };
  }

  /** Total tokens consumed in this evolve session. */
  get consumed() {
    return this.currentTokens - this.startTokens;
  }

  /** Budget usage as a fraction (0-1). */
  get percentUsed() {
    return this.hardLimit > 0 ? this.consumed / this.hardLimit : 0;
  }

  /** Rolling average tokens per round. */
  get avgTokensPerRound() {
    if (this.roundDeltas.length === 0) return this.perRoundEstimate;
    const sum = this.roundDeltas.reduce((s, d) => s + d.tokens, 0);
    return Math.round(sum / this.roundDeltas.length);
  }

  /**
   * Check budget state and return an action recommendation.
   */
  check() {
    let externalCritical = false;
    try {
      const usage = checkUsage();
      if (usage.level === 'critical') externalCritical = true;
    } catch { /* usage monitor may not have data */ }

    const consumed = this.consumed;
    const pct = this.percentUsed;
    const remaining = this.hardLimit - consumed;
    const avg = this.avgTokensPerRound;
    const canFitNextRound = remaining > avg * 1.2;

    const base = { consumed, percentUsed: pct, remaining, canFitNextRound, avgPerRound: avg };

    if (externalCritical || pct >= this.hardStopThreshold) {
      return { ...base, action: 'hard_stop',
        reason: externalCritical
          ? 'External usage monitor reports critical level'
          : `Hard limit reached: ${Math.round(pct * 100)}% of budget used` };
    }

    if (pct >= this.softStopThreshold || consumed >= this.softLimit) {
      return { ...base, action: 'soft_stop',
        reason: `Soft limit reached: ${Math.round(pct * 100)}% budget (${consumed.toLocaleString()} tokens)` };
    }

    if (pct >= this.reduceScopeThreshold) {
      return { ...base, action: 'reduce_scope',
        reason: `${Math.round(pct * 100)}% budget — switching to research-only rounds (no implement phase)` };
    }

    if (pct >= this.warnThreshold) {
      return { ...base, action: 'warn',
        reason: `${Math.round(pct * 100)}% budget used (${consumed.toLocaleString()} tokens)` };
    }

    return { ...base, action: 'continue', reason: 'Budget OK' };
  }

  /** Serialize tracker state for checkpoint persistence. */
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
  static deserialize(data) {
    const tracker = new EvolveBudgetTracker({
      softLimit: data.softLimit,
      hardLimit: data.hardLimit,
    });
    tracker.startTokens = data.startTokens;
    tracker.currentTokens = data.currentTokens;
    tracker.roundDeltas = data.roundDeltas || [];
    tracker._startedAt = data._startedAt;
    return tracker;
  }

  /** Summary for the session report. */
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

// ── Safety Prompt ───────────────────────────────────────────────────────────

/**
 * Build the safety rules block injected into every evolve agent prompt.
 */
export function buildEvolveSafetyPrompt(branchName) {
  return `## SAFETY RULES (NON-NEGOTIABLE)
These rules are enforced by the evolve runner. Violations are flagged in the session report.

### Branch Isolation
- You are on branch: \`${branchName}\`
- ONLY commit to this branch
- NEVER run: git push, git checkout dev, git checkout main, git checkout master
- NEVER run: git merge into dev/staging/main, git rebase

### Protected Files — DO NOT MODIFY
${[...PROTECTED_FILES].map(f => `- \`${f}\``).join('\n')}

### Blocked Commands — NEVER EXECUTE
${BLOCKED_COMMANDS.map(c => `- \`${c}\``).join('\n')}

### Scope
- Focus ONLY on your assigned improvement task
- Do NOT fix unrelated issues
- Do NOT add documentation, changelog entries, or version bumps
- Do NOT install new npm packages without clear necessity
- Do NOT modify the evolve system itself (self-modification is blocked)
- Do NOT delete existing test files`;
}

// ── Violation Scanner ───────────────────────────────────────────────────────

/**
 * Scan an evolve branch's diff against the base branch for guardrail violations.
 * Returns an array of violations (empty = clean).
 *
 * @param {string} projectRoot
 * @param {string} branchName
 * @param {string} [baseBranch='dev']
 * @returns {Array<{type: string, detail: string, severity: string}>}
 */
export function scanBranchViolations(projectRoot, branchName, baseBranch = 'dev') {
  const violations = [];

  const diffResult = spawnSync('git', ['diff', '--name-only', `${baseBranch}...${branchName}`], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 10_000,
    shell: process.platform === 'win32',
  });

  if (diffResult.status !== 0 || !diffResult.stdout) {
    return violations;
  }

  const changedFiles = diffResult.stdout.trim().split('\n').filter(Boolean);

  for (const file of changedFiles) {
    const normalized = file.replace(/\\/g, '/');

    if (PROTECTED_FILES.has(normalized)) {
      violations.push({
        type: 'protected_file',
        detail: `Modified protected file: ${file}`,
        severity: 'critical',
      });
    }

    for (const pattern of PROTECTED_PATTERNS) {
      if (pattern.test(normalized)) {
        violations.push({
          type: 'protected_pattern',
          detail: `Modified file matching protected pattern: ${file}`,
          severity: 'warning',
        });
        break;
      }
    }
  }

  // Check for deleted test files
  const deletedResult = spawnSync('git', ['diff', '--name-only', '--diff-filter=D', `${baseBranch}...${branchName}`], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 10_000,
    shell: process.platform === 'win32',
  });

  if (deletedResult.status === 0 && deletedResult.stdout) {
    const deletedFiles = deletedResult.stdout.trim().split('\n').filter(Boolean);
    for (const file of deletedFiles) {
      if (/\.test\.|\.spec\.|__tests__/.test(file)) {
        violations.push({
          type: 'deleted_test',
          detail: `Deleted test file: ${file}`,
          severity: 'critical',
        });
      }
    }
  }

  return violations;
}

// ── Git Helpers ─────────────────────────────────────────────────────────────

/** Verify the current git branch matches the expected branch. */
export function verifyBranch(projectRoot, expectedBranch) {
  const result = spawnSync('git', ['branch', '--show-current'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 5_000,
    shell: process.platform === 'win32',
  });
  const current = (result.stdout || '').trim();
  return { ok: current === expectedBranch, currentBranch: current };
}

/** Check if working tree is clean. */
export function isCleanWorkingTree(projectRoot) {
  const result = spawnSync('git', ['status', '--porcelain'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 5_000,
    shell: process.platform === 'win32',
  });
  return !(result.stdout || '').trim();
}
