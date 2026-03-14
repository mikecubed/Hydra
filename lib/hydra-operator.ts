/**
 * Hydra Operator Console (hydra:go)
 *
 * One-terminal command center for dispatching prompts to Gemini/Codex/Claude.
 * Dispatch is recorded as Hydra handoffs so each agent can pull with hydra:next.
 * Supports modes: auto (mini-round triage), handoff (direct), council (full deliberation).
 *
 * Usage:
 *   node hydra-operator.mjs prompt="Investigate auth deadlock"
 *   node hydra-operator.mjs              # interactive mode
 *   node hydra-operator.mjs mode=dispatch prompt="..."  # dispatch pipeline
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- T7A: operator uses polymorphic any for dynamic dispatch */
/* eslint-disable @typescript-eslint/strict-boolean-expressions, @typescript-eslint/no-non-null-assertion -- T7A: standard JS truthiness; type narrowing tracked as follow-up */
/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unnecessary-type-conversion -- T7A: operator uses || for truthiness-based defaults */
/* eslint-disable @typescript-eslint/no-misused-promises, require-atomic-updates -- T7A: CLI entry point */
/* eslint-disable no-await-in-loop, @typescript-eslint/no-base-to-string -- T7A: sequential processing */

/* eslint-disable unicorn/no-new-array, no-control-regex -- T7A: intentional patterns */

import './hydra-env.ts';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawnHydraNodeSync } from './hydra-exec-spawn.ts';
import { getAgent, getModelSummary, AGENT_TYPE, bestAgentFor } from './hydra-agents.ts';
import { checkUsage, renderUsageDashboard, formatTokens } from './hydra-usage.ts';
import { verifyAgentQuota } from './hydra-model-recovery.ts';
import {
  getSessionUsage,
  getMetricsSummary,
  estimateFlowDuration,
  resetMetrics,
} from './hydra-metrics.ts';
import { resolveProject, HYDRA_ROOT, loadHydraConfig, getRecentProjects } from './hydra-config.ts';
import { envFileExists } from './hydra-env.ts';
import {
  parseArgs,
  getPrompt,
  parseList,
  boolFlag,
  short,
  request,
  classifyPrompt,
} from './hydra-utils.ts';
import {
  renderStatsDashboard,
  agentBadge,
  label,
  sectionHeader,
  colorAgent,
  createSpinner,
  extractTopic,
  phaseNarrative,
  SUCCESS,
  ERROR,
  WARNING,
  DIM,
  ACCENT,
  shortModelName,
} from './hydra-ui.ts';
import {
  COMMAND_HELP,
  KNOWN_COMMANDS,
  SMART_TIER_MAP,
  printCommandHelp,
  printHelp,
  printSelfAwarenessStatus,
  printStatus,
} from './hydra-operator-ui.ts';
import {
  initStatusBar,
  destroyStatusBar,
  drawStatusBar,
  startEventStream,
  stopEventStream,
  onActivityEvent,
  setAgentActivity,
  setLastDispatch,
  setActiveMode,
  setDispatchContext,
  clearDispatchContext,
  setAgentExecMode,
} from './hydra-statusbar.ts';
import {
  workers,
  stopAllWorkers,
  _getWorkerStatus,
  startAgentWorkers,
} from './hydra-operator-workers.ts';
import {
  promptChoice,
  isChoiceActive,
  isAutoAccepting,
  setAutoAccept,
  resetAutoAccept,
} from './hydra-prompt-choice.ts';
import {
  conciergeTurn,
  conciergeSuggest,
  resetConversation,
  isConciergeAvailable,
  getConciergeConfig,
  getConciergeModelLabel,
  setConciergeBaseUrl,
} from './hydra-concierge.ts';
import { detectAvailableProviders } from './hydra-concierge-providers.ts';
import { syncHydraMd } from './hydra-sync-md.ts';
import { registerBuiltInSubAgents } from './hydra-sub-agents.ts';
import {
  detectSituationalQuery,
  buildActivityDigest,
  formatDigestForPrompt,
  generateSitrep,
} from './hydra-activity.ts';
import {
  loadCodebaseContext,
  detectCodebaseQuery,
  getTopicContext,
  getBaselineContext,
  searchKnowledgeBase,
} from './hydra-codebase-context.ts';
import { buildSelfSnapshot, formatSelfSnapshotForPrompt } from './hydra-self.ts';
import { buildSelfIndex, formatSelfIndexForPrompt } from './hydra-self-index.ts';
import {
  runForgeWizard,
  listForgedAgents,
  removeForgedAgent,
  testForgedAgent,
  loadForgeRegistry,
} from './hydra-agent-forge.ts';
import { scanResumableState } from './hydra-resume-scanner.ts';
import { checkForUpdates } from './hydra-updater.ts';
import {
  showPersonaSummary,
  applyPreset,
  listPresets,
  invalidatePersonaCache,
} from './hydra-persona.ts';
import { getProviderUsage, saveProviderUsage, resetSessionUsage } from './hydra-provider-usage.ts';
import pc from 'picocolors';
import { dispatchPrompt } from './hydra-operator-dispatch.ts';
import { runCouncilPrompt, runAutoPrompt, runSmartPrompt } from './hydra-operator-concierge.ts';
import {
  handleModelCommand,
  handleModelSelectCommand,
  handleRolesCommand,
  handleModeCommand,
  handleAgentsCommand,
  handleCleanupCommand,
  handlePrCommand,
  handleTasksCommand,
  handleNightlyCommand,
  handleEvolveCommand,
} from './hydra-operator-commands.ts';
import {
  ensureDaemon,
  launchAgentTerminals,
  extractHandoffAgents,
  printWelcome,
} from './hydra-operator-startup.ts';
import {
  selfIndexCache as _selfIndexCache,
  parseSelfAwarenessPlaintextCommand,
  applySelfAwarenessPatch,
  getGitInfo,
} from './hydra-operator-self-awareness.ts';
import { createGhostTextHelpers } from './hydra-operator-ghost-text.ts';
import { executeDaemonResume } from './hydra-operator-session.ts';
import { exit } from './hydra-process.ts';

export { KNOWN_COMMANDS, SMART_TIER_MAP, getSelfAwarenessSummary } from './hydra-operator-ui.ts';
export {
  ensureDaemon,
  findPowerShell,
  findWindowsTerminal,
  launchAgentTerminals,
  extractHandoffAgents,
  printWelcome,
} from './hydra-operator-startup.ts';
export {
  normalizeSimpleCommandText,
  parseSelfAwarenessPlaintextCommand,
  applySelfAwarenessPatch,
  getGitInfo,
} from './hydra-operator-self-awareness.ts';

const config = resolveProject();
const DEFAULT_URL = process.env['AI_ORCH_URL'] ?? 'http://127.0.0.1:4173';

// ── Dry-Run Mode ─────────────────────────────────────────────────────────────

let dryRunMode = false;

export function formatUptime(ms: number): string {
  if (ms < 60_000) return `${String(Math.round(ms / 1000))}s`;
  if (ms < 3600_000) return `${String(Math.round(ms / 60_000))}m`;
  return `${(ms / 3600_000).toFixed(1)}h`;
}

export function levenshtein(a: string, b: string): number {
  const m = a.length,
    n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array(n + 1);
    row[0] = i;
    return row;
  });
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

export function fuzzyMatchCommand(input: string): string | null {
  const normalized = input.toLowerCase().split(/\s/)[0];
  const target = normalized.startsWith(':') ? normalized : `:${normalized}`;
  let best = null;
  let bestDist = 3; // threshold
  for (const cmd of KNOWN_COMMANDS) {
    const dist = levenshtein(target, cmd);
    if (dist < bestDist) {
      bestDist = dist;
      best = cmd;
    }
  }
  return best;
}

// ── Interfaces ──────────────────────────────────────────────────────────────

interface LoopState {
  mode: string;
  conciergeActive: boolean;
  dispatchDepth: number;
  sidecaring: boolean;
  conciergeWelcomeShown: boolean;
}

interface LoopCtx {
  baseUrl: string;
  from: string;
  agents: string[];
  councilRounds: number;
  councilPreview: boolean;
  autoMiniRounds: number;
  autoCouncilRounds: number;
  autoPreview: boolean;
  rl: readline.Interface;
  cCfg: ReturnType<typeof getConciergeConfig>;
  normalPrompt: string;
  buildConciergePrompt: () => string;
  showConciergeWelcome: () => void;
  showGhostAfterPrompt: (det: string, ai: string) => void;
  upgradeGhostText: (s: string) => void;
  selfIndexCache: typeof _selfIndexCache;
}

interface PasteState {
  buffer: string[];
  timer: ReturnType<typeof setTimeout> | null;
  isPasted: boolean;
}

type CommandHandler = (ctx: LoopCtx, state: LoopState, line: string) => Promise<void> | void;

const PASTE_DEBOUNCE_MS = 120;

// ── buildCmdOpts ─────────────────────────────────────────────────────────────

function buildCmdOpts(ctx: LoopCtx, state: LoopState) {
  return {
    baseUrl: ctx.baseUrl,
    agents: ctx.agents,
    config,
    rl: ctx.rl,
    HYDRA_ROOT,
    getLoopMode: () => state.mode,
    setLoopMode: (m: string) => {
      state.mode = m;
    },
    initStatusBar,
    destroyStatusBar,
    drawStatusBar,
  };
}

// ── :status ──────────────────────────────────────────────────────────────────

function scheduleStatusGhostUpgrade(ctx: LoopCtx, state: LoopState, blockedTasks: any[]): void {
  if (!state.conciergeActive || !isConciergeAvailable()) return;
  const contextDesc = blockedTasks
    .map(
      (t: any) =>
        `Task ${String(t.id)} "${String((t.title ?? 'untitled').slice(0, 60))}" is blocked, waiting on: ${String((t.pendingDependencies ?? []).join(', ') ?? 'unknown')}`,
    )
    .join('. ');
  conciergeSuggest(
    `The user just ran :status and sees ${String(blockedTasks.length)} blocked task(s). ${String(contextDesc)}. Suggest a single actionable prompt they could type to investigate or resolve the blockage.`,
  )
    .then((result) => {
      if (result?.suggestion) ctx.upgradeGhostText(result.suggestion);
    })
    .catch(() => {
      /* silent */
    });
}

async function handleStatusCommand(ctx: LoopCtx, state: LoopState, _line: string): Promise<void> {
  const summary = await printStatus(ctx.baseUrl, ctx.agents);
  const openTasks = Array.isArray(summary.openTasks) ? summary.openTasks : [];
  const blockedTasks = openTasks.filter(
    (t: any) =>
      t.status === 'blocked' || (t.pendingDependencies && t.pendingDependencies.length > 0),
  );
  if (blockedTasks.length > 0 && !isChoiceActive()) {
    const first = blockedTasks[0];
    const deps = (first.pendingDependencies ?? first.blockedBy ?? []).join(', ');
    const deterministicHint =
      blockedTasks.length === 1
        ? `Investigate why ${String(first.id)} is blocked${deps ? ` (waiting on ${String(deps)})` : ''}`
        : `Investigate ${String(blockedTasks.length)} blocked tasks: ${String(blockedTasks.map((t: any) => t.id).join(', '))}`;
    ctx.rl.prompt(true);
    ctx.showGhostAfterPrompt(deterministicHint, deterministicHint);
    scheduleStatusGhostUpgrade(ctx, state, blockedTasks);
  } else {
    ctx.rl.prompt();
  }
}

// ── :sitrep ──────────────────────────────────────────────────────────────────

function displaySitrepResult(result: any): void {
  if (result.fallback) {
    let reason: string;
    if (result.reason === 'no_provider') {
      reason = 'no AI provider available';
    } else if (result.reason === 'empty_response') {
      reason = 'AI returned empty response';
    } else if (result.error) {
      reason = `AI call failed: ${String(result.error)}`;
    } else {
      reason = 'AI unavailable';
    }
    console.log(`\n  ${DIM(`(${reason} — showing raw digest)`)}\n`);
    console.log(result.narrative);
  } else {
    const modelLbl = result.model ? shortModelName(result.model) : (result.provider ?? 'ai');
    console.log(`\n  ${ACCENT('SITREP')} ${DIM(`via ${String(modelLbl)}`)}`);
    console.log(`  ${String(result.narrative).split('\n').join('\n  ')}`);
    if (result.usage) {
      const usage = result.usage as any;
      const inTok = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
      const outTok = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
      if (inTok + outTok > 0) console.log(`  ${DIM(`[${String(inTok + outTok)} tokens]`)}`);
    }
  }
  console.log('');
}

