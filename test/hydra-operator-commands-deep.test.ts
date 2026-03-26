/**
 * Deep coverage tests for hydra-operator-commands.ts
 *
 * Uses module-level mocking to replace all I/O dependencies,
 * then exercises each exported command handler.
 *
 * Run: node --test --experimental-test-module-mocks test/hydra-operator-commands-deep.test.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- test file uses dynamic mocks */

import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Suppress console output to prevent IPC serialization errors in CI ────────
// Node's test runner serializes worker output across IPC; complex objects from
// mocked modules can trigger "Unable to deserialize cloned data" errors.
const _origLog = console.log;
const _origWarn = console.warn;
const _origError = console.error;
console.log = () => {};
console.warn = () => {};
console.error = () => {};

// ── Mock state ──────────────────────────────────────────────────────────────

const mockRequest = mock.fn(async (): Promise<any> => ({ state: { tasks: [] } }));
const mockLoadConfig = mock.fn((): any => ({
  routing: { mode: 'balanced' },
  roles: {
    coordinator: { agent: 'claude', model: null },
    critic: { agent: 'gemini', model: null },
  },
  recommendations: {},
  agents: { customAgents: [] },
  nightly: { baseBranch: 'dev', maxTasks: 5, maxHours: 4, sources: {} },
  evolve: { baseBranch: 'dev' },
}));
const mockSaveConfig = mock.fn((): any => mockLoadConfig());
const mockGetAgent = mock.fn((name: string): any => ({
  name,
  label: name,
  displayName: name,
  type: 'physical',
  enabled: true,
  baseAgent: null,
  councilRole: null,
  strengths: ['coding'],
  tags: ['test'],
  taskAffinity: { refactor: 0.8 },
  rolePrompt: 'You are a test agent.\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7',
  cli: '/usr/bin/test',
}));
const mockGetActiveModel = mock.fn((): any => 'test-model');
const mockGetModelSummary = mock.fn((): any => ({
  _mode: 'balanced',
  claude: { active: 'claude-4', isOverride: false, tierSource: 'balanced', reasoningEffort: null },
  gemini: { active: 'gemini-3', isOverride: true, tierSource: 'balanced', reasoningEffort: 'high' },
}));
const mockSetActiveModel = mock.fn((): any => 'new-model');
const mockResetAgentModel = mock.fn((): any => 'default-model');
const mockGetMode = mock.fn((): any => 'balanced');
const mockSetMode = mock.fn();
const mockListAgents = mock.fn((opts?: { type?: string }): any => {
  if (opts?.type === 'virtual') return [];
  if (opts?.type === 'physical')
    return [
      { name: 'claude', label: 'Claude', displayName: 'Claude', type: 'physical', enabled: true },
    ];
  return [
    { name: 'claude', label: 'Claude', displayName: 'Claude', type: 'physical', enabled: true },
  ];
});
const mockFormatEffortDisplay = mock.fn(() => '');
const mockSetAgentEnabled = mock.fn();
const mockIsGhAvailable = mock.fn((): any => true);
const mockListPRs = mock.fn((): any => [
  { number: 1, title: 'Test PR', headRefName: 'feat/test', author: 'user' },
]);
const mockGetPR = mock.fn((): any => ({
  number: 1,
  title: 'Test PR',
  state: 'OPEN',
  headRefName: 'feat/test',
  baseRefName: 'main',
  author: { login: 'user' },
  additions: 10,
  deletions: 5,
  url: 'https://github.com/test/test/pull/1',
}));
const mockPushBranchAndCreatePR = mock.fn((): any => ({
  ok: true,
  url: 'https://github.com/test/test/pull/2',
}));
const mockSetActiveMode = mock.fn();
const mockPromptChoice = mock.fn(
  async (): Promise<any> => ({ value: true, autoAcceptAll: false, timedOut: false }),
);
const mockFormatConflictWorktrees = mock.fn((): any => []);
const mockSpawnHydraNode = mock.fn((): any => {
  const listeners: Record<string, ((...args: any[]) => void)[]> = {};
  const child = {
    on(event: string, cb: (...args: any[]) => void) {
      listeners[event] = listeners[event] || [];
      listeners[event].push(cb);
      // Auto-fire close events so handlers resolve
      if (event === 'close') {
        setTimeout(() => {
          cb(0);
        }, 5);
      }
      return child;
    },
    removeAllListeners() {
      return child;
    },
  };
  return child;
});
const mockSpawnHydraNodeSync = mock.fn((): any => ({ status: 0, stdout: '', stderr: '' }));
const mockExecuteAgent = mock.fn(
  async (): Promise<any> => ({
    ok: true,
    output: 'hello',
    stderr: '',
    errorCategory: null,
  }),
);

