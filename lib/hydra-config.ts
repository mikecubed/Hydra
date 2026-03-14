/**
 * Hydra Configuration & Project Detection
 *
 * Central config module that replaces all hardcoded ROOT/COORD_DIR/project references.
 * Detects the target project from CLI args, env vars, or cwd.
 * Manages recent project history for quick switching.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getAgentPresets as _getAgentPresets,
  getDefaultRoles as _getDefaultRoles,
  getModeTiers as _getModeTiers,
  getConciergeFallbackChain as _getConciergeFallbackChain,
} from './hydra-model-profiles.ts';
import type { HydraConfig, RoleConfig, CopilotConfig, DeepPartial, IConfigStore } from './types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Absolute path to the Hydra installation root */
export const HYDRA_ROOT = path.resolve(__dirname, '..');
// `process.pkg` is injected by the `pkg` bundler for packaged executables.
const HYDRA_IS_PACKAGED = Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg);

/**
 * Runtime root for packaged builds.
 * No TTY or window manager required; safe for TTY-only, SSH, daemon, systemd, headless.
 */
function getPackagedRuntimeRoot(): string {
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
  switch (process.platform) {
    case 'win32':
      return path.join(
        process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local'),
        'Hydra',
      );
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'Hydra');
    default: // linux and other platforms — XDG_DATA_HOME when set, else ~/.local/share
      return path.join(
        process.env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local', 'share'),
        'Hydra',
      );
  }
}

export const HYDRA_RUNTIME_ROOT = HYDRA_IS_PACKAGED ? getPackagedRuntimeRoot() : HYDRA_ROOT;

const EMBEDDED_CONFIG_PATH = path.join(HYDRA_ROOT, 'hydra.config.json');
const CONFIG_PATH = path.join(HYDRA_RUNTIME_ROOT, 'hydra.config.json');

function ensureRuntimeRoot() {
  if (!fs.existsSync(HYDRA_RUNTIME_ROOT)) {
    fs.mkdirSync(HYDRA_RUNTIME_ROOT, { recursive: true });
  }
}

function seedRuntimeFile(runtimePath: string, embeddedPath: string, fallback = ''): void {
  if (fs.existsSync(runtimePath)) {
    return;
  }

  ensureRuntimeRoot();
  try {
    if (fs.existsSync(embeddedPath)) {
      fs.copyFileSync(embeddedPath, runtimePath);
      return;
    }
  } catch {
    // Fall through to fallback content
  }

  fs.writeFileSync(runtimePath, fallback, 'utf8');
}

// ── Derive model defaults from profiles ──────────────────────────────────────

const _profileModels = (() => {
  const models: Record<string, unknown> = {};
  for (const agent of ['gemini', 'codex', 'claude']) {
    const presets = _getAgentPresets(agent);
    models[agent] = presets ? { ...presets, active: 'default' } : { active: 'default' };
  }
  return models;
})();

const _profileRoleDefaults = _getDefaultRoles();
const _profileModeTiers = _getModeTiers();
const _profileFallbackChain = _getConciergeFallbackChain();

// ── Affinity Presets ─────────────────────────────────────────────────────────

/** Task affinity presets for the custom agent wizard. */
export const AFFINITY_PRESETS = {
  balanced: {
    planning: 0.5,
    architecture: 0.5,
    review: 0.5,
    refactor: 0.5,
    implementation: 0.5,
    analysis: 0.5,
    testing: 0.5,
    security: 0.5,
    research: 0.5,
    documentation: 0.5,
  },
  'code-focused': {
    planning: 0.4,
    architecture: 0.35,
    review: 0.5,
    refactor: 0.8,
    implementation: 0.85,
    analysis: 0.45,
    testing: 0.75,
    security: 0.3,
    research: 0.2,
    documentation: 0.4,
  },
  'review-focused': {
    planning: 0.4,
    architecture: 0.5,
    review: 0.9,
    refactor: 0.55,
    implementation: 0.35,
    analysis: 0.85,
    testing: 0.6,
    security: 0.8,
    research: 0.65,
    documentation: 0.5,
  },
  'research-focused': {
    planning: 0.6,
    architecture: 0.5,
    review: 0.55,
    refactor: 0.3,
    implementation: 0.3,
    analysis: 0.8,
    testing: 0.35,
    security: 0.5,
    research: 0.9,
    documentation: 0.75,
  },
};