async function handleSitrepCommand(ctx: LoopCtx, _state: LoopState, _line: string): Promise<void> {
  let budgetStatus = null;
  try {
    budgetStatus = checkUsage();
  } catch {
    /* skip */
  }
  const gitInfo = getGitInfo();
  let statsData = null;
  try {
    statsData = (await request('GET', ctx.baseUrl, '/stats')) as any;
  } catch {
    /* skip */
  }
  let gitLog = null;
  try {
    const logResult = spawnSync('git', ['log', '--oneline', '-n', '10', '--no-decorate'], {
      cwd: config.projectRoot,
      encoding: 'utf8',
      timeout: 5000,
    });
    if (logResult.status === 0 && logResult.stdout.trim()) gitLog = logResult.stdout.trim();
  } catch {
    /* skip */
  }
  const providers = detectAvailableProviders();
  const spinner =
    providers.length > 0
      ? createSpinner(DIM('Generating situation report...'), { style: 'stellar' })
      : null;
  if (spinner) spinner.start();
  try {
    const result = await generateSitrep({
      baseUrl: ctx.baseUrl,
      workers: workers as any,
      budgetStatus,
      gitBranch: gitInfo?.branch,
      gitLog: gitLog ?? undefined,
      statsData,
    });
    if (spinner) spinner.stop();
    displaySitrepResult(result);
  } catch (err: unknown) {
    if (spinner) spinner.stop();
    console.log(`  ${ERROR('Sitrep error:')} ${(err as Error).message}`);
  }
  ctx.rl.prompt();
}

// ── :self ────────────────────────────────────────────────────────────────────

async function handleSelfCommand(ctx: LoopCtx, _state: LoopState, line: string): Promise<void> {
  const arg = line.slice(':self'.length).trim().toLowerCase();
  let self = null;
  try {
    const resp = (await request('GET', ctx.baseUrl, '/self')) as any;
    self = resp?.self ?? null;
  } catch {
    /* ignored - self stays null */
  }
  self ??= buildSelfSnapshot({ projectRoot: config.projectRoot, projectName: config.projectName });
  if (arg === 'json') {
    console.log(JSON.stringify(self, null, 2));
    console.log('');
    ctx.rl.prompt();
    return;
  }
  console.log('');
  const block = formatSelfSnapshotForPrompt(self, { maxLines: 120 });
  console.log(
    block
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n'),
  );
  const counts = self?.runtime?.counts;
  if (counts) {
    console.log('');
    console.log(`  ${ACCENT('Runtime counts')}`);
    for (const [k, v] of Object.entries(counts)) {
      console.log(`    ${pc.bold(k.padEnd(18))} ${pc.white(String(v))}`);
    }
  }
  console.log('');
  ctx.rl.prompt();
}

// ── :aware ───────────────────────────────────────────────────────────────────

async function handleAwareCommand(ctx: LoopCtx, _state: LoopState, line: string): Promise<void> {
  const arg = line.slice(':aware'.length).trim().toLowerCase();
  const cfg = loadHydraConfig();
  if (!arg || arg === 'status' || arg === 'show') {
    printSelfAwarenessStatus(cfg.selfAwareness);
    console.log('');
    ctx.rl.prompt();
    return;
  }
  if (arg === 'off') {
    await applySelfAwarenessPatch({ enabled: false });
  } else if (arg === 'on') {
    await applySelfAwarenessPatch({ enabled: true });
  } else if (arg === 'minimal') {
    await applySelfAwarenessPatch({ enabled: true, includeSnapshot: true, includeIndex: false });
  } else if (arg === 'full') {
    await applySelfAwarenessPatch({ enabled: true, includeSnapshot: true, includeIndex: true });
  } else {
    console.log(`  ${ERROR('Usage:')} :aware status | on | off | minimal | full`);
    ctx.rl.prompt();
    return;
  }
  const next = loadHydraConfig();
  printSelfAwarenessStatus(next.selfAwareness);
  console.log('');
  ctx.rl.prompt();
}

// ── :usage ───────────────────────────────────────────────────────────────────

function printSessionTokenSection(): void {
  try {
    const session = getSessionUsage();
    if (session.callCount === 0) return;
    const lines = [];
    lines.push(sectionHeader('Session Token Usage'));
    lines.push(label('Input tokens', pc.white(formatTokens(session.inputTokens))));
    lines.push(label('Output tokens', pc.white(formatTokens(session.outputTokens))));
    lines.push(label('Total tokens', pc.white(formatTokens(session.totalTokens))));
    if (session.cacheCreationTokens > 0 || session.cacheReadTokens > 0) {
      lines.push(label('Cache create', pc.white(formatTokens(session.cacheCreationTokens))));
      lines.push(label('Cache read', pc.white(formatTokens(session.cacheReadTokens))));
    }
    lines.push(label('Cost', pc.white(`$${session.costUsd.toFixed(4)}`)));
    lines.push(label('Calls', pc.white(String(session.callCount))));
    try {
      const summary = getMetricsSummary();
      const agentsWithTokens = Object.entries(summary.agents).filter(
        ([, a]: any) => a.sessionTokens?.callCount > 0,
      );
      if (agentsWithTokens.length > 1) {
        lines.push('');
        lines.push(DIM('  Per-agent:'));
        for (const [name, a] of agentsWithTokens) {
          const t = (a as any).sessionTokens;
          lines.push(
            `    ${pc.bold(name.padEnd(8))} ${formatTokens(t.totalTokens)} tokens  ${t.costUsd > 0 ? `$${String(t.costUsd.toFixed(4))}` : ''}  (${String(t.callCount)} calls)`,
          );
        }
      }
    } catch {
      /* skip per-agent */
    }
    lines.push('');
    console.log(lines.join('\n'));
  } catch {
    /* skip */
  }
}

function printProviderUsageSection(): void {
  try {
    const provUsage = getProviderUsage();
    const hasData = Object.values(provUsage).some((p) => p.session.calls > 0 || p.today.calls > 0);
    if (!hasData) return;
    const pLines = [];
    pLines.push(sectionHeader('Provider Usage'));
    for (const [name, p] of Object.entries(provUsage)) {
      if (p.session.calls === 0 && p.today.calls === 0) continue;
      const sTotal = p.session.inputTokens + p.session.outputTokens;
      const tTotal = p.today.inputTokens + p.today.outputTokens;
      pLines.push(
        `  ${pc.bold(name.padEnd(10))} session: ${formatTokens(sTotal)} ($${p.session.cost.toFixed(4)}, ${String(p.session.calls)} calls)  today: ${formatTokens(tTotal)} ($${p.today.cost.toFixed(4)})`,
      );
      if (p.external) {
        const eTotal = (p.external.inputTokens || 0) + (p.external.outputTokens || 0);
        pLines.push(
          `  ${' '.repeat(10)} account: ${formatTokens(eTotal)} ($${(p.external.cost || 0).toFixed(2)} today)`,
        );
      }
    }
    pLines.push('');
    console.log(pLines.join('\n'));
  } catch {
    /* skip */
  }
  try {
    saveProviderUsage();
  } catch {
    /* skip */
  }
}

async function printApiQuotaSection(): Promise<void> {
  try {
    console.log(sectionHeader('API Quota Status (live check)'));
    const verifications = await Promise.all(
      ['codex', 'claude', 'gemini'].map(async (a) => [a, await verifyAgentQuota(a)]),
    );
    const qLines = [];
    for (const [a, v] of verifications as any) {
      let icon: string;
      if (v.verified === false) {
        icon = pc.green('✓ active');
      } else if (v.verified === true) {
        icon = pc.red('✗ QUOTA EXHAUSTED');
      } else {
        icon = pc.yellow('? unverified');
      }
      const detail = v.reason ? pc.dim(` — ${String(v.reason)}`) : '';
      qLines.push(`  ${pc.bold(a.padEnd(8))} ${icon}${detail}`);
    }
    qLines.push('');
    console.log(qLines.join('\n'));
  } catch {
    /* skip */
  }
}

async function handleUsageCommand(ctx: LoopCtx, _state: LoopState, _line: string): Promise<void> {
  const usage = checkUsage();
  console.log(renderUsageDashboard(usage));
  printSessionTokenSection();
  printProviderUsageSection();
  await printApiQuotaSection();
  ctx.rl.prompt();
}

// ── :stats ───────────────────────────────────────────────────────────────────

async function handleStatsCommand(ctx: LoopCtx, _state: LoopState, _line: string): Promise<void> {
  try {
    const statsData = (await request('GET', ctx.baseUrl, '/stats')) as any;
    console.log(renderStatsDashboard(statsData.metrics, statsData.usage));
  } catch {
    const usage = checkUsage();
    console.log(renderStatsDashboard(null, usage as Parameters<typeof renderStatsDashboard>[1]));
  }
  ctx.rl.prompt();
}

// ── :resume ──────────────────────────────────────────────────────────────────

async function handleResumeSelection(
  ctx: LoopCtx,
  selectedValue: string,
  items: any[],
): Promise<void> {
  console.log(sectionHeader('Resuming'));
  if (
    selectedValue === 'daemon:unpause' ||
    selectedValue === 'daemon:stale' ||
    selectedValue === 'daemon:handoffs' ||
    selectedValue === 'daemon:resume'
  ) {
    await executeDaemonResume(ctx.baseUrl, ctx.agents, ctx.rl);
  } else if (selectedValue === 'evolve') {
    console.log(`  ${ACCENT('→')} Evolve session can be resumed`);
    console.log(`  ${DIM('Type')} ${ACCENT(':evolve resume')} ${DIM('to continue the session')}`);
  } else if (selectedValue.startsWith('council:')) {
    const hash = selectedValue.slice('council:'.length);
    console.log(`  ${ACCENT('Council checkpoint found:')} ${String(hash)}`);
    console.log(`  ${DIM('Re-run the prompt in council mode to continue deliberation')}`);
  } else if (selectedValue.startsWith('branches:')) {
    const prefix = selectedValue.slice('branches:'.length);
    let reviewCmd: string;
    if (prefix === 'evolve') {
      reviewCmd = ':evolve review';
    } else if (prefix === 'nightly') {
      reviewCmd = ':nightly review';
    } else {
      reviewCmd = ':tasks review';
    }
    console.log(`  ${ACCENT('→')} Unmerged ${String(prefix)}/* branches found`);
    console.log(`  ${DIM('Type')} ${ACCENT(reviewCmd)} ${DIM('to review and merge')}`);
  } else if (selectedValue === 'suggestions') {
    const pendingCount =
      items.find((i) => i.value === 'suggestions')?.label ?? 'pending suggestions';
    console.log(`  ${ACCENT('→')} ${String(pendingCount)}`);
    console.log(
      `  ${DIM('Type')} ${ACCENT(':evolve')} ${DIM('to pick a suggestion, or')} ${ACCENT(':evolve suggestions')} ${DIM('to manage them')}`,
    );
  }
  console.log('');
}

async function handleResumeCommand(ctx: LoopCtx, _state: LoopState, _line: string): Promise<void> {
  try {
    const items = await scanResumableState({
      baseUrl: ctx.baseUrl,
      projectRoot: config.projectRoot,
    });
    console.log('');
    if (items.length === 0) {
      console.log(`  ${DIM('Nothing to resume — dispatch a new objective to get started')}`);
      console.log('');
      ctx.rl.prompt();
      return;
    }
    let selectedValue;
    if (items.length === 1) {
      selectedValue = items[0].value;
      console.log(`  ${ACCENT('→')} ${items[0].label}`);
      console.log(`    ${DIM(items[0].hint)}`);
    } else {
      const choice = (await promptChoice(ctx.rl, {
        message: 'What would you like to resume?',
        choices: items.map((it) => ({ label: it.label, value: it.value, description: it.hint })),
        timeout: 60_000,
      })) as any;
      if (!choice.value) {
        ctx.rl.prompt();
        return;
      }
      selectedValue = choice.value;
    }
    await handleResumeSelection(ctx, selectedValue, items);
  } catch (err: unknown) {
    console.log(`  ${ERROR((err as Error).message)}`);
  }
  ctx.rl.prompt();
}

// ── :pause / :unpause ────────────────────────────────────────────────────────

async function handlePauseCommand(ctx: LoopCtx, _state: LoopState, line: string): Promise<void> {
  const reason = line.slice(':pause'.length).trim();
  try {
    (await request('POST', ctx.baseUrl, '/session/pause', { reason })) as any;
    console.log(`  ${SUCCESS('\u2713')} Session paused${reason ? `: "${reason}"` : ''}`);
  } catch (err: unknown) {
    console.log(`  ${ERROR((err as Error).message)}`);
  }
  ctx.rl.prompt();
}

async function handleUnpauseCommand(ctx: LoopCtx, _state: LoopState, _line: string): Promise<void> {
  try {
    (await request('POST', ctx.baseUrl, '/session/resume', {})) as any;
    console.log(`  ${SUCCESS('\u2713')} Session resumed`);
  } catch (err: unknown) {
    console.log(`  ${ERROR((err as Error).message)}`);
  }
  ctx.rl.prompt();
}

// ── :model / :roles / :mode / :agents / :cleanup / :pr / :tasks / :nightly / :evolve ────

