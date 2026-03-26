/**
 * Deep coverage tests for lib/hydra-operator-startup.ts
 *
 * Mocks process spawning, daemon HTTP, config loading.
 * Requires --experimental-test-module-mocks.
 */

import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock state ──────────────────────────────────────────────────────────────

const mockRequest = mock.fn(
  async (_method: string, _base: string, _path: string) => ({}) as Record<string, unknown>,
);
const mockSpawnHydraNode = mock.fn(
  (_script: string, _args: string[], _opts: Record<string, unknown>) => ({
    unref: mock.fn(),
    pid: 12345,
  }),
);
const mockGetAgent = mock.fn((name: string) =>
  name ? { name, rolePrompt: `You are ${name}.`, type: 'physical' } : null,
);
const mockGetModelSummary = mock.fn(() => ({
  _mode: 'balanced',
  claude: { active: 'claude-opus-4', isOverride: false },
  gemini: { active: 'gemini-3-pro', isOverride: false },
}));
const mockGetMode = mock.fn(() => 'balanced');
const mockCheckUsage = mock.fn(() => ({ todayTokens: 0, model: '' }));
const mockGetSessionUsage = mock.fn(() => ({ callCount: 0, totalTokens: 0, costUsd: 0 }));
const mockSyncHydraMd = mock.fn(() => ({ synced: [] as string[] }));
const mockPrintNextSteps = mock.fn();
const mockLoadProviderUsage = mock.fn();
const mockRefreshExternalUsage = mock.fn(async () => {});
const mockGetProviderSummary = mock.fn(() => [] as string[]);
const mockGetExternalSummary = mock.fn(() => [] as string[]);

// ── Module mocks ────────────────────────────────────────────────────────────

mock.module('../lib/hydra-utils.ts', {
  namedExports: {
    request: (...args: unknown[]) => mockRequest(...(args as [string, string, string])),
    short: (s: string | undefined, n?: number) => (s ?? '').slice(0, n ?? 200),
  },
});

mock.module('../lib/hydra-exec-spawn.ts', {
  namedExports: {
    spawnHydraNode: (...args: unknown[]) =>
      mockSpawnHydraNode(...(args as [string, string[], Record<string, unknown>])),
  },
});

mock.module('../lib/hydra-agents.ts', {
  namedExports: {
    getAgent: (name: string) => mockGetAgent(name),
    getModelSummary: () => mockGetModelSummary(),
    getMode: () => mockGetMode(),
    formatEffortDisplay: (_model: string, _effort: unknown) => '',
    AGENT_TYPE: { physical: 'physical', virtual: 'virtual' },
    getActiveModel: () => 'test-model',
    getReasoningEffort: () => null,
    AGENT_NAMES: ['claude', 'gemini', 'codex'],
    AGENTS: {},
    initAgentRegistry: () => {},
    _resetRegistry: () => {},
    registerAgent: () => {},
    unregisterAgent: () => {},
  },
});

mock.module('../lib/hydra-usage.ts', {
  namedExports: {
    checkUsage: () => mockCheckUsage(),
    formatTokens: (n: number) => String(n),
    recordUsage: () => {},
  },
});

mock.module('../lib/hydra-metrics.ts', {
  namedExports: {
    getSessionUsage: () => mockGetSessionUsage(),
    metricsEmitter: { on: () => {} },
    checkSLOs: () => [],
    recordMetric: () => {},
    getMetrics: () => ({}),
    resetMetrics: () => {},
  },
});

mock.module('../lib/hydra-config.ts', {
  namedExports: {
    resolveProject: () => ({ projectRoot: '/tmp/test', projectName: 'test' }),
    loadHydraConfig: () => ({
      routing: { mode: 'balanced' },
      models: {},
      aliases: {},
      mode: 'balanced',
    }),
    _setTestConfig: () => {},
    invalidateConfigCache: () => {},
    HYDRA_ROOT: '/tmp/hydra',
  },
});

mock.module('../lib/hydra-ui.ts', {
  namedExports: {
    hydraSplash: () => 'HYDRA',
    label: (_k: string, v: string) => v,
    colorAgent: (a: string) => a,
    SUCCESS: (s: string) => s,
    ERROR: (s: string) => s,
    WARNING: (s: string) => s,
    DIM: (s: string) => s,
    ACCENT: (s: string) => s,
    AGENT_COLORS: {},
    formatAgentStatus: () => '',
    formatElapsed: () => '',
    stripAnsi: (s: string) => s,
    shortModelName: (m: string) => m,
  },
});

mock.module('../lib/hydra-sync-md.ts', {
  namedExports: {
    syncHydraMd: () => mockSyncHydraMd(),
  },
});

mock.module('../lib/hydra-operator-ui.ts', {
  namedExports: {
    printNextSteps: (...args: unknown[]) => {
      mockPrintNextSteps(...args);
    },
  },
});