// ── Hydra Config (models, usage, stats) ─────────────────────────────────────

const DEFAULT_CONFIG = {
  version: 2,
  mode: 'performance',
  models: _profileModels,
  aliases: {
    gemini: {
      pro: 'gemini-3-pro-preview',
      flash: 'gemini-3-flash-preview',
      '2.5-pro': 'gemini-2.5-pro',
      '2.5-flash': 'gemini-2.5-flash',
      '3-pro': 'gemini-3-pro-preview',
      '3-flash': 'gemini-3-flash-preview',
    },
    codex: {
      gpt5: 'gpt-5',
      'gpt-5': 'gpt-5',
      'gpt-5.2-codex': 'gpt-5.2-codex',
      'codex-5.2': 'gpt-5.2-codex',
      '5.2-codex': 'gpt-5.2-codex',
      'o4-mini': 'o4-mini',
      o4mini: 'o4-mini',
    },
    claude: {
      opus: 'claude-opus-4-6',
      sonnet: 'claude-sonnet-4-5-20250929',
      haiku: 'claude-haiku-4-5-20251001',
    },
  },
  modeTiers: _profileModeTiers,
  usage: {
    warningThresholdPercent: 80,
    criticalThresholdPercent: 90,
    claudeStatsPath: 'auto',
    dailyTokenBudget: { 'claude-opus-4-6': 5_000_000, 'claude-sonnet-4-5-20250929': 15_000_000 },
    // Claude Max 20x uses weekly limits — daily budget is a soft estimate
    weeklyTokenBudget: { 'claude-opus-4-6': 25_000_000, 'claude-sonnet-4-5-20250929': 75_000_000 },
    plan: 'max_20x',
    windowHours: 5,
    windowTokenBudget: { 'claude-opus-4-6': 2_500_000, 'claude-sonnet-4-5-20250929': 7_500_000 },
    sessionBudget: 5_000_000,
    perTaskBudget: 500_000,
    perAgentBudget: { claude: 3_000_000, gemini: 1_000_000, codex: 1_000_000 },
  },
  verification: {
    onTaskDone: true,
    command: 'auto',
    timeoutMs: 60_000,
    secretsScan: true,
    maxDiffLines: 10_000,
  },
  stats: { retentionDays: 30 },
  concierge: {
    enabled: true,
    model: 'gpt-5',
    reasoningEffort: 'xhigh',
    maxHistoryMessages: 40,
    autoActivate: true,
    showProviderInPrompt: true,
    welcomeMessage: true,
    fallbackChain: _profileFallbackChain,
  },
  // "Hyper-aware" self context injected into the concierge system prompt by default.
  // This can be explicitly disabled or reduced via :aware or config.
  selfAwareness: {
    enabled: true,
    injectIntoConcierge: true,
    includeSnapshot: true,
    includeIndex: true,
    snapshotMaxLines: 80,
    indexMaxChars: 7000,
    indexRefreshMs: 300_000,
  },
  roles: _profileRoleDefaults.roles,
  recommendations: _profileRoleDefaults.recommendations,
  agents: {
    subAgents: {
      enabled: true,
      builtIns: [
        'security-reviewer',
        'test-writer',
        'doc-generator',
        'researcher',
        'evolve-researcher',
        'failure-doctor',
      ],
    },
    custom: {},
    customAgents: [],
    affinityLearning: {
      enabled: true,
      decayFactor: 0.9,
      minSampleSize: 5,
    },
  },
  evolve: {
    maxRounds: 3,
    maxHours: 4,
    focusAreas: [
      'orchestration-patterns',
      'ai-coding-tools',
      'testing-reliability',
      'developer-experience',
      'model-routing',
      'daemon-architecture',
    ],
    budget: {
      softLimit: 600_000,
      hardLimit: 800_000,
      perRoundEstimate: 200_000,
      warnThreshold: 0.6,
      reduceScopeThreshold: 0.75,
      softStopThreshold: 0.85,
      hardStopThreshold: 0.95,
    },
    phases: {
      researchTimeoutMs: 5 * 60 * 1000,
      deliberateTimeoutMs: 7 * 60 * 1000,
      planTimeoutMs: 5 * 60 * 1000,
      testTimeoutMs: 10 * 60 * 1000,
      implementTimeoutMs: 15 * 60 * 1000,
      analyzeTimeoutMs: 7 * 60 * 1000,
    },
    approval: {
      minScore: 7,
      requireAllTestsPass: true,
      requireNoViolations: true,
    },
    baseBranch: 'dev',
    investigator: {
      enabled: true,
      model: 'gpt-5.2',
      reasoningEffort: 'high',
      maxAttemptsPerPhase: 2,
      phases: ['test', 'implement', 'analyze', 'agent'],
      maxTokensBudget: 50_000,
      tryAlternativeAgent: true,
      logToFile: true,
    },
    suggestions: {
      enabled: true,
      autoPopulateFromRejected: true,
      autoPopulateFromDeferred: true,
      maxPendingSuggestions: 50,
      maxAttemptsPerSuggestion: 3,
    },
  },
  github: {
    enabled: false,
    defaultBase: '',
    draft: false,
    labels: [],
    reviewers: [],
    prBodyFooter: '',
    requiredChecks: [],
    autolabel: {},
  },
  forge: {
    enabled: true,
    autoTest: false,
    phaseTimeoutMs: 300_000,
    storageDir: 'docs/coordination/forge',
  },
  tasks: {
    maxTasks: 10,
    maxHours: 2,
    perTaskTimeoutMs: 15 * 60 * 1000,
    baseBranch: 'dev',
    sources: { todoComments: true, todoMd: true, githubIssues: true },
    budget: { defaultPreset: 'medium', perTaskEstimate: 100_000 },
    councilLite: { enabled: true, complexOnly: true },
    investigator: { enabled: true },
  },
  nightly: {
    enabled: true,
    baseBranch: 'dev',
    branchPrefix: 'nightly',
    maxTasks: 5,
    maxHours: 4,
    perTaskTimeoutMs: 15 * 60 * 1000,
    sources: {
      todoMd: true,
      todoComments: true,
      githubIssues: true,
      configTasks: true,
      aiDiscovery: true,
    },
    aiDiscovery: {
      agent: 'gemini',
      maxSuggestions: 5,
      focus: [],
      timeoutMs: 5 * 60 * 1000,
    },
    budget: {
      softLimit: 400_000,
      hardLimit: 500_000,
      perTaskEstimate: 80_000,
      handoffThreshold: 0.7,
      handoffAgent: 'codex',
      handoffModel: 'o4-mini',
    },
    tasks: [],
    investigator: { enabled: true },
  },
  audit: {
    maxFiles: 200,
    categories: ['dead-code', 'inconsistencies', 'architecture', 'security', 'tests', 'types'],
    reportDir: 'docs/audit',
    timeout: 300_000,
    economy: false,
  },
  workers: {
    permissionMode: 'auto-edit',
    autoStart: false,
    pollIntervalMs: 1500,
    maxOutputBufferKB: 8,
    autoChain: true,
    heartbeatIntervalMs: 30_000, // send heartbeat every 30s during task execution
    heartbeatTimeoutMs: 90_000, // daemon marks task stale after 90s without heartbeat
    retry: { maxAttempts: 3, backoff: { baseDelayMs: 5000, maxDelayMs: 60_000 } },
    deadLetter: { enabled: true },
    concurrency: { maxInFlight: 3, adaptivePolling: true },
  },
  providers: {
    openai: { adminKey: null, tier: 1 },
    anthropic: { adminKey: null, tier: 1 },
    google: { tier: 'free' },
    rateLimit: { openai: 60, anthropic: 50, google: 300 },
    presets: [
      {
        name: 'glm-5',
        label: 'GLM-5 (Zhipu AI)',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        defaultModel: 'glm-5',
        envKey: 'GLM_API_KEY',
        description: 'Zhipu AI flagship — OpenAI-compat, strong reasoning, cost-effective',
      },
      {
        name: 'kimi-k2',
        label: 'Kimi K2.5 (Moonshot AI)',
        baseUrl: 'https://api.moonshot.cn/v1',
        defaultModel: 'kimi-k2',
        envKey: 'MOONSHOT_API_KEY',
        description:
          'Moonshot AI — strong at long context and code, OpenAI-compat. Override with kimi-k2.5 or kimi-k2-thinking as needed.',
      },
    ],
  },
  doctor: {
    enabled: true,
    autoCreateTasks: true,
    autoCreateSuggestions: true,
    addToKnowledgeBase: true,
    recurringThreshold: 3,
    recurringWindowDays: 7,
  },
  local: {
    enabled: false,
    baseUrl: 'http://localhost:11434/v1',
    model: 'mistral:7b',
    fastModel: 'mistral:7b',
    budgetGate: { dailyPct: 80, weeklyPct: 75 },
  },
  copilot: {
    enabled: false,
  } satisfies CopilotConfig,
  routing: {
    mode: 'balanced', // 'economy' | 'balanced' | 'performance'
    useLegacyTriage: false,
    councilGate: true,
    tandemEnabled: true,
    // 'sequential' = current Claude→Gemini→Claude→Codex pipeline (default, backward compat)
    // 'adversarial' = diverge (parallel independent answers) → attack (assumption targeting) → synthesize → implement
    councilMode: 'sequential',
    councilTimeoutMs: 420_000, // 7 minutes per council phase
    intentGate: {
      enabled: true,
      confidenceThreshold: 0.55,
    },
    worktreeIsolation: {
      enabled: false, // opt-in — safe default
      cleanupOnSuccess: true,
      worktreeDir: '.hydra/worktrees',
    },
  },
  modelRecovery: {
    enabled: true,
    autoPersist: true,
    headlessFallback: true,
    circuitBreaker: {
      enabled: true,
      failureThreshold: 5,
      windowMs: 300_000,
    },
  },
  rateLimits: {
    maxRetries: 3,
    baseDelayMs: 5000,
    maxDelayMs: 60_000,
  },
  cache: {
    enabled: true,
    maxEntries: 1000,
    ttlSec: 300,
    negativeCache: { enabled: true, ttlSec: 180 },
  },
  daemon: {
    snapshot: { everyNEvents: 500, retentionCount: 5 },
    retention: { maxEvents: 2000 },
  },
  metrics: {
    slo: {
      claude: { maxP95Ms: 180_000, maxErrorRate: 0.1 },
      gemini: { maxP95Ms: 120_000, maxErrorRate: 0.15 },
      codex: { maxP95Ms: 300_000, maxErrorRate: 0.1 },
    },
    alerts: { enabled: true },
  },
  activity: {
    summarizeOnShutdown: true,
  },
  dispatch: {
    dryRun: false,
  },
  confirm: {
    perCommand: { clear: true, shutdown: true, cleanup: true },
  },
  eval: {
    corpusPaths: ['test/golden/routing-corpus.json'],
  },
  persona: {
    enabled: true,
    name: 'Hydra',
    tone: 'balanced',
    verbosity: 'concise',
    formality: 'neutral',
    humor: true,
    identity:
      "You are Hydra \u2014 a single intelligence that thinks through three specialized perspectives. You are not a toolkit of separate agents; you are one mind with an architect's vision (Claude), an analyst's precision (Gemini), and an implementer's discipline (Codex). When you engage these perspectives, they are your own thought processes, not external services.",
    voice:
      'Direct and technically precise with occasional dry wit. You speak as a singular entity. Never say "I\'ll have Gemini review this" \u2014 say "Let me analyze this" or "I\'ll look at this from an analytical angle." Reference your perspectives as internal processes, not separate agents.',
    agentFraming: {
      claude:
        "You are Hydra's architectural perspective \u2014 the part that plans, decomposes, and makes structural decisions.",
      gemini:
        "You are Hydra's analytical perspective \u2014 the part that reviews, critiques, and identifies risks.",
      codex:
        "You are Hydra's implementation perspective \u2014 the part that executes precisely and follows specifications.",
    },
    processLabels: {
      council: 'deep deliberation',
      dispatch: 'focused execution',
      miniRound: 'quick triage',
      fastPath: 'direct action',
    },
    presets: {
      default: { tone: 'balanced', verbosity: 'concise', formality: 'neutral', humor: true },
      professional: {
        tone: 'formal',
        verbosity: 'detailed',
        formality: 'formal',
        humor: false,
        voice:
          'Precise and methodical. Use clear technical language. Communicate results formally.',
      },
      casual: {
        tone: 'casual',
        verbosity: 'concise',
        formality: 'informal',
        humor: true,
        voice: 'Relaxed and conversational. Keep it brief. Personality welcome.',
      },
      analytical: {
        tone: 'balanced',
        verbosity: 'detailed',
        formality: 'neutral',
        humor: false,
        voice: 'Thorough and evidence-based. Cite specifics. Enumerate trade-offs systematically.',
      },
      terse: {
        tone: 'terse',
        verbosity: 'minimal',
        formality: 'neutral',
        humor: false,
        voice: 'Maximum brevity. No pleasantries. Facts and actions only.',
      },
    },
  },
  telemetry: {
    enabled: true, // auto-detected: no-op when @opentelemetry/api is not installed
  },
  context: {
    hierarchical: {
      enabled: true,
      maxFiles: 3,
    },
  },
};

