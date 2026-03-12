/**
 * Hydra Actualize — experimental self-actualization runner.
 *
 * A pragmatic autonomous loop for improving Hydra (or any project) by:
 *   SELF-SNAPSHOT → SCAN → DISCOVER → PRIORITIZE → EXECUTE (branch per task) → REPORT
 *
 * Notes:
 * - Makes changes only on isolated branches (default prefix: actualize/<date>/...)
 * - Does not auto-merge; use hydra-actualize-review.mjs to merge/clean
 *
 * Usage:
 *   node lib/hydra-actualize.mjs                       # defaults
 *   node lib/hydra-actualize.mjs max-tasks=3 max-hours=2
 *   node lib/hydra-actualize.mjs --dry-run
 *   node lib/hydra-actualize.mjs --interactive
 */

import './hydra-env.ts';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import pc from 'picocolors';

import { resolveProject, loadHydraConfig, HYDRA_ROOT } from './hydra-config.ts';
import {
  initAgentRegistry,
  classifyTask,
  bestAgentFor,
  getActiveModel,
  getAgent,
} from './hydra-agents.ts';
import { parseArgs, ensureDir, runProcess } from './hydra-utils.ts';
import { resolveVerificationPlan } from './hydra-verification.ts';
import { recordCallStart, recordCallComplete, recordCallError } from './hydra-metrics.ts';
import { getAgentInstructionFile } from './hydra-sync-md.ts';
import { BudgetTracker } from './hydra-shared/budget-tracker.ts';
import { executeAgentWithRecovery } from './hydra-shared/agent-executor.ts';
import {
  buildSafetyPrompt,
  verifyBranch,
  isCleanWorkingTree,
  scanBranchViolations,
} from './hydra-shared/guardrails.ts';
import {
  git,
  getCurrentBranch,
  checkoutBranch,
  createBranch,
  branchExists,
  getBranchStats,
} from './hydra-shared/git-ops.ts';
import {
  BASE_PROTECTED_FILES,
  BASE_PROTECTED_PATTERNS,
  BLOCKED_COMMANDS,
} from './hydra-shared/constants.ts';
import {
  scanAllSources,
  deduplicateTasks,
  prioritizeTasks,
  type ScannedTask,
} from './hydra-tasks-scanner.ts';
import { runDiscovery } from './hydra-nightly-discovery.ts';
import { buildSelfSnapshot, formatSelfSnapshotForPrompt } from './hydra-self.ts';
import { buildSelfIndex, formatSelfIndexForPrompt } from './hydra-self-index.ts';
import { detectInstalledCLIs } from './hydra-cli-detect.ts';

// ── Logging ─────────────────────────────────────────────────────────────────

const log = {
  info: (msg: string) => process.stderr.write(`  ${pc.blue('i')} ${msg}\n`),
  ok: (msg: string) => process.stderr.write(`  ${pc.green('+')} ${msg}\n`),
  warn: (msg: string) => process.stderr.write(`  ${pc.yellow('!')} ${msg}\n`),
  error: (msg: string) => process.stderr.write(`  ${pc.red('x')} ${msg}\n`),
  phase: (name: string) => process.stderr.write(`\n${pc.bold(pc.magenta(`[${name}]`))}\n`),
  task: (msg: string) => process.stderr.write(`\n${pc.bold(pc.cyan('>'))} ${pc.bold(msg)}\n`),
  dim: (msg: string) => process.stderr.write(`  ${pc.dim(msg)}\n`),
};

