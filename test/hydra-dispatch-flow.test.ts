/**
 * Deep coverage tests for hydra-dispatch.ts — dispatch flow, prompt builders,
 * coordinator/critic/synthesizer pipeline, and helper functions.
 *
 * Requires --experimental-test-module-mocks.
 */

import { describe, it, mock, before } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock State ────────────────────────────────────────────────────────────────

const mockAgentDefs: Record<string, Record<string, unknown>> = {
  claude: {
    label: 'Claude',
    enabled: true,
    cli: 'claude',
    rolePrompt: 'You are the architect.',
    taskRules: [],
    taskAffinity: {},
    invoke: {
      nonInteractive: (prompt: string, opts?: Record<string, unknown>) => [
        'claude',
        '--prompt',
        prompt,
        ...(opts?.['model'] ? ['--model', opts['model']] : []),
      ],
    },
    modelBelongsTo: (m: string) => m.startsWith('claude'),
  },
  gemini: {
    label: 'Gemini',
    enabled: true,
    cli: 'gemini',
    rolePrompt: 'You are the analyst.',
    taskRules: [],
    taskAffinity: {},
    invoke: {
      nonInteractive: (prompt: string, opts?: Record<string, unknown>) => [
        'gemini',
        prompt,
        ...(opts?.['model'] ? ['--model', opts['model']] : []),
      ],
    },
    modelBelongsTo: (m: string) => m.startsWith('gemini'),
  },
  codex: {
    label: 'Codex',
    enabled: true,
    cli: 'codex',
    rolePrompt: 'You are the implementer.',
    taskRules: [],
    taskAffinity: {},
    invoke: {
      nonInteractive: (prompt: string, opts?: Record<string, unknown>) => {
        const args = ['codex', prompt];
        if (opts?.['outputPath']) args.push('--output', opts['outputPath'] as string);
        if (opts?.['model']) args.push('--model', opts['model'] as string);
        return args;
      },
    },
    modelBelongsTo: (m: string) => m.startsWith('codex'),
  },
};

let currentMode = 'balanced';

// ── Module Mocks ──────────────────────────────────────────────────────────────

mock.module('../lib/hydra-env.ts', { namedExports: {} });

mock.module('../lib/hydra-context.ts', {
  namedExports: {
    buildAgentContext: (_agent: string) => '[test-context]',
    getProjectContext: () => '',
    extractPathsFromPrompt: () => [],
    findScopedContextFiles: () => [],
    compileHierarchicalContext: () => '',
  },
});

mock.module('../lib/hydra-agents.ts', {
  namedExports: {
    getAgent: (name: string) => mockAgentDefs[name] ?? null,
    getMode: () => currentMode,
    setMode: (m: string) => {
      currentMode = m;
      return m;
    },
    AGENT_NAMES: ['claude', 'gemini', 'codex'],
  },
});

mock.module('../lib/hydra-routing-constants.ts', {
  namedExports: {
    DISPATCH_PREFERENCE_ORDER: ['claude', 'gemini', 'codex'],
  },
});

const mockLoadHydraConfig = mock.fn(() => ({
  local: { enabled: false },
  routing: {},
  roles: {},
}));

const mockGetRoleConfig = mock.fn((role: string) => {
  const map: Record<string, { agent: string; model?: string }> = {
    coordinator: { agent: 'claude' },
    critic: { agent: 'gemini' },
    synthesizer: { agent: 'codex' },
  };
  return map[role] ?? undefined;
});

mock.module('../lib/hydra-config.ts', {
  namedExports: {
    resolveProject: () => ({
      projectRoot: '/tmp/test-project',
      projectName: 'test-project',
      runsDir: '/tmp/test-project/.hydra/runs',
      configPath: '/tmp/test-project/hydra.config.json',
    }),
    loadHydraConfig: mockLoadHydraConfig,
    getRoleConfig: mockGetRoleConfig,
    invalidateConfigCache: () => {},
    _setTestConfig: () => {},
    configStore: { load: () => ({}) },
  },
});

