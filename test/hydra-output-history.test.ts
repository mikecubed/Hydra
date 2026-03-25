/**
 * Tests for hydra-output-history.ts — ring buffer capturing recent CLI output.
 *
 * Since initOutputHistory patches process.stdout/stderr globally and is idempotent
 * (only patches once), we test by:
 * 1. Calling initOutputHistory to install the interceptors
 * 2. Writing to stdout/stderr via process.stdout.write
 * 3. Reading back via getRecentOutput / getRecentOutputRaw / getOutputContext
 * 4. Clearing via clearOutputHistory
 *
 * IMPORTANT: These tests modify global process.stdout.write / process.stderr.write.
 * The patches persist for the process lifetime (by design). We use clearOutputHistory
 * between tests to isolate output.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  initOutputHistory,
  getRecentOutput,
  getRecentOutputRaw,
  clearOutputHistory,
  getOutputContext,
} from '../lib/hydra-output-history.ts';

// Initialize once for the entire test file (idempotent)
initOutputHistory({ maxLines: 50 });

// ── Helpers ─────────────────────────────────────────────────────────────────

function writeToStdout(text: string): void {
  process.stdout.write(text);
}

function writeToStderr(text: string): void {
  process.stderr.write(text);
}

// ── getOutputContext ─────────────────────────────────────────────────────────

describe('getOutputContext', () => {
  beforeEach(() => {
    clearOutputHistory();
  });

  it('returns "(no recent output)" when buffer is empty', () => {
    const ctx = getOutputContext();
    assert.equal(ctx, '(no recent output)');
  });

  it('returns joined lines after writing to stdout', () => {
    writeToStdout('hello world\n');
    const ctx = getOutputContext();
    assert.ok(ctx.includes('hello world'), `expected "hello world" in: ${ctx}`);
  });
});

// ── getRecentOutput (ANSI-stripped) ─────────────────────────────────────────

describe('getRecentOutput', () => {
  beforeEach(() => {
    clearOutputHistory();
  });

  it('returns empty array when buffer is empty', () => {
    const lines = getRecentOutput();
    assert.deepEqual(lines, []);
  });

  it('captures stdout lines', () => {
    writeToStdout('line one\nline two\n');
    const lines = getRecentOutput();
    assert.ok(lines.length >= 2);
    assert.ok(lines.some((l) => l.includes('line one')));
    assert.ok(lines.some((l) => l.includes('line two')));
  });

  it('captures stderr lines', () => {
    writeToStderr('error output\n');
    const lines = getRecentOutput();
    assert.ok(lines.some((l) => l.includes('error output')));
  });

  it('strips ANSI escape codes', () => {
    writeToStdout('\x1b[31mred text\x1b[0m\n');
    const lines = getRecentOutput();
    assert.ok(lines.some((l) => l.includes('red text')));
    // Should NOT contain the escape sequence
    for (const line of lines) {
      if (line.includes('red text')) {
        assert.ok(!line.includes('\x1b['), `ANSI not stripped: ${JSON.stringify(line)}`);
      }
    }
  });

  it('respects n parameter to limit returned lines', () => {
    for (let i = 0; i < 10; i++) {
      writeToStdout(`numbered line ${String(i)}\n`);
    }
    const last3 = getRecentOutput(3);
    assert.ok(last3.length <= 3, `expected at most 3 lines, got ${String(last3.length)}`);
  });
});

// ── getRecentOutputRaw (with ANSI) ──────────────────────────────────────────

describe('getRecentOutputRaw', () => {
  beforeEach(() => {
    clearOutputHistory();
  });

  it('returns empty array when buffer is empty', () => {
    const lines = getRecentOutputRaw();
    assert.deepEqual(lines, []);
  });

  it('preserves ANSI escape codes', () => {
    writeToStdout('\x1b[32mgreen text\x1b[0m\n');
    const lines = getRecentOutputRaw();
    // Raw output should contain the escape sequences
    const greenLine = lines.find((l) => l.includes('green text'));
    assert.ok(greenLine, 'should capture the green text line');
    assert.ok(
      greenLine.includes('\x1b[32m') || greenLine.includes('\x1b[0m'),
      `expected ANSI codes in raw output: ${JSON.stringify(greenLine)}`,
    );
  });
});

// ── clearOutputHistory ──────────────────────────────────────────────────────

describe('clearOutputHistory', () => {
  it('empties the buffer', () => {
    writeToStdout('before clear\n');
    assert.ok(getRecentOutput().length > 0);
    clearOutputHistory();
    assert.deepEqual(getRecentOutput(), []);
  });

  it('context returns "(no recent output)" after clear', () => {
    writeToStdout('some data\n');
    clearOutputHistory();
    assert.equal(getOutputContext(), '(no recent output)');
  });
});

// ── Status bar filtering ────────────────────────────────────────────────────

describe('status bar filtering', () => {
  beforeEach(() => {
    clearOutputHistory();
  });

  it('filters out scroll region escape sequences', () => {
    // Scroll region set: ESC[1;24r
    writeToStdout('\x1b[1;24rscroll region content\n');
    const lines = getRecentOutput();
    // The entire chunk should be filtered since it starts with a scroll region escape
    assert.ok(
      !lines.some((l) => l.includes('scroll region content')),
      'scroll region lines should be filtered',
    );
  });

  it('filters out cursor save/restore sequences', () => {
    writeToStdout('\x1b[sstatus bar text\n');
    const lines = getRecentOutput();
    assert.ok(
      !lines.some((l) => l.includes('status bar text')),
      'cursor save lines should be filtered',
    );
  });
});

// ── Partial line handling ───────────────────────────────────────────────────

describe('partial line handling', () => {
  beforeEach(() => {
    clearOutputHistory();
  });

  it('accumulates partial lines until newline', () => {
    writeToStdout('partial');
    // No newline yet — should not appear in output
    const linesBefore = getRecentOutput();
    assert.ok(
      !linesBefore.some((l) => l.includes('partial')),
      'partial line should not appear yet',
    );

    // Complete the line
    writeToStdout(' complete\n');
    const linesAfter = getRecentOutput();
    assert.ok(
      linesAfter.some((l) => l.includes('partial complete')),
      'completed line should appear',
    );
  });
});

// ── Ring buffer overflow ────────────────────────────────────────────────────

describe('ring buffer overflow', () => {
  beforeEach(() => {
    clearOutputHistory();
  });

  it('limits buffer to maxLines', () => {
    // We initialized with maxLines: 50
    for (let i = 0; i < 100; i++) {
      writeToStdout(`overflow line ${String(i)}\n`);
    }
    const lines = getRecentOutput();
    assert.ok(lines.length <= 50, `expected at most 50 lines, got ${String(lines.length)}`);
  });
});

// ── initOutputHistory idempotency ───────────────────────────────────────────

describe('initOutputHistory — idempotency', () => {
  it('calling initOutputHistory again does not double-patch', () => {
    // Should not throw and should not duplicate interception
    initOutputHistory({ maxLines: 100 });
    clearOutputHistory();
    writeToStdout('after re-init\n');
    const lines = getRecentOutput();
    // Should only appear once (not duplicated)
    const matches = lines.filter((l) => l.includes('after re-init'));
    assert.equal(matches.length, 1, 'line should appear exactly once');
  });
});
