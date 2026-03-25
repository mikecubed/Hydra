/**
 * Deep coverage tests for lib/hydra-operator.ts
 *
 * Uses mock.module() to stub ALL I/O dependencies so we can import the full
 * operator module and exercise command dispatch, the REPL line handler,
 * helper functions, and mode-specific code paths.
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// ── Stubs shared across mocks ────────────────────────────────────────────────

const noopFn = mock.fn(() => {});
const noopAsync = mock.fn(async () => {});
const returnEmptyObj = mock.fn(() => ({}));
const returnEmptyArr = mock.fn(() => []);
const returnFalse = mock.fn(() => false);
const returnTrue = mock.fn(() => true);

// ── Mock all operator sub-modules ────────────────────────────────────────────

// hydra-env
mock.module('../lib/hydra-env.ts', {
  namedExports: { envFileExists: mock.fn(() => true) },
});

// hydra-config
mock.module('../lib/hydra-config.ts', {
  namedExports: {
    resolveProject: mock.fn(() => ({
      projectRoot: '/tmp/test-project',
      projectName: 'test-project',
      runsDir: '/tmp/test-project/.hydra/runs',
      configPath: '/tmp/test-project/hydra.config.json',
      routing: { mode: 'balanced', councilGate: true },
    })),
    HYDRA_ROOT: '/tmp/hydra-root',
    loadHydraConfig: mock.fn(() => ({
      routing: { mode: 'balanced', councilGate: true },
      selfAwareness: { enabled: false },
      persona: {},
    })),
    getRecentProjects: mock.fn(() => []),
    saveHydraConfig: noopFn,
    invalidateConfigCache: noopFn,
  },
});

// hydra-agents
mock.module('../lib/hydra-agents.ts', {
  namedExports: {
    getAgent: mock.fn((name: string) => ({
      name,
      label: name.toUpperCase(),
      rolePrompt: `You are ${name}`,
      strengths: [],
      tags: [],
      type: 'physical',
      enabled: true,
      baseAgent: name,
      displayName: name.toUpperCase(),
    })),
    getModelSummary: mock.fn(() => ({
      claude: { active: 'claude-4' },
      gemini: { active: 'gemini-3' },
      codex: { active: 'gpt-5' },
    })),
    AGENT_TYPE: { PHYSICAL: 'physical', VIRTUAL: 'virtual', CUSTOM: 'custom' },
    bestAgentFor: mock.fn(() => 'claude'),
    AGENT_NAMES: ['claude', 'gemini', 'codex'],
  },
});

// hydra-usage
mock.module('../lib/hydra-usage.ts', {
  namedExports: {
    checkUsage: mock.fn(() => ({ level: 'ok', percent: 10 })),
    renderUsageDashboard: mock.fn(() => 'usage dashboard'),
    formatTokens: mock.fn((n: number) => `${String(n)} tokens`),
  },
});

// hydra-model-recovery
mock.module('../lib/hydra-model-recovery.ts', {
  namedExports: {
    verifyAgentQuota: mock.fn(async () => ({ verified: false, reason: 'ok' })),
    detectRateLimitError: returnFalse,
    calculateBackoff: mock.fn(() => 1000),
  },
});

// hydra-metrics
mock.module('../lib/hydra-metrics.ts', {
  namedExports: {
    getSessionUsage: mock.fn(() => ({
      callCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
    })),
    getMetricsSummary: mock.fn(() => ({ agents: {} })),
    estimateFlowDuration: mock.fn(() => 5000),
    resetMetrics: noopFn,
  },
});

// hydra-utils
mock.module('../lib/hydra-utils.ts', {
  namedExports: {
    parseArgs: mock.fn(() => ({ options: {}, positionals: [] })),
    getPrompt: mock.fn(() => null),
    parseList: mock.fn((s: string) => s.split(',')),
    boolFlag: mock.fn((_v: unknown, def: boolean) => def),
    short: mock.fn((s: string, n: number) => (s || '').slice(0, n)),
    request: mock.fn(async () => ({ state: { handoffs: [], tasks: [] } })),
    classifyPrompt: mock.fn(() => ({
      tier: 'standard',
      confidence: 0.8,
      routeStrategy: 'single',
      taskType: 'code',
      suggestedAgent: 'claude',
      reason: 'test',
      tandemPair: null,
    })),
    ensureDir: noopFn,
    nowIso: mock.fn(() => '2026-01-01T00:00:00Z'),
    runId: mock.fn(() => 'test-run-id'),
    parseJsonLoose: mock.fn((s: string): unknown => {
      try {
        return JSON.parse(s) as unknown;
      } catch {
        return null;
      }
    }),
    sanitizeOwner: mock.fn((s: string) => s),
    normalizeTask: mock.fn((item: unknown) => item),
    dedupeTasks: mock.fn((arr: unknown[]) => arr),
    classifyPromptType: mock.fn(() => 'code'),
    generateSpec: mock.fn(async () => null),
  },
});

// hydra-ui
mock.module('../lib/hydra-ui.ts', {
  namedExports: {
    renderStatsDashboard: mock.fn(() => 'stats dashboard'),
    agentBadge: mock.fn((a: string) => `[${a}]`),
    label: mock.fn((l: string, v: string) => `${l}: ${v}`),
    sectionHeader: mock.fn((s: string) => `== ${s} ==`),
    colorAgent: mock.fn((a: string) => a),
    createSpinner: mock.fn(() => ({
      start: mock.fn(function (this: unknown) {
        return this;
      }),
      stop: noopFn,
      succeed: noopFn,
      fail: noopFn,
      update: noopFn,
    })),
    extractTopic: mock.fn((s: string) => s.slice(0, 20)),
    phaseNarrative: mock.fn((_p: string, a: string) => `${a} working`),
    SUCCESS: mock.fn((s: string) => s),
    ERROR: mock.fn((s: string) => s),
    WARNING: mock.fn((s: string) => s),
    DIM: mock.fn((s: string) => s),
    ACCENT: mock.fn((s: string) => s),
    shortModelName: mock.fn((s: string) => s),
    divider: mock.fn(() => '---'),
    formatElapsed: mock.fn(() => '1s'),
  },
});

// hydra-operator-ui
const mockPrintHelp = mock.fn();
const mockPrintCommandHelp = mock.fn();
const mockPrintStatus = mock.fn(async () => ({ openTasks: [] }));
mock.module('../lib/hydra-operator-ui.ts', {
  namedExports: {
    COMMAND_HELP: { ':help': 'Shows help', ':status': 'Shows status' } as Record<string, string>,
    KNOWN_COMMANDS: [
      ':help',
      ':status',
      ':quit',
      ':exit',
      ':mode',
      ':model',
      ':agents',
      ':sitrep',
      ':self',
      ':aware',
      ':usage',
      ':stats',
      ':resume',
      ':pause',
      ':unpause',
      ':roster',
      ':persona',
      ':fork',
      ':spawn',
      ':confirm',
      ':dry-run',
      ':clear',
      ':cancel',
      ':tasks',
      ':handoffs',
      ':archive',
      ':events',
      ':sync',
      ':shutdown',
      ':forge',
      ':cleanup',
      ':pr',
      ':nightly',
      ':evolve',
      ':model:select',
      ':roles',
    ],
    SMART_TIER_MAP: { simple: 'economy', standard: 'balanced', complex: 'performance' },
    printCommandHelp: mockPrintCommandHelp,
    printHelp: mockPrintHelp,
    printSelfAwarenessStatus: noopFn,
    printStatus: mockPrintStatus,
    getSelfAwarenessSummary: mock.fn(() => 'off'),
  },
});

// hydra-statusbar
mock.module('../lib/hydra-statusbar.ts', {
  namedExports: {
    initStatusBar: noopFn,
    destroyStatusBar: noopFn,
    drawStatusBar: noopFn,
    startEventStream: noopFn,
    stopEventStream: noopFn,
    onActivityEvent: noopFn,
    setAgentActivity: noopFn,
    setLastDispatch: noopFn,
    setActiveMode: noopFn,
    setDispatchContext: noopFn,
    clearDispatchContext: noopFn,
    setAgentExecMode: noopFn,
  },
});

// hydra-operator-workers
mock.module('../lib/hydra-operator-workers.ts', {
  namedExports: {
    workers: new Map(),
    stopAllWorkers: noopFn,
    _getWorkerStatus: mock.fn(() => 'idle'),
    startAgentWorkers: noopFn,
  },
});

// hydra-prompt-choice
const mockPromptChoice = mock.fn(async () => ({ value: 'proceed' }));
mock.module('../lib/hydra-prompt-choice.ts', {
  namedExports: {
    promptChoice: mockPromptChoice,
    isChoiceActive: returnFalse,
    isAutoAccepting: returnFalse,
    setAutoAccept: noopFn,
    resetAutoAccept: noopFn,
  },
});

// hydra-concierge
mock.module('../lib/hydra-concierge.ts', {
  namedExports: {
    conciergeTurn: mock.fn(async () => ({
      response: 'test response',
      intent: 'chat',
      estimatedCost: 0,
    })),
    conciergeSuggest: mock.fn(async () => ({ suggestion: 'test suggestion' })),
    resetConversation: noopFn,
    isConciergeAvailable: returnFalse,
    getConciergeConfig: mock.fn(() => ({
      autoActivate: false,
      showProviderInPrompt: true,
      welcomeMessage: true,
    })),
    getConciergeModelLabel: mock.fn(() => 'test-model'),
    setConciergeBaseUrl: noopFn,
  },
});

// hydra-concierge-providers
mock.module('../lib/hydra-concierge-providers.ts', {
  namedExports: {
    detectAvailableProviders: returnEmptyArr,
  },
});

// hydra-sync-md
mock.module('../lib/hydra-sync-md.ts', {
  namedExports: {
    syncHydraMd: mock.fn(() => ({ skipped: false, synced: ['HYDRA.md'] })),
  },
});

// hydra-sub-agents
mock.module('../lib/hydra-sub-agents.ts', {
  namedExports: { registerBuiltInSubAgents: noopFn },
});

// hydra-activity
mock.module('../lib/hydra-activity.ts', {
  namedExports: {
    detectSituationalQuery: mock.fn(() => ({ isSituational: false, focus: null })),
    buildActivityDigest: mock.fn(async () => ({})),
    formatDigestForPrompt: mock.fn(() => ''),
    generateSitrep: mock.fn(async () => ({ fallback: false, narrative: 'all clear' })),
  },
});

// hydra-codebase-context
mock.module('../lib/hydra-codebase-context.ts', {
  namedExports: {
    loadCodebaseContext: noopFn,
    detectCodebaseQuery: mock.fn(() => ({ isCodebaseQuery: false, topic: null })),
    getTopicContext: mock.fn(() => ''),
    getBaselineContext: mock.fn(() => ''),
    searchKnowledgeBase: mock.fn(() => null),
  },
});

// hydra-self
mock.module('../lib/hydra-self.ts', {
  namedExports: {
    buildSelfSnapshot: mock.fn(() => ({ runtime: { counts: {} } })),
    formatSelfSnapshotForPrompt: mock.fn(() => 'self snapshot'),
  },
});

// hydra-self-index
mock.module('../lib/hydra-self-index.ts', {
  namedExports: {
    buildSelfIndex: returnEmptyObj,
    formatSelfIndexForPrompt: mock.fn(() => 'self index'),
  },
});

// hydra-agent-forge
mock.module('../lib/hydra-agent-forge.ts', {
  namedExports: {
    runForgeWizard: noopAsync,
    listForgedAgents: returnEmptyArr,
    removeForgedAgent: noopFn,
    testForgedAgent: mock.fn(async () => ({ ok: true, durationMs: 100, output: 'ok' })),
    loadForgeRegistry: returnEmptyObj,
  },
});

// hydra-resume-scanner
mock.module('../lib/hydra-resume-scanner.ts', {
  namedExports: { scanResumableState: mock.fn(async () => []) },
});

// hydra-updater
mock.module('../lib/hydra-updater.ts', {
  namedExports: { checkForUpdates: mock.fn(async () => null) },
});

// hydra-persona
mock.module('../lib/hydra-persona.ts', {
  namedExports: {
    showPersonaSummary: noopFn,
    applyPreset: mock.fn(() => true),
    listPresets: mock.fn(() => ['professional', 'friendly']),
    invalidatePersonaCache: noopFn,
    isPersonaEnabled: returnTrue,
    getAgentFraming: mock.fn((a: string) => `You are ${a}`),
    getProcessLabel: mock.fn((k: string) => k),
    runPersonaEditor: noopAsync,
  },
});

// hydra-provider-usage
mock.module('../lib/hydra-provider-usage.ts', {
  namedExports: {
    getProviderUsage: returnEmptyObj,
    saveProviderUsage: noopFn,
    resetSessionUsage: noopFn,
  },
});

// hydra-operator-dispatch
mock.module('../lib/hydra-operator-dispatch.ts', {
  namedExports: {
    dispatchPrompt: mock.fn(async () => [
      { agent: 'claude', handoffId: 'H001' },
      { agent: 'gemini', handoffId: 'H002' },
    ]),
  },
});

// hydra-operator-concierge
mock.module('../lib/hydra-operator-concierge.ts', {
  namedExports: {
    runCouncilPrompt: mock.fn(async () => ({ ok: true, stdout: 'council done', stderr: '' })),
    runAutoPrompt: mock.fn(async () => ({
      ok: true,
      mode: 'fast-path',
      route: 'claude',
      recommended: 'claude',
      published: { tasks: [], handoffs: [] },
    })),
    runSmartPrompt: mock.fn(async () => ({
      ok: true,
      mode: 'fast-path',
      route: 'claude',
      recommended: 'claude',
      published: { tasks: [], handoffs: [] },
      smartTier: 'standard',
      smartMode: 'balanced',
    })),
  },
});

// hydra-operator-commands
mock.module('../lib/hydra-operator-commands.ts', {
  namedExports: {
    handleModelCommand: noopAsync,
    handleModelSelectCommand: noopAsync,
    handleRolesCommand: noopAsync,
    handleModeCommand: noopAsync,
    handleAgentsCommand: noopAsync,
    handleCleanupCommand: noopAsync,
    handlePrCommand: noopAsync,
    handleTasksCommand: noopAsync,
    handleNightlyCommand: noopAsync,
    handleEvolveCommand: noopAsync,
  },
});

// hydra-operator-startup
mock.module('../lib/hydra-operator-startup.ts', {
  namedExports: {
    ensureDaemon: mock.fn(async () => true),
    findPowerShell: mock.fn(() => null),
    findWindowsTerminal: mock.fn(() => null),
    launchAgentTerminals: noopFn,
    extractHandoffAgents: mock.fn(() => []),
    printWelcome: noopAsync,
  },
});

// hydra-operator-self-awareness
mock.module('../lib/hydra-operator-self-awareness.ts', {
  namedExports: {
    selfIndexCache: { block: null, key: '', builtAt: 0 },
    normalizeSimpleCommandText: mock.fn((s: string) => s),
    parseSelfAwarenessPlaintextCommand: mock.fn(() => null),
    applySelfAwarenessPatch: noopAsync,
    getGitInfo: mock.fn(() => ({ branch: 'main', sha: 'abc123' })),
  },
});

// hydra-operator-ghost-text
mock.module('../lib/hydra-operator-ghost-text.ts', {
  namedExports: {
    createGhostTextHelpers: mock.fn(() => ({
      showGhostAfterPrompt: noopFn,
      upgradeGhostText: noopFn,
      cleanup: noopFn,
    })),
  },
});

// hydra-operator-session
mock.module('../lib/hydra-operator-session.ts', {
  namedExports: { executeDaemonResume: noopAsync },
});

// hydra-process
const mockExit = mock.fn();
mock.module('../lib/hydra-process.ts', {
  namedExports: { exit: mockExit, setExitHandler: noopFn, resetExitHandler: noopFn },
});

// hydra-context
mock.module('../lib/hydra-context.ts', {
  namedExports: { buildAgentContext: mock.fn(() => 'context') },
});

// hydra-exec-spawn
mock.module('../lib/hydra-exec-spawn.ts', {
  namedExports: {
    spawnHydraNodeSync: mock.fn(() => ({ status: 0, stdout: '', stderr: '' })),
  },
});

// hydra-output-history
mock.module('../lib/hydra-output-history.ts', {
  namedExports: { initOutputHistory: noopFn },
});

// hydra-roster
mock.module('../lib/hydra-roster.ts', {
  namedExports: { runRosterEditor: noopAsync },
});

// hydra-setup
mock.module('../lib/hydra-setup.ts', {
  namedExports: {
    commandExists: returnFalse,
    registerCustomAgentMcp: noopFn,
    KNOWN_CLI_MCP_PATHS: [],
  },
});

// hydra-doctor
mock.module('../lib/hydra-doctor.ts', {
  namedExports: {
    diagnose: noopFn,
    isDoctorEnabled: returnFalse,
  },
});

// hydra-shared/agent-executor
mock.module('../lib/hydra-shared/agent-executor.ts', {
  namedExports: {
    executeAgentWithRecovery: mock.fn(async () => ({
      ok: true,
      output: '{}',
      stdout: '{}',
      stderr: '',
      error: '',
      exitCode: 0,
      command: 'test',
      args: [],
      promptSnippet: '',
      recovered: false,
    })),
  },
});

// ── Now import the module under test ─────────────────────────────────────────

const { formatUptime, levenshtein, fuzzyMatchCommand, KNOWN_COMMANDS, SMART_TIER_MAP } =
  await import('../lib/hydra-operator.ts');

// ── Tests ────────────────────────────────────────────────────────────────────

describe('formatUptime', () => {
  it('formats sub-minute durations as seconds', () => {
    assert.equal(formatUptime(0), '0s');
    assert.equal(formatUptime(5000), '5s');
    assert.equal(formatUptime(59999), '60s');
  });

  it('formats sub-hour durations as minutes', () => {
    assert.equal(formatUptime(60_000), '1m');
    assert.equal(formatUptime(120_000), '2m');
    assert.equal(formatUptime(3599_999), '60m');
  });

  it('formats multi-hour durations', () => {
    assert.equal(formatUptime(3_600_000), '1.0h');
    assert.equal(formatUptime(7_200_000), '2.0h');
    assert.equal(formatUptime(5_400_000), '1.5h');
  });
});

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    assert.equal(levenshtein('abc', 'abc'), 0);
  });

  it('returns the correct distance for simple edits', () => {
    assert.equal(levenshtein('kitten', 'sitting'), 3);
    assert.equal(levenshtein('', 'abc'), 3);
    assert.equal(levenshtein('abc', ''), 3);
  });

  it('handles single-character differences', () => {
    assert.equal(levenshtein('a', 'b'), 1);
    assert.equal(levenshtein('ab', 'ac'), 1);
  });
});

describe('fuzzyMatchCommand', () => {
  it('returns null for totally unrelated input', () => {
    assert.equal(fuzzyMatchCommand('xyzzy'), null);
  });

  it('matches close typos', () => {
    const result = fuzzyMatchCommand(':hlep');
    assert.equal(result, ':help');
  });

  it('matches without colon prefix', () => {
    const result = fuzzyMatchCommand('statu');
    assert.equal(result, ':status');
  });

  it('returns null when distance exceeds threshold', () => {
    const result = fuzzyMatchCommand(':abcdefghijk');
    assert.equal(result, null);
  });
});

describe('KNOWN_COMMANDS', () => {
  it('is a non-empty array of strings', () => {
    assert.ok(Array.isArray(KNOWN_COMMANDS));
    assert.ok(KNOWN_COMMANDS.length > 0);
  });

  it('all entries start with colon', () => {
    for (const cmd of KNOWN_COMMANDS) {
      assert.ok(cmd.startsWith(':'), `Expected colon prefix on "${cmd}"`);
    }
  });
});

describe('SMART_TIER_MAP', () => {
  it('maps tiers to mode names', () => {
    assert.ok(typeof SMART_TIER_MAP === 'object');
    assert.ok('simple' in (SMART_TIER_MAP as Record<string, string>));
    assert.ok('standard' in (SMART_TIER_MAP as Record<string, string>));
    assert.ok('complex' in (SMART_TIER_MAP as Record<string, string>));
  });
});

describe('re-exported utilities', () => {
  it('exports normalizeSimpleCommandText', async () => {
    const mod = await import('../lib/hydra-operator.ts');
    assert.equal(typeof mod.normalizeSimpleCommandText, 'function');
  });

  it('exports parseSelfAwarenessPlaintextCommand', async () => {
    const mod = await import('../lib/hydra-operator.ts');
    assert.equal(typeof mod.parseSelfAwarenessPlaintextCommand, 'function');
  });

  it('exports applySelfAwarenessPatch', async () => {
    const mod = await import('../lib/hydra-operator.ts');
    assert.equal(typeof mod.applySelfAwarenessPatch, 'function');
  });

  it('exports getGitInfo', async () => {
    const mod = await import('../lib/hydra-operator.ts');
    assert.equal(typeof mod.getGitInfo, 'function');
  });

  it('exports ensureDaemon', async () => {
    const mod = await import('../lib/hydra-operator.ts');
    assert.equal(typeof mod.ensureDaemon, 'function');
  });

  it('exports launchAgentTerminals', async () => {
    const mod = await import('../lib/hydra-operator.ts');
    assert.equal(typeof mod.launchAgentTerminals, 'function');
  });

  it('exports extractHandoffAgents', async () => {
    const mod = await import('../lib/hydra-operator.ts');
    assert.equal(typeof mod.extractHandoffAgents, 'function');
  });

  it('exports printWelcome', async () => {
    const mod = await import('../lib/hydra-operator.ts');
    assert.equal(typeof mod.printWelcome, 'function');
  });

  it('exports getSelfAwarenessSummary', async () => {
    const mod = await import('../lib/hydra-operator.ts');
    assert.equal(typeof mod.getSelfAwarenessSummary, 'function');
  });
});