// ── Module mocks ────────────────────────────────────────────────────────────

mock.module('../lib/hydra-utils.ts', {
  namedExports: {
    request: mockRequest,
    nowIso: () => '2026-01-01T00:00:00Z',
    runId: () => 'TEST-RUN-001',
    parseArgs: () => ({ options: {}, positionals: [] }),
    getPrompt: () => 'test prompt',
    boolFlag: (_v: unknown, fb: boolean) => fb,
    short: (_t: unknown) => String(_t).slice(0, 100),
    parseJsonLoose: (_t: unknown) => null,
    ensureDir: () => {},
  },
});

mock.module('../lib/hydra-agents.ts', {
  namedExports: {
    getAgent: mockGetAgent,
    AGENT_NAMES: ['claude', 'gemini', 'codex'],
    getActiveModel: mockGetActiveModel,
    getModelSummary: mockGetModelSummary,
    setActiveModel: mockSetActiveModel,
    resetAgentModel: mockResetAgentModel,
    getMode: mockGetMode,
    setMode: mockSetMode,
    listAgents: mockListAgents,
    formatEffortDisplay: mockFormatEffortDisplay,
    setAgentEnabled: mockSetAgentEnabled,
    AGENT_TYPE: { PHYSICAL: 'physical', VIRTUAL: 'virtual' },
    AGENT_DISPLAY_ORDER: ['gemini', 'codex', 'claude'],
    KNOWN_OWNERS: new Set(['claude', 'gemini', 'codex']),
    registerAgent: mock.fn(),
    unregisterAgent: mock.fn(),
    resolvePhysicalAgent: mock.fn(),
    getPhysicalAgentNames: () => ['claude', 'gemini', 'codex'],
    getAllAgentNames: () => ['claude', 'gemini', 'codex'],
    bestAgentFor: () => 'claude',
    classifyTask: () => 'refactor',
    getVerifier: () => 'gemini',
    initAgentRegistry: mock.fn(),
    invalidateAffinityCache: mock.fn(),
    recordTaskOutcome: mock.fn(),
    TASK_TYPES: ['refactor'],
    AGENTS: {},
  },
});

mock.module('../lib/hydra-shared/agent-executor.ts', {
  namedExports: {
    DefaultAgentExecutor: class {
      executeAgent = mockExecuteAgent;
    },
  },
});

mock.module('../lib/hydra-config.ts', {
  namedExports: {
    loadHydraConfig: mockLoadConfig,
    saveHydraConfig: mockSaveConfig,
    invalidateConfigCache: mock.fn(),
    resolveProject: () => ({
      projectRoot: '/tmp/test-project',
      projectName: 'test-project',
      runsDir: '/tmp/test-project/runs',
    }),
    getRoleConfig: () => ({ agent: 'claude', model: null }),
    getProviderPresets: () => [],
    HYDRA_ROOT: '/tmp/hydra',
    configStore: { get: mockLoadConfig, save: mockSaveConfig },
    _setTestConfigPath: mock.fn(),
    _setTestConfig: mock.fn(),
    diffConfig: mock.fn(),
    getProviderTier: () => 1,
    AFFINITY_PRESETS: {},
  },
});

mock.module('../lib/hydra-ui.ts', {
  namedExports: {
    sectionHeader: (t: string) => `--- ${t} ---`,
    label: (k: string, v?: string | number | boolean) => `${k}: ${String(v ?? '')}`,
    colorAgent: (n: string) => n,
    ACCENT: (s: string) => s,
    DIM: (s: string) => s,
    SUCCESS: (s: string) => s,
    ERROR: (s: string) => s,
    WARNING: (s: string) => s,
    box: () => '',
    stripAnsi: (s: string) => s,
    createSpinner: () => ({
      start: mock.fn(),
      succeed: mock.fn(),
      fail: mock.fn(),
      stop: mock.fn(),
    }),
    isTruecolor: false,
    AGENT_COLORS: {},
    AGENT_ICONS: {},
    HIGHLIGHT: (s: string) => s,
    hydraSplash: () => '',
    hydraLogoCompact: () => '',
    getAgentColor: () => (s: string) => s,
    getAgentIcon: () => '',
  },
});

