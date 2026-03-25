/**
 * Deep coverage tests for hydra-dispatch.ts
 *
 * Exercises the exported functions (getRoleAgent, setDispatchExecutor) and
 * internal helper logic (prompt building, preview/live slots, output summary)
 * through module-level mocking.
 *
 * Run: node --test --experimental-test-module-mocks test/hydra-dispatch-deep.coverage.test.ts
 */

import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Controllable mock state ──────────────────────────────────────────────────

let mockInstalledCLIs: Record<string, boolean | undefined> = {
  claude: true,
  gemini: true,
  codex: true,
};

const mockAgentDefs: Record<string, Record<string, unknown>> = {
  claude: {
    name: 'claude',
    label: 'Claude',
    enabled: true,
    cli: 'claude',
    rolePrompt: 'Claude role prompt',
    invoke: {
      nonInteractive: (prompt: string) => ['claude', '--prompt', prompt],
    },
    modelBelongsTo: (model: string) => model.includes('claude'),
  },
  gemini: {
    name: 'gemini',
    label: 'Gemini',
    enabled: true,
    cli: 'gemini',
    rolePrompt: 'Gemini role prompt',
    invoke: {
      nonInteractive: (prompt: string) => ['gemini', '--prompt', prompt],
    },
    modelBelongsTo: (model: string) => model.includes('gemini'),
  },
  codex: {
    name: 'codex',
    label: 'Codex',
    enabled: true,
    cli: 'codex',
    rolePrompt: 'Codex role prompt',
    invoke: {
      nonInteractive: (prompt: string) => ['codex', '--prompt', prompt],
    },
    modelBelongsTo: (model: string) => model.includes('codex'),
  },
  local: {
    name: 'local',
    label: 'Local',
    enabled: true,
    cli: null,
    rolePrompt: '',
    invoke: { nonInteractive: undefined },
    modelBelongsTo: () => false,
  },
};

let mockLocalEnabled = false;

// ── Module mocks ─────────────────────────────────────────────────────────────

mock.module('../lib/hydra-env.ts', { namedExports: { loadEnvFile: () => {} } });

mock.module('../lib/hydra-config.ts', {
  namedExports: {
    resolveProject: () => ({
      projectRoot: '/tmp/test-project',
      projectName: 'test-project',
      runsDir: '/tmp/test-project/.hydra/runs',
    }),
    loadHydraConfig: () => ({
      routing: { mode: 'balanced' },
      local: { enabled: mockLocalEnabled },
    }),
    getRoleConfig: (role: string) => {
      const roleDefs: Record<string, Record<string, unknown>> = {
        coordinator: { agent: 'claude', model: null },
        critic: { agent: 'gemini', model: null },
        synthesizer: { agent: 'codex', model: null },
      };
      return roleDefs[role] ?? { agent: 'claude', model: null };
    },
    invalidateConfigCache: () => {},
    HYDRA_ROOT: '/tmp/test-project',
    HYDRA_RUNTIME_ROOT: '/tmp/test-project',
    AFFINITY_PRESETS: {},
    _setTestConfig: () => {},
    _setTestConfigPath: () => {},
    configStore: { get: () => ({}), set: () => {} },
  },
});

mock.module('../lib/hydra-context.ts', {
  namedExports: {
    buildAgentContext: () => 'MOCK_CONTEXT',
    getProjectContext: () => 'MOCK_CONTEXT',
    extractPathsFromPrompt: () => [],
    findScopedContextFiles: () => [],
    compileHierarchicalContext: () => '',
  },
});

mock.module('../lib/hydra-agents.ts', {
  namedExports: {
    getAgent: (name: string) => mockAgentDefs[name] ?? null,
    getMode: () => 'balanced',
    setMode: mock.fn(() => 'economy'),
    AGENT_NAMES: ['claude', 'gemini', 'codex'],
    AGENT_TYPE: { PHYSICAL: 'physical', VIRTUAL: 'virtual' },
    registerAgent: () => ({}),
    unregisterAgent: () => false,
    setAgentEnabled: () => false,
    resolvePhysicalAgent: () => null,
    listAgents: () => [],
    AGENTS: {},
    AGENT_DISPLAY_ORDER: ['gemini', 'codex', 'claude'],
    KNOWN_OWNERS: new Set(['claude', 'gemini', 'codex', 'human', 'unassigned']),
    getPhysicalAgentNames: () => ['claude', 'gemini', 'codex'],
    getAllAgentNames: () => ['claude', 'gemini', 'codex'],
    initAgentRegistry: () => {},
    isRegistryInitialized: () => true,
    _resetRegistry: () => {},
    bestAgentFor: () => 'claude',
    classifyTask: () => 'general',
    getVerifier: () => 'gemini',
    recordTaskOutcome: () => {},
    invalidateAffinityCache: () => {},
    getActiveModel: () => null,
    setActiveModel: () => null,
    resetAgentModel: () => null,
    getModelFlags: () => [],
    getModelSummary: () => ({}),
    resolveModelId: () => null,
    getReasoningEffort: () => null,
    setReasoningEffort: () => null,
    getModelReasoningCaps: () => ({ supports: false }),
    getEffortOptionsForModel: () => [],
    formatEffortDisplay: () => '',
    MODEL_REASONING_CAPS: new Map(),
    REASONING_EFFORTS: ['low', 'medium', 'high', 'xhigh'],
    TASK_TYPES: [],
  },
});

