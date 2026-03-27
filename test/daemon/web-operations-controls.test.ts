import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { HydraStateShape, TaskEntry } from '../../lib/types.ts';
import {
  computeRevisionToken,
  discoverControls,
  executeControlMutation,
  type ControlContext,
} from '../../lib/daemon/web-operations-controls.ts';

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

function makeState(tasks: TaskEntry[]): HydraStateShape {
  return {
    tasks,
    handoffs: [],
    blockers: [],
    decisions: [],
    childSessions: [],
    activeSession: null,
    updatedAt: '2025-01-15T12:00:00.000Z',
  };
}

function makeControlConfig(now = '2025-01-15T12:00:00.000Z'): ControlContext {
  return {
    loadConfig: () => ({ mode: 'auto', routing: { mode: 'balanced' } }),
    agentNames: ['claude', 'gemini', 'codex'],
    nowIso: () => now,
  };
}

describe('web-operations-controls', () => {
  it('discovers actionable controls with revision tokens for active work items', () => {
    const controls = discoverControls(makeTask(), makeControlConfig());

    assert.equal(controls.length, 4);
    assert.ok(controls.every((control) => control.availability === 'actionable'));
    assert.ok(controls.every((control) => control.expectedRevision != null));
  });

  it('changes revision tokens when control-relevant task state changes', () => {
    const task = makeTask({ updatedAt: '2025-01-15T12:00:00.000Z' });
    const original = computeRevisionToken(task);
    const updated = computeRevisionToken({
      ...task,
      owner: 'gemini',
      updatedAt: '2025-01-15T12:01:00.000Z',
    });

    assert.notEqual(original, updated);
  });

  it('returns stale controls with resolved metadata on revision mismatch', () => {
    const task = makeTask();
    const result = executeControlMutation(
      makeState([task]),
      {
        workItemId: task.id,
        controlId: `${task.id}:routing`,
        requestedOptionId: 'routing-economy',
        expectedRevision: 'stale-token',
      },
      makeControlConfig(),
    );

    assert.equal(result.outcome, 'stale');
    assert.equal(result.control.availability, 'stale');
    assert.equal(result.control.lastResolvedAt, result.resolvedAt);
    assert.equal(result.control.kind, 'routing');
    assert.ok(result.control.options.length > 0);
  });

  it('returns resolved accepted controls after successful mutation', () => {
    const task = makeTask({ owner: 'claude' });
    const result = executeControlMutation(
      makeState([task]),
      {
        workItemId: task.id,
        controlId: `${task.id}:agent`,
        requestedOptionId: 'agent-gemini',
        expectedRevision: computeRevisionToken(task),
      },
      makeControlConfig(),
    );

    assert.equal(result.outcome, 'accepted');
    assert.equal(result.control.availability, 'accepted');
    assert.equal(result.control.lastResolvedAt, result.resolvedAt);
    assert.equal(task.owner, 'gemini');
    assert.equal(
      result.control.options.find((option) => option.selected)?.optionId,
      'agent-gemini',
    );
  });
});
