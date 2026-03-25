/**
 * Tests for hydra-operator-workers — worker Map state, status, and cleanup.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { _setTestConfig, invalidateConfigCache } from '../lib/hydra-config.ts';
import { workers, _getWorkerStatus, stopAllWorkers } from '../lib/hydra-operator-workers.ts';

// Ensure config doesn't read from disk
beforeEach(() => {
  _setTestConfig({} as never);
});

afterEach(() => {
  // Clean up any workers we added
  workers.clear();
  invalidateConfigCache();
});

// ── workers Map ──────────────────────────────────────────────────────────────

describe('workers Map', () => {
  it('is a Map instance', () => {
    assert.ok(workers instanceof Map);
  });

  it('starts empty', () => {
    assert.equal(workers.size, 0);
  });

  it('supports basic Map operations', () => {
    // Create a minimal mock worker
    const mockWorker = Object.assign(new EventEmitter(), {
      agent: 'testbot',
      status: 'idle',
      currentTask: null,
      uptime: 0,
      permissionMode: 'auto-edit',
      start: () => {},
      stop: () => {},
      kill: () => {},
    });
    workers.set('testbot', mockWorker as never);
    assert.equal(workers.size, 1);
    assert.ok(workers.has('testbot'));
    workers.delete('testbot');
    assert.equal(workers.size, 0);
  });
});

// ── _getWorkerStatus ─────────────────────────────────────────────────────────

describe('_getWorkerStatus', () => {
  it('returns null for unknown agent', () => {
    assert.equal(_getWorkerStatus('nonexistent-agent'), null);
  });

  it('returns status object for known worker', () => {
    const mockWorker = Object.assign(new EventEmitter(), {
      agent: 'claude',
      status: 'idle',
      currentTask: null,
      uptime: 12345,
      permissionMode: 'full-auto',
      start: () => {},
      stop: () => {},
      kill: () => {},
    });
    workers.set('claude', mockWorker as never);

    const status = _getWorkerStatus('claude');
    assert.ok(status !== null);
    assert.equal(status.agent, 'claude');
    assert.equal(status.status, 'idle');
    assert.equal(status.currentTask, null);
    assert.equal(status.uptime, 12345);
    assert.equal(status.permissionMode, 'full-auto');
  });

  it('returns current task info when worker is working', () => {
    const taskInfo = { taskId: 'task-001', title: 'Fix bug', startedAt: Date.now() };
    const mockWorker = Object.assign(new EventEmitter(), {
      agent: 'gemini',
      status: 'working',
      currentTask: taskInfo,
      uptime: 5000,
      permissionMode: 'auto-edit',
      start: () => {},
      stop: () => {},
      kill: () => {},
    });
    workers.set('gemini', mockWorker as never);

    const status = _getWorkerStatus('gemini');
    assert.ok(status !== null);
    assert.equal(status.status, 'working');
    assert.deepEqual(status.currentTask, taskInfo);
  });

  it('normalises agent name to lowercase', () => {
    const mockWorker = Object.assign(new EventEmitter(), {
      agent: 'codex',
      status: 'idle',
      currentTask: null,
      uptime: 0,
      permissionMode: 'auto-edit',
      start: () => {},
      stop: () => {},
      kill: () => {},
    });
    workers.set('codex', mockWorker as never);

    const status = _getWorkerStatus('CODEX');
    assert.ok(status !== null);
    assert.equal(status.agent, 'codex');
  });
});

// ── stopAllWorkers ───────────────────────────────────────────────────────────

describe('stopAllWorkers', () => {
  it('clears the workers map', () => {
    let killCalled = false;
    const mockWorker = Object.assign(new EventEmitter(), {
      agent: 'claude',
      status: 'idle',
      currentTask: null,
      uptime: 0,
      permissionMode: 'auto-edit',
      start: () => {},
      stop: () => {},
      kill: () => {
        killCalled = true;
      },
    });
    workers.set('claude', mockWorker as never);

    stopAllWorkers();
    assert.equal(workers.size, 0);
    assert.ok(killCalled, 'kill() should have been called');
  });

  it('calls kill on all workers', () => {
    const killed: string[] = [];
    for (const name of ['gemini', 'codex', 'claude']) {
      const mockWorker = Object.assign(new EventEmitter(), {
        agent: name,
        status: 'working',
        currentTask: null,
        uptime: 0,
        permissionMode: 'auto-edit',
        start: () => {},
        stop: () => {},
        kill: () => {
          killed.push(name);
        },
      });
      workers.set(name, mockWorker as never);
    }

    stopAllWorkers();
    assert.equal(workers.size, 0);
    assert.equal(killed.length, 3);
    assert.ok(killed.includes('gemini'));
    assert.ok(killed.includes('codex'));
    assert.ok(killed.includes('claude'));
  });

  it('handles empty workers map', () => {
    // Should not throw when no workers exist
    stopAllWorkers();
    assert.equal(workers.size, 0);
  });
});
