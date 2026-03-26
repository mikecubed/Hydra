/**
 * Unit tests for lib/daemon/web-operations-routes.ts
 *
 * Covers the /operations/snapshot read route: query param parsing,
 * response shape, status filtering, limit, and error handling.
 * Uses mock ReadRouteCtx — no daemon process required.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { EventEmitter } from 'node:events';
import type { ReadRouteCtx, HydraStateShape, TaskEntry, UsageCheckResult } from '../lib/types.ts';
import { handleOperationsReadRoute } from '../lib/daemon/web-operations-routes.ts';
import { handleWriteRoute } from '../lib/daemon/write-routes.ts';
import { projectWorkItemDetail } from '../lib/daemon/web-operations-projection.ts';
import {
  discoverControls,
  computeRevisionToken,
  executeControlMutation,
  type ControlContext,
} from '../lib/daemon/web-operations-controls.ts';

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

function captureWarningText(message: unknown): string {
  if (typeof message === 'string') {
    return message;
  }

  return message instanceof Error ? message.message : '';
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

  describe('snapshot refreshes status before reading', () => {
    it('calls writeStatus before readStatus', () => {
      const callOrder: string[] = [];
      const state = makeState({ tasks: [makeTask()] });
      const ctx = makeReadCtx(
        'GET',
        '/operations/snapshot',
        state,
        {},
        {
          readStatus: () => {
            callOrder.push('readStatus');
            return { running: true };
          },
        },
      );
      ctx.writeStatus = () => {
        callOrder.push('writeStatus');
      };
      handleOperationsReadRoute(ctx);
      assert.ok(callOrder.includes('writeStatus'), 'writeStatus should be called');
      assert.ok(
        callOrder.indexOf('writeStatus') < callOrder.indexOf('readStatus'),
        'writeStatus should be called before readStatus',
      );
    });

    it('still returns snapshot when writeStatus throws', () => {
      const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
      const ctx = makeReadCtx('GET', '/operations/snapshot', state);
      ctx.writeStatus = () => {
        throw new Error('write failed');
      };
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (message?: unknown) => {
        warnings.push(captureWarningText(message));
      };
      try {
        handleOperationsReadRoute(ctx);
      } finally {
        console.warn = originalWarn;
      }
      assert.equal(ctx.captured.statusCode, 200);
      const data = ctx.captured.data as Record<string, unknown>;
      assert.ok(Array.isArray(data['queue']));
      assert.ok(warnings.some((w) => w.includes('writeStatus')));
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

    it('snapshot health reflects recovering daemon after startup', () => {
      const state = makeState({ tasks: [makeTask()] });
      const ctx = makeReadCtx(
        'GET',
        '/operations/snapshot',
        state,
        {},
        {
          readStatus: () => ({
            running: true,
            uptimeSec: 20,
            updatedAt: '2025-01-01T00:00:20.000Z',
          }),
        },
      );
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const health = data['health'] as Record<string, unknown>;
      assert.equal(health['status'], 'recovering');
    });

    it('snapshot health reflects degraded daemon when active-session telemetry is stale', () => {
      const state = makeState({ tasks: [makeTask()] });
      const ctx = makeReadCtx(
        'GET',
        '/operations/snapshot',
        state,
        {},
        {
          readStatus: () => ({
            running: true,
            uptimeSec: 300,
            activeSessionId: 'session-1',
            updatedAt: '2025-01-01T00:05:00.000Z',
            stateUpdatedAt: '2025-01-01T00:00:00.000Z',
            lastEventAt: '2025-01-01T00:01:00.000Z',
          }),
        },
      );
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const health = data['health'] as Record<string, unknown>;
      assert.equal(health['status'], 'degraded');
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

    it('still returns queue data and explicit unavailable health when readStatus throws', () => {
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
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (message?: unknown) => {
        warnings.push(captureWarningText(message));
      };
      try {
        handleOperationsReadRoute(ctx);
      } finally {
        console.warn = originalWarn;
      }

      const data = ctx.captured.data as Record<string, unknown>;
      const queue = data['queue'] as Array<Record<string, unknown>>;
      const budget = data['budget'] as Record<string, unknown>;
      const health = data['health'] as Record<string, unknown>;
      assert.equal(ctx.captured.statusCode, 200);
      assert.equal(queue[0]['id'], 'task-1');
      assert.equal(data['availability'], 'partial');
      assert.equal(health['scope'], 'global');
      assert.equal(health['status'], 'unavailable');
      assert.equal(budget['scope'], 'global');
      assert.equal(budget['status'], 'normal');
      assert.ok(warnings.some((warning) => warning.includes('readStatus probe failed')));
    });

    it('still returns queue data and explicit unavailable budget when checkUsage throws', () => {
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
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (message?: unknown) => {
        warnings.push(captureWarningText(message));
      };
      try {
        handleOperationsReadRoute(ctx);
      } finally {
        console.warn = originalWarn;
      }

      const data = ctx.captured.data as Record<string, unknown>;
      const queue = data['queue'] as Array<Record<string, unknown>>;
      const health = data['health'] as Record<string, unknown>;
      const budget = data['budget'] as Record<string, unknown>;
      assert.equal(ctx.captured.statusCode, 200);
      assert.equal(queue[0]['id'], 'task-1');
      assert.equal(data['availability'], 'partial');
      assert.equal(health['scope'], 'global');
      assert.equal(health['status'], 'healthy');
      assert.equal(budget['scope'], 'global');
      assert.equal(budget['status'], 'unavailable');
      assert.ok(warnings.some((warning) => warning.includes('checkUsage probe failed')));
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

    it('returns routing as null when no routingHistory on task', () => {
      const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      assert.equal(data['routing'], null);
    });

    it('returns populated routing when task has routingHistory', () => {
      const state = makeState({
        tasks: [
          makeTask({
            id: 'task-1',
            routingHistory: [
              {
                route: 'claude',
                mode: 'council',
                changedAt: '2025-06-01T10:00:00.000Z',
                reason: 'Architecture analysis',
              },
            ],
          }),
        ],
      });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const routing = data['routing'] as Record<string, unknown>;
      assert.notEqual(routing, null);
      assert.equal(routing['currentRoute'], 'claude');
      assert.equal(routing['currentMode'], 'council');
      assert.ok(Array.isArray(routing['history']));
    });

    it('skips malformed history entries without failing the route', () => {
      const state = makeState({
        tasks: [
          makeTask({
            id: 'task-1',
            routingHistory: [null],
            assignmentHistory: [null],
            councilHistory: {
              status: 'completed',
              participants: [null],
              transitions: [null],
              finalOutcome: 'Done',
            },
          }),
        ],
      });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      assert.equal(ctx.captured.statusCode, 200);
      assert.equal(data['routing'], null);
      assert.deepStrictEqual(data['assignments'], []);
      const council = data['council'] as Record<string, unknown>;
      assert.deepStrictEqual(council['participants'], []);
      assert.deepStrictEqual(council['transitions'], []);
    });

    it('normalizes invalid history timestamps to contract-safe values', () => {
      const state = makeState({
        tasks: [
          makeTask({
            id: 'task-1',
            routingHistory: [
              {
                route: 'claude',
                mode: 'council',
                changedAt: '2025-06-01 10:00:00Z',
                reason: 'Non-ISO timestamp',
              },
            ],
            assignmentHistory: [
              {
                agent: 'codex',
                role: 'implementer',
                state: 'active',
                startedAt: '2025-06-01 10:00:00Z',
                endedAt: null,
              },
            ],
            councilHistory: {
              status: 'completed',
              participants: [],
              transitions: [
                {
                  label: 'Round 1',
                  status: 'completed',
                  timestamp: '2025-06-01 10:00:00Z',
                  detail: 'Non-ISO timestamp',
                },
              ],
              finalOutcome: 'Done',
            },
          }),
        ],
      });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const routing = data['routing'] as Record<string, unknown>;
      const assignments = data['assignments'] as Array<Record<string, unknown>>;
      const council = data['council'] as Record<string, unknown>;
      const transitions = council['transitions'] as Array<Record<string, unknown>>;

      assert.equal(ctx.captured.statusCode, 200);
      assert.equal(routing['changedAt'], '1970-01-01T00:00:00.000Z');
      assert.equal(assignments[0]['startedAt'], null);
      assert.equal(transitions[0]['timestamp'], '1970-01-01T00:00:00.000Z');
    });

    it('returns empty assignments array when no assignmentHistory', () => {
      const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      assert.deepStrictEqual(data['assignments'], []);
    });

    it('returns populated assignments when task has assignmentHistory', () => {
      const state = makeState({
        tasks: [
          makeTask({
            id: 'task-1',
            assignmentHistory: [
              {
                agent: 'codex',
                role: 'implementer',
                state: 'active',
                startedAt: '2025-06-01T10:00:00.000Z',
                endedAt: null,
              },
            ],
          }),
        ],
      });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const assignments = data['assignments'] as Array<Record<string, unknown>>;
      assert.equal(assignments.length, 1);
      assert.equal(assignments[0]['participantId'], 'codex');
      assert.equal(assignments[0]['state'], 'active');
    });

    it('returns council as null when no councilHistory', () => {
      const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      assert.equal(data['council'], null);
    });

    it('returns populated council when task has councilHistory', () => {
      const state = makeState({
        tasks: [
          makeTask({
            id: 'task-1',
            councilHistory: {
              status: 'completed',
              participants: [
                {
                  agent: 'claude',
                  role: 'architect',
                  state: 'completed',
                  startedAt: '2025-06-01T10:00:00.000Z',
                  endedAt: '2025-06-01T11:00:00.000Z',
                },
              ],
              transitions: [
                {
                  label: 'Round 1',
                  status: 'completed',
                  timestamp: '2025-06-01T10:30:00.000Z',
                  detail: 'Design review',
                },
              ],
              finalOutcome: 'Consensus reached',
            },
          }),
        ],
      });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const council = data['council'] as Record<string, unknown>;
      assert.notEqual(council, null);
      assert.equal(council['status'], 'completed');
      assert.equal(council['finalOutcome'], 'Consensus reached');
      const participants = council['participants'] as unknown[];
      assert.equal(participants.length, 1);
    });

    it('returns populated controls array for active work item', () => {
      const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const controls = data['controls'] as unknown[];
      assert.ok(Array.isArray(controls), 'controls should be an array');
      assert.ok(controls.length > 0, 'controls should be populated for active work items');
      const first = controls[0] as Record<string, unknown>;
      assert.ok(typeof first['controlId'] === 'string');
      assert.ok(typeof first['kind'] === 'string');
      assert.ok(typeof first['availability'] === 'string');
      assert.ok(typeof first['authority'] === 'string');
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

    it('returns availability as partial when no history data', () => {
      const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      assert.equal(data['availability'], 'partial');
    });

    it('returns availability as ready when all history data is populated', () => {
      const state = makeState({
        tasks: [
          makeTask({
            id: 'task-1',
            routingHistory: [
              {
                route: 'claude',
                mode: 'council',
                changedAt: '2025-06-01T10:00:00.000Z',
                reason: 'Architecture',
              },
            ],
            assignmentHistory: [
              {
                agent: 'claude',
                role: 'architect',
                state: 'active',
                startedAt: '2025-06-01T10:00:00.000Z',
                endedAt: null,
              },
            ],
            councilHistory: {
              status: 'active',
              participants: [
                {
                  agent: 'claude',
                  role: 'architect',
                  state: 'active',
                  startedAt: '2025-06-01T10:00:00.000Z',
                  endedAt: null,
                },
              ],
              transitions: [],
              finalOutcome: null,
            },
          }),
        ],
      });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      assert.equal(data['availability'], 'ready');
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

// ── T038: Control Discovery, Authority, Actionable/Read-Only, Outcomes ──────

function makeControlConfig(overrides: Partial<ControlContext> = {}): ControlContext {
  return {
    loadConfig: () => ({ mode: 'auto', routing: { mode: 'balanced' } }),
    agentNames: ['claude', 'gemini', 'codex'],
    nowIso: () => '2025-01-15T12:00:00.000Z',
    ...overrides,
  };
}

function makeWriteCtx(
  method: string,
  routePath: string,
  state: HydraStateShape,
  bodyData: Record<string, unknown> = {},
): {
  captured: { statusCode: number; data: unknown };
  ctx: Parameters<typeof handleWriteRoute>[0];
} {
  const url = new URL(`http://localhost${routePath}`);
  const captured: { statusCode: number; data: unknown } = { statusCode: 0, data: null };
  const req = new EventEmitter() as IncomingMessage & { headers: Record<string, string> };
  req.headers = {};
  const res = new EventEmitter() as ServerResponse & {
    writeHead: () => ServerResponse;
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
    ctx: {
      method,
      route: routePath,
      requestUrl: url,
      req,
      res,
      sendJson,
      sendError,
      writeStatus: () => {},
      readStatus: () => ({ running: true }),
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
      getSummary: () => ({ project: 'test', tasks: 0, handoffs: 0 }),
      buildPrompt: () => '',
      suggestNext: () => ({ action: 'none' }),
      readEvents: () => [],
      replayEvents: () => [],
      readJsonBody: () => Promise.resolve(bodyData),
      enqueueMutation: <T>(_label: string, mutator: (s: HydraStateShape) => T) =>
        Promise.resolve(mutator(state)),
      ensureKnownAgent: () => {},
      ensureKnownStatus: () => {},
      parseList: (val: unknown) =>
        String(val)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      getCurrentBranch: () => 'main',
      toSessionId: () => 'ses_test',
      nowIso: () => '2025-01-15T12:00:00.000Z',
      classifyTask: () => 'feat',
      nextId: (prefix: string, items: unknown[]) => `${prefix}_${String(items.length + 1)}`,
      detectCycle: () => false,
      autoUnblock: () => {},
      AGENT_NAMES: ['claude', 'gemini', 'codex'],
      getAgent: () => {},
      listAgents: () => [],
      resolveVerificationPlan: () => ({}),
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
      mergeTaskWorktree: () => ({}),
      cleanupTaskWorktree: () => {},
      sseClients: new Set(),
      readArchive: () => ({
        snapshots: [],
        lastArchiveAt: null,
        tasks: [],
        handoffs: [],
        blockers: [],
      }),
      getMetricsSummary: () => ({}),
      getEventCount: () => 0,
    } as Parameters<typeof handleWriteRoute>[0],
  };
}

describe('Control Discovery (T038/T039)', () => {
  describe('discoverControls', () => {
    it('discovers four control kinds for an active work item', () => {
      const task = makeTask({ id: 'task-1', status: 'todo' });
      const config = makeControlConfig();
      const controls = discoverControls(task, config);
      assert.equal(controls.length, 4);
      const kinds = controls.map((c) => c.kind);
      assert.deepStrictEqual(kinds, ['routing', 'mode', 'agent', 'council']);
    });

    it('marks all controls as actionable for non-terminal work items', () => {
      const task = makeTask({ id: 'task-1', status: 'in_progress' });
      const config = makeControlConfig();
      const controls = discoverControls(task, config);
      for (const control of controls) {
        assert.equal(control.availability, 'actionable');
        assert.equal(control.authority, 'granted');
        assert.equal(control.reason, null);
      }
    });

    it('marks all controls as read-only for terminal work items', () => {
      for (const status of ['done', 'failed', 'cancelled'] as const) {
        const task = makeTask({ id: 'task-1', status });
        const config = makeControlConfig();
        const controls = discoverControls(task, config);
        for (const control of controls) {
          assert.equal(
            control.availability,
            'read-only',
            `Expected read-only for status=${status}`,
          );
          assert.equal(
            control.authority,
            'unavailable',
            `Expected unavailable authority for status=${status}`,
          );
          assert.equal(control.reason, `Work item is ${status}`);
        }
      }
    });

    it('includes expectedRevision for actionable controls', () => {
      const task = makeTask({ id: 'task-1', status: 'todo' });
      const config = makeControlConfig();
      const controls = discoverControls(task, config);
      for (const control of controls) {
        assert.ok(
          typeof control.expectedRevision === 'string' && control.expectedRevision.length > 0,
          'actionable controls must have expectedRevision',
        );
      }
    });

    it('excludes expectedRevision for read-only controls', () => {
      const task = makeTask({ id: 'task-1', status: 'done' });
      const config = makeControlConfig();
      const controls = discoverControls(task, config);
      for (const control of controls) {
        assert.equal(control.expectedRevision, null);
      }
    });

    it('includes options with selected state for routing strategy', () => {
      const task = makeTask({ id: 'task-1', status: 'todo' });
      const config = makeControlConfig({
        loadConfig: () => ({ mode: 'auto', routing: { mode: 'performance' } }),
      });
      const controls = discoverControls(task, config);
      const routing = controls.find((c) => c.kind === 'routing');
      assert.ok(routing != null);
      const selected = routing.options.find((o) => o.selected);
      assert.ok(selected != null);
      assert.equal(selected.optionId, 'routing-performance');
    });

    it('includes agent options from config', () => {
      const task = makeTask({ id: 'task-1', status: 'todo', owner: 'gemini' });
      const config = makeControlConfig({ agentNames: ['claude', 'gemini', 'codex'] });
      const controls = discoverControls(task, config);
      const agentControl = controls.find((c) => c.kind === 'agent');
      assert.ok(agentControl != null);
      assert.equal(agentControl.options.length, 3);
      const selected = agentControl.options.find((o) => o.selected);
      assert.ok(selected != null);
      assert.equal(selected.optionId, 'agent-gemini');
    });

    it('includes mode options reflecting current dispatch mode', () => {
      const task = makeTask({
        id: 'task-1',
        status: 'in_progress',
        routingHistory: [
          { route: 'claude', mode: 'council', changedAt: '2025-01-15T12:00:00Z', reason: 'test' },
        ],
      });
      const config = makeControlConfig();
      const controls = discoverControls(task, config);
      const mode = controls.find((c) => c.kind === 'mode');
      assert.ok(mode != null);
      const selected = mode.options.find((o) => o.selected);
      assert.ok(selected != null);
      assert.equal(selected.optionId, 'mode-council');
    });

    it('marks options as unavailable for terminal work items', () => {
      const task = makeTask({ id: 'task-1', status: 'done' });
      const config = makeControlConfig();
      const controls = discoverControls(task, config);
      for (const control of controls) {
        for (const option of control.options) {
          assert.equal(option.available, false);
        }
      }
    });

    it('builds unique controlId per work-item and kind', () => {
      const task = makeTask({ id: 'task-1' });
      const config = makeControlConfig();
      const controls = discoverControls(task, config);
      const ids = new Set(controls.map((c) => c.controlId));
      assert.equal(ids.size, controls.length, 'controlIds must be unique');
      for (const control of controls) {
        assert.ok(control.controlId.startsWith('task-1:'), 'controlId must include workItemId');
      }
    });
  });

  describe('computeRevisionToken', () => {
    it('returns a non-empty string', () => {
      const task = makeTask({ id: 'task-1' });
      const token = computeRevisionToken(task);
      assert.ok(typeof token === 'string' && token.length > 0);
    });

    it('returns the same token for the same task state', () => {
      const task = makeTask({ id: 'task-1', updatedAt: '2025-01-15T12:00:00Z' });
      assert.equal(computeRevisionToken(task), computeRevisionToken(task));
    });

    it('returns a different token when owner changes', () => {
      const task1 = makeTask({ id: 'task-1', owner: 'claude', updatedAt: '2025-01-15T12:00:00Z' });
      const task2 = makeTask({ id: 'task-1', owner: 'gemini', updatedAt: '2025-01-15T12:00:00Z' });
      assert.notEqual(computeRevisionToken(task1), computeRevisionToken(task2));
    });

    it('returns a different token when status changes', () => {
      const task1 = makeTask({ id: 'task-1', status: 'todo', updatedAt: '2025-01-15T12:00:00Z' });
      const task2 = makeTask({
        id: 'task-1',
        status: 'in_progress',
        updatedAt: '2025-01-15T12:00:00Z',
      });
      assert.notEqual(computeRevisionToken(task1), computeRevisionToken(task2));
    });
  });

  describe('GET /operations/work-items/:id/controls', () => {
    it('returns controls for a valid work item', () => {
      const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1/controls', state);
      const handled = handleOperationsReadRoute(ctx);
      assert.equal(handled, true);
      assert.equal(ctx.captured.statusCode, 200);
      const data = ctx.captured.data as Record<string, unknown>;
      assert.equal(data['workItemId'], 'task-1');
      const controls = data['controls'] as unknown[];
      assert.ok(controls.length > 0);
      assert.ok(!('revision' in data));
      assert.equal(data['availability'], 'ready');
    });

    it('returns 404 for missing work item', () => {
      const state = makeState({ tasks: [] });
      const ctx = makeReadCtx('GET', '/operations/work-items/missing/controls', state);
      const handled = handleOperationsReadRoute(ctx);
      assert.equal(handled, true);
      assert.equal(ctx.captured.statusCode, 404);
    });

    it('filters controls by kind query parameter', () => {
      const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1/controls', state, {
        kind: 'routing',
      });
      const handled = handleOperationsReadRoute(ctx);
      assert.equal(handled, true);
      assert.equal(ctx.captured.statusCode, 200);
      const data = ctx.captured.data as Record<string, unknown>;
      const controls = data['controls'] as Array<Record<string, unknown>>;
      assert.equal(controls.length, 1);
      assert.equal(controls[0]['kind'], 'routing');
    });

    it('rejects invalid kind query parameter', () => {
      const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1/controls', state, {
        kind: 'invalid',
      });
      const handled = handleOperationsReadRoute(ctx);
      assert.equal(handled, true);
      assert.equal(ctx.captured.statusCode, 400);
    });

    it('filters control options to assignable agent names only', () => {
      const state = makeState({ tasks: [makeTask({ id: 'task-1', owner: 'claude' })] });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1/controls', state);
      ctx.getModelSummary = () =>
        ({
          claude: { active: 'claude-opus-4-6', isDefault: true },
          gemini: { active: 'gemini-3-pro', isDefault: false },
          _mode: { active: 'balanced', isDefault: false },
        }) as ReturnType<typeof ctx.getModelSummary>;
      const handled = handleOperationsReadRoute(ctx);
      assert.equal(handled, true);
      assert.equal(ctx.captured.statusCode, 200);
      const data = ctx.captured.data as Record<string, unknown>;
      const controls = data['controls'] as Array<Record<string, unknown>>;
      const agentControl = controls.find((control) => control['kind'] === 'agent');
      assert.ok(agentControl != null);
      const options = agentControl['options'] as Array<Record<string, unknown>>;
      assert.ok(options.some((option) => option['optionId'] === 'agent-claude'));
      assert.ok(options.some((option) => option['optionId'] === 'agent-gemini'));
      assert.ok(options.every((option) => option['optionId'] !== 'agent-_mode'));
    });
  });

  describe('POST /operations/controls/discover', () => {
    it('returns controls for multiple work items', async () => {
      const state = makeState({
        tasks: [makeTask({ id: 'task-1' }), makeTask({ id: 'task-2', status: 'done' })],
      });
      const { captured, ctx } = makeWriteCtx('POST', '/operations/controls/discover', state, {
        workItemIds: ['task-1', 'task-2'],
      });
      const handled = await handleWriteRoute(ctx);
      assert.equal(handled, true);
      assert.equal(captured.statusCode, 200);
      const data = captured.data as Record<string, unknown>;
      const items = data['items'] as Array<Record<string, unknown>>;
      assert.equal(items.length, 2);
      assert.equal(items[0]['workItemId'], 'task-1');
      assert.equal(items[0]['availability'], 'ready');
      assert.equal(items[1]['workItemId'], 'task-2');
    });

    it('returns unavailable for missing work items', async () => {
      const state = makeState({ tasks: [] });
      const { captured, ctx } = makeWriteCtx('POST', '/operations/controls/discover', state, {
        workItemIds: ['missing'],
      });
      const handled = await handleWriteRoute(ctx);
      assert.equal(handled, true);
      assert.equal(captured.statusCode, 200);
      const data = captured.data as Record<string, unknown>;
      const items = data['items'] as Array<Record<string, unknown>>;
      assert.equal(items.length, 1);
      assert.equal(items[0]['availability'], 'unavailable');
    });

    it('returns 400 when workItemIds is missing', async () => {
      const state = makeState();
      const { captured, ctx } = makeWriteCtx('POST', '/operations/controls/discover', state, {});
      const handled = await handleWriteRoute(ctx);
      assert.equal(handled, true);
      assert.equal(captured.statusCode, 400);
    });

    it('supports kindFilter body parameter', async () => {
      const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
      const { captured, ctx } = makeWriteCtx('POST', '/operations/controls/discover', state, {
        workItemIds: ['task-1'],
        kindFilter: 'agent',
      });
      const handled = await handleWriteRoute(ctx);
      assert.equal(handled, true);
      assert.equal(captured.statusCode, 200);
      const data = captured.data as Record<string, unknown>;
      const items = data['items'] as Array<Record<string, unknown>>;
      const controls = items[0]['controls'] as Array<Record<string, unknown>>;
      assert.equal(controls.length, 1);
      assert.equal(controls[0]['kind'], 'agent');
    });

    it('rejects invalid kindFilter', async () => {
      const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
      const { captured, ctx } = makeWriteCtx('POST', '/operations/controls/discover', state, {
        workItemIds: ['task-1'],
        kindFilter: 'bogus',
      });
      const handled = await handleWriteRoute(ctx);
      assert.equal(handled, true);
      assert.equal(captured.statusCode, 400);
    });
  });
});

describe('Control Mutations (T038/T040)', () => {
  describe('executeControlMutation', () => {
    it('accepts a valid routing strategy change', () => {
      const task = makeTask({ id: 'task-1', status: 'todo' });
      const state = makeState({ tasks: [task] });
      const config = makeControlConfig();
      const revision = computeRevisionToken(task);
      const result = executeControlMutation(
        state,
        {
          workItemId: 'task-1',
          controlId: 'task-1:routing',
          requestedOptionId: 'routing-performance',
          expectedRevision: revision,
        },
        config,
      );
      assert.equal(result.outcome, 'accepted');
      assert.equal(result.workItemId, 'task-1');
      assert.ok(result.resolvedAt !== '');
      const detail = projectWorkItemDetail(state, 'task-1', config);
      assert.ok(detail?.routing != null);
      assert.equal(detail.routing.currentMode, 'auto');
      const selected = result.control.options.find((option) => option.selected);
      assert.ok(selected != null);
      assert.equal(selected.optionId, 'routing-performance');
    });

    it('accepts an agent reassignment', () => {
      const task = makeTask({
        id: 'task-1',
        status: 'todo',
        owner: 'claude',
        assignmentHistory: [
          {
            agent: 'claude',
            role: null,
            state: 'waiting',
            startedAt: '2025-01-15T12:00:00.000Z',
            endedAt: null,
          },
        ],
      });
      const state = makeState({ tasks: [task] });
      const config = makeControlConfig();
      const revision = computeRevisionToken(task);
      const result = executeControlMutation(
        state,
        {
          workItemId: 'task-1',
          controlId: 'task-1:agent',
          requestedOptionId: 'agent-gemini',
          expectedRevision: revision,
        },
        config,
      );
      assert.equal(result.outcome, 'accepted');
      assert.equal(task.owner, 'gemini');
      const history = (task as Record<string, unknown>)['assignmentHistory'] as Array<
        Record<string, unknown>
      >;
      assert.equal(history.length, 2);
      assert.equal(history[0]?.['agent'], 'claude');
      assert.equal(history[0]?.['endedAt'], result.resolvedAt);
      assert.equal(history[1]?.['agent'], 'gemini');
    });

    it('accepts a mode change', () => {
      const task = makeTask({ id: 'task-1', status: 'in_progress' });
      const state = makeState({ tasks: [task] });
      const config = makeControlConfig();
      const revision = computeRevisionToken(task);
      const result = executeControlMutation(
        state,
        {
          workItemId: 'task-1',
          controlId: 'task-1:mode',
          requestedOptionId: 'mode-council',
          expectedRevision: revision,
        },
        config,
      );
      assert.equal(result.outcome, 'accepted');
    });

    it('rejects mutation for non-existent work item', () => {
      const state = makeState({ tasks: [] });
      const config = makeControlConfig();
      const result = executeControlMutation(
        state,
        {
          workItemId: 'missing',
          controlId: 'missing:routing',
          requestedOptionId: 'routing-economy',
          expectedRevision: 'abc123',
        },
        config,
      );
      assert.equal(result.outcome, 'rejected');
      assert.ok(result.message?.includes('not found'));
    });

    it('rejects mutation for terminal work item', () => {
      const task = makeTask({ id: 'task-1', status: 'done' });
      const state = makeState({ tasks: [task] });
      const config = makeControlConfig();
      // Must compute revision BEFORE testing terminal check —
      // terminal tasks still have a revision for read purposes
      const result = executeControlMutation(
        state,
        {
          workItemId: 'task-1',
          controlId: 'task-1:routing',
          requestedOptionId: 'routing-economy',
          expectedRevision: computeRevisionToken(task),
        },
        config,
      );
      assert.equal(result.outcome, 'rejected');
      assert.ok(result.message?.includes('done'));
    });

    it('returns stale outcome when revision token mismatches', () => {
      const task = makeTask({ id: 'task-1', status: 'todo' });
      const state = makeState({ tasks: [task] });
      const config = makeControlConfig();
      const result = executeControlMutation(
        state,
        {
          workItemId: 'task-1',
          controlId: 'task-1:routing',
          requestedOptionId: 'routing-economy',
          expectedRevision: 'stale-token-that-does-not-match',
        },
        config,
      );
      assert.equal(result.outcome, 'stale');
      assert.ok(result.message?.includes('Revision'));
    });

    it('returns superseded when option is already selected', () => {
      const task = makeTask({ id: 'task-1', status: 'todo', owner: 'claude' });
      const state = makeState({ tasks: [task] });
      const config = makeControlConfig();
      const revision = computeRevisionToken(task);
      const result = executeControlMutation(
        state,
        {
          workItemId: 'task-1',
          controlId: 'task-1:agent',
          requestedOptionId: 'agent-claude',
          expectedRevision: revision,
        },
        config,
      );
      assert.equal(result.outcome, 'superseded');
      assert.ok(result.message?.includes('already'));
    });

    it('rejects unknown option', () => {
      const task = makeTask({ id: 'task-1', status: 'todo' });
      const state = makeState({ tasks: [task] });
      const config = makeControlConfig();
      const revision = computeRevisionToken(task);
      const result = executeControlMutation(
        state,
        {
          workItemId: 'task-1',
          controlId: 'task-1:routing',
          requestedOptionId: 'routing-unknown',
          expectedRevision: revision,
        },
        config,
      );
      assert.equal(result.outcome, 'rejected');
      assert.ok(result.message?.includes('Unknown option'));
      assert.equal(result.control.kind, 'routing');
    });

    it('rejects invalid control ID', () => {
      const task = makeTask({ id: 'task-1', status: 'todo' });
      const state = makeState({ tasks: [task] });
      const config = makeControlConfig();
      const result = executeControlMutation(
        state,
        {
          workItemId: 'task-1',
          controlId: 'bogus-control-id',
          requestedOptionId: 'routing-economy',
          expectedRevision: computeRevisionToken(task),
        },
        config,
      );
      assert.equal(result.outcome, 'rejected');
      assert.ok(result.message?.includes('Invalid control ID'));
    });

    it('returns updated control view after accepted mutation', () => {
      const task = makeTask({ id: 'task-1', status: 'todo', owner: 'claude' });
      const state = makeState({ tasks: [task] });
      const config = makeControlConfig();
      const revision = computeRevisionToken(task);
      const result = executeControlMutation(
        state,
        {
          workItemId: 'task-1',
          controlId: 'task-1:agent',
          requestedOptionId: 'agent-gemini',
          expectedRevision: revision,
        },
        config,
      );
      assert.equal(result.outcome, 'accepted');
      assert.ok(result.control != null);
      assert.equal(result.control.kind, 'agent');
      // After mutation, the control should show the new state
      const selected = result.control.options.find((o) => o.selected);
      assert.ok(selected != null);
      assert.equal(selected.optionId, 'agent-gemini');
    });

    it('preserves rejected control kind for agent mutations', () => {
      const task = makeTask({ id: 'task-1', status: 'todo', owner: 'claude' });
      const state = makeState({ tasks: [task] });
      const config = makeControlConfig();
      const result = executeControlMutation(
        state,
        {
          workItemId: 'task-1',
          controlId: 'task-1:agent',
          requestedOptionId: 'agent-unknown',
          expectedRevision: computeRevisionToken(task),
        },
        config,
      );
      assert.equal(result.outcome, 'rejected');
      assert.equal(result.control.kind, 'agent');
    });

    it('requests council deliberation', () => {
      const task = makeTask({ id: 'task-1', status: 'todo' });
      const state = makeState({ tasks: [task] });
      const config = makeControlConfig();
      const revision = computeRevisionToken(task);
      const result = executeControlMutation(
        state,
        {
          workItemId: 'task-1',
          controlId: 'task-1:council',
          requestedOptionId: 'council-request',
          expectedRevision: revision,
        },
        config,
      );
      assert.equal(result.outcome, 'accepted');
      const councilHistory = (task as Record<string, unknown>)['councilHistory'] as Record<
        string,
        unknown
      >;
      assert.equal(councilHistory['status'], 'waiting');
    });
  });

  describe('POST /operations/work-items/:workItemId/controls/:controlId', () => {
    it('accepts a valid control mutation via route', async () => {
      const task = makeTask({ id: 'task-1', status: 'todo', owner: 'claude' });
      const state = makeState({ tasks: [task] });
      const revision = computeRevisionToken(task);
      const { captured, ctx } = makeWriteCtx(
        'POST',
        '/operations/work-items/task-1/controls/task-1%3Aagent',
        state,
        {
          requestedOptionId: 'agent-gemini',
          expectedRevision: revision,
        },
      );
      const handled = await handleWriteRoute(ctx);
      assert.equal(handled, true);
      assert.equal(captured.statusCode, 200);
      const data = captured.data as Record<string, unknown>;
      assert.equal(data['outcome'], 'accepted');
    });

    it('returns 409 for stale revision', async () => {
      const task = makeTask({ id: 'task-1', status: 'todo' });
      const state = makeState({ tasks: [task] });
      const { captured, ctx } = makeWriteCtx(
        'POST',
        '/operations/work-items/task-1/controls/task-1%3Arouting',
        state,
        {
          requestedOptionId: 'routing-economy',
          expectedRevision: 'stale-revision',
        },
      );
      const handled = await handleWriteRoute(ctx);
      assert.equal(handled, true);
      assert.equal(captured.statusCode, 409);
      const data = captured.data as Record<string, unknown>;
      assert.equal(data['outcome'], 'stale');
    });

    it('returns 200 for rejected mutation', async () => {
      const task = makeTask({ id: 'task-1', status: 'done' });
      const state = makeState({ tasks: [task] });
      const { captured, ctx } = makeWriteCtx(
        'POST',
        '/operations/work-items/task-1/controls/task-1%3Arouting',
        state,
        {
          requestedOptionId: 'routing-economy',
          expectedRevision: computeRevisionToken(task),
        },
      );
      const handled = await handleWriteRoute(ctx);
      assert.equal(handled, true);
      assert.equal(captured.statusCode, 200);
      const data = captured.data as Record<string, unknown>;
      assert.equal(data['outcome'], 'rejected');
    });

    it('returns 200 for superseded mutation', async () => {
      const task = makeTask({ id: 'task-1', status: 'todo', owner: 'claude' });
      const state = makeState({ tasks: [task] });
      const { captured, ctx } = makeWriteCtx(
        'POST',
        '/operations/work-items/task-1/controls/task-1%3Aagent',
        state,
        {
          requestedOptionId: 'agent-claude',
          expectedRevision: computeRevisionToken(task),
        },
      );
      const handled = await handleWriteRoute(ctx);
      assert.equal(handled, true);
      assert.equal(captured.statusCode, 200);
      const data = captured.data as Record<string, unknown>;
      assert.equal(data['outcome'], 'superseded');
    });

    it('validates required fields', async () => {
      const state = makeState();
      const full: Record<string, string> = {
        requestedOptionId: 'routing-economy',
        expectedRevision: 'some-rev',
      };
      for (const missingField of ['requestedOptionId', 'expectedRevision']) {
        const body = { ...full };
        body[missingField] = '';
        const { captured, ctx } = makeWriteCtx(
          'POST',
          '/operations/work-items/task-1/controls/task-1%3Arouting',
          state,
          body,
        );
        await handleWriteRoute(ctx);
        assert.equal(captured.statusCode, 400, `Missing ${missingField} should return 400`);
      }
    });

    it('returns control view with the result', async () => {
      const task = makeTask({ id: 'task-1', status: 'todo', owner: 'claude' });
      const state = makeState({ tasks: [task] });
      const revision = computeRevisionToken(task);
      const { captured, ctx } = makeWriteCtx(
        'POST',
        '/operations/work-items/task-1/controls/task-1%3Aagent',
        state,
        {
          requestedOptionId: 'agent-codex',
          expectedRevision: revision,
        },
      );
      await handleWriteRoute(ctx);
      const data = captured.data as Record<string, unknown>;
      assert.equal(data['outcome'], 'accepted');
      const control = data['control'] as Record<string, unknown>;
      assert.ok(control != null);
      assert.equal(control['kind'], 'agent');
      assert.equal(data['workItemId'], 'task-1');
      assert.ok(typeof data['resolvedAt'] === 'string');
    });

    it('mutates task state on accepted control action', async () => {
      const task = makeTask({ id: 'task-1', status: 'todo', owner: 'claude' });
      const state = makeState({ tasks: [task] });
      const revision = computeRevisionToken(task);
      const { ctx } = makeWriteCtx(
        'POST',
        '/operations/work-items/task-1/controls/task-1%3Aagent',
        state,
        {
          requestedOptionId: 'agent-gemini',
          expectedRevision: revision,
        },
      );
      await handleWriteRoute(ctx);
      assert.equal(task.owner, 'gemini', 'Task owner should be mutated to gemini');
    });
  });

  describe('detail route includes controls', () => {
    it('populates controls in work item detail for active work item', () => {
      const state = makeState({
        tasks: [makeTask({ id: 'task-1', status: 'in_progress', owner: 'claude' })],
      });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const controls = data['controls'] as Array<Record<string, unknown>>;
      assert.ok(controls.length > 0);
      for (const control of controls) {
        assert.equal(control['availability'], 'actionable');
        assert.equal(control['authority'], 'granted');
        assert.ok(typeof control['expectedRevision'] === 'string');
      }
    });

    it('populates read-only controls in work item detail for completed work item', () => {
      const state = makeState({
        tasks: [makeTask({ id: 'task-1', status: 'done', owner: 'claude' })],
      });
      const ctx = makeReadCtx('GET', '/operations/work-items/task-1', state);
      handleOperationsReadRoute(ctx);
      const data = ctx.captured.data as Record<string, unknown>;
      const controls = data['controls'] as Array<Record<string, unknown>>;
      assert.ok(controls.length > 0);
      for (const control of controls) {
        assert.equal(control['availability'], 'read-only');
        assert.equal(control['authority'], 'unavailable');
        assert.equal(control['expectedRevision'], null);
      }
    });
  });
});