function formatDuration(ms: number) {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${String(secs)}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${String(mins)}m ${String(remSecs)}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${String(hrs)}h ${String(remMins)}m`;
}

function askLine(rl: readline.Interface, question: string) {
  return new Promise<string>((resolve) => {
    rl.question(question, (answer: string) => {
      resolve(answer.trim());
    });
  });
}

async function phaseSelect(sortedTasks: ScannedTask[], maxTasks: number) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    console.log(pc.bold(`\nSelect up to ${String(maxTasks)} task(s) to run:\n`));
    for (let i = 0; i < Math.min(sortedTasks.length, 20); i++) {
      const t = sortedTasks[i];
      let prioColor: (s: string) => string;
      if (t.priority === 'high') {
        prioColor = pc.red;
      } else if (t.priority === 'low') {
        prioColor = pc.dim;
      } else {
        prioColor = pc.yellow;
      }
      console.log(
        `  ${pc.bold(String(i + 1).padStart(2))}. ${prioColor(t.priority.padEnd(6))} [${t.source}] ${t.title}`,
      );
      console.log(`      ${pc.dim(`[${t.taskType}] → ${t.suggestedAgent} | ${t.sourceRef}`)}`);
    }
    if (sortedTasks.length > 20) {
      console.log(pc.dim(`\n  ... and ${String(sortedTasks.length - 20)} more`));
    }
    console.log(pc.dim(`\n  Enter numbers (e.g. 1,3,5) or press Enter for top ${String(maxTasks)}.`));
    const answer = await askLine(rl, pc.bold('  Select: '));
    if (!answer) return sortedTasks.slice(0, maxTasks);

    const indices = answer
      .split(',')
      .map((s) => Number.parseInt(s.trim(), 10) - 1)
      .filter((i) => i >= 0 && i < sortedTasks.length);

    if (indices.length === 0) return sortedTasks.slice(0, maxTasks);
    return indices.map((i) => sortedTasks[i]).slice(0, maxTasks);
  } finally {
    rl.close();
  }
}

// ── Budget Thresholds ───────────────────────────────────────────────────────

function buildThresholds(budgetCfg: any) {
  return [
    { pct: 0.95, action: 'hard_stop', reason: 'Hard limit reached: {pct}% of budget used' },
    {
      pct: 0.85,
      action: 'soft_stop',
      reason: 'Soft limit reached: {pct}% budget ({consumed} tokens)',
    },
    {
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- 0 is a valid threshold (no handoff); || 0.7 is intentional
      pct: budgetCfg.handoffThreshold || 0.7,
      action: 'handoff',
      reason: '{pct}% budget — switching remaining tasks to economy models',
      once: true,
    },
    { pct: 0.5, action: 'warn', reason: '{pct}% budget used ({consumed} tokens)' },
  ];
}

// ── Prompt Builder ──────────────────────────────────────────────────────────

function buildTaskPrompt(
  task: ScannedTask,
  branchName: string,
  projectRoot: string,
  agent: string,
  opts: { selfSnapshotText?: string; selfIndexText?: string } = {},
) {
  const instructionFile = getAgentInstructionFile(agent, projectRoot);

  const selfSnapshot = opts.selfSnapshotText ?? '';
  const selfIndex = opts.selfIndexText ?? '';

  const safetyBlock = buildSafetyPrompt(branchName, {
    runner: 'actualize runner',
    reportName: 'actualize report',
    protectedFiles: new Set(BASE_PROTECTED_FILES),
    blockedCommands: BLOCKED_COMMANDS,
    attribution: { pipeline: 'hydra-actualize', agent },
  });

  const bodySection = task.body ? `\n## Details\n${task.body}\n` : '';

  const sourceNote = task.sourceRef
    ? `**Source:** ${task.source} (${task.sourceRef})`
    : `**Source:** ${task.source}`;

  const intent = `You are Hydra improving itself. Be bold, but keep scope bounded and verifiable.
- Prefer changes that increase self-awareness, diagnostics, safety, and autonomy.
- Add/extend tests when behavior changes.
- Run verification (or ensure it runs) and fix failures you introduce.
- Commit your work with a descriptive message.`;

  return `# Hydra Actualize Task

**Task:** ${task.title}
**Branch:** \`${branchName}\` (already checked out)
**Project:** ${projectRoot}
${sourceNote}

## Self Context (ground truth)
${selfSnapshot}

${selfIndex}

## Intent
${intent}

## Instructions
1. Read the project's \`${instructionFile}\` for conventions and patterns
2. Read relevant source files to understand the current implementation
3. Implement the task with focused, minimal changes (no sweeping rewrite)
4. Commit your work
5. Ensure verification passes
${bodySection}
${safetyBlock}

## Begin
Start working on the task now.`;
}

// ── Verification ────────────────────────────────────────────────────────────

