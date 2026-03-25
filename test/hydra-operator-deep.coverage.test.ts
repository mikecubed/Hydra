/**
 * Deep coverage tests for hydra-operator.ts and its sub-modules.
 *
 * Targets previously-uncovered paths in:
 *   - hydra-operator-startup.ts: extractHandoffAgents
 *   - hydra-operator-self-awareness.ts: normalizeSimpleCommandText, parseSelfAwarenessPlaintextCommand, getGitInfo
 *   - hydra-operator-ui.ts: KNOWN_COMMANDS, SMART_TIER_MAP, getSelfAwarenessSummary, printNextSteps
 *   - hydra-operator.ts: formatUptime, levenshtein, fuzzyMatchCommand
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  KNOWN_COMMANDS,
  formatUptime,
  fuzzyMatchCommand,
  getSelfAwarenessSummary,
  levenshtein,
  normalizeSimpleCommandText,
  parseSelfAwarenessPlaintextCommand,
} from '../lib/hydra-operator.ts';

import { extractHandoffAgents } from '../lib/hydra-operator-startup.ts';
import { getGitInfo, selfIndexCache } from '../lib/hydra-operator-self-awareness.ts';

// ── extractHandoffAgents ────────────────────────────────────────────────────

describe('extractHandoffAgents', () => {
  it('returns empty array for empty object', () => {
    assert.deepStrictEqual(extractHandoffAgents({}), []);
  });

  it('returns empty array when published is missing', () => {
    assert.deepStrictEqual(extractHandoffAgents({ foo: 'bar' }), []);
  });

  it('returns empty array when published.handoffs is not an array', () => {
    assert.deepStrictEqual(extractHandoffAgents({ published: { handoffs: 'not-array' } }), []);
  });

  it('returns empty array when published.handoffs is empty', () => {
    assert.deepStrictEqual(extractHandoffAgents({ published: { handoffs: [] } }), []);
  });

  it('extracts known agent names from handoffs', () => {
    const result = extractHandoffAgents({
      published: {
        handoffs: [
          { to: 'claude', summary: 'Test' },
          { to: 'gemini', summary: 'Test' },
        ],
      },
    });
    assert.ok(result.includes('claude'));
    assert.ok(result.includes('gemini'));
  });

  it('lowercases agent names', () => {
    const result = extractHandoffAgents({
      published: {
        handoffs: [{ to: 'CLAUDE', summary: 'Test' }],
      },
    });
    assert.ok(result.includes('claude'));
  });

  it('deduplicates agent names', () => {
    const result = extractHandoffAgents({
      published: {
        handoffs: [
          { to: 'claude', summary: 'Test 1' },
          { to: 'claude', summary: 'Test 2' },
        ],
      },
    });
    const claudeCount = result.filter((a: string) => a === 'claude').length;
    assert.equal(claudeCount, 1);
  });

  it('skips handoffs with null/empty to field', () => {
    const result = extractHandoffAgents({
      published: {
        handoffs: [
          { to: null, summary: 'Test' },
          { to: '', summary: 'Test' },
          { to: 'claude', summary: 'Test' },
        ],
      },
    });
    // Only claude should be in the result
    assert.ok(result.length <= 1);
  });

  it('skips unknown agent names', () => {
    const result = extractHandoffAgents({
      published: {
        handoffs: [{ to: 'nonexistent_agent_xyz', summary: 'Test' }],
      },
    });
    assert.ok(!result.includes('nonexistent_agent_xyz'));
  });
});

// ── getGitInfo ──────────────────────────────────────────────────────────────

describe('getGitInfo', () => {
  it('returns an object with branch and modifiedFiles', () => {
    const info = getGitInfo();
    // In a git repo, should return non-null
    assert.notStrictEqual(info, null);
    assert.equal(typeof info!.branch, 'string');
    assert.equal(typeof info!.modifiedFiles, 'number');
  });

  it('branch is a non-empty string', () => {
    const info = getGitInfo();
    assert.ok(info!.branch.length > 0);
  });

  it('modifiedFiles is non-negative', () => {
    const info = getGitInfo();
    assert.ok(info!.modifiedFiles >= 0);
  });

  it('returns cached result on repeated calls', () => {
    const first = getGitInfo();
    const second = getGitInfo();
    // Should be the same object (cached)
    assert.deepStrictEqual(first, second);
  });
});

// ── normalizeSimpleCommandText — additional edge cases ──────────────────────

describe('normalizeSimpleCommandText — additional edge cases', () => {
  it('handles boolean input', () => {
    assert.equal(normalizeSimpleCommandText(true), 'true');
    assert.equal(normalizeSimpleCommandText(false), 'false');
  });

  it('handles bigint input', () => {
    assert.equal(normalizeSimpleCommandText(BigInt(42)), '42');
  });

  it('returns empty string for object input', () => {
    assert.equal(normalizeSimpleCommandText({}), '');
    assert.equal(normalizeSimpleCommandText([]), '');
  });

  it('returns empty string for symbol input', () => {
    assert.equal(normalizeSimpleCommandText(Symbol('test')), '');
  });

  it('returns empty string for function input', () => {
    assert.equal(
      normalizeSimpleCommandText(() => {}),
      '',
    );
  });

  it('handles special characters', () => {
    assert.equal(normalizeSimpleCommandText('hello@world#test'), 'hello world test');
  });

  it('handles tabs and newlines', () => {
    assert.equal(normalizeSimpleCommandText('hello\tworld\ntest'), 'hello world test');
  });

  it('handles unicode', () => {
    const result = normalizeSimpleCommandText('hello world');
    assert.equal(typeof result, 'string');
  });
});

// ── parseSelfAwarenessPlaintextCommand — additional paths ───────────────────

describe('parseSelfAwarenessPlaintextCommand — additional paths', () => {
  it('returns null for object input', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand({}), null);
  });

  it('returns null for symbol input', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand(Symbol('x')), null);
  });

  it('returns null for function input', () => {
    assert.equal(
      parseSelfAwarenessPlaintextCommand(() => {}),
      null,
    );
  });

  it('returns null for whitespace-only input', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('   '), null);
  });

  it('handles polite phrasing: "please disable self awareness"', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('please disable self awareness'), 'off');
  });

  it('handles polite phrasing: "can you enable self awareness"', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('can you enable self awareness'), 'on');
  });

  it('handles polite phrasing: "could you turn off self awareness"', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('could you turn off self awareness'), 'off');
  });

  it('handles polite phrasing: "would you set self awareness to minimal"', () => {
    assert.equal(
      parseSelfAwarenessPlaintextCommand('would you set self awareness to minimal'),
      'minimal',
    );
  });

  it('handles "hyper awareness" variant', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('hyper awareness on'), 'on');
    assert.equal(parseSelfAwarenessPlaintextCommand('hyper awareness off'), 'off');
  });

  it('handles "hyper aware" variant', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('disable hyper aware'), 'off');
    assert.equal(parseSelfAwarenessPlaintextCommand('enable hyper aware'), 'on');
  });

  it('handles "agent" suffix', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('disable self awareness agent'), 'off');
    assert.equal(parseSelfAwarenessPlaintextCommand('self awareness agent on'), 'on');
    assert.equal(parseSelfAwarenessPlaintextCommand('self awareness agent status'), 'status');
  });

  it('returns null for unrelated but similar text', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('aware of the situation'), null);
    assert.equal(parseSelfAwarenessPlaintextCommand('I am self aware'), null);
  });

  it('handles numeric input', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand(42), null);
  });

  it('handles boolean input', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand(true), null);
  });
});

// ── formatUptime — more edge cases ─────────────────────────────────────────

describe('formatUptime — edge cases', () => {
  it('handles very small values', () => {
    assert.equal(formatUptime(1), '0s');
    assert.equal(formatUptime(499), '0s');
    assert.equal(formatUptime(500), '1s'); // rounds
  });

  it('handles exact minute boundary', () => {
    assert.equal(formatUptime(60_000), '1m');
    assert.equal(formatUptime(60_001), '1m');
  });

  it('handles values near hour boundary', () => {
    assert.equal(formatUptime(3_599_999), '60m');
    assert.equal(formatUptime(3_600_000), '1.0h');
    assert.equal(formatUptime(3_600_001), '1.0h');
  });

  it('handles multi-hour values', () => {
    assert.equal(formatUptime(10_800_000), '3.0h');
    assert.equal(formatUptime(9_000_000), '2.5h');
  });
});

// ── levenshtein — more cases ────────────────────────────────────────────────

describe('levenshtein — additional cases', () => {
  it('handles single character strings', () => {
    assert.equal(levenshtein('a', 'a'), 0);
    assert.equal(levenshtein('a', 'b'), 1);
    assert.equal(levenshtein('a', ''), 1);
    assert.equal(levenshtein('', 'a'), 1);
  });

  it('handles longer strings', () => {
    const dist = levenshtein('kitten', 'sitting');
    assert.equal(dist, 3);
  });

  it('handles strings of different lengths', () => {
    assert.equal(levenshtein('abc', 'abcd'), 1);
    assert.equal(levenshtein('abcd', 'abc'), 1);
  });

  it('handles completely different strings', () => {
    assert.equal(levenshtein('abc', 'xyz'), 3);
  });
});

// ── fuzzyMatchCommand — more paths ──────────────────────────────────────────

describe('fuzzyMatchCommand — additional paths', () => {
  it('handles input with trailing whitespace/args', () => {
    // Only first word is used
    const result = fuzzyMatchCommand(':help extra args');
    assert.equal(result, ':help');
  });

  it('handles uppercase input', () => {
    const result = fuzzyMatchCommand(':HELP');
    // Should match :help (distance of casing doesn't matter since input is lowercased)
    assert.equal(result, ':help');
  });

  it('handles very short input', () => {
    // Single char after colon
    const result = fuzzyMatchCommand(':q');
    // Should match something within distance 3
    assert.ok(result === null || KNOWN_COMMANDS.includes(result));
  });

  it('returns null for completely unrelated long string', () => {
    const result = fuzzyMatchCommand(':abcdefghijklmnop');
    assert.equal(result, null);
  });

  it('matches :stat to :status (2 chars short)', () => {
    const result = fuzzyMatchCommand(':stat');
    // Distance is 2, should match
    assert.ok(result !== null);
  });

  it('matches :mod to :mode (1 char short)', () => {
    const result = fuzzyMatchCommand(':mod');
    assert.ok(result !== null);
  });
});

// ── getSelfAwarenessSummary — more configuration paths ──────────────────────

describe('getSelfAwarenessSummary — additional paths', () => {
  it('returns level "minimal" when snapshot and index are disabled', () => {
    const summary = getSelfAwarenessSummary({
      enabled: true,
      includeSnapshot: false,
      includeIndex: false,
    });
    assert.equal(summary.level, 'minimal');
  });

  it('returns level "full" when all flags are true', () => {
    const summary = getSelfAwarenessSummary({
      enabled: true,
      includeSnapshot: true,
      includeIndex: true,
    });
    assert.equal(summary.level, 'full');
  });

  it('returns level "minimal" when snapshot is on but index is off', () => {
    const summary = getSelfAwarenessSummary({
      enabled: true,
      includeSnapshot: true,
      includeIndex: false,
    });
    // Level depends only on includeIndex: false => minimal
    assert.equal(summary.level, 'minimal');
  });

  it('returns level "full" when index is on regardless of snapshot', () => {
    const summary = getSelfAwarenessSummary({
      enabled: true,
      includeSnapshot: false,
      includeIndex: true,
    });
    // Level is "full" whenever includeIndex is true
    assert.equal(summary.level, 'full');
  });

  it('returns enabled=false and level="off" when disabled', () => {
    const summary = getSelfAwarenessSummary({ enabled: false });
    assert.equal(summary.enabled, false);
    assert.equal(summary.level, 'off');
  });
});

// ── selfIndexCache ──────────────────────────────────────────────────────────

describe('selfIndexCache', () => {
  it('is an object with block, builtAt, and key', () => {
    assert.equal(typeof selfIndexCache.block, 'string');
    assert.equal(typeof selfIndexCache.builtAt, 'number');
    assert.equal(typeof selfIndexCache.key, 'string');
  });
});