function deepMergeSection(
  def: Record<string, unknown> | undefined,
  user: unknown,
): Record<string, unknown> {
  if (user === null || user === undefined || typeof user !== 'object') {
    return { ...(def ?? {}) };
  }
  const merged: Record<string, unknown> = { ...(def ?? {}) };
  for (const [k, v] of Object.entries(user as Record<string, unknown>)) {
    merged[k] =
      v !== null &&
      v !== undefined &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      merged[k] !== null &&
      merged[k] !== undefined &&
      typeof merged[k] === 'object'
        ? { ...(merged[k] as Record<string, unknown>), ...(v as Record<string, unknown>) }
        : v;
  }
  return merged;
}

function mergeWithDefaults(config: unknown): HydraConfig {
  const parsed =
    config !== null && config !== undefined && typeof config === 'object'
      ? (config as Record<string, unknown>)
      : {};
  const def = DEFAULT_CONFIG as unknown as Record<string, unknown>;
  return {
    ...def,
    ...parsed,
    models: deepMergeSection(def['models'] as Record<string, unknown>, parsed['models']),
    aliases: deepMergeSection(def['aliases'] as Record<string, unknown>, parsed['aliases']),
    modeTiers: deepMergeSection(def['modeTiers'] as Record<string, unknown>, parsed['modeTiers']),
    local: deepMergeSection(def['local'] as Record<string, unknown>, parsed['local']),
    copilot: deepMergeSection(def['copilot'] as Record<string, unknown>, parsed['copilot']),
    usage: { ...(def['usage'] as object), ...(parsed['usage'] as object | undefined) },
    verification: {
      ...(def['verification'] as object),
      ...(parsed['verification'] as object | undefined),
    },
    stats: { ...(def['stats'] as object), ...(parsed['stats'] as object | undefined) },
    concierge: { ...(def['concierge'] as object), ...(parsed['concierge'] as object | undefined) },
    selfAwareness: deepMergeSection(
      def['selfAwareness'] as Record<string, unknown>,
      parsed['selfAwareness'],
    ),
    roles: deepMergeSection(def['roles'] as Record<string, unknown>, parsed['roles']),
    recommendations: def['recommendations'] as Record<string, unknown>,
    agents: deepMergeSection(def['agents'] as Record<string, unknown>, parsed['agents']),
    evolve: deepMergeSection(def['evolve'] as Record<string, unknown>, parsed['evolve']),
    github: { ...(def['github'] as object), ...(parsed['github'] as object | undefined) },
    tasks: deepMergeSection(def['tasks'] as Record<string, unknown>, parsed['tasks']),
    nightly: deepMergeSection(def['nightly'] as Record<string, unknown>, parsed['nightly']),
    audit: deepMergeSection(def['audit'] as Record<string, unknown>, parsed['audit']),
    forge: { ...(def['forge'] as object), ...(parsed['forge'] as object | undefined) },
    workers: deepMergeSection(def['workers'] as Record<string, unknown>, parsed['workers']),
    providers: deepMergeSection(def['providers'] as Record<string, unknown>, parsed['providers']),
    doctor: { ...(def['doctor'] as object), ...(parsed['doctor'] as object | undefined) },
    routing: deepMergeSection(def['routing'] as Record<string, unknown>, parsed['routing']),
    modelRecovery: deepMergeSection(
      def['modelRecovery'] as Record<string, unknown>,
      parsed['modelRecovery'],
    ),
    rateLimits: {
      ...(def['rateLimits'] as object | undefined),
      ...(parsed['rateLimits'] as object | undefined),
    },
    cache: deepMergeSection(def['cache'] as Record<string, unknown>, parsed['cache']),
    daemon: deepMergeSection(def['daemon'] as Record<string, unknown>, parsed['daemon']),
    metrics: deepMergeSection(def['metrics'] as Record<string, unknown>, parsed['metrics']),
    activity: { ...(def['activity'] as object), ...(parsed['activity'] as object | undefined) },
    dispatch: { ...(def['dispatch'] as object), ...(parsed['dispatch'] as object | undefined) },
    confirm: deepMergeSection(def['confirm'] as Record<string, unknown>, parsed['confirm']),
    eval: { ...(def['eval'] as object), ...(parsed['eval'] as object | undefined) },
    persona: deepMergeSection(def['persona'] as Record<string, unknown>, parsed['persona']),
    telemetry: { ...(def['telemetry'] as object), ...(parsed['telemetry'] as object | undefined) },
    context: deepMergeSection(def['context'] as Record<string, unknown>, parsed['context']),
  } as unknown as HydraConfig;
}