async function handleModelDispatch(ctx: LoopCtx, state: LoopState, line: string): Promise<void> {
  await handleModelCommand(buildCmdOpts(ctx, state), line.slice(':model'.length).trim());
}

async function handleModelSelectDispatch(
  ctx: LoopCtx,
  state: LoopState,
  line: string,
): Promise<void> {
  await handleModelSelectCommand(
    buildCmdOpts(ctx, state),
    line.slice(':model:select'.length).trim(),
  );
}

async function handleRolesDispatch(ctx: LoopCtx, state: LoopState, _line: string): Promise<void> {
  await handleRolesCommand(buildCmdOpts(ctx, state));
}

async function handleModeDispatchCmd(ctx: LoopCtx, state: LoopState, line: string): Promise<void> {
  await handleModeCommand(buildCmdOpts(ctx, state), line.slice(':mode'.length).trim());
}

async function handleAgentsDispatch(ctx: LoopCtx, state: LoopState, line: string): Promise<void> {
  await handleAgentsCommand(buildCmdOpts(ctx, state), line.slice(':agents'.length).trim());
}

async function handleCleanupDispatch(ctx: LoopCtx, state: LoopState, _line: string): Promise<void> {
  await handleCleanupCommand(buildCmdOpts(ctx, state));
}

async function handlePrDispatch(ctx: LoopCtx, state: LoopState, line: string): Promise<void> {
  await handlePrCommand(buildCmdOpts(ctx, state), line.slice(':pr'.length).trim());
}

async function handleTasksDispatch(ctx: LoopCtx, state: LoopState, line: string): Promise<void> {
  await handleTasksCommand(buildCmdOpts(ctx, state), line.slice(':tasks'.length).trim());
}

async function handleNightlyDispatch(ctx: LoopCtx, state: LoopState, line: string): Promise<void> {
  await handleNightlyCommand(buildCmdOpts(ctx, state), line.slice(':nightly'.length).trim());
}

async function handleEvolveDispatch(ctx: LoopCtx, state: LoopState, line: string): Promise<void> {
  await handleEvolveCommand(buildCmdOpts(ctx, state), line.slice(':evolve'.length).trim());
}

// ── :roster ──────────────────────────────────────────────────────────────────

async function handleRosterCommand(ctx: LoopCtx, _state: LoopState, _line: string): Promise<void> {
  try {
    const { runRosterEditor } = await import('./hydra-roster.ts');
    await runRosterEditor(ctx.rl);
  } catch (err: unknown) {
    console.log(`  ${ERROR('Roster editor error:')} ${(err as Error).message}`);
  }
  ctx.rl.prompt();
}

// ── :persona ─────────────────────────────────────────────────────────────────

async function handlePersonaCommand(ctx: LoopCtx, _state: LoopState, line: string): Promise<void> {
  if (line === ':persona') {
    try {
      const { runPersonaEditor } = await import('./hydra-persona.ts');
      await runPersonaEditor(ctx.rl);
    } catch (err: unknown) {
      console.log(`  ${ERROR('Persona editor error:')} ${(err as Error).message}`);
    }
    ctx.rl.prompt();
    return;
  }
  const arg = line.slice(':persona '.length).trim().toLowerCase();
  if (arg === 'show') {
    showPersonaSummary();
  } else if (arg === 'off') {
    const cfg = loadHydraConfig();
    cfg.persona = { ...cfg.persona, enabled: false };
    const { saveHydraConfig: save } = await import('./hydra-config.ts');
    save(cfg);
    invalidatePersonaCache();
    console.log(`  Persona ${pc.red('disabled')}`);
  } else if (arg === 'on') {
    const cfg = loadHydraConfig();
    cfg.persona = { ...cfg.persona, enabled: true };
    const { saveHydraConfig: save } = await import('./hydra-config.ts');
    save(cfg);
    invalidatePersonaCache();
    console.log(`  Persona ${pc.green('enabled')}`);
  } else {
    const presets = listPresets();
    if (presets.includes(arg)) {
      applyPreset(arg);
      console.log(`  ${SUCCESS('\u2713')} Applied persona preset: ${pc.white(arg)}`);
      showPersonaSummary();
    } else {
      console.log(`  ${WARNING('Unknown preset:')} ${arg}`);
      console.log(`  Available: ${presets.join(', ')}`);
    }
  }
  ctx.rl.prompt();
}

// ── :fork / :spawn ────────────────────────────────────────────────────────────

async function handleForkCommand(ctx: LoopCtx, _state: LoopState, line: string): Promise<void> {
  const reason = line.slice(':fork'.length).trim();
  try {
    const result = (await request('POST', ctx.baseUrl, '/session/fork', { reason })) as any;
    console.log(`  ${SUCCESS('\u2713')} Session forked: ${pc.white(result.session.id)}`);
    if (reason) console.log(`  ${DIM('Reason:')} ${reason}`);
  } catch (err: unknown) {
    console.log(`  ${ERROR((err as Error).message)}`);
  }
  ctx.rl.prompt();
}

async function handleSpawnCommand(ctx: LoopCtx, _state: LoopState, line: string): Promise<void> {
  const focus = line.slice(':spawn '.length).trim();
  if (!focus) {
    console.log(`  ${ERROR('Usage: :spawn <focus description>')}`);
    ctx.rl.prompt();
    return;
  }
  try {
    const result = (await request('POST', ctx.baseUrl, '/session/spawn', { focus })) as any;
    console.log(`  ${SUCCESS('\u2713')} Child session spawned: ${pc.white(result.session.id)}`);
    console.log(`  ${DIM('Focus:')} ${focus}`);
  } catch (err: unknown) {
    console.log(`  ${ERROR((err as Error).message)}`);
  }
  ctx.rl.prompt();
}

// ── :confirm / :dry-run ───────────────────────────────────────────────────────

function handleConfirmCommand(ctx: LoopCtx, _state: LoopState, line: string): void {
  const arg = line.slice(':confirm'.length).trim().toLowerCase();
  if (arg === 'off') {
    setAutoAccept(true);
    console.log(
      `  ${SUCCESS('\u2713')} Confirmations ${DIM('disabled')} (auto-accepting all prompts)`,
    );
  } else if (arg === 'on') {
    setAutoAccept(false);
    console.log(`  ${SUCCESS('\u2713')} Confirmations ${ACCENT('enabled')}`);
  } else {
    const confirmState = isAutoAccepting() ? DIM('off (auto-accepting)') : ACCENT('on');
    console.log(label('Confirmations', confirmState));
    console.log(DIM(`  Toggle: :confirm on | :confirm off`));
  }
  ctx.rl.prompt();
}

function handleDryRunCommand(ctx: LoopCtx, _state: LoopState, line: string): void {
  const arg = line.slice(':dry-run'.length).trim().toLowerCase();
  if (arg === 'on') {
    dryRunMode = true;
    console.log(
      `  ${SUCCESS('\u2713')} Dry-run mode ${ACCENT('enabled')} — dispatches will preview only, no tasks created`,
    );
  } else if (arg === 'off') {
    dryRunMode = false;
    console.log(
      `  ${SUCCESS('\u2713')} Dry-run mode ${DIM('disabled')} — dispatches will execute normally`,
    );
  } else {
    dryRunMode = !dryRunMode;
    const dryState = dryRunMode ? ACCENT('ON') : DIM('off');
    console.log(label('Dry-run mode', dryState));
    if (dryRunMode) {
      console.log(DIM(`  Dispatches will preview route/agent selection without creating tasks`));
    }
  }
  ctx.rl.prompt();
}

// ── :clear ────────────────────────────────────────────────────────────────────

async function executeDestructiveClear(ctx: LoopCtx, what: string): Promise<void> {
  const { state } = (await request('GET', ctx.baseUrl, '/state')) as any;
  let ackedCount = 0;
  let cancelledCount = 0;
  if (what === 'all' || what === 'handoffs') {
    const pending = state.handoffs.filter((h: any) => !h.acknowledgedAt);
    for (const h of pending) {
      const agent = String(h.to ?? 'human').toLowerCase();
      (await request('POST', ctx.baseUrl, '/handoff/ack', { handoffId: h.id, agent })) as any;
      ackedCount++;
    }
  }
  if (what === 'all' || what === 'tasks') {
    const open = state.tasks.filter((t: any) => t.status === 'todo' || t.status === 'in_progress');
    for (const t of open) {
      (await request('POST', ctx.baseUrl, '/task/update', {
        taskId: t.id,
        status: 'cancelled',
      })) as any;
      cancelledCount++;
    }
  }
  const parts = [];
  if (ackedCount > 0) parts.push(`${String(ackedCount)} handoff${ackedCount > 1 ? 's' : ''} acked`);
  if (cancelledCount > 0)
    parts.push(`${String(cancelledCount)} task${cancelledCount > 1 ? 's' : ''} cancelled`);
  console.log(
    parts.length > 0
      ? `  ${SUCCESS('\u2713')} ${parts.join(', ')}`
      : `  ${DIM('Nothing to clear')}`,
  );
}

async function doClearDestructive(ctx: LoopCtx, what: string): Promise<void> {
  const clearConfirm = (await promptChoice(ctx.rl, {
    title: 'Confirm Clear',
    context: {
      Scope: what === 'all' ? 'all tasks & handoffs' : what,
      Warning: 'This cannot be undone',
    },
    choices: [
      { label: 'Yes, proceed', value: 'yes', hint: `clear ${what}` },
      { label: 'No, cancel', value: 'no', hint: 'abort' },
    ],
    defaultValue: 'yes',
  })) as any;
  if (clearConfirm.value === 'no') {
    console.log(`  ${DIM('Cancelled.')}`);
    ctx.rl.prompt();
    return;
  }
  try {
    await executeDestructiveClear(ctx, what);
  } catch (err: unknown) {
    console.log(`  ${ERROR((err as Error).message)}`);
  }
  ctx.rl.prompt();
}

async function handleClearCommand(ctx: LoopCtx, _state: LoopState, line: string): Promise<void> {
  let what = line.slice(':clear'.length).trim().toLowerCase();
  if (!what) {
    const pick = (await promptChoice(ctx.rl, {
      title: 'Clear Target',
      context: { Warning: 'Select what to clear' },
      choices: [
        { label: 'Tasks & Handoffs', value: 'all', hint: 'cancel tasks + ack handoffs' },
        { label: 'Tasks only', value: 'tasks', hint: 'cancel all open tasks' },
        { label: 'Handoffs only', value: 'handoffs', hint: 'ack all pending handoffs' },
        { label: 'Concierge history', value: 'concierge', hint: 'clear conversation' },
        { label: 'Session metrics', value: 'metrics', hint: 'reset counters' },
        { label: 'Screen', value: 'screen', hint: 'clear terminal' },
      ],
    })) as any;
    if (!pick.value) {
      ctx.rl.prompt();
      return;
    }
    what = pick.value;
  }
  if (what === 'screen') {
    process.stdout.write('\x1b[2J\x1b[H');
    ctx.rl.prompt();
    return;
  }
  if (what === 'concierge') {
    resetConversation();
    console.log(`  ${SUCCESS('\u2713')} Concierge conversation cleared`);
    ctx.rl.prompt();
    return;
  }
  if (what === 'metrics') {
    resetMetrics();
    resetSessionUsage();
    console.log(`  ${SUCCESS('\u2713')} Session metrics reset`);
    ctx.rl.prompt();
    return;
  }
  if (what === 'all' || what === 'tasks' || what === 'handoffs') {
    await doClearDestructive(ctx, what);
    return;
  }
  console.log(`  ${ERROR('Unknown target:')} ${what}`);
  console.log(`  ${DIM('Usage: :clear [all|tasks|handoffs|concierge|metrics|screen]')}`);
  ctx.rl.prompt();
}

// ── :cancel ───────────────────────────────────────────────────────────────────

async function handleCancelCommand(ctx: LoopCtx, _state: LoopState, line: string): Promise<void> {
  const id = line.slice(':cancel '.length).trim().toUpperCase();
  try {
    const result = (await request('POST', ctx.baseUrl, '/task/update', {
      taskId: id,
      status: 'cancelled',
    })) as any;
    console.log(
      `  ${SUCCESS('\u2713')} ${pc.white(result.task.id)} cancelled ${DIM(result.task.title)}`,
    );
  } catch (err: unknown) {
    console.log(`  ${ERROR((err as Error).message)}`);
  }
  ctx.rl.prompt();
}

// ── :handoffs ─────────────────────────────────────────────────────────────────

