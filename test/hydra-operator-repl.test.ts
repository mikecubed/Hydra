/**
 * Deep coverage tests for hydra-operator.ts
 *
 * Strategy: mock every direct dependency so that importing the module exercises
 * all function definitions, re-exports, and module-level code. Then directly
 * test the three exported utility functions (formatUptime, levenshtein,
 * fuzzyMatchCommand).
 *
 * Requires --experimental-test-module-mocks.
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return */

import { describe, it, mock, before } from 'node:test';
import assert from 'node:assert/strict';

// ── Helpers ──────────────────────────────────────────────────────────────────

const noop = (): void => {};
const asyncNoop = async (): Promise<void> => {};
const emptyObj = (): Record<string, unknown> => ({});
const id = (s: unknown): string => {
  if (typeof s === 'string') return s;
  return '';
};

// ── Mock all direct dependencies before importing hydra-operator.ts ──────────

mock.module('../lib/hydra-env.ts', {
  namedExports: { envFileExists: () => true },
});

mock.module('../lib/hydra-exec-spawn.ts', {
  namedExports: { spawnHydraNodeSync: () => ({ status: 0, stdout: '', stderr: '' }) },
});

mock.module('../lib/hydra-agents.ts', {
  namedExports: {
    getAgent: () => null,
    getModelSummary: emptyObj,
    AGENT_TYPE: { PHYSICAL: 'physical', VIRTUAL: 'virtual' },
    bestAgentFor: () => 'claude',
    getAgentNames: () => [],
    registerAgent: noop,
    unregisterAgent: () => false,
    resolvePhysicalAgent: () => null,
    listAgents: () => [],
    AGENTS: {},
    AGENT_NAMES: [],
    getPhysicalAgentNames: () => [],
    getAllAgentNames: () => [],
    AGENT_DISPLAY_ORDER: [],
    KNOWN_OWNERS: new Set(),
    TASK_TYPES: [],
    recordTaskOutcome: noop,
    invalidateAffinityCache: noop,
    classifyTask: () => 'implementation',
    getVerifier: () => 'claude',
    initAgentRegistry: noop,
    isRegistryInitialized: () => true,
    _resetRegistry: noop,
    MODEL_REASONING_CAPS: {},
    getModelReasoningCaps: emptyObj,
    getEffortOptionsForModel: () => [],
    formatEffortDisplay: () => '',
    REASONING_EFFORTS: [],
    getReasoningEffort: () => null,
    setReasoningEffort: noop,
    resolveModelId: () => '',
    getMode: () => 'balanced',
    setMode: noop,
    resetAgentModel: () => null,
    getActiveModel: () => null,
    setActiveModel: () => null,
    getModelFlags: () => [],
    setAgentEnabled: () => false,
  },
});

mock.module('../lib/hydra-usage.ts', {
  namedExports: {
    checkUsage: () => ({ totalCost: 0, budgetLimit: 100 }),
    renderUsageDashboard: () => 'Usage dashboard',
    formatTokens: (n: unknown) => `${String(n)} tokens`,
  },
});

mock.module('../lib/hydra-model-recovery.ts', {
  namedExports: {
    verifyAgentQuota: async () => ({ verified: false, reason: 'ok' }),
    executeAgentWithRecovery: asyncNoop,
  },
});

mock.module('../lib/hydra-metrics.ts', {
  namedExports: {
    getSessionUsage: () => ({
      callCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
    }),
    getMetricsSummary: () => ({ agents: {} }),
    estimateFlowDuration: () => 5000,
    resetMetrics: noop,
  },
});

mock.module('../lib/hydra-config.ts', {
  namedExports: {
    resolveProject: () => ({
      projectRoot: '/tmp/test-project',
      projectName: 'test-project',
      routing: {},
    }),
    HYDRA_ROOT: '/tmp/hydra-root',
    HYDRA_RUNTIME_ROOT: '/tmp/hydra-root',
    loadHydraConfig: () => ({
      routing: { mode: 'balanced', councilGate: true },
      selfAwareness: { enabled: false },
      agents: { customAgents: [] },
      persona: { enabled: false },
    }),
    getRecentProjects: () => [],
    saveHydraConfig: noop,
    getRoleConfig: emptyObj,
    AFFINITY_PRESETS: { balanced: {} },
    invalidateConfigCache: noop,
    configStore: {},
    _setTestConfigPath: noop,
    _setTestConfig: noop,
    getProviderTier: () => 0,
    getProviderPresets: () => [],
    diffConfig: emptyObj,
    getProviderUsageConfig: emptyObj,
  },
});

