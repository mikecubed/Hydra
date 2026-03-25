/**
 * Coverage tests for lib/hydra-worker.ts — AgentWorker class and utility functions.
 *
 * Tests the exported getWorkerConcurrencyStats() function and the AgentWorker class
 * constructor, state management, and _buildTaskPrompt without requiring network calls.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getWorkerConcurrencyStats, AgentWorker } from '../lib/hydra-worker.ts';

// ── getWorkerConcurrencyStats ────────────────────────────────────────────────

describe('getWorkerConcurrencyStats', () => {
  it('returns an object with active, maxInFlight, and utilization', () => {
    const stats = getWorkerConcurrencyStats();
    assert.equal(typeof stats.active, 'number');
    assert.equal(typeof stats.maxInFlight, 'number');
    assert.equal(typeof stats.utilization, 'number');
  });

  it('active count is non-negative', () => {
    const stats = getWorkerConcurrencyStats();
    assert.ok(stats.active >= 0);
  });

  it('maxInFlight is positive', () => {
    const stats = getWorkerConcurrencyStats();
    assert.ok(stats.maxInFlight > 0);
  });

  it('utilization is between 0 and 1 (inclusive)', () => {
    const stats = getWorkerConcurrencyStats();
    assert.ok(stats.utilization >= 0 && stats.utilization <= 1);
  });
});

// ── AgentWorker constructor ──────────────────────────────────────────────────

describe('AgentWorker constructor', () => {
  it('creates a worker with lowercase agent name', () => {
    const w = new AgentWorker('CLAUDE');
    assert.equal(w.agent, 'claude');
  });

  it('sets default baseUrl and projectRoot to empty string', () => {
    const w = new AgentWorker('gemini');
    assert.equal(w.baseUrl, '');
    assert.equal(w.projectRoot, '');
  });

  it('accepts custom baseUrl and projectRoot', () => {
    const w = new AgentWorker('codex', {
      baseUrl: 'http://localhost:4173',
      projectRoot: '/tmp/test',
    });
    assert.equal(w.baseUrl, 'http://localhost:4173');
    assert.equal(w.projectRoot, '/tmp/test');
  });

  it('initializes status as stopped', () => {
    const w = new AgentWorker('claude');
    assert.equal(w.status, 'stopped');
  });

  it('initializes currentTask as null', () => {
    const w = new AgentWorker('claude');
    assert.strictEqual(w.currentTask, null);
  });

  it('initializes uptime as 0', () => {
    const w = new AgentWorker('claude');
    assert.equal(w.uptime, 0);
  });

  it('sets default permission mode from config', () => {
    const w = new AgentWorker('claude');
    assert.equal(typeof w.permissionMode, 'string');
    assert.ok(w.permissionMode.length > 0);
  });

  it('accepts custom permissionMode', () => {
    const w = new AgentWorker('claude', { permissionMode: 'full-auto' });
    assert.equal(w.permissionMode, 'full-auto');
  });

  it('accepts custom autoChain', () => {
    const w = new AgentWorker('claude', { autoChain: false });
    assert.equal(w.autoChain, false);
  });

  it('has positive poll interval', () => {
    const w = new AgentWorker('claude');
    assert.ok(w.pollIntervalMs > 0);
    assert.ok(w.basePollIntervalMs > 0);
  });

  it('has positive maxOutputBytes', () => {
    const w = new AgentWorker('claude');
    assert.ok(w.maxOutputBytes > 0);
  });

  it('is an EventEmitter', () => {
    const w = new AgentWorker('claude');
    assert.equal(typeof w.on, 'function');
    assert.equal(typeof w.emit, 'function');
  });
});

// ── AgentWorker.stop() ──────────────────────────────────────────────────────

describe('AgentWorker.stop()', () => {
  it('transitions idle worker to stopped', () => {
    const w = new AgentWorker('claude');
    // Manually set to idle to simulate started state
    w._status = 'idle';
    w.stop();
    assert.equal(w.status, 'stopped');
  });

  it('emits worker:stop on idle stop', () => {
    const w = new AgentWorker('claude');
    w._status = 'idle';
    let emitted = false;
    w.on('worker:stop', () => {
      emitted = true;
    });
    w.stop();
    assert.ok(emitted);
  });

  it('sets _stopped flag when working', () => {
    const w = new AgentWorker('claude');
    w._status = 'working';
    w.stop();
    assert.ok(w._stopped);
    // Status stays working (will finish current task then stop)
    assert.equal(w.status, 'working');
  });
});

// ── AgentWorker.kill() ──────────────────────────────────────────────────────

describe('AgentWorker.kill()', () => {
  it('transitions to stopped immediately', () => {
    const w = new AgentWorker('claude');
    w._status = 'working';
    w.kill();
    assert.equal(w.status, 'stopped');
    assert.strictEqual(w.currentTask, null);
  });

  it('emits worker:stop with reason killed', () => {
    const w = new AgentWorker('claude');
    let reason = '';
    w.on('worker:stop', (evt: { reason: string }) => {
      reason = evt.reason;
    });
    w.kill();
    assert.equal(reason, 'killed');
  });

  it('sets _stopped flag', () => {
    const w = new AgentWorker('claude');
    w.kill();
    assert.ok(w._stopped);
  });
});

// ── AgentWorker.setPermissionMode() ─────────────────────────────────────────

describe('AgentWorker.setPermissionMode()', () => {
  it('updates the permission mode', () => {
    const w = new AgentWorker('claude');
    w.setPermissionMode('full-auto');
    assert.equal(w.permissionMode, 'full-auto');
  });

  it('accepts any string', () => {
    const w = new AgentWorker('claude');
    w.setPermissionMode('custom-mode');
    assert.equal(w.permissionMode, 'custom-mode');
  });
});

// ── AgentWorker._buildTaskPrompt() ──────────────────────────────────────────

describe('AgentWorker._buildTaskPrompt()', () => {
  it('returns default prompt for null task', () => {
    const w = new AgentWorker('claude');
    const prompt = w._buildTaskPrompt(null);
    assert.equal(prompt, 'Continue assigned work.');
  });

  it('includes task title', () => {
    const w = new AgentWorker('claude');
    const prompt = w._buildTaskPrompt({ title: 'Fix the auth bug' });
    assert.match(prompt, /Task: Fix the auth bug/);
  });

  it('uses "Untitled" for missing title', () => {
    const w = new AgentWorker('claude');
    const prompt = w._buildTaskPrompt({});
    assert.match(prompt, /Task: Untitled/);
  });

  it('includes notes when present', () => {
    const w = new AgentWorker('claude');
    const prompt = w._buildTaskPrompt({
      title: 'Test',
      notes: 'Some important notes',
    });
    assert.match(prompt, /Notes: Some important notes/);
  });

  it('stringifies non-string notes', () => {
    const w = new AgentWorker('claude');
    const prompt = w._buildTaskPrompt({
      title: 'Test',
      notes: { key: 'value' },
    });
    assert.match(prompt, /Notes:/);
    assert.match(prompt, /key/);
  });

  it('includes definition of done when present', () => {
    const w = new AgentWorker('claude');
    const prompt = w._buildTaskPrompt({
      title: 'Test',
      done: 'All tests pass',
    });
    assert.match(prompt, /Definition of Done: All tests pass/);
  });

  it('stringifies non-string done field', () => {
    const w = new AgentWorker('claude');
    const prompt = w._buildTaskPrompt({
      title: 'Test',
      done: ['test1', 'test2'],
    });
    assert.match(prompt, /Definition of Done:/);
  });

  it('includes execution instruction', () => {
    const w = new AgentWorker('claude');
    const prompt = w._buildTaskPrompt({ title: 'Test' });
    assert.match(prompt, /Execute this task/);
    assert.match(prompt, /Report exactly what you changed/);
  });
});

// ── AgentWorker.uptime ──────────────────────────────────────────────────────

describe('AgentWorker.uptime', () => {
  it('returns 0 when not started', () => {
    const w = new AgentWorker('claude');
    assert.equal(w.uptime, 0);
  });

  it('returns positive value after _startedAt is set', () => {
    const w = new AgentWorker('claude');
    w._startedAt = Date.now() - 5000;
    assert.ok(w.uptime >= 4000); // Allow for timing variance
  });
});

// ── AgentWorker.start() — guard for already-running ─────────────────────────

describe('AgentWorker.start() — guard for already running', () => {
  let worker: AgentWorker;

  afterEach(() => {
    if (worker && typeof worker.kill === 'function') worker.kill();
  });

  it('does not restart when already idle', () => {
    worker = new AgentWorker('claude', { baseUrl: 'http://localhost:99999' });
    worker._status = 'idle';
    const beforeStartedAt = worker._startedAt;
    worker.start(); // Should be a no-op
    assert.equal(worker._startedAt, beforeStartedAt);
  });

  it('does not restart when working', () => {
    worker = new AgentWorker('claude', { baseUrl: 'http://localhost:99999' });
    worker._status = 'working';
    const beforeStartedAt = worker._startedAt;
    worker.start(); // Should be a no-op
    assert.equal(worker._startedAt, beforeStartedAt);
  });
});

// Note: _sleep() and _pollNext() are async I/O methods whose promises outlive
// the test runner event loop.  They are covered indirectly by integration tests.
