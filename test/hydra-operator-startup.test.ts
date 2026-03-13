/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractHandoffAgents,
  findPowerShell,
  findWindowsTerminal,
} from '../lib/hydra-operator-startup.ts';

describe('extractHandoffAgents', () => {
  it('returns [] for null/undefined result', () => {
    assert.deepEqual(extractHandoffAgents(null as any), []);
    assert.deepEqual(extractHandoffAgents(undefined as any), []);
  });

  it('returns [] when published is missing', () => {
    assert.deepEqual(extractHandoffAgents({} as any), []);
    assert.deepEqual(extractHandoffAgents({ published: {} } as any), []);
  });

  it('returns [] when handoffs is empty array', () => {
    assert.deepEqual(extractHandoffAgents({ published: { handoffs: [] } } as any), []);
  });

  it('extracts known agent names from handoffs', () => {
    const result = extractHandoffAgents({
      published: { handoffs: [{ to: 'claude' }, { to: 'gemini' }] },
    } as any);
    assert.ok(result.includes('claude'), 'should include claude');
    assert.ok(result.includes('gemini'), 'should include gemini');
  });

  it('deduplicates repeated agents', () => {
    const result = extractHandoffAgents({
      published: { handoffs: [{ to: 'codex' }, { to: 'codex' }] },
    } as any);
    assert.equal(result.length, 1);
    assert.equal(result[0], 'codex');
  });

  it('skips unknown agents', () => {
    const result = extractHandoffAgents({
      published: { handoffs: [{ to: 'unknown-agent-xyz' }, { to: 'claude' }] },
    } as any);
    assert.deepEqual(result, ['claude']);
  });

  it('normalises agent names to lowercase', () => {
    const result = extractHandoffAgents({
      published: { handoffs: [{ to: 'CLAUDE' }] },
    } as any);
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
