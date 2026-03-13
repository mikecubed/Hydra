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
/* eslint-disable n/no-process-exit, @typescript-eslint/no-misused-promises, require-atomic-updates -- T7A: CLI entry point */
/* eslint-disable no-await-in-loop, unicorn/prefer-ternary, @typescript-eslint/no-base-to-string -- T7A: sequential processing */

/* eslint-disable unicorn/no-new-array, no-control-regex -- T7A: intentional patterns */

import './hydra-env.ts';
import readline from 'node:readline';
import type { Interface as ReadlineInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { exec, spawnSync } from 'node:child_process';
import { spawnHydraNode, spawnHydraNodeSync } from './hydra-exec-spawn.ts';
import {
  getAgent,
  getModelSummary,
  getMode,
  AGENT_TYPE,
  formatEffortDisplay,
  bestAgentFor,
} from './hydra-agents.ts';
import { checkUsage, renderUsageDashboard, formatTokens } from './hydra-usage.ts';
import { verifyAgentQuota } from './hydra-model-recovery.ts';
import {
  getSessionUsage,
  getMetricsSummary,
  estimateFlowDuration,
  resetMetrics,
} from './hydra-metrics.ts';
import {
  resolveProject,
  HYDRA_ROOT,
  loadHydraConfig,
  saveHydraConfig,
  getRecentProjects,
} from './hydra-config.ts';
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
  hydraSplash,
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
  AGENT_COLORS,
  stripAnsi,
  shortModelName,
} from './hydra-ui.ts';
import {
  COMMAND_HELP,
  KNOWN_COMMANDS,
  SMART_TIER_MAP,
  printCommandHelp,
  printHelp,
  printNextSteps,
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
import {
  getProviderSummary,
  getExternalSummary,
  getProviderUsage,
  loadProviderUsage,
  saveProviderUsage,
  refreshExternalUsage,
  resetSessionUsage,
} from './hydra-provider-usage.ts';
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

export { KNOWN_COMMANDS, SMART_TIER_MAP, getSelfAwarenessSummary } from './hydra-operator-ui.ts';

const config = resolveProject();
const DEFAULT_URL = process.env['AI_ORCH_URL'] ?? 'http://127.0.0.1:4173';

// ── Dry-Run Mode ─────────────────────────────────────────────────────────────

let dryRunMode = false;

export function formatUptime(ms: number): string {
  if (ms < 60_000) return `${String(Math.round(ms / 1000))}s`;
  if (ms < 3600_000) return `${String(Math.round(ms / 60_000))}m`;
  return `${(ms / 3600_000).toFixed(1)}h`;
}

// ── Daemon Auto-Start ────────────────────────────────────────────────────────

async function ensureDaemon(baseUrl: string, { quiet = false }: { quiet?: boolean } = {}) {
  // Check if daemon is already running
  try {
    (await request('GET', baseUrl, '/health')) as any;
    return true;
  } catch {
    // Not running — try to start it
  }

  if (!quiet) {
    process.stderr.write(`  ${DIM('\u2026')} Starting daemon...\n`);
  }

  const daemonScript = path.join(HYDRA_ROOT, 'lib', 'orchestrator-daemon.mjs');
  const child = spawnHydraNode(daemonScript, ['start'], {
    cwd: config.projectRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  // Wait for health (up to 8 seconds)
  for (let i = 0; i < 32; i++) {
    await new Promise((r) => {
      setTimeout(r, 250);
    });
    try {
      (await request('GET', baseUrl, '/health')) as any;
      if (!quiet) {
        process.stderr.write(`  ${SUCCESS('\u2713')} Daemon started\n`);
      }
      return true;
    } catch {
      // keep waiting
    }
  }

  return false;
}

// ── Agent Terminal Auto-Launch ───────────────────────────────────────────────

/**
 * Detect pwsh or powershell on Windows. Returns exe path or null.
 */
function findPowerShell() {
  if (process.platform !== 'win32') return null;
  for (const cmd of ['pwsh', 'powershell']) {
    try {
      const result = spawnSync('where', [cmd], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5_000,
      });
      const exe = (result.stdout || '').split('\n')[0].trim();
      if (exe) return exe;
    } catch {
      /* not found */
    }
  }
  return null;
}

/**
 * Detect Windows Terminal (wt.exe). Returns exe path or null.
 */
function findWindowsTerminal() {
  if (process.platform !== 'win32') return null;
  try {
    const result = spawnSync('where', ['wt'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
    });
    const exe = (result.stdout || '').split('\n')[0].trim();
    if (exe) return exe;
  } catch {
    /* not found */
  }
  return null;
}

/**
 * Spawn visible terminal windows running hydra-head.ps1 for each agent.
 * Uses -EncodedCommand to avoid escaping issues, and exec(start ...) for
 * reliable window visibility on Windows.
 */
function launchAgentTerminals(agentNames: string[], baseUrl: string) {
  if (process.platform !== 'win32' || agentNames.length === 0) return;
  if ((process as any).pkg) {
    console.log(
      `  ${DIM('(standalone build: terminal launch disabled; use :workers start instead)')}`,
    );
    return;
  }

  const shell = findPowerShell();
  if (!shell) {
    console.log(`  ${DIM('(skipping terminal launch — no PowerShell found)')}`);
    return;
  }

  const wt = findWindowsTerminal();
  const headScript = path.join(HYDRA_ROOT, 'bin', 'hydra-head.ps1');
  const cwd = config.projectRoot;
  const cwdEscaped = cwd.replace(/'/g, "''");

  for (const agent of agentNames) {
    if (!getAgent(agent)) continue;
    const title = `Hydra Head - ${agent.toUpperCase()}`;
    const psCommand = [
      `Set-Location -LiteralPath '${cwdEscaped}'`,
      `& '${headScript}' -Agent ${agent} -Url '${baseUrl}'`,
    ].join('; ');

    // Encode as UTF-16LE base64 for -EncodedCommand (avoids all escaping issues)
    const encoded = Buffer.from(psCommand, 'utf16le').toString('base64');

    let cmd;
    if (wt) {
      // Windows Terminal: open a new tab in the current window
      cmd = `wt -w 0 new-tab --title "${title}" "${shell}" -NoExit -EncodedCommand ${encoded}`;
    } else {
      // Fallback: start command reliably opens a visible console window
      cmd = `start "${title}" "${shell}" -NoExit -EncodedCommand ${encoded}`;
    }
    exec(cmd, { cwd });

    const icon =
      ({ gemini: '\u2726', codex: '\u25B6', claude: '\u2666' } as Record<string, string>)[agent] ||
      '\u25CF';
    console.log(`  ${SUCCESS('\u2713')} ${colorAgent(agent)} ${icon} ${agent}  terminal launched`);
  }
}

/**
 * Extract unique agent names from auto/smart dispatch result.
 */
function extractHandoffAgents(result: Record<string, unknown>) {
  const handoffs = (result as any)?.published?.handoffs;
  if (!Array.isArray(handoffs) || handoffs.length === 0) return [];
  const seen = new Set();
  for (const h of handoffs) {
    const name = String(h.to ?? '').toLowerCase();
    if (name && getAgent(name)) seen.add(name);
  }
  return [...seen];
}

// ── Welcome Screen ───────────────────────────────────────────────────────────

async function printWelcome(baseUrl: string) {
  console.log(hydraSplash());
  console.log(label('Project', pc.white(config.projectName)));
  // Sync HYDRA.md → agent instruction files on startup
  try {
    const syncResult = syncHydraMd(config.projectRoot);
    if (syncResult.synced.length > 0) {
      console.log(label('Sync', DIM(`HYDRA.md → ${syncResult.synced.join(', ')}`)));
    }
  } catch {
    /* non-critical */
  }

  console.log(label('Daemon', DIM(baseUrl)));

  // Startup alert: check for in-progress tasks and pending handoffs
  try {
    const sessionStatus = (await request('GET', baseUrl, '/session/status')) as any;
    if (sessionStatus.activeSession?.status === 'paused') {
      const reason = sessionStatus.activeSession.pauseReason;
      console.log(
        `  ${WARNING('\u23F8')} Session paused${reason ? `: "${String(reason)}"` : ''} \u2014 type ${ACCENT(':unpause')} to resume`,
      );
    }
    const inProgressCount = (sessionStatus.inProgressTasks ?? []).length;
    const handoffCount = (sessionStatus.pendingHandoffs ?? []).length;
    const staleCount = (sessionStatus.staleTasks ?? []).length;
    const parts = [];
    if (inProgressCount > 0)
      parts.push(`${String(inProgressCount)} task${inProgressCount === 1 ? '' : 's'} in progress`);
    if (handoffCount > 0)
      parts.push(`${String(handoffCount)} handoff${handoffCount === 1 ? '' : 's'} pending`);
    if (staleCount > 0) parts.push(`${String(staleCount)} stale`);
    if (parts.length > 0) {
      console.log(
        `  ${WARNING('\u26A0')} ${parts.join(', ')} \u2014 type ${ACCENT(':resume')} for details`,
      );
    }
  } catch {
    /* daemon may not have session data yet */
  }

  // Mode & Models
  try {
    const models = getModelSummary();
    const currentMode = (models['_mode'] ?? getMode()) as string;
    console.log(label('Mode', ACCENT(currentMode)));
    const parts = [];
    for (const [agent, info] of Object.entries(models)) {
      if (agent === '_mode') continue;
      const colorFn = (AGENT_COLORS as any)[agent] ?? pc.white;
      const shortModel = ((info as any).active ?? '')
        .replace(/^claude-/, '')
        .replace(/^gemini-/, '');
      const tag = (info as any).isOverride ? pc.yellow(' *') : '';
      const effLabel = formatEffortDisplay(
        (info as any).active,
        (info as Record<string, any>)['reasoningEffort'],
      );
      const eff = effLabel ? pc.yellow(` ${effLabel}`) : '';
      parts.push(`${String(colorFn(agent))}${DIM(':')}${pc.white(shortModel)}${eff}${tag}`);
    }
    console.log(label('Models', parts.join(DIM('  '))));
  } catch {
    /* skip */
  }

  // Usage — show today's actual tokens from stats-cache
  try {
    const usage = checkUsage();
    if (usage.todayTokens > 0) {
      const modelShort = (usage.model ?? '').replace(/^claude-/, '').replace(/^gemini-/, '');
      console.log(
        label(
          'Today',
          `${pc.white(formatTokens(usage.todayTokens))} tokens ${modelShort ? DIM(`(${String(modelShort)})`) : ''}`,
        ),
      );
    }
  } catch {
    /* skip */
  }

  // Session token usage (from real Claude JSON output)
  try {
    const session = getSessionUsage();
    if (session.callCount > 0) {
      console.log(
        label(
          'Session',
          `${pc.white(formatTokens(session.totalTokens))} tokens  ${pc.white(`$${session.costUsd.toFixed(4)}`)}  ${DIM(`(${String(session.callCount)} calls)`)}`,
        ),
      );
    }
  } catch {
    /* skip */
  }

  // Provider usage (load persisted + refresh external in background)
  try {
    loadProviderUsage();
    void refreshExternalUsage(); // non-blocking
    const providerLines = getProviderSummary();
    if (providerLines.length > 0) {
      console.log(label('Providers', providerLines.join(DIM(' │ '))));
    }
    const extLines = getExternalSummary();
    if (extLines.length > 0) {
      console.log(label('Account', extLines.join(DIM(' │ '))));
    }
  } catch {
    /* skip */
  }

  // Context-aware next steps on startup
  try {
    const sessionStatus = (await request('GET', baseUrl, '/session/status')) as any;
    printNextSteps({
      agentSuggestions: sessionStatus.agentSuggestions,
      pendingHandoffs: sessionStatus.pendingHandoffs,
      staleTasks: sessionStatus.staleTasks,
      inProgressTasks: sessionStatus.inProgressTasks,
    });
  } catch {
    console.log(`  ${DIM('Type a prompt to dispatch, or :help for commands')}`);
  }
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

// ── Self Awareness (Hyper-Aware Concierge Context) ────────────────────────────

let _selfIndexCache = { block: '', builtAt: 0, key: '' };

export function normalizeSimpleCommandText(input: unknown): string {
  return String(input ?? '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseSelfAwarenessPlaintextCommand(input: unknown): string | null {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  if (raw.startsWith(':') || raw.startsWith('!')) return null;
  if (raw.includes('\n')) return null;

  const s = normalizeSimpleCommandText(raw);
  if (!s || s.length > 80) return null;

  const target = '(?:hyper\\s*aware(?:ness)?|self\\s*awareness)';
  const polite = '(?:please\\s+)?(?:can\\s+you\\s+|could\\s+you\\s+|would\\s+you\\s+)?';
  const agentSuffix = '(?:\\s+agent)?';

  if (new RegExp(`^${polite}(?:turn\\s+off|disable)\\s+${target}${agentSuffix}$`).test(s))
    return 'off';
  if (new RegExp(`^${polite}${target}${agentSuffix}\\s+off$`).test(s)) return 'off';

  if (new RegExp(`^${polite}(?:turn\\s+on|enable)\\s+${target}${agentSuffix}$`).test(s))
    return 'on';
  if (new RegExp(`^${polite}${target}${agentSuffix}\\s+on$`).test(s)) return 'on';

  if (new RegExp(`^${polite}(?:set\\s+)?${target}${agentSuffix}\\s+(?:to\\s+)?minimal$`).test(s))
    return 'minimal';
  if (new RegExp(`^${polite}(?:set\\s+)?${target}${agentSuffix}\\s+(?:to\\s+)?full$`).test(s))
    return 'full';

  if (new RegExp(`^${polite}${target}${agentSuffix}\\s+status$`).test(s)) return 'status';
  return null;
}

async function applySelfAwarenessPatch(patch = {}) {
  const cfg = loadHydraConfig();
  const current =
    cfg.selfAwareness && typeof cfg.selfAwareness === 'object' ? cfg.selfAwareness : {};
  cfg.selfAwareness = { ...current, ...patch };
  const { saveHydraConfig: save } = await import('./hydra-config.ts');
  const merged = save(cfg);
  _selfIndexCache = { block: '', builtAt: 0, key: '' };
  return merged.selfAwareness ?? cfg.selfAwareness;
}

// ── Git Info Cache ────────────────────────────────────────────────────────────

let _gitInfoCache: { data: any; at: number } = { data: null, at: 0 };
const GIT_CACHE_TTL = 30_000;

function getGitInfo() {
  const now = Date.now();
  if (_gitInfoCache.data && now - _gitInfoCache.at < GIT_CACHE_TTL) {
    return _gitInfoCache.data;
  }
  try {
    const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: config.projectRoot,
      encoding: 'utf8',
      timeout: 5000,
    }).stdout.trim();
    const porcelain = spawnSync('git', ['status', '--porcelain'], {
      cwd: config.projectRoot,
      encoding: 'utf8',
      timeout: 5000,
    }).stdout.trim();
    const modifiedFiles = porcelain ? porcelain.split('\n').length : 0;
    const info = { branch, modifiedFiles };
    _gitInfoCache = { data: info, at: now };
    return info;
  } catch {
    return null;
  }
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
  let mode = initialMode;
  let conciergeActive = false;
  let dispatchDepth = 0; // >0 while a blocking dispatch/council await is in flight
  let sidecaring = false; // true while a sidecar conciergeTurn is in flight
  let conciergeWelcomeShown = false;
  const cCfg = getConciergeConfig();
  if (cCfg.autoActivate && isConciergeAvailable()) conciergeActive = true;

  // Set daemon base URL for bidirectional concierge events
  setConciergeBaseUrl(baseUrl);

  // Initialize status bar BEFORE welcome so splash renders within the scroll region
  // (scroll region must be set first to prevent content from being overwritten by the status bar)
  initStatusBar(agents);
  setActiveMode(conciergeActive ? 'chat' : mode);

  // Initialize output history ring buffer (captures CLI output for AI context)
  try {
    const { initOutputHistory } = await import('./hydra-output-history.ts');
    initOutputHistory();
  } catch {
    /* non-critical */
  }

  // Fire update check in background — resolves from 24h disk cache on most startups
  const updateCheckPromise = checkForUpdates().catch(() => null);

  if (showWelcome) {
    await printWelcome(baseUrl);
  } else {
    printHelp();
    console.log(label('Mode', ACCENT(mode)));
    console.log('');
  }

  // First-run hint: suggest copying .env.example if no .env and no OPENAI_API_KEY
  if (!envFileExists() && !process.env['OPENAI_API_KEY']) {
    console.log(DIM('  Tip: Copy .env.example to .env and add your API keys to get started.'));
    console.log('');
  }

  // Update notice (non-blocking — show if check resolved by now, otherwise skip)
  const updateResult = await Promise.race([
    updateCheckPromise,
    new Promise((r) => {
      setTimeout(() => {
        r(null);
      }, 0);
    }),
  ]);
  if ((updateResult as any)?.hasUpdate) {
    console.log(
      `  ${pc.yellow('Update available:')} ${DIM((updateResult as any).localVersion)} → ${pc.bold(pc.yellow((updateResult as any).remoteVersion))}  ${DIM('git pull origin master')}`,
    );
    console.log('');
  }

  // Wrap ANSI escapes for readline so cursor position is calculated correctly

  const rlSafe = (s: string) => s.replace(/(\x1b\[[0-9;]*m)/g, '\x01$1\x02');

  function buildConciergePrompt() {
    const modelLabel = getConciergeModelLabel();
    const showModel = cCfg.showProviderInPrompt !== false;
    const modelSuffix = showModel ? `${DIM('[')}${pc.blue(modelLabel)}${DIM(']')}` : '';
    return rlSafe(`${ACCENT('hydra')}${pc.blue('\u2B22')}${modelSuffix}${DIM('>')} `);
  }

  function showConciergeWelcome() {
    if (conciergeWelcomeShown || !cCfg.welcomeMessage) return;
    conciergeWelcomeShown = true;
    const modelLabel = getConciergeModelLabel();
    console.log('');
    console.log(`  ${pc.blue('\u2B22')} Concierge active ${DIM(`(${modelLabel})`)}`);
  }

  const normalPrompt = rlSafe(`${ACCENT('hydra')}${DIM('>')} `);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: conciergeActive ? buildConciergePrompt() : normalPrompt,
  });

  // ── Multi-line paste buffer for concierge ──────────────────────────────────
  // When concierge is active, buffer rapidly-arriving lines (typical of paste)
  // and process them as a single input after a short debounce.
  let _pasteBuffer: string[] = [];
  let _pasteTimer: ReturnType<typeof setTimeout> | null = null;
  let _isPastedInput = false;
  const PASTE_DEBOUNCE_MS = 120;

  // Show welcome on first activate
  if (conciergeActive) showConciergeWelcome();

  // ── Ghost Text (greyed-out placeholder, Claude Code CLI style) ────────────
  // Shows dim hint text after the prompt cursor. Disappears on first keystroke.
  // Re-appears on blank line submissions or after command completion.
  // When _acceptableGhostText is set, Tab accepts + submits the ghost text.
  let _ghostCleanup: ((...args: any[]) => void) | null = null;
  let _acceptableGhostText: string | null = null; // Text that Tab would accept+submit
  let _ghostUpgradeAborted = false; // Set true when user types; prevents async AI upgrade

  const GHOST_HINTS_CONCIERGE = [
    () => `Chat with ${getConciergeModelLabel()} — prefix ! to dispatch`,
    () => 'Ask a question or describe what you need',
    () => `Talking to ${getConciergeModelLabel()} — :chat off to disable`,
    () => 'What would you like to work on?',
  ];
  const GHOST_HINTS_NORMAL = [
    () => 'Describe a task to dispatch to agents',
    () => ':help for commands, or type a prompt',
    () => 'What would you like to work on?',
  ];
  let _ghostIdx = 0;

  function getGhostText() {
    const pool = conciergeActive ? GHOST_HINTS_CONCIERGE : GHOST_HINTS_NORMAL;
    const text = pool[_ghostIdx % pool.length]();
    _ghostIdx++;
    return text;
  }

  /**
   * Show ghost text after the prompt cursor.
   * @param {string} [overrideText] - Custom text instead of cycling hints
   * @param {string} [acceptableText] - If set, Tab will accept+submit this text
   */
  function showGhostAfterPrompt(overrideText?: any, acceptableText?: any) {
    if (!process.stdout.isTTY) return;
    const base = overrideText ?? getGhostText();
    if (!base) return;

    _acceptableGhostText = acceptableText ?? null;
    _ghostUpgradeAborted = false;

    // Append [Tab] hint for acceptable ghost text
    const text = _acceptableGhostText ? `${String(base)}  [Tab]` : base;
    const plain = stripAnsi(text);

    // Write dim ghost text, then move cursor back to prompt end
    process.stdout.write(DIM(text));
    if (plain.length > 0) {
      process.stdout.write(`\x1b[${String(plain.length)}D`);
    }
    // One-shot: clear ghost text on first keystroke
    if (_ghostCleanup) {
      process.stdin.removeListener('data', _ghostCleanup);
      _ghostCleanup = null;
    }
    const cleanup = () => {
      process.stdout.write('\x1b[K'); // Erase from cursor to end of line
      _acceptableGhostText = null;
      _ghostUpgradeAborted = true;
      process.stdin.removeListener('data', cleanup);
      if (_ghostCleanup === cleanup) _ghostCleanup = null;
    };
    _ghostCleanup = cleanup;
    process.stdin.on('data', cleanup);
  }

  /**
   * Upgrade displayed ghost text with an AI-generated suggestion.
   * No-op if user has already started typing.
   */
  function upgradeGhostText(newText: string) {
    if (_ghostUpgradeAborted) return;
    if (!process.stdout.isTTY) return;
    if (rl.line && rl.line.length > 0) {
      _ghostUpgradeAborted = true;
      return;
    }
    // Erase old ghost, write new acceptable ghost
    process.stdout.write('\x1b[K');
    const display = `${newText}  [Tab]`;
    const plain = stripAnsi(display);
    process.stdout.write(DIM(display));
    if (plain.length > 0) {
      process.stdout.write(`\x1b[${String(plain.length)}D`);
    }
    _acceptableGhostText = newText;
  }

  // Wrap rl.prompt to auto-show ghost text on fresh prompts (not refreshes)
  const _origPrompt = rl.prompt.bind(rl);
  rl.prompt = function (preserveCursor) {
    _origPrompt(preserveCursor);
    if (!preserveCursor) {
      showGhostAfterPrompt();
    }
  };

  // ── Tab Interception (accept + submit ghost text) ──────────────────────────
  // Override readline's internal _ttyWrite to intercept Tab when acceptable
  // ghost text is displayed. Standard pattern used by inquirer/ora.
  const _origTtyWrite = (rl as any)._ttyWrite.bind(rl);
  (rl as any)._ttyWrite = function (s: any, key: any) {
    if (key.name === 'tab' && _acceptableGhostText && !rl.line.length) {
      // Clear ghost visual
      process.stdout.write('\x1b[K');
      const text = _acceptableGhostText;
      _acceptableGhostText = null;
      _ghostUpgradeAborted = true;
      // Clean up ghost listener
      if (_ghostCleanup) {
        process.stdin.removeListener('data', _ghostCleanup);
        _ghostCleanup = null;
      }
      // Inject text into readline and submit
      rl.write(text);
      setImmediate(() => {
        rl.write(null, { name: 'return' });
      });
      return; // swallow the Tab
    }
    _origTtyWrite(s, key);
  };

  // ── Daemon resume helper (extracted for unified :resume) ───────────────────
  async function executeDaemonResume(
    resumeBaseUrl: string,
    resumeAgents: string[],
    resumeRl: ReadlineInterface,
  ) {
    try {
      const sessionStatus = (await request('GET', resumeBaseUrl, '/session/status')) as any;

      // Unpause if paused
      if (sessionStatus.activeSession?.status === 'paused') {
        try {
          (await request('POST', resumeBaseUrl, '/session/unpause')) as any;
          console.log(`  ${SUCCESS('✓')} Session unpaused`);
        } catch (err: unknown) {
          console.log(`  ${WARNING('⚠')} Could not unpause: ${(err as Error).message}`);
        }
      }

      // Reset stale tasks
      const stale = sessionStatus.staleTasks ?? [];
      if (stale.length > 0) {
        console.log('');
        for (const t of stale) {
          try {
            (await request('POST', resumeBaseUrl, '/task/update', {
              taskId: t.id,
              status: 'todo',
            })) as any;
            const mins = Math.round((Date.now() - new Date(t.updatedAt).getTime()) / 60_000);
            console.log(
              `  ${WARNING('↻')} ${pc.white(t.id)} ${colorAgent(t.owner)} reset to todo ${DIM(`(was stale ${String(mins)}m)`)}`,
            );
          } catch {
            /* skip */
          }
        }
      }

      // Ack pending handoffs
      const handoffs = sessionStatus.pendingHandoffs ?? [];
      const agentsToLaunch = new Set();
      if (handoffs.length > 0) {
        console.log('');
        for (const h of handoffs) {
          const targetAgent = String(h.to ?? '').toLowerCase();
          try {
            (await request('POST', resumeBaseUrl, '/handoff/ack', {
              handoffId: h.id,
              agent: targetAgent,
            })) as any;
            if (targetAgent) agentsToLaunch.add(targetAgent);
          } catch (err: unknown) {
            console.log(`  ${ERROR('✗')} ${pc.white(h.id)} ${(err as Error).message}`);
          }
        }
      }

      // Collect in-progress agent owners
      for (const t of sessionStatus.inProgressTasks ?? []) {
        const owner = String(t.owner ?? '').toLowerCase();
        if (owner) agentsToLaunch.add(owner);
      }

      // Agent suggestions
      for (const [agent, suggestion] of Object.entries(sessionStatus.agentSuggestions ?? {})) {
        if (
          (suggestion as any)?.action &&
          (suggestion as any).action !== 'idle' &&
          (suggestion as any).action !== 'unknown'
        ) {
          agentsToLaunch.add(agent);
        }
      }

      // Launch workers
      const launchList = ([...agentsToLaunch] as string[]).filter((a) => resumeAgents.includes(a));
      if (launchList.length > 0) {
        console.log('');
        startAgentWorkers(launchList, resumeBaseUrl, { rl: resumeRl });
      }

      // Summary
      const actions = [];
      if (stale.length > 0)
        actions.push(`${String(stale.length)} stale task${stale.length > 1 ? 's' : ''} reset`);
      if (handoffs.length > 0)
        actions.push(`${String(handoffs.length)} handoff${handoffs.length > 1 ? 's' : ''} acked`);
      if (launchList.length > 0)
        actions.push(
          `${String(launchList.length)} agent${launchList.length > 1 ? 's' : ''} launched`,
        );
      if (actions.length > 0) {
        console.log('');
        console.log(`  ${SUCCESS('✓')} ${actions.join(', ')}`);
      }
    } catch (err: unknown) {
      console.log(`  ${ERROR((err as Error).message)}`);
    }
  }

  startEventStream(baseUrl, agents);

  // Subscribe to significant activity events and show them inline
  onActivityEvent(({ event, agent, detail }) => {
    const significant = ['handoff_ack', 'task_done', 'verify'];
    if (!significant.includes(event)) return;
    const prefix = event === 'verify' ? WARNING('\u2691') : SUCCESS('\u2713');
    const msg = `  ${prefix} ${DIM(event.replace(/_/g, ' '))}${agent ? ` ${colorAgent(agent)}` : ''} ${DIM(detail)}`;
    // Clear current prompt line, print event, re-show prompt
    process.stdout.write(`\r\x1b[2K${msg}\n`);
    // Don't flash normal prompt while a choice selection is active
    if (!isChoiceActive()) {
      rl.prompt(true);
    }
  });

  rl.prompt();

  rl.on('line', async (lineRaw) => {
    const line = (lineRaw || '').trim();

    // ── Paste buffering: collect rapid-fire lines while buffer is active ────
    if (_pasteTimer !== null) {
      _pasteBuffer.push(line);
      clearTimeout(_pasteTimer);
      _pasteTimer = setTimeout(() => {
        const fullInput = _pasteBuffer.join('\n').trim();
        _pasteBuffer = [];
        _pasteTimer = null;
        if (fullInput) {
          _isPastedInput = true;
          rl.emit('line', fullInput);
        } else {
          rl.prompt();
        }
      }, PASTE_DEBOUNCE_MS);
      return;
    }

    // ── Universal paste detection: non-command input waits briefly for more lines ──
    // Commands (:foo) execute immediately; all other input is buffered so that a
    // multi-line paste is collected into one submission regardless of mode.
    if (!_isPastedInput && line && !line.startsWith(':') && !isChoiceActive()) {
      _pasteBuffer = [line];
      _pasteTimer = setTimeout(() => {
        const fullInput = _pasteBuffer.join('\n').trim();
        _pasteBuffer = [];
        _pasteTimer = null;
        if (fullInput) {
          _isPastedInput = true;
          rl.emit('line', fullInput);
        } else {
          rl.prompt();
        }
      }, PASTE_DEBOUNCE_MS);
      return;
    }
    _isPastedInput = false;

    try {
      if (!line) {
        rl.prompt();
        return;
      }
      if (line === ':quit' || line === ':exit') {
        rl.close();
        return;
      }

      // ── Plaintext hyper-awareness toggles (explicit user intent) ───────────
      const awarePlain = parseSelfAwarenessPlaintextCommand(line);
      if (awarePlain) {
        const cfg = loadHydraConfig();
        if (awarePlain === 'status') {
          printSelfAwarenessStatus(cfg.selfAwareness);
          console.log('');
          rl.prompt();
          return;
        }
        if (awarePlain === 'off') {
          await applySelfAwarenessPatch({ enabled: false });
        } else if (awarePlain === 'on') {
          await applySelfAwarenessPatch({ enabled: true });
        } else if (awarePlain === 'minimal') {
          await applySelfAwarenessPatch({
            enabled: true,
            includeSnapshot: true,
            includeIndex: false,
          });
        } else {
          await applySelfAwarenessPatch({
            enabled: true,
            includeSnapshot: true,
            includeIndex: true,
          });
        }
        const next = loadHydraConfig();
        printSelfAwarenessStatus(next.selfAwareness);
        console.log('');
        rl.prompt();
        return;
      }

      // ── Command help via `?` suffix (e.g. `:model ?`) ──────────────────
      if (line.startsWith(':') && line.endsWith('?')) {
        const cmdPart = line.slice(0, -1).trim();
        // Try exact match, then base command (e.g. `:tasks scan ?` → `:tasks`)
        const cmd = COMMAND_HELP[cmdPart] ? cmdPart : cmdPart.split(/\s/)[0];
        printCommandHelp(cmd);
        rl.prompt();
        return;
      }

      if (line === ':help') {
        printHelp();
        rl.prompt();
        return;
      }
      if (line === ':status') {
        const summary = await printStatus(baseUrl, agents);

        // Smart ghost: nudge about blocked tasks
        const openTasks = Array.isArray(summary.openTasks) ? summary.openTasks : [];
        const blockedTasks = openTasks.filter(
          (t: any) =>
            t.status === 'blocked' || (t.pendingDependencies && t.pendingDependencies.length > 0),
        );

        if (blockedTasks.length > 0 && !isChoiceActive()) {
          // Phase 1: Deterministic ghost (immediate)
          const first = blockedTasks[0];
          const deps = (first.pendingDependencies ?? first.blockedBy ?? []).join(', ');
          const deterministicHint =
            blockedTasks.length === 1
              ? `Investigate why ${String(first.id)} is blocked${deps ? ` (waiting on ${String(deps)})` : ''}`
              : `Investigate ${String(blockedTasks.length)} blocked tasks: ${String(blockedTasks.map((t: any) => t.id).join(', '))}`;

          _origPrompt();
          showGhostAfterPrompt(deterministicHint, deterministicHint);

          // Phase 2: AI upgrade (async, non-blocking)
          if (conciergeActive && isConciergeAvailable()) {
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
                if (result?.suggestion) upgradeGhostText(result.suggestion);
              })
              .catch(() => {
                /* silent */
              });
          }
        } else {
          rl.prompt();
        }
        return;
      }
      if (line === ':sitrep') {
        // Gather supplemental data (each in try/catch)
        let budgetStatus = null;
        try {
          budgetStatus = checkUsage();
        } catch {
          /* skip */
        }
        const gitInfo = getGitInfo();
        let statsData = null;
        try {
          statsData = (await request('GET', baseUrl, '/stats')) as any;
        } catch {
          /* skip */
        }
        // Recent git log for big-picture context
        let gitLog = null;
        try {
          const logResult = spawnSync('git', ['log', '--oneline', '-n', '10', '--no-decorate'], {
            cwd: config.projectRoot,
            encoding: 'utf8',
            timeout: 5000,
          });
          if (logResult.status === 0 && logResult.stdout.trim()) {
            gitLog = logResult.stdout.trim();
          }
        } catch {
          /* skip */
        }

        // Show spinner if AI is likely available
        const providers = detectAvailableProviders();
        const spinner =
          providers.length > 0
            ? createSpinner(DIM('Generating situation report...'), { style: 'stellar' })
            : null;
        if (spinner) spinner.start();

        try {
          const result = await generateSitrep({
            baseUrl,
            workers: workers as any,
            budgetStatus,
            gitBranch: gitInfo?.branch,
            gitLog: gitLog ?? undefined,
            statsData: /** @type {any} */ statsData,
          });
          if (spinner) spinner.stop();

          if (result.fallback) {
            let reason: string;
            if (result.reason === 'no_provider') {
              reason = 'no AI provider available';
            } else if (result.reason === 'empty_response') {
              reason = 'AI returned empty response';
            } else if (result.error) {
              reason = `AI call failed: ${result.error}`;
            } else {
              reason = 'AI unavailable';
            }
            console.log(`\n  ${DIM(`(${reason} — showing raw digest)`)}\n`);
            console.log(result.narrative);
          } else {
            const modelLbl = result.model
              ? shortModelName(result.model)
              : (result.provider ?? 'ai');
            console.log(`\n  ${ACCENT('SITREP')} ${DIM(`via ${modelLbl}`)}`);
            console.log(`  ${result.narrative.split('\n').join('\n  ')}`);
            // Cost estimate from usage data
            if (result.usage) {
              const usage = result.usage as any;
              const inTok = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
              const outTok = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
              if (inTok + outTok > 0) {
                console.log(`  ${DIM(`[${String(inTok + outTok)} tokens]`)}`);
              }
            }
          }
          console.log('');
        } catch (err: unknown) {
          if (spinner) spinner.stop();
          console.log(`  ${ERROR('Sitrep error:')} ${(err as Error).message}`);
        }
        rl.prompt();
        return;
      }
      if (line === ':self' || line.startsWith(':self ')) {
        const arg = line.slice(':self'.length).trim().toLowerCase();

        let self = null;
        try {
          const resp = (await request('GET', baseUrl, '/self')) as any;
          self = resp?.self ?? null;
        } catch {
          self = null;
        }

        self ??= buildSelfSnapshot({
          projectRoot: config.projectRoot,
          projectName: config.projectName,
        });

        if (arg === 'json') {
          console.log(JSON.stringify(self, null, 2));
          console.log('');
          rl.prompt();
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

        // If daemon-provided runtime exists, show a short summary
        const counts = self?.runtime?.counts;
        if (counts) {
          console.log('');
          console.log(`  ${ACCENT('Runtime counts')}`);
          for (const [k, v] of Object.entries(counts)) {
            console.log(`    ${pc.bold(k.padEnd(18))} ${pc.white(String(v))}`);
          }
        }

        console.log('');
        rl.prompt();
        return;
      }
      if (line === ':aware' || line.startsWith(':aware ')) {
        const arg = line.slice(':aware'.length).trim().toLowerCase();
        const cfg = loadHydraConfig();

        if (!arg || arg === 'status' || arg === 'show') {
          printSelfAwarenessStatus(cfg.selfAwareness);
          console.log('');
          rl.prompt();
          return;
        }

        if (arg === 'off') {
          await applySelfAwarenessPatch({ enabled: false });
        } else if (arg === 'on') {
          await applySelfAwarenessPatch({ enabled: true });
        } else if (arg === 'minimal') {
          await applySelfAwarenessPatch({
            enabled: true,
            includeSnapshot: true,
            includeIndex: false,
          });
        } else if (arg === 'full') {
          await applySelfAwarenessPatch({
            enabled: true,
            includeSnapshot: true,
            includeIndex: true,
          });
        } else {
          console.log(`  ${ERROR('Usage:')} :aware status | on | off | minimal | full`);
          rl.prompt();
          return;
        }

        const next = loadHydraConfig();
        printSelfAwarenessStatus(next.selfAwareness);
        console.log('');
        rl.prompt();
        return;
      }
      if (
        line.startsWith(':mode ') &&
        ['economy', 'balanced', 'performance'].includes(line.slice(5).trim().toLowerCase())
      ) {
        const modeArg = line.slice(5).trim().toLowerCase();
        const cfg = loadHydraConfig();
        cfg.routing = { ...cfg.routing, mode: modeArg as any };
        saveHydraConfig(cfg);
        let chip: string;
        if (modeArg === 'economy') {
          chip = pc.yellow('◆ ECO');
        } else if (modeArg === 'performance') {
          chip = pc.cyan('◆ PERF');
        } else {
          chip = pc.green('◆ BAL');
        }
        console.log(`Mode set to ${chip}`);
        if (typeof setActiveMode === 'function') setActiveMode(modeArg);
        rl.prompt();
        return;
      }
      if (line === ':usage') {
        const usage = checkUsage();
        console.log(renderUsageDashboard(usage));
        // Append real session token usage when available (per-agent breakdown)
        try {
          const session = getSessionUsage();
          if (session.callCount > 0) {
            const lines = [];
            lines.push(sectionHeader('Session Token Usage'));
            lines.push(label('Input tokens', pc.white(formatTokens(session.inputTokens))));
            lines.push(label('Output tokens', pc.white(formatTokens(session.outputTokens))));
            lines.push(label('Total tokens', pc.white(formatTokens(session.totalTokens))));
            if (session.cacheCreationTokens > 0 || session.cacheReadTokens > 0) {
              lines.push(
                label('Cache create', pc.white(formatTokens(session.cacheCreationTokens))),
              );
              lines.push(label('Cache read', pc.white(formatTokens(session.cacheReadTokens))));
            }
            lines.push(label('Cost', pc.white(`$${session.costUsd.toFixed(4)}`)));
            lines.push(label('Calls', pc.white(String(session.callCount))));

            // Per-agent breakdown when multiple agents have real token data
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
          }
        } catch {
          /* skip */
        }

        // Per-provider usage breakdown
        try {
          const provUsage = getProviderUsage();
          const hasData = Object.values(provUsage).some(
            (p) => p.session.calls > 0 || p.today.calls > 0,
          );
          if (hasData) {
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
          }
        } catch {
          /* skip */
        }

        // Save provider usage after display
        try {
          saveProviderUsage();
        } catch {
          /* skip */
        }

        // API quota check — verify actual account status for each agent
        // Works with API keys; for OAuth CLI auth (Claude Code, Gemini CLI) shows auth type
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

        rl.prompt();
        return;
      }
      if (line === ':stats') {
        try {
          const statsData = (await request('GET', baseUrl, '/stats')) as any;
          console.log(renderStatsDashboard(statsData.metrics, statsData.usage));
        } catch {
          // Fallback to just usage if daemon is down
          const usage = checkUsage();
          console.log(
            renderStatsDashboard(null, usage as Parameters<typeof renderStatsDashboard>[1]),
          );
        }
        rl.prompt();
        return;
      }
      if (line === ':resume') {
        try {
          const items = await scanResumableState({ baseUrl, projectRoot: config.projectRoot });
          console.log('');

          if (items.length === 0) {
            console.log(`  ${DIM('Nothing to resume — dispatch a new objective to get started')}`);
            console.log('');
            rl.prompt();
            return;
          }

          // Auto-execute if only one source type, or let user pick
          let selectedValue;
          if (items.length === 1) {
            selectedValue = items[0].value;
            console.log(`  ${ACCENT('→')} ${items[0].label}`);
            console.log(`    ${DIM(items[0].hint)}`);
          } else {
            const choice = (await promptChoice(rl, {
              message: 'What would you like to resume?',
              choices: items.map((it) => ({
                label: it.label,
                value: it.value,
                description: it.hint,
              })),
              timeout: 60_000,
            })) as any;
            if (!choice.value) {
              rl.prompt();
              return;
            }
            selectedValue = choice.value;
          }

          // Dispatch by selected value
          console.log(sectionHeader('Resuming'));
          if (
            selectedValue === 'daemon:unpause' ||
            selectedValue === 'daemon:stale' ||
            selectedValue === 'daemon:handoffs' ||
            selectedValue === 'daemon:resume'
          ) {
            await executeDaemonResume(baseUrl, agents, rl);
          } else if (selectedValue === 'evolve') {
            console.log(`  ${ACCENT('→')} Evolve session can be resumed`);
            console.log(
              `  ${DIM('Type')} ${ACCENT(':evolve resume')} ${DIM('to continue the session')}`,
            );
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
            console.log(`  ${ACCENT('→')} ${pendingCount}`);
            console.log(
              `  ${DIM('Type')} ${ACCENT(':evolve')} ${DIM('to pick a suggestion, or')} ${ACCENT(':evolve suggestions')} ${DIM('to manage them')}`,
            );
          }

          console.log('');
        } catch (err: unknown) {
          console.log(`  ${ERROR((err as Error).message)}`);
        }
        rl.prompt();
        return;
      }
      if (line === ':pause' || line.startsWith(':pause ')) {
        const reason = line.slice(':pause'.length).trim();
        try {
          (await request('POST', baseUrl, '/session/pause', { reason })) as any;
          console.log(`  ${SUCCESS('\u2713')} Session paused${reason ? `: "${reason}"` : ''}`);
        } catch (err: unknown) {
          console.log(`  ${ERROR((err as Error).message)}`);
        }
        rl.prompt();
        return;
      }
      if (line === ':unpause') {
        try {
          (await request('POST', baseUrl, '/session/resume', {})) as any;
          console.log(`  ${SUCCESS('\u2713')} Session resumed`);
        } catch (err: unknown) {
          console.log(`  ${ERROR((err as Error).message)}`);
        }
        rl.prompt();
        return;
      }
      if (line === ':model' || line.startsWith(':model ')) {
        await handleModelCommand(
          {
            baseUrl,
            agents,
            config,
            rl,
            HYDRA_ROOT,
            getLoopMode: () => mode,
            setLoopMode: (m) => {
              mode = m;
            },
            initStatusBar,
            destroyStatusBar,
            drawStatusBar,
          },
          line.slice(':model'.length).trim(),
        );
        return;
      }
      if (line === ':model:select' || line.startsWith(':model:select ')) {
        await handleModelSelectCommand(
          {
            baseUrl,
            agents,
            config,
            rl,
            HYDRA_ROOT,
            getLoopMode: () => mode,
            setLoopMode: (m) => {
              mode = m;
            },
            initStatusBar,
            destroyStatusBar,
            drawStatusBar,
          },
          line.slice(':model:select'.length).trim(),
        );
        return;
      }
      if (line === ':roles') {
        await handleRolesCommand({
          baseUrl,
          agents,
          config,
          rl,
          HYDRA_ROOT,
          getLoopMode: () => mode,
          setLoopMode: (m) => {
            mode = m;
          },
          initStatusBar,
          destroyStatusBar,
          drawStatusBar,
        });
        return;
      }
      if (line === ':roster') {
        try {
          const { runRosterEditor } = await import('./hydra-roster.ts');
          await runRosterEditor(rl);
        } catch (err: unknown) {
          console.log(`  ${ERROR('Roster editor error:')} ${(err as Error).message}`);
        }
        rl.prompt();
        return;
      }
      // ── :persona command ──────────────────────────────────────────────────
      if (line === ':persona') {
        try {
          const { runPersonaEditor } = await import('./hydra-persona.ts');
          await runPersonaEditor(rl);
        } catch (err: unknown) {
          console.log(`  ${ERROR('Persona editor error:')} ${(err as Error).message}`);
        }
        rl.prompt();
        return;
      }
      if (line.startsWith(':persona ')) {
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
          // Try as preset name
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
        rl.prompt();
        return;
      }
      if (line === ':fork' || line.startsWith(':fork ')) {
        const reason = line.slice(':fork'.length).trim();
        try {
          const result = (await request('POST', baseUrl, '/session/fork', { reason })) as any;
          console.log(`  ${SUCCESS('\u2713')} Session forked: ${pc.white(result.session.id)}`);
          if (reason) console.log(`  ${DIM('Reason:')} ${reason}`);
        } catch (err: unknown) {
          console.log(`  ${ERROR((err as Error).message)}`);
        }
        rl.prompt();
        return;
      }
      if (line.startsWith(':spawn ')) {
        const focus = line.slice(':spawn '.length).trim();
        if (!focus) {
          console.log(`  ${ERROR('Usage: :spawn <focus description>')}`);
          rl.prompt();
          return;
        }
        try {
          const result = (await request('POST', baseUrl, '/session/spawn', { focus })) as any;
          console.log(
            `  ${SUCCESS('\u2713')} Child session spawned: ${pc.white(result.session.id)}`,
          );
          console.log(`  ${DIM('Focus:')} ${focus}`);
        } catch (err: unknown) {
          console.log(`  ${ERROR((err as Error).message)}`);
        }
        rl.prompt();
        return;
      }
      if (line === ':mode' || line.startsWith(':mode ')) {
        await handleModeCommand(
          {
            baseUrl,
            agents,
            config,
            rl,
            HYDRA_ROOT,
            getLoopMode: () => mode,
            setLoopMode: (m) => {
              mode = m;
            },
            initStatusBar,
            destroyStatusBar,
            drawStatusBar,
          },
          line.slice(':mode'.length).trim(),
        );
        return;
      }

      // ── Confirmation Toggle ──────────────────────────────────────────────
      if (line === ':confirm' || line.startsWith(':confirm ')) {
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
          const state = isAutoAccepting() ? DIM('off (auto-accepting)') : ACCENT('on');
          console.log(label('Confirmations', state));
          console.log(DIM(`  Toggle: :confirm on | :confirm off`));
        }
        rl.prompt();
        return;
      }

      // ── Dry-Run Toggle ──────────────────────────────────────────────────
      if (line === ':dry-run' || line.startsWith(':dry-run ')) {
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
          const state = dryRunMode ? ACCENT('ON') : DIM('off');
          console.log(label('Dry-run mode', state));
          if (dryRunMode) {
            console.log(
              DIM(`  Dispatches will preview route/agent selection without creating tasks`),
            );
          }
        }
        rl.prompt();
        return;
      }

      // ── Task & Handoff Management ─────────────────────────────────────────
      if (line === ':clear' || line.startsWith(':clear ')) {
        let what = line.slice(':clear'.length).trim().toLowerCase();

        // Interactive menu when no target specified
        if (!what) {
          const pick = (await promptChoice(rl, {
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
            rl.prompt();
            return;
          }
          what = pick.value;
        }

        // Non-destructive targets (no confirmation needed)
        if (what === 'screen') {
          process.stdout.write('\x1b[2J\x1b[H');
          rl.prompt();
          return;
        }
        if (what === 'concierge') {
          resetConversation();
          console.log(`  ${SUCCESS('\u2713')} Concierge conversation cleared`);
          rl.prompt();
          return;
        }
        if (what === 'metrics') {
          resetMetrics();
          resetSessionUsage();
          console.log(`  ${SUCCESS('\u2713')} Session metrics reset`);
          rl.prompt();
          return;
        }

        // Destructive targets — confirmation gate
        if (what === 'all' || what === 'tasks' || what === 'handoffs') {
          const clearConfirm = (await promptChoice(rl, {
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
            rl.prompt();
            return;
          }
          try {
            const { state } = (await request('GET', baseUrl, '/state')) as any;
            let ackedCount = 0;
            let cancelledCount = 0;

            if (what === 'all' || what === 'handoffs') {
              const pending = state.handoffs.filter((h: any) => !h.acknowledgedAt);
              for (const h of pending) {
                const agent = String(h.to ?? 'human').toLowerCase();
                (await request('POST', baseUrl, '/handoff/ack', { handoffId: h.id, agent })) as any;
                ackedCount++;
              }
            }

            if (what === 'all' || what === 'tasks') {
              const open = state.tasks.filter(
                (t: any) => t.status === 'todo' || t.status === 'in_progress',
              );
              for (const t of open) {
                (await request('POST', baseUrl, '/task/update', {
                  taskId: t.id,
                  status: 'cancelled',
                })) as any;
                cancelledCount++;
              }
            }

            const parts = [];
            if (ackedCount > 0)
              parts.push(`${String(ackedCount)} handoff${ackedCount > 1 ? 's' : ''} acked`);
            if (cancelledCount > 0)
              parts.push(
                `${String(cancelledCount)} task${cancelledCount > 1 ? 's' : ''} cancelled`,
              );
            console.log(
              parts.length > 0
                ? `  ${SUCCESS('\u2713')} ${parts.join(', ')}`
                : `  ${DIM('Nothing to clear')}`,
            );
          } catch (err: unknown) {
            console.log(`  ${ERROR((err as Error).message)}`);
          }
          rl.prompt();
          return;
        }

        // Unknown target
        console.log(`  ${ERROR('Unknown target:')} ${what}`);
        console.log(`  ${DIM('Usage: :clear [all|tasks|handoffs|concierge|metrics|screen]')}`);
        rl.prompt();
        return;
      }

      if (line.startsWith(':cancel ')) {
        const id = line.slice(':cancel '.length).trim().toUpperCase();
        try {
          const result = (await request('POST', baseUrl, '/task/update', {
            taskId: id,
            status: 'cancelled',
          })) as any;
          console.log(
            `  ${SUCCESS('\u2713')} ${pc.white(result.task.id)} cancelled ${DIM(result.task.title)}`,
          );
        } catch (err: unknown) {
          console.log(`  ${ERROR((err as Error).message)}`);
        }
        rl.prompt();
        return;
      }

      if (line === ':tasks' || line.startsWith(':tasks ')) {
        await handleTasksCommand(
          {
            baseUrl,
            agents,
            config,
            rl,
            HYDRA_ROOT,
            getLoopMode: () => mode,
            setLoopMode: (m) => {
              mode = m;
            },
            initStatusBar,
            destroyStatusBar,
            drawStatusBar,
          },
          line.slice(':tasks'.length).trim(),
        );
        return;
      }

      if (line === ':handoffs') {
        try {
          const { state } = (await request('GET', baseUrl, '/state')) as any;
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
        rl.prompt();
        return;
      }

      if (line === ':archive') {
        try {
          const result = (await request('POST', baseUrl, '/state/archive')) as any;
          console.log(
            `  ${SUCCESS('\u2713')} Archived: ${String(result.moved.tasks)} tasks, ${String(result.moved.handoffs)} handoffs, ${String(result.moved.blockers)} blockers${result.eventsTrimmed ? `, ${String(result.eventsTrimmed)} events trimmed` : ''}`,
          );
        } catch (err: unknown) {
          console.log(`  ${ERROR((err as Error).message)}`);
        }
        rl.prompt();
        return;
      }

      if (line === ':events') {
        try {
          const result = (await request('GET', baseUrl, '/events')) as any;
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
        rl.prompt();
        return;
      }

      if (line === ':sync') {
        try {
          const syncResult = syncHydraMd(config.projectRoot);
          if (syncResult.skipped) {
            console.log(`  ${DIM('No HYDRA.md found in project root.')}`);
          } else if (syncResult.synced.length > 0) {
            console.log(
              `  ${SUCCESS('\u2713')} Synced HYDRA.md \u2192 ${syncResult.synced.join(', ')}`,
            );
          } else {
            console.log(`  ${DIM('All agent files up to date.')}`);
          }
        } catch (err: unknown) {
          console.log(`  ${ERROR((err as Error).message)}`);
        }
        rl.prompt();
        return;
      }

      if (line === ':shutdown') {
        const shutdownConfirm = (await promptChoice(rl, {
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
          rl.prompt();
          return;
        }
        stopAllWorkers();
        try {
          (await request('POST', baseUrl, '/shutdown')) as any;
          console.log(`  ${SUCCESS('\u2713')} Daemon shutting down`);
        } catch (err: unknown) {
          console.log(`  ${ERROR((err as Error).message)}`);
        }
        rl.close();
        return;
      }

      // ── Agent Forge Commands ─────────────────────────────────────────────
      if (line === ':forge' || line.startsWith(':forge ')) {
        const forgeArgs = line.slice(':forge'.length).trim();
        const forgeParts = forgeArgs.split(/\s+/);
        const forgeSubCmd = forgeParts[0] || '';

        if (!forgeSubCmd) {
          // Interactive wizard
          try {
            await runForgeWizard(rl);
          } catch (err: unknown) {
            console.log(`  ${ERROR('Forge error:')} ${(err as Error).message}`);
          }
        } else if (forgeSubCmd === 'list') {
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
        } else if (forgeSubCmd === 'info') {
          const targetName = forgeParts[1];
          if (targetName) {
            const registry = loadForgeRegistry();
            const meta = registry[targetName];
            const agentDef = getAgent(targetName);
            console.log('');
            console.log(sectionHeader(`Forge: ${agentDef?.displayName ?? targetName}`));
            if (agentDef) {
              console.log(`  ${pc.bold('Name:')}      ${agentDef.name}`);
              console.log(`  ${pc.bold('Base:')}      ${String(agentDef.baseAgent)}`);
              console.log(
                `  ${pc.bold('Enabled:')}   ${agentDef.enabled ? SUCCESS('yes') : ERROR('no')}`,
              );
              console.log(`  ${pc.bold('Strengths:')} ${agentDef.strengths!.join(', ')}`);
              console.log(`  ${pc.bold('Tags:')}      ${agentDef.tags!.join(', ')}`);
            }
            console.log(`  ${pc.bold('Forged:')}    ${meta.forgedAt}`);
            console.log(`  ${pc.bold('Version:')}   ${String(meta.version)}`);
            console.log(
              `  ${pc.bold('Phases:')}    ${meta.phasesRun.join(' \u2192 ') || 'unknown'}`,
            );
            if (meta.description) console.log(`  ${pc.bold('Goal:')}      ${meta.description}`);
            if (meta.testResult)
              console.log(
                `  ${pc.bold('Test:')}      ${meta.testResult.ok ? SUCCESS('passed') : ERROR('failed')} (${(meta.testResult.durationMs / 1000).toFixed(1)}s)`,
              );
            console.log('');
          } else {
            console.log(`  ${ERROR('Usage:')} :forge info <name>`);
          }
        } else if (forgeSubCmd === 'test') {
          const targetName = forgeParts[1];
          if (targetName) {
            const agentDef = getAgent(targetName);
            if (agentDef) {
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
            } else {
              console.log(`  ${ERROR('Unknown agent:')} ${targetName}`);
            }
          } else {
            console.log(`  ${ERROR('Usage:')} :forge test <name>`);
          }
          console.log('');
        } else if (forgeSubCmd === 'delete') {
          const targetName = forgeParts[1];
          if (targetName) {
            const agentDef = getAgent(targetName);
            if (!agentDef) {
              console.log(`  ${ERROR('Unknown agent:')} ${targetName}`);
            } else if (agentDef.type === AGENT_TYPE.PHYSICAL) {
              console.log(`  ${ERROR('Cannot delete physical agents.')}`);
            } else {
              removeForgedAgent(targetName);
              console.log(`  ${SUCCESS('\u2713')} Agent ${ACCENT(targetName)} removed.`);
            }
          } else {
            console.log(`  ${ERROR('Usage:')} :forge delete <name>`);
          }
          console.log('');
        } else if (forgeSubCmd === 'edit') {
          const targetName = forgeParts[1];
          if (targetName) {
            const agentDef = getAgent(targetName);
            const registry = loadForgeRegistry();
            const meta = registry[targetName];
            if (agentDef) {
              console.log(`  ${ACCENT('\u25B6')} Re-forging ${targetName}...`);
              try {
                const desc = meta.description || agentDef.displayName;
                await runForgeWizard(rl, desc);
              } catch (err: unknown) {
                console.log(`  ${ERROR('Forge error:')} ${(err as Error).message}`);
              }
            } else {
              console.log(`  ${ERROR('Unknown agent:')} ${targetName}`);
            }
          } else {
            console.log(`  ${ERROR('Usage:')} :forge edit <name>`);
          }
        } else {
          // Treat the whole arg string as a description
          try {
            await runForgeWizard(rl, forgeArgs);
          } catch (err: unknown) {
            console.log(`  ${ERROR('Forge error:')} ${(err as Error).message}`);
          }
        }

        rl.prompt();
        return;
      }

      // ── Agent Registry Commands ────────────────────────────────────────
      if (line === ':agents' || line.startsWith(':agents ')) {
        await handleAgentsCommand(
          {
            baseUrl,
            agents,
            config,
            rl,
            HYDRA_ROOT,
            getLoopMode: () => mode,
            setLoopMode: (m) => {
              mode = m;
            },
            initStatusBar,
            destroyStatusBar,
            drawStatusBar,
          },
          line.slice(':agents'.length).trim(),
        );
        return;
      }

      // ── Cleanup Command ──────────────────────────────────────────────────
      if (line === ':cleanup') {
        await handleCleanupCommand({
          baseUrl,
          agents,
          config,
          rl,
          HYDRA_ROOT,
          getLoopMode: () => mode,
          setLoopMode: (m) => {
            mode = m;
          },
          initStatusBar,
          destroyStatusBar,
          drawStatusBar,
        });
        return;
      }

      if (line === ':pr' || line.startsWith(':pr ')) {
        await handlePrCommand(
          {
            baseUrl,
            agents,
            config,
            rl,
            HYDRA_ROOT,
            getLoopMode: () => mode,
            setLoopMode: (m) => {
              mode = m;
            },
            initStatusBar,
            destroyStatusBar,
            drawStatusBar,
          },
          line.slice(':pr'.length).trim(),
        );
        return;
      }

      // ── Nightly Commands ─────────────────────────────────────────────────
      if (line === ':nightly' || line.startsWith(':nightly ')) {
        await handleNightlyCommand(
          {
            baseUrl,
            agents,
            config,
            rl,
            HYDRA_ROOT,
            getLoopMode: () => mode,
            setLoopMode: (m) => {
              mode = m;
            },
            initStatusBar,
            destroyStatusBar,
            drawStatusBar,
          },
          line.slice(':nightly'.length).trim(),
        );
        return;
      }

      // ── Evolve Commands ──────────────────────────────────────────────────
      if (line === ':evolve' || line.startsWith(':evolve ')) {
        await handleEvolveCommand(
          {
            baseUrl,
            agents,
            config,
            rl,
            HYDRA_ROOT,
            getLoopMode: () => mode,
            setLoopMode: (m) => {
              mode = m;
            },
            initStatusBar,
            destroyStatusBar,
            drawStatusBar,
          },
          line.slice(':evolve'.length).trim(),
        );
        return;
      }

      // Catch unrecognized : commands — fuzzy match locally first, then concierge
      if (line.startsWith(':')) {
        // Try local fuzzy matching first (saves API call)
        const fuzzyMatch = fuzzyMatchCommand(line);
        if (fuzzyMatch) {
          console.log(`  ${DIM('Did you mean')} ${ACCENT(fuzzyMatch)}${DIM('?')}`);
          rl.prompt();
          return;
        }

        if (conciergeActive) {
          const modelLbl = getConciergeModelLabel();
          try {
            const hint = `The user typed "${line}" which is not a recognized command. Suggest the correct command.`;
            const cmdResult = await conciergeTurn(hint, {
              context: { projectName: config.projectName, projectRoot: config.projectRoot, mode },
            });
            const cmdResponse =
              (cmdResult as any).response ?? (cmdResult as any).fullResponse ?? '';
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
        rl.prompt();
        return;
      }

      // ── Sidecar: auto-route to concierge while dispatch/council is running ──
      if (dispatchDepth > 0 && !line.startsWith(':') && !isChoiceActive()) {
        if (sidecaring) {
          process.stdout.write(`\r\x1b[2K  ${DIM(`${pc.blue('\u2B22')} still thinking\u2026`)}\n`);
          rl.prompt(true);
          return;
        }
        if (!isConciergeAvailable()) {
          process.stdout.write(
            `\r\x1b[2K  ${DIM(`${pc.blue('\u2B22')} no concierge available while agents run`)}\n`,
          );
          rl.prompt(true);
          return;
        }
        const sidecarModel = getConciergeModelLabel();
        const sidecarContext: any = {
          projectName: config.projectName,
          projectRoot: config.projectRoot,
          mode,
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
        sidecaring = true;
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
          sidecaring = false;
          rl.prompt(true);
        }
        return;
      }

      // ── Force-dispatch escape hatch (bypass concierge with ! prefix) ────
      let dispatchLine = line;
      if (conciergeActive && line.startsWith('!')) {
        dispatchLine = line.slice(1).trim();
        if (!dispatchLine) {
          rl.prompt();
          return;
        }
        // Fall through to normal dispatch with the cleaned prompt
      }
      // ── Concierge Intercept ────────────────────────────────────────────
      else if (conciergeActive && !line.startsWith(':') && !isChoiceActive()) {
        // Gather enriched context for the system prompt
        const context: any = {
          projectName: config.projectName,
          projectRoot: config.projectRoot,
          mode,
        };
        try {
          context.knownProjects = getRecentProjects();
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
          context.agentModels = agentModels;
        } catch {
          /* skip */
        }
        try {
          const sessionStatus = (await request('GET', baseUrl, '/session/status')) as any;
          context.openTasks =
            Number((sessionStatus.inProgressTasks ?? []).length) +
            Number((sessionStatus.pendingHandoffs ?? []).length);
        } catch {
          context.openTasks = 0;
        }

        // Phase 4: Enriched awareness context
        try {
          context.gitInfo = getGitInfo();
        } catch {
          /* skip */
        }
        try {
          const events = await request('GET', baseUrl, '/events/replay?category=task&from=0');
          if (Array.isArray(events)) {
            context.recentCompletions = events
              .filter(
                (e: any) => e.payload?.status === 'done' || e.payload?.event === 'task_result',
              )
              .slice(-3)
              .map((e: any) => ({
                agent: e.payload?.agent ?? e.payload?.owner ?? 'unknown',
                title: e.payload?.title ?? e.payload?.taskId ?? '',
                taskId: e.payload?.taskId ?? '',
              }));
            context.recentErrors = events
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
          if (activeWorkerNames.length > 0) context.activeWorkers = activeWorkerNames;
        } catch {
          /* skip */
        }

        // Inject codebase baseline (always)
        try {
          context.codebaseBaseline = getBaselineContext();
        } catch {
          /* skip */
        }

        // Always-on self-awareness (unless explicitly disabled via :aware/config)
        try {
          const sa = loadHydraConfig().selfAwareness ?? {};
          const enabled = sa.enabled !== false;
          const inject = sa.injectIntoConcierge !== false;
          if (enabled && inject) {
            const includeSnapshot = sa.includeSnapshot !== false;
            const includeIndex = sa.includeIndex !== false;
            const maxLines = Number.isFinite(sa.snapshotMaxLines) ? sa.snapshotMaxLines : 80;
            const maxChars = Number.isFinite(sa.indexMaxChars) ? sa.indexMaxChars : 7000;
            const refreshMs = Number.isFinite(sa.indexRefreshMs) ? sa.indexRefreshMs : 300_000;

            context.selfAwarenessKey = `on:${String(includeSnapshot ? 1 : 0)}:${String(includeIndex ? 1 : 0)}:${String(maxChars)}`;

            if (includeSnapshot) {
              const snap = buildSelfSnapshot({
                projectRoot: config.projectRoot,
                projectName: config.projectName,
              });
              context.selfSnapshotBlock = formatSelfSnapshotForPrompt(snap, { maxLines });
            }

            if (includeIndex) {
              const now = Date.now();
              const key = `maxChars=${String(maxChars)}`;
              if (
                !_selfIndexCache.block ||
                _selfIndexCache.key !== key ||
                now - _selfIndexCache.builtAt > refreshMs!
              ) {
                const idx = buildSelfIndex(HYDRA_ROOT);
                _selfIndexCache = {
                  builtAt: now,
                  key,
                  block: formatSelfIndexForPrompt(idx, { maxChars }),
                };
              }
              context.selfIndexBlock = _selfIndexCache.block;
            }
          } else {
            context.selfAwarenessKey = 'off';
          }
        } catch {
          /* skip */
        }

        // Detect situational queries and inject rich activity digest
        try {
          const { isSituational, focus } = detectSituationalQuery(line);
          if (isSituational) {
            const digest = await buildActivityDigest({
              baseUrl,
              workers: workers as any,
              focus: focus ?? undefined,
            });
            context.activityDigest = formatDigestForPrompt(digest, { focus: focus ?? undefined });
          }
        } catch {
          /* fall back to sparse context */
        }

        // Detect codebase queries and inject topic-specific context
        try {
          const { isCodebaseQuery, topic } = detectCodebaseQuery(line);
          if (isCodebaseQuery && topic) {
            context.codebaseContext = getTopicContext(topic);
            // Also search knowledge base for relevant findings
            const kbFindings = searchKnowledgeBase(topic);
            if (kbFindings) {
              context.codebaseContext = `${context.codebaseContext as string}\n\n${kbFindings}`;
            }
          }
        } catch {
          /* skip */
        }

        // Show spinner while waiting for full response (buffered, not streamed)
        const modelLbl = getConciergeModelLabel();
        const spinner = createSpinner(`${pc.blue('\u2B22')} ${DIM(modelLbl)} thinking...`, {
          style: 'stellar',
        });
        spinner.start();

        try {
          const result = await conciergeTurn(line, { context });
          spinner.stop();

          // Display complete response at once
          const responseText = (result as any).response ?? (result as any).fullResponse ?? '';
          if (responseText) {
            process.stdout.write(`\n  ${pc.blue('\u2B22')} ${DIM(modelLbl)}\n  `);
            process.stdout.write(pc.blue(responseText));
          }

          // Cost display
          const costStr =
            result.estimatedCost != null && result.estimatedCost > 0
              ? ` ${DIM(`[~$${result.estimatedCost.toFixed(4)}]`)}`
              : '';
          process.stdout.write(`\n${costStr}\n`);

          // Update prompt in case model changed (fallback)
          rl.setPrompt(buildConciergePrompt());

          if (result.intent === 'dispatch') {
            console.log(
              `  ${ACCENT('\u2192')} Routing to dispatch: ${DIM(result.dispatchPrompt!.slice(0, 80))}${result.dispatchPrompt!.length > 80 ? '...' : ''}`,
            );
            console.log('');
            dispatchLine = result.dispatchPrompt!;
            // Fall through to normal dispatch below
          } else {
            rl.prompt();
            return;
          }
        } catch (err: unknown) {
          spinner.stop();
          console.log(`  ${ERROR('Concierge error:')} ${(err as Error).message}`);
          if ((err as any).status === 401 || (err as any).status === 403) {
            conciergeActive = false;
            setActiveMode(mode);
            rl.setPrompt(normalPrompt);
            console.log(`  ${DIM('Concierge auto-disabled due to auth error')}`);
          }
          rl.prompt();
          return;
        }
      }

      if (mode === 'auto' || mode === 'smart') {
        const classification = classifyPrompt(dispatchLine);
        const topic = extractTopic(dispatchLine);

        // Mode-aware agent selection: apply economy/performance multiplier
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

        // Pre-dispatch gate: show classification and let user confirm/modify
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
        const preDispatch = (await promptChoice(rl, {
          title: 'Pre-dispatch Review',
          context: {
            Classification: `${classification.tier} (${String(classification.confidence)} confidence)`,
            Route: routeDesc,
            Signals: classification.reason,
            Prompt: `"${short(dispatchLine, 300)}"`,
          },
          choices: [
            { label: 'Proceed', value: 'proceed', hint: `dispatch as ${classification.tier}` },
            {
              label: 'Proceed (auto-accept)',
              value: '__auto_accept__',
              hint: 'skip future confirmations',
            },
            { label: 'Cancel', value: 'cancel', hint: 'abort this dispatch' },
            {
              label: 'Respond',
              value: 'respond',
              hint: 'type custom instructions',
              freeform: true,
            },
          ],
          defaultValue: 'proceed',
        })) as any;

        if (preDispatch.value === 'cancel') {
          console.log(`  ${DIM('Dispatch cancelled.')}`);
          rl.prompt();
          return;
        }

        // If freeform text was provided, use it as the prompt instead
        if (
          preDispatch.value !== 'proceed' &&
          preDispatch.value !== 'cancel' &&
          !preDispatch.autoAcceptAll &&
          !preDispatch.timedOut
        ) {
          dispatchLine = preDispatch.value;
          console.log(`  ${DIM('Dispatching with modified prompt:')}`);
          console.log(`  ${ACCENT(short(dispatchLine, 70))}`);
        }

        const COUNCIL_AGENTS = [
          { agent: 'claude' },
          { agent: 'gemini' },
          { agent: 'claude' },
          { agent: 'codex' },
        ];
        const rs = classification.routeStrategy;
        let estMs: number;
        if (rs === 'single') {
          estMs = estimateFlowDuration([{ agent: classification.suggestedAgent || 'claude' }]);
        } else if (rs === 'tandem') {
          estMs = 5_000; // 2 daemon HTTP posts, very fast
        } else {
          estMs = estimateFlowDuration(COUNCIL_AGENTS, autoCouncilRounds);
        }
        const smartLabel =
          mode === 'smart'
            ? `Smart (${classification.tier}→${(SMART_TIER_MAP as Record<string, string>)[classification.tier] || 'balanced'}) `
            : '';
        const tandemLabel =
          rs === 'tandem' && classification.tandemPair
            ? `${classification.tandemPair.lead} → ${classification.tandemPair.follow}`
            : '';
        let spinner: ReturnType<ReturnType<typeof createSpinner>['start']>;
        if (rs === 'single') {
          spinner = createSpinner(`${smartLabel}Fast-path → ${classification.suggestedAgent}`, {
            estimatedMs: estMs,
            style: 'solar',
          }).start();
        } else if (rs === 'tandem') {
          spinner = createSpinner(`${smartLabel}Tandem dispatch: ${tandemLabel}`, {
            estimatedMs: estMs,
            style: 'solar',
          }).start();
        } else {
          spinner = createSpinner(`${smartLabel}Running council deliberation`, {
            estimatedMs: estMs,
            style: 'orbital',
          }).start();
        }

        // Set dispatch context for status bar
        setDispatchContext({
          promptSummary: topic || short(dispatchLine, 30),
          topic,
          tier: classification.tier,
        });

        const onProgress = (evt: any) => {
          if (evt.action === 'start') {
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
          }
        };
        let auto;
        if (dispatchDepth === 0 && isConciergeAvailable()) {
          process.stdout.write(
            `\r\x1b[2K  ${DIM(`${pc.blue('\u2B22')} agents running \u2014 you can ask concierge anything`)}\n`,
          );
          rl.prompt(true);
        }
        dispatchDepth++;
        try {
          const dispatchFn = mode === 'smart' ? runSmartPrompt : runAutoPrompt;
          auto = await dispatchFn({
            baseUrl,
            from,
            agents,
            promptText: dispatchLine,
            miniRounds: autoMiniRounds,
            councilRounds: autoCouncilRounds,
            preview: autoPreview || dryRunMode,
            onProgress,
          });
          let succeedMsg: string;
          if (auto.mode === 'fast-path') {
            succeedMsg = `Fast-path dispatched to ${classification.suggestedAgent}`;
          } else if (auto.mode === 'tandem') {
            succeedMsg = `Tandem dispatched: ${auto.route}`;
          } else {
            succeedMsg = `${auto.mode} complete`;
          }
          spinner.succeed(succeedMsg);
        } catch (err: unknown) {
          spinner.fail((err as Error).message);
          clearDispatchContext();
          throw err;
        } finally {
          dispatchDepth--;
        }

        // Post-dispatch: inject task titles into agent status lines
        if (auto.published?.tasks) {
          for (const task of auto.published.tasks) {
            const owner = String(task?.owner ?? '').toLowerCase();
            if (owner && agents.includes(owner)) {
              const title = String(task.title ?? '').slice(0, 40);
              if (title) {
                setAgentActivity(owner, 'idle', title, { taskTitle: title });
              }
            }
          }
        }

        clearDispatchContext();

        // Update status bar with dispatch info
        if (mode !== 'smart') {
          let sbRoute: string;
          if (auto.mode === 'fast-path') {
            sbRoute = `single→${classification.suggestedAgent || 'agent'}`;
          } else if (auto.mode === 'tandem') {
            sbRoute = `tandem→${classification.tandemPair?.lead ?? '?'}+${classification.tandemPair?.follow ?? '?'}`;
          } else {
            sbRoute = auto.mode;
          }
          setLastDispatch({
            route: sbRoute,
            tier: classification.tier,
            agent: auto.mode === 'fast-path' ? classification.suggestedAgent || '' : '',
            mode,
          });
        }
        const dryLabel = dryRunMode ? ' (DRY RUN)' : '';
        console.log(
          sectionHeader((mode === 'smart' ? 'Smart Dispatch' : 'Auto Dispatch') + dryLabel),
        );
        // Route summary
        const routeColor = auto.mode === 'fast-path' ? SUCCESS : ACCENT;
        console.log(label('Route', routeColor(auto.route || auto.recommended)));
        if (dryRunMode) {
          console.log(label('Mode', pc.yellow('DRY RUN — no tasks created')));
        }
        if (auto.mode === 'tandem') {
          const pair = classification.tandemPair;
          if (pair)
            console.log(label('Pattern', DIM(`${pair.lead} (analyze) → ${pair.follow} (execute)`)));
          console.log(label('Saved', DIM('skipped mini-round triage (4 agent calls)')));
        }
        console.log(label('Signals', DIM(classification.reason)));
        if ((auto as any).smartTier) {
          console.log(
            label(
              'Tier',
              `${ACCENT((auto as any).smartTier)} → ${DIM((auto as any).smartMode)} models`,
            ),
          );
        }
        if (auto.triage) {
          console.log(label('Rationale', DIM(auto.triage.recommendationRationale ?? 'n/a')));
        }
        if ((auto as any).escalatedToCouncil) {
          if ((auto as any).councilOutput) {
            console.log((auto as any).councilOutput);
          }
        } else if (auto.published) {
          console.log(label('Tasks created', pc.white(String(auto.published.tasks.length))));
          console.log(label('Handoffs queued', pc.white(String(auto.published.handoffs.length))));
          const handoffAgents = extractHandoffAgents(auto);
          if (handoffAgents.length > 0) {
            const postDispatch = (await promptChoice(rl, {
              title: 'Post-dispatch',
              context: {
                Tasks: `${String(auto.published.tasks.length)} created`,
                Agents: handoffAgents.join(', '),
              },
              choices: [
                {
                  label: 'Start workers',
                  value: 'workers',
                  hint: 'headless background execution (default)',
                },
                {
                  label: 'Launch terminals',
                  value: 'launch',
                  hint: 'open visible terminal windows',
                },
                { label: 'Skip', value: 'skip', hint: 'tasks dispatched, no execution' },
              ],
              defaultValue: 'workers',
            })) as any;
            if (postDispatch.value === 'workers') {
              startAgentWorkers(handoffAgents as string[], baseUrl, { rl });
            } else if (postDispatch.value === 'launch') {
              for (const a of handoffAgents as string[]) setAgentExecMode(a, 'terminal');
              launchAgentTerminals(handoffAgents as string[], baseUrl);
            }
          }
        } else {
          console.log(label('Route', DIM('preview only')));
        }
      } else if (mode === 'council') {
        const councilTopic = extractTopic(dispatchLine);

        // Council gate: check if council is overkill
        const routingCfg = (config as any).routing ?? {};
        const gateClassification = classifyPrompt(dispatchLine);
        if (
          routingCfg.councilGate !== false &&
          gateClassification.routeStrategy !== 'council' &&
          gateClassification.confidence >= 0.5
        ) {
          let efficientRoute: string;
          if (gateClassification.routeStrategy === 'single') {
            efficientRoute = `fast-path → ${gateClassification.suggestedAgent}`;
          } else if (gateClassification.tandemPair) {
            efficientRoute = `tandem: ${gateClassification.tandemPair.lead} → ${gateClassification.tandemPair.follow}`;
          } else {
            efficientRoute = `fast-path → ${gateClassification.suggestedAgent}`;
          }
          const gateChoice = (await promptChoice(rl, {
            title: 'Council Gate',
            context: {
              Classification: `${gateClassification.tier} (${String(gateClassification.confidence)} confidence)`,
              'Efficient route': efficientRoute,
              'Council cost': `${String(councilRounds * 4)} agent calls across ${String(councilRounds)} round(s)`,
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
            rl.prompt();
            return;
          }
          if (gateChoice.value === 'efficient') {
            // Route through auto dispatch with the gate classification
            if (dispatchDepth === 0 && isConciergeAvailable()) {
              process.stdout.write(
                `\r\x1b[2K  ${DIM(`${pc.blue('\u2B22')} agents running \u2014 you can ask concierge anything`)}\n`,
              );
              rl.prompt(true);
            }
            dispatchDepth++;
            let autoResult;
            try {
              autoResult = await runAutoPrompt({
                baseUrl,
                from,
                agents,
                promptText: dispatchLine,
                miniRounds: autoMiniRounds,
                councilRounds: autoCouncilRounds,
                preview: false,
              });
            } finally {
              dispatchDepth--;
            }
            console.log(sectionHeader('Efficient Dispatch (council gate)'));
            console.log(label('Route', SUCCESS(autoResult.route)));
            console.log(label('Signals', DIM(gateClassification.reason)));
            console.log(
              label('Saved', DIM(`skipped council (${String(councilRounds * 4)} agent calls)`)),
            );
            if (autoResult.published) {
              console.log(
                label('Tasks created', pc.white(String(autoResult.published.tasks.length))),
              );
              console.log(
                label('Handoffs queued', pc.white(String(autoResult.published.handoffs.length))),
              );
              const handoffAgents = extractHandoffAgents(autoResult);
              if (handoffAgents.length > 0) {
                startAgentWorkers(handoffAgents as string[], baseUrl, { rl });
              }
            }
            rl.prompt();
            return;
          }
        }

        const COUNCIL_AGENTS_C = [
          { agent: 'claude' },
          { agent: 'gemini' },
          { agent: 'claude' },
          { agent: 'codex' },
        ];
        const councilSpinner = createSpinner('Running council deliberation', {
          estimatedMs: estimateFlowDuration(COUNCIL_AGENTS_C, councilRounds),
          style: 'orbital',
        }).start();

        setDispatchContext({
          promptSummary: councilTopic || short(dispatchLine, 30),
          topic: councilTopic,
          tier: 'complex',
        });

        if (dispatchDepth === 0 && isConciergeAvailable()) {
          process.stdout.write(
            `\r\x1b[2K  ${DIM(`${pc.blue('\u2B22')} council running \u2014 you can ask concierge anything`)}\n`,
          );
          rl.prompt(true);
        }
        dispatchDepth++;
        let council;
        try {
          council = await runCouncilPrompt({
            baseUrl,
            promptText: dispatchLine,
            rounds: councilRounds,
            preview: councilPreview,
            onProgress: (evt) => {
              if (evt['action'] === 'start') {
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
              }
            },
          });
        } finally {
          dispatchDepth--;
        }

        clearDispatchContext();

        if (!council.ok) {
          councilSpinner.fail('Council failed');
          throw new Error(
            council.stderr ??
              council.stdout ??
              `Council exited with status ${String(council.status)}`,
          );
        }
        councilSpinner.succeed('Council completed');
        console.log(council.stdout.trim());
      } else if (mode === 'dispatch') {
        console.log(
          'Dispatch mode: run `npm run hydra:go -- mode=dispatch prompt="..."` for headless pipeline.',
        );
      } else {
        const handoffTopic = extractTopic(dispatchLine);
        const handoffSpinner = createSpinner('Dispatching to agents', {
          estimatedMs: 5_000,
          style: 'eclipse',
        }).start();
        const records = await dispatchPrompt({
          baseUrl,
          from,
          agents,
          promptText: dispatchLine,
        });
        handoffSpinner.succeed('Dispatched');

        // Set agent status to prompt topic instead of bare "Handoff from human"
        for (const item of records) {
          const agentName = (item.agent || '').toLowerCase();
          const title = handoffTopic || short(dispatchLine, 40);
          if (agentName && title) {
            setAgentActivity(agentName, 'idle', title, { taskTitle: title });
          }
        }

        console.log(sectionHeader('Dispatched'));
        for (const item of records) {
          console.log(
            `  ${agentBadge(item.agent)}  ${DIM('handoff=')}${pc.bold(item.handoffId ?? '?')}`,
          );
        }
        const handoffAgents = records.map((r) => r.agent.toLowerCase()).filter(Boolean);
        if (handoffAgents.length > 0) {
          startAgentWorkers(handoffAgents, baseUrl, { rl });
        }
      }
    } catch (err: unknown) {
      console.error(`Error: ${(err as Error).message}`);
    }

    drawStatusBar();
    rl.prompt();
  });

  rl.on('close', () => {
    if (_ghostCleanup) {
      process.stdin.removeListener('data', _ghostCleanup);
      _ghostCleanup = null;
    }
    resetAutoAccept();
    resetConversation();
    stopAllWorkers();
    stopEventStream();
    destroyStatusBar();
    console.log('Hydra operator console closed.');

    process.exit(0);
  });
}

async function main() {
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

  // Register built-in virtual sub-agents
  registerBuiltInSubAgents();

  // Pre-load codebase context for concierge knowledge
  try {
    loadCodebaseContext();
  } catch {
    /* non-critical */
  }

  // Auto-start daemon if not running
  const daemonOk = await ensureDaemon(baseUrl, { quiet: !interactive });
  if (!daemonOk) {
    console.error(`Hydra daemon unreachable at ${baseUrl}.`);
    console.error('Start manually: npm run hydra:start');

    process.exit(1);
  }

  if (interactive) {
    await interactiveLoop({
      baseUrl,
      from,
      agents,
      initialMode: mode,
      councilRounds,
      councilPreview,
      autoMiniRounds,
      autoCouncilRounds,
      autoPreview,
      showWelcome,
    });
    return;
  }

  if (mode === 'auto' || mode === 'smart') {
    const dispatchFn = mode === 'smart' ? runSmartPrompt : runAutoPrompt;
    const auto = await dispatchFn({
      baseUrl,
      from,
      agents,
      promptText,
      miniRounds: autoMiniRounds,
      councilRounds: autoCouncilRounds,
      preview: autoPreview,
    });
    console.log(
      sectionHeader(mode === 'smart' ? 'Smart Dispatch Complete' : 'Auto Dispatch Complete'),
    );
    const oneShotRouteColor = auto.mode === 'fast-path' ? SUCCESS : ACCENT;
    console.log(label('Route', oneShotRouteColor(auto.route || auto.recommended)));
    if (auto.mode === 'tandem') {
      console.log(label('Saved', DIM('skipped mini-round triage (4 agent calls)')));
    }
    if ((auto as any).smartTier) {
      console.log(
        label(
          'Tier',
          `${ACCENT((auto as any).smartTier)} → ${DIM((auto as any).smartMode)} models`,
        ),
      );
    }
    if (auto.triage) {
      console.log(label('Rationale', DIM(auto.triage.recommendationRationale ?? 'n/a')));
    }
    if ((auto as any).escalatedToCouncil) {
      if ((auto as any).councilOutput) {
        console.log((auto as any).councilOutput);
      }
    } else if (auto.published) {
      console.log(label('Tasks created', pc.white(String(auto.published.tasks.length))));
      console.log(label('Handoffs queued', pc.white(String(auto.published.handoffs.length))));
      const handoffAgents = extractHandoffAgents(auto);
      if (handoffAgents.length > 0) startAgentWorkers(handoffAgents as string[], baseUrl);
    } else {
      console.log(label('Route', DIM('preview')));
    }
  } else if (mode === 'council') {
    // One-shot council: log routing tip if council seems overkill
    const oneShotClassification = classifyPrompt(promptText);
    if (
      oneShotClassification.routeStrategy !== 'council' &&
      oneShotClassification.confidence >= 0.5
    ) {
      console.log(
        DIM(
          `  Tip: this prompt classified as ${oneShotClassification.tier} (${String(oneShotClassification.routeStrategy)}), consider auto mode for efficiency`,
        ),
      );
    }
    const council = await runCouncilPrompt({
      baseUrl,
      promptText,
      rounds: councilRounds,
      preview: councilPreview,
    });
    if (!council.ok) {
      throw new Error(
        council.stderr ?? council.stdout ?? `Council exited with status ${String(council.status)}`,
      );
    }
    console.log(council.stdout.trim());
  } else if (mode === 'dispatch') {
    // Headless dispatch pipeline: spawn hydra-dispatch.mjs
    const dispatchScript = path.join(HYDRA_ROOT, 'lib', 'hydra-dispatch.ts');
    const args = [dispatchScript, `prompt=${promptText}`, `url=${baseUrl}`];
    if (boolFlag(options['preview'], false)) {
      args.push('mode=preview');
    }
    const result = spawnHydraNodeSync(args[0], args.slice(1), {
      cwd: config.projectRoot,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 8,
      windowsHide: true,
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  } else {
    const records = await dispatchPrompt({
      baseUrl,
      from,
      agents,
      promptText,
    });

    console.log(sectionHeader('Dispatch Complete'));
    for (const item of records) {
      console.log(
        `  ${agentBadge(item.agent)}  ${DIM('handoff=')}${pc.bold(item.handoffId ?? '?')}`,
      );
    }
    const handoffAgents = records.map((r) => r.agent.toLowerCase()).filter(Boolean);
    if (handoffAgents.length > 0) startAgentWorkers(handoffAgents, baseUrl);
  }
}

const _isMainModule =
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (_isMainModule) {
  main().catch((err: unknown) => {
    console.error(`Hydra operator failed: ${(err as Error).message}`);

    process.exit(1);
  });
}