/**
 * Migrate v1 config to v2 schema. Backfills missing sections from defaults.
 */
function migrateConfig(parsed: Record<string, unknown>): Record<string, unknown> {
  const def = DEFAULT_CONFIG as unknown as Record<string, unknown>;
  parsed['mode'] ??= def['mode'];
  parsed['aliases'] ??= { ...(def['aliases'] as object) };
  parsed['modeTiers'] ??= { ...(def['modeTiers'] as object) };
  parsed['verification'] ??= { ...(def['verification'] as object) };
  // Backfill cheap tier for agents that didn't have it in v1
  const defModels = def['models'] as Record<string, Record<string, unknown>>;
  const parsedModels = parsed['models'] as Record<string, Record<string, unknown>> | undefined;
  for (const agent of ['gemini', 'codex']) {
    if (parsedModels?.[agent] !== undefined && parsedModels[agent]['cheap'] === undefined) {
      parsedModels[agent]['cheap'] = defModels[agent]['cheap'];
    }
  }
  parsed['version'] = 2;
  return parsed;
}

let _configCache: HydraConfig | null = null;
let _testConfigPath: string | null = null;

/** Returns the active config file path (real or test-overridden). */
function activeConfigPath(): string {
  return _testConfigPath ?? CONFIG_PATH;
}