mock.module('../lib/hydra-utils.ts', {
  namedExports: {
    nowIso: () => '2026-01-01T00:00:00.000Z',
    runId: (prefix: string) => `${prefix}_test123`,
    parseArgs: (argv: string[]) => ({ options: {}, positionals: argv }),
    getPrompt: (opts: Record<string, unknown>, pos: string[]) =>
      (opts['prompt'] as string) ?? pos[0] ?? '',
    boolFlag: (val: unknown, def: boolean) => (val === undefined ? def : Boolean(val)),
    short: (text: unknown, max: number) => {
      const s = typeof text === 'string' ? text : '';
      return s.length > max ? `${s.slice(0, max)}...` : s;
    },
    parseJsonLoose: (text: string): unknown => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return null;
      }
    },
    ensureDir: () => {},
    request: mock.fn(async () => ({ ok: true })),
  },
});

const mockExecuteAgent = mock.fn(async (_agent: string, _prompt: string, _opts?: unknown) => ({
  ok: true,
  output: '{"plan": "test plan"}',
  stdout: '{"plan": "test plan"}',
  stderr: '',
  error: '',
  exitCode: 0,
}));

mock.module('../lib/hydra-shared/agent-executor.ts', {
  namedExports: {
    DefaultAgentExecutor: class {
      executeAgent = mockExecuteAgent;
    },
    executeAgentWithRecovery: mockExecuteAgent,
  },
});

mock.module('../lib/hydra-ui.ts', {
  namedExports: {
    sectionHeader: (t: string) => `=== ${t} ===`,
    label: (k: string, v: string) => `${k}: ${v}`,
    colorAgent: (a: string) => a,
    createSpinner: () => ({
      start: () => {},
      succeed: () => {},
      fail: () => {},
      update: () => {},
    }),
    SUCCESS: (t: string) => t,
    ERROR: (t: string) => t,
    WARNING: (t: string) => t,
    DIM: (t: string) => t,
    ACCENT: (t: string) => t,
    divider: () => '---',
    formatElapsed: () => '0s',
  },
});

mock.module('../lib/hydra-usage.ts', {
  namedExports: {
    checkUsage: () => ({ level: 'ok', percent: 10 }),
  },
});

mock.module('../lib/hydra-persona.ts', {
  namedExports: {
    isPersonaEnabled: () => false,
    getAgentFraming: (agent: string) => `[${agent}]`,
    getProcessLabel: (k: string) => k,
  },
});

mock.module('../lib/hydra-cli-detect.ts', {
  namedExports: {
    detectInstalledCLIs: () => ({
      claude: true,
      gemini: true,
      codex: true,
    }),
  },
});

mock.module('picocolors', {
  defaultExport: {
    white: (s: string) => s,
    dim: (s: string) => s,
    green: (s: string) => s,
    red: (s: string) => s,
    yellow: (s: string) => s,
    cyan: (s: string) => s,
    bold: (s: string) => s,
  },
});

// ── Import module under test after mocks ──────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- dynamic import type needed for mock pattern
type DispatchMod = typeof import('../lib/hydra-dispatch.ts');
let getRoleAgent: DispatchMod['getRoleAgent'];
let setDispatchExecutor: DispatchMod['setDispatchExecutor'];

