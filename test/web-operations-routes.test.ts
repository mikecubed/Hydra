/**
 * Unit tests for lib/daemon/web-operations-routes.ts
 *
 * Covers the /operations/snapshot read route: query param parsing,
 * response shape, status filtering, limit, and error handling.
 * Uses mock ReadRouteCtx — no daemon process required.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import type { ReadRouteCtx, HydraStateShape, TaskEntry, UsageCheckResult } from '../lib/types.ts';
import { handleOperationsReadRoute } from '../lib/daemon/web-operations-routes.ts';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<TaskEntry> = {}): TaskEntry {
  return {
    id: 'task-1',
    title: 'Test task',
    owner: 'claude',
    status: 'todo',
    type: 'implementation',
    files: [],
    notes: '',
    blockedBy: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

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
  ctxOverrides: {
    checkUsage?: () => UsageCheckResult;
    readStatus?: () => Record<string, unknown>;
  } = {},
): ReadRouteCtx & { captured: { statusCode: number; data: unknown } } {
  const url = new URL(
    `http://localhost${routePath}${
      Object.keys(searchParams).length > 0 ? `?${new URLSearchParams(searchParams).toString()}` : ''
    }`,
  );
  const captured: { statusCode: number; data: unknown } = { statusCode: 0, data: null };
  const req = new EventEmitter() as IncomingMessage & {
    headers: Record<string, string>;
  };
  req.headers = {};
  const res = new EventEmitter() as ServerResponse & {
    writeHead: (
      statusCode: number,
      statusMessage?: string | Record<string, string>,
      headers?: Record<string, string>,
    ) => ServerResponse;
    write: () => boolean;
    end: () => ServerResponse;
  };
  res.writeHead = () => res;
  res.write = () => true;
  res.end = () => res;

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
    readStatus: ctxOverrides.readStatus ?? (() => ({ running: true })),
    checkUsage:
      ctxOverrides.checkUsage ??
      (() => ({
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
      })),
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
    buildPrompt: () => 'test-prompt',
    suggestNext: (_s: HydraStateShape, agent: string) => ({
      action: 'wait',
      message: `No tasks for ${agent}`,
    }),
    readEvents: () => [],
    replayEvents: () => [],
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

// ── Route Matching ─────────────────────────────────────────────────────────

describe('handleOperationsReadRoute', () => {
  describe('route matching', () => {
    it('handles /operations/snapshot route', () => {
      const state = makeState({ tasks: [makeTask()] });
      const ctx = makeReadCtx('GET', '/operations/snapshot', state);
      const handled = handleOperationsReadRoute(ctx);
      assert.equal(handled, true);
      assert.equal(ctx.captured.statusCode, 200);
    });

    it('returns false for non-operations routes', () => {
      const ctx = makeReadCtx('GET', '/health', makeState());
      const handled = handleOperationsReadRoute(ctx);
      assert.equal(handled, false);
    });

    it('returns false for non-GET methods', () => {
      const ctx = makeReadCtx('POST', '/operations/snapshot', makeState());
      const handled = handleOperationsReadRoute(ctx);
      assert.equal(handled, false);
    });
  });

  describe('GET /operations/snapshot', () => {
    it('returns queue array without an extra wrapper key', () => {
      const state = makeState({
        tasks: [makeTask({ id: 'task-1', title: 'Build it' })],
      });
      const ctx = makeReadCtx('GET', '/operations/snapshot', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      assert.ok(Array.isArray(data['queue']), 'queue should be an array');
      assert.ok(!('ok' in data));
    });

    it('returns availability field', () => {
      const state = makeState({ tasks: [makeTask()] });
      const ctx = makeReadCtx('GET', '/operations/snapshot', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      assert.equal(data['availability'], 'ready');
    });

    it('returns empty availability for empty queue', () => {
      const ctx = makeReadCtx('GET', '/operations/snapshot', makeState());
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      assert.equal(data['availability'], 'empty');
    });

    it('returns health and budget fields', () => {
      const ctx = makeReadCtx('GET', '/operations/snapshot', makeState());
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      assert.ok('health' in data, 'should have health field');
      assert.ok('budget' in data, 'should have budget field');
    });

    it('returns lastSynchronizedAt as ISO string', () => {
      const state = makeState({ tasks: [makeTask()] });
      const ctx = makeReadCtx('GET', '/operations/snapshot', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      assert.ok(typeof data['lastSynchronizedAt'] === 'string');
    });

    it('returns nextCursor as null when all items fit', () => {
      const state = makeState({ tasks: [makeTask()] });
      const ctx = makeReadCtx('GET', '/operations/snapshot', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      assert.equal(data['nextCursor'], null);
    });
  });

  describe('snapshot health and budget fields', () => {
    it('snapshot includes populated health from daemon status', () => {
      const state = makeState({ tasks: [makeTask()] });
      const ctx = makeReadCtx('GET', '/operations/snapshot', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const health = data['health'] as Record<string, unknown>;
      assert.notEqual(health, null);
      assert.equal(health['status'], 'healthy');
      assert.equal(health['scope'], 'global');
    });

    it('snapshot includes populated budget from usage check', () => {
      const state = makeState({ tasks: [makeTask()] });
      const ctx = makeReadCtx('GET', '/operations/snapshot', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const budget = data['budget'] as Record<string, unknown>;
      assert.notEqual(budget, null);
      assert.equal(budget['scope'], 'global');
      assert.equal(budget['status'], 'normal');
    });

    it('snapshot budget reflects warning usage level', () => {
      const state = makeState({ tasks: [makeTask()] });
      const ctx = makeReadCtx(
        'GET',
        '/operations/snapshot',
        state,
        {},
        {
          checkUsage: () => ({
            level: 'warning',
            percent: 85,
            todayTokens: 850,
            message: 'approaching limit',
            confidence: 1,
            model: 'test',
            budget: 1000,
            used: 850,
            remaining: 150,
            resetAt: '',
            resetInMs: 0,
            agents: {},
          }),
        },
      );
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const budget = data['budget'] as Record<string, unknown>;
      assert.equal(budget['status'], 'warning');
    });

    it('snapshot health reflects unavailable daemon', () => {
      const state = makeState({ tasks: [makeTask()] });
      const ctx = makeReadCtx(
        'GET',
        '/operations/snapshot',
        state,
        {},
        {
          readStatus: () => ({ running: false }),
        },
      );
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const health = data['health'] as Record<string, unknown>;
      assert.equal(health['status'], 'unavailable');
    });

    it('snapshot budget keeps critical-threshold usage as warning while budget remains', () => {
      const state = makeState({ tasks: [makeTask()] });
      const ctx = makeReadCtx(
        'GET',
        '/operations/snapshot',
        state,
        {},
        {
          checkUsage: () => ({
            level: 'critical',
            percent: 95,
            todayTokens: 9500,
            message: 'over budget',
            confidence: 1,
            model: 'test',
            budget: 10000,
            used: 9500,
            remaining: 500,
            resetAt: '',
            resetInMs: 0,
            agents: {},
          }),
        },
      );
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const budget = data['budget'] as Record<string, unknown>;
      assert.equal(budget['status'], 'warning');
    });

    it('snapshot budget reflects exceeded status when budget is fully consumed', () => {
      const state = makeState({ tasks: [makeTask()] });
      const ctx = makeReadCtx(
        'GET',
        '/operations/snapshot',
        state,
        {},
        {
          checkUsage: () => ({
            level: 'critical',
            percent: 100,
            todayTokens: 10_000,
            message: 'budget exhausted',
            confidence: 1,
            model: 'test',
            budget: 10_000,
            used: 10_000,
            remaining: 0,
            resetAt: '',
            resetInMs: 0,
            agents: {},
          }),
        },
      );
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const budget = data['budget'] as Record<string, unknown>;
      assert.equal(budget['status'], 'exceeded');
    });

    it('still returns queue data when readStatus throws', () => {
      const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
      const ctx = makeReadCtx(
        'GET',
        '/operations/snapshot',
        state,
        {},
        {
          readStatus: () => {
            throw new Error('status failed');
          },
        },
      );

      handleOperationsReadRoute(ctx);

      const data = ctx.captured.data as Record<string, unknown>;
      const queue = data['queue'] as Array<Record<string, unknown>>;
      const budget = data['budget'] as Record<string, unknown>;
      assert.equal(ctx.captured.statusCode, 200);
      assert.equal(queue[0]['id'], 'task-1');
      assert.equal(data['health'], null);
      assert.equal(budget['scope'], 'global');
      assert.equal(budget['status'], 'normal');
    });

    it('still returns queue data when checkUsage throws', () => {
      const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
      const ctx = makeReadCtx(
        'GET',
        '/operations/snapshot',
        state,
        {},
        {
          checkUsage: () => {
            throw new Error('usage failed');
          },
        },
      );

      handleOperationsReadRoute(ctx);

      const data = ctx.captured.data as Record<string, unknown>;
      const queue = data['queue'] as Array<Record<string, unknown>>;
      const health = data['health'] as Record<string, unknown>;
      assert.equal(ctx.captured.statusCode, 200);
      assert.equal(queue[0]['id'], 'task-1');
      assert.equal(data['budget'], null);
      assert.equal(health['scope'], 'global');
      assert.equal(health['status'], 'healthy');
    });
  });

  describe('query param: statusFilter', () => {
    it('filters queue items by comma-separated status values', () => {
      const state = makeState({
        tasks: [
          makeTask({ id: 'task-1', status: 'todo' }),
          makeTask({ id: 'task-2', status: 'in_progress' }),
          makeTask({ id: 'task-3', status: 'done' }),
        ],
      });
      const ctx = makeReadCtx('GET', '/operations/snapshot', state, {
        statusFilter: 'active',
      });
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const queue = data['queue'] as unknown[];
      assert.equal(queue.length, 1);
    });

    it('accepts multiple status values', () => {
      const state = makeState({
        tasks: [
          makeTask({ id: 'task-1', status: 'todo' }),
          makeTask({ id: 'task-2', status: 'in_progress' }),
          makeTask({ id: 'task-3', status: 'done' }),
        ],
      });
      const ctx = makeReadCtx('GET', '/operations/snapshot', state, {
        statusFilter: 'waiting,active',
      });
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const queue = data['queue'] as unknown[];
      assert.equal(queue.length, 2);
    });

    it('accepts repeated statusFilter query params from gateway-style requests', () => {
      const state = makeState({
        tasks: [
          makeTask({ id: 'task-1', status: 'todo' }),
          makeTask({ id: 'task-2', status: 'in_progress' }),
          makeTask({ id: 'task-3', status: 'done' }),
        ],
      });
      const ctx = makeReadCtx('GET', '/operations/snapshot', state, {
        statusFilter: 'active',
      });
      ctx.requestUrl.searchParams.append('statusFilter', 'waiting');
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const queue = data['queue'] as Array<Record<string, unknown>>;
      assert.deepStrictEqual(
        queue.map((item) => item['id']),
        ['task-2', 'task-1'],
      );
    });

    it('returns 400 for an invalid statusFilter value', () => {
      const state = makeState({ tasks: [makeTask()] });
      const ctx = makeReadCtx('GET', '/operations/snapshot', state, {
        statusFilter: 'bogus',
      });
      const handled = handleOperationsReadRoute(ctx);
      assert.equal(handled, true);
      assert.equal(ctx.captured.statusCode, 400);
    });

    it('returns 400 when statusFilter mixes valid and invalid tokens', () => {
      const state = makeState({ tasks: [makeTask()] });
      const ctx = makeReadCtx('GET', '/operations/snapshot', state, {
        statusFilter: 'active,bogus',
      });
      const handled = handleOperationsReadRoute(ctx);
      assert.equal(handled, true);
      assert.equal(ctx.captured.statusCode, 400);
    });

    it('returns 400 when repeated statusFilter params contain an invalid token', () => {
      const state = makeState({ tasks: [makeTask()] });
      const ctx = makeReadCtx('GET', '/operations/snapshot', state, {
        statusFilter: 'active',
      });
      ctx.requestUrl.searchParams.append('statusFilter', 'nope');
      const handled = handleOperationsReadRoute(ctx);
      assert.equal(handled, true);
      assert.equal(ctx.captured.statusCode, 400);
    });

    it('returns 400 for empty statusFilter tokens', () => {
      const state = makeState({ tasks: [makeTask()] });
      const ctx = makeReadCtx('GET', '/operations/snapshot', state, {
        statusFilter: 'active,',
      });
      const handled = handleOperationsReadRoute(ctx);
      assert.equal(handled, true);
      assert.equal(ctx.captured.statusCode, 400);
    });
  });

  describe('query param: limit', () => {
    it('limits the number of returned items', () => {
      const state = makeState({
        tasks: [
          makeTask({ id: 'task-1', updatedAt: '2025-01-01T00:00:00.000Z' }),
          makeTask({ id: 'task-2', updatedAt: '2025-01-01T01:00:00.000Z' }),
          makeTask({ id: 'task-3', updatedAt: '2025-01-01T02:00:00.000Z' }),
        ],
      });
      const ctx = makeReadCtx('GET', '/operations/snapshot', state, { limit: '2' });
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const queue = data['queue'] as unknown[];
      assert.equal(queue.length, 2);
      assert.ok(data['nextCursor'] !== null, 'nextCursor should be set when truncated');
    });

    it('ignores invalid limit values', () => {
      const state = makeState({
        tasks: [makeTask({ id: 'task-1' }), makeTask({ id: 'task-2' })],
      });
      const ctx = makeReadCtx('GET', '/operations/snapshot', state, { limit: 'abc' });
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const queue = data['queue'] as unknown[];
      assert.equal(queue.length, 2);
    });

    it('ignores partially numeric limit values like "10abc"', () => {
      const state = makeState({
        tasks: Array.from({ length: 11 }, (_, index) =>
          makeTask({
            id: `task-${String(index + 1)}`,
            updatedAt: `2025-01-01T${String(index).padStart(2, '0')}:00:00.000Z`,
          }),
        ),
      });
      const ctx = makeReadCtx('GET', '/operations/snapshot', state, { limit: '10abc' });
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const queue = data['queue'] as unknown[];
      assert.equal(queue.length, 11);
      assert.equal(data['nextCursor'], null);
    });

    it('applies cursor before limit when paginating', () => {
      const state = makeState({
        tasks: [
          makeTask({
            id: 'task-active-1',
            status: 'in_progress',
            updatedAt: '2026-03-25T00:00:03.000Z',
          }),
          makeTask({
            id: 'task-active-2',
            status: 'in_progress',
            updatedAt: '2026-03-25T00:00:02.000Z',
          }),
          makeTask({ id: 'task-waiting', status: 'todo', updatedAt: '2026-03-25T00:00:01.000Z' }),
        ],
      });
      const ctx = makeReadCtx('GET', '/operations/snapshot', state, {
        cursor: 'task-active-1',
        limit: '1',
      });
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const queue = data['queue'] as Array<Record<string, unknown>>;
      assert.deepStrictEqual(
        queue.map((item) => item['id']),
        ['task-active-2'],
      );
      assert.equal(data['nextCursor'], 'task-active-2');
    });
  });

  describe('projected item shape', () => {
    it('includes all WorkQueueItemView fields', () => {
      const now = new Date().toISOString();
      const state = makeState({
        tasks: [makeTask({ id: 'task-1', title: 'Do stuff', owner: 'gemini', updatedAt: now })],
      });
      const ctx = makeReadCtx('GET', '/operations/snapshot', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const queue = data['queue'] as Record<string, unknown>[];
      const item = queue[0];

      assert.equal(item['id'], 'task-1');
      assert.equal(item['title'], 'Do stuff');
      assert.equal(item['status'], 'waiting');
      assert.equal(item['ownerLabel'], 'gemini');
      assert.equal(item['updatedAt'], now);
      assert.ok('position' in item);
      assert.ok('relatedConversationId' in item);
      assert.ok('relatedSessionId' in item);
      assert.ok('lastCheckpointSummary' in item);
      assert.ok('riskSignals' in item);
      assert.ok('detailAvailability' in item);
    });
  });

  // ── GET /operations/work-items/:id ──────────────────────────────────────

  describe('GET /operations/work-items/:id', () => {
    it('handles the work-item detail route', () => {
      const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1', state);
      const handled = handleOperationsReadRoute(ctx);
      assert.equal(handled, true);
      assert.equal(ctx.captured.statusCode, 200);
    });

    it('returns 404 when work item is not found', () => {
      const state = makeState({ tasks: [] });
      const ctx = makeReadCtx('GET', '/operations/work-items/nonexistent', state);
      const handled = handleOperationsReadRoute(ctx);
      assert.equal(handled, true);
      assert.equal(ctx.captured.statusCode, 404);
    });

    it('returns projected item with correct fields', () => {
      const now = new Date().toISOString();
      const state = makeState({
        tasks: [makeTask({ id: 'task-1', title: 'Build feature', owner: 'codex', updatedAt: now })],
      });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const item = data['item'] as Record<string, unknown>;
      assert.equal(item['id'], 'task-1');
      assert.equal(item['title'], 'Build feature');
      assert.equal(item['status'], 'waiting');
      assert.equal(item['ownerLabel'], 'codex');
    });

    it('returns checkpoints array', () => {
      const state = makeState({
        tasks: [
          makeTask({
            id: 'task-1',
            checkpoints: [
              { note: 'Step 1', at: '2025-01-01T00:00:00.000Z' },
              { note: 'Step 2', at: '2025-01-01T01:00:00.000Z' },
            ],
          }),
        ],
      });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const checkpoints = data['checkpoints'] as unknown[];
      assert.equal(checkpoints.length, 2);
    });

    it('returns checkpoints with monotonic sequence', () => {
      const state = makeState({
        tasks: [
          makeTask({
            id: 'task-1',
            checkpoints: [
              { note: 'A', at: '2025-01-01T00:00:00.000Z' },
              { note: 'B', at: '2025-01-01T01:00:00.000Z' },
              { note: 'C', at: '2025-01-01T02:00:00.000Z' },
            ],
          }),
        ],
      });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const checkpoints = data['checkpoints'] as Array<Record<string, unknown>>;
      assert.equal(checkpoints[0]['sequence'], 0);
      assert.equal(checkpoints[1]['sequence'], 1);
      assert.equal(checkpoints[2]['sequence'], 2);
    });

    it('returns routing as null (not yet tracked)', () => {
      const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      assert.equal(data['routing'], null);
    });

    it('returns empty assignments array', () => {
      const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      assert.deepStrictEqual(data['assignments'], []);
    });

    it('returns council as null', () => {
      const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      assert.equal(data['council'], null);
    });

    it('returns empty controls array', () => {
      const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      assert.deepStrictEqual(data['controls'], []);
    });

    it('returns unavailable item budget for work item', () => {
      const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const itemBudget = data['itemBudget'] as Record<string, unknown>;
      assert.notEqual(itemBudget, null);
      assert.equal(itemBudget['status'], 'unavailable');
      assert.equal(itemBudget['scope'], 'work-item');
      assert.equal(itemBudget['scopeId'], 'task-1');
    });

    it('returns availability as partial', () => {
      const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      assert.equal(data['availability'], 'partial');
    });

    it('returns false for non-GET methods on work-item route', () => {
      const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
      const ctx = makeReadCtx('POST', '/operations/work-items/task-1', state);
      const handled = handleOperationsReadRoute(ctx);
      assert.equal(handled, false);
    });

    it('projects checkpoints with recovery status', () => {
      const state = makeState({
        tasks: [
          makeTask({
            id: 'task-1',
            checkpoints: [
              { note: 'Started', at: '2025-01-01T00:00:00.000Z' },
              {
                note: 'Recovered after crash',
                at: '2025-01-01T01:00:00.000Z',
                status: 'recovered',
              },
            ],
          }),
        ],
      });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const checkpoints = data['checkpoints'] as Array<Record<string, unknown>>;
      assert.equal(checkpoints[1]['status'], 'recovered');
    });

    it('projects checkpoints with waiting status', () => {
      const state = makeState({
        tasks: [
          makeTask({
            id: 'task-1',
            checkpoints: [
              { note: 'Awaiting approval', at: '2025-01-01T00:00:00.000Z', status: 'waiting' },
            ],
          }),
        ],
      });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const checkpoints = data['checkpoints'] as Array<Record<string, unknown>>;
      assert.equal(checkpoints[0]['status'], 'waiting');
    });

    it('accepts singular /operations/work-item/ for backward compatibility', () => {
      const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
      const ctx = makeReadCtx('GET', '/operations/work-item/task-1', state);
      const handled = handleOperationsReadRoute(ctx);
      assert.equal(handled, true);
      assert.equal(ctx.captured.statusCode, 200);
    });

    it('projects daemon-persisted checkpoint shape (name/savedAt/context/agent)', () => {
      const state = makeState({
        tasks: [
          makeTask({
            id: 'task-1',
            checkpoints: [
              {
                note: '',
                at: '',
                name: 'Implement parser',
                savedAt: '2025-06-01T10:00:00.000Z',
                context: 'Added AST nodes',
                agent: 'codex',
              },
            ] as unknown as Array<{ note: string; at: string }>,
          }),
        ],
      });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const checkpoints = data['checkpoints'] as Array<Record<string, unknown>>;
      assert.equal(checkpoints[0]['label'], 'Implement parser');
      assert.equal(checkpoints[0]['timestamp'], '2025-06-01T10:00:00.000Z');
      assert.equal(checkpoints[0]['detail'], 'Added AST nodes');
    });
  });

  // ── GET /operations/work-items/:id/checkpoints ──────────────────────────

  describe('GET /operations/work-items/:id/checkpoints', () => {
    it('handles the checkpoints sub-route', () => {
      const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1/checkpoints', state);
      const handled = handleOperationsReadRoute(ctx);
      assert.equal(handled, true);
      assert.equal(ctx.captured.statusCode, 200);
    });

    it('returns 404 when work item is not found', () => {
      const state = makeState({ tasks: [] });
      const ctx = makeReadCtx('GET', '/operations/work-items/missing/checkpoints', state);
      const handled = handleOperationsReadRoute(ctx);
      assert.equal(handled, true);
      assert.equal(ctx.captured.statusCode, 404);
    });

    it('returns workItemId and checkpoints array', () => {
      const state = makeState({
        tasks: [
          makeTask({
            id: 'task-1',
            checkpoints: [
              { note: 'First', at: '2025-01-01T00:00:00.000Z' },
              { note: 'Second', at: '2025-01-01T01:00:00.000Z' },
            ],
          }),
        ],
      });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1/checkpoints', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      assert.equal(data['workItemId'], 'task-1');
      const checkpoints = data['checkpoints'] as unknown[];
      assert.equal(checkpoints.length, 2);
    });

    it('returns availability field', () => {
      const state = makeState({
        tasks: [
          makeTask({
            id: 'task-1',
            checkpoints: [{ note: 'Done', at: '2025-01-01T00:00:00.000Z' }],
          }),
        ],
      });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1/checkpoints', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      assert.equal(data['availability'], 'ready');
    });

    it('returns partial availability when task has no checkpoints', () => {
      const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1/checkpoints', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      assert.equal(data['availability'], 'partial');
    });

    it('returns checkpoints with monotonic sequences', () => {
      const state = makeState({
        tasks: [
          makeTask({
            id: 'task-1',
            checkpoints: [
              { note: 'A', at: '2025-01-01T00:00:00.000Z' },
              { note: 'B', at: '2025-01-01T01:00:00.000Z' },
            ],
          }),
        ],
      });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1/checkpoints', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const checkpoints = data['checkpoints'] as Array<Record<string, unknown>>;
      assert.equal(checkpoints[0]['sequence'], 0);
      assert.equal(checkpoints[1]['sequence'], 1);
    });

    it('accepts singular /operations/work-item/ for backward compatibility', () => {
      const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
      const ctx = makeReadCtx('GET', '/operations/work-item/task-1/checkpoints', state);
      const handled = handleOperationsReadRoute(ctx);
      assert.equal(handled, true);
      assert.equal(ctx.captured.statusCode, 200);
    });
  });

  describe('URL-encoded work-item IDs', () => {
    it('decodes encoded colon in detail route', () => {
      const id = 'ns:task-1';
      const state = makeState({ tasks: [makeTask({ id })] });
      const ctx = makeReadCtx('GET', `/operations/work-items/${encodeURIComponent(id)}`, state);
      const handled = handleOperationsReadRoute(ctx);
      assert.equal(handled, true);
      assert.equal(ctx.captured.statusCode, 200);
      const data = ctx.captured.data as Record<string, unknown>;
      const item = data['item'] as Record<string, unknown>;
      assert.equal(item['id'], id);
    });

    it('decodes encoded slash in detail route', () => {
      const id = 'scope/task-2';
      const state = makeState({ tasks: [makeTask({ id })] });
      const ctx = makeReadCtx('GET', `/operations/work-items/${encodeURIComponent(id)}`, state);
      const handled = handleOperationsReadRoute(ctx);
      assert.equal(handled, true);
      assert.equal(ctx.captured.statusCode, 200);
      const data = ctx.captured.data as Record<string, unknown>;
      const item = data['item'] as Record<string, unknown>;
      assert.equal(item['id'], id);
    });

    it('decodes encoded colon in checkpoints route', () => {
      const id = 'ns:task-3';
      const state = makeState({ tasks: [makeTask({ id })] });
      const ctx = makeReadCtx(
        'GET',
        `/operations/work-items/${encodeURIComponent(id)}/checkpoints`,
        state,
      );
      const handled = handleOperationsReadRoute(ctx);
      assert.equal(handled, true);
      assert.equal(ctx.captured.statusCode, 200);
      const data = ctx.captured.data as Record<string, unknown>;
      assert.equal(data['workItemId'], id);
    });

    it('decodes encoded slash in checkpoints route', () => {
      const id = 'scope/task-4';
      const state = makeState({ tasks: [makeTask({ id })] });
      const ctx = makeReadCtx(
        'GET',
        `/operations/work-items/${encodeURIComponent(id)}/checkpoints`,
        state,
      );
      const handled = handleOperationsReadRoute(ctx);
      assert.equal(handled, true);
      assert.equal(ctx.captured.statusCode, 200);
      const data = ctx.captured.data as Record<string, unknown>;
      assert.equal(data['workItemId'], id);
    });

    it('handles malformed percent-encoding gracefully', () => {
      const state = makeState({ tasks: [makeTask({ id: '%ZZbad' })] });
      const ctx = makeReadCtx('GET', '/operations/work-items/%ZZbad', state);
      const handled = handleOperationsReadRoute(ctx);
      assert.equal(handled, true);
      assert.equal(ctx.captured.statusCode, 200);
    });
  });
});