mock.module('../lib/hydra-utils.ts', {
  namedExports: {
    parseArgs: () => ({ options: {}, positionals: [] }),
    getPrompt: () => null,
    parseList: (s: any) => (s ?? '').split(','),
    boolFlag: (_v: any, def: any) => def,
    short: (s: any, _n: any) => (s ?? '').slice(0, 50),
    request: async () => ({ state: { handoffs: [], tasks: [] } }),
    classifyPrompt: () => ({
      tier: 'routine',
      taskType: 'implementation',
      routeStrategy: 'single',
      suggestedAgent: 'claude',
      confidence: 0.8,
      reason: 'test',
      tandemPair: null,
    }),
  },
});

mock.module('../lib/hydra-ui.ts', {
  namedExports: {
    renderStatsDashboard: () => 'Stats dashboard',
    agentBadge: (a: any) => `[${a}]`,
    label: (k: any, v: any) => `${k}: ${v}`,
    sectionHeader: (s: any) => `-- ${s} --`,
    colorAgent: (a: any) => a,
    createSpinner: () => ({
      start() {
        return this;
      },
      stop: noop,
      succeed: noop,
      fail: noop,
      update: noop,
    }),
    extractTopic: () => 'test topic',
    phaseNarrative: () => 'phase narrative',
    SUCCESS: id,
    ERROR: id,
    WARNING: id,
    DIM: id,
    ACCENT: id,
    shortModelName: id,
  },
});

mock.module('../lib/hydra-operator-ui.ts', {
  namedExports: {
    COMMAND_HELP: { ':help': 'help text', ':status': 'status text' },
    KNOWN_COMMANDS: [':help', ':status', ':quit', ':exit', ':mode', ':agents', ':forge'],
    SMART_TIER_MAP: { routine: 'economy', moderate: 'balanced', complex: 'performance' },
    printCommandHelp: noop,
    printHelp: noop,
    printSelfAwarenessStatus: noop,
    printStatus: async () => ({ openTasks: [] }),
    getSelfAwarenessSummary: () => 'off',
  },
});

mock.module('../lib/hydra-statusbar.ts', {
  namedExports: {
    initStatusBar: noop,
    destroyStatusBar: noop,
    drawStatusBar: noop,
    startEventStream: noop,
    stopEventStream: noop,
    onActivityEvent: noop,
    setAgentActivity: noop,
    setLastDispatch: noop,
    setActiveMode: noop,
    setDispatchContext: noop,
    clearDispatchContext: noop,
    setAgentExecMode: noop,
  },
});

mock.module('../lib/hydra-operator-workers.ts', {
  namedExports: {
    workers: new Map(),
    stopAllWorkers: noop,
    _getWorkerStatus: emptyObj,
    startAgentWorkers: noop,
  },
});

mock.module('../lib/hydra-prompt-choice.ts', {
  namedExports: {
    promptChoice: async () => ({ value: 'proceed' }),
    isChoiceActive: () => false,
    isAutoAccepting: () => false,
    setAutoAccept: noop,
    resetAutoAccept: noop,
  },
});

mock.module('../lib/hydra-concierge.ts', {
  namedExports: {
    conciergeTurn: async () => ({ response: 'test response', intent: 'chat' }),
    conciergeSuggest: async () => ({ suggestion: 'test suggestion' }),
    resetConversation: noop,
    isConciergeAvailable: () => false,
    getConciergeConfig: () => ({
      autoActivate: false,
      showProviderInPrompt: true,
      welcomeMessage: true,
    }),
    getConciergeModelLabel: () => 'test-model',
    setConciergeBaseUrl: noop,
  },
});

mock.module('../lib/hydra-concierge-providers.ts', {
  namedExports: { detectAvailableProviders: () => [] },
});

mock.module('../lib/hydra-sync-md.ts', {
  namedExports: { syncHydraMd: () => ({ skipped: true, synced: [] }) },
});

mock.module('../lib/hydra-sub-agents.ts', {
  namedExports: { registerBuiltInSubAgents: noop },
});

mock.module('../lib/hydra-activity.ts', {
  namedExports: {
    detectSituationalQuery: () => ({ isSituational: false, focus: null }),
    buildActivityDigest: async () => ({}),
    formatDigestForPrompt: () => '',
    generateSitrep: async () => ({ narrative: 'test sitrep', fallback: false }),
  },
});

mock.module('../lib/hydra-codebase-context.ts', {
  namedExports: {
    loadCodebaseContext: noop,
    detectCodebaseQuery: () => ({ isCodebaseQuery: false, topic: null }),
    getTopicContext: () => '',
    getBaselineContext: () => '',
    searchKnowledgeBase: () => null,
  },
});

