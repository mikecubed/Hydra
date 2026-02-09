#!/usr/bin/env node
/**
 * Hydra Nightly Runner — Autonomous overnight task execution.
 *
 * Processes a queue of tasks on isolated nightly/* branches, never touching
 * dev/staging/main. Manages budget with Claude → Codex 5.3 escalation.
 *
 * Usage:
 *   node lib/hydra-nightly.mjs                          # uses defaults
 *   node lib/hydra-nightly.mjs project=E:/Dev/SideQuest  # explicit project
 *   node lib/hydra-nightly.mjs max-tasks=2               # override max tasks
 *
 * Flow:
 *   1. Validate: must be on dev, clean working tree
 *   2. Load queue (nightly-queue.md → TODO.md fallback)
 *   3. For each task:
 *      a. Check budget → decide agent (Claude or Codex 5.3)
 *      b. Create branch: nightly/<date>/<slug>
 *      c. Dispatch agent (headless CLI)
 *      d. Run verification (npm run typecheck)
 *      e. Scan for violations
 *      f. Record result + token delta
 *      g. Return to dev
 *   4. Generate morning report
 */

import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { loadNightlyQueue, taskToSlug } from './hydra-nightly-queue.mjs';
import {
  BudgetTracker,
  buildSafetyPrompt,
  buildCodexHandoffPrompt,
  scanBranchViolations,
  verifyBranch,
  isCleanWorkingTree,
  CODEX_HANDOFF_MODEL,
} from './hydra-nightly-guardrails.mjs';
import { resolveProject } from './hydra-config.mjs';
import { resolveVerificationPlan } from './hydra-verification.mjs';
import { runProcess, ensureDir, parseArgs } from './hydra-utils.mjs';
import { recordCallStart, recordCallComplete, recordCallError } from './hydra-metrics.mjs';
import pc from 'picocolors';

// ── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_PER_TASK_TIMEOUT_MS = 15 * 60 * 1000;  // 15 minutes
const DEFAULT_MAX_HOURS = 6;

// ── Logging ─────────────────────────────────────────────────────────────────

const log = {
  info:  (msg) => process.stderr.write(`  ${pc.blue('ℹ')} ${msg}\n`),
  ok:    (msg) => process.stderr.write(`  ${pc.green('✓')} ${msg}\n`),
  warn:  (msg) => process.stderr.write(`  ${pc.yellow('⚠')} ${msg}\n`),
  error: (msg) => process.stderr.write(`  ${pc.red('✗')} ${msg}\n`),
  task:  (msg) => process.stderr.write(`\n${pc.bold(pc.cyan('▶'))} ${pc.bold(msg)}\n`),
  dim:   (msg) => process.stderr.write(`  ${pc.dim(msg)}\n`),
};

// ── Git Helpers ─────────────────────────────────────────────────────────────

function git(args, cwd) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 15_000,
    shell: process.platform === 'win32',
  });
}

function getCurrentBranch(cwd) {
  const r = git(['branch', '--show-current'], cwd);
  return (r.stdout || '').trim();
}

function checkoutDev(cwd) {
  git(['checkout', 'dev'], cwd);
}

function createNightlyBranch(cwd, branchName) {
  // Create from dev
  const r = git(['checkout', '-b', branchName, 'dev'], cwd);
  return r.status === 0;
}

function branchHasCommits(cwd, branchName) {
  const r = git(['log', `dev..${branchName}`, '--oneline'], cwd);
  return (r.stdout || '').trim().length > 0;
}

function getBranchStats(cwd, branchName) {
  const logResult = git(['log', `dev..${branchName}`, '--oneline'], cwd);
  const commits = (logResult.stdout || '').trim().split('\n').filter(Boolean).length;

  const diffResult = git(['diff', '--stat', `dev...${branchName}`], cwd);
  const statLines = (diffResult.stdout || '').trim().split('\n').filter(Boolean);
  const filesChanged = Math.max(0, statLines.length - 1); // Last line is summary

  return { commits, filesChanged };
}

// ── Agent Dispatch ──────────────────────────────────────────────────────────

/**
 * Build the Claude prompt for a nightly task.
 */