function runVerification(projectRoot: string, cfg: any) {
  const plan = resolveVerificationPlan(projectRoot, cfg);
  if (!plan.enabled || !plan.command) {
    return { ran: false, passed: true, command: '', output: '', reason: plan.reason || 'disabled' };
  }

  log.dim(`Verifying: ${plan.command}`);
  const parts = plan.command.split(/\s+/);
  const result = runProcess(parts[0], parts.slice(1), plan.timeoutMs, { cwd: projectRoot });
  return {
    ran: true,
    passed: result.ok,
    command: plan.command,
    output: (result.stdout || '').slice(-2000) + (result.stderr || '').slice(-1000),
    reason: plan.reason || '',
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { options } = parseArgs(process.argv);
  const startedAt = Date.now();
  const dateStr = new Date().toISOString().split('T')[0];

  // Resolve project (default: Hydra itself)
  let projectConfig;
  try {
    const projectOpt = (options['project'] as string | undefined) ?? HYDRA_ROOT;
    projectConfig = resolveProject({ project: projectOpt });
  } catch (err) {
    log.error(`Project resolution failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const { projectRoot, coordDir } = projectConfig;
  log.info(`Project: ${projectRoot}`);

  initAgentRegistry();

  const cfg = loadHydraConfig();
  const baseBranch = String(
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- options['base-branch'] can be false (boolean flag); || is intentional
    options['base-branch'] || cfg.evolve?.baseBranch ?? cfg.nightly?.baseBranch ?? 'dev',
  );
  const branchPrefix = (options['branch-prefix'] as string) || 'actualize';
  const maxTasks = options['max-tasks'] ? Number.parseInt(options['max-tasks'] as string, 10) : 5;
  const maxHours = options['max-hours'] ? Number.parseFloat(options['max-hours'] as string) : 4;
  const isDryRun = !!options['dry-run'];
  const isInteractive = !!options['interactive'];
  const noDiscovery = !!options['no-discovery'];

  // Preconditions
  const currentBranch = getCurrentBranch(projectRoot);
  if (currentBranch !== baseBranch) {
    log.error(`Must be on '${baseBranch}' branch (currently on '${currentBranch}')`);
    process.exitCode = 1;
    return;
  }
  if (!isCleanWorkingTree(projectRoot)) {
    log.error('Working tree is not clean. Commit or stash changes first.');
    process.exitCode = 1;
    return;
  }
  log.ok(`Preconditions met: on ${baseBranch}, clean working tree`);

  // ── Phase: SELF ──
  log.phase('SELF');
  const actualizeDir = path.join(coordDir, 'actualize');
  ensureDir(actualizeDir);

  const snapshotObj = buildSelfSnapshot({ projectRoot, projectName: projectConfig.projectName });
  const snapshotText = formatSelfSnapshotForPrompt(snapshotObj, { maxLines: 120 });
  const indexObj = buildSelfIndex(HYDRA_ROOT);
  const indexText = formatSelfIndexForPrompt(indexObj, { maxChars: 7000 });

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const snapshotPath = path.join(actualizeDir, `SELF_SNAPSHOT_${dateStr}_${ts}.json`);
  const indexPath = path.join(actualizeDir, `SELF_INDEX_${dateStr}_${ts}.json`);
  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshotObj, null, 2)}\n`, 'utf8');
  fs.writeFileSync(indexPath, `${JSON.stringify(indexObj, null, 2)}\n`, 'utf8');
  log.ok(`Wrote self snapshot: ${path.relative(projectRoot, snapshotPath)}`);
  log.ok(`Wrote self index: ${path.relative(projectRoot, indexPath)}`);

  // ── Phase: SCAN ──
  log.phase('SCAN');
  const scanned = scanAllSources(projectRoot);
  log.info(`Scanned ${String(scanned.length)} task(s) from TODO comments / TODO.md / GitHub issues`);

  // ── Phase: DISCOVER ──
  let discovered: unknown[] = [];
  if (noDiscovery) {
    log.dim('AI discovery: disabled');
  } else {
    log.phase('DISCOVER');
    const discoveryCfg = cfg.nightly?.aiDiscovery ?? {};
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- options value can be false (boolean flag); || is intentional
    const discoveryAgent = String(options['discovery-agent'] || discoveryCfg.agent || 'gemini');
    const focus = options['focus']
      ? String(options['focus'])
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : discoveryCfg.focus ?? [];
    const maxSuggestions = options['discover-max']
      ? Number.parseInt(options['discover-max'] as string, 10)
      : discoveryCfg.maxSuggestions ?? 6;

    const extraContext = [snapshotText, indexText].join('\n\n');

    discovered = await runDiscovery(projectRoot, {
      agent: discoveryAgent,
      maxSuggestions,
      focus,
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- 0ms timeout is invalid; || is intentional
      timeoutMs: discoveryCfg.timeoutMs ?? 5 * 60 * 1000,
      existingTasks: scanned.map((t) => t.title),
      profile: 'actualize',
      extraContext,
    });
  }

  // Merge + prioritize
  log.phase('PRIORITIZE');
  const all = [...scanned, ...discovered] as ScannedTask[];
  const deduped = deduplicateTasks(all);
  const sorted = prioritizeTasks(deduped);
  let selected = sorted.slice(0, Math.max(1, maxTasks));

  if (isInteractive && process.stdin.isTTY) {
    selected = await phaseSelect(sorted, Math.max(1, maxTasks));
  }

  if (selected.length === 0) {
    log.warn('No tasks to execute. Nothing to do.');
    // eslint-disable-next-line n/no-process-exit -- top-level main function; safe to exit cleanly
    process.exit(0);
  }

  log.info(`Selected ${String(selected.length)} task(s)`);
  for (const t of selected) {
    let prioColor2: (s: string) => string;
    if (t.priority === 'high') {
      prioColor2 = pc.red;
    } else if (t.priority === 'low') {
      prioColor2 = pc.dim;
    } else {
      prioColor2 = pc.yellow;
    }
    log.dim(`  ${prioColor2(t.priority.padEnd(6))} [${t.source}] ${t.title}`);
  }

  if (isDryRun) {
    console.log('');
    console.log(pc.bold('=== Dry Run Complete ==='));
    console.log(`  Would execute ${String(selected.length)} task(s):`);
    for (const t of selected) {
      console.log(`    - [${t.source}] ${t.title} -> ${t.suggestedAgent}`);
    }
    console.log('');
    // eslint-disable-next-line n/no-process-exit -- top-level main function; safe to exit cleanly
    process.exit(0);
  }

  // ── Phase: EXECUTE ──
  log.phase('EXECUTE');

  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- fallback object needed
  const budgetCfg = cfg.nightly?.budget || {
    softLimit: 300_000,
    hardLimit: 450_000,
    perTaskEstimate: 100_000,
  };
  const budget = new BudgetTracker({
    softLimit: budgetCfg.softLimit ?? 0,
    hardLimit: budgetCfg.hardLimit ?? 0,
    unitEstimate: budgetCfg.perTaskEstimate ?? 0,
    unitLabel: 'task',
    thresholds: buildThresholds(budgetCfg),
  });
  budget.recordStart();
  log.info(`Budget: ${budget.hardLimit.toLocaleString()} token hard limit`);

  const results = [];
  const maxHoursMs = maxHours * 60 * 60 * 1000;
  let useEconomy = false;
  let stopReason = null;

  const installedCLIs = detectInstalledCLIs();
  for (let i = 0; i < selected.length; i++) {
    const task = selected[i];

    if (Date.now() - startedAt > maxHoursMs) {
      stopReason = 'time limit';
      log.warn(`Time limit reached (${formatDuration(maxHoursMs)}). Stopping.`);
      break;
    }

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
    if (budgetCheck.action === 'handoff') {
      useEconomy = true;
      log.warn(budgetCheck.reason);
    }
    if (budgetCheck.action === 'warn') {
      log.warn(budgetCheck.reason);
    }

    const date = new Date().toISOString().split('T')[0];
    const branchName = `${branchPrefix}/${date}/${task.slug}`;

    // Choose agent — validate suggestedAgent against installedCLIs/enabled to avoid
    // dispatching to an unavailable or disabled agent when the suggestion is stale.
    const taskType = classifyTask(task.title);
    let agent = task.suggestedAgent;
    if (agent) {
      const agentDef = getAgent(agent);
      const isInstalled = !(agent in installedCLIs) || installedCLIs[agent];
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cfg.local may be undefined at runtime despite types
      const isLocalDisabled = agent === 'local' && !cfg.local?.enabled;
      if (!agentDef?.enabled || !isInstalled || isLocalDisabled) {
        agent = bestAgentFor(taskType, { installedCLIs });
      }
    } else {
      agent = bestAgentFor(taskType, { installedCLIs });
    }
    const modelOverride = useEconomy
      ? (getAgent(agent)?.economyModel(budgetCfg) ?? undefined)
      : undefined;

    log.task(`Task ${String(i + 1)}/${String(selected.length)}: ${task.title} [${agent}]`);

    if (branchExists(projectRoot, branchName)) {
      log.warn(`Branch already exists: ${branchName} — skipping`);
      results.push({
        slug: task.slug,
        title: task.title,
        branch: branchName,
        source: task.source,
        taskType: task.taskType || 'unknown',
        status: 'skipped',
        agent,
        tokensUsed: 0,
        durationMs: 0,
        commits: 0,
        filesChanged: 0,
        verification: 'SKIP',
        violations: [],
      });
      continue;
    }

    if (!createBranch(projectRoot, branchName, baseBranch)) {
      log.error(`Failed to create branch: ${branchName}`);
      results.push({
        slug: task.slug,
        title: task.title,
        branch: branchName,
        source: task.source,
        taskType: task.taskType || 'unknown',
        status: 'error',
        agent,
        tokensUsed: 0,
        durationMs: 0,
        commits: 0,
        filesChanged: 0,
        verification: 'SKIP',
        violations: [],
        error: 'Branch creation failed',
      });
      checkoutBranch(projectRoot, baseBranch);
      continue;
    }
    log.ok(`Branch: ${branchName}`);

    const prompt = buildTaskPrompt(task, branchName, projectRoot, agent, {
      selfSnapshotText: snapshotText,
      selfIndexText: indexText,
    });

    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string is not a valid model name
    const effectiveModel = modelOverride || getActiveModel(agent) || 'default';
    const handle = recordCallStart(agent, effectiveModel);
    log.dim(`Dispatching ${agent}${modelOverride ? ` (${modelOverride})` : ''}...`);

    let agentResult;
    try {
      agentResult = await executeAgentWithRecovery(agent, prompt, {
        cwd: projectRoot,
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- 0ms timeout is invalid; || is intentional
        timeoutMs: cfg.nightly?.perTaskTimeoutMs || 15 * 60 * 1000,
        modelOverride,
        progressIntervalMs: 15_000,
        onProgress: (elapsed, outputKB) => {
          const elStr = formatDuration(elapsed);
          const kbStr = outputKB > 0 ? ` | ${String(outputKB)}KB` : '';
          process.stderr.write(
            `\r  ${pc.dim(`${agent}: working... ${elStr}${kbStr}`)}${' '.repeat(20)}`,
          );
        },
      });
    } catch (err) {
      agentResult = {
        ok: false,
        output: '',
        stderr: '',
        error: err instanceof Error ? err.message : String(err),
        durationMs: 0,
      };
    }
    process.stderr.write(`\r${' '.repeat(100)}\r`);

    if (agentResult.ok) recordCallComplete(handle, agentResult as any);
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty string error should fall through to 'unknown'
    else recordCallError(handle, new Error(agentResult.error || 'unknown'));

    const taskDurationMs = agentResult.durationMs || 0;
    const tokenDelta = budget.recordUnitEnd(task.slug, taskDurationMs);

    // Branch integrity
    const branchCheck = verifyBranch(projectRoot, branchName);
    if (!branchCheck.ok) {
      log.error(
        `Branch escape detected! Expected '${branchName}', on '${branchCheck.currentBranch}'`,
      );
      try {
        git(['checkout', branchName], projectRoot);
      } catch {
        /* best effort */
      }
    }

    // Verification
    const verification = runVerification(projectRoot, cfg);
    let verificationStatus: string;
    if (!verification.ran) {
      verificationStatus = 'SKIP';
    } else if (verification.passed) {
      verificationStatus = 'PASS';
    } else {
      verificationStatus = 'FAIL';
    }
    if (verification.ran) {
      if (verification.passed) log.ok('Verification: PASS');
      else log.warn('Verification: FAIL');
    }

    // Violations
    const violations = scanBranchViolations(projectRoot, branchName, {
      baseBranch,
      protectedFiles: new Set(BASE_PROTECTED_FILES),
      protectedPatterns: [...BASE_PROTECTED_PATTERNS],
    });
    if (violations.length > 0) {
      log.warn(`${String(violations.length)} violation(s) detected`);
      for (const v of violations) log.dim(`  [${v.severity}] ${v.detail}`);
    }

    const stats = getBranchStats(projectRoot, branchName, baseBranch);
    let status = 'success';
    if (!agentResult.ok) status = 'error';
    else if (verification.ran && !verification.passed) status = 'partial';

    log.ok(
      `Done: ${status} | ${String(stats.commits)} commits | ${String(stats.filesChanged)} files | ~${tokenDelta.tokens.toLocaleString()} tokens | ${formatDuration(taskDurationMs)}`,
    );

    results.push({
      slug: task.slug,
      title: task.title,
      branch: branchName,
      source: task.source,
      taskType: task.taskType || 'unknown',
      status,
      agent,
      tokensUsed: tokenDelta.tokens,
      durationMs: taskDurationMs,
      commits: stats.commits,
      filesChanged: stats.filesChanged,
      verification: verificationStatus,
      violations,
    });

    checkoutBranch(projectRoot, baseBranch);
  }

  // Ensure base branch
  if (getCurrentBranch(projectRoot) !== baseBranch) {
    checkoutBranch(projectRoot, baseBranch);
  }

  // ── Phase: REPORT ──
  log.phase('REPORT');

  const runMeta = {
    date: dateStr,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    projectRoot,
    baseBranch,
    branchPrefix,
    totalTasks: selected.length,
    processedTasks: results.length,
    stopReason,
    artifacts: {
      selfSnapshot: path.relative(projectRoot, snapshotPath).replace(/\\/g, '/'),
      selfIndex: path.relative(projectRoot, indexPath).replace(/\\/g, '/'),
    },
  };

  const budgetSummary = budget.getSummary();
  if (stopReason) budgetSummary['stopReason'] = stopReason;

  const jsonReport = {
    ...runMeta,
    budget: budgetSummary,
    results,
  };

  const md = [];
  md.push(`# Hydra Actualize Report — ${runMeta.date}`);
  md.push('');
  md.push(`- Project: \`${runMeta.projectRoot}\``);
  md.push(`- Base branch: \`${runMeta.baseBranch}\``);
  md.push(`- Branch prefix: \`${runMeta.branchPrefix}\``);
  md.push(`- Tasks: ${String(runMeta.processedTasks)}/${String(runMeta.totalTasks)}`);
  if (runMeta.stopReason) md.push(`- Stopped: ${runMeta.stopReason}`);
  md.push(`- Self snapshot: \`${runMeta.artifacts.selfSnapshot}\``);
  md.push(`- Self index: \`${runMeta.artifacts.selfIndex}\``);
  md.push('');
  md.push('## Results');
  md.push('');
  md.push('| # | Task | Agent | Status | Verification | Branch |');
  md.push('|---|------|-------|--------|--------------|--------|');
  for (const [i, r] of results.entries()) {
    md.push(
      `| ${String(i + 1)} | ${r.title.slice(0, 60)} | ${r.agent} | ${r.status} | ${r.verification} | \`${r.branch}\` |`,
    );
  }
  md.push('');
  md.push('## Budget');
  md.push(
    `- Consumed: ${(budgetSummary['consumed'] as number | undefined ?? 0).toLocaleString()} of ${(budgetSummary['hardLimit'] as number | undefined ?? 0).toLocaleString()}`,
  );
  md.push(
    `- Avg per task: ${(budgetSummary['avgPerTask'] as number | undefined ?? 0).toLocaleString()}`,
  );
  md.push('');
  md.push('## Next');
  md.push('- Review and merge: `node lib/hydra-actualize-review.mjs review`');
  md.push('- Status: `node lib/hydra-actualize-review.mjs status`');
  md.push('- Clean branches: `node lib/hydra-actualize-review.mjs clean`');
  md.push('');

  const reportJsonPath = path.join(actualizeDir, `ACTUALIZE_${runMeta.date}.json`);
  const reportMdPath = path.join(actualizeDir, `ACTUALIZE_${runMeta.date}.md`);
  fs.writeFileSync(reportJsonPath, `${JSON.stringify(jsonReport, null, 2)}\n`, 'utf8');
  fs.writeFileSync(reportMdPath, md.join('\n'), 'utf8');

  log.ok(`Report: ${path.relative(projectRoot, reportMdPath)}`);
  log.ok(`Review: node lib/hydra-actualize-review.mjs review`);
}

main().catch((err: unknown) => {
  process.stderr.write(pc.red(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`));
  // eslint-disable-next-line n/no-process-exit -- inside .catch() callback; return does not propagate
  process.exit(1);
});