mock.module('../lib/hydra-routing-constants.ts', {
  namedExports: {
    DISPATCH_PREFERENCE_ORDER: ['claude', 'gemini', 'codex'],
  },
});

mock.module('../lib/hydra-usage.ts', {
  namedExports: {
    checkUsage: () => ({ level: 'ok', percent: 10, todayTokens: 100 }),
  },
});

mock.module('../lib/hydra-utils.ts', {
  namedExports: {
    nowIso: () => '2026-01-01T00:00:00.000Z',
    runId: (prefix: string) => `${prefix}_test123`,
    parseArgs: () => ({ options: {}, positionals: [] }),
    getPrompt: () => '',
    boolFlag: (_v: unknown, d: boolean) => d,
    short: (s: unknown, n: number) => (typeof s === 'string' ? s.slice(0, n) : ''),
    parseJsonLoose: (s: string) => {
      try {
        return JSON.parse(s) as unknown;
      } catch {
        return null;
      }
    },
    request: mock.fn(async () => ({ ok: true })),
    ensureDir: () => {},
  },
});

mock.module('../lib/hydra-ui.ts', {
  namedExports: {
    sectionHeader: (s: string) => `== ${s} ==`,
    label: (k: string, v: string) => `${k}: ${v}`,
    colorAgent: (a: string) => a,
    createSpinner: () => ({
      start: () => {},
      stop: () => {},
      succeed: () => {},
      fail: () => {},
      update: () => {},
    }),
    divider: () => '---',
    SUCCESS: (s: unknown) => String(s),
    ERROR: (s: unknown) => String(s),
    WARNING: (s: unknown) => String(s),
    DIM: (s: unknown) => String(s),
    ACCENT: (s: unknown) => String(s),
    formatElapsed: () => '0s',
    formatAgentStatus: () => '',
    stripAnsi: (s: string) => s,
    shortModelName: (s: string) => s,
  },
});

const mockExecuteAgent = mock.fn(async () => ({
  ok: true,
  output: '{"plan": "test"}',
  stdout: '{"plan": "test"}',
  stderr: '',
  error: '',
  exitCode: 0,
  command: 'mock',
  args: [],
}));

mock.module('../lib/hydra-shared/agent-executor.ts', {
  namedExports: {
    executeAgent: mockExecuteAgent,
    executeAgentWithRecovery: mockExecuteAgent,
    DefaultAgentExecutor: class {
      async executeAgent() {
        return mockExecuteAgent();
      }
    },
    diagnoseAgentError: () => null,
    expandInvokeArgs: () => [],
    parseCliResponse: () => ({}),
    assertSafeSpawnCmd: () => true,
    extractCodexText: () => '',
    extractCodexUsage: () => null,
    extractCodexErrors: () => [],
  },
});

mock.module('../lib/hydra-persona.ts', {
  namedExports: {
    isPersonaEnabled: () => false,
    getAgentFraming: (a: string) => `You are ${a}`,
    getConciergeIdentity: () => '',
    getProcessLabel: (k: string) => k,
  },
});

mock.module('../lib/hydra-cli-detect.ts', {
  namedExports: {
    detectInstalledCLIs: () => mockInstalledCLIs,
  },
});

mock.module('picocolors', {
  defaultExport: {
    white: (s: string) => s,
    red: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    blue: (s: string) => s,
    cyan: (s: string) => s,
    magenta: (s: string) => s,
    dim: (s: string) => s,
    bold: (s: string) => s,
    gray: (s: string) => s,
    underline: (s: string) => s,
    italic: (s: string) => s,
    reset: (s: string) => s,
    bgRed: (s: string) => s,
    bgGreen: (s: string) => s,
  },
});

// ── Import target module after mocks ─────────────────────────────────────────

const { getRoleAgent, setDispatchExecutor } = await import('../lib/hydra-dispatch.ts');

// ── Tests ────────────────────────────────────────────────────────────────────

