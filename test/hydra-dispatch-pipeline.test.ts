/**
 * Deep coverage tests for lib/hydra-dispatch.ts — pipeline functions.
 *
 * Mocks ALL I/O dependencies (agents, config, context, CLI detection, usage, persona, UI)
 * and tests the internal dispatch pipeline helpers via the two exported entry points.
 */
import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock dependencies BEFORE importing the module under test ─────────────────

const mockBuildAgentContext = mock.fn(() => 'mock-context');
mock.module('../lib/hydra-context.ts', {
  namedExports: { buildAgentContext: mockBuildAgentContext },
});

const mockGetAgent = mock.fn(
  (
    name: string,
  ): {
    label: string;
    enabled: boolean;
    cli: string;
    rolePrompt: string;
    invoke: { nonInteractive: (_prompt: string, _opts?: Record<string, unknown>) => string[] };
    modelBelongsTo: (_m: string) => boolean;
  } => ({
    label: `Mock ${name}`,
    enabled: true,
    cli: name,
    rolePrompt: `You are ${name}`,
    invoke: {
      nonInteractive: (_prompt: string, _opts?: Record<string, unknown>) => ['mock-cmd', '--arg'],
    },
    modelBelongsTo: (_m: string) => true,
  }),
);
const mockGetMode = mock.fn(() => 'balanced');
const mockSetMode = mock.fn();
mock.module('../lib/hydra-agents.ts', {
  namedExports: {
    getAgent: mockGetAgent,
    getMode: mockGetMode,
    setMode: mockSetMode,
    getActiveModel: mock.fn(() => 'mock-model'),
    setActiveModel: mock.fn(),
    getReasoningEffort: mock.fn(() => null),
    AGENT_NAMES: ['claude', 'gemini', 'codex'],
    AGENTS: {},
  },
});

mock.module('../lib/hydra-routing-constants.ts', {
  namedExports: { DISPATCH_PREFERENCE_ORDER: ['claude', 'gemini', 'codex'] },
});

const mockResolveProject = mock.fn(() => ({
  projectRoot: '/tmp/test-project',
  projectName: 'test-project',
  runsDir: '/tmp/test-project/.hydra/runs',
  configPath: '/tmp/test-project/hydra.config.json',
}));
const roleAgentMap: Record<string, string> = {
  coordinator: 'claude',
  critic: 'gemini',
  synthesizer: 'codex',
};
const mockGetRoleConfig = mock.fn((role: string) => ({
  agent: roleAgentMap[role] ?? 'codex',
  model: null,
}));
const mockLoadHydraConfig = mock.fn(() => ({
  local: { enabled: false },
  roles: {},
  models: {},
  mode: 'balanced',
}));
const mockInvalidateConfigCache = mock.fn();
const mockSaveHydraConfig = mock.fn();
mock.module('../lib/hydra-config.ts', {
  namedExports: {
    resolveProject: mockResolveProject,
    getRoleConfig: mockGetRoleConfig,
    loadHydraConfig: mockLoadHydraConfig,
    invalidateConfigCache: mockInvalidateConfigCache,
    saveHydraConfig: mockSaveHydraConfig,
    _setTestConfig: mock.fn(),
    _setTestConfigPath: mock.fn(),
    HYDRA_ROOT: '/tmp/hydra-root',
    configStore: {
      load: mockLoadHydraConfig,
      save: mockSaveHydraConfig,
      invalidate: mockInvalidateConfigCache,
    },
  },
});

const mockParseArgs = mock.fn((_argv: string[]) => ({
  options: { prompt: 'test prompt', mode: 'live' } as Record<string, string>,
  positionals: [] as string[],
}));
const mockGetPrompt = mock.fn(
  (opts: Record<string, string>, _pos: string[]) => opts['prompt'] ?? '',
);
const mockBoolFlag = mock.fn((_val: string | boolean | undefined, def: boolean) => def);
const mockShort = mock.fn((s: string, _n: number) => s.slice(0, 50));
const mockParseJsonLoose = mock.fn((s: string): unknown => {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
});
const mockEnsureDir = mock.fn();
const mockNowIso = mock.fn(() => '2025-01-01T00:00:00Z');
const mockRunId = mock.fn(() => 'TEST-RUN-001');
mock.module('../lib/hydra-utils.ts', {
  namedExports: {
    parseArgs: mockParseArgs,
    getPrompt: mockGetPrompt,
    boolFlag: mockBoolFlag,
    short: mockShort,
    parseJsonLoose: mockParseJsonLoose,
    ensureDir: mockEnsureDir,
    nowIso: mockNowIso,
    runId: mockRunId,
    request: mock.fn(),
  },
});

mock.module('../lib/hydra-ui.ts', {
  namedExports: {
    sectionHeader: (t: string) => `=== ${t} ===`,
    label: (k: string, v: string) => `${k}: ${v}`,
    colorAgent: (n: string) => n,
    createSpinner: () => ({
      start: mock.fn(),
      stop: mock.fn(),
      succeed: mock.fn(),
      fail: mock.fn(),
    }),
    SUCCESS: (s: string) => s,
    ERROR: (s: string) => s,
    WARNING: (s: string) => s,
    DIM: (s: string) => s,
    ACCENT: (s: string) => s,
  },
});

const mockCheckUsage = mock.fn(() => ({ level: 'ok', percent: 10 }));
mock.module('../lib/hydra-usage.ts', {
  namedExports: { checkUsage: mockCheckUsage },
});