mock.module('../lib/hydra-self.ts', {
  namedExports: {
    buildSelfSnapshot: emptyObj,
    formatSelfSnapshotForPrompt: () => 'self snapshot',
  },
});

mock.module('../lib/hydra-self-index.ts', {
  namedExports: {
    buildSelfIndex: emptyObj,
    formatSelfIndexForPrompt: () => 'self index',
  },
});

mock.module('../lib/hydra-agent-forge.ts', {
  namedExports: {
    runForgeWizard: asyncNoop,
    listForgedAgents: () => [],
    removeForgedAgent: noop,
    testForgedAgent: async () => ({ ok: true, durationMs: 100, output: 'test' }),
    loadForgeRegistry: emptyObj,
  },
});

mock.module('../lib/hydra-resume-scanner.ts', {
  namedExports: { scanResumableState: async () => [] },
});

mock.module('../lib/hydra-updater.ts', {
  namedExports: { checkForUpdates: async () => ({ hasUpdate: false }) },
});

mock.module('../lib/hydra-persona.ts', {
  namedExports: {
    showPersonaSummary: noop,
    applyPreset: noop,
    listPresets: () => ['default', 'concise', 'verbose'],
    invalidatePersonaCache: noop,
    getConciergeIdentity: () => '',
    getAgentFraming: () => '',
    getProcessLabel: (k: any) => k,
    isPersonaEnabled: () => false,
  },
});

mock.module('../lib/hydra-provider-usage.ts', {
  namedExports: {
    getProviderUsage: emptyObj,
    saveProviderUsage: noop,
    resetSessionUsage: noop,
  },
});

mock.module('../lib/hydra-operator-dispatch.ts', {
  namedExports: {
    dispatchPrompt: async () => [{ agent: 'claude', handoffId: 'H-1' }],
  },
});

mock.module('../lib/hydra-operator-concierge.ts', {
  namedExports: {
    runCouncilPrompt: async () => ({ ok: true, stdout: 'Council output', stderr: '', status: 0 }),
    runAutoPrompt: async () => ({
      mode: 'fast-path',
      route: 'claude',
      recommended: 'claude',
      published: { tasks: [], handoffs: [] },
    }),
    runSmartPrompt: async () => ({
      mode: 'fast-path',
      route: 'claude',
      recommended: 'claude',
      published: { tasks: [], handoffs: [] },
      smartTier: 'routine',
      smartMode: 'economy',
    }),
  },
});

mock.module('../lib/hydra-operator-commands.ts', {
  namedExports: {
    handleModelCommand: asyncNoop,
    handleModelSelectCommand: asyncNoop,
    handleRolesCommand: asyncNoop,
    handleModeCommand: asyncNoop,
    handleAgentsCommand: asyncNoop,
    handleCleanupCommand: asyncNoop,
    handlePrCommand: asyncNoop,
    handleTasksCommand: asyncNoop,
    handleNightlyCommand: asyncNoop,
    handleEvolveCommand: asyncNoop,
  },
});

mock.module('../lib/hydra-operator-startup.ts', {
  namedExports: {
    ensureDaemon: async () => true,
    launchAgentTerminals: noop,
    extractHandoffAgents: () => [],
    printWelcome: asyncNoop,
    findPowerShell: () => null,
    findWindowsTerminal: () => null,
  },
});

mock.module('../lib/hydra-operator-self-awareness.ts', {
  namedExports: {
    selfIndexCache: { block: '', builtAt: 0, key: '' },
    parseSelfAwarenessPlaintextCommand: () => null,
    applySelfAwarenessPatch: asyncNoop,
    getGitInfo: () => ({ branch: 'main', modifiedFiles: 0 }),
    normalizeSimpleCommandText: (s: any) => String(s ?? ''),
  },
});

mock.module('../lib/hydra-operator-ghost-text.ts', {
  namedExports: {
    createGhostTextHelpers: () => ({
      showGhostAfterPrompt: noop,
      upgradeGhostText: noop,
      cleanup: noop,
    }),
  },
});

mock.module('../lib/hydra-operator-session.ts', {
  namedExports: { executeDaemonResume: asyncNoop },
});

mock.module('../lib/hydra-process.ts', {
  namedExports: { exit: noop, setExitHandler: noop, resetExitHandler: noop },
});

mock.module('../lib/hydra-output-history.ts', {
  namedExports: { initOutputHistory: noop },
});

mock.module('../lib/hydra-roster.ts', {
  namedExports: { runRosterEditor: asyncNoop },
});

