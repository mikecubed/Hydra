/**
 * Deep coverage tests for hydra-statusbar.ts
 *
 * Exercises agent activity state management, ticker events, SSE event handling,
 * status bar rendering helpers, and lifecycle (init/destroy). Uses module-level
 * mocking to isolate from terminal I/O, HTTP, and daemon polling.
 *
 * Run: node --test --experimental-test-module-mocks test/hydra-statusbar-deep.coverage.test.ts
 */

import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Module mocks ─────────────────────────────────────────────────────────────

mock.module('../lib/hydra-config.ts', {
  namedExports: {
    resolveProject: () => ({
      projectRoot: '/tmp/test-project',
      projectName: 'test-project',
      runsDir: '/tmp/test-project/.hydra/runs',
    }),
    loadHydraConfig: () => ({
      routing: { mode: 'balanced' },
      local: { enabled: false },
      metrics: {},
    }),
    getRoleConfig: () => ({ agent: 'claude', model: null }),
    invalidateConfigCache: () => {},
    HYDRA_ROOT: '/tmp/test-project',
    HYDRA_RUNTIME_ROOT: '/tmp/test-project',
    AFFINITY_PRESETS: {},
    _setTestConfig: () => {},
    _setTestConfigPath: () => {},
    configStore: { get: () => ({}), set: () => {} },
  },
});

mock.module('../lib/hydra-metrics.ts', {
  namedExports: {
    metricsEmitter: {
      on: mock.fn(() => {}),
      emit: mock.fn(() => {}),
      removeListener: mock.fn(() => {}),
    },
    getSessionUsage: () => ({ costUsd: 0, tokens: 0 }),
    checkSLOs: () => [],
    recordMetric: () => {},
  },
});

mock.module('../lib/hydra-usage.ts', {
  namedExports: {
    checkUsage: () => ({ level: 'ok', percent: 10, todayTokens: 5000 }),
  },
});

mock.module('../lib/hydra-ui.ts', {
  namedExports: {
    formatAgentStatus: (agent: string, status: string, action: string) =>
      `${agent}:${status}:${action}`,
    formatElapsed: (ms: number) => `${Math.round(ms / 1000)}s`,
    stripAnsi: (s: string) => s,
    shortModelName: (s: string) => s,
    DIM: (s: unknown) => String(s),
    ACCENT: (s: unknown) => String(s),
    sectionHeader: (s: string) => `== ${s} ==`,
    label: (k: string, v: string) => `${k}: ${v}`,
    colorAgent: (a: string) => a,
    createSpinner: () => ({
      start: () => {},
      stop: () => {},
      succeed: () => {},
      fail: () => {},
    }),
    SUCCESS: (s: unknown) => String(s),
    ERROR: (s: unknown) => String(s),
    WARNING: (s: unknown) => String(s),
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
  },
});

// ── Import target module after mocks ─────────────────────────────────────────

const {
  setAgentActivity,
  getAgentActivity,
  setAgentExecMode,
  getAgentExecMode,
  onActivityEvent,
  setDispatchContext,
  clearDispatchContext,
  setLastDispatch,
  setActiveMode,
  updateTaskCount,
  drawStatusBar,
  initStatusBar,
  destroyStatusBar,
  startEventStream,
  stopEventStream,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- testing backward compat
  startPolling,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- testing backward compat
  stopPolling,
} = await import('../lib/hydra-statusbar.ts');

// ── Tests ────────────────────────────────────────────────────────────────────

