/**
 * T5 safety tests — boolean simplification (Priority 2)
 *
 * `@typescript-eslint/strict-boolean-expressions` will change:
 *   `if (str)` → `if (str !== '')`
 *   `if (arr)` → `if (arr.length > 0)`
 *   `if (!str)` → `if (str === '')`
 *   `!text || !text.trim()` → `text === '' || text.trim() === ''`
 *
 * These rewrites are semantically equivalent for typed string/array values.
 * The tests below verify the edge-case behaviour (empty string, empty array,
 * null/undefined) so that any accidental logic change is caught immediately.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractPathsFromPrompt, compileHierarchicalContext } from '../lib/hydra-context.ts';
import { normalizeIntent } from '../lib/hydra-intent-gate.ts';
import { classifyPrompt, selectTandemPair } from '../lib/hydra-utils.ts';

// ── extractPathsFromPrompt — empty / falsy input ──────────────────────────────

describe('extractPathsFromPrompt — boolean guard on text param', () => {
  it('returns [] for empty string (guard: !text)', () => {
    // `if (!text) return [];` — with strict-boolean: `if (text === '') return [];`
    // Both produce the same result, but the test pins the contract.
    const result = extractPathsFromPrompt('');
    assert.deepEqual(result, []);
  });

  it('returns [] when text has only whitespace (no file-path matches)', () => {
    const result = extractPathsFromPrompt('   ');
    assert.deepEqual(result, []);
  });

  it('returns [] when text has only prose (no file-path patterns)', () => {
    // Regression guard: ensure a truthy non-empty string that matches no paths
    // correctly returns [].
    const result = extractPathsFromPrompt('please fix the login flow today');
    assert.deepEqual(result, []);
  });
});

// ── compileHierarchicalContext — guard on files array ────────────────────────

describe('compileHierarchicalContext — empty array and null guard', () => {
  it('returns empty string for empty array (guard: !files || files.length === 0)', () => {
    // Both `![]` (false) and `[].length === 0` (true) → combined true → return ''.
    // The strict-boolean fix changes `!files` to `files == null`, leaving
    // `files.length === 0` as is.  End behaviour stays the same.
    const result = compileHierarchicalContext([], '/any/root');
    assert.equal(result, '');
  });

  it('returns empty string for null input (guard: !files branch)', () => {
    // Passing null exercises the `!files` branch directly.
    // After strict-boolean fix: `files == null || files.length === 0`
    // null == null → true → early return ''.  Semantics preserved.
    const result = compileHierarchicalContext(null as unknown as string[], '/any/root');
    assert.equal(result, '');
  });
});

// ── normalizeIntent — empty / whitespace-only input ──────────────────────────

describe('normalizeIntent — empty string / whitespace guard', () => {
  it('returns empty string for empty input (guard: !text)', () => {
    assert.equal(normalizeIntent(''), '');
  });

  it('returns empty string for whitespace-only input (guard: !text.trim())', () => {
    // `if (!text || !text.trim()) return '';`
    // With strict-boolean:  `if (text === '' || text.trim() === '') return '';`
    // Both paths return '' for whitespace-only.
    assert.equal(normalizeIntent('   '), '');
    assert.equal(normalizeIntent('\t\n'), '');
  });

  it('preserves non-empty text after normalization', () => {
    // Regression guard: truthy non-filler text must NOT be collapsed to ''.
    const result = normalizeIntent('fix the auth bug');
    assert.ok(result.length > 0);
    assert.ok(result.includes('auth'));
  });
});

// ── classifyPrompt — non-string / empty input ────────────────────────────────

describe('classifyPrompt — falsy and non-string inputs', () => {
  it('handles empty string without throwing and returns moderate tier', () => {
    // `const text = (typeof promptText === 'string' ? promptText : '').trim()`
    // Strict-boolean: `if (!text)` → `if (text === '')` — same result.
    const result = classifyPrompt('');
    assert.equal(result.tier, 'moderate');
    assert.equal(result.reason, 'Empty prompt');
  });

  it('handles null input (coerces to "") without throwing', () => {
    const result = classifyPrompt(null);
    assert.equal(result.tier, 'moderate');
    assert.equal(result.reason, 'Empty prompt');
  });

  it('handles numeric input (coerces to "") without throwing', () => {
    const result = classifyPrompt(0);
    assert.equal(result.tier, 'moderate');
  });
});

// ── selectTandemPair — empty array vs null filter ─────────────────────────────

describe('selectTandemPair — empty array guard', () => {
  it('returns default pair when agents is empty array', () => {
    // `if (!agents || agents.length === 0) return { lead, follow };`
    // ![] = false, [].length === 0 = true → combined true → returns default pair.
    // With strict-boolean fix: `agents == null || agents.length === 0` — same.
    const result = selectTandemPair('planning', 'claude', []);
    assert.ok(result !== null);
    assert.equal(result.lead, 'claude');
    assert.equal(result.follow, 'codex');
  });

  it('returns default pair when agents is null (no filter)', () => {
    // `!agents || agents.length === 0` where agents=null:
    // !null = true → short-circuit → returns default pair.
    const result = selectTandemPair('planning', 'claude', null);
    assert.ok(result, 'selectTandemPair with null agents must return a TandemPair');
    assert.equal(result.lead, 'claude');
    assert.equal(result.follow, 'codex');
  });

  it('returns null when exactly 1 agent is available (cannot form a tandem)', () => {
    // agents.length < 2 → returns null (this path is NOT affected by boolean rewrite)
    const result = selectTandemPair('planning', 'claude', ['claude']);
    assert.equal(result, null);
  });

  it('substitutes missing lead from available agents', () => {
    // codex (lead for testing) not available, should pick from gemini
    const result = selectTandemPair('testing', 'codex', ['gemini', 'claude']);
    assert.ok(result !== null);
    // testing pair: lead=codex, follow=gemini; codex not in list → swap lead
    assert.notEqual(result.lead, result.follow);
    assert.ok(['gemini', 'claude'].includes(result.lead));
    assert.ok(['gemini', 'claude'].includes(result.follow));
  });
});