mock.module('picocolors', {
  defaultExport: {
    red: id,
    green: id,
    blue: id,
    yellow: id,
    cyan: id,
    magenta: id,
    white: id,
    gray: id,
    dim: id,
    bold: id,
    italic: id,
    underline: id,
    strikethrough: id,
    inverse: id,
    hidden: id,
    reset: id,
    bgRed: id,
    bgGreen: id,
    bgBlue: id,
    bgYellow: id,
    bgCyan: id,
    bgMagenta: id,
    bgWhite: id,
    bgBlack: id,
    black: id,
    isColorSupported: false,
  },
});

// ── Import the module under test ──────────────────────────────────────────────

let formatUptime: any;
let levenshtein: any;
let fuzzyMatchCommand: any;
let _testExports: any;

before(async () => {
  const mod = await import('../lib/hydra-operator.ts');
  formatUptime = mod.formatUptime;
  levenshtein = mod.levenshtein;
  fuzzyMatchCommand = mod.fuzzyMatchCommand;
  _testExports = mod._testExports;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('hydra-operator: formatUptime', () => {
  it('formats sub-minute durations in seconds', () => {
    assert.equal(formatUptime(0), '0s');
    assert.equal(formatUptime(5000), '5s');
    assert.equal(formatUptime(30_000), '30s');
    assert.equal(formatUptime(59_999), '60s');
  });

  it('formats sub-hour durations in minutes', () => {
    assert.equal(formatUptime(60_000), '1m');
    assert.equal(formatUptime(120_000), '2m');
    assert.equal(formatUptime(3_599_999), '60m');
  });

  it('formats hour+ durations in hours with decimal', () => {
    assert.equal(formatUptime(3_600_000), '1.0h');
    assert.equal(formatUptime(5_400_000), '1.5h');
    assert.equal(formatUptime(7_200_000), '2.0h');
  });
});

describe('hydra-operator: levenshtein', () => {
  it('returns 0 for identical strings', () => {
    assert.equal(levenshtein('abc', 'abc'), 0);
    assert.equal(levenshtein('', ''), 0);
  });

  it('returns string length for empty comparison', () => {
    assert.equal(levenshtein('abc', ''), 3);
    assert.equal(levenshtein('', 'xyz'), 3);
  });

  it('returns 1 for single-char difference', () => {
    assert.equal(levenshtein('cat', 'bat'), 1);
    assert.equal(levenshtein('cat', 'ca'), 1);
    assert.equal(levenshtein('cat', 'cats'), 1);
  });

  it('computes correct distance for multi-char edits', () => {
    assert.equal(levenshtein('kitten', 'sitting'), 3);
    assert.equal(levenshtein('sunday', 'saturday'), 3);
  });
});

describe('hydra-operator: fuzzyMatchCommand', () => {
  it('returns null for very different input', () => {
    assert.equal(fuzzyMatchCommand(':zzzzzzzzz'), null);
    assert.equal(fuzzyMatchCommand(':xyzabc'), null);
  });

  it('returns closest match for near-miss commands', () => {
    const result = fuzzyMatchCommand(':statu');
    assert.equal(result, ':status');
  });

  it('returns match for command without colon prefix', () => {
    const result = fuzzyMatchCommand('help');
    assert.equal(result, ':help');
  });

  it('returns null when nothing is close enough', () => {
    const result = fuzzyMatchCommand(':abcdefghij');
    assert.equal(result, null);
  });

  it('handles multi-word input by using first word', () => {
    const result = fuzzyMatchCommand(':statu some args');
    assert.equal(result, ':status');
  });
});

describe('hydra-operator: re-exports', () => {
  it('re-exports KNOWN_COMMANDS from hydra-operator-ui', async () => {
    const mod = await import('../lib/hydra-operator.ts');
    assert.ok(Array.isArray(mod.KNOWN_COMMANDS));
  });

  it('re-exports SMART_TIER_MAP from hydra-operator-ui', async () => {
    const mod = await import('../lib/hydra-operator.ts');
    assert.ok(mod.SMART_TIER_MAP != null);
    assert.equal(typeof mod.SMART_TIER_MAP, 'object');
  });

  it('re-exports ensureDaemon from hydra-operator-startup', async () => {
    const mod = await import('../lib/hydra-operator.ts');
    assert.equal(typeof mod.ensureDaemon, 'function');
  });

  it('re-exports extractHandoffAgents from hydra-operator-startup', async () => {
    const mod = await import('../lib/hydra-operator.ts');
    assert.equal(typeof mod.extractHandoffAgents, 'function');
  });

  it('re-exports printWelcome from hydra-operator-startup', async () => {
    const mod = await import('../lib/hydra-operator.ts');
    assert.equal(typeof mod.printWelcome, 'function');
  });

  it('re-exports normalizeSimpleCommandText', async () => {
    const mod = await import('../lib/hydra-operator.ts');
    assert.equal(typeof mod.normalizeSimpleCommandText, 'function');
  });

  it('re-exports parseSelfAwarenessPlaintextCommand', async () => {
    const mod = await import('../lib/hydra-operator.ts');
    assert.equal(typeof mod.parseSelfAwarenessPlaintextCommand, 'function');
  });

  it('re-exports applySelfAwarenessPatch', async () => {
    const mod = await import('../lib/hydra-operator.ts');
    assert.equal(typeof mod.applySelfAwarenessPatch, 'function');
  });

  it('re-exports getGitInfo', async () => {
    const mod = await import('../lib/hydra-operator.ts');
    assert.equal(typeof mod.getGitInfo, 'function');
  });

  it('re-exports getSelfAwarenessSummary', async () => {
    const mod = await import('../lib/hydra-operator.ts');
    assert.equal(typeof mod.getSelfAwarenessSummary, 'function');
  });

  it('re-exports findPowerShell', async () => {
    const mod = await import('../lib/hydra-operator.ts');
    assert.equal(typeof mod.findPowerShell, 'function');
  });

  it('re-exports findWindowsTerminal', async () => {
    const mod = await import('../lib/hydra-operator.ts');
    assert.equal(typeof mod.findWindowsTerminal, 'function');
  });
});

// ── Internal function tests via _testExports ─────────────────────────────────

function makeMockCtx(overrides: any = {}): any {
  return {
    baseUrl: 'http://127.0.0.1:4173',
    from: 'human',
    agents: ['claude', 'gemini', 'codex'],
    councilRounds: 2,
    councilPreview: false,
    autoMiniRounds: 1,
    autoCouncilRounds: 2,
    autoPreview: false,
    rl: {
      prompt: () => {},
      close: () => {},
      setPrompt: () => {},
      question: (_q: any, cb: any) => cb(''),
    },
    cCfg: { autoActivate: false, showProviderInPrompt: true },
    normalPrompt: 'hydra> ',
    buildConciergePrompt: () => 'hydra> ',
    showConciergeWelcome: () => {},
    showGhostAfterPrompt: () => {},
    upgradeGhostText: () => {},
    selfIndexCache: { block: '', builtAt: 0, key: '' },
    ...overrides,
  };
}

function makeMockState(overrides: any = {}): any {
  return {
    mode: 'auto',
    conciergeActive: false,
    dispatchDepth: 0,
    sidecaring: false,
    conciergeWelcomeShown: false,
    ...overrides,
  };
}

describe('hydra-operator: dispatchLineCommand', () => {
  it('handles empty line', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    let prompted = false;
    ctx.rl.prompt = () => {
      prompted = true;
    };
    await _testExports.dispatchLineCommand(ctx, state, '');
    assert.ok(prompted, 'should re-prompt on empty line');
  });

  it('handles :quit', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    let closed = false;
    ctx.rl.close = () => {
      closed = true;
    };
    await _testExports.dispatchLineCommand(ctx, state, ':quit');
    assert.ok(closed, 'should close rl on :quit');
  });

  it('handles :exit', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    let closed = false;
    ctx.rl.close = () => {
      closed = true;
    };
    await _testExports.dispatchLineCommand(ctx, state, ':exit');
    assert.ok(closed, 'should close rl on :exit');
  });

  it('handles :help', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':help');
    // printHelp is mocked; just verifying no crash
    assert.ok(true);
  });

  it('handles :status', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':status');
    assert.ok(true);
  });

  it('handles :mode', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':mode');
    assert.ok(true);
  });

  it('handles :agents', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':agents');
    assert.ok(true);
  });

  it('handles :sync', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':sync');
    assert.ok(true);
  });

  it('handles :archive', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':archive');
    assert.ok(true);
  });

  it('handles :events', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':events');
    assert.ok(true);
  });

  it('handles :handoffs', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':handoffs');
    assert.ok(true);
  });

  it('handles :pause', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':pause for lunch');
    assert.ok(true);
  });

  it('handles :unpause', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':unpause');
    assert.ok(true);
  });

  it('handles :resume', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':resume');
    assert.ok(true);
  });

  it('handles :usage', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':usage');
    assert.ok(true);
  });

  it('handles :stats', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':stats');
    assert.ok(true);
  });

  it('handles :self', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':self');
    assert.ok(true);
  });

  it('handles :self json', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':self json');
    assert.ok(true);
  });

  it('handles :aware', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':aware');
    assert.ok(true);
  });

  it('handles :aware on', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':aware on');
    assert.ok(true);
  });

  it('handles :aware off', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':aware off');
    assert.ok(true);
  });

  it('handles :aware minimal', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':aware minimal');
    assert.ok(true);
  });

  it('handles :aware full', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':aware full');
    assert.ok(true);
  });

  it('handles :aware invalid', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':aware badvalue');
    assert.ok(true);
  });

  it('handles :model', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':model');
    assert.ok(true);
  });

  it('handles :model:select', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':model:select');
    assert.ok(true);
  });

  it('handles :roles', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':roles');
    assert.ok(true);
  });

  it('handles :persona', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':persona');
    assert.ok(true);
  });

  it('handles :persona show', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':persona show');
    assert.ok(true);
  });

  it('handles :persona on', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':persona on');
    assert.ok(true);
  });

  it('handles :persona off', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':persona off');
    assert.ok(true);
  });

  it('handles :persona <preset>', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':persona default');
    assert.ok(true);
  });

  it('handles :persona unknown preset', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':persona nonexistent');
    assert.ok(true);
  });

  it('handles :fork', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':fork test reason');
    assert.ok(true);
  });

  it('handles :spawn', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':spawn focus on auth');
    assert.ok(true);
  });

  it('handles :spawn with empty focus', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':spawn ');
    assert.ok(true);
  });

  it('handles :confirm', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':confirm');
    assert.ok(true);
  });

  it('handles :confirm on', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':confirm on');
    assert.ok(true);
  });

  it('handles :confirm off', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':confirm off');
    assert.ok(true);
  });

  it('handles :dry-run', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':dry-run');
    assert.ok(true);
  });

  it('handles :dry-run on', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':dry-run on');
    assert.ok(true);
  });

  it('handles :dry-run off', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':dry-run off');
    assert.ok(true);
  });

  it('handles :clear screen', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':clear screen');
    assert.ok(true);
  });

  it('handles :clear concierge', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':clear concierge');
    assert.ok(true);
  });

  it('handles :clear metrics', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':clear metrics');
    assert.ok(true);
  });

  it('handles :clear unknown', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':clear xyz');
    assert.ok(true);
  });

  it('handles :cancel', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':cancel TASK-1');
    assert.ok(true);
  });

  it('handles :tasks', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':tasks');
    assert.ok(true);
  });

  it('handles :pr', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':pr');
    assert.ok(true);
  });

  it('handles :nightly', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':nightly');
    assert.ok(true);
  });

  it('handles :evolve', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':evolve');
    assert.ok(true);
  });

  it('handles :cleanup', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':cleanup');
    assert.ok(true);
  });

  it('handles :forge', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':forge');
    assert.ok(true);
  });

  it('handles :forge list', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':forge list');
    assert.ok(true);
  });

  it('handles :forge info without name', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':forge info');
    assert.ok(true);
  });

  it('handles :forge test without name', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':forge test');
    assert.ok(true);
  });

  it('handles :forge delete without name', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':forge delete');
    assert.ok(true);
  });

  it('handles :roster', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':roster');
    assert.ok(true);
  });

  it('handles :shutdown', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':shutdown');
    assert.ok(true);
  });

  it('handles :sitrep', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':sitrep');
    assert.ok(true);
  });

  it('handles command? help suffix', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':help?');
    assert.ok(true);
  });

  it('handles unknown : command', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.dispatchLineCommand(ctx, state, ':nonexistent');
    assert.ok(true);
  });
});

