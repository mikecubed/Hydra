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
import type { ReadRouteCtx, HydraStateShape, TaskEntry } from '../lib/types.ts';
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
});
