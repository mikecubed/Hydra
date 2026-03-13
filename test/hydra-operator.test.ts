/**
 * Characterization tests for lib/hydra-operator.ts
 *
 * hydra-operator.ts is the largest file in the codebase (~6630 lines). It is the
 * interactive REPL entry point and previously had no exports. These tests document
 * the behaviour of the pure utility functions that were extracted as exports so the
 * file can be safely split (rf-op01 through rf-op05).
 *
 * NOTE: The REPL loop (interactiveLoop / main) is NOT tested here — it requires TTY
 * mocking that belongs in integration tests. Only pure/near-pure exported helpers
 * are covered.
 *
 * NOTE: Importing hydra-operator.ts triggers resolveProject() at module scope which
 * reads package.json / .git from the cwd. Tests must run from a valid Hydra project
 * directory, which is the normal `npm test` invocation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  KNOWN_COMMANDS,
  SMART_TIER_MAP,
  formatUptime,
  fuzzyMatchCommand,
  getSelfAwarenessSummary,
  levenshtein,
  normalizeSimpleCommandText,
  parseSelfAwarenessPlaintextCommand,
} from '../lib/hydra-operator.ts';

// ── KNOWN_COMMANDS ─────────────────────────────────────────────────────────

describe('KNOWN_COMMANDS', () => {
  it('is a non-empty array', () => {
    assert.ok(Array.isArray(KNOWN_COMMANDS));
    assert.ok(KNOWN_COMMANDS.length > 0);
  });

  it('every entry starts with a colon', () => {
    for (const cmd of KNOWN_COMMANDS) {
      assert.ok(cmd.startsWith(':'), `Expected ':' prefix on "${cmd}"`);
    }
  });

  it('contains the core navigation commands', () => {
    const required = [':help', ':status', ':mode', ':model', ':quit', ':exit', ':agents'];
    for (const cmd of required) {
      assert.ok(KNOWN_COMMANDS.includes(cmd), `Missing command: ${cmd}`);
    }
  });

  it('has no duplicate entries', () => {
    const unique = new Set(KNOWN_COMMANDS);
    assert.equal(unique.size, KNOWN_COMMANDS.length);
  });
});

// ── SMART_TIER_MAP ──────────────────────────────────────────────────────────

describe('SMART_TIER_MAP', () => {
  it('maps the three complexity tiers to routing modes', () => {
    assert.equal(SMART_TIER_MAP.simple, 'economy');
    assert.equal(SMART_TIER_MAP.medium, 'balanced');
    assert.equal(SMART_TIER_MAP.complex, 'performance');
  });

  it('has exactly three entries', () => {
    assert.equal(Object.keys(SMART_TIER_MAP).length, 3);
  });
});

// ── formatUptime ────────────────────────────────────────────────────────────

describe('formatUptime', () => {
  it('returns seconds for durations under one minute', () => {
    assert.equal(formatUptime(0), '0s');
    assert.equal(formatUptime(1_000), '1s');
    assert.equal(formatUptime(59_000), '59s');
    assert.equal(formatUptime(59_999), '60s'); // rounds to 60s
  });

  it('returns minutes for durations between 1 and 60 minutes', () => {
    assert.equal(formatUptime(60_000), '1m');
    assert.equal(formatUptime(120_000), '2m');
    assert.equal(formatUptime(3_599_000), '60m');
  });

  it('returns hours for durations of one hour or more', () => {
    assert.equal(formatUptime(3_600_000), '1.0h');
    assert.equal(formatUptime(7_200_000), '2.0h');
    assert.equal(formatUptime(5_400_000), '1.5h');
  });
});

// ── levenshtein ─────────────────────────────────────────────────────────────

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    assert.equal(levenshtein('', ''), 0);
    assert.equal(levenshtein('abc', 'abc'), 0);
  });

  it('returns string length for empty-string comparison', () => {
    assert.equal(levenshtein('abc', ''), 3);
    assert.equal(levenshtein('', 'abc'), 3);
  });

  it('returns 1 for a single substitution', () => {
    assert.equal(levenshtein('abc', 'axc'), 1);
  });

  it('returns 1 for a single insertion', () => {
    assert.equal(levenshtein('ac', 'abc'), 1);
  });

  it('returns 1 for a single deletion', () => {
    assert.equal(levenshtein('abc', 'ac'), 1);
  });

  it('handles :help vs :hlep typo', () => {
    assert.equal(levenshtein(':help', ':hlep'), 2);
  });

  it('is symmetric', () => {
    assert.equal(levenshtein(':mode', ':mdoe'), levenshtein(':mdoe', ':mode'));
  });
});

// ── fuzzyMatchCommand ───────────────────────────────────────────────────────

describe('fuzzyMatchCommand', () => {
  it('returns exact match for a known command', () => {
    assert.equal(fuzzyMatchCommand(':help'), ':help');
    assert.equal(fuzzyMatchCommand(':status'), ':status');
    assert.equal(fuzzyMatchCommand(':mode'), ':mode');
  });

  it('returns close match for a one-character typo', () => {
    // :halp is 1 edit away from :help
    const result = fuzzyMatchCommand(':halp');
    assert.equal(result, ':help');
  });

  it('returns null when no command is close enough', () => {
    // Completely unrelated input — distance exceeds threshold of 3
    assert.equal(fuzzyMatchCommand(':xyzzy'), null);
  });

  it('prepends colon if the input lacks one', () => {
    // "help" → normalised to ":help" → matches :help
    assert.equal(fuzzyMatchCommand('help'), ':help');
  });

  it('returns a value from KNOWN_COMMANDS or null', () => {
    const result = fuzzyMatchCommand(':stat');
    assert.ok(result === null || KNOWN_COMMANDS.includes(result));
  });
});

// ── normalizeSimpleCommandText ──────────────────────────────────────────────

describe('normalizeSimpleCommandText', () => {
  it('lowercases input', () => {
    assert.equal(normalizeSimpleCommandText('Hello World'), 'hello world');
  });

  it('replaces non-word characters with spaces', () => {
    // comma and exclamation replaced, then spaces collapsed and trimmed
    assert.equal(normalizeSimpleCommandText('hello, world!'), 'hello world');
  });

  it('collapses multiple spaces', () => {
    assert.equal(normalizeSimpleCommandText('  foo   bar  '), 'foo bar');
  });

  it('returns empty string for empty input', () => {
    assert.equal(normalizeSimpleCommandText(''), '');
  });

  it('coerces non-string input to string', () => {
    assert.equal(normalizeSimpleCommandText(null), '');
    // eslint-disable-next-line unicorn/no-useless-undefined -- characterizing explicit-undefined behaviour
    assert.equal(normalizeSimpleCommandText(undefined), '');
    assert.equal(normalizeSimpleCommandText(42), '42');
  });
});

// ── parseSelfAwarenessPlaintextCommand ──────────────────────────────────────

describe('parseSelfAwarenessPlaintextCommand', () => {
  it('returns null for empty input', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand(''), null);
    assert.equal(parseSelfAwarenessPlaintextCommand(null), null);
  });

  it('returns null for colon-prefixed commands (handled elsewhere)', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand(':aware'), null);
  });

  it('returns null for bang-prefixed commands', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('!something'), null);
  });

  it('returns null for multi-line input', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('line1\nline2'), null);
  });

  it('returns null for input longer than 80 chars after normalisation', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('a'.repeat(81)), null);
  });

  it('detects "disable self-awareness" intent → "off"', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('disable self awareness'), 'off');
    assert.equal(parseSelfAwarenessPlaintextCommand('turn off hyper awareness'), 'off');
    assert.equal(parseSelfAwarenessPlaintextCommand('self awareness off'), 'off');
  });

  it('detects "enable self-awareness" intent → "on"', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('enable self awareness'), 'on');
    assert.equal(parseSelfAwarenessPlaintextCommand('turn on hyper awareness'), 'on');
    assert.equal(parseSelfAwarenessPlaintextCommand('self awareness on'), 'on');
  });

  it('detects "set to minimal" intent → "minimal"', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('set self awareness to minimal'), 'minimal');
    assert.equal(parseSelfAwarenessPlaintextCommand('hyper awareness minimal'), 'minimal');
  });

  it('detects "set to full" intent → "full"', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('set self awareness to full'), 'full');
    assert.equal(parseSelfAwarenessPlaintextCommand('hyper awareness full'), 'full');
  });

  it('detects status query → "status"', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('self awareness status'), 'status');
    assert.equal(parseSelfAwarenessPlaintextCommand('hyper awareness status'), 'status');
  });

  it('returns null for unrelated natural language', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('fix the auth bug'), null);
    assert.equal(parseSelfAwarenessPlaintextCommand('what time is it'), null);
  });
});

// ── getSelfAwarenessSummary ─────────────────────────────────────────────────

describe('getSelfAwarenessSummary', () => {
  it('returns full defaults when called with no arguments', () => {
    const summary = getSelfAwarenessSummary();
    assert.equal(summary.enabled, true);
    assert.equal(summary.includeSnapshot, true);
    assert.equal(summary.includeIndex, true);
    assert.equal(summary.level, 'full');
  });

  it('returns level "off" when enabled is false', () => {
    const summary = getSelfAwarenessSummary({ enabled: false });
    assert.equal(summary.enabled, false);
    assert.equal(summary.level, 'off');
  });

  it('returns level "minimal" when index is disabled but awareness is on', () => {
    const summary = getSelfAwarenessSummary({ enabled: true, includeIndex: false });
    assert.equal(summary.level, 'minimal');
    assert.equal(summary.enabled, true);
  });

  it('returns level "full" when both snapshot and index are enabled', () => {
    const summary = getSelfAwarenessSummary({ enabled: true, includeSnapshot: true, includeIndex: true });
    assert.equal(summary.level, 'full');
  });

  it('treats enabled:false as overriding index flag for level computation', () => {
    // Even if includeIndex is true, level should be "off" when disabled
    const summary = getSelfAwarenessSummary({ enabled: false, includeIndex: true });
    assert.equal(summary.level, 'off');
  });

  it('handles non-object input gracefully', () => {
    const summary = getSelfAwarenessSummary(null);
    assert.equal(typeof summary, 'object');
    assert.equal(summary.level, 'full'); // defaults kick in
  });

  it('returns an object with the expected shape', () => {
    const summary = getSelfAwarenessSummary({});
    assert.ok('enabled' in summary);
    assert.ok('includeSnapshot' in summary);
    assert.ok('includeIndex' in summary);
    assert.ok('level' in summary);
  });
});