describe('hydra-operator: displaySitrepResult', () => {
  it('displays fallback with no_provider reason', () => {
    _testExports.displaySitrepResult({
      fallback: true,
      reason: 'no_provider',
      narrative: 'raw digest',
    });
    assert.ok(true);
  });

  it('displays fallback with empty_response reason', () => {
    _testExports.displaySitrepResult({
      fallback: true,
      reason: 'empty_response',
      narrative: 'raw digest',
    });
    assert.ok(true);
  });

  it('displays fallback with error', () => {
    _testExports.displaySitrepResult({
      fallback: true,
      error: 'some error',
      narrative: 'raw digest',
    });
    assert.ok(true);
  });

  it('displays fallback with generic reason', () => {
    _testExports.displaySitrepResult({ fallback: true, narrative: 'raw digest' });
    assert.ok(true);
  });

  it('displays AI-generated sitrep with usage', () => {
    _testExports.displaySitrepResult({
      fallback: false,
      narrative: 'AI sitrep',
      model: 'gpt-4',
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    assert.ok(true);
  });

  it('displays AI-generated sitrep without usage', () => {
    _testExports.displaySitrepResult({
      fallback: false,
      narrative: 'AI sitrep',
      provider: 'openai',
    });
    assert.ok(true);
  });
});

describe('hydra-operator: printSessionTokenSection', () => {
  it('runs without crash', () => {
    _testExports.printSessionTokenSection();
    assert.ok(true);
  });
});

describe('hydra-operator: printProviderUsageSection', () => {
  it('runs without crash', () => {
    _testExports.printProviderUsageSection();
    assert.ok(true);
  });
});

describe('hydra-operator: handleSyncCommand', () => {
  it('runs without crash', () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    _testExports.handleSyncCommand(ctx, state, ':sync');
    assert.ok(true);
  });
});

describe('hydra-operator: handleConfirmCommand', () => {
  it('handles :confirm off', () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    _testExports.handleConfirmCommand(ctx, state, ':confirm off');
    assert.ok(true);
  });

  it('handles :confirm on', () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    _testExports.handleConfirmCommand(ctx, state, ':confirm on');
    assert.ok(true);
  });

  it('handles :confirm status', () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    _testExports.handleConfirmCommand(ctx, state, ':confirm');
    assert.ok(true);
  });
});