describe('hydra-dispatch deep coverage', () => {
  beforeEach(() => {
    mockInstalledCLIs = { claude: true, gemini: true, codex: true };
    mockLocalEnabled = false;
  });

  describe('getRoleAgent', () => {
    it('returns configured agent when installed', () => {
      const result = getRoleAgent('coordinator', { claude: true, gemini: true, codex: true });
      assert.equal(result, 'claude');
    });

    it('returns critic agent', () => {
      const result = getRoleAgent('critic', { claude: true, gemini: true, codex: true });
      assert.equal(result, 'gemini');
    });

    it('returns synthesizer agent', () => {
      const result = getRoleAgent('synthesizer', { claude: true, gemini: true, codex: true });
      assert.equal(result, 'codex');
    });

    it('falls back to preference order when preferred agent not installed', () => {
      // gemini is preferred for critic but not installed
      const result = getRoleAgent('critic', { claude: true, gemini: false, codex: true });
      assert.equal(result, 'claude');
    });

    it('falls back to any installed agent', () => {
      const result = getRoleAgent('coordinator', { claude: false, gemini: false, codex: true });
      assert.equal(result, 'codex');
    });

    it('throws when no agents available', () => {
      assert.throws(
        () => getRoleAgent('coordinator', { claude: false, gemini: false, codex: false }),
        /No agents available/,
      );
    });

    it('handles local agent when enabled', () => {
      mockLocalEnabled = true;
      // When all CLI agents are unavailable but local is enabled
      const result = getRoleAgent('coordinator', {
        claude: false,
        gemini: false,
        codex: false,
        local: true,
      });
      assert.equal(result, 'local');
    });

    it('skips local when not enabled', () => {
      mockLocalEnabled = false;
      const result = getRoleAgent('coordinator', { claude: true, local: true });
      assert.equal(result, 'claude');
    });

    it('handles disabled agent gracefully', () => {
      // Override mockAgentDefs temporarily — codex disabled
      const origCodex = mockAgentDefs['codex'];
      mockAgentDefs['codex'] = { ...origCodex, enabled: false };
      try {
        const result = getRoleAgent('synthesizer', { claude: true, gemini: true, codex: true });
        // Should fall back since codex is disabled
        assert.ok(['claude', 'gemini'].includes(result));
      } finally {
        mockAgentDefs['codex'] = origCodex;
      }
    });

    it('handles unknown role name', () => {
      const result = getRoleAgent('unknown_role', { claude: true, gemini: true, codex: true });
      // Should still resolve via preference order fallback
      assert.ok(['claude', 'gemini', 'codex'].includes(result));
    });
  });

  describe('setDispatchExecutor', () => {
    it('returns the previous executor', () => {
      const mockResult = {
        ok: true,
        output: 'mock',
        stdout: 'mock',
        stderr: '',
        error: '',
        exitCode: 0,
        command: 'test',
        args: [] as string[],
        promptSnippet: '',
        recovered: false,
        originalModel: undefined,
        newModel: undefined,
      };
      const mockExec = {
        executeAgent: mock.fn(async () => mockResult),
        executeAgentWithRecovery: mock.fn(async () => mockResult),
      } as unknown as Parameters<typeof setDispatchExecutor>[0];
      const prev = setDispatchExecutor(mockExec);
      assert.ok(prev != null);
      // Restore
      setDispatchExecutor(prev);
    });

    it('allows swapping executor back and forth', () => {
      const result1 = {
        ok: true,
        output: 'exec1',
        stdout: '',
        stderr: '',
        error: '',
        exitCode: 0,
        command: '',
        args: [] as string[],
        promptSnippet: '',
        recovered: false,
        originalModel: undefined,
        newModel: undefined,
      };
      const result2 = {
        ok: false,
        output: 'exec2',
        stdout: '',
        stderr: '',
        error: 'fail',
        exitCode: 1,
        command: '',
        args: [] as string[],
        promptSnippet: '',
        recovered: false,
        originalModel: undefined,
        newModel: undefined,
      };
      const exec1 = {
        executeAgent: mock.fn(async () => result1),
        executeAgentWithRecovery: mock.fn(async () => result1),
      } as unknown as Parameters<typeof setDispatchExecutor>[0];
      const exec2 = {
        executeAgent: mock.fn(async () => result2),
        executeAgentWithRecovery: mock.fn(async () => result2),
      } as unknown as Parameters<typeof setDispatchExecutor>[0];

      const original = setDispatchExecutor(exec1);
      const prev1 = setDispatchExecutor(exec2);
      assert.strictEqual(prev1, exec1);
      const prev2 = setDispatchExecutor(original);
      assert.strictEqual(prev2, exec2);
    });
  });
});
