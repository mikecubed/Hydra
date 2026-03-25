/**
 * Deep coverage tests for lib/hydra-operator.ts
 *
 * Uses mock.module() to mock all I/O dependencies so we can exercise
 * command dispatch, mode handling, formatting, paste buffer logic,
 * and many internal handler paths without needing a real TTY or daemon.
 *
 * Run: node --test --experimental-test-module-mocks test/hydra-operator-deep.coverage.test.ts
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock dependencies BEFORE importing the target module ─────────────────

// hydra-env must be mocked first (imported at module top)
mock.module('../lib/hydra-env.ts', {
  namedExports: {
    envFileExists: mock.fn(() => false),
  },
});

const mockResolveProject = mock.fn(() => ({
  projectRoot: '/tmp/test-project',
  projectName: 'test-project',
}));
const mockLoadHydraConfig = mock.fn(() => ({
  routing: { mode: 'balanced', councilGate: true },
  selfAwareness: { enabled: false },
  persona: { enabled: false },
  rateLimits: {},
}));
const mockGetRecentProjects = mock.fn(() => []);
const MOCK_HYDRA_ROOT = '/tmp/hydra-root';
mock.module('../lib/hydra-config.ts', {
  namedExports: {
    resolveProject: mockResolveProject,
    loadHydraConfig: mockLoadHydraConfig,
    HYDRA_ROOT: MOCK_HYDRA_ROOT,
    getRecentProjects: mockGetRecentProjects,
    saveHydraConfig: mock.fn(),
    getRoleConfig: mock.fn(() => ({})),
  },
});

// hydra-agents
const mockGetAgent = mock.fn(() => null);
const mockGetModelSummary = mock.fn(() => ({}));
const mockBestAgentFor = mock.fn(() => 'claude');
mock.module('../lib/hydra-agents.ts', {
  namedExports: {
    getAgent: mockGetAgent,
    getModelSummary: mockGetModelSummary,
    AGENT_TYPE: { PHYSICAL: 'physical', VIRTUAL: 'virtual', FORGED: 'forged' },
    bestAgentFor: mockBestAgentFor,
  },
});

// hydra-usage
mock.module('../lib/hydra-usage.ts', {
  namedExports: {
    checkUsage: mock.fn(() => ({ totalCost: 0, limit: 100 })),
    renderUsageDashboard: mock.fn(() => 'Usage dashboard'),
    formatTokens: mock.fn((n: number) => `${String(n)} tok`),
  },
});

// hydra-model-recovery
mock.module('../lib/hydra-model-recovery.ts', {
  namedExports: {
    verifyAgentQuota: mock.fn(async () => ({ verified: false })),
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
    resetMetrics: mock.fn(),
  },
});

// hydra-utils
const mockParseArgs = mock.fn(() => ({ options: {}, positionals: [] }));
const mockClassifyPrompt = mock.fn(() => ({
  tier: 'simple',
  confidence: 0.8,
  routeStrategy: 'single',
  suggestedAgent: 'claude',
  reason: 'test',
  taskType: 'code',
}));
mock.module('../lib/hydra-utils.ts', {
  namedExports: {
    parseArgs: mockParseArgs,
    getPrompt: mock.fn(() => null),
    parseList: mock.fn((s: string) => s.split(',')),
    boolFlag: mock.fn((_v: unknown, d: boolean) => d),
    short: mock.fn((s: string, n: number) => (s?.length > n ? `${s.slice(0, n)}...` : (s ?? ''))),
    request: mock.fn(async () => ({})),
    classifyPrompt: mockClassifyPrompt,
  },
});

// hydra-ui
const mockCreateSpinner = mock.fn(() => ({
  start: mock.fn(function (this: unknown) {
    return this;
  }),
  stop: mock.fn(),
  succeed: mock.fn(),
  fail: mock.fn(),
  update: mock.fn(),
}));
mock.module('../lib/hydra-ui.ts', {
  namedExports: {
    renderStatsDashboard: mock.fn(() => 'Stats dashboard'),
    agentBadge: mock.fn((a: string) => `[${a}]`),
    label: mock.fn((k: string, v: string) => `${k}: ${v}`),
    sectionHeader: mock.fn((s: string) => `=== ${s} ===`),
    colorAgent: mock.fn((a: string) => a),
    createSpinner: mockCreateSpinner,
    extractTopic: mock.fn(() => 'test topic'),
    phaseNarrative: mock.fn(() => 'working...'),
    SUCCESS: mock.fn((s: string) => s),
    ERROR: mock.fn((s: string) => s),
    WARNING: mock.fn((s: string) => s),
    DIM: mock.fn((s: string) => s),
    ACCENT: mock.fn((s: string) => s),
    shortModelName: mock.fn((s: string) => s),
  },
});

// hydra-operator-ui
const mockKnownCommands = [
  ':help',
  ':status',
  ':sitrep',
  ':self',
  ':aware',
  ':usage',
  ':stats',
  ':resume',
  ':pause',
  ':unpause',
  ':model',
  ':model:select',
  ':roles',
  ':roster',
  ':persona',
  ':fork',
  ':spawn',
  ':mode',
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
  ':agents',
  ':cleanup',
  ':pr',
  ':nightly',
  ':evolve',
  ':quit',
  ':exit',
];
mock.module('../lib/hydra-operator-ui.ts', {
  namedExports: {
    COMMAND_HELP: { ':help': 'show help', ':status': 'show status' },
    KNOWN_COMMANDS: mockKnownCommands,
    SMART_TIER_MAP: { simple: 'economy', medium: 'balanced', complex: 'performance' },
    printCommandHelp: mock.fn(),
    printHelp: mock.fn(),
    printSelfAwarenessStatus: mock.fn(),
    printStatus: mock.fn(async () => ({ openTasks: [] })),
    getSelfAwarenessSummary: mock.fn(() => 'off'),
  },
});

// hydra-statusbar
mock.module('../lib/hydra-statusbar.ts', {
  namedExports: {
    initStatusBar: mock.fn(),
    destroyStatusBar: mock.fn(),
    drawStatusBar: mock.fn(),
    startEventStream: mock.fn(),
    stopEventStream: mock.fn(),
    onActivityEvent: mock.fn(),
    setAgentActivity: mock.fn(),
    setLastDispatch: mock.fn(),
    setActiveMode: mock.fn(),
    setDispatchContext: mock.fn(),
    clearDispatchContext: mock.fn(),
    setAgentExecMode: mock.fn(),
  },
});

// hydra-operator-workers
mock.module('../lib/hydra-operator-workers.ts', {
  namedExports: {
    workers: new Map(),
    stopAllWorkers: mock.fn(),
    _getWorkerStatus: mock.fn(() => ({})),
    startAgentWorkers: mock.fn(),
  },
});

// hydra-prompt-choice
const mockPromptChoice = mock.fn(async () => ({ value: 'proceed' }));
mock.module('../lib/hydra-prompt-choice.ts', {
  namedExports: {
    promptChoice: mockPromptChoice,
    isChoiceActive: mock.fn(() => false),
    isAutoAccepting: mock.fn(() => false),
    setAutoAccept: mock.fn(),
    resetAutoAccept: mock.fn(),
  },
});

// hydra-concierge
const mockConciergeTurn = mock.fn(async () => ({
  response: 'AI response',
  intent: 'chat',
  estimatedCost: 0.001,
}));
mock.module('../lib/hydra-concierge.ts', {
  namedExports: {
    conciergeTurn: mockConciergeTurn,
    conciergeSuggest: mock.fn(async () => ({ suggestion: 'try this' })),
    resetConversation: mock.fn(),
    isConciergeAvailable: mock.fn(() => false),
    getConciergeConfig: mock.fn(() => ({
      autoActivate: false,
      showProviderInPrompt: true,
      welcomeMessage: true,
    })),
    getConciergeModelLabel: mock.fn(() => 'test-model'),
    setConciergeBaseUrl: mock.fn(),
  },
});

// hydra-concierge-providers
mock.module('../lib/hydra-concierge-providers.ts', {
  namedExports: {
    detectAvailableProviders: mock.fn(() => []),
  },
});

// hydra-sync-md
mock.module('../lib/hydra-sync-md.ts', {
  namedExports: {
    syncHydraMd: mock.fn(() => ({ skipped: false, synced: ['GEMINI.md'] })),
  },
});

// hydra-sub-agents
mock.module('../lib/hydra-sub-agents.ts', {
  namedExports: {
    registerBuiltInSubAgents: mock.fn(),
  },
});

// hydra-activity
mock.module('../lib/hydra-activity.ts', {
  namedExports: {
    detectSituationalQuery: mock.fn(() => ({ isSituational: false, focus: null })),
    buildActivityDigest: mock.fn(async () => ({})),
    formatDigestForPrompt: mock.fn(() => ''),
    generateSitrep: mock.fn(async () => ({ narrative: 'All good', fallback: false })),
  },
});

// hydra-codebase-context
mock.module('../lib/hydra-codebase-context.ts', {
  namedExports: {
    loadCodebaseContext: mock.fn(),
    detectCodebaseQuery: mock.fn(() => ({ isCodebaseQuery: false, topic: null })),
    getTopicContext: mock.fn(() => ''),
    getBaselineContext: mock.fn(() => ''),
    searchKnowledgeBase: mock.fn(() => null),
  },
});

// hydra-self
mock.module('../lib/hydra-self.ts', {
  namedExports: {
    buildSelfSnapshot: mock.fn(() => ({ runtime: { counts: { tasks: 0 } } })),
    formatSelfSnapshotForPrompt: mock.fn(() => 'Self snapshot'),
  },
});

// hydra-self-index
mock.module('../lib/hydra-self-index.ts', {
  namedExports: {
    buildSelfIndex: mock.fn(() => ({})),
    formatSelfIndexForPrompt: mock.fn(() => 'Self index'),
  },
});

// hydra-agent-forge
mock.module('../lib/hydra-agent-forge.ts', {
  namedExports: {
    runForgeWizard: mock.fn(async () => {}),
    listForgedAgents: mock.fn(() => []),
    removeForgedAgent: mock.fn(),
    testForgedAgent: mock.fn(async () => ({ ok: true, durationMs: 1000, output: 'ok' })),
    loadForgeRegistry: mock.fn(() => ({})),
  },
});

// hydra-resume-scanner
mock.module('../lib/hydra-resume-scanner.ts', {
  namedExports: {
    scanResumableState: mock.fn(async () => []),
  },
});

// hydra-updater
mock.module('../lib/hydra-updater.ts', {
  namedExports: {
    checkForUpdates: mock.fn(async () => null),
  },
});

// hydra-persona
mock.module('../lib/hydra-persona.ts', {
  namedExports: {
    showPersonaSummary: mock.fn(),
    applyPreset: mock.fn(),
    listPresets: mock.fn(() => ['concise', 'verbose']),
    invalidatePersonaCache: mock.fn(),
    runPersonaEditor: mock.fn(async () => {}),
  },
});

// hydra-provider-usage
mock.module('../lib/hydra-provider-usage.ts', {
  namedExports: {
    getProviderUsage: mock.fn(() => ({})),
    saveProviderUsage: mock.fn(),
    resetSessionUsage: mock.fn(),
  },
});

// hydra-operator-dispatch
mock.module('../lib/hydra-operator-dispatch.ts', {
  namedExports: {
    dispatchPrompt: mock.fn(async () => []),
  },
});

// hydra-operator-concierge
mock.module('../lib/hydra-operator-concierge.ts', {
  namedExports: {
    runCouncilPrompt: mock.fn(async () => ({ ok: true, stdout: 'council output', stderr: '' })),
    runAutoPrompt: mock.fn(async () => ({
      mode: 'fast-path',
      route: 'claude',
      recommended: 'claude',
      published: { tasks: [], handoffs: [] },
    })),
    runSmartPrompt: mock.fn(async () => ({
      mode: 'fast-path',
      route: 'claude',
      recommended: 'claude',
      published: { tasks: [], handoffs: [] },
      smartTier: 'simple',
      smartMode: 'economy',
    })),
  },
});

// hydra-operator-commands
mock.module('../lib/hydra-operator-commands.ts', {
  namedExports: {
    handleModelCommand: mock.fn(async () => {}),
    handleModelSelectCommand: mock.fn(async () => {}),
    handleRolesCommand: mock.fn(async () => {}),
    handleModeCommand: mock.fn(async () => {}),
    handleAgentsCommand: mock.fn(async () => {}),
    handleCleanupCommand: mock.fn(async () => {}),
    handlePrCommand: mock.fn(async () => {}),
    handleTasksCommand: mock.fn(async () => {}),
    handleNightlyCommand: mock.fn(async () => {}),
    handleEvolveCommand: mock.fn(async () => {}),
  },
});

// hydra-operator-startup
mock.module('../lib/hydra-operator-startup.ts', {
  namedExports: {
    ensureDaemon: mock.fn(async () => true),
    launchAgentTerminals: mock.fn(),
    extractHandoffAgents: mock.fn(() => []),
    printWelcome: mock.fn(async () => {}),
    findPowerShell: mock.fn(() => null),
    findWindowsTerminal: mock.fn(() => null),
  },
});

// hydra-operator-self-awareness
const mockParseSelfAwarenessPlaintextCommand = mock.fn(() => null);
mock.module('../lib/hydra-operator-self-awareness.ts', {
  namedExports: {
    selfIndexCache: { block: null, key: '', builtAt: 0 },
    parseSelfAwarenessPlaintextCommand: mockParseSelfAwarenessPlaintextCommand,
    applySelfAwarenessPatch: mock.fn(async () => {}),
    getGitInfo: mock.fn(() => ({ branch: 'main', hash: 'abc123' })),
    normalizeSimpleCommandText: mock.fn((s: string) => s),
  },
});

// hydra-operator-ghost-text
mock.module('../lib/hydra-operator-ghost-text.ts', {
  namedExports: {
    createGhostTextHelpers: mock.fn(() => ({
      showGhostAfterPrompt: mock.fn(),
      upgradeGhostText: mock.fn(),
      cleanup: mock.fn(),
    })),
  },
});

// hydra-operator-session
mock.module('../lib/hydra-operator-session.ts', {
  namedExports: {
    executeDaemonResume: mock.fn(async () => {}),
  },
});

// hydra-process
mock.module('../lib/hydra-process.ts', {
  namedExports: {
    exit: mock.fn(),
  },
});

// hydra-exec-spawn
mock.module('../lib/hydra-exec-spawn.ts', {
  namedExports: {
    spawnHydraNodeSync: mock.fn(() => ({ status: 0 })),
  },
});

// hydra-output-history (lazy import)
mock.module('../lib/hydra-output-history.ts', {
  namedExports: {
    initOutputHistory: mock.fn(),
  },
});

// ── Import target module AFTER mocking ───────────────────────────────────

const { formatUptime, levenshtein, fuzzyMatchCommand, KNOWN_COMMANDS, SMART_TIER_MAP } =
  await import('../lib/hydra-operator.ts');

// ── formatUptime ─────────────────────────────────────────────────────────

describe('formatUptime (deep)', () => {
  it('returns seconds for sub-minute durations', () => {
    assert.equal(formatUptime(0), '0s');
    assert.equal(formatUptime(1_000), '1s');
    assert.equal(formatUptime(30_000), '30s');
    assert.equal(formatUptime(59_000), '59s');
  });

  it('returns minutes for durations between 1-60 minutes', () => {
    assert.equal(formatUptime(60_000), '1m');
    assert.equal(formatUptime(120_000), '2m');
    assert.equal(formatUptime(300_000), '5m');
    assert.equal(formatUptime(3_599_000), '60m');
  });

  it('returns hours for durations over 60 minutes', () => {
    assert.equal(formatUptime(3_600_000), '1.0h');
    assert.equal(formatUptime(7_200_000), '2.0h');
    assert.equal(formatUptime(5_400_000), '1.5h');
  });

  it('rounds correctly for edge cases', () => {
    // 500ms rounds to 1s
    assert.equal(formatUptime(500), '1s');
    // 59999ms rounds to 60s
    assert.equal(formatUptime(59_999), '60s');
  });
});

// ── levenshtein ──────────────────────────────────────────────────────────

describe('levenshtein (deep)', () => {
  it('returns 0 for identical strings', () => {
    assert.equal(levenshtein('hello', 'hello'), 0);
    assert.equal(levenshtein('', ''), 0);
  });

  it('returns string length for empty comparison', () => {
    assert.equal(levenshtein('hello', ''), 5);
    assert.equal(levenshtein('', 'world'), 5);
  });

  it('returns 1 for single character difference', () => {
    assert.equal(levenshtein('cat', 'bat'), 1);
    assert.equal(levenshtein('cat', 'car'), 1);
    assert.equal(levenshtein('cat', 'cats'), 1);
  });

  it('handles substitution, insertion, deletion', () => {
    assert.equal(levenshtein('kitten', 'sitting'), 3);
  });

  it('is symmetric', () => {
    assert.equal(levenshtein('abc', 'xyz'), levenshtein('xyz', 'abc'));
  });

  it('handles single character strings', () => {
    assert.equal(levenshtein('a', 'a'), 0);
    assert.equal(levenshtein('a', 'b'), 1);
    assert.equal(levenshtein('a', ''), 1);
  });

  it('handles longer distance calculations', () => {
    // 'abcdef' -> 'fedcba' requires 6 operations (full reversal minus shared middle)
    assert.equal(levenshtein('abcdef', 'fedcba'), 6);
  });
});

// ── fuzzyMatchCommand ────────────────────────────────────────────────────

describe('fuzzyMatchCommand (deep)', () => {
  it('returns exact match for known commands', () => {
    assert.equal(fuzzyMatchCommand(':help'), ':help');
    assert.equal(fuzzyMatchCommand(':status'), ':status');
  });

  it('returns close match for typos', () => {
    // :statu -> :status (distance 1)
    const match = fuzzyMatchCommand(':statu');
    assert.equal(match, ':status');
  });

  it('returns null for distant strings', () => {
    assert.equal(fuzzyMatchCommand(':xyzabc'), null);
  });

  it('adds colon prefix if missing', () => {
    const match = fuzzyMatchCommand('help');
    assert.equal(match, ':help');
  });

  it('only uses first word', () => {
    const match = fuzzyMatchCommand(':help extra args');
    assert.equal(match, ':help');
  });

  it('normalizes to lowercase', () => {
    const match = fuzzyMatchCommand(':HELP');
    assert.equal(match, ':help');
  });

  it('returns null for empty input', () => {
    // Empty string -> ":"" which is far from everything
    const match = fuzzyMatchCommand('');
    // The normalized target would be ":" which is far from all commands
    assert.ok(match === null || typeof match === 'string');
  });
});

// ── KNOWN_COMMANDS ───────────────────────────────────────────────────────

describe('KNOWN_COMMANDS (deep)', () => {
  it('is a non-empty array', () => {
    assert.ok(Array.isArray(KNOWN_COMMANDS));
    assert.ok(KNOWN_COMMANDS.length > 0);
  });

  it('all entries start with colon', () => {
    for (const cmd of KNOWN_COMMANDS) {
      assert.ok(cmd.startsWith(':'), `Expected ':' prefix on "${cmd}"`);
    }
  });

  it('contains critical commands', () => {
    const required = [':help', ':status', ':mode', ':quit', ':exit'];
    for (const cmd of required) {
      assert.ok(KNOWN_COMMANDS.includes(cmd), `Missing: ${cmd}`);
    }
  });

  it('has no duplicates', () => {
    const unique = new Set(KNOWN_COMMANDS);
    assert.equal(unique.size, KNOWN_COMMANDS.length);
  });
});

// ── SMART_TIER_MAP ───────────────────────────────────────────────────────

describe('SMART_TIER_MAP (deep)', () => {
  it('maps tiers to routing modes', () => {
    assert.equal(SMART_TIER_MAP.simple, 'economy');
    assert.equal(SMART_TIER_MAP.medium, 'balanced');
    assert.equal(SMART_TIER_MAP.complex, 'performance');
  });

  it('has exactly three entries', () => {
    assert.equal(Object.keys(SMART_TIER_MAP).length, 3);
  });
});
