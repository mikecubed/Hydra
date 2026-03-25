/**
 * Focused ordering/filter/pagination coverage for daemon queue projection.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { HydraStateShape, TaskEntry } from '../lib/types.ts';
import { projectQueueSnapshot } from '../lib/daemon/web-operations-projection.ts';

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

describe('projectQueueSnapshot ordering and paging', () => {
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

    it('orders deterministically when some tasks have empty updatedAt', () => {
      const stateTs = '2026-06-15T10:00:00.000Z';
      const state = makeState({
        tasks: [
          makeTask({ id: 'todo-empty', status: 'todo', updatedAt: '' }),
          makeTask({ id: 'todo-dated', status: 'todo', updatedAt: '2026-06-15T12:00:00.000Z' }),
          makeTask({ id: 'todo-empty2', status: 'todo', updatedAt: '' }),
        ],
        updatedAt: stateTs,
      });
      const result = projectQueueSnapshot(state);
      const ids = result.queue.map((item) => item.id);
      assert.equal(ids[0], 'todo-dated');
      assert.ok(ids.includes('todo-empty'));
      assert.ok(ids.includes('todo-empty2'));
      for (const item of result.queue) {
        assert.ok(item.updatedAt !== '', `updatedAt must not be empty for ${item.id}`);
        assert.ok(
          !Number.isNaN(new Date(item.updatedAt).getTime()),
          `updatedAt must parse for ${item.id}`,
        );
      }
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
