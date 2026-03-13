/**
 * Tests for lib/daemon/task-helpers.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import type { TaskEntry, HydraStateShape } from '../lib/types.ts';
import {
  nextId,
  parseList,
  ensureKnownStatus,
  ensureKnownAgent,
  formatTask,
  detectCycle,
  autoUnblock,
  buildPrompt,
  getSummary,
  suggestNext,
} from '../lib/daemon/task-helpers.ts';

function makeTask(overrides: Partial<TaskEntry> = {}): TaskEntry {
  return {
    id: 'T001',
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

function makeState(tasks: TaskEntry[] = []): HydraStateShape {
  return {
    tasks,
    handoffs: [],
    blockers: [],
    decisions: [],
    updatedAt: new Date().toISOString(),
    activeSession: null,
  };
}

describe('nextId', () => {
  it('returns prefix-001 for empty list', () => {
    assert.equal(nextId('T', []), 'T001');
  });

  it('returns next sequential id after existing', () => {
    assert.equal(nextId('T', [{ id: 'T001' }]), 'T002');
  });

  it('skips gaps and uses max + 1', () => {
    assert.equal(nextId('T', [{ id: 'T001' }, { id: 'T005' }]), 'T006');
  });

  it('ignores items with non-matching prefix', () => {
    assert.equal(nextId('H', [{ id: 'T001' }, { id: 'H002' }]), 'H003');
  });
});

describe('parseList', () => {
  it('returns empty array for undefined', () => {
    assert.deepEqual(parseList(), []);
  });

  it('returns empty array for null', () => {
    assert.deepEqual(parseList(null), []);
  });

  it('splits comma-separated string', () => {
    assert.deepEqual(parseList('a,b,c'), ['a', 'b', 'c']);
  });

  it('trims whitespace around entries', () => {
    assert.deepEqual(parseList('a, b , c'), ['a', 'b', 'c']);
  });

  it('filters empty entries', () => {
    assert.deepEqual(parseList('a,,b'), ['a', 'b']);
  });

  it('passes through an array', () => {
    assert.deepEqual(parseList(['x', 'y']), ['x', 'y']);
  });
});

describe('ensureKnownStatus', () => {
  it('accepts valid status todo', () => {
    assert.doesNotThrow(() => {
      ensureKnownStatus('todo');
    });
  });

  it('accepts valid status in_progress', () => {
    assert.doesNotThrow(() => {
      ensureKnownStatus('in_progress');
    });
  });

  it('accepts valid status done', () => {
    assert.doesNotThrow(() => {
      ensureKnownStatus('done');
    });
  });

  it('throws for unknown status', () => {
    assert.throws(() => {
      ensureKnownStatus('bogus');
    }, /Invalid status/);
  });

  it('throws for pending (not a valid Hydra status)', () => {
    assert.throws(() => {
      ensureKnownStatus('pending');
    }, /Invalid status/);
  });
});

describe('ensureKnownAgent', () => {
  it('accepts claude', () => {
    assert.doesNotThrow(() => {
      ensureKnownAgent('claude');
    });
  });

  it('accepts unassigned when allowUnassigned=true (default)', () => {
    assert.doesNotThrow(() => {
      ensureKnownAgent('unassigned');
    });
  });

  it('throws for unknown agent', () => {
    assert.throws(() => {
      ensureKnownAgent('bogusagent9999');
    }, /Unknown agent/);
  });
});

describe('formatTask', () => {
  it('formats a task without blockedBy', () => {
    const task = makeTask({ id: 'T001', status: 'todo', owner: 'claude', title: 'Do stuff' });
    const result = formatTask(task);
    assert.match(result, /T001/);
    assert.match(result, /todo/);
    assert.match(result, /claude/);
    assert.match(result, /Do stuff/);
  });

  it('includes blockedBy when present', () => {
    const task = makeTask({ id: 'T002', blockedBy: ['T001'] });
    const result = formatTask(task);
    assert.match(result, /blockedBy=T001/);
  });
});

describe('detectCycle', () => {
  it('returns false when no cycle', () => {
    const tasks: TaskEntry[] = [makeTask({ id: 'T001', blockedBy: [] })];
    assert.equal(detectCycle(tasks, 'T002', ['T001']), false);
  });

  it('detects direct cycle', () => {
    // T001 already blocked-by T002; adding T001 to T002's blockedBy would be a cycle
    const tasks: TaskEntry[] = [
      makeTask({ id: 'T001', blockedBy: ['T002'] }),
      makeTask({ id: 'T002', blockedBy: [] }),
    ];
    assert.equal(detectCycle(tasks, 'T002', ['T001']), true);
  });

  it('detects transitive cycle', () => {
    const tasks: TaskEntry[] = [
      makeTask({ id: 'T001', blockedBy: ['T002'] }),
      makeTask({ id: 'T002', blockedBy: ['T003'] }),
    ];
    assert.equal(detectCycle(tasks, 'T003', ['T001']), true);
  });
});

describe('autoUnblock', () => {
  it('moves blocked task to todo when all deps are complete', () => {
    const t1 = makeTask({ id: 'T001', status: 'done' });
    const t2 = makeTask({ id: 'T002', status: 'blocked', blockedBy: ['T001'] });
    const state = makeState([t1, t2]);
    autoUnblock(state, 'T001');
    assert.equal(t2.status, 'todo');
  });

  it('does not unblock task with remaining deps', () => {
    const t1 = makeTask({ id: 'T001', status: 'done' });
    const t2 = makeTask({ id: 'T002', status: 'in_progress' });
    const t3 = makeTask({ id: 'T003', status: 'blocked', blockedBy: ['T001', 'T002'] });
    const state = makeState([t1, t2, t3]);
    autoUnblock(state, 'T001');
    assert.equal(t3.status, 'blocked');
  });
});

describe('getSummary', () => {
  it('returns counts object', () => {
    const state = makeState([
      makeTask({ id: 'T001', status: 'todo' }),
      makeTask({ id: 'T002', status: 'done' }),
    ]);
    const summary = getSummary(state);
    assert.ok(typeof summary['counts'] === 'object');
    assert.equal((summary['counts'] as Record<string, number>)['tasksOpen'], 1);
  });

  it('counts open blockers', () => {
    const state = makeState([]);
    (state.blockers as unknown[]).push({ id: 'B001', status: 'open' });
    const summary = getSummary(state);
    assert.equal((summary['counts'] as Record<string, number>)['blockersOpen'], 1);
  });
});

describe('buildPrompt', () => {
  it('returns a string containing the project name', () => {
    const state = makeState([]);
    const result = buildPrompt('claude', state, os.tmpdir(), 'TestProject');
    assert.ok(typeof result === 'string');
    assert.match(result, /TestProject/);
  });

  it('includes agent label for claude', () => {
    const state = makeState([]);
    const result = buildPrompt('claude', state, os.tmpdir(), 'Proj');
    assert.ok(result.length > 0);
  });

  it('includes open tasks section', () => {
    const state = makeState([makeTask({ id: 'T001', title: 'My open task', status: 'todo' })]);
    const result = buildPrompt('gemini', state, os.tmpdir(), 'Proj');
    assert.match(result, /Open tasks/);
  });
});

describe('suggestNext', () => {
  it('returns idle when no tasks', () => {
    const state = makeState([]);
    const suggestion = suggestNext(state, 'claude');
    assert.equal(suggestion['action'], 'idle');
  });

  it('suggests continuing in-progress task', () => {
    const state = makeState([makeTask({ id: 'T001', status: 'in_progress', owner: 'claude' })]);
    const suggestion = suggestNext(state, 'claude');
    assert.equal(suggestion['action'], 'continue_task');
  });

  it('throws for unknown agent', () => {
    const state = makeState([]);
    assert.throws(() => suggestNext(state, 'bogusagent999'), /Unknown agent/);
  });
});