async function handleHandoffsCommand(
  ctx: LoopCtx,
  _state: LoopState,
  _line: string,
): Promise<void> {
  try {
    const { state } = (await request('GET', ctx.baseUrl, '/state')) as any;
    const pending = state.handoffs.filter((h: any) => !h.acknowledgedAt);
    const recent = state.handoffs.filter((h: any) => h.acknowledgedAt).slice(-5);
    if (pending.length === 0 && recent.length === 0) {
      console.log(`  ${DIM('No handoffs')}`);
    } else {
      if (pending.length > 0) {
        console.log('');
        console.log(sectionHeader(`Pending handoffs (${String(pending.length)})`));
        for (const h of pending) {
          console.log(
            `  ${WARNING('\u25CF')} ${pc.white(h.id)} ${colorAgent(h.from)}\u2192${colorAgent(h.to)} ${DIM(short(h.summary, 50))}`,
          );
        }
      }
      if (recent.length > 0) {
        console.log('');
        console.log(sectionHeader('Recent handoffs'));
        for (const h of recent) {
          console.log(
            `  ${SUCCESS('\u2713')} ${pc.white(h.id)} ${colorAgent(h.from)}\u2192${colorAgent(h.to)} ${DIM(short(h.summary, 50))}`,
          );
        }
      }
      console.log('');
    }
  } catch (err: unknown) {
    console.log(`  ${ERROR((err as Error).message)}`);
  }
  ctx.rl.prompt();
}

// ── :archive / :events / :sync ────────────────────────────────────────────────

async function handleArchiveCommand(ctx: LoopCtx, _state: LoopState, _line: string): Promise<void> {
  try {
    const result = (await request('POST', ctx.baseUrl, '/state/archive')) as any;
    console.log(
      `  ${SUCCESS('\u2713')} Archived: ${String(result.moved.tasks)} tasks, ${String(result.moved.handoffs)} handoffs, ${String(result.moved.blockers)} blockers${result.eventsTrimmed ? `, ${String(result.eventsTrimmed)} events trimmed` : ''}`,
    );
  } catch (err: unknown) {
    console.log(`  ${ERROR((err as Error).message)}`);
  }
  ctx.rl.prompt();
}

async function handleEventsCommand(ctx: LoopCtx, _state: LoopState, _line: string): Promise<void> {
  try {
    const result = (await request('GET', ctx.baseUrl, '/events')) as any;
    const events = result.events ?? [];
    if (events.length === 0) {
      console.log(`  ${DIM('No events')}`);
    } else {
      console.log('');
      console.log(sectionHeader(`Recent events (${String(events.length)})`));
      for (const e of events.slice(-15)) {
        const time = e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : '';
        const agent = e.agent ? ` ${colorAgent(e.agent)}` : '';
        console.log(
          `  ${DIM(time)}${agent} ${String(e.event ?? e.type ?? 'unknown')} ${DIM(e.detail ?? e.taskId ?? '')}`,
        );
      }
      console.log('');
    }
  } catch (err: unknown) {
    console.log(`  ${ERROR((err as Error).message)}`);
  }
  ctx.rl.prompt();
}

function handleSyncCommand(ctx: LoopCtx, _state: LoopState, _line: string): void {
  try {
    const syncResult = syncHydraMd(config.projectRoot);
    if (syncResult.skipped) {
      console.log(`  ${DIM('No HYDRA.md found in project root.')}`);
    } else if (syncResult.synced.length > 0) {
      console.log(`  ${SUCCESS('\u2713')} Synced HYDRA.md \u2192 ${syncResult.synced.join(', ')}`);
    } else {
      console.log(`  ${DIM('All agent files up to date.')}`);
    }
  } catch (err: unknown) {
    console.log(`  ${ERROR((err as Error).message)}`);
  }
  ctx.rl.prompt();
}

// ── :shutdown ─────────────────────────────────────────────────────────────────

async function handleShutdownCommand(
  ctx: LoopCtx,
  _state: LoopState,
  _line: string,
): Promise<void> {
  const shutdownConfirm = (await promptChoice(ctx.rl, {
    title: 'Confirm Shutdown',
    context: { Warning: 'This will stop the daemon and all agent activity' },
    choices: [
      { label: 'Yes, proceed', value: 'yes', hint: 'stop the daemon' },
      { label: 'No, cancel', value: 'no', hint: 'abort' },
    ],
    defaultValue: 'yes',
  })) as any;
  if (shutdownConfirm.value === 'no') {
    console.log(`  ${DIM('Cancelled.')}`);
    ctx.rl.prompt();
    return;
  }
  stopAllWorkers();
  try {
    (await request('POST', ctx.baseUrl, '/shutdown')) as any;
    console.log(`  ${SUCCESS('\u2713')} Daemon shutting down`);
  } catch (err: unknown) {
    console.log(`  ${ERROR((err as Error).message)}`);
  }
  ctx.rl.close();
}

// ── :forge ────────────────────────────────────────────────────────────────────

function handleForgeList(_ctx: LoopCtx): void {
  const forged = listForgedAgents();
  console.log('');
  console.log(sectionHeader('Forged Agents'));
  if (forged.length === 0) {
    console.log(`  ${DIM('No forged agents yet. Use :forge to create one.')}`);
  } else {
    for (const f of forged) {
      const status = f.enabled ? SUCCESS('on') : ERROR('off');
      console.log(
        `  ${ACCENT(f.name)} ${DIM(f.displayName)}  ${DIM('\u2192')} ${f.baseAgent}  [${status}]`,
      );
      console.log(
        `    ${DIM('Top:')} ${f.topAffinities.join(', ')}  ${DIM(`v${String(f.version)}`)}  ${DIM(f.forgedAt.slice(0, 10) || '')}`,
      );
      if (f.description) console.log(`    ${DIM(f.description.slice(0, 80))}`);
    }
  }
  console.log('');
}

function handleForgeInfo(_ctx: LoopCtx, targetName: string | undefined): void {
  if (!targetName) {
    console.log(`  ${ERROR('Usage:')} :forge info <name>`);
    return;
  }
  const registry = loadForgeRegistry();
  const meta = registry[targetName];
  const agentDef = getAgent(targetName);
  console.log('');
  console.log(sectionHeader(`Forge: ${agentDef?.displayName ?? targetName}`));
  if (agentDef) {
    console.log(`  ${pc.bold('Name:')}      ${agentDef.name}`);
    console.log(`  ${pc.bold('Base:')}      ${String(agentDef.baseAgent)}`);
    console.log(`  ${pc.bold('Enabled:')}   ${agentDef.enabled ? SUCCESS('yes') : ERROR('no')}`);
    console.log(`  ${pc.bold('Strengths:')} ${agentDef.strengths!.join(', ')}`);
    console.log(`  ${pc.bold('Tags:')}      ${agentDef.tags!.join(', ')}`);
  }
  console.log(`  ${pc.bold('Forged:')}    ${meta.forgedAt}`);
  console.log(`  ${pc.bold('Version:')}   ${String(meta.version)}`);
  console.log(`  ${pc.bold('Phases:')}    ${meta.phasesRun.join(' \u2192 ') || 'unknown'}`);
  if (meta.description) console.log(`  ${pc.bold('Goal:')}      ${meta.description}`);
  if (meta.testResult) {
    console.log(
      `  ${pc.bold('Test:')}      ${meta.testResult.ok ? SUCCESS('passed') : ERROR('failed')} (${(meta.testResult.durationMs / 1000).toFixed(1)}s)`,
    );
  }
  console.log('');
}

async function handleForgeTest(_ctx: LoopCtx, targetName: string | undefined): Promise<void> {
  if (!targetName) {
    console.log(`  ${ERROR('Usage:')} :forge test <name>`);
    console.log('');
    return;
  }
  const agentDef = getAgent(targetName);
  if (!agentDef) {
    console.log(`  ${ERROR('Unknown agent:')} ${targetName}`);
    console.log('');
    return;
  }
  console.log(
    `  ${ACCENT('\u25B6')} Testing ${targetName} ${DIM(`(${String(agentDef.baseAgent)}...)`)}`,
  );
  try {
    const result = await testForgedAgent(agentDef as any);
    console.log(
      `  ${result.ok ? SUCCESS('\u2713') : ERROR('\u2718')} Test ${result.ok ? 'passed' : 'failed'} ${DIM(`(${(result.durationMs / 1000).toFixed(1)}s)`)}`,
    );
    if (result.output) {
      const preview = result.output.split('\n').slice(0, 8);
      for (const l of preview) console.log(`    ${DIM(l.slice(0, 120))}`);
      if (result.output.split('\n').length > 8) console.log(`    ${DIM('...')}`);
    }
  } catch (err: unknown) {
    console.log(`  ${ERROR('Test error:')} ${(err as Error).message}`);
  }
  console.log('');
}

function handleForgeDelete(_ctx: LoopCtx, targetName: string | undefined): void {
  if (!targetName) {
    console.log(`  ${ERROR('Usage:')} :forge delete <name>`);
    console.log('');
    return;
  }
  const agentDef = getAgent(targetName);
  if (!agentDef) {
    console.log(`  ${ERROR('Unknown agent:')} ${targetName}`);
  } else if (agentDef.type === AGENT_TYPE.PHYSICAL) {
    console.log(`  ${ERROR('Cannot delete physical agents.')}`);
  } else {
    removeForgedAgent(targetName);
    console.log(`  ${SUCCESS('\u2713')} Agent ${ACCENT(targetName)} removed.`);
  }
  console.log('');
}

async function handleForgeEdit(ctx: LoopCtx, targetName: string | undefined): Promise<void> {
  if (!targetName) {
    console.log(`  ${ERROR('Usage:')} :forge edit <name>`);
    return;
  }
  const agentDef = getAgent(targetName);
  const registry = loadForgeRegistry();
  const meta = registry[targetName];
  if (!agentDef) {
    console.log(`  ${ERROR('Unknown agent:')} ${targetName}`);
    return;
  }
  console.log(`  ${ACCENT('\u25B6')} Re-forging ${targetName}...`);
  try {
    const desc = meta.description || agentDef.displayName;
    await runForgeWizard(ctx.rl, desc);
  } catch (err: unknown) {
    console.log(`  ${ERROR('Forge error:')} ${(err as Error).message}`);
  }
}

async function handleForgeSubCmd(
  ctx: LoopCtx,
  subCmd: string,
  forgeParts: string[],
  forgeArgs: string,
): Promise<void> {
  if (subCmd === 'list') {
    handleForgeList(ctx);
    return;
  }
  if (subCmd === 'info') {
    handleForgeInfo(ctx, forgeParts[1]);
    return;
  }
  if (subCmd === 'test') {
    await handleForgeTest(ctx, forgeParts[1]);
    return;
  }
  if (subCmd === 'delete') {
    handleForgeDelete(ctx, forgeParts[1]);
    return;
  }
  if (subCmd === 'edit') {
    await handleForgeEdit(ctx, forgeParts[1]);
    return;
  }
  try {
    await runForgeWizard(ctx.rl, forgeArgs);
  } catch (err: unknown) {
    console.log(`  ${ERROR('Forge error:')} ${(err as Error).message}`);
  }
}

async function handleForgeCommand(ctx: LoopCtx, _state: LoopState, line: string): Promise<void> {
  const forgeArgs = line.slice(':forge'.length).trim();
  const forgeParts = forgeArgs.split(/\s+/);
  const forgeSubCmd = forgeParts[0] || '';
  if (forgeSubCmd) {
    await handleForgeSubCmd(ctx, forgeSubCmd, forgeParts, forgeArgs);
  } else {
    try {
      await runForgeWizard(ctx.rl);
    } catch (err: unknown) {
      console.log(`  ${ERROR('Forge error:')} ${(err as Error).message}`);
    }
  }
  ctx.rl.prompt();
}

// ── Unknown : command ─────────────────────────────────────────────────────────

async function handleUnknownColonCommand(
  ctx: LoopCtx,
  state: LoopState,
  line: string,
): Promise<void> {
  const fuzzyMatch = fuzzyMatchCommand(line);
  if (fuzzyMatch) {
    console.log(`  ${DIM('Did you mean')} ${ACCENT(fuzzyMatch)}${DIM('?')}`);
    ctx.rl.prompt();
    return;
  }
  if (state.conciergeActive) {
    const modelLbl = getConciergeModelLabel();
    try {
      const hint = `The user typed "${line}" which is not a recognized command. Suggest the correct command.`;
      const cmdResult = await conciergeTurn(hint, {
        context: {
          projectName: config.projectName,
          projectRoot: config.projectRoot,
          mode: state.mode,
        },
      });
      const cmdResponse = (cmdResult as any).response ?? (cmdResult as any).fullResponse ?? '';
      if (cmdResponse) {
        process.stdout.write(`\n  ${pc.blue('\u2B22')} ${DIM(modelLbl)}\n  `);
        process.stdout.write(pc.blue(cmdResponse));
        process.stdout.write('\n\n');
      }
    } catch {
      console.log(`  ${ERROR('Unknown command:')} ${line}`);
      console.log(`  ${DIM('Type :help for available commands')}`);
    }
  } else {
    console.log(`  ${ERROR('Unknown command:')} ${line}`);
    console.log(`  ${DIM('Type :help for available commands')}`);
  }
  ctx.rl.prompt();
}

