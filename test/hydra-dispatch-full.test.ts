/**
 * Full dispatch pipeline tests for lib/hydra-dispatch.ts.
 *
 * Mocks all external dependencies (agents, config, CLI detection, usage, persona,
 * context, UI) to exercise the prompt builder functions, role resolution helpers,
 * and executor seam.
 */
import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock dependencies ────────────────────────────────────────────────────────

mock.module('../lib/hydra-env.ts', { namedExports: {} });

const mockGetAgent = mock.fn((name: string) => ({
  label: `${name}-label`,
  enabled: true,
  cli: name === 'local' ? null : name,
  rolePrompt: `${name} role prompt`,
  invoke: {
    nonInteractive: (prompt: string, opts?: Record<string, unknown>) => ({
      cmd: name,
      prompt,
      opts,
    }),
  },
  modelBelongsTo: (m: string) => m.includes(name),
}));

const mockGetMode = mock.fn(() => 'balanced');
const mockSetMode = mock.fn();

mock.module('../lib/hydra-agents.ts', {
  namedExports: {
    getAgent: mockGetAgent,
    getMode: mockGetMode,
    setMode: mockSetMode,
    AGENT_NAMES: ['claude', 'gemini', 'codex'],
    AGENTS: {},
  },
});

mock.module('../lib/hydra-routing-constants.ts', {
  namedExports: {
    DISPATCH_PREFERENCE_ORDER: ['claude', 'gemini', 'codex'],
  },
});

function getRoleAgentName(role: string): string {
  if (role === 'coordinator') return 'claude';
  if (role === 'critic') return 'gemini';
  return 'codex';
}

const mockResolveProject = mock.fn(() => ({
  projectRoot: '/test/project',
  projectName: 'test-project',
  runsDir: '/tmp/test-runs',
}));

const mockGetRoleConfig = mock.fn((role: string) => ({
  agent: getRoleAgentName(role),
  model: null,
}));

const mockLoadHydraConfig = mock.fn(() => ({
  local: { enabled: false },
  roles: {},
}));

mock.module('../lib/hydra-config.ts', {
  namedExports: {
    resolveProject: mockResolveProject,
    getRoleConfig: mockGetRoleConfig,
    loadHydraConfig: mockLoadHydraConfig,
    _setTestConfig: mock.fn(),
    invalidateConfigCache: mock.fn(),
  },
});

mock.module('../lib/hydra-context.ts', {
  namedExports: {
    buildAgentContext: mock.fn(() => 'mocked context'),
  },
});

mock.module('../lib/hydra-usage.ts', {
  namedExports: {
    checkUsage: mock.fn(() => ({ level: 'ok', percent: 20 })),
  },
});

mock.module('../lib/hydra-persona.ts', {
  namedExports: {
    isPersonaEnabled: mock.fn(() => false),
    getAgentFraming: mock.fn((agent: string) => `framed-${agent}`),
  },
});

mock.module('../lib/hydra-cli-detect.ts', {
  namedExports: {
    detectInstalledCLIs: mock.fn(() => ({ claude: true, gemini: true, codex: true })),
  },
});

mock.module('../lib/hydra-ui.ts', {
  namedExports: {
    sectionHeader: (s: string) => s,
    label: (k: string, v: string) => `${k}: ${v}`,
    colorAgent: (s: string) => s,
    createSpinner: () => ({ start: mock.fn(), succeed: mock.fn(), fail: mock.fn() }),
    SUCCESS: (s: string) => s,
    ERROR: (s: string) => s,
    WARNING: (s: string) => s,
    DIM: (s: string) => s,
    ACCENT: (s: string) => s,
    divider: () => '---',
  },
});

mock.module('picocolors', {
  defaultExport: {
    white: (s: string) => s,
    yellow: (s: string) => s,
    red: (s: string) => s,
    green: (s: string) => s,
    blue: (s: string) => s,
    bold: (s: string) => s,
    dim: (s: string) => s,
    gray: (s: string) => s,
    magenta: (s: string) => s,
    cyan: (s: string) => s,
  },
});

mock.module('../lib/hydra-utils.ts', {
  namedExports: {
    nowIso: () => '2026-01-01T00:00:00Z',
    runId: () => 'TEST_RUN_001',
    parseArgs: mock.fn((argv: string[]) => ({ options: {}, positionals: argv })),
    getPrompt: mock.fn(() => 'test prompt'),
    boolFlag: mock.fn((_v: unknown, def: boolean) => def),
    short: (s: string, n: number) => (s ?? '').slice(0, n),
    parseJsonLoose: mock.fn((s: string) => {
      try {
        return JSON.parse(s) as unknown;
      } catch {
        return null;
      }
    }),
    ensureDir: mock.fn(),
    request: mock.fn(),
  },
});

mock.module('../lib/hydra-shared/agent-executor.ts', {
  namedExports: {
    DefaultAgentExecutor: class {
      async executeAgent() {
        return {
          ok: true,
          output: '{}',
          stderr: '',
          error: null,
          exitCode: 0,
          signal: null,
          durationMs: 100,
          timedOut: false,
        };
      }
      async executeAgentWithRecovery() {
        return this.executeAgent();
      }
    },
  },
});