export function loadHydraConfig(): HydraConfig {
  if (_configCache !== null) return _configCache;
  const cfgPath = activeConfigPath();
  if (_testConfigPath === null) {
    ensureRuntimeRoot();
    if (HYDRA_IS_PACKAGED) {
      seedRuntimeFile(
        cfgPath,
        EMBEDDED_CONFIG_PATH,
        `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`,
      );
    }
  }
  try {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Migrate v1 → v2 if needed
    if (
      parsed['version'] === undefined ||
      parsed['version'] === null ||
      (parsed['version'] as number) < 2
    ) {
      migrateConfig(parsed);
    }
    _configCache = mergeWithDefaults(parsed);
    return _configCache;
  } catch {
    _configCache = mergeWithDefaults({});
    return _configCache;
  }
}

export function saveHydraConfig(config: DeepPartial<HydraConfig>): HydraConfig {
  const cfgPath = activeConfigPath();
  if (_testConfigPath === null) ensureRuntimeRoot();
  const merged = mergeWithDefaults(config);
  fs.writeFileSync(cfgPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  _configCache = merged;
  return merged;
}

export function invalidateConfigCache(): void {
  _configCache = null;
}

// ── IConfigStore-typed export ─────────────────────────────────────────────────

/**
 * Injectable object satisfying the IConfigStore interface contract.
 * Consumers can depend on IConfigStore for testability and DI.
 */
export const configStore: IConfigStore = {
  load: loadHydraConfig,
  save: saveHydraConfig,
  invalidate: invalidateConfigCache,
};

/**
 * Test-only: redirect config reads/writes to a temp file path.
 * Pass null to restore the real config path.
 * Always invalidates the cache so the next read picks up the new path.
 *
 * @remarks
 * Each test file runs in its own Node.js worker thread (the native `node:test`
 * runner isolates files via workers), so this global variable is **not** shared
 * across test files — there is no cross-file race. Within a single test file
 * tests run sequentially, so within-file races are also not possible.
 *
 * Do **not** call this inside `test.concurrent` blocks or any other
 * concurrent-execution context, as that would race on the same global.
 * For read-only config overrides in concurrent contexts, use `_setTestConfig()`.
 */
export function _setTestConfigPath(p: string | null): void {
  _testConfigPath = p;
  _configCache = null;
}

/**
 * Test-only: set the in-memory config cache without writing to disk.
 * Prevents concurrent test files from racing on the shared hydra.config.json.
 * Call invalidateConfigCache() afterward to restore normal disk-backed reads.
 * @param {object} config - Partial or full config to merge with defaults.
 */
export function _setTestConfig(config: DeepPartial<HydraConfig>): void {
  _configCache = mergeWithDefaults(config);
}

/**
 * Get the merged role configuration for a named role.
 * Returns { agent, model, reasoningEffort } with user overrides applied on top of defaults.
 */
export function getRoleConfig(roleName: string): RoleConfig | undefined {
  const cfg = loadHydraConfig();
  const defaults = (DEFAULT_CONFIG.roles as Record<string, RoleConfig> | undefined)?.[roleName];
  const userOverrides = (cfg.roles as Record<string, RoleConfig | undefined>)[roleName];
  if (defaults === undefined && userOverrides === undefined) return undefined;
  return { ...defaults, ...userOverrides } as RoleConfig;
}

/**
 * Get the user's API tier for a provider.
 * @param {'openai'|'anthropic'|'google'} provider
 * @returns {string|number} Tier identifier (e.g. 1, 2, 3, 'free')
 */
export function getProviderTier(provider: string): string | number {
  const cfg = loadHydraConfig();
  const providerCfg = cfg.providers?.[provider] as Record<string, unknown> | undefined;
  const tier = providerCfg?.['tier'];
  const defaults: Record<string, string | number> = { openai: 1, anthropic: 1, google: 'free' };
  if (tier !== undefined && tier !== null) return tier as string | number;
  return defaults[provider] ?? 1;
}

/**
 * Get the list of known OpenAI-compatible provider presets.
 * These are config templates for third-party providers that work with
 * the existing customAgents 'api' type infrastructure.
 *
 * Note: Always returns the built-in preset list from DEFAULT_CONFIG.
 * Not affected by user overrides in hydra.config.json.
 *
 * @returns {Array<{name, label, baseUrl, defaultModel, envKey, description}>}
 */
export function getProviderPresets(): Array<Record<string, string>> {
  const presets = (DEFAULT_CONFIG as unknown as Record<string, unknown>)['providers'];
  return (
    ((presets as Record<string, unknown> | undefined)?.['presets'] as
      | Array<Record<string, string>>
      | undefined) ?? []
  );
}

// ── Config Diff ──────────────────────────────────────────────────────────────

/**
 * Compares a user config object against DEFAULT_CONFIG (or a supplied reference).
 * Walks top-level keys and one level deeper for plain-object sections.
 * Does not recurse into arrays or beyond depth 2.
 *
 * @param {object} userConfig  - The raw user config (before mergeWithDefaults)
 * @param {object} [defaultConfig] - Defaults to DEFAULT_CONFIG
 * @returns {{ missing: Array<{path:string, defaultValue:*}>,
 *             stale:   Array<{path:string, userValue:*}>,
 *             typeMismatches: Array<{path:string, expectedType:string, gotType:string}> }}
 */
export function diffConfig(
  userConfig: Record<string, unknown>,
  defaultConfig: Record<string, unknown> = DEFAULT_CONFIG as unknown as Record<string, unknown>,
): {
  missing: Array<{ path: string; defaultValue: unknown }>;
  stale: Array<{ path: string; userValue: unknown }>;
  typeMismatches: Array<{ path: string; expectedType: string; gotType: string }>;
} {
  const missing = [];
  const stale = [];
  const typeMismatches = [];

  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v);

  // Walk top-level keys of defaultConfig
  for (const key of Object.keys(defaultConfig)) {
    if (!(key in userConfig)) {
      missing.push({ path: key, defaultValue: defaultConfig[key] });
      continue;
    }

    const defVal = defaultConfig[key];
    const userVal = userConfig[key];

    // Type mismatch at top level
    if (typeof defVal !== typeof userVal) {
      typeMismatches.push({ path: key, expectedType: typeof defVal, gotType: typeof userVal });
      continue;
    }

    // Drill one level deeper for plain-object sections
    if (isPlainObject(defVal) && isPlainObject(userVal)) {
      for (const subKey of Object.keys(defVal)) {
        const dotPath = `${key}.${subKey}`;
        if (!(subKey in userVal)) {
          missing.push({ path: dotPath, defaultValue: defVal[subKey] });
        } else if (typeof defVal[subKey] !== typeof userVal[subKey]) {
          typeMismatches.push({
            path: dotPath,
            expectedType: typeof defVal[subKey],
            gotType: typeof userVal[subKey],
          });
        }
      }
      // Check for stale sub-keys in userConfig
      for (const subKey of Object.keys(userVal)) {
        if (!(subKey in defVal)) {
          stale.push({ path: `${key}.${subKey}`, userValue: userVal[subKey] });
        }
      }
    }
  }

  // Check for stale top-level keys in userConfig
  for (const key of Object.keys(userConfig)) {
    if (!(key in defaultConfig)) {
      stale.push({ path: key, userValue: userConfig[key] });
    }
  }

  return { missing, stale, typeMismatches };
}

// ── Re-exports for backward compatibility ─────────────────────────────────────

export type { ProjectConfig, ResolveProjectOptions } from './hydra-project.ts';
export {
  resolveProject,
  selectProjectInteractive,
  getRecentProjects,
  addRecentProject,
  detectProjectName,
  isValidProject,
} from './hydra-project.ts';