function buildClaudePrompt(task, branchName, projectRoot) {
  const safetyBlock = buildSafetyPrompt(branchName);

  return `# Nightly Autonomous Task

**Task:** ${task.title}
**Branch:** \`${branchName}\` (already checked out)
**Project:** ${projectRoot}

## Instructions
1. Read the project's CLAUDE.md for conventions and patterns
2. Read relevant source files to understand the codebase
3. Implement the task with focused, minimal changes
4. Commit your work with a descriptive message
5. Run \`npm run typecheck\` and fix any TypeScript errors you introduce

${safetyBlock}

## Begin
Start working on the task now.`;
}

/**
 * Execute an agent CLI as a headless subprocess.
 * Returns { ok, output, durationMs, timedOut }.
 */
function executeAgent(agent, prompt, { cwd, timeoutMs, modelOverride } = {}) {
  return new Promise((resolve) => {
    let cmd, args;

    if (agent === 'codex') {
      const sandbox = 'auto-edit';
      args = ['exec', prompt, '-s', sandbox, '-C', cwd];
      if (modelOverride) args.push('--model', modelOverride);
      cmd = 'codex';
    } else {
      // claude
      args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'auto-edit'];
      if (modelOverride) args.push('--model', modelOverride);
      cmd = 'claude';
    }

    const chunks = [];
    let totalBytes = 0;
    const maxBytes = 64 * 1024;

    const child = spawn(cmd, args, {
      cwd,
      windowsHide: true,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (d) => {
      totalBytes += Buffer.byteLength(d);
      chunks.push(d);
      while (totalBytes > maxBytes && chunks.length > 1) {
        const dropped = chunks.shift();
        totalBytes -= Buffer.byteLength(dropped);
      }
    });

    // Swallow stderr (agent internal progress)
    child.stderr.on('data', () => {});

    const startTime = Date.now();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }, timeoutMs || DEFAULT_PER_TASK_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        output: chunks.join(''),
        error: err.message,
        durationMs: Date.now() - startTime,
        timedOut: false,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        output: chunks.join(''),
        error: code !== 0 ? `Exit code ${code}` : null,
        durationMs: Date.now() - startTime,
        timedOut,
      });
    });
  });
}

// ── Verification ────────────────────────────────────────────────────────────

function runVerification(projectRoot) {
  const plan = resolveVerificationPlan(projectRoot);
  if (!plan.enabled) {
    return { ran: false, passed: true, command: '', output: '' };
  }

  log.dim(`Verifying: ${plan.command}`);
  const parts = plan.command.split(' ');
  const result = runProcess(parts[0], parts.slice(1), plan.timeoutMs, { cwd: projectRoot });

  return {
    ran: true,
    passed: result.ok,
    command: plan.command,
    output: (result.stdout || '').slice(-2000) + (result.stderr || '').slice(-1000),
  };
}

// ── Report Generation ───────────────────────────────────────────────────────