// ── COMMAND_TABLE ─────────────────────────────────────────────────────────────

const COMMAND_TABLE: { test: (l: string) => boolean; handler: CommandHandler }[] = [
  { test: (l) => l === ':status', handler: handleStatusCommand },
  { test: (l) => l === ':sitrep', handler: handleSitrepCommand },
  { test: (l) => l === ':self' || l.startsWith(':self '), handler: handleSelfCommand },
  { test: (l) => l === ':aware' || l.startsWith(':aware '), handler: handleAwareCommand },
  { test: (l) => l === ':usage', handler: handleUsageCommand },
  { test: (l) => l === ':stats', handler: handleStatsCommand },
  { test: (l) => l === ':resume', handler: handleResumeCommand },
  { test: (l) => l === ':pause' || l.startsWith(':pause '), handler: handlePauseCommand },
  { test: (l) => l === ':unpause', handler: handleUnpauseCommand },
  {
    test: (l) => l === ':model:select' || l.startsWith(':model:select '),
    handler: handleModelSelectDispatch,
  },
  { test: (l) => l === ':model' || l.startsWith(':model '), handler: handleModelDispatch },
  { test: (l) => l === ':roles', handler: handleRolesDispatch },
  { test: (l) => l === ':roster', handler: handleRosterCommand },
  { test: (l) => l === ':persona' || l.startsWith(':persona '), handler: handlePersonaCommand },
  { test: (l) => l === ':fork' || l.startsWith(':fork '), handler: handleForkCommand },
  { test: (l) => l.startsWith(':spawn '), handler: handleSpawnCommand },
  { test: (l) => l === ':mode' || l.startsWith(':mode '), handler: handleModeDispatchCmd },
  { test: (l) => l === ':confirm' || l.startsWith(':confirm '), handler: handleConfirmCommand },
  { test: (l) => l === ':dry-run' || l.startsWith(':dry-run '), handler: handleDryRunCommand },
  { test: (l) => l === ':clear' || l.startsWith(':clear '), handler: handleClearCommand },
  { test: (l) => l.startsWith(':cancel '), handler: handleCancelCommand },
  { test: (l) => l === ':tasks' || l.startsWith(':tasks '), handler: handleTasksDispatch },
  { test: (l) => l === ':handoffs', handler: handleHandoffsCommand },
  { test: (l) => l === ':archive', handler: handleArchiveCommand },
  { test: (l) => l === ':events', handler: handleEventsCommand },
  { test: (l) => l === ':sync', handler: handleSyncCommand },
  { test: (l) => l === ':shutdown', handler: handleShutdownCommand },
  { test: (l) => l === ':forge' || l.startsWith(':forge '), handler: handleForgeCommand },
  { test: (l) => l === ':agents' || l.startsWith(':agents '), handler: handleAgentsDispatch },
  { test: (l) => l === ':cleanup', handler: handleCleanupDispatch },
  { test: (l) => l === ':pr' || l.startsWith(':pr '), handler: handlePrDispatch },
  { test: (l) => l === ':nightly' || l.startsWith(':nightly '), handler: handleNightlyDispatch },
  { test: (l) => l === ':evolve' || l.startsWith(':evolve '), handler: handleEvolveDispatch },
];

// ── Sidecar ───────────────────────────────────────────────────────────────────

async function handleSidecarLine(ctx: LoopCtx, state: LoopState, line: string): Promise<boolean> {
  if (!(state.dispatchDepth > 0 && !line.startsWith(':') && !isChoiceActive())) return false;
  if (state.sidecaring) {
    process.stdout.write(`\r\x1b[2K  ${DIM(`${pc.blue('\u2B22')} still thinking\u2026`)}\n`);
    ctx.rl.prompt(true);
    return true;
  }
  if (!isConciergeAvailable()) {
    process.stdout.write(
      `\r\x1b[2K  ${DIM(`${pc.blue('\u2B22')} no concierge available while agents run`)}\n`,
    );
    ctx.rl.prompt(true);
    return true;
  }
  const sidecarModel = getConciergeModelLabel();
  const sidecarContext: any = {
    projectName: config.projectName,
    projectRoot: config.projectRoot,
    mode: state.mode,
    sidecarNote:
      'User is asking this while a dispatch/council is running in the background. Be brief. Ignore any [DISPATCH] intent.',
  };
  try {
    const activeWorkerNames = [];
    for (const [name, w] of workers) {
      if (w.status === 'running') activeWorkerNames.push(name);
    }
    if (activeWorkerNames.length > 0) sidecarContext.activeWorkers = activeWorkerNames;
  } catch {
    /* non-critical */
  }
  try {
    sidecarContext.codebaseBaseline = getBaselineContext();
  } catch {
    /* non-critical */
  }
  state.sidecaring = true;
  try {
    const sidecarResult = await conciergeTurn(line, { context: sidecarContext });
    const sidecarText = String(sidecarResult.response ?? '');
    if (sidecarText) {
      process.stdout.write(`\r\x1b[2K  ${pc.blue('\u2B22')} ${DIM(sidecarModel)}\n  `);
      process.stdout.write(pc.blue(sidecarText));
      process.stdout.write('\n');
    }
  } catch (sidecarErr) {
    process.stdout.write(
      `\r\x1b[2K  ${DIM(`${pc.blue('\u2B22')} concierge error: ${String((sidecarErr as any).message.slice(0, 60))}`)}\n`,
    );
  } finally {
    state.sidecaring = false;
    ctx.rl.prompt(true);
  }
  return true;
}

// ── Concierge context enrichment ──────────────────────────────────────────────

async function enrichConciergeCtxCore(ctx: LoopCtx, state: LoopState, ctxObj: any): Promise<void> {
  try {
    ctxObj.knownProjects = getRecentProjects();
  } catch {
    /* skip */
  }
  try {
    const models = getModelSummary();
    const agentModels: any = {};
    for (const [agent, info] of Object.entries(models)) {
      if (agent === '_mode') continue;
      agentModels[agent] = (info as any).active ?? 'unknown';
    }
    ctxObj.agentModels = agentModels;
  } catch {
    /* skip */
  }
  try {
    const sessionStatus = (await request('GET', ctx.baseUrl, '/session/status')) as any;
    ctxObj.openTasks =
      Number((sessionStatus.inProgressTasks ?? []).length) +
      Number((sessionStatus.pendingHandoffs ?? []).length);
  } catch {
    ctxObj.openTasks = 0;
  }
  void state;
}

async function enrichConciergeCtxAwareness(ctx: LoopCtx, ctxObj: any): Promise<void> {
  try {
    ctxObj.gitInfo = getGitInfo();
  } catch {
    /* skip */
  }
  try {
    const events = await request('GET', ctx.baseUrl, '/events/replay?category=task&from=0');
    if (Array.isArray(events)) {
      ctxObj.recentCompletions = events
        .filter((e: any) => e.payload?.status === 'done' || e.payload?.event === 'task_result')
        .slice(-3)
        .map((e: any) => ({
          agent: e.payload?.agent ?? e.payload?.owner ?? 'unknown',
          title: e.payload?.title ?? e.payload?.taskId ?? '',
          taskId: e.payload?.taskId ?? '',
        }));
      ctxObj.recentErrors = events
        .filter((e: any) => e.payload?.passed === false || e.payload?.status === 'error')
        .slice(-3)
        .map((e: any) => ({
          agent: e.payload?.agent ?? 'system',
          error: e.payload?.snippet ?? e.payload?.error ?? 'verification failed',
        }));
    }
  } catch {
    /* skip */
  }
  try {
    const activeWorkerNames = [];
    for (const [name, w] of workers) {
      if (w.status === 'running') activeWorkerNames.push(name);
    }
    if (activeWorkerNames.length > 0) ctxObj.activeWorkers = activeWorkerNames;
  } catch {
    /* skip */
  }
  try {
    ctxObj.codebaseBaseline = getBaselineContext();
  } catch {
    /* skip */
  }
}

function enrichConciergeCtxSelfAwareness(ctx: LoopCtx, ctxObj: any): void {
  try {
    const sa = loadHydraConfig().selfAwareness ?? {};
    if (sa.enabled === false || sa.injectIntoConcierge === false) {
      ctxObj.selfAwarenessKey = 'off';
      return;
    }
    const includeSnapshot = sa.includeSnapshot !== false;
    const includeIndex = sa.includeIndex !== false;
    const maxLines = Number.isFinite(sa.snapshotMaxLines) ? sa.snapshotMaxLines : 80;
    const maxChars = Number.isFinite(sa.indexMaxChars) ? sa.indexMaxChars : 7000;
    const refreshMs = Number.isFinite(sa.indexRefreshMs) ? sa.indexRefreshMs : 300_000;
    ctxObj.selfAwarenessKey = `on:${String(includeSnapshot ? 1 : 0)}:${String(includeIndex ? 1 : 0)}:${String(maxChars)}`;
    if (includeSnapshot) {
      const snap = buildSelfSnapshot({
        projectRoot: config.projectRoot,
        projectName: config.projectName,
      });
      ctxObj.selfSnapshotBlock = formatSelfSnapshotForPrompt(snap, { maxLines });
    }
    if (includeIndex) {
      const now = Date.now();
      const key = `maxChars=${String(maxChars)}`;
      if (
        !ctx.selfIndexCache.block ||
        ctx.selfIndexCache.key !== key ||
        now - ctx.selfIndexCache.builtAt > refreshMs!
      ) {
        const idx = buildSelfIndex(HYDRA_ROOT);
        Object.assign(ctx.selfIndexCache, {
          builtAt: now,
          key,
          block: formatSelfIndexForPrompt(idx, { maxChars }),
        });
      }
      ctxObj.selfIndexBlock = ctx.selfIndexCache.block;
    }
  } catch {
    /* skip */
  }
}

async function enrichConciergeCtxActivity(ctx: LoopCtx, ctxObj: any, line: string): Promise<void> {
  try {
    const { isSituational, focus } = detectSituationalQuery(line);
    if (isSituational) {
      const digest = await buildActivityDigest({
        baseUrl: ctx.baseUrl,
        workers: workers as any,
        focus: focus ?? undefined,
      });
      ctxObj.activityDigest = formatDigestForPrompt(digest, { focus: focus ?? undefined });
    }
  } catch {
    /* fall back to sparse context */
  }
  try {
    const { isCodebaseQuery, topic } = detectCodebaseQuery(line);
    if (isCodebaseQuery && topic) {
      ctxObj.codebaseContext = getTopicContext(topic);
      const kbFindings = searchKnowledgeBase(topic);
      if (kbFindings)
        ctxObj.codebaseContext = `${ctxObj.codebaseContext as string}\n\n${kbFindings}`;
    }
  } catch {
    /* skip */
  }
}

async function buildConciergeCtx(ctx: LoopCtx, state: LoopState, line: string): Promise<any> {
  const ctxObj: any = {
    projectName: config.projectName,
    projectRoot: config.projectRoot,
    mode: state.mode,
  };
  await enrichConciergeCtxCore(ctx, state, ctxObj);
  await enrichConciergeCtxAwareness(ctx, ctxObj);
  enrichConciergeCtxSelfAwareness(ctx, ctxObj);
  await enrichConciergeCtxActivity(ctx, ctxObj, line);
  return ctxObj;
}

// ── Concierge intercept ────────────────────────────────────────────────────────

async function runConciergeIntercept(
  ctx: LoopCtx,
  state: LoopState,
  line: string,
  context: any,
): Promise<{ handled: boolean; dispatchLine: string }> {
  const modelLbl = getConciergeModelLabel();
  const spinner = createSpinner(`${pc.blue('\u2B22')} ${DIM(modelLbl)} thinking...`, {
    style: 'stellar',
  });
  spinner.start();
  try {
    const result = await conciergeTurn(line, { context });
    spinner.stop();
    const responseText = (result as any).response ?? (result as any).fullResponse ?? '';
    if (responseText) {
      process.stdout.write(`\n  ${pc.blue('\u2B22')} ${DIM(modelLbl)}\n  `);
      process.stdout.write(pc.blue(responseText));
    }
    const costStr =
      result.estimatedCost != null && result.estimatedCost > 0
        ? ` ${DIM(`[~$${result.estimatedCost.toFixed(4)}]`)}`
        : '';
    process.stdout.write(`\n${costStr}\n`);
    ctx.rl.setPrompt(ctx.buildConciergePrompt());
    if (result.intent === 'dispatch') {
      console.log(
        `  ${ACCENT('\u2192')} Routing to dispatch: ${DIM(result.dispatchPrompt!.slice(0, 80))}${result.dispatchPrompt!.length > 80 ? '...' : ''}`,
      );
      console.log('');
      return { handled: false, dispatchLine: result.dispatchPrompt! };
    }
    ctx.rl.prompt();
    return { handled: true, dispatchLine: line };
  } catch (err: unknown) {
    spinner.stop();
    console.log(`  ${ERROR('Concierge error:')} ${(err as Error).message}`);
    if ((err as any).status === 401 || (err as any).status === 403) {
      state.conciergeActive = false;
      setActiveMode(state.mode);
      ctx.rl.setPrompt(ctx.normalPrompt);
      console.log(`  ${DIM('Concierge auto-disabled due to auth error')}`);
    }
    ctx.rl.prompt();
    return { handled: true, dispatchLine: line };
  }
}

