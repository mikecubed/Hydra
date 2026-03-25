/**
 * Tests for hydra-prompt-choice — multi-select parsing, auto-accept state, and choice state.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMultiSelectInput,
  setAutoAccept,
  resetAutoAccept,
  isAutoAccepting,
  isChoiceActive,
} from '../lib/hydra-prompt-choice.ts';

describe('parseMultiSelectInput', () => {
  it('returns "all" for "a" input', () => {
    assert.equal(parseMultiSelectInput('a', 5), 'all');
    assert.equal(parseMultiSelectInput('all', 5), 'all');
    assert.equal(parseMultiSelectInput('ALL', 5), 'all');
  });

  it('parses single numbers', () => {
    assert.deepEqual(parseMultiSelectInput('3', 5), [2]);
    assert.deepEqual(parseMultiSelectInput('1', 5), [0]);
  });

  it('parses comma-separated numbers', () => {
    assert.deepEqual(parseMultiSelectInput('1,3,5', 5), [0, 2, 4]);
    assert.deepEqual(parseMultiSelectInput('2, 4', 5), [1, 3]);
  });

  it('parses ranges', () => {
    assert.deepEqual(parseMultiSelectInput('1-3', 5), [0, 1, 2]);
    assert.deepEqual(parseMultiSelectInput('2-4', 5), [1, 2, 3]);
  });

  it('parses mixed numbers and ranges', () => {
    assert.deepEqual(parseMultiSelectInput('1,3-5', 5), [0, 2, 3, 4]);
  });

  it('deduplicates overlapping selections', () => {
    assert.deepEqual(parseMultiSelectInput('1,1,2', 5), [0, 1]);
    assert.deepEqual(parseMultiSelectInput('1-3,2', 5), [0, 1, 2]);
  });

  it('returns null for empty input', () => {
    assert.equal(parseMultiSelectInput('', 5), null);
    assert.equal(parseMultiSelectInput('  ', 5), null);
  });

  it('returns null for out-of-range numbers', () => {
    assert.equal(parseMultiSelectInput('0', 5), null);
    assert.equal(parseMultiSelectInput('6', 5), null);
    assert.equal(parseMultiSelectInput('1,10', 5), null);
  });

  it('returns null for invalid ranges', () => {
    assert.equal(parseMultiSelectInput('3-1', 5), null); // reversed
    assert.equal(parseMultiSelectInput('0-3', 5), null); // below 1
    assert.equal(parseMultiSelectInput('3-10', 5), null); // above max
  });

  it('returns null for non-numeric input', () => {
    assert.equal(parseMultiSelectInput('abc', 5), null);
    assert.equal(parseMultiSelectInput('x', 5), null);
  });

  it('handles space-separated numbers', () => {
    assert.deepEqual(parseMultiSelectInput('1 3 5', 5), [0, 2, 4]);
  });

  it('returns sorted indices', () => {
    assert.deepEqual(parseMultiSelectInput('5,1,3', 5), [0, 2, 4]);
  });

  it('handles maxIndex of 1 (single choice)', () => {
    assert.deepEqual(parseMultiSelectInput('1', 1), [0]);
    assert.equal(parseMultiSelectInput('2', 1), null);
  });

  it('handles tab-separated input', () => {
    assert.deepEqual(parseMultiSelectInput('1\t3', 5), [0, 2]);
  });

  it('returns null for negative numbers', () => {
    assert.equal(parseMultiSelectInput('-1', 5), null);
  });

  it('parseInt truncates decimal — "1.5" parses as 1', () => {
    // parseInt('1.5', 10) === 1, which is valid
    assert.deepEqual(parseMultiSelectInput('1.5', 5), [0]);
  });
});

// ── Auto-Accept State ────────────────────────────────────────────────────────

describe('auto-accept state', () => {
  afterEach(() => {
    resetAutoAccept();
  });

  it('isAutoAccepting defaults to false', () => {
    assert.equal(isAutoAccepting(), false);
  });

  it('setAutoAccept(true) enables auto-accept', () => {
    setAutoAccept(true);
    assert.equal(isAutoAccepting(), true);
  });

  it('setAutoAccept(false) disables auto-accept', () => {
    setAutoAccept(true);
    setAutoAccept(false);
    assert.equal(isAutoAccepting(), false);
  });

  it('resetAutoAccept resets to false', () => {
    setAutoAccept(true);
    resetAutoAccept();
    assert.equal(isAutoAccepting(), false);
  });
});

// ── Choice Active State ──────────────────────────────────────────────────────

describe('isChoiceActive', () => {
  it('returns a boolean', () => {
    assert.equal(typeof isChoiceActive(), 'boolean');
  });

  it('returns false when no choice prompt is active', () => {
    // Outside of a promptChoice call, this should be false
    assert.equal(isChoiceActive(), false);
  });
});
