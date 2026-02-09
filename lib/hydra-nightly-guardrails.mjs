#!/usr/bin/env node
/**
 * Hydra Nightly Guardrails — Safety, budget enforcement, and Codex 5.3 handoff.
 *
 * Three responsibilities:
 * 1. Budget tracking with escalation tiers (Claude → Codex 5.3 handoff)
 * 2. Safety rules injected into every nightly agent prompt
 * 3. Post-execution violation scanning
 *
 * Escalation strategy:
 *   - Start with Claude (per config mode)
 *   - At 70% budget: hand off remaining tasks to Codex 5.2 (gpt-5.2-codex)
 *     with a structured "interview" briefing so it picks up confidently
 *   - At 85% budget: complete current task, then STOP new tasks
 *   - At 95% budget: hard stop, save progress
 *   - If checkUsage() returns critical: immediate graceful stop
 */

import { spawnSync } from 'child_process';
import { checkUsage } from './hydra-usage.mjs';
import { getSessionUsage } from './hydra-metrics.mjs';
import { loadHydraConfig, getRoleConfig } from './hydra-config.mjs';
import { getAgentInstructionFile } from './hydra-sync-md.mjs';

// ── Constants ───────────────────────────────────────────────────────────────

/** The Codex model used for budget-saving handoff (config-driven). */
export const CODEX_HANDOFF_MODEL = getRoleConfig('nightlyHandoff').model || 'gpt-5.2-codex';

/** Files that nightly agents must NEVER modify. */
export const PROTECTED_FILES = new Set([
  'HYDRA.md',
  'CLAUDE.md',
  'GEMINI.md',
  'AGENTS.md',
  'TODO.md',
  'package.json',
  'package-lock.json',
  'app.json',
  'nightly-queue.md',
  'docs/sessions/CHANGELOG_2026.md',
  'docs/TODO.md',
]);

/** Path patterns that nightly agents must not touch. */
export const PROTECTED_PATTERNS = [
  /^\.github\//,
  /^\.env/,
  /^supabase\/migrations\//,
  /^scripts\/release/,
];

/** Shell commands that nightly agents must never execute. */
export const BLOCKED_COMMANDS = [
  'git push',
  'git checkout dev',
  'git checkout staging',
  'git checkout main',
  'git merge',
  'git rebase',
  'DROP TABLE',
  'TRUNCATE',
  'DELETE FROM',
  'rm -rf',
  'rm -r /',
  'eas build',
  'npm publish',
  'npx supabase db push',
  'npx supabase migration',
];

// ── Budget Config ───────────────────────────────────────────────────────────

function getBudgetConfig() {
  const cfg = loadHydraConfig();
  const nightly = cfg.nightly || {};
  const budget = nightly.tokenBudget || {};
  return {
    softLimit: budget.softLimit || 400_000,
    hardLimit: budget.hardLimit || 500_000,
    perTaskEstimate: budget.perTaskEstimate || 80_000,
    handoffThreshold: budget.handoffThreshold || 0.70,
    warningThreshold: budget.warningThreshold || 0.50,
  };
}

// ── Budget Tracker ──────────────────────────────────────────────────────────

/**
 * Tracks cumulative token usage across the nightly run and decides
 * when to warn, hand off to Codex 5.3, or hard-stop.
 */
export class BudgetTracker {
  constructor(budgetOverrides = {}) {
    const defaults = getBudgetConfig();
    this.softLimit = budgetOverrides.softLimit || defaults.softLimit;
    this.hardLimit = budgetOverrides.hardLimit || defaults.hardLimit;
    this.perTaskEstimate = budgetOverrides.perTaskEstimate || defaults.perTaskEstimate;
    this.handoffThreshold = budgetOverrides.handoffThreshold || defaults.handoffThreshold;
    this.warningThreshold = budgetOverrides.warningThreshold || defaults.warningThreshold;

    this.startTokens = 0;
    this.currentTokens = 0;
    this.taskDeltas = [];       // [{ slug, tokens, durationMs }]
    this.handoffTriggered = false;
    this._startedAt = Date.now();
  }

  /** Record initial token state at start of run. */
  recordStart() {
    const session = getSessionUsage();
    this.startTokens = session.totalTokens || 0;
    this.currentTokens = this.startTokens;
  }

  /**
   * Snapshot current tokens (call after each task).
   * @returns {{ tokens: number }} Delta for this task
   */
  recordTaskEnd(slug, durationMs) {
    const session = getSessionUsage();
    const now = session.totalTokens || 0;
    const delta = now - this.currentTokens;
    this.currentTokens = now;
    this.taskDeltas.push({ slug, tokens: delta, durationMs });
    return { tokens: delta };
  }

  /** Total tokens consumed in this nightly run. */
  get consumed() {
    return this.currentTokens - this.startTokens;
  }

  /** Budget usage as a fraction (0–1). */
  get percentUsed() {
    return this.hardLimit > 0 ? this.consumed / this.hardLimit : 0;
  }

  /** Rolling average tokens per task. */
  get avgTokensPerTask() {
    if (this.taskDeltas.length === 0) return this.perTaskEstimate;
    const sum = this.taskDeltas.reduce((s, d) => s + d.tokens, 0);
    return Math.round(sum / this.taskDeltas.length);
  }