const mockIsPersonaEnabled = mock.fn(() => false);
const mockGetAgentFraming = mock.fn((_name: string) => 'You are an agent');
mock.module('../lib/hydra-persona.ts', {
  namedExports: {
    isPersonaEnabled: mockIsPersonaEnabled,
    getAgentFraming: mockGetAgentFraming,
  },
});

const mockDetectInstalledCLIs = mock.fn(() => ({
  claude: true,
  gemini: true,
  codex: true,
}));
mock.module('../lib/hydra-cli-detect.ts', {
  namedExports: { detectInstalledCLIs: mockDetectInstalledCLIs },
});

// Suppress env loading
mock.module('../lib/hydra-env.ts', {
  namedExports: { loadEnvFile: mock.fn(), envFileExists: mock.fn(() => false) },
});

// Now import the module under test
const { getRoleAgent, setDispatchExecutor } = await import('../lib/hydra-dispatch.ts');
import type { IAgentExecutor } from '../lib/hydra-shared/agent-executor.ts';
import type { ExecuteResult } from '../lib/types.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMockResult(output: string, ok = true): ExecuteResult {
  return {
    ok,
    output,
    stderr: ok ? '' : 'mock-err',
    error: ok ? null : 'mock error',
    exitCode: ok ? 0 : 1,
    signal: null,
    durationMs: 100,
    timedOut: false,
  } as ExecuteResult;
}

function makeMockExecutor(output = 'mock-output', ok = true): IAgentExecutor {
  const fn = async () => makeMockResult(output, ok);
  return { executeAgent: fn, executeAgentWithRecovery: fn };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('hydra-dispatch pipeline — getRoleAgent extended', () => {
  afterEach(() => {
    mockLoadHydraConfig.mock.resetCalls();
    mockGetRoleConfig.mock.resetCalls();
  });

  it('returns local agent when local is enabled and configured for role', () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      local: { enabled: true },
      roles: {},
      models: {},
      mode: 'balanced',
    }));
    mockGetRoleConfig.mock.mockImplementation(() => ({ agent: 'local', model: null }));

    const result = getRoleAgent('coordinator', { claude: true, gemini: true, codex: true });
    assert.equal(result, 'local');
  });

  it('skips local agent when local is disabled', () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      local: { enabled: false },
      roles: {},
      models: {},
      mode: 'balanced',
    }));
    mockGetRoleConfig.mock.mockImplementation(() => ({ agent: 'local', model: null }));

    const result = getRoleAgent('coordinator', { claude: true, gemini: true, codex: true });
    // Should fall back to preference order
    assert.notEqual(result, 'local');
  });

  it('returns agent from preference order when configured agent not installed', () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      local: { enabled: false },
      roles: {},
      models: {},
      mode: 'balanced',
    }));
    mockGetRoleConfig.mock.mockImplementation(() => ({ agent: 'claude', model: null }));

    // claude not installed
    const result = getRoleAgent('coordinator', { claude: false, gemini: true, codex: true });
    assert.equal(result, 'gemini');
  });

  it('throws when no agents available at all', () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      local: { enabled: false },
      roles: {},
      models: {},
      mode: 'balanced',
    }));
    mockGetRoleConfig.mock.mockImplementation(() => ({ agent: 'claude', model: null }));

    // Mock getAgent to return disabled agents
    mockGetAgent.mock.mockImplementation(() => ({
      label: 'Mock',
      enabled: false,
      cli: 'mock',
      rolePrompt: '',
      invoke: { nonInteractive: (_p: string, _o?: Record<string, unknown>) => ['mock-cmd'] },
      modelBelongsTo: () => false,
    }));

    assert.throws(
      () => getRoleAgent('coordinator', { claude: false, gemini: false, codex: false }),
      /No agents available/,
    );

    // Restore
    mockGetAgent.mock.mockImplementation((name: string) => ({
      label: `Mock ${name}`,
      enabled: true,
      cli: name,
      rolePrompt: `You are ${name}`,
      invoke: { nonInteractive: (_p: string, _o?: Record<string, unknown>) => ['mock-cmd'] },
      modelBelongsTo: () => true,
    }));
  });

  it('handles null/empty preferred agent in role config', () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      local: { enabled: false },
      roles: {},
      models: {},
      mode: 'balanced',
    }));
    mockGetRoleConfig.mock.mockImplementation(() => ({ agent: '', model: null }));

    const result = getRoleAgent('coordinator', { claude: true, gemini: true, codex: true });
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
  });

  it('handles null role config', () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      local: { enabled: false },
      roles: {},
      models: {},
      mode: 'balanced',
    }));
    mockGetRoleConfig.mock.mockImplementation(
      () => null as unknown as { agent: string; model: null },
    );

    const result = getRoleAgent('coordinator', { claude: true, gemini: true, codex: true });
    assert.equal(typeof result, 'string');
  });
});

describe('hydra-dispatch pipeline — setDispatchExecutor', () => {
  it('replaces executor and returns previous one', () => {
    const mock1 = makeMockExecutor('out1');
    const prev = setDispatchExecutor(mock1);
    assert.ok(prev !== null);
    assert.equal(typeof prev.executeAgent, 'function');

    // Restore
    setDispatchExecutor(prev);
  });

  it('chain of replacements works correctly', () => {
    const e1 = makeMockExecutor('e1');
    const e2 = makeMockExecutor('e2');
    const e3 = makeMockExecutor('e3');

    const orig = setDispatchExecutor(e1);
    const got1 = setDispatchExecutor(e2);
    assert.strictEqual(got1, e1);

    const got2 = setDispatchExecutor(e3);
    assert.strictEqual(got2, e2);

    // Restore
    setDispatchExecutor(orig);
  });
});
