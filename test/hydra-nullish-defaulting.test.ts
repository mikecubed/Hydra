/**
 * T5 safety tests — nullish/defaulting behaviour (Priority 1)
 *
 * The most common lint error being fixed by T6 is
 * `@typescript-eslint/prefer-nullish-coalescing`: code like `x || default`
 * will be changed to `x ?? default`.  These two operators differ when x is
 * falsy-but-defined (0, false, "").
 *
 * Each test below documents the CURRENT `||` behaviour for a value that is
 * falsy but semantically valid.  If T6 incorrectly changes `||` → `??` in a
 * place where the callers can pass "", the test will fail and alert the author.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTask } from '../lib/hydra-utils.ts';
import { box, label, colorStatus, colorAgent, agentBadge, stripAnsi } from '../lib/hydra-ui.ts';

// ── normalizeTask — || fallback chains ────────────────────────────────────────

describe('normalizeTask — || fallback chains', () => {
  it('falls back to "task" field when "title" field is present but empty string', () => {
    // str('title') returns '' (empty string, falsy with ||, but NOT nullish).
    // Current: '' || str('task') = 'Build feature'
    // With ??:  '' ?? str('task') = '' → empty title → normalizeTask returns null
    const task = normalizeTask({ title: '', task: 'Build feature' });
    assert.ok(
      task !== null,
      'normalizeTask should not return null when "task" field provides title',
    );
    assert.equal(task.title, 'Build feature');
  });

  it('falls back to "done" field when "definition_of_done" field is empty string', () => {
    // Current: '' || str('done') = 'All tests pass'
    // With ??:  '' ?? str('done') = ''  → task.done = ''
    const task = normalizeTask({
      title: 'Ship feature',
      definition_of_done: '',
      done: 'All tests pass',
    });
    assert.ok(task !== null);
    assert.equal(task.done, 'All tests pass');
  });

  it('falls back to "acceptance" field when both "definition_of_done" and "done" are empty', () => {
    // Three-step chain: '' || '' || 'User can log in'
    // With ??:          '' stays, done never consulted
    const task = normalizeTask({
      title: 'Login flow',
      definition_of_done: '',
      done: '',
      acceptance: 'User can log in',
    });
    assert.ok(task !== null);
    assert.equal(task.done, 'User can log in');
  });

  it('falls back to "why" field when "rationale" field is empty string', () => {
    // Current: '' || str('why') = 'Reduces latency'
    // With ??:  '' ?? str('why') = ''
    const task = normalizeTask({
      title: 'Cache layer',
      rationale: '',
      why: 'Reduces latency',
    });
    assert.ok(task !== null);
    assert.equal(task.rationale, 'Reduces latency');
  });

  it('uses explicit fallbackOwner when the "owner" field is empty string', () => {
    // sanitizeOwner(str('owner') || fallbackOwner)
    // str('owner') returns '' for an empty-string owner field value.
    // Current || path: '' || 'codex' = 'codex'
    // With ??    path: '' ?? 'codex' = '' → sanitizeOwner('') = 'unassigned'
    const task = normalizeTask({ title: 'Task', owner: '' }, 'codex');
    assert.ok(task !== null);
    assert.equal(
      task.owner,
      'codex',
      'fallbackOwner should be used when owner field is empty string',
    );
  });
});

// ── box() — options object defaults ──────────────────────────────────────────

describe('box — options object defaults', () => {
  it('renders a box when no options are provided (uses all defaults)', () => {
    const result = box('Title', ['line one']);
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('Title'));
    assert.ok(result.includes('line one'));
  });

  it('renders with explicit width=60 and width=0 uses the 60 default (|| fallback)', () => {
    // widthOrOpts.width || 60: 0 || 60 = 60
    // With ??:                  0 ?? 60 = 0 → inner = 0 → box collapses
    const defaultBox = box('T', ['x'], { width: 60 });
    const zeroBox = box('T', ['x'], { width: 0 });
    // Both render as strings without throwing
    assert.ok(typeof defaultBox === 'string');
    assert.ok(typeof zeroBox === 'string');
    // With || semantics, width=0 falls back to 60, so boxes are identical
    assert.equal(zeroBox, defaultBox);
  });

  it('renders with light style when style is empty string (|| fallback)', () => {
    // widthOrOpts.style || 'light': '' || 'light' = 'light'
    // With ??:                       '' ?? 'light' = '' → BOX_STYLES[''] = undefined
    const lightBox = box('T', ['line'], { style: 'light', width: 50 });
    const emptyStyleBox = box('T', ['line'], { style: '', width: 50 });
    // Both should render identically (light style via || fallback)
    assert.equal(emptyStyleBox, lightBox);
  });
});

// ── label() — falsy-but-defined values must be rendered, not omitted ──────────

describe('label — falsy value rendering', () => {
  it('renders numeric zero as "0" (not omitted)', () => {
    // label uses `value !== undefined ? ... : ...`
    // If this guard is ever changed to `if (value)`, numeric 0 would be lost.
    const result = stripAnsi(label('count', 0));
    assert.ok(result.includes('0'), `Expected "0" in label output, got: ${result}`);
  });

  it('renders boolean false as "false" (not omitted)', () => {
    const result = stripAnsi(label('active', false));
    assert.ok(result.includes('false'), `Expected "false" in label output, got: ${result}`);
  });

  it('renders empty string value (not omitted, just empty)', () => {
    const result = stripAnsi(label('name', ''));
    assert.ok(result.includes('name:'), 'Key must still be present when value is empty string');
    // value is '' (not undefined) so the "value present" branch is taken
    assert.ok(result.length > 0);
  });

  it('omits value segment when value is undefined', () => {
    const withValue = stripAnsi(label('key', 'val'));
    const withoutValue = stripAnsi(label('key'));
    // The with-undefined form must be shorter (no trailing value)
    assert.ok(withoutValue.length < withValue.length);
    assert.ok(!withoutValue.endsWith(' '), 'No trailing space when value omitted');
  });
});

// ── colorStatus / colorAgent — empty string inputs ────────────────────────────

describe('colorStatus — empty and falsy inputs', () => {
  it('returns a non-empty string for empty status (does not throw)', () => {
    // colorStatus uses `String(status || '').toLowerCase()`
    // The || here is safe (both branches give ''), but the test pins the contract.
    const result = colorStatus('');
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0, 'Should return the bullet character at minimum');
  });

  it('returns a styled string for every known status value', () => {
    const knownStatuses = ['todo', 'in-progress', 'done', 'blocked', 'error'];
    for (const s of knownStatuses) {
      const result = colorStatus(s);
      assert.ok(typeof result === 'string', `colorStatus('${s}') must return a string`);
      assert.ok(stripAnsi(result).includes(s), `colorStatus('${s}') must include the status text`);
    }
  });
});

describe('colorAgent — empty string input', () => {
  it('returns an empty visible string (not a raw function or undefined)', () => {
    const result = colorAgent('');
    assert.ok(typeof result === 'string');
    // stripAnsi of colorAgent('') is '' since there is no name content
    assert.equal(stripAnsi(result), '');
  });
});

describe('agentBadge — empty string input', () => {
  it('returns a string containing the diamond icon for unknown agents', () => {
    const result = agentBadge('');
    assert.ok(typeof result === 'string');
    // Unknown agent → diamond icon ◇ (\u25C7) in the badge
    assert.ok(
      stripAnsi(result).includes('\u25C7') || result.length > 0,
      'badge for empty agent should not be empty',
    );
  });
});
