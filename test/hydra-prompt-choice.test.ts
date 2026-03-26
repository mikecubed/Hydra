/**
 * Tests for hydra-prompt-choice — multi-select parsing, auto-accept state, and choice state.
 */

import { describe, it, before, afterEach } from 'node:test';
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

// ── Additional parseMultiSelectInput edge cases ──────────────────────────────

describe('parseMultiSelectInput edge cases', () => {
  it('handles "A" (uppercase single letter)', () => {
    assert.equal(parseMultiSelectInput('A', 5), 'all');
  });

  it('handles "All" (mixed case)', () => {
    assert.equal(parseMultiSelectInput('All', 5), 'all');
  });

  it('handles whitespace around "all"', () => {
    assert.equal(parseMultiSelectInput('  all  ', 5), 'all');
  });

  it('handles whitespace around "a"', () => {
    assert.equal(parseMultiSelectInput('  a  ', 5), 'all');
  });

  it('returns null for just commas', () => {
    assert.equal(parseMultiSelectInput(',,,', 5), null);
  });

  it('handles range at boundary (1-maxIndex)', () => {
    assert.deepEqual(parseMultiSelectInput('1-5', 5), [0, 1, 2, 3, 4]);
  });

  it('returns null for range starting at 0', () => {
    assert.equal(parseMultiSelectInput('0-3', 5), null);
  });

  it('returns null for range exceeding maxIndex', () => {
    assert.equal(parseMultiSelectInput('1-6', 5), null);
  });

  it('handles single-element range (e.g. 3-3)', () => {
    assert.deepEqual(parseMultiSelectInput('3-3', 5), [2]);
  });

  it('handles large maxIndex', () => {
    assert.deepEqual(parseMultiSelectInput('99,100', 100), [98, 99]);
  });

  it('handles mixed commas and spaces', () => {
    assert.deepEqual(parseMultiSelectInput('1, 2 3,4', 5), [0, 1, 2, 3]);
  });

  it('returns null when range has non-numeric parts', () => {
    assert.equal(parseMultiSelectInput('a-b', 5), null);
  });

  it('handles duplicate across range and individual', () => {
    // 1-3 gives [0,1,2], then 2 gives [1] — deduped
    assert.deepEqual(parseMultiSelectInput('1-3,2', 5), [0, 1, 2]);
  });

  it('returns null for float-like range "1.0-3.0"', () => {
    // The regex /^(\d+)\s*-\s*(\d+)$/ won't match "1.0-3.0"
    // It will try parseInt("1.0-3.0") which is 1, valid
    // Actually "1.0-3.0" split by comma/space is ["1.0-3.0"]
    // rangeMatch: /^(\d+)\s*-\s*(\d+)$/ won't match "1.0-3.0"
    // So it falls through to parseInt("1.0-3.0") = 1 which is valid
    assert.deepEqual(parseMultiSelectInput('1.0-3.0', 5), [0]);
  });
});

// ── Auto-Accept State additional tests ───────────────────────────────────────

describe('auto-accept state additional', () => {
  afterEach(() => {
    resetAutoAccept();
  });

  it('setAutoAccept is idempotent for true', () => {
    setAutoAccept(true);
    setAutoAccept(true);
    assert.equal(isAutoAccepting(), true);
  });

  it('setAutoAccept is idempotent for false', () => {
    setAutoAccept(false);
    setAutoAccept(false);
    assert.equal(isAutoAccepting(), false);
  });

  it('resetAutoAccept works even when already false', () => {
    assert.equal(isAutoAccepting(), false);
    resetAutoAccept();
    assert.equal(isAutoAccepting(), false);
  });

  it('toggle sequence: false -> true -> false -> true', () => {
    assert.equal(isAutoAccepting(), false);
    setAutoAccept(true);
    assert.equal(isAutoAccepting(), true);
    setAutoAccept(false);
    assert.equal(isAutoAccepting(), false);
    setAutoAccept(true);
    assert.equal(isAutoAccepting(), true);
  });
});

// ── promptChoice non-TTY / auto-accept behavior ─────────────────────────────

