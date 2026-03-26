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
  projectCheckpoints,
  projectWorkItemDetail,
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

// ── Checkpoint Projection ──────────────────────────────────────────────────

describe('projectCheckpoints', () => {
  it('returns empty array when task has no checkpoints', () => {
    const task = makeTask({ id: 'task-1' });
    const result = projectCheckpoints(task);
    assert.deepStrictEqual(result, []);
  });

  it('assigns monotonic sequence numbers starting from 0', () => {
    const task = makeTask({
      id: 'task-1',
      checkpoints: [
        { note: 'First', at: '2025-01-01T00:00:00.000Z' },
        { note: 'Second', at: '2025-01-01T01:00:00.000Z' },
        { note: 'Third', at: '2025-01-01T02:00:00.000Z' },
      ],
    });
    const result = projectCheckpoints(task);
    assert.equal(result.length, 3);
    assert.equal(result[0].sequence, 0);
    assert.equal(result[1].sequence, 1);
    assert.equal(result[2].sequence, 2);
  });

  it('generates deterministic checkpoint IDs from task id and sequence', () => {
    const task = makeTask({
      id: 'task-42',
      checkpoints: [
        { note: 'Start', at: '2025-01-01T00:00:00.000Z' },
        { note: 'Done', at: '2025-01-01T01:00:00.000Z' },
      ],
    });
    const result = projectCheckpoints(task);
    assert.equal(result[0].id, 'task-42-cp-0');
    assert.equal(result[1].id, 'task-42-cp-1');
  });

  it('maps note → label and at → timestamp', () => {
    const task = makeTask({
      id: 'task-1',
      checkpoints: [{ note: 'Halfway done', at: '2025-06-01T12:00:00.000Z' }],
    });
    const result = projectCheckpoints(task);
    assert.equal(result[0].label, 'Halfway done');
    assert.equal(result[0].timestamp, '2025-06-01T12:00:00.000Z');
  });

  it('defaults checkpoint status to reached', () => {
    const task = makeTask({
      id: 'task-1',
      checkpoints: [{ note: 'Basic checkpoint', at: '2025-01-01T00:00:00.000Z' }],
    });
    const result = projectCheckpoints(task);
    assert.equal(result[0].status, 'reached');
  });

  it('preserves explicit checkpoint status when present', () => {
    const task = makeTask({
      id: 'task-1',
      checkpoints: [
        { note: 'Recovered after failure', at: '2025-01-01T00:00:00.000Z', status: 'recovered' },
      ],
    });
    const result = projectCheckpoints(task);
    assert.equal(result[0].status, 'recovered');
  });

  it('maps waiting status on checkpoints', () => {
    const task = makeTask({
      id: 'task-1',
      checkpoints: [
        { note: 'Waiting for review', at: '2025-01-01T00:00:00.000Z', status: 'waiting' },
      ],
    });
    const result = projectCheckpoints(task);
    assert.equal(result[0].status, 'waiting');
  });

  it('maps resumed status on checkpoints', () => {
    const task = makeTask({
      id: 'task-1',
      checkpoints: [
        { note: 'Resumed after pause', at: '2025-01-01T00:00:00.000Z', status: 'resumed' },
      ],
    });
    const result = projectCheckpoints(task);
    assert.equal(result[0].status, 'resumed');
  });

  it('maps skipped status on checkpoints', () => {
    const task = makeTask({
      id: 'task-1',
      checkpoints: [
        { note: 'Skipped optimization', at: '2025-01-01T00:00:00.000Z', status: 'skipped' },
      ],
    });
    const result = projectCheckpoints(task);
    assert.equal(result[0].status, 'skipped');
  });

  it('falls back to reached for unknown checkpoint statuses', () => {
    const task = makeTask({
      id: 'task-1',
      checkpoints: [{ note: 'Weird status', at: '2025-01-01T00:00:00.000Z', status: 'bogus' }],
    });
    const result = projectCheckpoints(task);
    assert.equal(result[0].status, 'reached');
  });

  it('preserves checkpoint ordering (input order = sequence order)', () => {
    const task = makeTask({
      id: 'task-1',
      checkpoints: [
        { note: 'C', at: '2025-01-01T03:00:00.000Z' },
        { note: 'A', at: '2025-01-01T01:00:00.000Z' },
        { note: 'B', at: '2025-01-01T02:00:00.000Z' },
      ],
    });
    const result = projectCheckpoints(task);
    assert.deepStrictEqual(
      result.map((cp) => cp.label),
      ['C', 'A', 'B'],
    );
    assert.equal(result[0].sequence, 0);
    assert.equal(result[1].sequence, 1);
    assert.equal(result[2].sequence, 2);
  });

  it('maps detail field from checkpoint when present', () => {
    const task = makeTask({
      id: 'task-1',
      checkpoints: [
        { note: 'With detail', at: '2025-01-01T00:00:00.000Z', detail: 'Extra info here' },
      ],
    });
    const result = projectCheckpoints(task);
    assert.equal(result[0].detail, 'Extra info here');
  });

  it('sets detail to null when not present on checkpoint', () => {
    const task = makeTask({
      id: 'task-1',
      checkpoints: [{ note: 'No detail', at: '2025-01-01T00:00:00.000Z' }],
    });
    const result = projectCheckpoints(task);
    assert.equal(result[0].detail, null);
  });
});