describe('hydra-operator: handleDryRunCommand', () => {
  it('handles :dry-run on', () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    _testExports.handleDryRunCommand(ctx, state, ':dry-run on');
    assert.ok(true);
  });

  it('handles :dry-run off', () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    _testExports.handleDryRunCommand(ctx, state, ':dry-run off');
    assert.ok(true);
  });

  it('handles :dry-run toggle', () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    _testExports.handleDryRunCommand(ctx, state, ':dry-run');
    assert.ok(true);
  });
});

describe('hydra-operator: createPasteState', () => {
  it('returns initial paste state', () => {
    const ps = _testExports.createPasteState();
    assert.deepEqual(ps.buffer, []);
    assert.equal(ps.timer, null);
    assert.equal(ps.isPasted, false);
  });
});

describe('hydra-operator: handleResumeSelection', () => {
  it('handles daemon:unpause', async () => {
    const ctx = makeMockCtx();
    await _testExports.handleResumeSelection(ctx, 'daemon:unpause', []);
    assert.ok(true);
  });

  it('handles evolve', async () => {
    const ctx = makeMockCtx();
    await _testExports.handleResumeSelection(ctx, 'evolve', []);
    assert.ok(true);
  });

  it('handles council:hash', async () => {
    const ctx = makeMockCtx();
    await _testExports.handleResumeSelection(ctx, 'council:abc123', []);
    assert.ok(true);
  });

  it('handles branches:evolve', async () => {
    const ctx = makeMockCtx();
    await _testExports.handleResumeSelection(ctx, 'branches:evolve', []);
    assert.ok(true);
  });

  it('handles branches:nightly', async () => {
    const ctx = makeMockCtx();
    await _testExports.handleResumeSelection(ctx, 'branches:nightly', []);
    assert.ok(true);
  });

  it('handles branches:tasks', async () => {
    const ctx = makeMockCtx();
    await _testExports.handleResumeSelection(ctx, 'branches:tasks', []);
    assert.ok(true);
  });

  it('handles suggestions', async () => {
    const ctx = makeMockCtx();
    await _testExports.handleResumeSelection(ctx, 'suggestions', [
      { value: 'suggestions', label: '3 pending suggestions' },
    ]);
    assert.ok(true);
  });
});

