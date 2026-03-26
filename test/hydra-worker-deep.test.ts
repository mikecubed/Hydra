/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any -- mock.module() typing is intentionally loose for test isolation */
/**
 * Deep coverage tests for lib/hydra-worker.ts
 *
 * Mocks all I/O: HTTP requests, agent execution, config loading, agent lookup.
 * Requires --experimental-test-module-mocks.
 */

import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock state ──────────────────────────────────────────────────────────────

const mockRequestFn = mock.fn(async () => ({}));
const mockExecuteAgentFn = mock.fn(
  async () =>
    ({
      ok: true,
      output: 'done',
      stdout: 'done',
      stderr: '',
      error: '',
      exitCode: 0,
      signal: null,
    }) as Record<string, unknown>,
);
const mockGetAgentFn = mock.fn((name: string) =>
  name ? { name, rolePrompt: `You are ${name}.`, type: 'physical' } : null,
);
const mockLoadConfigFn = mock.fn(() => ({
  workers: {
    permissionMode: 'auto-edit',
    pollIntervalMs: 10,
    maxOutputBufferKB: 8,
    autoChain: true,
    heartbeatIntervalMs: 50000,
    concurrency: { adaptivePolling: true, maxInFlight: 3 },
  },
}));

const mockDetectModelError = mock.fn(() => ({ isModelError: false }));
const mockRecoverFromModelError = mock.fn(async () => ({
  recovered: false,
  newModel: null,
}));
const mockDetectCodexError = mock.fn(() => ({ isCodexError: false }));
const mockDetectUsageLimitError = mock.fn(() => ({
  isUsageLimit: false,
  errorMessage: '',
  resetInSeconds: 0,
}));
const mockFormatResetTime = mock.fn((s: number) => `${String(s)}s`);

// ── Module mocks ────────────────────────────────────────────────────────────

mock.module('../lib/hydra-utils.ts', {
  namedExports: {
    // @ts-expect-error spread in mock context
    request: (...args: unknown[]) => mockRequestFn(...args),
    short: (s: string | undefined, n?: number) => (s == null ? '' : s.slice(0, n ?? 200)),
  },
});

mock.module('../lib/hydra-agents.ts', {
  namedExports: {
    getAgent: (name: string) => mockGetAgentFn(name),
    getActiveModel: () => 'test-model',
    getReasoningEffort: () => null,
    AGENT_NAMES: ['claude', 'gemini', 'codex'],
    AGENTS: {},
    AGENT_TYPE: { physical: 'physical', virtual: 'virtual' },
    initAgentRegistry: () => {},
    _resetRegistry: () => {},
    getMode: () => 'balanced',
    formatEffortDisplay: () => '',
    registerAgent: () => {},
    unregisterAgent: () => {},
    getModelSummary: () => ({}),
  },
});

mock.module('../lib/hydra-config.ts', {
  namedExports: {
    loadHydraConfig: () => mockLoadConfigFn(),
    resolveProject: () => ({ projectRoot: '/tmp/test', projectName: 'test' }),
    _setTestConfig: () => {},
    invalidateConfigCache: () => {},
    HYDRA_ROOT: '/tmp/hydra',
  },
});

mock.module('../lib/hydra-shared/agent-executor.ts', {
  namedExports: {
    // @ts-expect-error spread in mock context
    executeAgent: (...args: unknown[]) => mockExecuteAgentFn(...args),
  },
});

mock.module('../lib/hydra-model-recovery.ts', {
  namedExports: {
    // @ts-expect-error spread in mock context
    detectModelError: (...args: unknown[]) => mockDetectModelError(...args),
    // @ts-expect-error spread in mock context
    recoverFromModelError: (...args: unknown[]) => mockRecoverFromModelError(...args),
    // @ts-expect-error spread in mock context
    detectCodexError: (...args: unknown[]) => mockDetectCodexError(...args),
    // @ts-expect-error spread in mock context
    detectUsageLimitError: (...args: unknown[]) => mockDetectUsageLimitError(...args),
    formatResetTime: (s: number) => mockFormatResetTime(s),
    isModelRecoveryEnabled: () => true,
    resetCircuitBreaker: () => {},
    recordModelFailure: () => {},
    isCircuitOpen: () => false,
    detectRateLimitError: () => ({ isRateLimit: false }),
    calculateBackoff: () => 1000,
  },
});

// ── Import under test (AFTER mocks) ────────────────────────────────────────

