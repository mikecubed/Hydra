import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractHandoffAgents,
  findPowerShell,
  findWindowsTerminal,
} from '../lib/hydra-operator-startup.ts';

describe('extractHandoffAgents', () => {
  it('returns [] for null/undefined result', () => {
    assert.deepEqual(extractHandoffAgents(null as unknown as Record<string, unknown>), []);
    assert.deepEqual(extractHandoffAgents(undefined as unknown as Record<string, unknown>), []);
  });

  it('returns [] when published is missing', () => {
    assert.deepEqual(extractHandoffAgents({}), []);
    assert.deepEqual(extractHandoffAgents({ published: {} }), []);
  });

  it('returns [] when handoffs is empty array', () => {
    assert.deepEqual(extractHandoffAgents({ published: { handoffs: [] } }), []);
  });

  it('extracts known agent names from handoffs', () => {
    const result = extractHandoffAgents({
      published: { handoffs: [{ to: 'claude' }, { to: 'gemini' }] },
    });
    assert.ok(result.includes('claude'), 'should include claude');
    assert.ok(result.includes('gemini'), 'should include gemini');
  });

  it('deduplicates repeated agents', () => {
    const result = extractHandoffAgents({
      published: { handoffs: [{ to: 'codex' }, { to: 'codex' }] },
    });
    assert.equal(result.length, 1);
    assert.equal(result[0], 'codex');
  });

  it('skips unknown agents', () => {
    const result = extractHandoffAgents({
      published: { handoffs: [{ to: 'unknown-agent-xyz' }, { to: 'claude' }] },
    });
    assert.deepEqual(result, ['claude']);
  });

  it('normalises agent names to lowercase', () => {
    const result = extractHandoffAgents({
      published: { handoffs: [{ to: 'CLAUDE' }] },
    });
    assert.ok(result.includes('claude'));
  });
});

describe('findPowerShell (non-Windows)', () => {
  it('returns null on non-Windows platforms', { skip: process.platform === 'win32' }, () => {
    assert.equal(findPowerShell(), null);
  });
});

describe('findWindowsTerminal (non-Windows)', () => {
  it('returns null on non-Windows platforms', { skip: process.platform === 'win32' }, () => {
    assert.equal(findWindowsTerminal(), null);
  });
});

// ── extractHandoffAgents additional edge cases ──────────────────────────────

describe('extractHandoffAgents — edge cases', () => {
  it('returns [] when handoffs contains items with missing "to"', () => {
    const result = extractHandoffAgents({
      published: { handoffs: [{ from: 'gemini' }, {}] },
    });
    assert.deepEqual(result, []);
  });

  it('returns [] when handoffs contains items with empty "to"', () => {
    const result = extractHandoffAgents({
      published: { handoffs: [{ to: '' }] },
    });
    assert.deepEqual(result, []);
  });

  it('handles handoffs array with mixed valid and missing to fields', () => {
    const result = extractHandoffAgents({
      published: { handoffs: [{ to: 'claude' }, { from: 'gemini' }, { to: 'codex' }] },
    });
    assert.ok(result.includes('claude'));
    assert.ok(result.includes('codex'));
  });

  it('returns [] when published.handoffs is not an array', () => {
    assert.deepEqual(extractHandoffAgents({ published: { handoffs: 'not-array' } }), []);
    assert.deepEqual(extractHandoffAgents({ published: { handoffs: 42 } }), []);
    assert.deepEqual(extractHandoffAgents({ published: { handoffs: null } }), []);
  });

  it('handles deeply nested result objects', () => {
    const result = extractHandoffAgents({
      published: {
        handoffs: [{ to: 'gemini', payload: { nested: { deep: true } } }],
      },
    });
    assert.deepEqual(result, ['gemini']);
  });

  it('handles single handoff', () => {
    const result = extractHandoffAgents({
      published: { handoffs: [{ to: 'claude' }] },
    });
    assert.deepEqual(result, ['claude']);
    assert.equal(result.length, 1);
  });

  it('handles multiple unique agents', () => {
    const result = extractHandoffAgents({
      published: {
        handoffs: [{ to: 'claude' }, { to: 'gemini' }, { to: 'codex' }],
      },
    });
    assert.equal(result.length, 3);
  });
});

// ── findPowerShell / findWindowsTerminal additional tests ────────────────────

describe('findPowerShell — platform behavior', () => {
  it('returns string or null', () => {
    const result = findPowerShell();
    assert.ok(result === null || typeof result === 'string');
  });
});

describe('findWindowsTerminal — platform behavior', () => {
  it('returns string or null', () => {
    const result = findWindowsTerminal();
    assert.ok(result === null || typeof result === 'string');
  });
});

// ── Coverage Phase 4: Extended Tests ─────────────────────────────────────────

describe('extractHandoffAgents — type coercion edge cases', () => {
  it('handles numeric to field', () => {
    const result = extractHandoffAgents({
      published: { handoffs: [{ to: 123 }] },
    });
    // String(123) = '123', not a known agent
    assert.deepEqual(result, []);
  });

  it('handles boolean to field', () => {
    const result = extractHandoffAgents({
      published: { handoffs: [{ to: true }] },
    });
    assert.deepEqual(result, []);
  });

  it('handles undefined to field', () => {
    const result = extractHandoffAgents({
      published: { handoffs: [{ to: undefined }] },
    });
    assert.deepEqual(result, []);
  });

  it('preserves order of first appearance', () => {
    const result = extractHandoffAgents({
      published: {
        handoffs: [{ to: 'gemini' }, { to: 'claude' }, { to: 'gemini' }, { to: 'codex' }],
      },
    });
    assert.equal(result[0], 'gemini');
    assert.equal(result[1], 'claude');
    assert.equal(result[2], 'codex');
    assert.equal(result.length, 3);
  });

  it('handles case-insensitive deduplication', () => {
    const result = extractHandoffAgents({
      published: {
        handoffs: [{ to: 'Claude' }, { to: 'CLAUDE' }, { to: 'claude' }],
      },
    });
    assert.equal(result.length, 1);
    assert.equal(result[0], 'claude');
  });
});

describe('findPowerShell — extended non-Windows tests', () => {
  it('always returns null on non-Windows', { skip: process.platform === 'win32' }, () => {
    // Call multiple times to ensure consistent behavior
    assert.equal(findPowerShell(), null);
    assert.equal(findPowerShell(), null);
  });
});

describe('findWindowsTerminal — extended non-Windows tests', () => {
  it('always returns null on non-Windows', { skip: process.platform === 'win32' }, () => {
    assert.equal(findWindowsTerminal(), null);
    assert.equal(findWindowsTerminal(), null);
  });
});