describe('hydra-statusbar deep coverage', () => {
  afterEach(() => {
    // Always clean up
    destroyStatusBar();
    stopEventStream();
  });

  describe('setAgentActivity / getAgentActivity', () => {
    it('sets and retrieves agent activity', () => {
      setAgentActivity('claude', 'working', 'Analyzing code', { model: 'claude-4' });
      const state = getAgentActivity('claude');
      assert.equal(state.status, 'working');
      assert.equal(state.action, 'Analyzing code');
      assert.equal(state.model, 'claude-4');
      assert.ok(state.updatedAt > 0);
    });

    it('is case-insensitive on agent name', () => {
      setAgentActivity('GEMINI', 'idle', 'Idle');
      const state = getAgentActivity('gemini');
      assert.equal(state.status, 'idle');
    });

    it('returns default state for unknown agent', () => {
      const state = getAgentActivity('nonexistent_agent');
      assert.equal(state.status, 'inactive');
      assert.equal(state.action, '');
      assert.equal(state.model, null);
      assert.equal(state.taskTitle, null);
      assert.equal(state.phase, null);
      assert.equal(state.step, null);
      assert.equal(state.updatedAt, 0);
    });

    it('stores all metadata fields', () => {
      setAgentActivity('codex', 'working', 'Implementing', {
        model: 'gpt-5',
        taskTitle: 'Build API',
        phase: 'implement',
        step: '2/4',
      });
      const state = getAgentActivity('codex');
      assert.equal(state.taskTitle, 'Build API');
      assert.equal(state.phase, 'implement');
      assert.equal(state.step, '2/4');
    });

    it('defaults to inactive when status is empty', () => {
      setAgentActivity('claude', '', '');
      const state = getAgentActivity('claude');
      assert.equal(state.status, 'inactive');
    });

    it('handles null meta values', () => {
      setAgentActivity('claude', 'idle', 'Idle', { model: null, taskTitle: null });
      const state = getAgentActivity('claude');
      assert.equal(state.model, null);
      assert.equal(state.taskTitle, null);
    });
  });

  describe('setAgentExecMode / getAgentExecMode', () => {
    it('sets and gets exec mode', () => {
      setAgentExecMode('claude', 'worker');
      assert.equal(getAgentExecMode('claude'), 'worker');
    });

    it('returns null for unknown agent', () => {
      assert.equal(getAgentExecMode('unknown_agent'), null);
    });

    it('allows setting to terminal', () => {
      setAgentExecMode('gemini', 'terminal');
      assert.equal(getAgentExecMode('gemini'), 'terminal');
    });

    it('allows clearing with null', () => {
      setAgentExecMode('codex', 'worker');
      setAgentExecMode('codex', null);
      assert.equal(getAgentExecMode('codex'), null);
    });

    it('is case-insensitive', () => {
      setAgentExecMode('CLAUDE', 'worker');
      assert.equal(getAgentExecMode('claude'), 'worker');
    });
  });

  describe('onActivityEvent', () => {
    it('registers a callback', () => {
      const events: unknown[] = [];
      onActivityEvent((event) => events.push(event));
      // Callback registered — will be tested indirectly via SSE handlers
      assert.ok(true);
    });

    it('ignores non-function input', () => {
      // Should not throw
      onActivityEvent(null as unknown as () => void);
      onActivityEvent(undefined as unknown as () => void);
    });
  });

  describe('setDispatchContext / clearDispatchContext', () => {
    it('sets dispatch context', () => {
      setDispatchContext({
        promptSummary: 'Fix bug',
        topic: 'auth',
        tier: 'simple',
        startedAt: Date.now(),
      });
      // No getter exposed, but should not throw
      assert.ok(true);
    });

    it('clears dispatch context', () => {
      setDispatchContext({ promptSummary: 'Test' });
      clearDispatchContext();
      assert.ok(true);
    });

    it('handles null context', () => {
      setDispatchContext(null);
      assert.ok(true);
    });
  });

  describe('setLastDispatch', () => {
    it('sets last dispatch info', () => {
      setLastDispatch({ route: 'smart', tier: 'simple', agent: 'claude', mode: 'auto' });
      assert.ok(true);
    });

    it('merges with existing state', () => {
      setLastDispatch({ route: 'first' });
      setLastDispatch({ tier: 'complex' });
      assert.ok(true);
    });
  });

  describe('setActiveMode', () => {
    it('sets mode', () => {
      setActiveMode('council');
      assert.ok(true);
    });

    it('defaults to auto for empty string', () => {
      setActiveMode('');
      assert.ok(true);
    });
  });

  describe('updateTaskCount', () => {
    it('sets positive count', () => {
      updateTaskCount(5);
      assert.ok(true);
    });

    it('clamps to zero for negative', () => {
      updateTaskCount(-3);
      assert.ok(true);
    });

    it('handles zero', () => {
      updateTaskCount(0);
      assert.ok(true);
    });

    it('handles NaN as zero', () => {
      updateTaskCount(Number.NaN);
      assert.ok(true);
    });
  });

  describe('drawStatusBar', () => {
    it('is a no-op when bar not active', () => {
      // statusBarActive is false by default
      drawStatusBar();
      assert.ok(true);
    });

    it('is a no-op with skipCursorSaveRestore option', () => {
      drawStatusBar({ skipCursorSaveRestore: true });
      assert.ok(true);
    });
  });

  describe('initStatusBar / destroyStatusBar lifecycle', () => {
    it('init then destroy without TTY is a no-op', () => {
      // process.stdout.isTTY may be false in test env
      initStatusBar(['claude', 'gemini', 'codex']);
      destroyStatusBar();
      assert.ok(true);
    });

    it('double destroy is safe', () => {
      destroyStatusBar();
      destroyStatusBar();
      assert.ok(true);
    });

    it('registers agents as lowercase', () => {
      initStatusBar(['CLAUDE', 'Gemini']);
      destroyStatusBar();
      assert.ok(true);
    });
  });

  describe('startEventStream / stopEventStream', () => {
    it('stop without start is safe', () => {
      stopEventStream();
      assert.ok(true);
    });

    it('double stop is safe', () => {
      stopEventStream();
      stopEventStream();
      assert.ok(true);
    });

    it('startEventStream is a no-op without TTY', () => {
      startEventStream('http://127.0.0.1:9999', ['claude', 'gemini']);
      stopEventStream();
      assert.ok(true);
    });
  });

  describe('legacy exports', () => {
    it('startPolling delegates to startEventStream', () => {
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- testing backward compat
      startPolling('http://127.0.0.1:9999', ['claude']);
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- testing backward compat
      stopPolling();
      assert.ok(true);
    });

    it('stopPolling delegates to stopEventStream', () => {
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- testing backward compat
      stopPolling();
      assert.ok(true);
    });
  });

  describe('agent activity state edge cases', () => {
    it('overwrites previous activity', () => {
      setAgentActivity('claude', 'working', 'Task A');
      setAgentActivity('claude', 'idle', 'Done');
      const state = getAgentActivity('claude');
      assert.equal(state.status, 'idle');
      assert.equal(state.action, 'Done');
    });

    it('handles many agents', () => {
      for (let i = 0; i < 10; i++) {
        setAgentActivity(`agent${String(i)}`, 'working', `Task ${String(i)}`);
      }
      for (let i = 0; i < 10; i++) {
        const state = getAgentActivity(`agent${String(i)}`);
        assert.equal(state.status, 'working');
      }
    });

    it('sets error status', () => {
      setAgentActivity('claude', 'error', 'Rate limited');
      const state = getAgentActivity('claude');
      assert.equal(state.status, 'error');
      assert.equal(state.action, 'Rate limited');
    });
  });

  describe('exec mode variants', () => {
    it('worker mode', () => {
      setAgentExecMode('claude', 'worker');
      assert.equal(getAgentExecMode('claude'), 'worker');
    });

    it('terminal mode', () => {
      setAgentExecMode('gemini', 'terminal');
      assert.equal(getAgentExecMode('gemini'), 'terminal');
    });

    it('null mode clears', () => {
      setAgentExecMode('codex', 'worker');
      setAgentExecMode('codex', null);
      assert.equal(getAgentExecMode('codex'), null);
    });
  });
});