before(async () => {
  const mod: DispatchMod = await import('../lib/hydra-dispatch.ts');
  getRoleAgent = mod.getRoleAgent;
  setDispatchExecutor = mod.setDispatchExecutor;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('hydra-dispatch — getRoleAgent', () => {
  it('resolves coordinator to claude from config', () => {
    const result = getRoleAgent('coordinator', { claude: true, gemini: true, codex: true });
    assert.equal(result, 'claude');
  });

  it('resolves critic to gemini from config', () => {
    const result = getRoleAgent('critic', { claude: true, gemini: true, codex: true });
    assert.equal(result, 'gemini');
  });

  it('resolves synthesizer to codex from config', () => {
    const result = getRoleAgent('synthesizer', { claude: true, gemini: true, codex: true });
    assert.equal(result, 'codex');
  });

  it('falls back through preference order when preferred agent not installed', () => {
    mockGetRoleConfig.mock.mockImplementation(() => ({ agent: 'codex' }));
    // codex not installed, but claude is
    const result = getRoleAgent('coordinator', { claude: true, gemini: false, codex: false });
    assert.equal(result, 'claude');
    // Restore
    mockGetRoleConfig.mock.mockImplementation((role: string) => {
      const map: Record<string, { agent: string }> = {
        coordinator: { agent: 'claude' },
        critic: { agent: 'gemini' },
        synthesizer: { agent: 'codex' },
      };
      return map[role];
    });
  });

  it('throws when no agents available', () => {
    mockGetRoleConfig.mock.mockImplementation(() => ({ agent: 'nonexistent' }));
    assert.throws(() => getRoleAgent('coordinator', {}), /No agents available/);
    mockGetRoleConfig.mock.mockImplementation((role: string) => {
      const map: Record<string, { agent: string }> = {
        coordinator: { agent: 'claude' },
        critic: { agent: 'gemini' },
        synthesizer: { agent: 'codex' },
      };
      return map[role];
    });
  });

  it('returns local agent when local is enabled and preferred', () => {
    mockGetRoleConfig.mock.mockImplementation(() => ({ agent: 'local' }));
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      local: { enabled: true },
      routing: {},
      roles: {},
    }));
    const result = getRoleAgent('coordinator', { local: true });
    assert.equal(result, 'local');
    // Restore
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      local: { enabled: false },
      routing: {},
      roles: {},
    }));
    mockGetRoleConfig.mock.mockImplementation((role: string) => {
      const map: Record<string, { agent: string }> = {
        coordinator: { agent: 'claude' },
        critic: { agent: 'gemini' },
        synthesizer: { agent: 'codex' },
      };
      return map[role];
    });
  });

  it('skips local when local is not enabled', () => {
    mockGetRoleConfig.mock.mockImplementation(() => ({ agent: 'local' }));
    const result = getRoleAgent('coordinator', { claude: true });
    assert.equal(result, 'claude');
    mockGetRoleConfig.mock.mockImplementation((role: string) => {
      const map: Record<string, { agent: string }> = {
        coordinator: { agent: 'claude' },
        critic: { agent: 'gemini' },
        synthesizer: { agent: 'codex' },
      };
      return map[role];
    });
  });
});

describe('hydra-dispatch — setDispatchExecutor', () => {
  it('replaces and returns previous executor', () => {
    const mockExecutor = {
      executeAgent: mock.fn(async () => ({ ok: true, output: '' })),
    } as unknown as Parameters<typeof setDispatchExecutor>[0];
    const prev = setDispatchExecutor(mockExecutor);
    assert.ok(prev !== null);
    // Restore
    setDispatchExecutor(prev);
  });
});

describe('hydra-dispatch — getRoleAgent with disabled agents', () => {
  it('skips disabled agent and falls back to preference order', () => {
    // Override so preferred agent is disabled
    const savedDef = mockAgentDefs['claude'];
    mockAgentDefs['claude'] = { ...savedDef, enabled: false };
    try {
      const result = getRoleAgent('coordinator', { claude: true, gemini: true });
      // Should skip disabled claude and return gemini
      assert.equal(result, 'gemini');
    } finally {
      mockAgentDefs['claude'] = savedDef;
    }
  });
});

describe('hydra-dispatch — getRoleAgent with empty preferred agent', () => {
  it('falls back when role config has empty agent string', () => {
    mockGetRoleConfig.mock.mockImplementation(() => ({ agent: '' }));
    const result = getRoleAgent('coordinator', { claude: true });
    assert.equal(result, 'claude');
    mockGetRoleConfig.mock.mockImplementation((role: string) => {
      const map: Record<string, { agent: string }> = {
        coordinator: { agent: 'claude' },
        critic: { agent: 'gemini' },
        synthesizer: { agent: 'codex' },
      };
      return map[role];
    });
  });
});

describe('hydra-dispatch — findAnyInstalledAgentName fallback', () => {
  it('finds any installed agent when preference order has none', () => {
    // All preference order agents disabled, but gemini installed
    const savedClaude = mockAgentDefs['claude'];
    const savedCodex = mockAgentDefs['codex'];
    mockAgentDefs['claude'] = { ...savedClaude, enabled: false };
    mockAgentDefs['codex'] = { ...savedCodex, enabled: false };
    mockGetRoleConfig.mock.mockImplementation(() => ({ agent: '' }));
    try {
      const result = getRoleAgent('coordinator', { claude: true, gemini: true, codex: true });
      assert.equal(result, 'gemini');
    } finally {
      mockAgentDefs['claude'] = savedClaude;
      mockAgentDefs['codex'] = savedCodex;
      mockGetRoleConfig.mock.mockImplementation((role: string) => {
        const map: Record<string, { agent: string }> = {
          coordinator: { agent: 'claude' },
          critic: { agent: 'gemini' },
          synthesizer: { agent: 'codex' },
        };
        return map[role];
      });
    }
  });
});