mock.module('../lib/hydra-provider-usage.ts', {
  namedExports: {
    loadProviderUsage: () => {
      mockLoadProviderUsage();
    },
    refreshExternalUsage: () => mockRefreshExternalUsage(),
    getProviderSummary: () => mockGetProviderSummary(),
    getExternalSummary: () => mockGetExternalSummary(),
  },
});

mock.module('picocolors', {
  defaultExport: {
    white: (s: string) => s,
    bold: (s: string) => s,
    yellow: (s: string) => s,
    red: (s: string) => s,
    green: (s: string) => s,
    cyan: (s: string) => s,
    dim: (s: string) => s,
    blue: (s: string) => s,
  },
});

// ── Import under test (AFTER mocks) ────────────────────────────────────────

const {
  ensureDaemon,
  findPowerShell,
  findWindowsTerminal,
  launchAgentTerminals,
  extractHandoffAgents,
  printWelcome,
} = await import('../lib/hydra-operator-startup.ts');

// ── Tests ───────────────────────────────────────────────────────────────────

describe('hydra-operator-startup-deep', () => {
  let consoleLogs: string[];
  let origConsoleLog: typeof console.log;

  beforeEach(() => {
    consoleLogs = [];
    origConsoleLog = console.log;
    console.log = (...args: unknown[]) => consoleLogs.push(args.join(' '));

    mockRequest.mock.resetCalls();
    mockSpawnHydraNode.mock.resetCalls();
    mockGetAgent.mock.resetCalls();
    mockSyncHydraMd.mock.resetCalls();
    mockPrintNextSteps.mock.resetCalls();
  });

  afterEach(() => {
    console.log = origConsoleLog;
  });

  describe('ensureDaemon', () => {
    it('returns true if daemon is already running', async () => {
      mockRequest.mock.mockImplementation(async () => ({ status: 'ok' }));
      const result = await ensureDaemon('http://localhost:4173');
      assert.equal(result, true);
      // Should not spawn
      assert.equal(mockSpawnHydraNode.mock.callCount(), 0);
    });

    it('spawns daemon and waits for health check', async () => {
      let callCount = 0;
      mockRequest.mock.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error('not running');
        return { status: 'ok' };
      });

      const result = await ensureDaemon('http://localhost:4173');
      assert.equal(result, true);
      assert.equal(mockSpawnHydraNode.mock.callCount(), 1);
    });

    it('returns false if daemon fails to start within timeout', async () => {
      mockRequest.mock.mockImplementation(async () => {
        throw new Error('not running');
      });

      const result = await ensureDaemon('http://localhost:4173');
      assert.equal(result, false);
    });

    it('respects quiet option', async () => {
      let callCount = 0;
      mockRequest.mock.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error('not running');
        return { status: 'ok' };
      });

      // quiet: true should suppress stderr output — verify daemon starts without throwing
      const result = await ensureDaemon('http://localhost:4173', { quiet: true });
      assert.equal(result, true);
    });
  });

  describe('findPowerShell', () => {
    it('returns null on non-windows', () => {
      // process.platform is already linux in this env
      assert.equal(findPowerShell(), null);
    });
  });

  describe('findWindowsTerminal', () => {
    it('returns null on non-windows', () => {
      assert.equal(findWindowsTerminal(), null);
    });
  });

  describe('launchAgentTerminals', () => {
    it('does nothing on non-windows', () => {
      launchAgentTerminals(['claude', 'gemini'], 'http://localhost:4173');
      // No errors thrown
    });

    it('does nothing with empty agent list', () => {
      launchAgentTerminals([], 'http://localhost:4173');
    });
  });

  describe('extractHandoffAgents', () => {
    it('returns empty array when no handoffs', () => {
      assert.deepEqual(extractHandoffAgents({}), []);
    });

    it('returns empty array for null published', () => {
      assert.deepEqual(extractHandoffAgents({ published: null }), []);
    });

    it('returns empty array for empty handoffs', () => {
      assert.deepEqual(extractHandoffAgents({ published: { handoffs: [] } }), []);
    });

    it('extracts unique valid agent names from handoffs', () => {
      mockGetAgent.mock.mockImplementation((name: string) => {
        if (['claude', 'gemini'].includes(name)) return { name, rolePrompt: '', type: 'physical' };
        return null;
      });
      const result = extractHandoffAgents({
        published: {
          handoffs: [
            { to: 'Claude' },
            { to: 'gemini' },
            { to: 'Claude' }, // duplicate
            { to: 'unknown_agent' },
          ],
        },
      });
      assert.ok(result.includes('claude'));
      assert.ok(result.includes('gemini'));
      assert.equal(result.length, 2);
    });

    it('handles handoffs with missing to field', () => {
      const result = extractHandoffAgents({
        published: { handoffs: [{ summary: 'no to field' }] },
      });
      assert.deepEqual(result, []);
    });
  });

  describe('printWelcome', () => {
    it('prints welcome screen', async () => {
      mockRequest.mock.mockImplementation(async () => ({
        activeSession: { status: 'active' },
        inProgressTasks: [],
        pendingHandoffs: [],
        staleTasks: [],
      }));
      mockSyncHydraMd.mock.mockImplementation(() => ({ synced: [] }));

      await printWelcome('http://localhost:4173');
      // Should have printed something
      assert.ok(consoleLogs.length > 0);
    });

    it('shows synced files', async () => {
      mockRequest.mock.mockImplementation(async () => ({
        activeSession: { status: 'active' },
        inProgressTasks: [],
        pendingHandoffs: [],
        staleTasks: [],
      }));
      mockSyncHydraMd.mock.mockImplementation(() => ({
        synced: ['.claude/instructions.md'],
      }));

      await printWelcome('http://localhost:4173');
      assert.ok(consoleLogs.some((l) => l.includes('.claude/instructions.md')));
    });

    it('shows paused session alert', async () => {
      mockRequest.mock.mockImplementation(async () => ({
        activeSession: { status: 'paused', pauseReason: 'manual pause' },
        inProgressTasks: [],
        pendingHandoffs: [],
        staleTasks: [],
      }));

      await printWelcome('http://localhost:4173');
      assert.ok(consoleLogs.some((l) => l.includes('paused') || l.includes('manual pause')));
    });

    it('shows in-progress tasks, handoffs, stale alerts', async () => {
      mockRequest.mock.mockImplementation(async () => ({
        activeSession: { status: 'active' },
        inProgressTasks: [{ id: 't1' }, { id: 't2' }],
        pendingHandoffs: [{ id: 'h1' }],
        staleTasks: [{ id: 's1' }],
      }));

      await printWelcome('http://localhost:4173');
      assert.ok(
        consoleLogs.some(
          (l) => l.includes('2 tasks') || l.includes('1 handoff') || l.includes('1 stale'),
        ),
      );
    });

    it('handles daemon errors gracefully', async () => {
      mockRequest.mock.mockImplementation(async () => {
        throw new Error('daemon down');
      });

      // Should not throw
      await printWelcome('http://localhost:4173');
    });

    it('shows usage stats', async () => {
      mockCheckUsage.mock.mockImplementation(() => ({
        todayTokens: 5000,
        model: 'claude-opus-4',
      }));
      mockGetSessionUsage.mock.mockImplementation(() => ({
        callCount: 3,
        totalTokens: 8000,
        costUsd: 0.05,
      }));
      mockRequest.mock.mockImplementation(async () => ({
        activeSession: { status: 'active' },
        inProgressTasks: [],
        pendingHandoffs: [],
        staleTasks: [],
      }));

      await printWelcome('http://localhost:4173');
      assert.ok(consoleLogs.some((l) => l.includes('5000') || l.includes('tokens')));
    });

    it('shows model summary', async () => {
      mockGetModelSummary.mock.mockImplementation(() => ({
        _mode: 'performance',
        claude: { active: 'claude-opus-4', isOverride: true, reasoningEffort: 'high' },
        gemini: { active: 'gemini-2.5-pro', isOverride: false },
      }));
      mockRequest.mock.mockImplementation(async () => ({
        activeSession: { status: 'active' },
        inProgressTasks: [],
        pendingHandoffs: [],
        staleTasks: [],
      }));

      await printWelcome('http://localhost:4173');
      assert.ok(consoleLogs.some((l) => l.includes('performance') || l.includes('opus')));
    });

    it('shows provider summary', async () => {
      mockGetProviderSummary.mock.mockImplementation(() => ['Anthropic: OK']);
      mockGetExternalSummary.mock.mockImplementation(() => ['Credits: $5.00']);
      mockRequest.mock.mockImplementation(async () => ({
        activeSession: { status: 'active' },
        inProgressTasks: [],
        pendingHandoffs: [],
        staleTasks: [],
      }));

      await printWelcome('http://localhost:4173');
      assert.ok(consoleLogs.some((l) => l.includes('Anthropic') || l.includes('Credits')));
    });

    it('handles syncHydraMd failure gracefully', async () => {
      mockSyncHydraMd.mock.mockImplementation(() => {
        throw new Error('sync failed');
      });
      mockRequest.mock.mockImplementation(async () => ({
        activeSession: { status: 'active' },
        inProgressTasks: [],
        pendingHandoffs: [],
        staleTasks: [],
      }));

      await printWelcome('http://localhost:4173');
      // Should not throw, just skip sync output
    });
  });
});