mock.module('../lib/hydra-statusbar.ts', {
  namedExports: {
    setActiveMode: mockSetActiveMode,
    setAgentActivity: mock.fn(),
    setAgentExecMode: mock.fn(),
    getAgentExecMode: mock.fn(),
    getAgentActivity: mock.fn(),
    onActivityEvent: mock.fn(),
    setDispatchContext: mock.fn(),
    clearDispatchContext: mock.fn(),
    setLastDispatch: mock.fn(),
    updateTaskCount: mock.fn(),
  },
});

mock.module('../lib/hydra-prompt-choice.ts', {
  namedExports: {
    promptChoice: mockPromptChoice,
    confirmActionPlan: mock.fn(async () => true),
    isAutoAccepting: () => false,
    setAutoAccept: mock.fn(),
    resetAutoAccept: mock.fn(),
    isChoiceActive: () => false,
    parseMultiSelectInput: () => null,
  },
});

mock.module('../lib/hydra-github.ts', {
  namedExports: {
    isGhAvailable: mockIsGhAvailable,
    listPRs: mockListPRs,
    getPR: mockGetPR,
    pushBranchAndCreatePR: mockPushBranchAndCreatePR,
    gh: mock.fn(),
    isGhAuthenticated: () => true,
    detectRepo: () => null,
    createPR: mock.fn(),
    mergePR: mock.fn(),
    closePR: mock.fn(),
    listIssues: mock.fn(),
  },
});

mock.module('../lib/hydra-worktree-conflicts.ts', {
  namedExports: {
    formatConflictWorktrees: mockFormatConflictWorktrees,
  },
});

mock.module('../lib/hydra-exec-spawn.ts', {
  namedExports: {
    spawnHydraNode: mockSpawnHydraNode,
    spawnHydraNodeSync: mockSpawnHydraNodeSync,
    HYDRA_EMBEDDED_ROOT: '/tmp/hydra',
    HYDRA_STANDALONE: false,
    HYDRA_INTERNAL_FLAG: '--hydra-internal',
    toHydraModuleId: mock.fn(),
    rewriteNodeInvocation: mock.fn(),
  },
});

mock.module('node:child_process', {
  namedExports: {
    spawnSync: mock.fn((_cmd: string, _args: string[], _opts?: Record<string, unknown>) => ({
      status: 0,
      stdout: 'main',
      stderr: '',
      output: ['', 'main', ''],
    })),
    spawn: mock.fn(),
    exec: mock.fn(),
    execSync: mock.fn(() => ''),
    execFile: mock.fn(),
    fork: mock.fn(),
  },
});

mock.module('picocolors', {
  defaultExport: {
    bold: (s: string) => s,
    white: (s: string) => s,
    yellow: (s: string) => s,
    red: (s: string) => s,
    green: (s: string) => s,
    gray: (s: string) => s,
    cyan: (s: string) => s,
    magenta: (s: string) => s,
    dim: (s: string) => s,
  },
});

// ── Import target after mocking ─────────────────────────────────────────────

const {
  handleModelCommand,
  handleModelSelectCommand,
  handleRolesCommand,
  handleModeCommand,
  handleTasksCommand,
  handleAgentsCommand,
  handleCleanupCommand,
  handlePrCommand,
  handleNightlyCommand,
  handleEvolveCommand,
} = await import('../lib/hydra-operator-commands.ts');

// ── Test helpers ────────────────────────────────────────────────────────────