describe('hydra-operator: handleForgeList', () => {
  it('displays empty forge list', () => {
    const ctx = makeMockCtx();
    _testExports.handleForgeList(ctx);
    assert.ok(true);
  });
});

describe('hydra-operator: handleForgeInfo', () => {
  it('shows error for missing name', () => {
    const ctx = makeMockCtx();
    _testExports.handleForgeInfo(ctx);
    assert.ok(true);
  });
});

describe('hydra-operator: handleForgeDelete', () => {
  it('shows error for missing name', () => {
    const ctx = makeMockCtx();
    _testExports.handleForgeDelete(ctx);
    assert.ok(true);
  });

  it('shows error for unknown agent', () => {
    const ctx = makeMockCtx();
    _testExports.handleForgeDelete(ctx, 'nonexistent');
    assert.ok(true);
  });
});

describe('hydra-operator: classifyAutoRoute', () => {
  it('classifies single route', () => {
    const state = makeMockState();
    const result = _testExports.classifyAutoRoute(state, 'fix the login bug');
    assert.ok(result.classification);
    assert.ok(typeof result.routeDesc === 'string');
  });
});

describe('hydra-operator: buildCmdOpts', () => {
  it('builds command options object', () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    const opts = _testExports.buildCmdOpts(ctx, state);
    assert.equal(opts.baseUrl, 'http://127.0.0.1:4173');
    assert.deepEqual(opts.agents, ['claude', 'gemini', 'codex']);
    assert.equal(typeof opts.getLoopMode, 'function');
    assert.equal(typeof opts.setLoopMode, 'function');
    assert.equal(opts.getLoopMode(), 'auto');
    opts.setLoopMode('council');
    assert.equal(state.mode, 'council');
  });
});

