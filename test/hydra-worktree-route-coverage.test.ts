/**
 * Handler-level coverage for daemon worktree claim/result flows.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { EventEmitter } from 'node:events';

import { handleWriteRoute } from '../lib/daemon/write-routes.ts';
import { _setTestConfig, invalidateConfigCache } from '../lib/hydra-config.ts';
import type { HydraStateShape, ReadRouteCtx, TaskEntry, WriteRouteCtx } from '../lib/types.ts';

function makeState(overrides: Partial<HydraStateShape> = {}): HydraStateShape {
  return {
    tasks: [],
    handoffs: [],
    blockers: [],
    decisions: [],
    childSessions: [],
    activeSession: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskEntry> = {}): TaskEntry {
  return {
    id: 'T1',
    title: 'Test task',
    owner: 'codex',
    status: 'todo',
    type: 'implementation',
    files: [],
    notes: '',
    blockedBy: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeReadCtx(
  method: string,
  routePath: string,
  state: HydraStateShape,
): ReadRouteCtx & { captured: { statusCode: number; data: unknown } } {
  const url = new URL(`http://localhost${routePath}`);
  const captured = { statusCode: 0, data: null as unknown };
  const req = new EventEmitter() as IncomingMessage;
  (req as unknown as Record<string, unknown>)['headers'] = {};
  const res = new EventEmitter() as ServerResponse;
  (res as unknown as Record<string, unknown>)['writeHead'] = () => {};
  (res as unknown as Record<string, unknown>)['write'] = () => {};
  (res as unknown as Record<string, unknown>)['end'] = () => {};

  return {
    captured,
    method,
    route: routePath,
    requestUrl: url,
    req,
    res,
    sendJson: (_r: ServerResponse, code: number, data: unknown) => {
      captured.statusCode = code;
      captured.data = data;
    },
    sendError: (_r: ServerResponse, code: number, msg: string) => {
      captured.statusCode = code;
      captured.data = { ok: false, error: msg };
    },
    writeStatus: () => {},
    readStatus: () => ({ ok: true }),
    checkUsage: () => ({
      level: 'normal',
      percent: 10,
      todayTokens: 100,
      message: 'ok',
      confidence: 1,
      model: 'test',
      budget: 1000,
      used: 100,
      remaining: 900,
      resetAt: '',
      resetInMs: 0,
      agents: {},
    }),
    getModelSummary: () => ({ claude: { active: 'claude-opus', isDefault: true } }),
    readState: () => state,
    getSummary: (s: HydraStateShape) => ({ counts: { tasks: s.tasks.length } }),
    projectRoot: '/tmp/test',
    projectName: 'test',
    buildPrompt: () => 'prompt',
    suggestNext: (_s: HydraStateShape, agent: string) => ({ action: 'wait', message: agent }),
    readEvents: () => [],
    replayEvents: () => [],
    sseClients: new Set(),
    readArchive: () => ({
      tasks: [],
      handoffs: [],
      blockers: [],
      archivedAt: new Date().toISOString(),
    }),
    getMetricsSummary: () => ({}),
    getEventCount: () => 0,
  } as ReadRouteCtx & { captured: { statusCode: number; data: unknown } };
}

function makeWriteCtx(
  method: string,
  routePath: string,
  state: HydraStateShape,
  bodyData: Record<string, unknown>,
  overrides: Partial<WriteRouteCtx> = {},
): WriteRouteCtx & { captured: { statusCode: number; data: unknown } } {
  const readCtx = makeReadCtx(method, routePath, state);
  const req = readCtx.req;
  const parseList = (val: unknown): string[] => {
    if (Array.isArray(val)) {
      return val
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
    if (typeof val !== 'string') return [];
    return val
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  };
  return {
    ...readCtx,
    req,
    readJsonBody: () => Promise.resolve(bodyData),
    enqueueMutation: async <T>(_label: string, mutator: (s: HydraStateShape) => T) =>
      mutator(state),
    ensureKnownAgent: () => {},
    ensureKnownStatus: () => {},
    parseList,
    getCurrentBranch: () => 'main',
    toSessionId: () => 'ses_test',
    nowIso: () => new Date().toISOString(),
    classifyTask: () => 'implementation',
    nextId: (prefix: string, items: unknown[]) => `${prefix}_${String(items.length + 1)}`,
    detectCycle: () => false,
    autoUnblock: () => {},
    AGENT_NAMES: ['claude', 'gemini', 'codex'],
    getAgent: () => void 0,
    listAgents: () => [],
    resolveVerificationPlan: () => ({
      enabled: false,
      source: 'test',
      command: null,
      reason: 'test',
    }),
    runVerification: () => {},
    archiveState: () => 0,
    truncateEventsFile: () => 0,
    appendEvent: () => {},
    broadcastEvent: () => {},
    setIsShuttingDown: () => {},
    server: {} as Server,
    createSnapshot: () => ({}),
    cleanOldSnapshots: () => {},
    checkIdempotency: null,
    createTaskWorktree: () => null,
    mergeTaskWorktree: () => ({ ok: true }),
    cleanupTaskWorktree: () => {},
    writeStatus: () => {},
    ...overrides,
  } as WriteRouteCtx & { captured: { statusCode: number; data: unknown } };
}

afterEach(() => {
  invalidateConfigCache();
});

describe('handleWriteRoute worktree coverage', () => {
  it('does not create a worktree when worktree isolation is disabled', async () => {
    _setTestConfig({ routing: { worktreeIsolation: { enabled: false, cleanupOnSuccess: true } } });
    const state = makeState();
    let createCalls = 0;
    const ctx = makeWriteCtx(
      'POST',
      '/task/claim',
      state,
      { agent: 'codex', title: 'new task', worktree: true },
      {
        createTaskWorktree: () => {
          createCalls += 1;
          return '/tmp/ignored';
        },
      },
    );

    const handled = await handleWriteRoute(ctx);
    assert.equal(handled, true);
    assert.equal(createCalls, 0);
    assert.equal(state.tasks.length, 1);
    assert.equal((state.tasks[0] as Record<string, unknown>)['worktreePath'], undefined);
  });

  it('creates and records a worktree when body.worktree is true', async () => {
    _setTestConfig({ routing: { worktreeIsolation: { enabled: true, cleanupOnSuccess: true } } });
    const state = makeState();
    let createCalls = 0;
    const ctx = makeWriteCtx(
      'POST',
      '/task/claim',
      state,
      { agent: 'codex', title: 'new task', worktree: true, mode: 'balanced' },
      {
        createTaskWorktree: (taskId: string) => {
          createCalls += 1;
          return `/tmp/${taskId}`;
        },
      },
    );

    await handleWriteRoute(ctx);

    assert.equal(createCalls, 1);
    const task = state.tasks[0] as Record<string, unknown>;
    assert.equal(task['worktreePath'], '/tmp/T_1');
    assert.equal(task['worktreeBranch'], 'hydra/task/T_1');
  });

  it('creates a worktree for tandem-mode claims', async () => {
    _setTestConfig({ routing: { worktreeIsolation: { enabled: true, cleanupOnSuccess: true } } });
    const state = makeState();
    let createCalls = 0;
    const ctx = makeWriteCtx(
      'POST',
      '/task/claim',
      state,
      { agent: 'codex', title: 'new task', mode: 'tandem' },
      {
        createTaskWorktree: (taskId: string) => {
          createCalls += 1;
          return `/tmp/${taskId}`;
        },
      },
    );

    await handleWriteRoute(ctx);
    assert.equal(createCalls, 1);
  });

  it('creates a worktree for council-mode claims', async () => {
    _setTestConfig({ routing: { worktreeIsolation: { enabled: true, cleanupOnSuccess: true } } });
    const state = makeState();
    let createCalls = 0;
    const ctx = makeWriteCtx(
      'POST',
      '/task/claim',
      state,
      { agent: 'codex', title: 'new task', mode: 'council' },
      {
        createTaskWorktree: (taskId: string) => {
          createCalls += 1;
          return `/tmp/${taskId}`;
        },
      },
    );

    await handleWriteRoute(ctx);
    assert.equal(createCalls, 1);
  });

  it('merges and cleans up a completed task worktree on success', async () => {
    _setTestConfig({ routing: { worktreeIsolation: { enabled: true, cleanupOnSuccess: true } } });
    const state = makeState({
      tasks: [
        makeTask({ id: 'T55', owner: 'codex', status: 'in_progress', worktreePath: '/tmp/T55' }),
      ],
    });
    const mergeCalls: string[] = [];
    const cleanupCalls: string[] = [];
    const ctx = makeWriteCtx(
      'POST',
      '/task/result',
      state,
      { taskId: 'T55', agent: 'codex', status: 'done', output: 'ok' },
      {
        mergeTaskWorktree: (taskId: string) => {
          mergeCalls.push(taskId);
          return { ok: true };
        },
        cleanupTaskWorktree: (taskId: string) => {
          cleanupCalls.push(taskId);
        },
      },
    );

    await handleWriteRoute(ctx);

    assert.deepStrictEqual(mergeCalls, ['T55']);
    assert.deepStrictEqual(cleanupCalls, ['T55']);
  });

  it('marks the task as worktreeConflict when merge reports a conflict', async () => {
    _setTestConfig({ routing: { worktreeIsolation: { enabled: true, cleanupOnSuccess: true } } });
    const state = makeState({
      tasks: [
        makeTask({ id: 'T56', owner: 'codex', status: 'in_progress', worktreePath: '/tmp/T56' }),
      ],
    });
    const cleanupCalls: string[] = [];
    const ctx = makeWriteCtx(
      'POST',
      '/task/result',
      state,
      { taskId: 'T56', agent: 'codex', status: 'done', output: 'ok' },
      {
        mergeTaskWorktree: () => ({ ok: false, conflict: true }),
        cleanupTaskWorktree: (taskId: string) => {
          cleanupCalls.push(taskId);
        },
      },
    );

    await handleWriteRoute(ctx);

    assert.deepStrictEqual(cleanupCalls, []);
    assert.equal((state.tasks[0] as Record<string, unknown>)['worktreeConflict'], true);
  });
});