function generateReport(results, budgetSummary, runMeta) {
  const { startedAt, finishedAt, source, totalTasks, processedTasks, stopReason } = runMeta;

  const startStr = new Date(startedAt).toLocaleTimeString('en-US', { hour12: false });
  const endStr = new Date(finishedAt).toLocaleTimeString('en-US', { hour12: false });
  const durationMs = finishedAt - startedAt;
  const durationStr = formatDuration(durationMs);
  const dateStr = new Date(startedAt).toISOString().split('T')[0];
  const tokensStr = `~${budgetSummary.consumed.toLocaleString()}`;

  const lines = [
    `# Nightly Run — ${dateStr}`,
    `Started: ${startStr} | Finished: ${endStr} | Duration: ${durationStr}`,
    `Tasks: ${processedTasks}/${totalTasks} processed` +
      (stopReason ? ` (stopped: ${stopReason})` : '') +
      ` | Tokens: ${tokensStr}`,
    `Source: ${source}`,
    '',
    '## Results',
  ];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const tokenNote = r.tokensUsed ? ` — ~${r.tokensUsed.toLocaleString()} tokens` : '';
    const statusTag = r.status.toUpperCase();
    const agentNote = r.agent !== 'claude' ? ` (${r.agent})` : '';

    lines.push(`### ${i + 1}. ${r.slug} [${statusTag}]${tokenNote}${agentNote}`);
    lines.push(`- Branch: \`${r.branch}\``);
    lines.push(`- Commits: ${r.commits} | Files: ${r.filesChanged} | Typecheck: ${r.verification}`);
    if (r.violations.length > 0) {
      lines.push(`- **Violations:** ${r.violations.length}`);
      for (const v of r.violations) {
        lines.push(`  - [${v.severity}] ${v.detail}`);
      }
    }
    lines.push(`- Duration: ${formatDuration(r.durationMs)}`);
    lines.push(`- Review: \`git log dev..${r.branch} --oneline\``);
    lines.push('');
  }

  lines.push('## Quick Commands');
  lines.push('```');
  lines.push(`git branch --list "nightly/${dateStr}/*"    # list branches`);
  lines.push(`git diff dev...nightly/${dateStr}/<slug>     # review changes`);
  lines.push('npm run hydra:nightly:review                 # interactive merge');
  lines.push('npm run hydra:nightly:clean                  # delete all nightly branches');
  lines.push('```');
  lines.push('');
  lines.push('## Budget Summary');
  lines.push(`- Start tokens: ${budgetSummary.startTokens.toLocaleString()}`);
  lines.push(`- End tokens: ${budgetSummary.endTokens.toLocaleString()}`);
  lines.push(`- Consumed: ${budgetSummary.consumed.toLocaleString()}`);
  lines.push(`- Budget limit: ${budgetSummary.hardLimit.toLocaleString()}`);
  lines.push(`- Avg per task: ${budgetSummary.avgPerTask.toLocaleString()}`);
  if (budgetSummary.taskDeltas.length > 0) {
    lines.push('');
    lines.push('| Task | Tokens | Duration |');
    lines.push('|------|--------|----------|');
    for (const d of budgetSummary.taskDeltas) {
      lines.push(`| ${d.slug} | ${d.tokens.toLocaleString()} | ${formatDuration(d.durationMs)} |`);
    }
  }
  lines.push('');
  lines.push(`> Reminder: Check \`/usage\` in Claude Code to verify actual token spend.`);

  return lines.join('\n');
}

function generateReportJSON(results, budgetSummary, runMeta) {
  return {
    ...runMeta,
    budget: budgetSummary,
    results: results.map((r) => ({
      slug: r.slug,
      title: r.title,
      branch: r.branch,
      status: r.status,
      agent: r.agent,
      tokensUsed: r.tokensUsed,
      durationMs: r.durationMs,
      commits: r.commits,
      filesChanged: r.filesChanged,
      verification: r.verification,
      violations: r.violations,
    })),
  };
}