function makeCtx(overrides: Record<string, unknown> = {}): any {
  return {
    baseUrl: 'http://127.0.0.1:4173',
    agents: ['claude', 'gemini', 'codex'],
    config: { projectRoot: '/tmp/test-project', projectName: 'test-project' },
    rl: {
      prompt: mock.fn(),
      pause: mock.fn(),
      resume: mock.fn(),
      on: mock.fn(),
      removeAllListeners: mock.fn(),
      listeners: () => [],
      setPrompt: mock.fn(),
    },
    HYDRA_ROOT: '/tmp/hydra',
    getLoopMode: mock.fn(() => 'auto'),
    setLoopMode: mock.fn(),
    initStatusBar: mock.fn(),
    destroyStatusBar: mock.fn(),
    drawStatusBar: mock.fn(),
    executor: { executeAgent: mockExecuteAgent },
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('hydra-operator-commands-deep', () => {
  beforeEach(() => {
    mockRequest.mock.resetCalls();
    mockLoadConfig.mock.resetCalls();
    mockSaveConfig.mock.resetCalls();
    mockGetAgent.mock.resetCalls();
    mockGetActiveModel.mock.resetCalls();
    mockGetModelSummary.mock.resetCalls();
    mockSetActiveModel.mock.resetCalls();
    mockResetAgentModel.mock.resetCalls();
    mockGetMode.mock.resetCalls();
    mockSetMode.mock.resetCalls();
    mockListAgents.mock.resetCalls();
    mockSetAgentEnabled.mock.resetCalls();
    mockIsGhAvailable.mock.resetCalls();
    mockListPRs.mock.resetCalls();
    mockGetPR.mock.resetCalls();
    mockPushBranchAndCreatePR.mock.resetCalls();
    mockSetActiveMode.mock.resetCalls();
    mockPromptChoice.mock.resetCalls();
    mockSpawnHydraNode.mock.resetCalls();
    mockSpawnHydraNodeSync.mock.resetCalls();
    mockExecuteAgent.mock.resetCalls();
  });

  afterEach(() => {});

  // ── handleModelCommand ──────────────────────────────────────────────────

  describe('handleModelCommand', () => {
    it('shows model summary when no args', async () => {
      const ctx = makeCtx();
      await handleModelCommand(ctx, '');
      assert.ok(mockGetModelSummary.mock.callCount() > 0);
      assert.ok(ctx.rl.prompt.mock.callCount() > 0);
    });

    it('handles "reset" arg', async () => {
      const ctx = makeCtx();
      await handleModelCommand(ctx, 'reset');
      assert.ok(mockSetMode.mock.callCount() > 0);
      assert.ok(ctx.rl.prompt.mock.callCount() > 0);
    });

    it('applies key=value pairs for agent', async () => {
      const ctx = makeCtx();
      await handleModelCommand(ctx, 'claude=gpt-5');
      assert.ok(mockSetActiveModel.mock.callCount() > 0);
      assert.ok(ctx.rl.prompt.mock.callCount() > 0);
    });

    it('applies key=default to reset agent', async () => {
      const ctx = makeCtx();
      await handleModelCommand(ctx, 'claude=default');
      assert.ok(mockResetAgentModel.mock.callCount() > 0);
    });

    it('applies mode= pair', async () => {
      const ctx = makeCtx();
      await handleModelCommand(ctx, 'mode=economy');
      assert.ok(mockSetMode.mock.callCount() > 0);
    });

    it('handles unknown key in pair', async () => {
      const ctx = makeCtx();
      // Should not throw
      await handleModelCommand(ctx, 'unknownkey=val');
      assert.ok(ctx.rl.prompt.mock.callCount() > 0);
    });

    it('handles mode=invalid gracefully', async () => {
      const ctx = makeCtx();
      mockSetMode.mock.mockImplementationOnce(() => {
        throw new Error('Invalid mode');
      });
      await handleModelCommand(ctx, 'mode=invalid');
      assert.ok(ctx.rl.prompt.mock.callCount() > 0);
    });

    it('handles multiple pairs', async () => {
      const ctx = makeCtx();
      await handleModelCommand(ctx, 'claude=gpt-5 gemini=gemini-3');
      assert.equal(mockSetActiveModel.mock.callCount(), 2);
    });
  });

  // ── handleModelSelectCommand ────────────────────────────────────────────

  describe('handleModelSelectCommand', () => {
    it('spawns model select picker', async () => {
      const ctx = makeCtx();
      await handleModelSelectCommand(ctx, '');
      assert.ok(mockSpawnHydraNodeSync.mock.callCount() > 0);
      assert.ok(ctx.rl.pause.mock.callCount() > 0);
      assert.ok(ctx.rl.resume.mock.callCount() > 0);
      assert.ok(ctx.destroyStatusBar.mock.callCount() > 0);
      assert.ok(ctx.initStatusBar.mock.callCount() > 0);
    });

    it('passes agent name arg when valid', async () => {
      const ctx = makeCtx();
      await handleModelSelectCommand(ctx, 'claude');
      const call = mockSpawnHydraNodeSync.mock.calls[0];
      assert.ok(call);
      const args = call.arguments as any[];
      assert.ok(args[1].includes('claude'));
    });
  });

  // ── handleRolesCommand ──────────────────────────────────────────────────

  describe('handleRolesCommand', () => {
    it('displays role mappings', async () => {
      const ctx = makeCtx();
      await handleRolesCommand(ctx);
      assert.ok(mockLoadConfig.mock.callCount() > 0);
      assert.ok(ctx.rl.prompt.mock.callCount() > 0);
    });
  });

  // ── handleModeCommand ─────────────────────────────────────────────────

  describe('handleModeCommand', () => {
    it('shows current mode when no args', async () => {
      const ctx = makeCtx();
      await handleModeCommand(ctx, '');
      assert.ok(ctx.rl.prompt.mock.callCount() > 0);
    });

    it('sets orchestration mode (auto)', async () => {
      const ctx = makeCtx();
      await handleModeCommand(ctx, 'auto');
      assert.ok(ctx.setLoopMode.mock.callCount() > 0);
      assert.equal(ctx.setLoopMode.mock.calls[0].arguments[0], 'auto');
    });

    it('sets orchestration mode (council)', async () => {
      const ctx = makeCtx();
      await handleModeCommand(ctx, 'council');
      assert.ok(ctx.setLoopMode.mock.callCount() > 0);
    });

    it('sets routing mode (economy)', async () => {
      const ctx = makeCtx();
      await handleModeCommand(ctx, 'economy');
      assert.ok(mockSaveConfig.mock.callCount() > 0);
      assert.ok(mockSetActiveMode.mock.callCount() > 0);
    });

    it('sets routing mode (performance)', async () => {
      const ctx = makeCtx();
      await handleModeCommand(ctx, 'performance');
      assert.ok(mockSaveConfig.mock.callCount() > 0);
    });

    it('sets routing mode (balanced)', async () => {
      const ctx = makeCtx();
      await handleModeCommand(ctx, 'balanced');
      assert.ok(mockSaveConfig.mock.callCount() > 0);
    });

    it('rejects invalid mode', async () => {
      const ctx = makeCtx();
      await handleModeCommand(ctx, 'invalid');
      assert.ok(ctx.rl.prompt.mock.callCount() > 0);
      assert.equal(ctx.setLoopMode.mock.callCount(), 0);
    });

    it('handles smart and dispatch and handoff modes', async () => {
      for (const mode of ['smart', 'dispatch', 'handoff']) {
        const ctx = makeCtx();
        await handleModeCommand(ctx, mode);
        assert.ok(ctx.setLoopMode.mock.callCount() > 0, `${mode} should set loop mode`);
      }
    });

    it('shows economy chip in no-args path', async () => {
      mockLoadConfig.mock.mockImplementationOnce(() => ({
        routing: { mode: 'economy' },
        roles: {},
        recommendations: {},
        agents: { customAgents: [] },
        nightly: {},
        evolve: {},
      }));
      const ctx = makeCtx();
      await handleModeCommand(ctx, '');
      assert.ok(ctx.rl.prompt.mock.callCount() > 0);
    });

    it('shows performance chip in no-args path', async () => {
      mockLoadConfig.mock.mockImplementationOnce(() => ({
        routing: { mode: 'performance' },
        roles: {},
        recommendations: {},
        agents: { customAgents: [] },
        nightly: {},
        evolve: {},
      }));
      const ctx = makeCtx();
      await handleModeCommand(ctx, '');
      assert.ok(ctx.rl.prompt.mock.callCount() > 0);
    });
  });

  // ── handleTasksCommand ────────────────────────────────────────────────

  describe('handleTasksCommand', () => {
    it('lists tasks from daemon (default)', async () => {
      const ctx = makeCtx();
      mockRequest.mock.mockImplementationOnce(async () => ({
        state: { tasks: [{ id: 't1', title: 'Task 1', status: 'in_progress', owner: 'claude' }] },
      }));
      await handleTasksCommand(ctx, '');
      assert.ok(mockRequest.mock.callCount() > 0);
      assert.ok(ctx.rl.prompt.mock.callCount() > 0);
    });

    it('lists no active tasks', async () => {
      const ctx = makeCtx();
      mockRequest.mock.mockImplementationOnce(async () => ({
        state: { tasks: [{ id: 't1', title: 'Task 1', status: 'done', owner: 'claude' }] },
      }));
      await handleTasksCommand(ctx, '');
      assert.ok(ctx.rl.prompt.mock.callCount() > 0);
    });

    it('handles daemon error for tasks list', async () => {
      const ctx = makeCtx();
      mockRequest.mock.mockImplementationOnce(async () => {
        throw new Error('Daemon down');
      });
      await handleTasksCommand(ctx, '');
      assert.ok(ctx.rl.prompt.mock.callCount() > 0);
    });

    it('runs task scan subcommand', async () => {
      const ctx = makeCtx();
      // The scan subcommand does dynamic import — it should handle errors
      await handleTasksCommand(ctx, 'scan');
      // Should still prompt after error/success
      assert.ok(ctx.rl.prompt.mock.callCount() > 0);
    });

    it('runs tasks run subcommand', async () => {
      const ctx = makeCtx();
      await handleTasksCommand(ctx, 'run');
      assert.ok(mockSpawnHydraNode.mock.callCount() > 0);
    });

    it('runs tasks review subcommand', async () => {
      const ctx = makeCtx();
      await handleTasksCommand(ctx, 'review');
      assert.ok(mockSpawnHydraNode.mock.callCount() > 0);
    });

    it('runs tasks status subcommand', async () => {
      const ctx = makeCtx();
      await handleTasksCommand(ctx, 'status');
      assert.ok(mockSpawnHydraNode.mock.callCount() > 0);
    });

    it('runs tasks clean subcommand', async () => {
      const ctx = makeCtx();
      await handleTasksCommand(ctx, 'clean');
      assert.ok(mockSpawnHydraNode.mock.callCount() > 0);
    });
  });

  // ── handleAgentsCommand ───────────────────────────────────────────────

  describe('handleAgentsCommand', () => {
    it('shows registry when no subcommand', async () => {
      const ctx = makeCtx();
      await handleAgentsCommand(ctx, '');
      assert.ok(mockListAgents.mock.callCount() > 0);
      assert.ok(ctx.rl.prompt.mock.callCount() > 0);
    });

    it('handles list virtual subcommand', async () => {
      const ctx = makeCtx();
      await handleAgentsCommand(ctx, 'list virtual');
      assert.ok(mockListAgents.mock.callCount() > 0);
    });

    it('handles list physical subcommand', async () => {
      const ctx = makeCtx();
      await handleAgentsCommand(ctx, 'list physical');
      assert.ok(mockListAgents.mock.callCount() > 0);
    });

    it('handles list all subcommand', async () => {
      const ctx = makeCtx();
      await handleAgentsCommand(ctx, 'list all');
      assert.ok(mockListAgents.mock.callCount() > 0);
    });

    it('handles info subcommand with agent name', async () => {
      const ctx = makeCtx();
      await handleAgentsCommand(ctx, 'info claude');
      assert.ok(mockGetAgent.mock.callCount() > 0);
    });

    it('handles info subcommand without name', async () => {
      const ctx = makeCtx();
      await handleAgentsCommand(ctx, 'info');
      // Should show error
      assert.ok(ctx.rl.prompt.mock.callCount() > 0);
    });

    it('handles info subcommand with unknown agent', async () => {
      const ctx = makeCtx();
      mockGetAgent.mock.mockImplementationOnce(() => null);
      await handleAgentsCommand(ctx, 'info unknown');
      assert.ok(ctx.rl.prompt.mock.callCount() > 0);
    });

    it('handles enable subcommand', async () => {
      const ctx = makeCtx();
      mockGetAgent.mock.mockImplementationOnce(() => ({
        name: 'test-virtual',
        type: 'virtual',
        enabled: false,
      }));
      await handleAgentsCommand(ctx, 'enable test-virtual');
      assert.ok(mockSetAgentEnabled.mock.callCount() > 0);
    });

    it('handles disable subcommand', async () => {
      const ctx = makeCtx();
      mockGetAgent.mock.mockImplementationOnce(() => ({
        name: 'test-virtual',
        type: 'virtual',
        enabled: true,
      }));
      await handleAgentsCommand(ctx, 'disable test-virtual');
      assert.ok(mockSetAgentEnabled.mock.callCount() > 0);
    });

    it('rejects enable on physical agent', async () => {
      const ctx = makeCtx();
      // Default mock returns type: 'physical'
      await handleAgentsCommand(ctx, 'enable claude');
      assert.equal(mockSetAgentEnabled.mock.callCount(), 0);
    });

    it('handles enable without name', async () => {
      const ctx = makeCtx();
      await handleAgentsCommand(ctx, 'enable');
      assert.ok(ctx.rl.prompt.mock.callCount() > 0);
    });

    it('handles remove subcommand with valid name', async () => {
      const ctx = makeCtx();
      mockLoadConfig.mock.mockImplementationOnce(() => ({
        routing: { mode: 'balanced' },
        roles: {},
        recommendations: {},
        agents: { customAgents: [{ name: 'my-agent' }] },
        nightly: {},
        evolve: {},
      }));
      await handleAgentsCommand(ctx, 'remove my-agent');
      assert.ok(mockSaveConfig.mock.callCount() > 0);
    });

    it('handles remove subcommand with missing name', async () => {
      const ctx = makeCtx();
      await handleAgentsCommand(ctx, 'remove');
      assert.ok(ctx.rl.prompt.mock.callCount() > 0);
    });

    it('handles remove subcommand with nonexistent agent', async () => {
      const ctx = makeCtx();
      await handleAgentsCommand(ctx, 'remove nonexistent');
      // Should print error, no save
    });

    it('handles test subcommand with valid agent', async () => {
      const ctx = makeCtx();
      await handleAgentsCommand(ctx, 'test claude');
      assert.ok(mockExecuteAgent.mock.callCount() > 0);
    });

    it('handles test subcommand — agent fail', async () => {
      const ctx = makeCtx();
      mockExecuteAgent.mock.mockImplementationOnce(async () => ({
        ok: false,
        output: '',
        stderr: 'connection refused',
        errorCategory: 'network',
      }));
      await handleAgentsCommand(ctx, 'test claude');
      assert.ok(mockExecuteAgent.mock.callCount() > 0);
    });

    it('handles test subcommand — executor throws', async () => {
      const ctx = makeCtx();
      mockExecuteAgent.mock.mockImplementationOnce(async () => {
        throw new Error('test error');
      });
      await handleAgentsCommand(ctx, 'test claude');
      assert.ok(ctx.rl.prompt.mock.callCount() > 0);
    });

    it('handles test subcommand without name', async () => {
      const ctx = makeCtx();
      await handleAgentsCommand(ctx, 'test');
      assert.ok(ctx.rl.prompt.mock.callCount() > 0);
    });

    it('handles test subcommand with unknown agent', async () => {
      const ctx = makeCtx();
      mockGetAgent.mock.mockImplementationOnce(() => null);
      await handleAgentsCommand(ctx, 'test unknown');
      // Should print "Not found"
      assert.equal(mockExecuteAgent.mock.callCount(), 0);
    });

    it('handles unknown subcommand', async () => {
      const ctx = makeCtx();
      await handleAgentsCommand(ctx, 'foobar');
      assert.ok(ctx.rl.prompt.mock.callCount() > 0);
    });

    it('shows virtual agents in registry when present', async () => {
      const ctx = makeCtx();
      mockListAgents.mock.mockImplementationOnce((opts?: { type?: string }) => {
        if (opts?.type === 'physical')
          return [
            {
              name: 'claude',
              label: 'Claude',
              displayName: 'Claude',
              type: 'physical',
              enabled: true,
            },
          ];
        return [];
      });
      mockListAgents.mock.mockImplementationOnce(() => [
        {
          name: 'advisor',
          label: 'Advisor',
          displayName: 'Advisor',
          type: 'virtual',
          enabled: true,
          baseAgent: 'claude',
        },
      ]);
      await handleAgentsCommand(ctx, '');
      assert.ok(ctx.rl.prompt.mock.callCount() > 0);
    });
  });

  // ── handleCleanupCommand ──────────────────────────────────────────────

  describe('handleCleanupCommand', () => {
    it('calls runActionPipeline (mocked via dynamic import)', async () => {
      const ctx = makeCtx();
      // handleCleanupCommand does dynamic imports — it may throw on missing modules
      // but the catch block should handle it and still prompt
      await handleCleanupCommand(ctx);
      assert.ok(ctx.rl.prompt.mock.callCount() > 0);
    });
  });

  // ── handlePrCommand ───────────────────────────────────────────────────

  describe('handlePrCommand', () => {
    it('shows error when gh not available', async () => {
      const ctx = makeCtx();
      mockIsGhAvailable.mock.mockImplementationOnce(() => false);
      await handlePrCommand(ctx, 'list');
      assert.ok(ctx.rl.prompt.mock.callCount() > 0);
    });

    it('lists PRs', async () => {
      const ctx = makeCtx();
      await handlePrCommand(ctx, 'list');
      assert.ok(mockListPRs.mock.callCount() > 0);
    });

    it('lists PRs when no open PRs', async () => {
      const ctx = makeCtx();
      mockListPRs.mock.mockImplementationOnce(() => []);
      await handlePrCommand(ctx, 'list');
      assert.ok(ctx.rl.prompt.mock.callCount() > 0);
    });

    it('creates PR', async () => {
      const ctx = makeCtx();
      await handlePrCommand(ctx, 'create');
      assert.ok(mockPushBranchAndCreatePR.mock.callCount() > 0);
    });

    it('creates PR with failure', async () => {
      const ctx = makeCtx();
      mockPushBranchAndCreatePR.mock.mockImplementationOnce(() => ({
        ok: false,
        error: 'push failed',
      }));
      await handlePrCommand(ctx, 'create');
      assert.ok(ctx.rl.prompt.mock.callCount() > 0);
    });

    it('views PR', async () => {
      const ctx = makeCtx();
      await handlePrCommand(ctx, 'view 1');
      assert.ok(mockGetPR.mock.callCount() > 0);
    });

    it('view PR not found', async () => {
      const ctx = makeCtx();
      mockGetPR.mock.mockImplementationOnce(() => null);
      await handlePrCommand(ctx, 'view 999');
      assert.ok(ctx.rl.prompt.mock.callCount() > 0);
    });

    it('view PR without number', async () => {
      const ctx = makeCtx();
      await handlePrCommand(ctx, 'view');
      assert.ok(ctx.rl.prompt.mock.callCount() > 0);
    });

    it('shows usage for unknown pr subcommand', async () => {
      const ctx = makeCtx();
      await handlePrCommand(ctx, 'merge');
      assert.ok(ctx.rl.prompt.mock.callCount() > 0);
    });
  });

  // ── handleNightlyCommand ──────────────────────────────────────────────

  describe('handleNightlyCommand', () => {
    it('handles status subcommand', async () => {
      const ctx = makeCtx();
      await handleNightlyCommand(ctx, 'status');
      assert.ok(mockSpawnHydraNode.mock.callCount() > 0);
    });

    it('handles review subcommand', async () => {
      const ctx = makeCtx();
      await handleNightlyCommand(ctx, 'review');
      assert.ok(mockSpawnHydraNode.mock.callCount() > 0);
    });

    it('handles clean subcommand', async () => {
      const ctx = makeCtx();
      await handleNightlyCommand(ctx, 'clean');
      assert.ok(mockSpawnHydraNode.mock.callCount() > 0);
    });

    it('handles dry-run', async () => {
      const ctx = makeCtx();
      // ensureBranchAndClean uses spawnSync — mock it
      // Since spawnSync is from node:child_process and not mocked, this will
      // likely fail at the branch check; that's exercising the code path
      await handleNightlyCommand(ctx, 'dry-run');
      // May prompt due to branch check failure — that's still valid coverage
    });
  });

  // ── handleEvolveCommand ───────────────────────────────────────────────

  describe('handleEvolveCommand', () => {
    it('handles status subcommand', async () => {
      const ctx = makeCtx();
      await handleEvolveCommand(ctx, 'status');
      assert.ok(mockSpawnHydraNode.mock.callCount() > 0);
    });

    it('handles knowledge subcommand', async () => {
      const ctx = makeCtx();
      await handleEvolveCommand(ctx, 'knowledge');
      assert.ok(mockSpawnHydraNode.mock.callCount() > 0);
    });

    it('handles resume subcommand', async () => {
      const ctx = makeCtx();
      // Will hit ensureBranchAndClean
      await handleEvolveCommand(ctx, 'resume');
    });

    it('handles default evolve launch', async () => {
      const ctx = makeCtx();
      await handleEvolveCommand(ctx, '');
    });
  });
});
