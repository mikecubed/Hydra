/**
 * Unit tests for lib/daemon/web-operations-projection.ts
 *
 * Covers queue snapshot projection: status normalization, ordering,
 * relationship hints, risk signals, and availability semantics.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { HydraStateShape, TaskEntry, UsageCheckResult } from '../lib/types.ts';
import {
  projectQueueSnapshot,
  normalizeTaskStatus,
  DAEMON_TO_WORK_ITEM_STATUS,
  projectCheckpoints,
  projectWorkItemDetail,
  projectDaemonHealth,
  projectGlobalBudget,
  projectItemBudget,
} from '../lib/daemon/web-operations-projection.ts';
import {
  CheckpointRecordView as CheckpointRecordViewSchema,
  DaemonHealthView as DaemonHealthViewSchema,
  BudgetStatusView as BudgetStatusViewSchema,
} from '@hydra/web-contracts';

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

function makeUsage(overrides: Partial<UsageCheckResult> = {}): UsageCheckResult {
  return {
    level: 'normal',
    percent: 10,
    todayTokens: 100,
    message: 'ok',
    confidence: 1,
    model: 'test',
    budget: 1000,
    used: 100,
    remaining: 900,
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

    it('extracts last checkpoint name as lastCheckpointSummary for daemon-persisted shape', () => {
      const state = makeState({
        tasks: [
          makeTask({
            id: 'task-1',
            checkpoints: [
              {
                note: '',
                at: '',
                name: 'First pass',
                savedAt: '2025-07-01T00:00:00.000Z',
                context: '',
                agent: 'codex',
              },
              {
                note: '',
                at: '',
                name: 'Final review',
                savedAt: '2025-07-01T01:00:00.000Z',
                context: '',
                agent: 'claude',
              },
            ] as unknown as Array<{ note: string; at: string }>,
          }),
        ],
      });
      const result = projectQueueSnapshot(state);
      assert.equal(result.queue[0].lastCheckpointSummary, 'Final review');
    });

    it('keeps lastCheckpointSummary null when the latest checkpoint has no visible label', () => {
      const state = makeState({
        tasks: [
          makeTask({
            id: 'task-1',
            title: 'Task 1',
            status: 'in_progress',
            checkpoints: [{ name: '', note: '', at: '', savedAt: '2026-03-01T12:00:00.000Z' }],
          }),
        ],
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

  it('projects health and budget independently when only one probe succeeds', () => {
    const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });

    const healthOnly = projectQueueSnapshot(state, {}, { statusData: { running: true } });
    assert.equal(healthOnly.health?.status, 'healthy');
    assert.equal(healthOnly.budget, null);

    const budgetOnly = projectQueueSnapshot(state, {}, { usage: makeUsage() });
    assert.equal(budgetOnly.health, null);
    assert.equal(budgetOnly.budget?.status, 'normal');
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

  // ── Daemon-persisted checkpoint shape { name, savedAt, context, agent } ──

  it('normalizes daemon-persisted shape: name → label, savedAt → timestamp', () => {
    const task = makeTask({
      id: 'task-1',
      checkpoints: [
        {
          note: '',
          at: '',
          name: 'Implement routing',
          savedAt: '2025-07-01T09:30:00.000Z',
          context: '',
          agent: 'codex',
        },
      ] as unknown as Array<{ note: string; at: string }>,
    });
    const result = projectCheckpoints(task);
    assert.equal(result[0].label, 'Implement routing');
    assert.equal(result[0].timestamp, '2025-07-01T09:30:00.000Z');
  });

  it('maps context → detail for daemon-persisted checkpoints', () => {
    const task = makeTask({
      id: 'task-1',
      checkpoints: [
        {
          note: '',
          at: '',
          name: 'Design review',
          savedAt: '2025-07-01T10:00:00.000Z',
          context: 'Reviewed module boundaries',
          agent: 'claude',
        },
      ] as unknown as Array<{ note: string; at: string }>,
    });
    const result = projectCheckpoints(task);
    assert.equal(result[0].detail, 'Reviewed module boundaries');
  });

  it('sets detail to null when daemon context is empty', () => {
    const task = makeTask({
      id: 'task-1',
      checkpoints: [
        {
          note: '',
          at: '',
          name: 'Quick save',
          savedAt: '2025-07-01T11:00:00.000Z',
          context: '',
          agent: 'gemini',
        },
      ] as unknown as Array<{ note: string; at: string }>,
    });
    const result = projectCheckpoints(task);
    assert.equal(result[0].detail, null);
  });

  it('prefers note/at when both legacy and daemon fields are present', () => {
    const task = makeTask({
      id: 'task-1',
      checkpoints: [
        {
          note: 'Legacy label',
          at: '2025-01-01T00:00:00.000Z',
          name: 'Daemon label',
          savedAt: '2025-07-01T12:00:00.000Z',
        },
      ] as unknown as Array<{ note: string; at: string }>,
    });
    const result = projectCheckpoints(task);
    assert.equal(result[0].label, 'Legacy label');
    assert.equal(result[0].timestamp, '2025-01-01T00:00:00.000Z');
  });

  it('falls back to epoch when neither at nor savedAt is present', () => {
    const task = makeTask({
      id: 'task-1',
      checkpoints: [{ note: '', at: '', name: 'Orphan', context: '' }] as unknown as Array<{
        note: string;
        at: string;
      }>,
    });
    const result = projectCheckpoints(task);
    assert.equal(result[0].timestamp, '1970-01-01T00:00:00.000Z');
  });

  // ── Empty-string normalization (regression: contract-violating empty strings) ──

  it('normalizes empty-string name to fallback label when note is also empty', () => {
    const task = makeTask({
      id: 'task-1',
      checkpoints: [
        {
          note: '',
          at: '',
          name: '',
          savedAt: '2025-07-01T09:30:00.000Z',
          context: '',
          agent: 'codex',
        },
      ] as unknown as Array<{ note: string; at: string }>,
    });
    const result = projectCheckpoints(task);
    assert.equal(result[0].label, '(checkpoint)');
  });

  it('normalizes empty-string savedAt to epoch when at is also empty', () => {
    const task = makeTask({
      id: 'task-1',
      checkpoints: [
        {
          note: '',
          at: '',
          name: 'Checkpoint A',
          savedAt: '',
          context: '',
        },
      ] as unknown as Array<{ note: string; at: string }>,
    });
    const result = projectCheckpoints(task);
    assert.equal(result[0].timestamp, '1970-01-01T00:00:00.000Z');
  });

  it('normalizes empty-string detail to null instead of empty string', () => {
    const task = makeTask({
      id: 'task-1',
      checkpoints: [{ note: 'Has empty detail', at: '2025-01-01T00:00:00.000Z', detail: '' }],
    });
    const result = projectCheckpoints(task);
    assert.equal(result[0].detail, null);
  });

  it('normalizes all-empty daemon-shaped checkpoint to valid contract values', () => {
    const task = makeTask({
      id: 'task-1',
      checkpoints: [
        { note: '', at: '', name: '', savedAt: '', context: '', agent: 'claude' },
      ] as unknown as Array<{ note: string; at: string }>,
    });
    const result = projectCheckpoints(task);
    assert.equal(result[0].label, '(checkpoint)');
    assert.equal(result[0].timestamp, '1970-01-01T00:00:00.000Z');
    assert.equal(result[0].detail, null);
    assert.equal(result[0].status, 'reached');
    assert.equal(result[0].id, 'task-1-cp-0');
    assert.equal(result[0].sequence, 0);
  });

  it('normalizes mixed legacy+daemon checkpoint with all-empty strings', () => {
    const task = makeTask({
      id: 'task-1',
      checkpoints: [
        { note: '', at: '', name: '', savedAt: '', detail: '', context: '' },
      ] as unknown as Array<{ note: string; at: string }>,
    });
    const result = projectCheckpoints(task);
    assert.equal(result[0].label, '(checkpoint)');
    assert.equal(result[0].timestamp, '1970-01-01T00:00:00.000Z');
    assert.equal(result[0].detail, null);
  });

  it('prefers non-empty name when note is empty', () => {
    const task = makeTask({
      id: 'task-1',
      checkpoints: [
        { note: '', at: '2025-06-01T00:00:00.000Z', name: 'Valid name' },
      ] as unknown as Array<{ note: string; at: string }>,
    });
    const result = projectCheckpoints(task);
    assert.equal(result[0].label, 'Valid name');
  });

  it('prefers non-empty detail over empty context', () => {
    const task = makeTask({
      id: 'task-1',
      checkpoints: [
        {
          note: 'Test',
          at: '2025-01-01T00:00:00.000Z',
          detail: 'Real detail',
          context: '',
        },
      ] as unknown as Array<{ note: string; at: string }>,
    });
    const result = projectCheckpoints(task);
    assert.equal(result[0].detail, 'Real detail');
  });

  it('falls back to non-empty context when detail is empty string', () => {
    const task = makeTask({
      id: 'task-1',
      checkpoints: [
        {
          note: 'Test',
          at: '2025-01-01T00:00:00.000Z',
          detail: '',
          context: 'Context value',
        },
      ] as unknown as Array<{ note: string; at: string }>,
    });
    const result = projectCheckpoints(task);
    assert.equal(result[0].detail, 'Context value');
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

  it('returns unavailable item budget (per-item attribution not yet available)', () => {
    const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
    const result = projectWorkItemDetail(state, 'task-1');
    assert.ok(result !== null);
    assert.notEqual(result.itemBudget, null);
    assert.equal(result.itemBudget.status, 'unavailable');
    assert.equal(result.itemBudget.scope, 'work-item');
    assert.equal(result.itemBudget.scopeId, 'task-1');
    assert.equal(result.itemBudget.complete, false);
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

// ── Snapshot / Detail Position Consistency ──────────────────────────────────

describe('snapshot vs detail position consistency', () => {
  const now = new Date();

  function ts(minutesAgo: number): string {
    return new Date(now.getTime() - minutesAgo * 60_000).toISOString();
  }

  it('detail position matches snapshot position for a non-terminal item', () => {
    const state = makeState({
      tasks: [
        makeTask({ id: 'task-a', status: 'in_progress', updatedAt: ts(1) }),
        makeTask({ id: 'task-b', status: 'todo', updatedAt: ts(5) }),
        makeTask({ id: 'task-c', status: 'todo', updatedAt: ts(3) }),
      ],
    });

    const snapshot = projectQueueSnapshot(state);
    const detail = projectWorkItemDetail(state, 'task-b');

    assert.ok(detail !== null);
    const snapshotItem = snapshot.queue.find((i) => i.id === 'task-b');
    assert.ok(snapshotItem != null, 'task-b should appear in snapshot');
    assert.equal(detail.item.position, snapshotItem.position);
    assert.equal(typeof detail.item.position, 'number');
  });

  it('detail position is null for a terminal item, matching snapshot', () => {
    const state = makeState({
      tasks: [
        makeTask({ id: 'task-a', status: 'in_progress', updatedAt: ts(1) }),
        makeTask({ id: 'task-done', status: 'done', updatedAt: ts(2) }),
      ],
    });

    const snapshot = projectQueueSnapshot(state);
    const detail = projectWorkItemDetail(state, 'task-done');

    assert.ok(detail !== null);
    const snapshotItem = snapshot.queue.find((i) => i.id === 'task-done');
    assert.ok(snapshotItem != null);
    assert.equal(detail.item.position, null);
    assert.equal(snapshotItem.position, null);
  });

  it('all non-terminal items agree on position across snapshot and detail', () => {
    const state = makeState({
      tasks: [
        makeTask({ id: 't1', status: 'in_progress', updatedAt: ts(10) }),
        makeTask({ id: 't2', status: 'todo', updatedAt: ts(2) }),
        makeTask({
          id: 't3',
          status: 'blocked',
          owner: 'gemini',
          updatedAt: ts(5),
          blockedBy: ['t1'],
        }),
        makeTask({ id: 't4', status: 'done', updatedAt: ts(1) }),
        makeTask({ id: 't5', status: 'failed', updatedAt: ts(0) }),
        makeTask({ id: 't6', status: 'todo', updatedAt: ts(8) }),
      ],
    });

    const snapshot = projectQueueSnapshot(state);

    for (const snapshotItem of snapshot.queue) {
      const detail = projectWorkItemDetail(state, snapshotItem.id);
      assert.ok(detail !== null, `detail for ${snapshotItem.id} should exist`);
      assert.equal(
        detail.item.position,
        snapshotItem.position,
        `position mismatch for ${snapshotItem.id}: detail=${String(detail.item.position)} snapshot=${String(snapshotItem.position)}`,
      );
    }
  });

  it('single-item queue returns position 0 in both snapshot and detail', () => {
    const state = makeState({
      tasks: [makeTask({ id: 'only-task', status: 'todo', updatedAt: ts(0) })],
    });

    const snapshot = projectQueueSnapshot(state);
    const detail = projectWorkItemDetail(state, 'only-task');

    assert.ok(detail !== null);
    assert.equal(snapshot.queue[0].position, 0);
    assert.equal(detail.item.position, 0);
  });
});

// ── Daemon Health Projection ───────────────────────────────────────────────

describe('projectDaemonHealth', () => {
  it('returns healthy when daemon reports running', () => {
    const health = projectDaemonHealth({ running: true, updatedAt: '2025-01-01T00:00:00.000Z' });
    assert.equal(health.status, 'healthy');
    assert.equal(health.scope, 'global');
    assert.equal(health.detailsAvailability, 'ready');
    assert.equal(health.message, null);
  });

  it('returns unavailable when daemon reports not running', () => {
    const health = projectDaemonHealth({ running: false });
    assert.equal(health.status, 'unavailable');
    assert.equal(health.scope, 'global');
    assert.notEqual(health.message, null);
  });

  it('returns unavailable when status data is empty', () => {
    const health = projectDaemonHealth({});
    assert.equal(health.status, 'unavailable');
    assert.equal(health.detailsAvailability, 'unavailable');
  });

  it('scope is always global', () => {
    const health = projectDaemonHealth({ running: true });
    assert.equal(health.scope, 'global');
  });

  it('observedAt is a valid ISO datetime', () => {
    const health = projectDaemonHealth({ running: true });
    assert.doesNotThrow(() => new Date(health.observedAt));
    assert.ok(health.observedAt.endsWith('Z'));
  });

  it('detailsAvailability is partial when not running', () => {
    const health = projectDaemonHealth({ running: false });
    assert.equal(health.detailsAvailability, 'partial');
  });

  it('validates against DaemonHealthView schema when healthy', () => {
    const health = projectDaemonHealth({ running: true });
    const parsed = DaemonHealthViewSchema.safeParse(health);
    assert.ok(parsed.success, `Schema validation failed: ${JSON.stringify(parsed.error?.issues)}`);
  });

  it('validates against DaemonHealthView schema when unavailable', () => {
    const health = projectDaemonHealth({});
    const parsed = DaemonHealthViewSchema.safeParse(health);
    assert.ok(parsed.success, `Schema validation failed: ${JSON.stringify(parsed.error?.issues)}`);
  });
});

// ── Global Budget Projection ───────────────────────────────────────────────

describe('projectGlobalBudget', () => {
  it('maps normal level to normal severity', () => {
    const budget = projectGlobalBudget(makeUsage({ level: 'normal' }));
    assert.equal(budget.status, 'normal');
  });

  it('maps warning level to warning severity', () => {
    const budget = projectGlobalBudget(makeUsage({ level: 'warning', percent: 85 }));
    assert.equal(budget.status, 'warning');
  });

  it('maps critical level to warning severity when budget remains', () => {
    const budget = projectGlobalBudget(
      makeUsage({ level: 'critical', percent: 95, used: 9500, budget: 10000 }),
    );
    assert.equal(budget.status, 'warning');
  });

  it('maps unknown level to unavailable severity', () => {
    const budget = projectGlobalBudget(makeUsage({ level: 'unknown-level' }));
    assert.equal(budget.status, 'unavailable');
  });

  it('includes numeric data when available', () => {
    const budget = projectGlobalBudget(makeUsage({ used: 500, budget: 1000 }));
    assert.equal(budget.used, 500);
    assert.equal(budget.limit, 1000);
    assert.equal(budget.unit, 'tokens');
    assert.equal(budget.complete, true);
  });

  it('aggregates daemon-wide totals from tracked agents when available', () => {
    const budget = projectGlobalBudget(
      makeUsage({
        todayTokens: 1300,
        percent: 85,
        used: 850,
        budget: 1000,
        agents: {
          claude: { todayTokens: 800, budget: 1000 },
          codex: { todayTokens: 500, budget: 2000 },
        },
      }),
    );
    assert.equal(budget.used, 1300);
    assert.equal(budget.limit, 3000);
    assert.equal(budget.complete, true);
    assert.equal(budget.status, 'normal');
  });

  it('marks aggregate budget as incomplete when some agent budgets are unavailable', () => {
    const budget = projectGlobalBudget(
      makeUsage({
        todayTokens: 1300,
        percent: 85,
        agents: {
          claude: { todayTokens: 800, budget: 1000 },
          codex: { todayTokens: 500, budget: null },
        },
      }),
    );
    assert.equal(budget.used, 1300);
    assert.equal(budget.limit, null);
    assert.equal(budget.complete, false);
  });

  it('marks incomplete when numeric data missing', () => {
    const budget = projectGlobalBudget(makeUsage({ used: undefined, budget: undefined }));
    assert.equal(budget.used, null);
    assert.equal(budget.limit, null);
    assert.equal(budget.unit, null);
    assert.equal(budget.complete, false);
  });

  it('scope is always global with null scopeId', () => {
    const budget = projectGlobalBudget(makeUsage());
    assert.equal(budget.scope, 'global');
    assert.equal(budget.scopeId, null);
  });

  it('summary reflects warning severity with percent', () => {
    const budget = projectGlobalBudget(makeUsage({ level: 'warning', percent: 85 }));
    assert.ok(budget.summary.includes('85'));
  });

  it('summary reflects exceeded severity only when usage is actually exhausted', () => {
    const budget = projectGlobalBudget(
      makeUsage({ level: 'critical', percent: 100, used: 10_000, budget: 10_000 }),
    );
    assert.ok(budget.summary.toLowerCase().includes('exceeded'));
  });

  it('maps to exceeded severity when usage reaches the budget limit', () => {
    const budget = projectGlobalBudget(
      makeUsage({ level: 'critical', percent: 100, used: 10_000, budget: 10_000 }),
    );
    assert.equal(budget.status, 'exceeded');
  });

  it('validates against BudgetStatusView schema for normal', () => {
    const budget = projectGlobalBudget(makeUsage());
    const parsed = BudgetStatusViewSchema.safeParse(budget);
    assert.ok(parsed.success, `Schema validation failed: ${JSON.stringify(parsed.error?.issues)}`);
  });

  it('validates against BudgetStatusView schema for warning', () => {
    const budget = projectGlobalBudget(makeUsage({ level: 'warning', percent: 85 }));
    const parsed = BudgetStatusViewSchema.safeParse(budget);
    assert.ok(parsed.success, `Schema validation failed: ${JSON.stringify(parsed.error?.issues)}`);
  });

  it('validates against BudgetStatusView schema for exceeded', () => {
    const budget = projectGlobalBudget(makeUsage({ level: 'critical' }));
    const parsed = BudgetStatusViewSchema.safeParse(budget);
    assert.ok(parsed.success, `Schema validation failed: ${JSON.stringify(parsed.error?.issues)}`);
  });

  it('validates against BudgetStatusView schema for unavailable', () => {
    const budget = projectGlobalBudget(makeUsage({ level: 'unknown' }));
    const parsed = BudgetStatusViewSchema.safeParse(budget);
    assert.ok(parsed.success, `Schema validation failed: ${JSON.stringify(parsed.error?.issues)}`);
  });
});

// ── Item Budget Projection ─────────────────────────────────────────────────

describe('projectItemBudget', () => {
  it('returns unavailable status', () => {
    const budget = projectItemBudget('task-1');
    assert.equal(budget.status, 'unavailable');
  });

  it('has work-item scope with correct scopeId', () => {
    const budget = projectItemBudget('task-1');
    assert.equal(budget.scope, 'work-item');
    assert.equal(budget.scopeId, 'task-1');
  });

  it('marks data as incomplete', () => {
    const budget = projectItemBudget('task-1');
    assert.equal(budget.complete, false);
    assert.equal(budget.used, null);
    assert.equal(budget.limit, null);
    assert.equal(budget.unit, null);
  });

  it('summary describes unavailable attribution', () => {
    const budget = projectItemBudget('task-1');
    assert.ok(budget.summary.length > 0);
  });

  it('validates against BudgetStatusView schema', () => {
    const budget = projectItemBudget('task-1');
    const parsed = BudgetStatusViewSchema.safeParse(budget);
    assert.ok(parsed.success, `Schema validation failed: ${JSON.stringify(parsed.error?.issues)}`);
  });
});

// ── Snapshot with Health/Budget Context ─────────────────────────────────────

describe('projectQueueSnapshot with health/budget context', () => {
  it('populates health when context provided', () => {
    const state = makeState({ tasks: [makeTask()] });
    const result = projectQueueSnapshot(
      state,
      {},
      {
        statusData: { running: true },
        usage: makeUsage(),
      },
    );
    assert.notEqual(result.health, null);
    assert.equal(result.health!.status, 'healthy');
    assert.equal(result.health!.scope, 'global');
  });

  it('populates budget when context provided', () => {
    const state = makeState({ tasks: [makeTask()] });
    const result = projectQueueSnapshot(
      state,
      {},
      {
        statusData: { running: true },
        usage: makeUsage({ level: 'warning', percent: 85 }),
      },
    );
    assert.notEqual(result.budget, null);
    assert.equal(result.budget!.status, 'warning');
    assert.equal(result.budget!.scope, 'global');
  });

  it('keeps critical-threshold snapshot budget at warning while budget remains', () => {
    const state = makeState({ tasks: [makeTask()] });
    const result = projectQueueSnapshot(
      state,
      {},
      {
        statusData: { running: true },
        usage: makeUsage({ level: 'critical', percent: 95, used: 9500, budget: 10_000 }),
      },
    );
    assert.notEqual(result.budget, null);
    assert.equal(result.budget!.status, 'warning');
  });

  it('reflects unavailable health in snapshot', () => {
    const state = makeState({ tasks: [makeTask()] });
    const result = projectQueueSnapshot(
      state,
      {},
      {
        statusData: { running: false },
        usage: makeUsage(),
      },
    );
    assert.notEqual(result.health, null);
    assert.equal(result.health!.status, 'unavailable');
  });

  it('leaves health/budget null when no context provided', () => {
    const state = makeState();
    const result = projectQueueSnapshot(state);
    assert.equal(result.health, null);
    assert.equal(result.budget, null);
  });

  it('separates global budget from per-item scope', () => {
    const state = makeState({ tasks: [makeTask({ id: 'task-1' })] });
    const snapshot = projectQueueSnapshot(
      state,
      {},
      {
        statusData: { running: true },
        usage: makeUsage({ level: 'warning', percent: 80 }),
      },
    );
    assert.notEqual(snapshot.budget, null);
    assert.equal(snapshot.budget!.scope, 'global');
    assert.equal(snapshot.budget!.scopeId, null);

    const detail = projectWorkItemDetail(state, 'task-1');
    assert.ok(detail !== null);
    assert.equal(detail.itemBudget.scope, 'work-item');
    assert.equal(detail.itemBudget.scopeId, 'task-1');
    assert.equal(detail.itemBudget.status, 'unavailable');
  });
});

// ── Contract Validation (empty-string regression) ──────────────────────────

describe('checkpoint contract validation', () => {
  it('all-empty daemon-shaped checkpoint passes CheckpointRecordView schema', () => {
    const task = makeTask({
      id: 'task-1',
      checkpoints: [
        { note: '', at: '', name: '', savedAt: '', context: '', agent: 'codex' },
      ] as unknown as Array<{ note: string; at: string }>,
    });
    const result = projectCheckpoints(task);
    const parsed = CheckpointRecordViewSchema.safeParse(result[0]);
    assert.ok(parsed.success, `Schema validation failed: ${JSON.stringify(parsed.error?.issues)}`);
  });

  it('empty-detail legacy checkpoint passes CheckpointRecordView schema', () => {
    const task = makeTask({
      id: 'task-1',
      checkpoints: [{ note: 'Test', at: '2025-01-01T00:00:00.000Z', detail: '' }],
    });
    const result = projectCheckpoints(task);
    const parsed = CheckpointRecordViewSchema.safeParse(result[0]);
    assert.ok(parsed.success, `Schema validation failed: ${JSON.stringify(parsed.error?.issues)}`);
  });

  it('well-formed daemon checkpoint passes CheckpointRecordView schema', () => {
    const task = makeTask({
      id: 'task-1',
      checkpoints: [
        {
          note: '',
          at: '',
          name: 'Review complete',
          savedAt: '2025-07-01T12:00:00.000Z',
          context: 'Approved with minor notes',
          agent: 'claude',
        },
      ] as unknown as Array<{ note: string; at: string }>,
    });
    const result = projectCheckpoints(task);
    const parsed = CheckpointRecordViewSchema.safeParse(result[0]);
    assert.ok(parsed.success, `Schema validation failed: ${JSON.stringify(parsed.error?.issues)}`);
  });
});