async function tryConciergeIntercept(
  ctx: LoopCtx,
  state: LoopState,
  line: string,
): Promise<{ handled: boolean; dispatchLine: string }> {
  if (!state.conciergeActive) return { handled: false, dispatchLine: line };
  if (line.startsWith('!')) {
    const stripped = line.slice(1).trim();
    if (!stripped) {
      ctx.rl.prompt();
      return { handled: true, dispatchLine: '' };
    }
    return { handled: false, dispatchLine: stripped };
  }
  if (line.startsWith(':') || isChoiceActive()) return { handled: false, dispatchLine: line };
  const context = await buildConciergeCtx(ctx, state, line);
  return runConciergeIntercept(ctx, state, line, context);
}

// ── Auto / Smart mode dispatch ────────────────────────────────────────────────

function classifyAutoRoute(
  state: LoopState,
  dispatchLine: string,
): { classification: any; routeDesc: string } {
  const classification = classifyPrompt(dispatchLine);
  const routingMode = loadHydraConfig().routing.mode;
  let budgetState = null;
  try {
    budgetState = checkUsage();
  } catch {
    /* skip */
  }
  classification.suggestedAgent = bestAgentFor(classification.taskType, {
    mode: routingMode,
    budgetState,
  });
  let routeDesc: string;
  if (classification.routeStrategy === 'single') {
    routeDesc = `fast-path → ${classification.suggestedAgent}`;
  } else if (classification.routeStrategy === 'tandem' && classification.tandemPair) {
    routeDesc = `tandem: ${classification.tandemPair.lead} → ${classification.tandemPair.follow}`;
  } else if (classification.routeStrategy === 'council') {
    routeDesc = 'council deliberation';
  } else {
    routeDesc = `mini-round triage → delegated`;
  }
  void state;
  return { classification, routeDesc };
}

async function showPreDispatchGate(
  ctx: LoopCtx,
  classification: any,
  routeDesc: string,
  dispatchLine: string,
): Promise<{ proceed: boolean; modifiedLine: string }> {
  const preDispatch = (await promptChoice(ctx.rl, {
    title: 'Pre-dispatch Review',
    context: {
      Classification: `${String(classification.tier)} (${String(classification.confidence)} confidence)`,
      Route: routeDesc,
      Signals: classification.reason,
      Prompt: `"${short(dispatchLine, 300)}"`,
    },
    choices: [
      { label: 'Proceed', value: 'proceed', hint: `dispatch as ${String(classification.tier)}` },
      {
        label: 'Proceed (auto-accept)',
        value: '__auto_accept__',
        hint: 'skip future confirmations',
      },
      { label: 'Cancel', value: 'cancel', hint: 'abort this dispatch' },
      { label: 'Respond', value: 'respond', hint: 'type custom instructions', freeform: true },
    ],
    defaultValue: 'proceed',
  })) as any;
  if (preDispatch.value === 'cancel') {
    console.log(`  ${DIM('Dispatch cancelled.')}`);
    ctx.rl.prompt();
    return { proceed: false, modifiedLine: dispatchLine };
  }
  let modifiedLine = dispatchLine;
  if (
    preDispatch.value !== 'proceed' &&
    preDispatch.value !== 'cancel' &&
    !preDispatch.autoAcceptAll &&
    !preDispatch.timedOut
  ) {
    modifiedLine = preDispatch.value;
    console.log(`  ${DIM('Dispatching with modified prompt:')}`);
    console.log(`  ${ACCENT(short(modifiedLine, 70))}`);
  }
  return { proceed: true, modifiedLine };
}

function createAutoSpinner(
  classification: any,
  autoCouncilRounds: number,
  smartLabel: string,
  tandemLabel: string,
): any {
  const rs = classification.routeStrategy;
  const COUNCIL_AGENTS_S = [
    { agent: 'claude' },
    { agent: 'gemini' },
    { agent: 'claude' },
    { agent: 'codex' },
  ];
  let estMs: number;
  if (rs === 'single') {
    estMs = estimateFlowDuration([{ agent: classification.suggestedAgent ?? 'claude' }]);
  } else if (rs === 'tandem') {
    estMs = 5_000;
  } else {
    estMs = estimateFlowDuration(COUNCIL_AGENTS_S, autoCouncilRounds);
  }
  if (rs === 'single') {
    return createSpinner(`${smartLabel}Fast-path → ${String(classification.suggestedAgent)}`, {
      estimatedMs: estMs,
      style: 'solar',
    }).start();
  }
  if (rs === 'tandem') {
    return createSpinner(`${smartLabel}Tandem dispatch: ${tandemLabel}`, {
      estimatedMs: estMs,
      style: 'solar',
    }).start();
  }
  return createSpinner(`${smartLabel}Running council deliberation`, {
    estimatedMs: estMs,
    style: 'orbital',
  }).start();
}

async function runAutoDispatch(
  ctx: LoopCtx,
  state: LoopState,
  classification: any,
  dispatchLine: string,
  spinner: any,
  smartLabel: string,
): Promise<any> {
  const topic = extractTopic(dispatchLine);
  setDispatchContext({
    promptSummary: topic || short(dispatchLine, 30),
    topic,
    tier: classification.tier,
  });
  const onProgress = (evt: any) => {
    if (evt.action !== 'start') return;
    const narrative = phaseNarrative(evt.phase, evt.agent, topic);
    const prefix = classification.tier === 'complex' ? 'Council' : 'Mini-round';
    spinner.update(
      `${smartLabel}${prefix}: ${narrative} [${String(evt.step)}/${String(evt.totalSteps)}]`,
    );
    setAgentActivity(evt.agent, 'working', narrative, {
      phase: evt.phase,
      step: `${String(evt.step)}/${String(evt.totalSteps)}`,
    });
    drawStatusBar();
  };
  if (state.dispatchDepth === 0 && isConciergeAvailable()) {
    process.stdout.write(
      `\r\x1b[2K  ${DIM(`${pc.blue('\u2B22')} agents running \u2014 you can ask concierge anything`)}\n`,
    );
    ctx.rl.prompt(true);
  }
  state.dispatchDepth++;
  try {
    const dispatchFn = state.mode === 'smart' ? runSmartPrompt : runAutoPrompt;
    const auto = await dispatchFn({
      baseUrl: ctx.baseUrl,
      from: ctx.from,
      agents: ctx.agents,
      promptText: dispatchLine,
      miniRounds: ctx.autoMiniRounds,
      councilRounds: ctx.autoCouncilRounds,
      preview: ctx.autoPreview || dryRunMode,
      onProgress,
    });
    let succeedMsg: string;
    if (auto.mode === 'fast-path') {
      succeedMsg = `Fast-path dispatched to ${String(classification.suggestedAgent)}`;
    } else if (auto.mode === 'tandem') {
      succeedMsg = `Tandem dispatched: ${String(auto.route)}`;
    } else {
      succeedMsg = `${String(auto.mode)} complete`;
    }
    spinner.succeed(succeedMsg);
    return auto;
  } catch (err: unknown) {
    spinner.fail((err as Error).message);
    clearDispatchContext();
    throw err;
  } finally {
    state.dispatchDepth--;
  }
}

async function reportAutoPublished(ctx: LoopCtx, auto: any): Promise<void> {
  console.log(label('Tasks created', pc.white(String(auto.published.tasks.length))));
  console.log(label('Handoffs queued', pc.white(String(auto.published.handoffs.length))));
  const handoffAgents = extractHandoffAgents(auto);
  if (handoffAgents.length === 0) return;
  const postDispatch = (await promptChoice(ctx.rl, {
    title: 'Post-dispatch',
    context: {
      Tasks: `${String(auto.published.tasks.length)} created`,
      Agents: handoffAgents.join(', '),
    },
    choices: [
      { label: 'Start workers', value: 'workers', hint: 'headless background execution (default)' },
      { label: 'Launch terminals', value: 'launch', hint: 'open visible terminal windows' },
      { label: 'Skip', value: 'skip', hint: 'tasks dispatched, no execution' },
    ],
    defaultValue: 'workers',
  })) as any;
  if (postDispatch.value === 'workers') {
    startAgentWorkers(handoffAgents as string[], ctx.baseUrl, { rl: ctx.rl });
  } else if (postDispatch.value === 'launch') {
    for (const a of handoffAgents as string[]) setAgentExecMode(a, 'terminal');
    launchAgentTerminals(handoffAgents as string[], ctx.baseUrl);
  }
}

function updateTaskActivities(ctx: LoopCtx, auto: any): void {
  if (!auto.published?.tasks) return;
  for (const task of auto.published.tasks) {
    const owner = String(task?.owner ?? '').toLowerCase();
    if (owner && ctx.agents.includes(owner)) {
      const title = String(task.title ?? '').slice(0, 40);
      if (title) setAgentActivity(owner, 'idle', title, { taskTitle: title });
    }
  }
}

function updateAutoStatusBar(state: LoopState, auto: any, classification: any): void {
  if (state.mode === 'smart') return;
  let sbRoute: string;
  if (auto.mode === 'fast-path') {
    sbRoute = `single→${String(classification.suggestedAgent ?? 'agent')}`;
  } else if (auto.mode === 'tandem') {
    sbRoute = `tandem→${String(classification.tandemPair?.lead ?? '?')}+${String(classification.tandemPair?.follow ?? '?')}`;
  } else {
    sbRoute = auto.mode;
  }
  setLastDispatch({
    route: sbRoute,
    tier: classification.tier,
    agent: auto.mode === 'fast-path' ? (classification.suggestedAgent ?? '') : '',
    mode: state.mode,
  });
}

function printAutoDispatchHeader(state: LoopState, auto: any, classification: any): void {
  const dryLabel = dryRunMode ? ' (DRY RUN)' : '';
  console.log(
    sectionHeader((state.mode === 'smart' ? 'Smart Dispatch' : 'Auto Dispatch') + dryLabel),
  );
  const routeColor = auto.mode === 'fast-path' ? SUCCESS : ACCENT;
  console.log(label('Route', routeColor(auto.route === '' ? auto.recommended : auto.route)));
  if (dryRunMode) console.log(label('Mode', pc.yellow('DRY RUN — no tasks created')));
  if (auto.mode === 'tandem') {
    const pair = classification.tandemPair;
    if (pair)
      console.log(
        label('Pattern', DIM(`${String(pair.lead)} (analyze) → ${String(pair.follow)} (execute)`)),
      );
    console.log(label('Saved', DIM('skipped mini-round triage (4 agent calls)')));
  }
  console.log(label('Signals', DIM(classification.reason)));
  if ((auto as any).smartTier)
    console.log(
      label('Tier', `${ACCENT((auto as any).smartTier)} → ${DIM((auto as any).smartMode)} models`),
    );
  if (auto.triage)
    console.log(label('Rationale', DIM(auto.triage.recommendationRationale ?? 'n/a')));
}

async function reportAutoResult(
  ctx: LoopCtx,
  state: LoopState,
  auto: any,
  classification: any,
): Promise<void> {
  updateTaskActivities(ctx, auto);
  clearDispatchContext();
  updateAutoStatusBar(state, auto, classification);
  printAutoDispatchHeader(state, auto, classification);
  if ((auto as any).escalatedToCouncil) {
    if ((auto as any).councilOutput) console.log((auto as any).councilOutput);
  } else if (auto.published) {
    await reportAutoPublished(ctx, auto);
  } else {
    console.log(label('Route', DIM('preview only')));
  }
}

async function handleAutoSmartLine(
  ctx: LoopCtx,
  state: LoopState,
  dispatchLine: string,
): Promise<void> {
  const { classification, routeDesc } = classifyAutoRoute(state, dispatchLine);
  const { proceed, modifiedLine } = await showPreDispatchGate(
    ctx,
    classification,
    routeDesc,
    dispatchLine,
  );
  if (!proceed) return;
  const smartLabel =
    state.mode === 'smart'
      ? `Smart (${String(classification.tier)}→${(SMART_TIER_MAP as Record<string, string>)[classification.tier] || 'balanced'}) `
      : '';
  const tandemLabel =
    classification.routeStrategy === 'tandem' && classification.tandemPair
      ? `${String(classification.tandemPair.lead)} → ${String(classification.tandemPair.follow)}`
      : '';
  const spinner = createAutoSpinner(classification, ctx.autoCouncilRounds, smartLabel, tandemLabel);
  const auto = await runAutoDispatch(ctx, state, classification, modifiedLine, spinner, smartLabel);
  await reportAutoResult(ctx, state, auto, classification);
}

