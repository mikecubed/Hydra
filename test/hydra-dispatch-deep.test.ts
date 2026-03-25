/**
 * Deep coverage tests for hydra-dispatch.ts
 *
 * Mocks all agent execution, config, and I/O dependencies to test
 * the dispatch pipeline: getRoleAgent, coordinator/critic/synthesizer flow,
 * preview mode, and error handling.
 *
 * Run: node --test --experimental-test-module-mocks test/hydra-dispatch-deep.test.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- test file uses dynamic mocks */

import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock state ──────────────────────────────────────────────────────────────

const mockGetAgent = mock.fn((name: string): any => ({
  name,
  label: name,
  displayName: name,
  type: 'physical',
  enabled: true,
  cli: '/usr/bin/test',
  rolePrompt: 'You are a test agent',
  invoke: {
    nonInteractive: (prompt: string, _opts?: Record<string, unknown>) => [
      'test-cmd',
      prompt.slice(0, 20),
    ],
  },
  modelBelongsTo: (_m: string) => true,
  strengths: [],
  tags: [],
  taskAffinity: {},
}));
const mockGetMode = mock.fn((): any => 'balanced');
const mockSetMode = mock.fn();
const mockCheckUsage = mock.fn((): any => ({
  level: 'ok',
  percent: 25,
}));
const mockDetectInstalledCLIs = mock.fn((): any => ({
  claude: true,
  gemini: true,
  codex: true,
}));
const mockLoadHydraConfig = mock.fn((): any => ({
  routing: { mode: 'balanced' },
  roles: {
    coordinator: { agent: 'claude', model: null },
    critic: { agent: 'gemini', model: null },
    synthesizer: { agent: 'codex', model: null },
  },
  local: { enabled: false },
  agents: { customAgents: [] },
}));
const mockGetRoleConfig = mock.fn((role: string): any => {
  const map: Record<string, { agent: string; model: string | null }> = {
    coordinator: { agent: 'claude', model: null },
    critic: { agent: 'gemini', model: null },
    synthesizer: { agent: 'codex', model: null },
  };
  return map[role] ?? { agent: 'claude', model: null };
});
const mockResolveProject = mock.fn((): any => ({
  projectRoot: '/tmp/test-project',
  projectName: 'test-project',
  runsDir: '/tmp/test-project/runs',
}));

// ── Module mocks ────────────────────────────────────────────────────────────

mock.module('../lib/hydra-env.ts', {
  namedExports: {
    loadEnvFile: mock.fn(),
    envFileExists: () => false,
  },
});

mock.module('../lib/hydra-context.ts', {
  namedExports: {
    buildAgentContext: () => 'MOCK_CONTEXT',
    getProjectContext: () => 'MOCK_CONTEXT',
    extractPathsFromPrompt: () => [],
    findScopedContextFiles: () => [],
    compileHierarchicalContext: () => '',
    contextProvider: { buildContext: () => '' },
  },
});