const { AgentWorker, getWorkerConcurrencyStats } = await import('../lib/hydra-worker.ts');

// ── Tests ───────────────────────────────────────────────────────────────────

describe('hydra-worker-deep', () => {
  beforeEach(() => {
    mockRequestFn.mock.resetCalls();
    mockExecuteAgentFn.mock.resetCalls();
    mockGetAgentFn.mock.resetCalls();
    mockLoadConfigFn.mock.resetCalls();
    mockDetectModelError.mock.resetCalls();
    mockRecoverFromModelError.mock.resetCalls();
    mockDetectCodexError.mock.resetCalls();
    mockDetectUsageLimitError.mock.resetCalls();
    mockFormatResetTime.mock.resetCalls();
  });

  describe('getWorkerConcurrencyStats', () => {
    it('returns stats with zero active tasks', () => {
      const stats = getWorkerConcurrencyStats();
      assert.equal(typeof stats.active, 'number');
      assert.equal(typeof stats.maxInFlight, 'number');
      assert.equal(typeof stats.utilization, 'number');
    });
  });

  describe('AgentWorker constructor', () => {
    it('creates worker with default config', () => {
      const w = new AgentWorker('Claude');
      assert.equal(w.agent, 'claude');
      assert.equal(w.status, 'stopped');
      assert.equal(w.currentTask, null);
      assert.equal(w.uptime, 0);
    });

    it('creates worker with explicit options', () => {
      const w = new AgentWorker('gemini', {
        baseUrl: 'http://localhost:9999',
        projectRoot: '/tmp/proj',
        permissionMode: 'full-auto',
        autoChain: false,
      });
      assert.equal(w.agent, 'gemini');
      assert.equal(w.baseUrl, 'http://localhost:9999');
      assert.equal(w.projectRoot, '/tmp/proj');
      assert.equal(w.permissionMode, 'full-auto');
      assert.equal(w.autoChain, false);
    });

    it('falls back to defaults if config loading throws', () => {
      mockLoadConfigFn.mock.mockImplementation(() => {
        throw new Error('config error');
      });
      const w = new AgentWorker('claude');
      assert.equal(w.permissionMode, 'auto-edit');
      // Restore
      mockLoadConfigFn.mock.mockImplementation(() => ({
        workers: {
          permissionMode: 'auto-edit',
          pollIntervalMs: 10,
          maxOutputBufferKB: 8,
          autoChain: true,
          heartbeatIntervalMs: 50000,
          concurrency: { adaptivePolling: true, maxInFlight: 3 },
        },
      }));
    });
  });

  describe('start / stop / kill lifecycle', () => {
    it('start() sets status to idle and emits worker:start', () => {
      const w = new AgentWorker('claude', { baseUrl: 'http://x' });
      const events: string[] = [];
      w.on('worker:start', () => events.push('start'));
      // Mock _workLoop to not actually loop
      w._workLoop = async () => {};
      w.start();
      assert.equal(w.status, 'idle');
      assert.ok(events.includes('start'));
      assert.ok(w.uptime >= 0);
      w.stop();
    });

    it('start() is no-op if already idle or working', () => {
      const w = new AgentWorker('claude', { baseUrl: 'http://x' });
      w._workLoop = async () => {};
      w.start();
      const firstStartedAt = w._startedAt;
      w.start(); // second call — should be no-op
      assert.equal(w._startedAt, firstStartedAt);
      w.stop();
    });

    it('stop() sets status to stopped when idle', () => {
      const w = new AgentWorker('claude', { baseUrl: 'http://x' });
      w._workLoop = async () => {};
      w.start();
      const events: string[] = [];
      w.on('worker:stop', () => events.push('stop'));
      w.stop();
      assert.equal(w.status, 'stopped');
      assert.ok(events.includes('stop'));
    });

    it('stop() sets _stopped flag when working', () => {
      const w = new AgentWorker('claude', { baseUrl: 'http://x' });
      w._status = 'working';
      w.stop();
      assert.ok(w._stopped);
      // Status doesn't change to stopped immediately when working
      assert.equal(w._status, 'working');
    });

    it('kill() stops immediately and emits worker:stop with killed reason', () => {
      const w = new AgentWorker('claude', { baseUrl: 'http://x' });
      const events: Array<{ reason: string }> = [];
      w.on('worker:stop', (e: { reason: string }) => events.push(e));
      w.kill();
      assert.equal(w.status, 'stopped');
      assert.equal(w.currentTask, null);
      assert.equal(events[0]?.reason, 'killed');
    });

    it('kill() kills child process if present', () => {
      const w = new AgentWorker('claude', { baseUrl: 'http://x' });
      const killed: string[] = [];
      w._childProcess = {
        kill: (sig: string) => killed.push(sig),
      } as never;
      w.kill();
      assert.deepEqual(killed, ['SIGTERM']);
      assert.equal(w._childProcess, null);
    });
  });

  describe('setPermissionMode', () => {
    it('updates permission mode', () => {
      const w = new AgentWorker('claude');
      w.setPermissionMode('full-auto');
      assert.equal(w.permissionMode, 'full-auto');
    });
  });

  describe('_buildTaskPrompt', () => {
    it('returns default for null task', () => {
      const w = new AgentWorker('claude');
      assert.equal(w._buildTaskPrompt(null), 'Continue assigned work.');
    });

    it('builds prompt from task fields', () => {
      const w = new AgentWorker('claude');
      const prompt = w._buildTaskPrompt({
        title: 'Fix bug',
        notes: 'Check the parser',
        done: 'All tests pass',
      });
      assert.ok(prompt.includes('Task: Fix bug'));
      assert.ok(prompt.includes('Notes: Check the parser'));
      assert.ok(prompt.includes('Definition of Done: All tests pass'));
      assert.ok(prompt.includes('Execute this task'));
    });

    it('uses preferred agent rolePrompt if available', () => {
      mockGetAgentFn.mock.mockImplementation((name: string) => {
        if (name === 'architect')
          return { name: 'architect', rolePrompt: 'You are the architect.', type: 'virtual' };
        return { name, rolePrompt: `You are ${name}.`, type: 'physical' };
      });
      const w = new AgentWorker('claude');
      const prompt = w._buildTaskPrompt({
        title: 'Design API',
        preferredAgent: 'architect',
      });
      assert.ok(prompt.includes('You are the architect.'));
    });

    it('falls back to own rolePrompt if preferredAgent has no rolePrompt', () => {
      mockGetAgentFn.mock.mockImplementation((name: string) => {
        if (name === 'noop') return { name: 'noop', rolePrompt: '', type: 'virtual' };
        return { name, rolePrompt: `You are ${name}.`, type: 'physical' };
      });
      const w = new AgentWorker('claude');
      const prompt = w._buildTaskPrompt({
        title: 'Task',
        preferredAgent: 'noop',
      });
      assert.ok(prompt.includes('You are claude.'));
    });

    it('handles non-string notes and done fields', () => {
      const w = new AgentWorker('claude');
      const prompt = w._buildTaskPrompt({
        title: 'Test',
        notes: { key: 'value' },
        done: ['a', 'b'],
      });
      assert.ok(prompt.includes('Notes:'));
      assert.ok(prompt.includes('Definition of Done:'));
    });
  });

  describe('_pollNext', () => {
    it('returns next action from daemon', async () => {
      mockRequestFn.mock.mockImplementation(async () => ({
        next: { action: 'claim_owned_task', task: { id: 't1', title: 'Test task' } },
      }));
      const w = new AgentWorker('claude', { baseUrl: 'http://localhost:4173' });
      const result = await w._pollNext();
      assert.deepEqual(result?.action, 'claim_owned_task');
    });

    it('returns null on error', async () => {
      mockRequestFn.mock.mockImplementation(async () => {
        throw new Error('network error');
      });
      const w = new AgentWorker('claude', { baseUrl: 'http://localhost:4173' });
      const result = await w._pollNext();
      assert.equal(result, null);
    });

    it('returns null when response has no next field', async () => {
      mockRequestFn.mock.mockImplementation(async () => ({}));
      const w = new AgentWorker('claude', { baseUrl: 'http://localhost:4173' });
      const result = await w._pollNext();
      assert.equal(result, null);
    });
  });

  describe('_executeAgent', () => {
    it('calls executeAgent with correct args', async () => {
      const w = new AgentWorker('claude', {
        baseUrl: 'http://localhost:4173',
        projectRoot: '/tmp/proj',
      });
      await w._executeAgent('test prompt');
      assert.equal(mockExecuteAgentFn.mock.callCount(), 1);
      const callArgs = mockExecuteAgentFn.mock.calls[0]?.arguments;
      assert.equal((callArgs as any)?.[0], 'claude');
      assert.equal((callArgs as any)?.[1], 'test prompt');
    });
  });

  describe('_sleep', () => {
    it('resolves after given ms', async () => {
      const w = new AgentWorker('claude');
      // Use a very short sleep to avoid blocking
      await w._sleep(1);
      assert.ok(true, '_sleep resolved');
    });
  });

  describe('_adjustPollInterval (adaptive polling)', () => {
    it('does nothing when adaptivePolling is false', () => {
      const w = new AgentWorker('claude');
      w.adaptivePolling = false;
      const orig = w.pollIntervalMs;
      // access private method via prototype
      (w as any)._adjustPollInterval();
      assert.equal(w.pollIntervalMs, orig);
    });
  });

  describe('_workLoop integration', () => {
    /** Make _sleep resolve immediately so work-loop tests don't hang. */
    function patchSleep(w: InstanceType<typeof AgentWorker>) {
      w._sleep = () => Promise.resolve();
    }

    it('handles idle response', async () => {
      const events: string[] = [];
      const w = new AgentWorker('claude', { baseUrl: 'http://x' });
      patchSleep(w);
      w.on('worker:idle', () => events.push('idle'));
      let pollCount = 0;
      mockRequestFn.mock.mockImplementation(async () => {
        pollCount++;
        if (pollCount >= 2) w._stopped = true;
        return { next: { action: 'idle' } };
      });
      await w._workLoop();
      assert.ok(events.includes('idle'));
      assert.equal(w.status, 'stopped');
    });

    it('handles task claim and execution', async () => {
      const events: string[] = [];
      const w = new AgentWorker('claude', { baseUrl: 'http://x' });
      patchSleep(w);
      w.autoChain = false;
      w.on('task:start', () => events.push('start'));
      w.on('task:complete', () => events.push('complete'));

      let pollCount = 0;
      // @ts-expect-error mock implementation with flexible signature
      mockRequestFn.mock.mockImplementation(async (_m: unknown, _b: unknown, path: unknown) => {
        if (typeof path === 'string' && path.startsWith('/next')) {
          pollCount++;
          if (pollCount === 1) {
            return {
              next: {
                action: 'claim_owned_task',
                task: { id: 't1', title: 'Test task' },
              },
            };
          }
          return { next: { action: 'idle' } };
        }
        return {};
      });

      mockExecuteAgentFn.mock.mockImplementation(async () => ({
        ok: true,
        output: 'done',
        stdout: 'done',
        stderr: '',
        error: '',
        exitCode: 0,
        signal: null,
      }));

      await w._workLoop();
      assert.ok(events.includes('start'));
      assert.ok(events.includes('complete'));
    });

    it('handles handoff pickup', async () => {
      const events: string[] = [];
      const w = new AgentWorker('claude', { baseUrl: 'http://x' });
      patchSleep(w);
      w.autoChain = false;
      w.on('task:start', () => events.push('start'));
      w.on('task:complete', () => events.push('complete'));

      let pollCount = 0;
      // @ts-expect-error mock implementation with flexible signature
      mockRequestFn.mock.mockImplementation(async (_m: unknown, _b: unknown, path: unknown) => {
        if (typeof path === 'string' && path.startsWith('/next')) {
          pollCount++;
          if (pollCount === 1) {
            return {
              next: {
                action: 'pickup_handoff',
                handoff: {
                  id: 'h1',
                  summary: 'Continue work',
                  tasks: ['t2'],
                },
              },
            };
          }
          return { next: { action: 'idle' } };
        }
        return {};
      });

      mockExecuteAgentFn.mock.mockImplementation(async () => ({
        ok: true,
        output: 'done',
        stdout: 'done',
        stderr: '',
        error: '',
        exitCode: 0,
        signal: null,
      }));

      await w._workLoop();
      assert.ok(events.includes('start'));
      assert.ok(events.includes('complete'));
    });

    it('skips previously failed tasks', async () => {
      const w = new AgentWorker('claude', { baseUrl: 'http://x' });
      patchSleep(w);
      w.autoChain = false;
      w._failedTasks.add('t-fail');

      let pollCount = 0;
      // @ts-expect-error mock implementation with flexible signature
      mockRequestFn.mock.mockImplementation(async (_m: unknown, _b: unknown, path: unknown) => {
        if (typeof path === 'string' && path.startsWith('/next')) {
          pollCount++;
          if (pollCount === 1) {
            return {
              next: {
                action: 'claim_owned_task',
                task: { id: 't-fail', title: 'Failed task' },
              },
            };
          }
          // After skip, stop the loop
          w._stopped = true;
          return { next: { action: 'idle' } };
        }
        return {};
      });

      await w._workLoop();
      // Task should have been skipped (marked as blocked)
      assert.equal(w.status, 'stopped');
    });

    it('handles error in work loop catch branch', async () => {
      const w = new AgentWorker('claude', { baseUrl: 'http://x' });
      patchSleep(w);
      const errorEvents: Array<{ error: string }> = [];
      w.on('task:error', (e: { error: string }) => errorEvents.push(e));

      // Return a valid task action so _resolveWorkItem is called.
      // Then make _executeAgent throw to trigger the catch block.
      let pollCount = 0;
      // @ts-expect-error mock implementation with flexible signature
      mockRequestFn.mock.mockImplementation(async (_m: unknown, _b: unknown, path: unknown) => {
        if (typeof path === 'string' && path.startsWith('/next')) {
          pollCount++;
          if (pollCount === 1) {
            return {
              next: {
                action: 'claim_owned_task',
                task: { id: 'terr', title: 'Error task' },
              },
            };
          }
          w._stopped = true;
          return { next: { action: 'idle' } };
        }
        return {};
      });

      mockExecuteAgentFn.mock.mockImplementation(async () => {
        throw new Error('agent crash');
      });

      await w._workLoop();
      // The catch branch emits task:error and resets status to idle then stopped
      assert.equal(w.status, 'stopped');
      assert.ok(errorEvents.length > 0);
    });

    it('handles execution failure with model recovery', async () => {
      const w = new AgentWorker('claude', { baseUrl: 'http://x' });
      patchSleep(w);
      w.autoChain = false;

      let pollCount = 0;
      // @ts-expect-error mock implementation with flexible signature
      mockRequestFn.mock.mockImplementation(async (_m: unknown, _b: unknown, path: unknown) => {
        if (typeof path === 'string' && path.startsWith('/next')) {
          pollCount++;
          if (pollCount === 1) {
            return {
              next: {
                action: 'claim_owned_task',
                task: { id: 't3', title: 'Recovery test' },
              },
            };
          }
          return { next: { action: 'idle' } };
        }
        return {};
      });

      let execCount = 0;
      mockExecuteAgentFn.mock.mockImplementation(async () => {
        execCount++;
        if (execCount === 1) {
          return {
            ok: false,
            output: '',
            stdout: '',
            stderr: 'model error',
            error: 'model not found',
            exitCode: 1,
            signal: null,
          };
        }
        return {
          ok: true,
          output: 'recovered',
          stdout: 'recovered',
          stderr: '',
          error: '',
          exitCode: 0,
          signal: null,
        };
      });

      mockDetectModelError.mock.mockImplementation(() => ({
        isModelError: true,
        failedModel: 'old-model',
      }));
      /* eslint-disable @typescript-eslint/no-unsafe-return */
      mockRecoverFromModelError.mock.mockImplementation(
        async () =>
          ({
            recovered: true,
            newModel: 'new-model',
          }) as any,
      );
      /* eslint-enable @typescript-eslint/no-unsafe-return */

      const progressEvents: string[] = [];
      w.on('task:progress', (e: { output: string }) => progressEvents.push(e.output));

      await w._workLoop();
      assert.ok(progressEvents.some((p) => p.includes('Model recovery')));
    });

    it('handles usage limit error', async () => {
      const w = new AgentWorker('claude', { baseUrl: 'http://x' });
      patchSleep(w);
      w.autoChain = true;

      let pollCount = 0;
      // @ts-expect-error mock implementation with flexible signature
      mockRequestFn.mock.mockImplementation(async (_m: unknown, _b: unknown, path: unknown) => {
        if (typeof path === 'string' && path.startsWith('/next')) {
          pollCount++;
          if (pollCount === 1) {
            return {
              next: {
                action: 'claim_owned_task',
                task: { id: 't4', title: 'Usage limit test' },
              },
            };
          }
          return { next: { action: 'idle' } };
        }
        return {};
      });

      mockExecuteAgentFn.mock.mockImplementation(async () => ({
        ok: false,
        output: '',
        stdout: '',
        stderr: 'usage limit',
        error: 'usage limit exceeded',
        exitCode: 1,
        signal: null,
      }));

      mockDetectUsageLimitError.mock.mockImplementation(() => ({
        isUsageLimit: true,
        errorMessage: 'Rate limited',
        resetInSeconds: 3600,
      }));

      await w._workLoop();
      // Worker should have stopped due to usage limit
      assert.equal(w.status, 'stopped');
    });

    it('handles codex-specific error', async () => {
      const w = new AgentWorker('codex', { baseUrl: 'http://x' });
      patchSleep(w);
      w.autoChain = false;

      let pollCount = 0;
      // @ts-expect-error mock implementation with flexible signature
      mockRequestFn.mock.mockImplementation(async (_m: unknown, _b: unknown, path: unknown) => {
        if (typeof path === 'string' && path.startsWith('/next')) {
          pollCount++;
          if (pollCount === 1) {
            return {
              next: {
                action: 'claim_owned_task',
                task: { id: 't5', title: 'Codex error test' },
              },
            };
          }
          return { next: { action: 'idle' } };
        }
        return {};
      });

      mockExecuteAgentFn.mock.mockImplementation(async () => ({
        ok: false,
        output: '',
        stdout: '',
        stderr: 'auth error',
        error: 'codex auth failed',
        exitCode: 1,
        signal: null,
      }));

      mockDetectCodexError.mock.mockImplementation(() => ({
        isCodexError: true,
        category: 'auth',
        errorMessage: 'Auth failed',
      }));

      const progressEvents: string[] = [];
      w.on('task:progress', (e: { output: string }) => progressEvents.push(e.output));

      await w._workLoop();
      assert.ok(progressEvents.some((p) => p.includes('auth')));
    });

    it('handles unknown action from _resolveWorkItem', async () => {
      const w = new AgentWorker('claude', { baseUrl: 'http://x' });
      patchSleep(w);

      let pollCount = 0;
      mockRequestFn.mock.mockImplementation(async () => {
        pollCount++;
        if (pollCount === 1) {
          return { next: { action: 'unknown_action' } };
        }
        w._stopped = true;
        return { next: { action: 'idle' } };
      });

      await w._workLoop();
      assert.equal(w.status, 'stopped');
    });

    it('handles continue_task action', async () => {
      const w = new AgentWorker('claude', { baseUrl: 'http://x' });
      patchSleep(w);
      w.autoChain = false;

      let pollCount = 0;
      // @ts-expect-error mock implementation with flexible signature
      mockRequestFn.mock.mockImplementation(async (_m: unknown, _b: unknown, path: unknown) => {
        if (typeof path === 'string' && path.startsWith('/next')) {
          pollCount++;
          if (pollCount === 1) {
            return {
              next: {
                action: 'continue_task',
                task: { id: 'ct1', title: 'Continue this' },
              },
            };
          }
          return { next: { action: 'idle' } };
        }
        return {};
      });

      mockExecuteAgentFn.mock.mockImplementation(async () => ({
        ok: true,
        output: 'done',
        stdout: 'done',
        stderr: '',
        error: '',
        exitCode: 0,
        signal: null,
      }));

      await w._workLoop();
      assert.equal(w.status, 'stopped');
    });
  });

  describe('_resolveHandoffItem', () => {
    it('builds work item from handoff with missing fields', async () => {
      const w = new AgentWorker('claude', { baseUrl: 'http://x' });
      mockRequestFn.mock.mockImplementation(async () => ({}));
      const result = await (w as any)._resolveHandoffItem({
        action: 'pickup_handoff',
        handoff: {},
      });
      assert.equal(result.prompt, 'Continue assigned work.');
      assert.equal(result.taskId, 'unknown');
    });

    it('handles ack request failure gracefully', async () => {
      const w = new AgentWorker('claude', { baseUrl: 'http://x' });
      mockRequestFn.mock.mockImplementation(async () => {
        throw new Error('ack failed');
      });
      const result = await (w as any)._resolveHandoffItem({
        action: 'pickup_handoff',
        handoff: { id: 'h2', summary: 'Do stuff', nextStep: 'Step 1', tasks: ['t10'] },
      });
      assert.equal(result.prompt, 'Do stuff');
      assert.equal(result.taskId, 't10');
    });
  });

  describe('_reportResult', () => {
    it('reports success to daemon', async () => {
      const w = new AgentWorker('claude', { baseUrl: 'http://x' });
      mockRequestFn.mock.mockImplementation(async () => ({}));
      await (w as any)._reportResult(
        't1',
        { ok: true, output: 'success', exitCode: 0 },
        1000,
        'success',
      );
      assert.equal(mockRequestFn.mock.callCount(), 1);
    });

    it('falls back to task/update on result endpoint failure', async () => {
      const w = new AgentWorker('claude', { baseUrl: 'http://x' });
      let callCount = 0;
      mockRequestFn.mock.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error('result endpoint down');
        return {};
      });
      await (w as any)._reportResult(
        't1',
        { ok: false, output: '', error: 'some error', exitCode: 1, stderr: 'err' },
        2000,
        'error output',
      );
      assert.ok(callCount >= 2);
    });

    it('handles both endpoints failing', async () => {
      const w = new AgentWorker('claude', { baseUrl: 'http://x' });
      mockRequestFn.mock.mockImplementation(async () => {
        throw new Error('all down');
      });
      // Should not throw
      await (w as any)._reportResult('t1', { ok: true, output: 'x' }, 100, 'x');
    });
  });

  describe('_finalizeTask', () => {
    it('emits complete event for successful task', async () => {
      const w = new AgentWorker('claude', { baseUrl: 'http://x' });
      mockRequestFn.mock.mockImplementation(async () => ({}));
      const events: Array<{ status: string }> = [];
      w.on('task:complete', (e: { status: string }) => events.push(e));

      const shouldStop = await (w as any)._finalizeTask('t1', 'Test', {
        ok: true,
        output: 'done',
        error: '',
      });
      assert.equal(shouldStop, false);
      assert.equal(events[0]?.status, 'done');
    });

    it('adds failed task to _failedTasks set', async () => {
      const w = new AgentWorker('claude', { baseUrl: 'http://x' });
      w._sleep = () => Promise.resolve();
      mockRequestFn.mock.mockImplementation(async () => ({}));
      mockDetectUsageLimitError.mock.mockImplementation(() => ({
        isUsageLimit: false,
        errorMessage: '',
        resetInSeconds: 0,
      }));

      await (w as any)._finalizeTask('t-err', 'Fail', {
        ok: false,
        output: '',
        error: 'some error',
        exitCode: 1,
        errorCategory: 'model-error',
        errorDetail: 'bad model',
      });
      assert.ok(w._failedTasks.has('t-err'));
    });

    it('returns true and stops worker on usage limit', async () => {
      const w = new AgentWorker('claude', { baseUrl: 'http://x' });
      w._sleep = () => Promise.resolve();
      mockRequestFn.mock.mockImplementation(async () => ({}));
      mockDetectUsageLimitError.mock.mockImplementation(() => ({
        isUsageLimit: true,
        errorMessage: 'limit hit',
        resetInSeconds: 300,
      }));

      const shouldStop = await (w as any)._finalizeTask('t-limit', 'Limit', {
        ok: false,
        output: '',
        error: 'limit',
        exitCode: 1,
      });
      assert.equal(shouldStop, true);
    });
  });

  afterEach(() => {
    // Reset mock implementations to defaults
    mockRequestFn.mock.mockImplementation(async () => ({}));
    mockExecuteAgentFn.mock.mockImplementation(async () => ({
      ok: true,
      output: 'done',
      stdout: 'done',
      stderr: '',
      error: '',
      exitCode: 0,
      signal: null,
    }));
    mockGetAgentFn.mock.mockImplementation((name: string) =>
      name ? { name, rolePrompt: `You are ${name}.`, type: 'physical' } : null,
    );
    mockLoadConfigFn.mock.mockImplementation(() => ({
      workers: {
        permissionMode: 'auto-edit',
        pollIntervalMs: 10,
        maxOutputBufferKB: 8,
        autoChain: true,
        heartbeatIntervalMs: 50000,
        concurrency: { adaptivePolling: true, maxInFlight: 3 },
      },
    }));
    mockDetectModelError.mock.mockImplementation(() => ({ isModelError: false }));
    mockRecoverFromModelError.mock.mockImplementation(async () => ({
      recovered: false,
      newModel: null,
    }));
    mockDetectCodexError.mock.mockImplementation(() => ({ isCodexError: false }));
    mockDetectUsageLimitError.mock.mockImplementation(() => ({
      isUsageLimit: false,
      errorMessage: '',
      resetInSeconds: 0,
    }));
  });
});