  /**
   * Check budget state and return an action recommendation.
   *
   * Actions (in priority order):
   *   hard_stop     → Interrupt immediately, save progress
   *   soft_stop     → Finish current task, don't start new ones
   *   handoff_codex → Switch remaining tasks to Codex 5.3
   *   warn          → Log warning, continue with current agent
   *   continue      → All good
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
    const avg = this.avgTokensPerTask;
    const canFitNextTask = remaining > avg * 1.2;

    const base = { consumed, percentUsed: pct, remaining, canFitNextTask, avgPerTask: avg };

    if (externalCritical || pct >= 0.95) {
      return { ...base, action: 'hard_stop',
        reason: externalCritical
          ? 'External usage monitor reports critical level'
          : `Hard limit reached: ${Math.round(pct * 100)}% of budget used` };
    }

    if (pct >= 0.85 || consumed >= this.softLimit) {
      return { ...base, action: 'soft_stop',
        reason: `Soft limit reached: ${Math.round(pct * 100)}% budget (${consumed.toLocaleString()} tokens)` };
    }

    if (pct >= this.handoffThreshold && !this.handoffTriggered) {
      this.handoffTriggered = true;
      return { ...base, action: 'handoff_codex',
        reason: `${Math.round(pct * 100)}% budget — handing remaining tasks to Codex 5.3` };
    }

    if (pct >= this.warningThreshold) {
      return { ...base, action: 'warn',
        reason: `${Math.round(pct * 100)}% budget used (${consumed.toLocaleString()} tokens)` };
    }

    return { ...base, action: 'continue', reason: 'Budget OK' };
  }

  /** Summary for the morning report. */
  getSummary() {
    return {
      startTokens: this.startTokens,
      endTokens: this.currentTokens,
      consumed: this.consumed,
      hardLimit: this.hardLimit,
      softLimit: this.softLimit,
      percentUsed: this.percentUsed,
      taskDeltas: [...this.taskDeltas],
      avgPerTask: this.avgTokensPerTask,
      durationMs: Date.now() - this._startedAt,
    };
  }
}

// ── Codex 5.3 Handoff Interview ─────────────────────────────────────────────

/**
 * Build a structured context briefing ("interview") for Codex 5.3 so it can
 * pick up nightly work mid-run with full confidence.
 *
 * Includes: project context, completed tasks, the assignment, budget state,
 * and the full safety rules block.
 */
export function buildCodexHandoffPrompt({
  projectRoot,
  task,
  branchName,
  completedTasks = [],
  budgetSummary = {},
}) {
  const safetyBlock = buildSafetyPrompt(branchName);

  const completedSection = completedTasks.length > 0
    ? completedTasks.map((t, i) =>
        `  ${i + 1}. [${t.status}] ${t.title} → branch: ${t.branch}`
      ).join('\n')
    : '  (none — you are the first task)';

  const budgetNote = budgetSummary.consumed
    ? `\nBudget consumed so far: ~${budgetSummary.consumed.toLocaleString()} tokens ` +
      `across ${budgetSummary.taskDeltas?.length || 0} tasks.\n` +
      `Remaining budget: ~${Math.max(0, (budgetSummary.hardLimit || 0) - budgetSummary.consumed).toLocaleString()} tokens. Be efficient.\n`
    : '';

  return `# Codex 5.3 — Nightly Autonomous Task

## Context
You are taking over an autonomous nightly run for the SideQuest project.
The previous agent (Claude) processed some tasks and is handing off to you
to conserve Claude token budget. You have full capability to complete this work.

**Project:** SideQuest — Location-based mobile RPG
**Stack:** Expo + React Native + TypeScript + Supabase
**Root:** ${projectRoot}
**Branch:** \`${branchName}\` (already checked out for you)

## Completed Tasks (previous agent)
${completedSection}

## Your Assignment
**Task:** ${task.title}
**Branch:** \`${branchName}\`

Execute this task thoroughly:
1. Read the project's ${getAgentInstructionFile('codex', projectRoot)} for conventions and patterns
2. Read relevant source files before making changes
3. Make focused, minimal changes that address ONLY this task
4. Commit your work to the \`${branchName}\` branch with a descriptive message
5. Run \`npm run typecheck\` and fix any TypeScript errors you introduce
${budgetNote}
${safetyBlock}

## Execution
Begin working now. Be thorough but efficient. If the task is too large to complete
fully, do as much as you can and commit partial progress with a clear note about
what remains.`;
}

// ── Safety Prompt ───────────────────────────────────────────────────────────

/**
 * Build the safety rules block injected into every nightly agent prompt.
 */
export function buildSafetyPrompt(branchName) {
  return `## SAFETY RULES (NON-NEGOTIABLE)
These rules are enforced by the nightly runner. Violations are flagged in the morning report.

### Branch Isolation
- You are on branch: \`${branchName}\`
- ONLY commit to this branch
- NEVER run: git push, git checkout dev, git checkout staging, git checkout main
- NEVER run: git merge into dev/staging/main, git rebase

### Protected Files — DO NOT MODIFY
${[...PROTECTED_FILES].map(f => `- \`${f}\``).join('\n')}

### Blocked Commands — NEVER EXECUTE
${BLOCKED_COMMANDS.map(c => `- \`${c}\``).join('\n')}

### Scope
- Focus ONLY on your assigned task
- Do NOT fix unrelated issues (note them in your commit message instead)
- Do NOT add documentation, changelog entries, or version bumps
- Do NOT install new npm packages without clear necessity`;
}

// ── Violation Scanner ───────────────────────────────────────────────────────

/**
 * Scan a nightly branch's diff against dev for guardrail violations.
 * Returns an array of violations (empty = clean).
 *
 * @param {string} projectRoot
 * @param {string} branchName
 * @returns {Array<{type: string, detail: string, severity: string}>}
 */
export function scanBranchViolations(projectRoot, branchName) {
  const violations = [];

  const diffResult = spawnSync('git', ['diff', '--name-only', `dev...${branchName}`], {
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

  return violations;
}

// ── Git Helpers ─────────────────────────────────────────────────────────────

/** Verify the current git branch matches the expected nightly branch. */
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
