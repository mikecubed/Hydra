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

    it('returns null lastSynchronizedAt when the daemon state timestamp is empty', () => {
      const state = makeState({ updatedAt: '' });
      const result = projectQueueSnapshot(state);
      assert.equal(result.lastSynchronizedAt, null);
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

    it('falls back to daemon state updatedAt when task updatedAt is empty', () => {
      const stateTs = '2026-06-15T10:00:00.000Z';
      const state = makeState({
        tasks: [makeTask({ id: 'task-empty-ts', updatedAt: '' })],
        updatedAt: stateTs,
      });
      const result = projectQueueSnapshot(state);
      assert.equal(result.queue[0].updatedAt, stateTs);
    });

    it('falls back to epoch when both task and state updatedAt are empty', () => {
      const state = makeState({
        tasks: [makeTask({ id: 'task-epoch', updatedAt: '' })],
        updatedAt: '',
      });
      const result = projectQueueSnapshot(state);
      assert.equal(result.queue[0].updatedAt, '1970-01-01T00:00:00.000Z');
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
});