function formatDuration(ms) {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m`;
}

// ── Main Runner ─────────────────────────────────────────────────────────────

async function main() {
  const { options } = parseArgs(process.argv);
  const startedAt = Date.now();
  const dateStr = new Date().toISOString().split('T')[0];

  // ── Resolve project ───────────────────────────────────────────────────
  let config;
  try {
    config = resolveProject({ project: options.project });
  } catch (err) {
    log.error(`Project resolution failed: ${err.message}`);
    process.exit(1);
  }

  const { projectRoot, coordDir } = config;
  log.info(`Project: ${projectRoot}`);

  // ── Validate preconditions ────────────────────────────────────────────
  const currentBranch = getCurrentBranch(projectRoot);
  if (currentBranch !== 'dev') {
    log.error(`Must be on 'dev' branch (currently on '${currentBranch}')`);
    process.exit(1);
  }

  if (!isCleanWorkingTree(projectRoot)) {
    log.error('Working tree is not clean. Commit or stash changes first.');
    process.exit(1);
  }

  log.ok('Preconditions met: on dev, clean working tree');

  // ── Load task queue ───────────────────────────────────────────────────
  const maxTasksOverride = options['max-tasks'] ? parseInt(options['max-tasks'], 10) : undefined;
  const { tasks, config: queueConfig, source } = loadNightlyQueue(projectRoot, {
    maxTasks: maxTasksOverride,
  });

  if (tasks.length === 0) {
    log.warn('No tasks found in queue. Nothing to do.');
    process.exit(0);
  }

  log.info(`Queue: ${tasks.length} tasks from ${source}`);
  for (const t of tasks) {
    log.dim(`  - [${t.slug}] ${t.title}`);
  }

  // ── Initialize budget tracker ─────────────────────────────────────────
  const budgetOverrides = {};
  if (options['hard-limit']) budgetOverrides.hardLimit = parseInt(options['hard-limit'], 10);
  if (options['soft-limit']) budgetOverrides.softLimit = parseInt(options['soft-limit'], 10);

  const budget = new BudgetTracker(budgetOverrides);
  budget.recordStart();
  log.info(`Budget: ${budget.hardLimit.toLocaleString()} token hard limit`);

  // ── Resolve config ────────────────────────────────────────────────────
  const perTaskTimeoutMs = (queueConfig.perTaskTimeoutMin || 15) * 60 * 1000;
  const maxHoursMs = (options['max-hours']
    ? parseFloat(options['max-hours'])
    : queueConfig.maxHours || DEFAULT_MAX_HOURS) * 60 * 60 * 1000;

  // ── Ensure nightly report directory ───────────────────────────────────
  const nightlyDir = path.join(coordDir, 'nightly');
  ensureDir(nightlyDir);

  // ── Task loop ─────────────────────────────────────────────────────────
  const results = [];
  let stopReason = null;
  let useCodex = false;  // Flips to true after handoff threshold

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const branchName = `nightly/${dateStr}/${task.slug}`;

    // Time limit check
    if (Date.now() - startedAt > maxHoursMs) {
      stopReason = 'time limit';
      log.warn(`Time limit reached (${formatDuration(maxHoursMs)}). Stopping.`);
      break;
    }

    // Budget check
    const budgetCheck = budget.check();

    if (budgetCheck.action === 'hard_stop') {
      stopReason = 'hard budget limit';
      log.error(`HARD STOP: ${budgetCheck.reason}`);
      break;
    }

    if (budgetCheck.action === 'soft_stop') {
      stopReason = 'soft budget limit';
      log.warn(`SOFT STOP: ${budgetCheck.reason}`);
      break;
    }

    if (budgetCheck.action === 'handoff_codex') {
      useCodex = true;
      log.warn(budgetCheck.reason);
      log.info(`Remaining tasks will use Codex 5.3 (${CODEX_HANDOFF_MODEL})`);
    }

    if (budgetCheck.action === 'warn') {
      log.warn(budgetCheck.reason);
    }

    if (!budgetCheck.canFitNextTask && i > 0) {
      stopReason = 'predicted budget exceeded';
      log.warn(`Predicted next task (~${budgetCheck.avgPerTask.toLocaleString()} tokens) would exceed remaining budget. Stopping.`);
      break;
    }

    // ── Execute task ──────────────────────────────────────────────────
    const agent = useCodex ? 'codex' : 'claude';
    log.task(`Task ${i + 1}/${tasks.length}: ${task.title} [${agent}]`);

    // Create nightly branch
    if (!createNightlyBranch(projectRoot, branchName)) {
      log.error(`Failed to create branch: ${branchName}`);
      results.push({
        slug: task.slug, title: task.title, branch: branchName,
        status: 'error', agent, tokensUsed: 0, durationMs: 0,
        commits: 0, filesChanged: 0, verification: 'SKIP',
        violations: [], error: 'Branch creation failed',
      });
      checkoutDev(projectRoot);
      continue;
    }
    log.ok(`Branch: ${branchName}`);

    // Build prompt
    let prompt;
    if (useCodex) {
      prompt = buildCodexHandoffPrompt({
        projectRoot,
        task,
        branchName,
        completedTasks: results,
        budgetSummary: budget.getSummary(),
      });
    } else {
      prompt = buildClaudePrompt(task, branchName, projectRoot);
    }

    // Dispatch agent
    const modelOverride = useCodex ? CODEX_HANDOFF_MODEL : undefined;
    const handle = recordCallStart(agent, modelOverride || 'default');

    log.dim(`Dispatching ${agent}${modelOverride ? ` (${modelOverride})` : ''}...`);
    const agentResult = await executeAgent(agent, prompt, {
      cwd: projectRoot,
      timeoutMs: perTaskTimeoutMs,
      modelOverride,
    });

    if (agentResult.ok) {
      recordCallComplete(handle, agentResult);
    } else {
      recordCallError(handle, new Error(agentResult.error || 'unknown'));
    }

    const taskDurationMs = agentResult.durationMs;
    const tokenDelta = budget.recordTaskEnd(task.slug, taskDurationMs);

    if (agentResult.timedOut) {
      log.warn(`Task timed out after ${formatDuration(perTaskTimeoutMs)}`);
    }

    // ── Post-task checks ──────────────────────────────────────────────

    // Verify we're still on the right branch (agent shouldn't have escaped)
    const branchCheck = verifyBranch(projectRoot, branchName);
    if (!branchCheck.ok) {
      log.error(`Branch escape detected! Expected '${branchName}', on '${branchCheck.currentBranch}'`);
      // Force back to the nightly branch for cleanup, then dev
      git(['checkout', branchName], projectRoot);
    }

    // Run verification
    const verification = runVerification(projectRoot);
    const verificationStatus = !verification.ran ? 'SKIP' : verification.passed ? 'PASS' : 'FAIL';
    if (verification.ran) {
      if (verification.passed) {
        log.ok(`Typecheck: PASS`);
      } else {
        log.warn(`Typecheck: FAIL`);
      }
    }

    // Scan for violations
    const violations = scanBranchViolations(projectRoot, branchName);
    if (violations.length > 0) {
      log.warn(`${violations.length} violation(s) detected:`);
      for (const v of violations) {
        log.dim(`  [${v.severity}] ${v.detail}`);
      }
    }

    // Get commit/file stats
    const stats = getBranchStats(projectRoot, branchName);

    // Determine status
    let status = 'success';
    if (agentResult.timedOut) status = 'timeout';
    else if (!agentResult.ok) status = 'error';
    else if (!verification.passed && verification.ran) status = 'partial';

    const taskTokens = tokenDelta.tokens;
    log.ok(`Done: ${status} | ${stats.commits} commits | ${stats.filesChanged} files | ~${taskTokens.toLocaleString()} tokens | ${formatDuration(taskDurationMs)}`);

    results.push({
      slug: task.slug,
      title: task.title,
      branch: branchName,
      status,
      agent,
      tokensUsed: taskTokens,
      durationMs: taskDurationMs,
      commits: stats.commits,
      filesChanged: stats.filesChanged,
      verification: verificationStatus,
      violations,
      error: agentResult.error,
    });

    // Return to dev for next task
    checkoutDev(projectRoot);
  }

  // ── Always return to dev ────────────────────────────────────────────
  const finalBranch = getCurrentBranch(projectRoot);
  if (finalBranch !== 'dev') {
    checkoutDev(projectRoot);
  }

  // ── Generate reports ────────────────────────────────────────────────
  const finishedAt = Date.now();
  const budgetSummary = budget.getSummary();
  const runMeta = {
    startedAt,
    finishedAt,
    date: dateStr,
    source,
    totalTasks: tasks.length,
    processedTasks: results.length,
    stopReason,
  };

  const mdReport = generateReport(results, budgetSummary, runMeta);
  const jsonReport = generateReportJSON(results, budgetSummary, runMeta);

  // Save reports
  const mdPath = path.join(nightlyDir, `NIGHTLY_${dateStr}.md`);
  const jsonPath = path.join(nightlyDir, `NIGHTLY_${dateStr}.json`);

  fs.writeFileSync(mdPath, mdReport, 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2), 'utf8');

  log.ok(`Report saved: ${mdPath}`);
  log.ok(`JSON saved:   ${jsonPath}`);

  // ── Summary ─────────────────────────────────────────────────────────
  const successCount = results.filter(r => r.status === 'success').length;
  const failCount = results.filter(r => r.status !== 'success').length;
  const totalTokens = budgetSummary.consumed;

  console.log('');
  console.log(pc.bold('═══ Nightly Run Complete ═══'));
  console.log(`  Tasks: ${pc.green(successCount + ' passed')}${failCount ? `, ${pc.red(failCount + ' failed')}` : ''} of ${tasks.length} queued`);
  console.log(`  Tokens: ~${totalTokens.toLocaleString()} consumed`);
  console.log(`  Duration: ${formatDuration(finishedAt - startedAt)}`);
  if (stopReason) console.log(`  Stopped: ${stopReason}`);
  console.log(`  Report: ${mdPath}`);
  console.log('');
}

// ── Entry ───────────────────────────────────────────────────────────────────

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  // Always try to get back to dev
  try {
    const projectRoot = process.cwd();
    const branch = getCurrentBranch(projectRoot);
    if (branch !== 'dev' && branch.startsWith('nightly/')) {
      checkoutDev(projectRoot);
    }
  } catch { /* last resort */ }
  process.exit(1);
});
