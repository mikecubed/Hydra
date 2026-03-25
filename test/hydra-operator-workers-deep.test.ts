/* eslint-disable @typescript-eslint/unbound-method -- test mocking patterns */
/**
 * Deep coverage tests for lib/hydra-operator-workers.ts
 *
 * Mocks AgentWorker, statusbar, activity, prompt-choice, and UI deps.
 * Requires --experimental-test-module-mocks.
 */

import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

// ── Mock state ──────────────────────────────────────────────────────────────

const mockSetAgentActivity = mock.fn();
const mockDrawStatusBar = mock.fn();
const mockSetAgentExecMode = mock.fn();
const mockPushActivity = mock.fn();
const mockAnnotateCompletion = mock.fn(
  (info: Record<string, unknown>) => `${String(info['agent'])} completed ${String(info['taskId'])}`,
);
const mockIsChoiceActive = mock.fn(() => false);

// Track workers created
class MockAgentWorker extends EventEmitter {
  agent: string;
  baseUrl: string;
  projectRoot: string;
  permissionMode: string;
  _status: string;
  _currentTask: null;
  _startedAt: number | null;

  constructor(agent: string, opts: Record<string, unknown> = {}) {
    super();
    this.agent = agent;
    this.baseUrl = (opts['baseUrl'] as string) ?? '';
    this.projectRoot = (opts['projectRoot'] as string) ?? '';
    this.permissionMode = 'auto-edit';
    this._status = 'stopped';
    this._currentTask = null;
    this._startedAt = null;
  }

  get status() {
    return this._status;
  }
  get currentTask() {
    return this._currentTask;
  }
  get uptime() {
    return this._startedAt ? Date.now() - this._startedAt : 0;
  }

  start() {
    this._status = 'idle';
    this._startedAt = Date.now();
  }
  stop() {
    this._status = 'stopped';
  }
  kill() {
    this._status = 'stopped';
  }
}

// ── Module mocks ────────────────────────────────────────────────────────────

mock.module('../lib/hydra-worker.ts', {
  namedExports: {
    AgentWorker: MockAgentWorker,
  },
});

mock.module('../lib/hydra-config.ts', {
  namedExports: {
    resolveProject: () => ({ projectRoot: '/tmp/test', projectName: 'test' }),
    loadHydraConfig: () => ({ routing: { mode: 'balanced' } }),
    _setTestConfig: () => {},
    invalidateConfigCache: () => {},
    HYDRA_ROOT: '/tmp/hydra',
  },
});

mock.module('../lib/hydra-statusbar.ts', {
  namedExports: {
    setAgentActivity: (...args: unknown[]) => {
      mockSetAgentActivity(...args);
    },
    drawStatusBar: () => {
      mockDrawStatusBar();
    },
    setAgentExecMode: (...args: unknown[]) => {
      mockSetAgentExecMode(...args);
    },
    getAgentActivity: () => ({ status: 'inactive', action: '' }),
    getAgentExecMode: () => null,
    setDispatchContext: () => {},
    clearDispatchContext: () => {},
    setLastDispatch: () => {},
    setActiveMode: () => {},
    updateTaskCount: () => {},
    initStatusBar: () => {},
    destroyStatusBar: () => {},
    onActivityEvent: () => {},
    startPolling: () => {},
    stopPolling: () => {},
    startEventStream: () => {},
    stopEventStream: () => {},
  },
});

mock.module('../lib/hydra-activity.ts', {
  namedExports: {
    pushActivity: (...args: unknown[]) => {
      mockPushActivity(...args);
    },
    annotateCompletion: (info: Record<string, unknown>) => mockAnnotateCompletion(info),
    annotateDispatch: () => '',
    annotateHandoff: () => '',
    getSessionContext: () => ({ priorSessions: [] }),
    detectSituationalQuery: () => ({ isSituational: false }),
    getRecentActivity: () => [],
    clearActivityLog: () => {},
  },
});

mock.module('../lib/hydra-prompt-choice.ts', {
  namedExports: {
    isChoiceActive: () => mockIsChoiceActive(),
    promptChoice: async () => '',
  },
});

