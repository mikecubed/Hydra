/**
 * Unit tests for lib/daemon/read-routes.ts and lib/daemon/write-routes.ts.
 * Uses mock contexts — no daemon process required.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { EventEmitter } from 'node:events';
import { handleReadRoute } from '../lib/daemon/read-routes.ts';
import { handleWriteRoute } from '../lib/daemon/write-routes.ts';
import type {
  ReadRouteCtx,
  WriteRouteCtx,
  HydraStateShape,
  TaskEntry,
  HandoffEntry,
} from '../lib/types.ts';

// ── Helpers ────────────────────────────────────────────────────────────────

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

function makeReadCtx(
  method: string,
  routePath: string,
  state: HydraStateShape,
  searchParams: Record<string, string> = {},
): ReadRouteCtx & { captured: { statusCode: number; data: unknown } } {
  const url = new URL(
    `http://localhost${routePath}${
      Object.keys(searchParams).length > 0 ? `?${new URLSearchParams(searchParams).toString()}` : ''
    }`,
  );
  const captured: { statusCode: number; data: unknown } = { statusCode: 0, data: null };
  const req = new EventEmitter() as IncomingMessage;
  (req as unknown as Record<string, unknown>)['headers'] = {};
  const res = new EventEmitter() as ServerResponse;
  (res as unknown as Record<string, unknown>)['writeHead'] = () => {};
  (res as unknown as Record<string, unknown>)['write'] = () => {};
  (res as unknown as Record<string, unknown>)['end'] = () => {};

  const sendJson = (_r: ServerResponse, code: number, data: unknown) => {
    captured.statusCode = code;
    captured.data = data;
  };
  const sendError = (_r: ServerResponse, code: number, msg: string) => {
    captured.statusCode = code;
    captured.data = { ok: false, error: msg };
  };

  return {
    captured,
    method,
    route: routePath,
    requestUrl: url,
    req,
    res,
    sendJson,
    sendError,
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
    getModelSummary: () => ({
      claude: { active: 'claude-opus-4-6', isDefault: true },
    }),
    readState: () => state,
    getSummary: (s: HydraStateShape) => ({
      project: 'test',
      counts: { tasks: s.tasks.length },
    }),
    projectRoot: '/tmp/test',
    projectName: 'test',
    buildPrompt: (_agent: string, _s: HydraStateShape) => 'test-prompt',
    suggestNext: (_s: HydraStateShape, agent: string) => ({
      action: 'wait',
      message: `No tasks for ${agent}`,
    }),
    readEvents: (_limit: number) => [
      { seq: 1, at: new Date().toISOString(), type: 'task:add', category: 'task' },
    ],
    replayEvents: (_fromSeq: number) => [
      { seq: 1, at: new Date().toISOString(), type: 'task:add', category: 'task' },
      { seq: 2, at: new Date().toISOString(), type: 'session:start', category: 'session' },
    ],
    sseClients: new Set(),
    readArchive: () => ({
      tasks: [],
      handoffs: [],
      blockers: [],
      archivedAt: new Date().toISOString(),
    }),
    getMetricsSummary: () => ({ requests: 5 }),
    getEventCount: () => 42,
  };
}

function makeWriteCtx(
  method: string,
  routePath: string,
  state: HydraStateShape,
  bodyData: Record<string, unknown> = {},
  reqHeaders: Record<string, string> = {},
): WriteRouteCtx & { captured: { statusCode: number; data: unknown } } {
  const readCtx = makeReadCtx(method, routePath, state);
  const req = new EventEmitter() as IncomingMessage;
  (req as unknown as Record<string, unknown>)['headers'] = reqHeaders;

  const appendedEvents: Array<{ type: string; payload?: unknown }> = [];
  const broadcastedEvents: unknown[] = [];

  return {
    ...readCtx,
    req,
    readJsonBody: (_r: IncomingMessage) => Promise.resolve(bodyData),
    enqueueMutation: <T>(
      _label: string,
      mutator: (s: HydraStateShape) => T,
      _detail?: Record<string, unknown>,
    ) => Promise.resolve(mutator(state)),
    ensureKnownAgent: (agent: string, allowUnassigned = true) => {
      const known = ['claude', 'gemini', 'codex', 'human', 'local', 'copilot', 'unassigned'];
      if (!allowUnassigned && agent === 'unassigned') throw new Error(`Unknown agent: ${agent}`);
      if (!known.includes(agent)) throw new Error(`Unknown agent: ${agent}`);
    },
    ensureKnownStatus: (status: string) => {
      const known = ['todo', 'in_progress', 'done', 'blocked', 'cancelled'];
      if (!known.includes(status)) throw new Error(`Unknown status: ${status}`);
    },
    parseList: (val: unknown) =>
      String(val)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    getCurrentBranch: () => 'main',
    toSessionId: () => `ses_${Date.now().toString(36)}`,
    nowIso: () => new Date().toISOString(),
    classifyTask: (_title: string, type?: string) => type ?? 'feat',
    nextId: (prefix: string, items: unknown[]) => `${prefix}_${String(items.length + 1)}`,
    detectCycle: () => false,
    autoUnblock: () => {},
    AGENT_NAMES: ['claude', 'gemini', 'codex'],
    getAgent: () => void 0,
    listAgents: () => [],
    resolveVerificationPlan: () => ({}),
    runVerification: () => {},
    archiveState: () => 0,
    truncateEventsFile: () => 0,
    appendEvent: (type: string, payload?: unknown) => {
      appendedEvents.push({ type, payload });
    },
    broadcastEvent: (event: unknown) => {
      broadcastedEvents.push(event);
    },
    setIsShuttingDown: () => {},
    server: {} as Server,
    createSnapshot: () => ({}),
    cleanOldSnapshots: () => {},
    checkIdempotency: null,
    createTaskWorktree: () => null,
    mergeTaskWorktree: () => ({}),
    cleanupTaskWorktree: () => {},
    writeStatus: () => {},
    _appendedEvents: appendedEvents,
    _broadcastedEvents: broadcastedEvents,
  } as WriteRouteCtx & {
    captured: { statusCode: number; data: unknown };
    _appendedEvents: Array<{ type: string; payload?: unknown }>;
    _broadcastedEvents: unknown[];
  };
}

function makeTask(overrides: Partial<TaskEntry> = {}): TaskEntry {
  return {
    id: 't_1',
    title: 'Test task',
    status: 'todo',
    owner: 'claude',
    type: 'feat',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    files: [],
    notes: '',
    blockedBy: [],
    ...overrides,
  };
}

describe('handleReadRoute', () => {
  it('GET /health returns ok:true with usage and models', async () => {
    const ctx = makeReadCtx('GET', '/health', makeState());
    const handled = await handleReadRoute(ctx);
    assert.ok(handled, 'route should be handled');
    assert.equal(ctx.captured.statusCode, 200);
    const data = ctx.captured.data as Record<string, unknown>;
    assert.equal(data['ok'], true);
    assert.ok(data['usage'] != null, 'should have usage');
    assert.ok(data['models'] != null, 'should have models');
  });

  it('GET /state returns full state', async () => {
    const state = makeState({ tasks: [] });
    const ctx = makeReadCtx('GET', '/state', state);
    const handled = await handleReadRoute(ctx);
    assert.ok(handled);
    assert.equal(ctx.captured.statusCode, 200);
    const data = ctx.captured.data as Record<string, unknown>;
    assert.equal(data['ok'], true);
    assert.ok(data['state'] != null);
  });

  it('GET /summary returns summary object', async () => {
    const ctx = makeReadCtx('GET', '/summary', makeState());
    const handled = await handleReadRoute(ctx);
    assert.ok(handled);
    assert.equal(ctx.captured.statusCode, 200);
    const data = ctx.captured.data as Record<string, unknown>;
    assert.equal(data['ok'], true);
    assert.ok(data['summary'] != null);
  });

  it('GET /prompt returns prompt for given agent', async () => {
    const ctx = makeReadCtx('GET', '/prompt', makeState(), { agent: 'claude' });
    const handled = await handleReadRoute(ctx);
    assert.ok(handled);
    assert.equal(ctx.captured.statusCode, 200);
    const data = ctx.captured.data as Record<string, unknown>;
    assert.equal(data['ok'], true);
    assert.equal(data['agent'], 'claude');
    assert.equal(typeof data['prompt'], 'string');
  });

  it('GET /next with agent returns suggestion', async () => {
    const ctx = makeReadCtx('GET', '/next', makeState(), { agent: 'gemini' });
    const handled = await handleReadRoute(ctx);
    assert.ok(handled);
    assert.equal(ctx.captured.statusCode, 200);
    const data = ctx.captured.data as Record<string, unknown>;
    assert.equal(data['ok'], true);
    assert.ok(data['next'] != null);
  });

  it('GET /next without agent returns 400', async () => {
    const ctx = makeReadCtx('GET', '/next', makeState());
    const handled = await handleReadRoute(ctx);
    assert.ok(handled);
    assert.equal(ctx.captured.statusCode, 400);
  });

  it('GET /events returns event list', async () => {
    const ctx = makeReadCtx('GET', '/events', makeState(), { limit: '10' });
    const handled = await handleReadRoute(ctx);
    assert.ok(handled);
    assert.equal(ctx.captured.statusCode, 200);
    const data = ctx.captured.data as Record<string, unknown>;
    assert.ok(Array.isArray(data['events']));
  });

  it('GET /events/replay returns replayed events', async () => {
    const ctx = makeReadCtx('GET', '/events/replay', makeState(), { from: '0' });
    const handled = await handleReadRoute(ctx);
    assert.ok(handled);
    assert.equal(ctx.captured.statusCode, 200);
    const data = ctx.captured.data as Record<string, unknown>;
    assert.ok(Array.isArray(data['events']));
  });

  it('GET /events/replay filters by category', async () => {
    const ctx = makeReadCtx('GET', '/events/replay', makeState(), {
      from: '0',
      category: 'task',
    });
    const handled = await handleReadRoute(ctx);
    assert.ok(handled);
    assert.equal(ctx.captured.statusCode, 200);
    const data = ctx.captured.data as Record<string, unknown>;
    const events = data['events'] as Array<{ category?: string }>;
    assert.ok(events.every((e) => e.category === 'task'));
  });

  it('GET /activity returns structured activity snapshot', async () => {
    const ctx = makeReadCtx('GET', '/activity', makeState());
    const handled = await handleReadRoute(ctx);
    assert.ok(handled);
    assert.equal(ctx.captured.statusCode, 200);
    const data = ctx.captured.data as Record<string, unknown>;
    assert.equal(data['ok'], true);
    const activity = data['activity'] as Record<string, unknown>;
    assert.ok(activity['agents'] != null);
    assert.ok(activity['tasks'] != null);
    assert.ok(activity['counts'] != null);
  });

  it('GET /state/archive returns archive counts', async () => {
    const ctx = makeReadCtx('GET', '/state/archive', makeState());
    const handled = await handleReadRoute(ctx);
    assert.ok(handled);
    assert.equal(ctx.captured.statusCode, 200);
    const data = ctx.captured.data as Record<string, unknown>;
    assert.equal(data['ok'], true);
    const counts = data['counts'] as Record<string, number>;
    assert.ok(typeof counts['tasks'] === 'number');
  });

  it('GET /sessions returns session info', async () => {
    const ctx = makeReadCtx('GET', '/sessions', makeState());
    const handled = await handleReadRoute(ctx);
    assert.ok(handled);
    assert.equal(ctx.captured.statusCode, 200);
    const data = ctx.captured.data as Record<string, unknown>;
    assert.equal(data['ok'], true);
    assert.ok('activeSession' in data);
    assert.ok(Array.isArray(data['childSessions']));
  });

  it('GET /tasks/stale returns stale task list', async () => {
    const staleTask: TaskEntry = makeTask({
      id: 't_1',
      title: 'Stale task',
      status: 'in_progress',
      owner: 'claude',
      stale: true,
      staleSince: new Date().toISOString(),
    });
    const ctx = makeReadCtx('GET', '/tasks/stale', makeState({ tasks: [staleTask] }));
    const handled = await handleReadRoute(ctx);
    assert.ok(handled);
    assert.equal(ctx.captured.statusCode, 200);
    const data = ctx.captured.data as Record<string, unknown>;
    const tasks = data['tasks'] as unknown[];
    assert.equal(tasks.length, 1);
  });

  it('GET /stats returns metrics, usage, and daemon info', async () => {
    const ctx = makeReadCtx('GET', '/stats', makeState());
    const handled = await handleReadRoute(ctx);
    assert.ok(handled);
    assert.equal(ctx.captured.statusCode, 200);
    const data = ctx.captured.data as Record<string, unknown>;
    assert.equal(data['ok'], true);
    assert.ok(data['metrics'] != null);
    assert.ok(data['usage'] != null);
    const daemon = data['daemon'] as Record<string, unknown>;
    assert.equal(daemon['eventsRecorded'], 42);
  });

  it('GET /task/:id/checkpoints returns task checkpoints', async () => {
    const task: TaskEntry = makeTask({
      id: 't_1',
      title: 'Test task',
      status: 'in_progress',
      owner: 'codex',
      checkpoints: [{ note: 'first checkpoint', at: new Date().toISOString() }],
    });
    const ctx = makeReadCtx('GET', '/task/t_1/checkpoints', makeState({ tasks: [task] }));
    const handled = await handleReadRoute(ctx);
    assert.ok(handled);
    assert.equal(ctx.captured.statusCode, 200);
    const data = ctx.captured.data as Record<string, unknown>;
    assert.equal(data['taskId'], 't_1');
    assert.ok(Array.isArray(data['checkpoints']));
    assert.equal((data['checkpoints'] as unknown[]).length, 1);
  });

  it('GET /task/:id/checkpoints returns 404 for unknown task', async () => {
    const ctx = makeReadCtx('GET', '/task/unknown_id/checkpoints', makeState());
    const handled = await handleReadRoute(ctx);
    assert.ok(handled);
    assert.equal(ctx.captured.statusCode, 404);
  });

  it('unhandled GET route returns false', async () => {
    const ctx = makeReadCtx('GET', '/nonexistent', makeState());
    const handled = await handleReadRoute(ctx);
    assert.equal(handled, false);
  });

  it('POST method is not handled by read routes', async () => {
    const ctx = makeReadCtx('POST', '/health', makeState());
    const handled = await handleReadRoute(ctx);
    assert.equal(handled, false);
  });
});

// ── Write Route Tests ──────────────────────────────────────────────────────

describe('handleWriteRoute', () => {
  it('POST /events/push with valid type appends and broadcasts', async () => {
    const ctx = makeWriteCtx('POST', '/events/push', makeState(), {
      type: 'concierge:dispatch',
      payload: { prompt: 'test' },
    });
    const handled = await handleWriteRoute(ctx);
    assert.ok(handled);
    assert.equal(ctx.captured.statusCode, 200);
    const data = ctx.captured.data as Record<string, unknown>;
    assert.equal(data['ok'], true);
    assert.equal(data['type'], 'concierge:dispatch');
  });

  it('POST /events/push with invalid type returns 400', async () => {
    const ctx = makeWriteCtx('POST', '/events/push', makeState(), {
      type: 'evil:xss',
      payload: {},
    });
    const handled = await handleWriteRoute(ctx);
    assert.ok(handled);
    assert.equal(ctx.captured.statusCode, 400);
  });

  it('POST /session/start with valid focus creates session', async () => {
    const ctx = makeWriteCtx('POST', '/session/start', makeState(), {
      focus: 'Implement the new feature',
      owner: 'human',
    });
    const handled = await handleWriteRoute(ctx);
    assert.ok(handled);
    assert.equal(ctx.captured.statusCode, 200);
    const data = ctx.captured.data as Record<string, unknown>;
    assert.equal(data['ok'], true);
    assert.ok(data['session'] != null);
  });

  it('POST /session/start with missing focus returns 400', async () => {
    const ctx = makeWriteCtx('POST', '/session/start', makeState(), { focus: '' });
    const handled = await handleWriteRoute(ctx);
    assert.ok(handled);
    assert.equal(ctx.captured.statusCode, 400);
  });

  it('POST /session/fork rejects when no active session', async () => {
    const ctx = makeWriteCtx('POST', '/session/fork', makeState({ activeSession: null }), {
      reason: 'explore feature',
    });
    // The mutator throws "No active session to fork." — this propagates to caller
    await assert.rejects(
      () => handleWriteRoute(ctx),
      (err: Error) => {
        assert.ok(err.message.includes('No active session'), `unexpected error: ${err.message}`);
        return true;
      },
    );
  });

  it('POST idempotency key duplicate returns 409', async () => {
    const seenKeys = new Set<string>();
    const ctx = makeWriteCtx(
      'POST',
      '/events/push',
      makeState(),
      {
        type: 'concierge:dispatch',
        payload: {},
      },
      { 'idempotency-key': 'key-abc-123' },
    );
    ctx.checkIdempotency = (key: string) => {
      if (seenKeys.has(key)) return true;
      seenKeys.add(key);
      return false;
    };

    // First request — should succeed
    const first = await handleWriteRoute(ctx);
    assert.ok(first);
    assert.equal(ctx.captured.statusCode, 200);

    // Second request with same key — should be rejected
    const ctx2 = makeWriteCtx(
      'POST',
      '/events/push',
      makeState(),
      {
        type: 'concierge:dispatch',
        payload: {},
      },
      { 'idempotency-key': 'key-abc-123' },
    );
    ctx2.checkIdempotency = (key: string) => seenKeys.has(key);

    const second = await handleWriteRoute(ctx2);
    assert.ok(second);
    assert.equal(ctx2.captured.statusCode, 409);
  });

  it('unhandled POST route returns false', async () => {
    const ctx = makeWriteCtx('POST', '/nonexistent-route', makeState(), {});
    const handled = await handleWriteRoute(ctx);
    assert.equal(handled, false);
  });

  it('POST /session/spawn rejects missing focus', async () => {
    const ctx = makeWriteCtx('POST', '/session/spawn', makeState(), { focus: '' });
    const handled = await handleWriteRoute(ctx);
    assert.ok(handled);
    assert.equal(ctx.captured.statusCode, 400);
  });

  it('GET /session/status returns structured status', async () => {
    const task: TaskEntry = makeTask({
      id: 't_1',
      title: 'In progress task',
      status: 'in_progress',
      owner: 'claude',
    });
    const state = makeState({ tasks: [task] });
    const ctx = makeReadCtx('GET', '/session/status', state);
    const handled = await handleReadRoute(ctx);
    assert.ok(handled);
    assert.equal(ctx.captured.statusCode, 200);
    const data = ctx.captured.data as Record<string, unknown>;
    assert.equal(data['ok'], true);
    assert.ok(Array.isArray(data['inProgressTasks']));
    assert.ok(Array.isArray(data['pendingHandoffs']));
  });

  it('GET /sessions lists child sessions', async () => {
    const state = makeState({
      childSessions: [
        {
          id: 'child_1',
          type: 'fork',
          parentId: 'root_1',
          focus: 'child focus',
          owner: 'human',
          status: 'active',
        },
      ],
    });
    const ctx = makeReadCtx('GET', '/sessions', state);
    const handled = await handleReadRoute(ctx);
    assert.ok(handled);
    assert.equal(ctx.captured.statusCode, 200);
    const data = ctx.captured.data as Record<string, unknown>;
    const children = data['childSessions'] as unknown[];
    assert.equal(children.length, 1);
  });

  it('GET /activity counts match task list', async () => {
    const tasks: TaskEntry[] = [
      makeTask({ id: 't_1', title: 'Todo', status: 'todo', owner: 'claude', type: 'feat' }),
      makeTask({ id: 't_2', title: 'Done', status: 'done', owner: 'codex', type: 'fix' }),
    ];
    const ctx = makeReadCtx('GET', '/activity', makeState({ tasks }));
    const handled = await handleReadRoute(ctx);
    assert.ok(handled);
    assert.equal(ctx.captured.statusCode, 200);
    const activity = (ctx.captured.data as Record<string, unknown>)['activity'] as Record<
      string,
      unknown
    >;
    const counts = activity['counts'] as Record<string, number>;
    assert.equal(counts['tasksTodo'], 1);
    assert.equal(counts['tasksDone'], 1);
  });

  it('GET /activity includes pending handoffs', async () => {
    const handoff: HandoffEntry = {
      id: 'h_1',
      from: 'gemini',
      to: 'codex',
      summary: 'Please implement X',
      createdAt: new Date().toISOString(),
      acknowledgedAt: null,
    };
    const ctx = makeReadCtx('GET', '/activity', makeState({ handoffs: [handoff] }));
    const handled = await handleReadRoute(ctx);
    assert.ok(handled);
    assert.equal(ctx.captured.statusCode, 200);
    const activity = (ctx.captured.data as Record<string, unknown>)['activity'] as Record<
      string,
      unknown
    >;
    const handoffs = activity['handoffs'] as Record<string, unknown>;
    const pending = handoffs['pending'] as unknown[];
    assert.equal(pending.length, 1);
  });
});