// ── Work Item Detail Projection ────────────────────────────────────────────

describe('projectWorkItemDetail', () => {
  it('returns null when task is not found', () => {
    const state = makeState({ tasks: [] });
    const result = projectWorkItemDetail(state, 'nonexistent');
    assert.equal(result, null);
  });

  it('returns detail with projected item for existing task', () => {
    const state = makeState({
      tasks: [makeTask({ id: 'task-1', title: 'Do stuff', status: 'in_progress' })],
    });
    const result = projectWorkItemDetail(state, 'task-1');
    assert.ok(result !== null);
    assert.equal(result.item.id, 'task-1');
    assert.equal(result.item.title, 'Do stuff');
    assert.equal(result.item.status, 'active');
  });

  it('includes projected checkpoints in monotonic order', () => {
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
    const result = projectWorkItemDetail(state, 'task-1');
    assert.ok(result !== null);
    assert.equal(result.checkpoints.length, 2);
    assert.equal(result.checkpoints[0].sequence, 0);
    assert.equal(result.checkpoints[1].sequence, 1);
    assert.equal(result.checkpoints[0].label, 'Step 1');
    assert.equal(result.checkpoints[1].label, 'Step 2');
  });

  it('sets routing to null (not yet tracked)', () => {
    const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
    const result = projectWorkItemDetail(state, 'task-1');
    assert.ok(result !== null);
    assert.equal(result.routing, null);
  });

  it('returns empty assignments array (not yet tracked)', () => {
    const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
    const result = projectWorkItemDetail(state, 'task-1');
    assert.ok(result !== null);
    assert.deepStrictEqual(result.assignments, []);
  });

  it('sets council to null (not yet tracked)', () => {
    const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
    const result = projectWorkItemDetail(state, 'task-1');
    assert.ok(result !== null);
    assert.equal(result.council, null);
  });

  it('returns empty controls array (not yet tracked)', () => {
    const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
    const result = projectWorkItemDetail(state, 'task-1');
    assert.ok(result !== null);
    assert.deepStrictEqual(result.controls, []);
  });

  it('sets itemBudget to null (not yet tracked)', () => {
    const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
    const result = projectWorkItemDetail(state, 'task-1');
    assert.ok(result !== null);
    assert.equal(result.itemBudget, null);
  });

  it('sets availability to partial when checkpoints exist but routing/assignments are not tracked', () => {
    const state = makeState({
      tasks: [
        makeTask({
          id: 'task-1',
          checkpoints: [{ note: 'Started', at: '2025-01-01T00:00:00.000Z' }],
        }),
      ],
    });
    const result = projectWorkItemDetail(state, 'task-1');
    assert.ok(result !== null);
    assert.equal(result.availability, 'partial');
  });

  it('sets availability to partial even when no checkpoints exist', () => {
    const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
    const result = projectWorkItemDetail(state, 'task-1');
    assert.ok(result !== null);
    assert.equal(result.availability, 'partial');
  });

  it('projects paused status for in_progress task with paused session', () => {
    const state = makeState({
      tasks: [makeTask({ id: 'task-1', status: 'in_progress', owner: 'codex' })],
      activeSession: {
        id: 'session-1',
        focus: 'Test',
        owner: 'codex',
        status: 'paused',
        startedAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:01:00.000Z',
        pauseReason: 'Waiting',
        pausedAt: '2025-01-01T00:01:00.000Z',
      },
    });
    const result = projectWorkItemDetail(state, 'task-1');
    assert.ok(result !== null);
    assert.equal(result.item.status, 'paused');
  });

  it('includes risk signals on the projected item', () => {
    const state = makeState({
      tasks: [makeTask({ id: 'task-1', status: 'in_progress', stale: true })],
    });
    const result = projectWorkItemDetail(state, 'task-1');
    assert.ok(result !== null);
    const staleSignals = result.item.riskSignals.filter((s) => s.kind === 'stale');
    assert.equal(staleSignals.length, 1);
  });

  it('includes checkpoints with recovery status', () => {
    const state = makeState({
      tasks: [
        makeTask({
          id: 'task-1',
          checkpoints: [
            { note: 'Started', at: '2025-01-01T00:00:00.000Z' },
            { note: 'Recovered', at: '2025-01-01T01:00:00.000Z', status: 'recovered' },
          ],
        }),
      ],
    });
    const result = projectWorkItemDetail(state, 'task-1');
    assert.ok(result !== null);
    assert.equal(result.checkpoints[1].status, 'recovered');
  });

  it('includes checkpoints with waiting status', () => {
    const state = makeState({
      tasks: [
        makeTask({
          id: 'task-1',
          checkpoints: [
            { note: 'Awaiting input', at: '2025-01-01T00:00:00.000Z', status: 'waiting' },
          ],
        }),
      ],
    });
    const result = projectWorkItemDetail(state, 'task-1');
    assert.ok(result !== null);
    assert.equal(result.checkpoints[0].status, 'waiting');
  });

  it('sets detailAvailability to partial on projected item', () => {
    const state = makeState({
      tasks: [makeTask({ id: 'task-1' })],
    });
    const result = projectWorkItemDetail(state, 'task-1');
    assert.ok(result !== null);
    assert.equal(result.item.detailAvailability, 'partial');
  });
});
