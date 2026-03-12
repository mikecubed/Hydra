/**
 * T5 safety tests — template expression safety (Priority 3)
 *
 * `@typescript-eslint/restrict-template-expressions` will force explicit
 * string conversion for non-string values inside template literals:
 *   `${someNumber}` → `${String(someNumber)}`
 *   `${someBoolean}` → `${String(someBoolean)}`
 *
 * These are semantically equivalent (implicit vs explicit toString), but the
 * tests below pin the exact string output so that any regression introduced
 * during the T6 conversion (e.g. wrapping with `JSON.stringify` by accident)
 * is caught immediately.
 *
 * The tests also cover the `short()` helper which is used throughout the
 * codebase to stringify arbitrary values in template expressions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { short, runId, parseTestOutput } from '../lib/hydra-utils.ts';
import { label, stripAnsi } from '../lib/hydra-ui.ts';

// ── short() — non-string type coercion ────────────────────────────────────────

describe('short — non-string input coercion (restrict-template-expressions)', () => {
  it('converts number to its decimal string representation', () => {
    assert.equal(short(0), '0');
    assert.equal(short(42), '42');
    assert.equal(short(-7), '-7');
    assert.equal(short(3.14), '3.14');
  });

  it('converts boolean true to "true"', () => {
    assert.equal(short(true), 'true');
  });

  it('converts boolean false to "false"', () => {
    assert.equal(short(false), 'false');
  });

  it('converts null to empty string (not "null")', () => {
    // `if (text == null) { raw = ''; }` — null maps to ''
    assert.equal(short(null), '');
  });

  it('converts undefined to empty string', () => {
    // undefined == null → true → raw = ''
    // `text` is typed `unknown` so passing `undefined` is valid.
    const undef: unknown = undefined;
    assert.equal(short(undef), '');
  });

  it('JSON-stringifies plain objects', () => {
    const result = short({ a: 1, b: 2 });
    assert.equal(result, '{"a":1,"b":2}');
  });

  it('JSON-stringifies arrays', () => {
    const result = short([1, 2, 3]);
    assert.equal(result, '[1,2,3]');
  });

  it('truncates long JSON objects with ellipsis', () => {
    const bigObj = { data: 'x'.repeat(400) };
    const result = short(bigObj, 50);
    assert.equal(result.length, 50);
    assert.ok(result.endsWith('...'));
  });
});

// ── runId() — empty prefix edge case ─────────────────────────────────────────

describe('runId — prefix parameter', () => {
  it('uses "HYDRA" as default prefix', () => {
    const id = runId();
    assert.ok(id.startsWith('HYDRA_'));
    assert.match(id, /^HYDRA_\d{8}_\d{6}$/);
  });

  it('uses custom prefix string', () => {
    const id = runId('TEST');
    assert.ok(id.startsWith('TEST_'));
    assert.match(id, /^TEST_\d{8}_\d{6}$/);
  });

  it('handles empty string prefix (falsy but valid)', () => {
    // runId uses `${prefix}_${...}` template — with empty prefix this
    // produces a string starting with '_'.
    // If the code had `prefix || 'HYDRA'` (||), empty string would use 'HYDRA'.
    // The function signature defaults to 'HYDRA' but accepts '' as explicit arg.
    const id = runId('');
    // Documents current behaviour: empty prefix produces '_YYYYMMDD_HHMMSS'
    assert.ok(typeof id === 'string');
    assert.ok(id.length > 0);
    assert.match(id, /^_\d{8}_\d{6}$/);
  });
});

// ── parseTestOutput() — summary string format (template literals with String()) ──

describe('parseTestOutput — summary template literals', () => {
  it('formats "N/M failed: name1, name2" when failures exist', () => {
    const stdout = [
      '# tests 5',
      '# pass 3',
      '# fail 2',
      'not ok 4 - first failed test',
      'not ok 5 - second failed test',
    ].join('\n');

    const result = parseTestOutput(stdout, '');
    // The summary uses `${String(failed)}/${String(total)} failed...`
    // With restrict-template-expressions the String() calls become explicit.
    assert.ok(result.summary.startsWith('2/5 failed'), `Unexpected summary: ${result.summary}`);
    assert.equal(result.failed, 2);
    assert.equal(result.total, 5);
  });

  it('formats "N/M passed" when all tests pass', () => {
    const stdout = ['# tests 10', '# pass 10', '# fail 0'].join('\n');

    const result = parseTestOutput(stdout, '');
    assert.equal(result.summary, '10/10 passed');
    assert.equal(result.failed, 0);
    assert.equal(result.passed, 10);
  });

  it('returns zero-counts and empty summary for empty input', () => {
    const result = parseTestOutput('', '');
    assert.equal(result.total, 0);
    assert.equal(result.passed, 0);
    assert.equal(result.failed, 0);
    assert.equal(result.summary, '');
  });

  it('derives total from pass+fail when only counters are present (no # tests line)', () => {
    const stdout = ['# pass 8', '# fail 1'].join('\n');
    const result = parseTestOutput(stdout, '');
    assert.equal(result.total, 9);
    assert.equal(result.passed, 8);
    assert.equal(result.failed, 1);
  });
});

// ── label() — template interpolation of non-string values ────────────────────

describe('label — template expression with non-string value types', () => {
  it('renders numeric value correctly in template', () => {
    // label uses `  ${k} ${value}` — with restrict-template-expressions
    // this would require explicit String(value) conversion.
    // The test pins that 0 becomes the string "0", not empty.
    const result = stripAnsi(label('retries', 0));
    assert.ok(result.includes('0'), `Numeric 0 must appear in: ${result}`);
    assert.ok(!result.includes('undefined'));
  });

  it('renders boolean value correctly in template', () => {
    const trueResult = stripAnsi(label('enabled', true));
    assert.ok(trueResult.includes('true'), `Boolean true must appear in: ${trueResult}`);

    const falseResult = stripAnsi(label('enabled', false));
    assert.ok(falseResult.includes('false'), `Boolean false must appear in: ${falseResult}`);
  });

  it('includes both key and value in the output', () => {
    const result = stripAnsi(label('mode', 'auto'));
    assert.ok(result.includes('mode:'));
    assert.ok(result.includes('auto'));
  });
});