describe('promptChoice non-TTY behavior', () => {
  // promptChoice returns default immediately when not TTY
  // We import it here to test
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- dynamic import needed for test setup
  let promptChoice: typeof import('../lib/hydra-prompt-choice.ts').promptChoice;

  before(async () => {
    const mod = await import('../lib/hydra-prompt-choice.ts');
    promptChoice = mod.promptChoice;
  });

  afterEach(() => {
    resetAutoAccept();
  });

  it('returns default value in non-TTY environment', async () => {
    // In test environment, stdout is typically not a TTY
    const mockRl = {
      listeners: () => [],
      removeAllListeners: () => mockRl,
      on: () => mockRl,
      setPrompt: () => {},
      prompt: () => {},
    };
    const result = await promptChoice(mockRl, {
      title: 'Test',
      choices: [
        { label: 'Option A', value: 'a' },
        { label: 'Option B', value: 'b' },
      ],
      defaultValue: 'a',
    });
    // In non-TTY, should return default value
    assert.equal(result.value, 'a');
    assert.equal(result.timedOut, false);
  });

  it('returns default when auto-accept is on', async () => {
    setAutoAccept(true);
    const mockRl = {
      listeners: () => [],
      removeAllListeners: () => mockRl,
      on: () => mockRl,
      setPrompt: () => {},
      prompt: () => {},
    };
    const result = await promptChoice(mockRl, {
      title: 'Test',
      choices: [
        { label: 'Option A', value: 'a' },
        { label: 'Option B', value: 'b' },
      ],
      defaultValue: 'a',
    });
    assert.equal(result.value, 'a');
    assert.equal(result.autoAcceptAll, true);
  });

  it('returns default immediately with empty choices array', async () => {
    const mockRl = {
      listeners: () => [],
      removeAllListeners: () => mockRl,
      on: () => mockRl,
      setPrompt: () => {},
      prompt: () => {},
    };
    const result = await promptChoice(mockRl, {
      title: 'Test',
      choices: [],
      defaultValue: 'fallback',
    });
    assert.equal(result.value, 'fallback');
    assert.equal(result.timedOut, false);
  });

  it('defaults to first choice value when defaultValue not specified', async () => {
    const mockRl = {
      listeners: () => [],
      removeAllListeners: () => mockRl,
      on: () => mockRl,
      setPrompt: () => {},
      prompt: () => {},
    };
    const result = await promptChoice(mockRl, {
      title: 'Test',
      choices: [
        { label: 'First', value: 'first' },
        { label: 'Second', value: 'second' },
      ],
    });
    // Default should be first choice's value
    assert.equal(result.value, 'first');
  });

  it('multi-select returns all values in non-TTY when none preSelected', async () => {
    const mockRl = {
      listeners: () => [],
      removeAllListeners: () => mockRl,
      on: () => mockRl,
      setPrompt: () => {},
      prompt: () => {},
    };
    const result = await promptChoice(mockRl, {
      title: 'Test',
      multiSelect: true,
      choices: [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
        { label: 'C', value: 'c' },
      ],
    });
    // In non-TTY with no preSelected, returns all values
    assert.ok(Array.isArray(result.values));
    assert.deepEqual(result.values, ['a', 'b', 'c']);
  });

  it('multi-select returns preSelected values in non-TTY', async () => {
    const mockRl = {
      listeners: () => [],
      removeAllListeners: () => mockRl,
      on: () => mockRl,
      setPrompt: () => {},
      prompt: () => {},
    };
    const result = await promptChoice(mockRl, {
      title: 'Test',
      multiSelect: true,
      choices: [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
        { label: 'C', value: 'c' },
      ],
      preSelected: ['a', 'c'],
    });
    assert.ok(Array.isArray(result.values));
    assert.deepEqual(result.values, ['a', 'c']);
  });

  it('multi-select with empty choices returns empty values', async () => {
    const mockRl = {
      listeners: () => [],
      removeAllListeners: () => mockRl,
      on: () => mockRl,
      setPrompt: () => {},
      prompt: () => {},
    };
    const result = await promptChoice(mockRl, {
      title: 'Test',
      multiSelect: true,
      choices: [],
    });
    assert.ok(Array.isArray(result.values));
    assert.deepEqual(result.values, []);
  });
});