// ── Council mode dispatch ─────────────────────────────────────────────────────

async function runCouncilGateEfficientDispatch(
  ctx: LoopCtx,
  state: LoopState,
  dispatchLine: string,
  gateClassification: any,
): Promise<void> {
  if (state.dispatchDepth === 0 && isConciergeAvailable()) {
    process.stdout.write(
      `\r\x1b[2K  ${DIM(`${pc.blue('\u2B22')} agents running \u2014 you can ask concierge anything`)}\n`,
    );
    ctx.rl.prompt(true);
  }
  state.dispatchDepth++;
  let autoResult;
  try {
    autoResult = await runAutoPrompt({
      baseUrl: ctx.baseUrl,
      from: ctx.from,
      agents: ctx.agents,
      promptText: dispatchLine,
      miniRounds: ctx.autoMiniRounds,
      councilRounds: ctx.autoCouncilRounds,
      preview: false,
    });
  } finally {
    state.dispatchDepth--;
  }
  console.log(sectionHeader('Efficient Dispatch (council gate)'));
  console.log(label('Route', SUCCESS(autoResult.route)));
  console.log(label('Signals', DIM(gateClassification.reason)));
  console.log(
    label('Saved', DIM(`skipped council (${String(ctx.councilRounds * 4)} agent calls)`)),
  );
  if (autoResult.published) {
    console.log(label('Tasks created', pc.white(String(autoResult.published.tasks.length))));
    console.log(label('Handoffs queued', pc.white(String(autoResult.published.handoffs.length))));
    const handoffAgents = extractHandoffAgents(autoResult);
    if (handoffAgents.length > 0)
      startAgentWorkers(handoffAgents as string[], ctx.baseUrl, { rl: ctx.rl });
  }
  ctx.rl.prompt();
}

async function runCouncilGate(
  ctx: LoopCtx,
  state: LoopState,
  dispatchLine: string,
): Promise<{ skip: boolean }> {
  const routingCfg = (config as any).routing ?? {};
  const gateClassification = classifyPrompt(dispatchLine);
  if (
    routingCfg.councilGate === false ||
    gateClassification.routeStrategy === 'council' ||
    gateClassification.confidence < 0.5
  ) {
    return { skip: false };
  }
  let efficientRoute: string;
  if (gateClassification.routeStrategy === 'single') {
    efficientRoute = `fast-path → ${gateClassification.suggestedAgent}`;
  } else if (gateClassification.tandemPair) {
    efficientRoute = `tandem: ${gateClassification.tandemPair.lead} → ${gateClassification.tandemPair.follow}`;
  } else {
    efficientRoute = `fast-path → ${gateClassification.suggestedAgent}`;
  }
  const gateChoice = (await promptChoice(ctx.rl, {
    title: 'Council Gate',
    context: {
      Classification: `${gateClassification.tier} (${String(gateClassification.confidence)} confidence)`,
      'Efficient route': efficientRoute,
      'Council cost': `${String(ctx.councilRounds * 4)} agent calls across ${String(ctx.councilRounds)} round(s)`,
    },
    choices: [
      {
        label: 'Use efficient route',
        value: 'efficient',
        hint: `recommended — ${String(gateClassification.routeStrategy)}`,
      },
      { label: 'Proceed with council', value: 'council', hint: 'full deliberation' },
      { label: 'Cancel', value: 'cancel', hint: 'abort' },
    ],
    defaultValue: 'efficient',
  })) as any;
  if (gateChoice.value === 'cancel') {
    console.log(`  ${DIM('Dispatch cancelled.')}`);
    ctx.rl.prompt();
    return { skip: true };
  }
  if (gateChoice.value === 'efficient') {
    await runCouncilGateEfficientDispatch(ctx, state, dispatchLine, gateClassification);
    return { skip: true };
  }
  return { skip: false };
}

async function runCouncilDispatch(
  ctx: LoopCtx,
  state: LoopState,
  dispatchLine: string,
): Promise<void> {
  const councilTopic = extractTopic(dispatchLine);
  const COUNCIL_AGENTS_C = [
    { agent: 'claude' },
    { agent: 'gemini' },
    { agent: 'claude' },
    { agent: 'codex' },
  ];
  const councilSpinner = createSpinner('Running council deliberation', {
    estimatedMs: estimateFlowDuration(COUNCIL_AGENTS_C, ctx.councilRounds),
    style: 'orbital',
  }).start();
  setDispatchContext({
    promptSummary: councilTopic || short(dispatchLine, 30),
    topic: councilTopic,
    tier: 'complex',
  });
  if (state.dispatchDepth === 0 && isConciergeAvailable()) {
    process.stdout.write(
      `\r\x1b[2K  ${DIM(`${pc.blue('\u2B22')} council running \u2014 you can ask concierge anything`)}\n`,
    );
    ctx.rl.prompt(true);
  }
  state.dispatchDepth++;
  let council;
  try {
    council = await runCouncilPrompt({
      baseUrl: ctx.baseUrl,
      promptText: dispatchLine,
      rounds: ctx.councilRounds,
      preview: ctx.councilPreview,
      onProgress: (evt) => {
        if (evt['action'] !== 'start') return;
        const narrative = phaseNarrative(
          evt['phase'] as string,
          evt['agent'] as string,
          councilTopic,
        );
        councilSpinner.update(
          `Council: ${narrative} [${String(evt['step'])}/${String(evt['totalSteps'])}]`,
        );
        setAgentActivity(evt['agent'] as string, 'working', narrative, {
          phase: evt['phase'] as string,
          step: `${String(evt['step'])}/${String(evt['totalSteps'])}`,
        });
        drawStatusBar();
      },
    });
  } finally {
    state.dispatchDepth--;
  }
  clearDispatchContext();
  if (!council.ok) {
    councilSpinner.fail('Council failed');
    throw new Error(
      council.stderr ?? council.stdout ?? `Council exited with status ${String(council.status)}`,
    );
  }
  councilSpinner.succeed('Council completed');
  console.log(council.stdout.trim());
}

async function handleCouncilLine(
  ctx: LoopCtx,
  state: LoopState,
  dispatchLine: string,
): Promise<void> {
  const { skip } = await runCouncilGate(ctx, state, dispatchLine);
  if (!skip) await runCouncilDispatch(ctx, state, dispatchLine);
}

// ── Handoff mode dispatch ─────────────────────────────────────────────────────

async function handleHandoffLine(
  ctx: LoopCtx,
  _state: LoopState,
  dispatchLine: string,
): Promise<void> {
  const handoffTopic = extractTopic(dispatchLine);
  const handoffSpinner = createSpinner('Dispatching to agents', {
    estimatedMs: 5_000,
    style: 'eclipse',
  }).start();
  const records = await dispatchPrompt({
    baseUrl: ctx.baseUrl,
    from: ctx.from,
    agents: ctx.agents,
    promptText: dispatchLine,
  });
  handoffSpinner.succeed('Dispatched');
  for (const item of records) {
    const agentName = (item.agent || '').toLowerCase();
    const title = handoffTopic || short(dispatchLine, 40);
    if (agentName && title) setAgentActivity(agentName, 'idle', title, { taskTitle: title });
  }
  console.log(sectionHeader('Dispatched'));
  for (const item of records) {
    console.log(`  ${agentBadge(item.agent)}  ${DIM('handoff=')}${pc.bold(item.handoffId ?? '?')}`);
  }
  const handoffAgents = records.map((r) => r.agent.toLowerCase()).filter(Boolean);
  if (handoffAgents.length > 0) startAgentWorkers(handoffAgents, ctx.baseUrl, { rl: ctx.rl });
}

async function handleModeDispatchLine(
  ctx: LoopCtx,
  state: LoopState,
  dispatchLine: string,
): Promise<void> {
  if (state.mode === 'auto' || state.mode === 'smart') {
    await handleAutoSmartLine(ctx, state, dispatchLine);
  } else if (state.mode === 'council') {
    await handleCouncilLine(ctx, state, dispatchLine);
  } else if (state.mode === 'dispatch') {
    console.log(
      'Dispatch mode: run `npm run hydra:go -- mode=dispatch prompt="..."` for headless pipeline.',
    );
  } else {
    await handleHandoffLine(ctx, state, dispatchLine);
  }
}

// ── Paste buffer helpers ──────────────────────────────────────────────────────

function createPasteState(): PasteState {
  return { buffer: [], timer: null, isPasted: false };
}

function flushPasteBuffer(rl: readline.Interface, ps: PasteState): void {
  const fullInput = ps.buffer.join('\n').trim();
  ps.buffer = [];
  ps.timer = null;
  if (fullInput) {
    ps.isPasted = true;
    rl.emit('line', fullInput);
  } else {
    rl.prompt();
  }
}

function bufferPasteLine(rl: readline.Interface, ps: PasteState, line: string): boolean {
  if (ps.timer !== null) {
    ps.buffer.push(line);
    clearTimeout(ps.timer);
    ps.timer = setTimeout(() => {
      flushPasteBuffer(rl, ps);
    }, PASTE_DEBOUNCE_MS);
    return true;
  }
  if (!ps.isPasted && line && !line.startsWith(':') && !isChoiceActive()) {
    ps.buffer = [line];
    ps.timer = setTimeout(() => {
      flushPasteBuffer(rl, ps);
    }, PASTE_DEBOUNCE_MS);
    return true;
  }
  ps.isPasted = false;
  return false;
}

// ── dispatchLineCommand helpers ───────────────────────────────────────────────

async function handleAwarePlain(
  ctx: LoopCtx,
  _state: LoopState,
  awarePlain: string,
): Promise<void> {
  if (awarePlain === 'status') {
    const cfg = loadHydraConfig();
    printSelfAwarenessStatus(cfg.selfAwareness);
    console.log('');
    ctx.rl.prompt();
    return;
  }
  if (awarePlain === 'off') {
    await applySelfAwarenessPatch({ enabled: false });
  } else if (awarePlain === 'on') {
    await applySelfAwarenessPatch({ enabled: true });
  } else if (awarePlain === 'minimal') {
    await applySelfAwarenessPatch({ enabled: true, includeSnapshot: true, includeIndex: false });
  } else {
    await applySelfAwarenessPatch({ enabled: true, includeSnapshot: true, includeIndex: true });
  }
  const next = loadHydraConfig();
  printSelfAwarenessStatus(next.selfAwareness);
  console.log('');
  ctx.rl.prompt();
}

function handleCmdHelpSuffix(ctx: LoopCtx, line: string): void {
  const cmdPart = line.slice(0, -1).trim();
  const cmd = COMMAND_HELP[cmdPart] ? cmdPart : cmdPart.split(/\s/)[0];
  printCommandHelp(cmd);
  ctx.rl.prompt();
}

// ── dispatchLineCommand ───────────────────────────────────────────────────────

async function dispatchLineCommand(ctx: LoopCtx, state: LoopState, line: string): Promise<void> {
  if (!line) {
    ctx.rl.prompt();
    return;
  }
  if (line === ':quit' || line === ':exit') {
    ctx.rl.close();
    return;
  }

  const awarePlain = parseSelfAwarenessPlaintextCommand(line);
  if (awarePlain) {
    await handleAwarePlain(ctx, state, awarePlain);
    return;
  }

  if (line.startsWith(':') && line.endsWith('?')) {
    handleCmdHelpSuffix(ctx, line);
    return;
  }
  if (line === ':help') {
    printHelp();
    ctx.rl.prompt();
    return;
  }

  for (const entry of COMMAND_TABLE) {
    if (entry.test(line)) {
      await entry.handler(ctx, state, line);
      return;
    }
  }

  if (line.startsWith(':')) {
    await handleUnknownColonCommand(ctx, state, line);
    return;
  }

  if (await handleSidecarLine(ctx, state, line)) return;

  const intercept = await tryConciergeIntercept(ctx, state, line);
  if (intercept.handled) return;

  await handleModeDispatchLine(ctx, state, intercept.dispatchLine);
}

// ── interactiveLoop ───────────────────────────────────────────────────────────

async function showLoopWelcome(
  baseUrl: string,
  showWelcome: boolean,
  initialMode: string,
): Promise<void> {
  if (showWelcome) {
    await printWelcome(baseUrl);
  } else {
    printHelp();
    console.log(label('Mode', ACCENT(initialMode)));
    console.log('');
  }
  if (!envFileExists() && !process.env['OPENAI_API_KEY']) {
    console.log(DIM('  Tip: Copy .env.example to .env and add your API keys to get started.'));
    console.log('');
  }
  const updateResult = await Promise.race([
    checkForUpdates().catch(() => null),
    new Promise<null>((r) => {
      setTimeout(() => {
        r(null);
      }, 0);
    }),
  ]);
  if ((updateResult as any)?.hasUpdate) {
    console.log(
      `  ${pc.yellow('Update available:')} ${DIM((updateResult as any).localVersion)} \u2192 ${pc.bold(pc.yellow((updateResult as any).remoteVersion))}  ${DIM('git pull origin master')}`,
    );
    console.log('');
  }
}