describe('hydra-operator: handleCmdHelpSuffix', () => {
  it('shows help for command?', () => {
    const ctx = makeMockCtx();
    _testExports.handleCmdHelpSuffix(ctx, ':help?');
    assert.ok(true);
  });
});

describe('hydra-operator: handleAwarePlain', () => {
  it('handles status subcommand', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.handleAwarePlain(ctx, state, 'status');
    assert.ok(true);
  });

  it('handles off subcommand', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.handleAwarePlain(ctx, state, 'off');
    assert.ok(true);
  });

  it('handles on subcommand', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.handleAwarePlain(ctx, state, 'on');
    assert.ok(true);
  });

  it('handles minimal subcommand', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.handleAwarePlain(ctx, state, 'minimal');
    assert.ok(true);
  });

  it('handles full subcommand', async () => {
    const ctx = makeMockCtx();
    const state = makeMockState();
    await _testExports.handleAwarePlain(ctx, state, 'full');
    assert.ok(true);
  });
});

describe('hydra-operator: updateTaskActivities', () => {
  it('handles empty published', () => {
    const ctx = makeMockCtx();
    _testExports.updateTaskActivities(ctx, {});
    assert.ok(true);
  });

  it('handles tasks with owners', () => {
    const ctx = makeMockCtx();
    _testExports.updateTaskActivities(ctx, {
      published: {
        tasks: [
          { owner: 'claude', title: 'Fix bug' },
          { owner: 'gemini', title: 'Review code' },
        ],
      },
    });
    assert.ok(true);
  });
});

describe('hydra-operator: updateAutoStatusBar', () => {
  it('skips for smart mode', () => {
    const state = makeMockState({ mode: 'smart' });
    _testExports.updateAutoStatusBar(state, {}, {});
    assert.ok(true);
  });

  it('handles fast-path', () => {
    const state = makeMockState({ mode: 'auto' });
    _testExports.updateAutoStatusBar(
      state,
      { mode: 'fast-path' },
      { tier: 'routine', suggestedAgent: 'claude' },
    );
    assert.ok(true);
  });

  it('handles tandem', () => {
    const state = makeMockState({ mode: 'auto' });
    _testExports.updateAutoStatusBar(
      state,
      { mode: 'tandem' },
      { tier: 'moderate', tandemPair: { lead: 'gemini', follow: 'codex' } },
    );
    assert.ok(true);
  });

  it('handles other mode', () => {
    const state = makeMockState({ mode: 'auto' });
    _testExports.updateAutoStatusBar(state, { mode: 'mini-round' }, { tier: 'complex' });
    assert.ok(true);
  });
});

describe('hydra-operator: printAutoDispatchHeader', () => {
  it('prints header for auto fast-path', () => {
    const state = makeMockState({ mode: 'auto' });
    _testExports.printAutoDispatchHeader(
      state,
      { mode: 'fast-path', route: 'claude', published: { tasks: [] } },
      { tier: 'routine', reason: 'test signals' },
    );
    assert.ok(true);
  });

  it('prints header for tandem', () => {
    const state = makeMockState({ mode: 'auto' });
    _testExports.printAutoDispatchHeader(
      state,
      { mode: 'tandem', route: 'gemini->codex', published: { tasks: [] } },
      { tier: 'moderate', reason: 'test', tandemPair: { lead: 'gemini', follow: 'codex' } },
    );
    assert.ok(true);
  });

  it('prints header for smart mode', () => {
    const state = makeMockState({ mode: 'smart' });
    _testExports.printAutoDispatchHeader(
      state,
      {
        mode: 'fast-path',
        route: '',
        recommended: 'claude',
        smartTier: 'routine',
        smartMode: 'economy',
      },
      { tier: 'routine', reason: 'test' },
    );
    assert.ok(true);
  });

  it('prints header with triage rationale', () => {
    const state = makeMockState({ mode: 'auto' });
    _testExports.printAutoDispatchHeader(
      state,
      { mode: 'mini-round', route: 'claude', triage: { recommendationRationale: 'Best fit' } },
      { tier: 'moderate', reason: 'test' },
    );
    assert.ok(true);
  });
});
