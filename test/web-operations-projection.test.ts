/**
 * Unit tests for lib/daemon/web-operations-projection.ts
 *
 * Covers queue snapshot projection: status normalization, ordering,
 * relationship hints, risk signals, and availability semantics.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { HydraStateShape, TaskEntry } from '../lib/types.ts';
import {
  projectQueueSnapshot,
  normalizeTaskStatus,
  DAEMON_TO_WORK_ITEM_STATUS,
} from '../lib/daemon/web-operations-projection.ts';

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

// ── Status Normalization ───────────────────────────────────────────────────

describe('normalizeTaskStatus', () => {
  it('maps todo → waiting', () => {
    assert.equal(normalizeTaskStatus('todo'), 'waiting');
  });

  it('maps in_progress → active', () => {
    assert.equal(normalizeTaskStatus('in_progress'), 'active');
  });

  it('maps blocked → blocked', () => {
    assert.equal(normalizeTaskStatus('blocked'), 'blocked');
  });

  it('maps done → completed', () => {
    assert.equal(normalizeTaskStatus('done'), 'completed');
  });

  it('maps failed → failed', () => {
    assert.equal(normalizeTaskStatus('failed'), 'failed');
  });

  it('maps cancelled → cancelled', () => {
    assert.equal(normalizeTaskStatus('cancelled'), 'cancelled');
  });

  it('falls back to waiting for unknown statuses', () => {
    assert.equal(normalizeTaskStatus('unknown' as never), 'waiting');
  });
});

describe('DAEMON_TO_WORK_ITEM_STATUS', () => {
  it('covers all daemon task statuses', () => {
    const expected = ['todo', 'in_progress', 'blocked', 'done', 'failed', 'cancelled'];
    for (const status of expected) {
      assert.ok(
        status in DAEMON_TO_WORK_ITEM_STATUS,
        `Missing mapping for daemon status: ${status}`,
      );
    }
  });
});

// ── Queue Snapshot Projection ──────────────────────────────────────────────

describe('projectQueueSnapshot', () => {
  describe('empty state', () => {
    it('returns empty queue with correct availability', () => {
      const state = makeState();
      const result = projectQueueSnapshot(state);
      assert.deepStrictEqual(result.queue, []);
      assert.equal(result.availability, 'empty');
      assert.equal(result.nextCursor, null);
    });

    it('returns null health and budget by default', () => {
      const state = makeState();
      const result = projectQueueSnapshot(state);
      assert.equal(result.health, null);
      assert.equal(result.budget, null);
    });

    it('uses the daemon state updatedAt as lastSynchronizedAt', () => {
      const updatedAt = '2026-03-25T00:00:00.000Z';
      const state = makeState({ updatedAt });
      const result = projectQueueSnapshot(state);
      assert.equal(result.lastSynchronizedAt, updatedAt);
    });
  });

  describe('single task projection', () => {
    it('projects a todo task as waiting with correct fields', () => {
      const now = new Date().toISOString();
      const state = makeState({
        tasks: [makeTask({ id: 'task-1', title: 'Build feature', owner: 'codex', updatedAt: now })],
      });
      const result = projectQueueSnapshot(state);

      assert.equal(result.queue.length, 1);
      const item = result.queue[0];
      assert.equal(item.id, 'task-1');
      assert.equal(item.title, 'Build feature');
      assert.equal(item.status, 'waiting');
      assert.equal(item.ownerLabel, 'codex');
      assert.equal(item.updatedAt, now);
      assert.equal(item.detailAvailability, 'partial');
    });

    it('projects an in_progress task as active', () => {
      const state = makeState({
        tasks: [makeTask({ id: 'task-2', status: 'in_progress' })],
      });
      const result = projectQueueSnapshot(state);
      assert.equal(result.queue[0].status, 'active');
    });

    it('projects an in_progress task as paused when its owning active session is paused', () => {
      const state = makeState({
        tasks: [makeTask({ id: 'task-2', status: 'in_progress', owner: 'codex' })],
        activeSession: {
          id: 'session-1',
          focus: 'Queue visibility',
          owner: 'codex',
          status: 'paused',
          startedAt: '2026-03-25T00:00:00.000Z',
          updatedAt: '2026-03-25T00:01:00.000Z',
          pauseReason: 'Awaiting operator input',
          pausedAt: '2026-03-25T00:01:00.000Z',
        },
      });
      const result = projectQueueSnapshot(state);
      assert.equal(result.queue[0].status, 'paused');
    });

    it('projects a done task as completed', () => {
      const state = makeState({
        tasks: [makeTask({ id: 'task-3', status: 'done' })],
      });
      const result = projectQueueSnapshot(state);
      assert.equal(result.queue[0].status, 'completed');
    });

    it('projects a failed task as failed', () => {
      const state = makeState({
        tasks: [makeTask({ id: 'task-4', status: 'failed' })],
      });
      const result = projectQueueSnapshot(state);
      assert.equal(result.queue[0].status, 'failed');
    });
  });

  describe('relationship hints', () => {
    it('leaves relatedSessionId null when no authoritative task-session linkage exists', () => {
      const state = makeState({
        tasks: [makeTask({ id: 'task-1' })],
        activeSession: {
          id: 'session-abc',
          focus: 'test focus',
          owner: 'claude',
          status: 'active',
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
      const result = projectQueueSnapshot(state);
      assert.equal(result.queue[0].relatedSessionId, null);
    });

    it('sets relatedConversationId to null (not yet supported)', () => {
      const state = makeState({
        tasks: [makeTask({ id: 'task-1' })],
      });
      const result = projectQueueSnapshot(state);
      assert.equal(result.queue[0].relatedConversationId, null);
    });
  });

  describe('checkpoint summary', () => {
    it('extracts last checkpoint note as lastCheckpointSummary', () => {
      const state = makeState({
        tasks: [
          makeTask({
            id: 'task-1',
            checkpoints: [
              { note: 'Started work', at: '2025-01-01T00:00:00.000Z' },
              { note: 'Halfway done', at: '2025-01-01T01:00:00.000Z' },
            ],
          }),
        ],
      });
      const result = projectQueueSnapshot(state);
      assert.equal(result.queue[0].lastCheckpointSummary, 'Halfway done');
    });

    it('sets lastCheckpointSummary to null when no checkpoints', () => {
      const state = makeState({
        tasks: [makeTask({ id: 'task-1' })],
      });
      const result = projectQueueSnapshot(state);
      assert.equal(result.queue[0].lastCheckpointSummary, null);
    });
  });

  describe('risk signals', () => {
    it('adds stale risk signal for stale tasks', () => {
      const state = makeState({
        tasks: [makeTask({ id: 'task-1', status: 'in_progress', stale: true })],
      });
      const result = projectQueueSnapshot(state);
      const staleSignals = result.queue[0].riskSignals.filter((s) => s.kind === 'stale');
      assert.equal(staleSignals.length, 1);
      assert.equal(staleSignals[0].severity, 'warning');
    });

    it('adds waiting risk signal for blocked tasks with blockers', () => {
      const state = makeState({
        tasks: [makeTask({ id: 'task-1', status: 'blocked', blockedBy: ['task-2'] })],
      });
      const result = projectQueueSnapshot(state);
      const waitingSignals = result.queue[0].riskSignals.filter((s) => s.kind === 'waiting');
      assert.equal(waitingSignals.length, 1);
    });

    it('returns empty risk signals for healthy tasks', () => {
      const state = makeState({
        tasks: [makeTask({ id: 'task-1', status: 'todo' })],
      });
      const result = projectQueueSnapshot(state);
      assert.deepStrictEqual(result.queue[0].riskSignals, []);
    });
  });

  describe('ordering', () => {
    it('orders active before blocked before waiting before completed', () => {
      const state = makeState({
        tasks: [
          makeTask({ id: 'done-1', status: 'done', updatedAt: '2025-01-01T04:00:00.000Z' }),
          makeTask({ id: 'todo-1', status: 'todo', updatedAt: '2025-01-01T01:00:00.000Z' }),
          makeTask({
            id: 'active-1',
            status: 'in_progress',
            updatedAt: '2025-01-01T03:00:00.000Z',
          }),
          makeTask({
            id: 'blocked-1',
            status: 'blocked',
            updatedAt: '2025-01-01T02:00:00.000Z',
          }),
        ],
      });
      const result = projectQueueSnapshot(state);
      const ids = result.queue.map((item) => item.id);
      assert.deepStrictEqual(ids, ['active-1', 'blocked-1', 'todo-1', 'done-1']);
    });

    it('assigns sequential position numbers starting from 0', () => {
      const state = makeState({
        tasks: [
          makeTask({ id: 'active-1', status: 'in_progress' }),
          makeTask({ id: 'todo-1', status: 'todo' }),
        ],
      });
      const result = projectQueueSnapshot(state);
      assert.equal(result.queue[0].position, 0);
      assert.equal(result.queue[1].position, 1);
    });

    it('sets position to null for terminal statuses', () => {
      const state = makeState({
        tasks: [makeTask({ id: 'done-1', status: 'done' })],
      });
      const result = projectQueueSnapshot(state);
      assert.equal(result.queue[0].position, null);
    });

    it('orders items within the same status group by updatedAt descending', () => {
      const state = makeState({
        tasks: [
          makeTask({ id: 'todo-old', status: 'todo', updatedAt: '2025-01-01T00:00:00.000Z' }),
          makeTask({ id: 'todo-new', status: 'todo', updatedAt: '2025-01-01T02:00:00.000Z' }),
          makeTask({ id: 'todo-mid', status: 'todo', updatedAt: '2025-01-01T01:00:00.000Z' }),
        ],
      });
      const result = projectQueueSnapshot(state);
      const ids = result.queue.map((item) => item.id);
      assert.deepStrictEqual(ids, ['todo-new', 'todo-mid', 'todo-old']);
    });
  });

  describe('status filtering', () => {
    it('filters by a single status', () => {
      const state = makeState({
        tasks: [
          makeTask({ id: 'task-1', status: 'todo' }),
          makeTask({ id: 'task-2', status: 'in_progress' }),
          makeTask({ id: 'task-3', status: 'done' }),
        ],
      });
      const result = projectQueueSnapshot(state, { statusFilter: ['active'] });
      assert.equal(result.queue.length, 1);
      assert.equal(result.queue[0].id, 'task-2');
    });

    it('filters by multiple statuses', () => {
      const state = makeState({
        tasks: [
          makeTask({ id: 'task-1', status: 'todo' }),
          makeTask({ id: 'task-2', status: 'in_progress' }),
          makeTask({ id: 'task-3', status: 'done' }),
        ],
      });
      const result = projectQueueSnapshot(state, { statusFilter: ['waiting', 'active'] });
      assert.equal(result.queue.length, 2);
    });

    it('filters paused items when the owning active session is paused', () => {
      const state = makeState({
        tasks: [
          makeTask({ id: 'paused-1', status: 'in_progress', owner: 'codex' }),
          makeTask({ id: 'active-1', status: 'in_progress', owner: 'claude' }),
        ],
        activeSession: {
          id: 'session-1',
          focus: 'Paused work',
          owner: 'codex',
          status: 'paused',
          startedAt: '2026-03-25T00:00:00.000Z',
          updatedAt: '2026-03-25T00:01:00.000Z',
          pauseReason: 'Waiting',
          pausedAt: '2026-03-25T00:01:00.000Z',
        },
      });
      const result = projectQueueSnapshot(state, { statusFilter: ['paused'] });
      assert.deepStrictEqual(
        result.queue.map((item) => item.id),
        ['paused-1'],
      );
      assert.equal(result.queue[0].status, 'paused');
    });

    it('returns all items when no filter is set', () => {
      const state = makeState({
        tasks: [
          makeTask({ id: 'task-1', status: 'todo' }),
          makeTask({ id: 'task-2', status: 'in_progress' }),
        ],
      });
      const result = projectQueueSnapshot(state);
      assert.equal(result.queue.length, 2);
    });
  });

  describe('limit and cursor', () => {
    it('respects limit parameter', () => {
      const state = makeState({
        tasks: [
          makeTask({ id: 'task-1', status: 'todo', updatedAt: '2025-01-01T00:00:00.000Z' }),
          makeTask({ id: 'task-2', status: 'todo', updatedAt: '2025-01-01T01:00:00.000Z' }),
          makeTask({ id: 'task-3', status: 'todo', updatedAt: '2025-01-01T02:00:00.000Z' }),
        ],
      });
      const result = projectQueueSnapshot(state, { limit: 2 });
      assert.equal(result.queue.length, 2);
      assert.ok(result.nextCursor !== null, 'should set nextCursor when truncated');
    });

    it('returns null nextCursor when all items fit', () => {
      const state = makeState({
        tasks: [makeTask({ id: 'task-1' })],
      });
      const result = projectQueueSnapshot(state, { limit: 10 });
      assert.equal(result.nextCursor, null);
    });

    it('returns only items after the cursor in sorted order', () => {
      const state = makeState({
        tasks: [
          makeTask({
            id: 'task-active',
            status: 'in_progress',
            updatedAt: '2026-03-25T00:00:03.000Z',
          }),
          makeTask({ id: 'task-waiting', status: 'todo', updatedAt: '2026-03-25T00:00:02.000Z' }),
          makeTask({ id: 'task-done', status: 'done', updatedAt: '2026-03-25T00:00:01.000Z' }),
        ],
      });
      const result = projectQueueSnapshot(state, { cursor: 'task-active' });
      assert.deepStrictEqual(
        result.queue.map((item) => item.id),
        ['task-waiting', 'task-done'],
      );
    });

    it('preserves global queue positions after applying cursor pagination', () => {
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
      const result = projectQueueSnapshot(state, {
        cursor: 'task-active-1',
        limit: 1,
      });
      assert.deepStrictEqual(
        result.queue.map((item) => item.id),
        ['task-active-2'],
      );
      assert.equal(result.queue[0].position, 1);
      assert.equal(result.nextCursor, 'task-active-2');
    });
  });

  describe('availability', () => {
    it('returns ready when tasks exist', () => {
      const state = makeState({
        tasks: [makeTask({ id: 'task-1' })],
      });
      const result = projectQueueSnapshot(state);
      assert.equal(result.availability, 'ready');
    });

    it('returns empty when no tasks exist', () => {
      const state = makeState({ tasks: [] });
      const result = projectQueueSnapshot(state);
      assert.equal(result.availability, 'empty');
    });
  });

  describe('lastSynchronizedAt', () => {
    it('returns the daemon state timestamp', () => {
      const state = makeState({
        tasks: [makeTask({ id: 'task-1' })],
        updatedAt: '2026-03-25T12:34:56.000Z',
      });
      const result = projectQueueSnapshot(state);
      assert.equal(result.lastSynchronizedAt, '2026-03-25T12:34:56.000Z');
    });
  });
});