function bindActivityEventHandler(rl: readline.Interface): void {
  onActivityEvent(({ event, agent, detail }) => {
    const significant = ['handoff_ack', 'task_done', 'verify'];
    if (!significant.includes(event)) return;
    const prefix = event === 'verify' ? WARNING('\u2691') : SUCCESS('\u2713');
    const msg = `  ${prefix} ${DIM(event.replace(/_/g, ' '))}${agent ? ` ${colorAgent(agent)}` : ''} ${DIM(detail)}`;
    process.stdout.write(`\r\x1b[2K${msg}\n`);
    if (!isChoiceActive()) {
      rl.prompt(true);
    }
  });
}

function attachRlCloseHandler(rl: readline.Interface, ghostTextCleanup: () => void): void {
  rl.on('close', () => {
    ghostTextCleanup();
    resetAutoAccept();
    resetConversation();
    stopAllWorkers();
    stopEventStream();
    destroyStatusBar();
    console.log('Hydra operator console closed.');
    exit(0);
  });
}

function bindRlToLoop(
  params: {
    baseUrl: string;
    from: string;
    agents: string[];
    councilRounds: number;
    councilPreview: boolean;
    autoMiniRounds: number;
    autoCouncilRounds: number;
    autoPreview: boolean;
  },
  state: LoopState,
  cCfg: ReturnType<typeof getConciergeConfig>,
  normalPrompt: string,
  buildConciergePrompt: () => string,
  showConciergeWelcome: () => void,
): void {
  const {
    baseUrl,
    from,
    agents,
    councilRounds,
    councilPreview,
    autoMiniRounds,
    autoCouncilRounds,
    autoPreview,
  } = params;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: state.conciergeActive ? buildConciergePrompt() : normalPrompt,
  });
  const {
    showGhostAfterPrompt,
    upgradeGhostText,
    cleanup: _ghostTextCleanup,
  } = createGhostTextHelpers({
    rl,
    getConciergeActive: () => state.conciergeActive,
    getConciergeModelLabel,
  });
  const ctx: LoopCtx = {
    baseUrl,
    from,
    agents,
    councilRounds,
    councilPreview,
    autoMiniRounds,
    autoCouncilRounds,
    autoPreview,
    rl,
    cCfg,
    normalPrompt,
    buildConciergePrompt,
    showConciergeWelcome,
    showGhostAfterPrompt,
    upgradeGhostText,
    selfIndexCache: _selfIndexCache,
  };
  startEventStream(baseUrl, agents);
  bindActivityEventHandler(rl);
  if (state.conciergeActive) showConciergeWelcome();
  rl.prompt();
  const pasteState = createPasteState();
  rl.on('line', async (lineRaw) => {
    if (bufferPasteLine(rl, pasteState, (lineRaw || '').trim())) return;
    const line = (lineRaw || '').trim();
    try {
      await dispatchLineCommand(ctx, state, line);
    } catch (err: unknown) {
      console.error(`Error: ${(err as Error).message}`);
    }
    drawStatusBar();
    rl.prompt();
  });
  attachRlCloseHandler(rl, _ghostTextCleanup);
}

async function interactiveLoop({
  baseUrl,
  from,
  agents,
  initialMode,
  councilRounds,
  councilPreview,
  autoMiniRounds,
  autoCouncilRounds,
  autoPreview,
  showWelcome,
}: {
  baseUrl: string;
  from: string;
  agents: string[];
  initialMode: string;
  councilRounds: number;
  councilPreview: boolean;
  autoMiniRounds: number;
  autoCouncilRounds: number;
  autoPreview: boolean;
  showWelcome: boolean;
}) {
  const state: LoopState = {
    mode: initialMode,
    conciergeActive: false,
    dispatchDepth: 0,
    sidecaring: false,
    conciergeWelcomeShown: false,
  };
  const cCfg = getConciergeConfig();
  if (cCfg.autoActivate && isConciergeAvailable()) state.conciergeActive = true;
  setConciergeBaseUrl(baseUrl);
  initStatusBar(agents);
  setActiveMode(state.conciergeActive ? 'chat' : initialMode);
  try {
    const { initOutputHistory } = await import('./hydra-output-history.ts');
    initOutputHistory();
  } catch {
    /* non-critical */
  }
  await showLoopWelcome(baseUrl, showWelcome, initialMode);
  const rlSafe = (s: string) => s.replace(/(\x1b\[[0-9;]*m)/g, '\x01$1\x02');
  const normalPrompt = rlSafe(`${ACCENT('hydra')}${DIM('>')} `);
  const buildConciergePrompt = () => {
    const modelLabel = getConciergeModelLabel();
    const showModel = cCfg.showProviderInPrompt !== false;
    const modelSuffix = showModel ? `${DIM('[')}${pc.blue(modelLabel)}${DIM(']')}` : '';
    return rlSafe(`${ACCENT('hydra')}${pc.blue('\u2B22')}${modelSuffix}${DIM('>')} `);
  };
  const showConciergeWelcome = () => {
    if (state.conciergeWelcomeShown || !cCfg.welcomeMessage) return;
    state.conciergeWelcomeShown = true;
    console.log('');
    console.log(`  ${pc.blue('\u2B22')} Concierge active ${DIM(`(${getConciergeModelLabel()})`)}`);
  };
  bindRlToLoop(
    {
      baseUrl,
      from,
      agents,
      councilRounds,
      councilPreview,
      autoMiniRounds,
      autoCouncilRounds,
      autoPreview,
    },
    state,
    cCfg,
    normalPrompt,
    buildConciergePrompt,
    showConciergeWelcome,
  );
}

// ── main helpers ─────────────────────────────────────────────────────────────

function parseMainOpts() {
  const { options, positionals } = parseArgs(process.argv);
  const baseUrl = String(options['url'] || DEFAULT_URL);
  const from = String(options['from'] || 'human').toLowerCase();
  const agents = parseList(String(options['agents'] || 'gemini,codex,claude'));
  const mode = String(options['mode'] || 'auto').toLowerCase();
  const councilRounds = Math.max(
    1,
    Math.min(4, Number.parseInt(String(options['councilRounds'] || '2'), 10) || 2),
  );
  const councilPreview = boolFlag(options['councilPreview'], false);
  const autoMiniRounds = Math.max(
    1,
    Math.min(2, Number.parseInt(String(options['autoMiniRounds'] || '1'), 10) || 1),
  );
  const autoCouncilRounds = Math.max(
    1,
    Math.min(
      4,
      Number.parseInt(String(options['autoCouncilRounds'] || String(councilRounds)), 10) ||
        councilRounds,
    ),
  );
  const autoPreview = boolFlag(options['autoPreview'], false);
  const promptText = getPrompt(options, positionals);
  const interactive = !promptText;
  const showWelcome = boolFlag(options['welcome'], interactive);
  return {
    baseUrl,
    from,
    agents,
    mode,
    councilRounds,
    councilPreview,
    autoMiniRounds,
    autoCouncilRounds,
    autoPreview,
    promptText,
    interactive,
    showWelcome,
    options,
  };
}

async function runOneShotAuto(opts: ReturnType<typeof parseMainOpts>): Promise<void> {
  const {
    baseUrl,
    from,
    agents,
    mode,
    autoMiniRounds,
    autoCouncilRounds,
    autoPreview,
    promptText,
  } = opts;
  const dispatchFn = mode === 'smart' ? runSmartPrompt : runAutoPrompt;
  const auto = await dispatchFn({
    baseUrl,
    from,
    agents,
    promptText: promptText!,
    miniRounds: autoMiniRounds,
    councilRounds: autoCouncilRounds,
    preview: autoPreview,
  });
  console.log(
    sectionHeader(mode === 'smart' ? 'Smart Dispatch Complete' : 'Auto Dispatch Complete'),
  );
  const routeColor = auto.mode === 'fast-path' ? SUCCESS : ACCENT;
  console.log(label('Route', routeColor(auto.route === '' ? auto.recommended : auto.route)));
  if (auto.mode === 'tandem')
    console.log(label('Saved', DIM('skipped mini-round triage (4 agent calls)')));
  if ((auto as any).smartTier) {
    console.log(
      label('Tier', `${ACCENT((auto as any).smartTier)} → ${DIM((auto as any).smartMode)} models`),
    );
  }
  if (auto.triage)
    console.log(label('Rationale', DIM(auto.triage.recommendationRationale ?? 'n/a')));
  if ((auto as any).escalatedToCouncil) {
    if ((auto as any).councilOutput) console.log((auto as any).councilOutput);
  } else if (auto.published) {
    console.log(label('Tasks created', pc.white(String(auto.published.tasks.length))));
    console.log(label('Handoffs queued', pc.white(String(auto.published.handoffs.length))));
    const handoffAgents = extractHandoffAgents(auto);
    if (handoffAgents.length > 0) startAgentWorkers(handoffAgents as string[], baseUrl);
  } else {
    console.log(label('Route', DIM('preview')));
  }
}

async function runOneShotCouncil(opts: ReturnType<typeof parseMainOpts>): Promise<void> {
  const { baseUrl, councilRounds, councilPreview, promptText } = opts;
  const classification = classifyPrompt(promptText!);
  if (classification.routeStrategy !== 'council' && classification.confidence >= 0.5) {
    console.log(
      DIM(
        `  Tip: this prompt classified as ${classification.tier} (${String(classification.routeStrategy)}), consider auto mode for efficiency`,
      ),
    );
  }
  const council = await runCouncilPrompt({
    baseUrl,
    promptText: promptText!,
    rounds: councilRounds,
    preview: councilPreview,
  });
  if (!council.ok) {
    throw new Error(
      council.stderr ?? council.stdout ?? `Council exited with status ${String(council.status)}`,
    );
  }
  console.log(council.stdout.trim());
}

function runOneShotDispatch(opts: ReturnType<typeof parseMainOpts>): void {
  const { promptText, baseUrl, options } = opts;
  const dispatchScript = path.join(HYDRA_ROOT, 'lib', 'hydra-dispatch.ts');
  const args = [dispatchScript, `prompt=${promptText!}`, `url=${baseUrl}`];
  if (boolFlag(options['preview'], false)) args.push('mode=preview');
  const result = spawnHydraNodeSync(args[0], args.slice(1), {
    cwd: config.projectRoot,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 8,
    windowsHide: true,
    stdio: 'inherit',
  });
  if (result.status !== 0) exit(result.status ?? 1);
}

async function runOneShotHandoff(opts: ReturnType<typeof parseMainOpts>): Promise<void> {
  const { baseUrl, from, agents, promptText } = opts;
  const records = await dispatchPrompt({ baseUrl, from, agents, promptText: promptText! });
  console.log(sectionHeader('Dispatch Complete'));
  for (const item of records) {
    console.log(`  ${agentBadge(item.agent)}  ${DIM('handoff=')}${pc.bold(item.handoffId ?? '?')}`);
  }
  const handoffAgents = records.map((r) => r.agent.toLowerCase()).filter(Boolean);
  if (handoffAgents.length > 0) startAgentWorkers(handoffAgents, baseUrl);
}

async function main() {
  const opts = parseMainOpts();
  registerBuiltInSubAgents();
  try {
    loadCodebaseContext();
  } catch {
    /* non-critical */
  }
  const daemonOk = await ensureDaemon(opts.baseUrl, { quiet: !opts.interactive });
  if (!daemonOk) {
    console.error(`Hydra daemon unreachable at ${opts.baseUrl}.`);
    console.error('Start manually: npm run hydra:start');
    exit(1);
  }
  if (opts.interactive) {
    await interactiveLoop({
      baseUrl: opts.baseUrl,
      from: opts.from,
      agents: opts.agents,
      initialMode: opts.mode,
      councilRounds: opts.councilRounds,
      councilPreview: opts.councilPreview,
      autoMiniRounds: opts.autoMiniRounds,
      autoCouncilRounds: opts.autoCouncilRounds,
      autoPreview: opts.autoPreview,
      showWelcome: opts.showWelcome,
    });
    return;
  }
  if (opts.mode === 'auto' || opts.mode === 'smart') {
    await runOneShotAuto(opts);
    return;
  }
  if (opts.mode === 'council') {
    await runOneShotCouncil(opts);
    return;
  }
  if (opts.mode === 'dispatch') {
    runOneShotDispatch(opts);
    return;
  }
  await runOneShotHandoff(opts);
}

const _isMainModule =
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (_isMainModule) {
  main().catch((err: unknown) => {
    console.error(`Hydra operator failed: ${(err as Error).message}`);

    exit(1);
  });
}