const { getRoleAgent, setDispatchExecutor } = await import('../lib/hydra-dispatch.ts');

// ── Tests ────────────────────────────────────────────────────────────────────

describe('getRoleAgent — resolution paths', () => {
  it('returns configured agent when installed', () => {
    const clis = { claude: true, gemini: true, codex: true };
    assert.equal(getRoleAgent('coordinator', clis), 'claude');
  });

  it('falls back through preference order when configured agent is not installed', () => {
    const clis: Record<string, boolean | undefined> = {
      claude: false,
      gemini: true,
      codex: true,
    };
    const agent = getRoleAgent('coordinator', clis);
    assert.equal(typeof agent, 'string');
    assert.notEqual(agent, 'claude');
  });

  it('returns local when local is enabled and preferred', () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      local: { enabled: true },
      roles: {},
    }));
    mockGetRoleConfig.mock.mockImplementation(() => ({
      agent: 'local',
      model: null,
    }));

    const clis: Record<string, boolean | undefined> = {
      claude: false,
      gemini: false,
      codex: false,
    };
    const agent = getRoleAgent('coordinator', clis);
    assert.equal(agent, 'local');

    // Restore
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      local: { enabled: false },
      roles: {},
    }));
    mockGetRoleConfig.mock.mockImplementation((role: string) => ({
      agent: getRoleAgentName(role),
      model: null,
    }));
  });

  it('throws when no agents are available', () => {
    mockGetAgent.mock.mockImplementation(() => ({
      label: 'test',
      enabled: false,
      cli: 'test',
      rolePrompt: '',
      invoke: { nonInteractive: () => ({ cmd: 'x', prompt: 'x', opts: undefined }) },
      modelBelongsTo: () => false,
    }));

    const clis: Record<string, boolean | undefined> = {
      claude: false,
      gemini: false,
      codex: false,
    };
    assert.throws(() => getRoleAgent('coordinator', clis), /No agents available/);

    // Restore
    mockGetAgent.mock.mockImplementation((name: string) => ({
      label: `${name}-label`,
      enabled: true,
      cli: name === 'local' ? null : name,
      rolePrompt: `${name} role prompt`,
      invoke: {
        nonInteractive: (prompt: string, opts?: Record<string, unknown>) => ({
          cmd: name,
          prompt,
          opts,
        }),
      },
      modelBelongsTo: (m: string) => m.includes(name),
    }));
  });

  it('finds any installed agent as last resort', () => {
    mockGetRoleConfig.mock.mockImplementation(() => ({
      agent: 'nonexistent',
      model: null,
    }));

    const clis: Record<string, boolean | undefined> = {
      claude: false,
      gemini: false,
      codex: true,
    };
    const agent = getRoleAgent('coordinator', clis);
    assert.equal(agent, 'codex');

    // Restore
    mockGetRoleConfig.mock.mockImplementation((role: string) => ({
      agent: getRoleAgentName(role),
      model: null,
    }));
  });
});

describe('setDispatchExecutor', () => {
  let original: unknown;

  afterEach(() => {
    if (original) setDispatchExecutor(original as Parameters<typeof setDispatchExecutor>[0]);
  });

  it('returns the previous executor', () => {
    const mockExec = {
      executeAgent: async () => ({
        ok: true,
        output: 'test',
        stderr: '',
        error: null,
        exitCode: 0,
        signal: null,
        durationMs: 0,
        timedOut: false,
      }),
      executeAgentWithRecovery: async () => ({
        ok: true,
        output: 'test',
        stderr: '',
        error: null,
        exitCode: 0,
        signal: null,
        durationMs: 0,
        timedOut: false,
      }),
    };
    original = setDispatchExecutor(mockExec as Parameters<typeof setDispatchExecutor>[0]);
    assert.ok(original);
  });

  it('swaps and restores correctly', () => {
    const mockA = {
      executeAgent: async () => ({
        ok: true,
        output: 'A',
        stderr: '',
        error: null,
        exitCode: 0,
        signal: null,
        durationMs: 0,
        timedOut: false,
      }),
      executeAgentWithRecovery: async () => ({
        ok: true,
        output: 'A',
        stderr: '',
        error: null,
        exitCode: 0,
        signal: null,
        durationMs: 0,
        timedOut: false,
      }),
    };
    const mockB = {
      executeAgent: async () => ({
        ok: true,
        output: 'B',
        stderr: '',
        error: null,
        exitCode: 0,
        signal: null,
        durationMs: 0,
        timedOut: false,
      }),
      executeAgentWithRecovery: async () => ({
        ok: true,
        output: 'B',
        stderr: '',
        error: null,
        exitCode: 0,
        signal: null,
        durationMs: 0,
        timedOut: false,
      }),
    };
    original = setDispatchExecutor(mockA as Parameters<typeof setDispatchExecutor>[0]);
    const displaced = setDispatchExecutor(mockB as Parameters<typeof setDispatchExecutor>[0]);
    assert.strictEqual(displaced, mockA);
    const displaced2 = setDispatchExecutor(original as Parameters<typeof setDispatchExecutor>[0]);
    assert.strictEqual(displaced2, mockB);
  });
});