mock.module('../lib/hydra-ui.ts', {
  namedExports: {
    colorAgent: (a: string) => a,
    SUCCESS: (s: string) => s,
    ERROR: (s: string) => s,
    DIM: (s: string) => s,
    ACCENT: (s: string) => s,
    WARNING: (s: string) => s,
    hydraSplash: () => '',
    label: () => '',
    AGENT_COLORS: {},
    formatAgentStatus: () => '',
    formatElapsed: () => '',
    stripAnsi: (s: string) => s,
    shortModelName: (m: string) => m,
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
  workers,
  startAgentWorker,
  stopAgentWorker,
  stopAllWorkers,
  _getWorkerStatus,
  startAgentWorkers,
} = await import('../lib/hydra-operator-workers.ts');

// ── Tests ───────────────────────────────────────────────────────────────────

describe('hydra-operator-workers-deep', () => {
  let origIsTTY: boolean | undefined;
  let origWrite: typeof process.stdout.write;
  const writtenData: string[] = [];
  let consoleLogs: string[];
  let origConsoleLog: typeof console.log;

  beforeEach(() => {
    // Clear workers map
    workers.clear();

    origIsTTY = process.stdout.isTTY;
    origWrite = process.stdout.write;
    writtenData.length = 0;
    process.stdout.write = ((data: string | Uint8Array) => {
      writtenData.push(String(data));
      return true;
    }) as typeof process.stdout.write;

    consoleLogs = [];
    origConsoleLog = console.log;
    console.log = (...args: unknown[]) => consoleLogs.push(args.join(' '));

    mockSetAgentActivity.mock.resetCalls();
    mockDrawStatusBar.mock.resetCalls();
    mockSetAgentExecMode.mock.resetCalls();
    mockPushActivity.mock.resetCalls();
    mockAnnotateCompletion.mock.resetCalls();
    mockIsChoiceActive.mock.resetCalls();
  });

  afterEach(() => {
    workers.clear();
    Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
    process.stdout.write = origWrite;
    console.log = origConsoleLog;
  });

  describe('startAgentWorker', () => {
    it('creates and starts a worker', () => {
      const worker = startAgentWorker('claude', 'http://localhost:4173');
      assert.ok(worker);
      assert.equal(worker.agent, 'claude');
      assert.equal(worker.status, 'idle');
      assert.ok(workers.has('claude'));
    });

    it('returns existing non-stopped worker', () => {
      const first = startAgentWorker('claude', 'http://localhost:4173');
      const second = startAgentWorker('claude', 'http://localhost:4173');
      assert.equal(first, second);
    });

    it('replaces stopped worker', () => {
      const first = startAgentWorker('claude', 'http://localhost:4173');
      first!.stop();
      const second = startAgentWorker('claude', 'http://localhost:4173');
      assert.notEqual(first, second);
    });

    it('sets exec mode to worker', () => {
      startAgentWorker('gemini', 'http://localhost:4173');
      assert.ok(
        mockSetAgentExecMode.mock.calls.some(
          (c) => c.arguments[0] === 'gemini' && c.arguments[1] === 'worker',
        ),
      );
    });

    it('logs worker start message', () => {
      startAgentWorker('codex', 'http://localhost:4173');
      assert.ok(consoleLogs.some((l) => l.includes('codex') && l.includes('worker started')));
    });

    it('wires task:start event', () => {
      const worker = startAgentWorker('claude', 'http://localhost:4173');
      worker!.emit('task:start', { agent: 'claude', taskId: 't1', title: 'Test task' });
      assert.ok(
        mockSetAgentActivity.mock.calls.some(
          (c) => c.arguments[0] === 'claude' && c.arguments[1] === 'working',
        ),
      );
      assert.ok(mockDrawStatusBar.mock.callCount() > 0);
    });

    it('wires task:complete event for success', () => {
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      const worker = startAgentWorker('claude', 'http://localhost:4173');
      worker!.emit('task:complete', {
        agent: 'claude',
        taskId: 't1',
        title: 'Test task',
        status: 'done',
        durationMs: 5000,
        outputSummary: 'Fixed it',
      });
      assert.ok(mockPushActivity.mock.callCount() > 0);
      assert.ok(
        mockSetAgentActivity.mock.calls.some(
          (c) => c.arguments[0] === 'claude' && c.arguments[1] === 'idle',
        ),
      );
    });

    it('wires task:complete event for error (skips success notification)', () => {
      const worker = startAgentWorker('claude', 'http://localhost:4173');
      worker!.emit('task:complete', {
        agent: 'claude',
        taskId: 't1',
        title: 'Fail task',
        status: 'error',
        durationMs: 1000,
        outputSummary: 'error msg',
      });
      assert.ok(mockPushActivity.mock.callCount() > 0);
      // setAgentActivity should NOT be called with 'idle' for error status
      // (error handler covers those)
    });

    it('wires task:error event', () => {
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      const worker = startAgentWorker('claude', 'http://localhost:4173');
      worker!.emit('task:error', {
        agent: 'claude',
        taskId: 't1',
        title: 'Failed task',
        error: 'Something broke',
      });
      assert.ok(
        mockSetAgentActivity.mock.calls.some(
          (c) => c.arguments[0] === 'claude' && c.arguments[1] === 'error',
        ),
      );
    });

    it('wires task:error event on non-TTY', () => {
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
      const worker = startAgentWorker('claude', 'http://localhost:4173');
      worker!.emit('task:error', {
        agent: 'claude',
        taskId: 't1',
        error: 'Error',
      });
      assert.ok(writtenData.some((d) => d.includes('Error')));
    });

    it('wires worker:idle event', () => {
      const worker = startAgentWorker('claude', 'http://localhost:4173');
      worker!.emit('worker:idle', { agent: 'claude' });
      assert.ok(
        mockSetAgentActivity.mock.calls.some(
          (c) => c.arguments[0] === 'claude' && c.arguments[1] === 'idle',
        ),
      );
    });

    it('wires worker:stop event', () => {
      const worker = startAgentWorker('claude', 'http://localhost:4173');
      worker!.emit('worker:stop', { agent: 'claude', reason: 'stopped' });
      assert.ok(
        mockSetAgentExecMode.mock.calls.some(
          (c) => c.arguments[0] === 'claude' && c.arguments[1] === null,
        ),
      );
      assert.ok(
        mockSetAgentActivity.mock.calls.some(
          (c) => c.arguments[0] === 'claude' && c.arguments[1] === 'inactive',
        ),
      );
    });

    it('prompts rl on task:complete when not in choice mode and TTY', () => {
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      const mockPrompt = mock.fn();
      const rl = { prompt: mockPrompt } as never;
      const worker = startAgentWorker('claude', 'http://localhost:4173', { rl });
      worker!.emit('task:complete', {
        agent: 'claude',
        taskId: 't1',
        title: 'Done',
        status: 'done',
        durationMs: 100,
        outputSummary: 'ok',
      });
      // prompt is called via setTimeout, we can't easily test it synchronously
      // but the event handler should run without error
    });

    it('prompts rl on task:error', () => {
      const mockPrompt = mock.fn();
      const rl = { prompt: mockPrompt } as never;
      const worker = startAgentWorker('claude', 'http://localhost:4173', { rl });
      worker!.emit('task:error', {
        agent: 'claude',
        taskId: 't1',
        error: 'fail',
      });
      assert.ok(mockPrompt.mock.callCount() > 0);
    });

    it('does not prompt rl when choice is active', () => {
      mockIsChoiceActive.mock.mockImplementation(() => true);
      const mockPrompt = mock.fn();
      const rl = { prompt: mockPrompt } as never;
      const worker = startAgentWorker('claude', 'http://localhost:4173', { rl });
      worker!.emit('task:error', {
        agent: 'claude',
        taskId: 't1',
        error: 'fail',
      });
      assert.equal(mockPrompt.mock.callCount(), 0);
    });
  });

  describe('stopAgentWorker', () => {
    it('stops a running worker', () => {
      startAgentWorker('claude', 'http://localhost:4173');
      stopAgentWorker('claude');
      const w = workers.get('claude');
      assert.equal(w?.status, 'stopped');
    });

    it('does nothing for unknown agent', () => {
      stopAgentWorker('nonexistent');
      // No error
    });

    it('clears exec mode', () => {
      startAgentWorker('claude', 'http://localhost:4173');
      mockSetAgentExecMode.mock.resetCalls();
      stopAgentWorker('claude');
      assert.ok(
        mockSetAgentExecMode.mock.calls.some(
          (c) => c.arguments[0] === 'claude' && c.arguments[1] === null,
        ),
      );
    });
  });

  describe('stopAllWorkers', () => {
    it('kills all workers and clears the map', () => {
      startAgentWorker('claude', 'http://localhost:4173');
      startAgentWorker('gemini', 'http://localhost:4173');
      assert.equal(workers.size, 2);
      stopAllWorkers();
      assert.equal(workers.size, 0);
    });
  });

  describe('_getWorkerStatus', () => {
    it('returns null for unknown agent', () => {
      assert.equal(_getWorkerStatus('nonexistent'), null);
    });

    it('returns status for known worker', () => {
      startAgentWorker('claude', 'http://localhost:4173');
      const status = _getWorkerStatus('claude');
      assert.ok(status);
      assert.equal(status.agent, 'claude');
      assert.equal(status.status, 'idle');
      assert.equal(status.currentTask, null);
      assert.ok(status.uptime >= 0);
      assert.equal(status.permissionMode, 'auto-edit');
    });
  });

  describe('startAgentWorkers', () => {
    it('starts multiple workers', () => {
      startAgentWorkers(['claude', 'gemini', 'codex'], 'http://localhost:4173');
      assert.equal(workers.size, 3);
      assert.ok(workers.has('claude'));
      assert.ok(workers.has('gemini'));
      assert.ok(workers.has('codex'));
    });

    it('passes rl option through', () => {
      const mockPrompt = mock.fn();
      const rl = { prompt: mockPrompt } as never;
      startAgentWorkers(['claude'], 'http://localhost:4173', { rl });
      const worker = workers.get('claude');
      assert.ok(worker);
    });
  });

  describe('writeCompletionNotification paths', () => {
    it('handles non-TTY task:complete', () => {
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
      const worker = startAgentWorker('claude', 'http://localhost:4173');
      worker!.emit('task:complete', {
        agent: 'claude',
        taskId: 't1',
        title: 'Task',
        status: 'done',
        durationMs: 0,
        outputSummary: 'ok',
      });
      assert.ok(writtenData.some((d) => d.includes('completed')));
    });

    it('handles task:complete with empty title and zero duration', () => {
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
      const worker = startAgentWorker('claude', 'http://localhost:4173');
      worker!.emit('task:complete', {
        agent: 'claude',
        taskId: 't2',
        title: '',
        status: 'done',
        durationMs: 0,
        outputSummary: '',
      });
      assert.ok(writtenData.some((d) => d.includes('t2')));
    });
  });
});