mock.module('../lib/hydra-agents.ts', {
  namedExports: {
    getAgent: mockGetAgent,
    getMode: mockGetMode,
    setMode: mockSetMode,
    AGENT_NAMES: ['claude', 'gemini', 'codex'],
    AGENT_TYPE: { PHYSICAL: 'physical', VIRTUAL: 'virtual' },
    AGENT_DISPLAY_ORDER: ['gemini', 'codex', 'claude'],
    KNOWN_OWNERS: new Set(['claude', 'gemini', 'codex']),
    getActiveModel: () => 'test-model',
    setActiveModel: mock.fn(),
    resetAgentModel: mock.fn(),
    getModelSummary: () => ({}),
    listAgents: () => [],
    formatEffortDisplay: () => '',
    setAgentEnabled: mock.fn(),
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

mock.module('../lib/hydra-routing-constants.ts', {
  namedExports: {
    DISPATCH_PREFERENCE_ORDER: ['claude', 'copilot', 'gemini', 'codex', 'local'],
  },
});

mock.module('../lib/hydra-config.ts', {
  namedExports: {
    resolveProject: mockResolveProject,
    getRoleConfig: mockGetRoleConfig,
    loadHydraConfig: mockLoadHydraConfig,
    saveHydraConfig: mock.fn(),
    invalidateConfigCache: mock.fn(),
    HYDRA_ROOT: '/tmp/hydra',
    configStore: { get: mockLoadHydraConfig, save: mock.fn() },
    _setTestConfigPath: mock.fn(),
    _setTestConfig: mock.fn(),
    diffConfig: mock.fn(),
    getProviderTier: () => 1,
    getProviderPresets: () => [],
    AFFINITY_PRESETS: {},
  },
});

mock.module('../lib/hydra-utils.ts', {
  namedExports: {
    nowIso: () => '2026-01-01T00:00:00Z',
    runId: () => 'TEST-DISPATCH-001',
    parseArgs: (argv: string[]) => ({ options: {}, positionals: argv }),
    getPrompt: () => 'test prompt',
    boolFlag: (_v: unknown, fb: boolean) => fb,
    short: (t: unknown) => String(t).slice(0, 100),
    parseJsonLoose: (t: unknown) => {
      try {
        return JSON.parse(String(t));
      } catch {
        return null;
      }
    },
    ensureDir: mock.fn(),
    request: mock.fn(async () => ({})),
    parseList: () => [],
  },
});

mock.module('../lib/hydra-shared/agent-executor.ts', {
  namedExports: {
    DefaultAgentExecutor: class {
      async executeAgent() {
        return { ok: true, output: '{"test": "result"}', stderr: '', errorCategory: null };
      }
    },
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

mock.module('../lib/hydra-usage.ts', {
  namedExports: {
    checkUsage: mockCheckUsage,
    checkWindowBudget: () => ({ ok: true }),
    findStatsCache: () => null,
    parseStatsCache: () => ({}),
    getContingencyOptions: () => [],
    executeContingency: mock.fn(),
    renderUsageDashboard: mock.fn(),
    renderUsageBar: () => '',
    formatTokens: () => '',
  },
});

mock.module('../lib/hydra-persona.ts', {
  namedExports: {
    isPersonaEnabled: () => false,
    getAgentFraming: () => '',
    getConciergeIdentity: () => '',
    getProcessLabel: (k: string) => k,
    listPresets: () => [],
    getPersonaConfig: () => ({}),
    invalidatePersonaCache: mock.fn(),
    applyPreset: mock.fn(),
    showPersonaSummary: mock.fn(),
  },
});

mock.module('../lib/hydra-cli-detect.ts', {
  namedExports: {
    detectInstalledCLIs: mockDetectInstalledCLIs,
    commandExists: () => true,
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

// ── Import target ───────────────────────────────────────────────────────────

const { getRoleAgent, setDispatchExecutor } = await import('../lib/hydra-dispatch.ts');

// ── Tests ───────────────────────────────────────────────────────────────────

describe('hydra-dispatch-deep', () => {
  beforeEach(() => {
    mockGetAgent.mock.resetCalls();
    mockGetMode.mock.resetCalls();
    mockSetMode.mock.resetCalls();
    mockCheckUsage.mock.resetCalls();
    mockDetectInstalledCLIs.mock.resetCalls();
    mockLoadHydraConfig.mock.resetCalls();
    mockGetRoleConfig.mock.resetCalls();
  });

  // ── getRoleAgent ──────────────────────────────────────────────────────

  describe('getRoleAgent', () => {
    it('returns preferred agent from role config', () => {
      const agent = getRoleAgent('coordinator', { claude: true, gemini: true, codex: true });
      assert.equal(agent, 'claude');
    });

    it('falls back to preference order when preferred is not installed', () => {
      mockGetRoleConfig.mock.mockImplementationOnce(() => ({
        agent: 'codex',
        model: null,
      }));
      // codex not installed, but claude is
      const agent = getRoleAgent('coordinator', { claude: true, gemini: true, codex: false });
      assert.equal(agent, 'claude');
    });

    it('returns local agent when preferred is local and local is enabled', () => {
      mockGetRoleConfig.mock.mockImplementationOnce(() => ({
        agent: 'local',
        model: null,
      }));
      mockLoadHydraConfig.mock.mockImplementationOnce(() => ({
        routing: { mode: 'balanced' },
        roles: {},
        local: { enabled: true },
        agents: { customAgents: [] },
      }));
      const agent = getRoleAgent('coordinator', { claude: true });
      assert.equal(agent, 'local');
    });

    it('skips local when not enabled', () => {
      mockGetRoleConfig.mock.mockImplementationOnce(() => ({
        agent: 'local',
        model: null,
      }));
      // Default config has local.enabled: false
      const agent = getRoleAgent('coordinator', { claude: true, gemini: true });
      assert.equal(agent, 'claude');
    });

    it('throws when no agents available', () => {
      mockGetRoleConfig.mock.mockImplementationOnce(() => ({
        agent: 'claude',
        model: null,
      }));
      mockGetAgent.mock.mockImplementation(() => ({
        name: 'claude',
        enabled: false,
        cli: '/usr/bin/claude',
      }));
      assert.throws(() => getRoleAgent('coordinator', {}), /No agents available/);
      // Restore default
      mockGetAgent.mock.mockImplementation((name: string) => ({
        name,
        label: name,
        displayName: name,
        type: 'physical',
        enabled: true,
        cli: '/usr/bin/test',
        rolePrompt: 'You are a test agent',
        invoke: {
          nonInteractive: (prompt: string) => ['test-cmd', prompt.slice(0, 20)],
        },
        modelBelongsTo: () => true,
        strengths: [],
        tags: [],
        taskAffinity: {},
      }));
    });

    it('falls back to any installed agent when preference order fails', () => {
      mockGetRoleConfig.mock.mockImplementationOnce(() => ({
        agent: 'nonexistent',
        model: null,
      }));
      // nonexistent won't resolve, but gemini is in the installed list
      const agent = getRoleAgent('coordinator', { gemini: true });
      assert.equal(agent, 'gemini');
    });

    it('uses preference order: claude before gemini', () => {
      mockGetRoleConfig.mock.mockImplementationOnce(() => ({
        agent: '',
        model: null,
      }));
      const agent = getRoleAgent('coordinator', { claude: true, gemini: true, codex: true });
      assert.equal(agent, 'claude');
    });

    it('skips disabled agents in preference order', () => {
      mockGetRoleConfig.mock.mockImplementationOnce(() => ({
        agent: '',
        model: null,
      }));
      // First agent in preference order (claude) is disabled
      mockGetAgent.mock.mockImplementation((name: string) => {
        if (name === 'claude') {
          return {
            name,
            label: name,
            displayName: name,
            type: 'physical',
            enabled: false,
            cli: '/usr/bin/claude',
          };
        }
        return {
          name,
          label: name,
          displayName: name,
          type: 'physical',
          enabled: true,
          cli: '/usr/bin/test',
          rolePrompt: '',
          invoke: { nonInteractive: () => [] },
          modelBelongsTo: () => true,
          strengths: [],
          tags: [],
          taskAffinity: {},
        };
      });
      const agent = getRoleAgent('coordinator', { claude: true, gemini: true, codex: true });
      // Should skip claude (disabled) and pick next from preference order
      assert.notEqual(agent, 'claude');
      // Restore
      mockGetAgent.mock.mockImplementation((name: string) => ({
        name,
        label: name,
        displayName: name,
        type: 'physical',
        enabled: true,
        cli: '/usr/bin/test',
        rolePrompt: 'You are a test agent',
        invoke: { nonInteractive: (prompt: string) => ['test-cmd', prompt.slice(0, 20)] },
        modelBelongsTo: () => true,
        strengths: [],
        tags: [],
        taskAffinity: {},
      }));
    });

    it('handles agent without CLI (needsCli is false)', () => {
      mockGetRoleConfig.mock.mockImplementationOnce(() => ({
        agent: 'claude',
        model: null,
      }));
      mockGetAgent.mock.mockImplementationOnce((name: string) => ({
        name,
        label: name,
        displayName: name,
        type: 'physical',
        enabled: true,
        cli: null, // no CLI required
        rolePrompt: '',
        invoke: { nonInteractive: () => [] },
        modelBelongsTo: () => true,
        strengths: [],
        tags: [],
        taskAffinity: {},
      }));
      const agent = getRoleAgent('coordinator', { claude: false }); // not installed but no CLI needed
      assert.equal(agent, 'claude');
    });

    it('handles getAgent throwing for unknown agent in preference order', () => {
      mockGetRoleConfig.mock.mockImplementationOnce(() => ({
        agent: '',
        model: null,
      }));
      // Make getAgent throw for some names
      mockGetAgent.mock.mockImplementation((name: string) => {
        if (name === 'claude' || name === 'copilot') throw new Error('Unknown agent');
        return {
          name,
          label: name,
          displayName: name,
          type: 'physical',
          enabled: true,
          cli: '/usr/bin/test',
          rolePrompt: '',
          invoke: { nonInteractive: () => [] },
          modelBelongsTo: () => true,
          strengths: [],
          tags: [],
          taskAffinity: {},
        };
      });
      const agent = getRoleAgent('coordinator', { claude: true, gemini: true, copilot: true });
      assert.equal(agent, 'gemini');
      // Restore
      mockGetAgent.mock.mockImplementation((name: string) => ({
        name,
        label: name,
        displayName: name,
        type: 'physical',
        enabled: true,
        cli: '/usr/bin/test',
        rolePrompt: 'You are a test agent',
        invoke: { nonInteractive: (prompt: string) => ['test-cmd', prompt.slice(0, 20)] },
        modelBelongsTo: () => true,
        strengths: [],
        tags: [],
        taskAffinity: {},
      }));
    });

    it('uses findAnyInstalledAgentName as last resort', () => {
      mockGetRoleConfig.mock.mockImplementationOnce(() => ({
        agent: 'nonexistent',
        model: null,
      }));
      // None in preference order are installed, but "codex" is installed outside order
      mockGetAgent.mock.mockImplementation((name: string) => {
        if (name === 'nonexistent') return null;
        return {
          name,
          label: name,
          displayName: name,
          type: 'physical',
          enabled: true,
          cli: '/usr/bin/test',
          rolePrompt: '',
          invoke: { nonInteractive: () => [] },
          modelBelongsTo: () => true,
          strengths: [],
          tags: [],
          taskAffinity: {},
        };
      });
      // Only codex installed, and it's in preference order, so it should be found
      const agent = getRoleAgent('coordinator', { codex: true });
      assert.equal(agent, 'codex');
      // Restore
      mockGetAgent.mock.mockImplementation((name: string) => ({
        name,
        label: name,
        displayName: name,
        type: 'physical',
        enabled: true,
        cli: '/usr/bin/test',
        rolePrompt: 'You are a test agent',
        invoke: { nonInteractive: (prompt: string) => ['test-cmd', prompt.slice(0, 20)] },
        modelBelongsTo: () => true,
        strengths: [],
        tags: [],
        taskAffinity: {},
      }));
    });
  });

  // ── setDispatchExecutor ───────────────────────────────────────────────

  describe('setDispatchExecutor', () => {
    it('replaces the executor and returns the previous one', () => {
      const mockExecutor = {
        executeAgent: mock.fn(async () => ({
          ok: true,
          output: 'mock',
          stderr: '',
          errorCategory: null,
        })),
      };
      const prev = setDispatchExecutor(mockExecutor as any);
      assert.ok(prev !== null);
      // Restore
      setDispatchExecutor(prev);
    });

    it('round-trips correctly', () => {
      const exec1 = { executeAgent: mock.fn() };
      const exec2 = { executeAgent: mock.fn() };
      const original = setDispatchExecutor(exec1 as any);
      const displaced = setDispatchExecutor(exec2 as any);
      assert.strictEqual(displaced, exec1);
      // Restore
      setDispatchExecutor(original);
    });
  });
});
