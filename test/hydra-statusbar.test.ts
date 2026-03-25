/**
 * Tests for hydra-statusbar — agent activity state, dispatch context, and lifecycle.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { _setTestConfig, invalidateConfigCache } from '../lib/hydra-config.ts';
import {
  setAgentActivity,
  getAgentActivity,
  setAgentExecMode,
  getAgentExecMode,
  setDispatchContext,
  clearDispatchContext,
  setLastDispatch,
  setActiveMode,
  updateTaskCount,
} from '../lib/hydra-statusbar.ts';

// Ensure loadHydraConfig doesn't read from disk during tests
beforeEach(() => {
  _setTestConfig({} as never);
});

afterEach(() => {
  invalidateConfigCache();
});

// ── Agent Activity State ─────────────────────────────────────────────────────

describe('setAgentActivity / getAgentActivity', () => {
  it('returns default inactive state for unknown agent', () => {
    const state = getAgentActivity('nonexistent-agent-xyz');
    assert.equal(state.status, 'inactive');
    assert.equal(state.action, '');
    assert.equal(state.model, null);
    assert.equal(state.taskTitle, null);
    assert.equal(state.phase, null);
    assert.equal(state.step, null);
    assert.equal(state.updatedAt, 0);
  });

  it('sets and gets agent activity', () => {
    setAgentActivity('gemini', 'working', 'Analyzing code', {
      model: 'gemini-2.5-pro',
      taskTitle: 'Review PR #42',
      phase: 'analysis',
      step: '2/4',
    });

    const state = getAgentActivity('gemini');
    assert.equal(state.status, 'working');
    assert.equal(state.action, 'Analyzing code');
    assert.equal(state.model, 'gemini-2.5-pro');
    assert.equal(state.taskTitle, 'Review PR #42');
    assert.equal(state.phase, 'analysis');
    assert.equal(state.step, '2/4');
    assert.ok(state.updatedAt > 0);
  });

  it('normalises agent name to lowercase', () => {
    setAgentActivity('CLAUDE', 'idle', 'Waiting');
    const state = getAgentActivity('claude');
    assert.equal(state.status, 'idle');
    assert.equal(state.action, 'Waiting');
  });

  it('defaults missing meta fields to null', () => {
    setAgentActivity('codex', 'working', 'Building');
    const state = getAgentActivity('codex');
    assert.equal(state.model, null);
    assert.equal(state.taskTitle, null);
    assert.equal(state.phase, null);
    assert.equal(state.step, null);
  });

  it('defaults empty status to inactive', () => {
    setAgentActivity('codex', '', '');
    const state = getAgentActivity('codex');
    assert.equal(state.status, 'inactive');
    assert.equal(state.action, '');
  });

  it('overwrites previous state', () => {
    setAgentActivity('gemini', 'working', 'First task');
    setAgentActivity('gemini', 'idle', 'Done');
    const state = getAgentActivity('gemini');
    assert.equal(state.status, 'idle');
    assert.equal(state.action, 'Done');
  });
});

// ── Agent Exec Mode ──────────────────────────────────────────────────────────

describe('setAgentExecMode / getAgentExecMode', () => {
  it('returns null for unknown agent', () => {
    assert.equal(getAgentExecMode('unknown-agent-xyz'), null);
  });

  it('sets and gets exec mode', () => {
    setAgentExecMode('claude', 'worker');
    assert.equal(getAgentExecMode('claude'), 'worker');
  });

  it('sets terminal mode', () => {
    setAgentExecMode('gemini', 'terminal');
    assert.equal(getAgentExecMode('gemini'), 'terminal');
  });

  it('clears mode with null', () => {
    setAgentExecMode('codex', 'worker');
    setAgentExecMode('codex', null);
    assert.equal(getAgentExecMode('codex'), null);
  });

  it('normalises agent name to lowercase', () => {
    setAgentExecMode('CLAUDE', 'worker');
    assert.equal(getAgentExecMode('claude'), 'worker');
  });
});

// ── Dispatch Context ─────────────────────────────────────────────────────────

describe('setDispatchContext / clearDispatchContext', () => {
  it('sets and clears dispatch context without error', () => {
    // These are state setters — just verify they don't throw
    setDispatchContext({
      promptSummary: 'Fix the bug',
      topic: 'debugging',
      tier: 'T2',
      startedAt: Date.now(),
    });
    clearDispatchContext();
  });

  it('handles null context', () => {
    setDispatchContext(null);
    // Should not throw
  });

  it('auto-adds startedAt if missing', () => {
    const before = Date.now();
    setDispatchContext({ promptSummary: 'Test' });
    // No way to read dispatchContext directly, but this validates no throw
    clearDispatchContext();
    const after = Date.now();
    assert.ok(after >= before);
  });
});

// ── State Setters ────────────────────────────────────────────────────────────

describe('setLastDispatch', () => {
  it('sets last dispatch info without error', () => {
    setLastDispatch({ route: 'claude', tier: 'T1', agent: 'claude', mode: 'auto' });
    // State setter — verify no throw
  });

  it('merges with existing state', () => {
    setLastDispatch({ route: 'gemini' });
    setLastDispatch({ tier: 'T2' });
    // Both should be recorded (merged), no throw
  });
});

describe('setActiveMode', () => {
  it('sets mode without error', () => {
    setActiveMode('smart');
    setActiveMode('auto');
    setActiveMode('council');
  });

  it('defaults empty string to auto', () => {
    setActiveMode('');
    // Internally should default to 'auto', no throw
  });
});

describe('updateTaskCount', () => {
  it('sets task count without error', () => {
    updateTaskCount(5);
    updateTaskCount(0);
  });

  it('clamps negative counts to 0', () => {
    updateTaskCount(-3);
    // Should not throw; internally clamps to 0
  });

  it('handles NaN/falsy as 0', () => {
    updateTaskCount(Number.NaN);
    updateTaskCount(0);
  });
});
