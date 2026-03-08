/**
 * Tests for spawnSyncCapture — including the file-backed stdio fallback path
 * activated by HYDRA_NO_PIPES=1 (or when the first spawn returns EPERM).
 *
 * NOTE: The runProcess tests in hydra-utils.test.mjs can fail in sandboxed or
 * pipe-restricted environments (e.g. certain CI setups or AI coding agents) where
 * spawning child processes with stdio: 'pipe' returns EPERM. This is expected
 * behaviour. Run with HYDRA_NO_PIPES=1 to exercise the file-backed fallback path.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSyncCapture } from '../lib/hydra-proc.mjs';

// ── helpers ──────────────────────────────────────────────────────────────────

function withNoPipes(fn) {
  const prev = process.env.HYDRA_NO_PIPES;
  process.env.HYDRA_NO_PIPES = '1';
  try {
    return fn();
  } finally {
    if (prev === undefined) {
      delete process.env.HYDRA_NO_PIPES;
    } else {
      process.env.HYDRA_NO_PIPES = prev;
    }
  }
}

// ── pipe path (normal) ───────────────────────────────────────────────────────

describe('spawnSyncCapture (pipe path)', () => {
  it('captures stdout', () => {
    const r = spawnSyncCapture(process.execPath, ['-e', "console.log('hello-pipe')"], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('hello-pipe'));
  });

  it('captures stderr', () => {
    const r = spawnSyncCapture(process.execPath, ['-e', "console.error('err-pipe')"], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.ok(r.stderr.includes('err-pipe'));
  });

  it('returns non-zero status', () => {
    const r = spawnSyncCapture(process.execPath, ['-e', 'process.exit(7)'], { encoding: 'utf8' });
    assert.equal(r.status, 7);
  });

  it('passes stdin input', () => {
    const r = spawnSyncCapture(
      process.execPath,
      ['-e', "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(d.trim()))"],
      { encoding: 'utf8', input: 'pipe-stdin' },
    );
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('pipe-stdin'));
  });
});

// ── file-backed fallback path (HYDRA_NO_PIPES=1) ─────────────────────────────

describe('spawnSyncCapture (file-backed fallback, HYDRA_NO_PIPES=1)', () => {
  it('captures stdout via temp files', () => {
    const r = withNoPipes(() =>
      spawnSyncCapture(process.execPath, ['-e', "console.log('hello-nopipes')"], { encoding: 'utf8' }),
    );
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('hello-nopipes'));
  });

  it('captures stderr via temp files', () => {
    const r = withNoPipes(() =>
      spawnSyncCapture(process.execPath, ['-e', "console.error('err-nopipes')"], { encoding: 'utf8' }),
    );
    assert.equal(r.status, 0);
    assert.ok(r.stderr.includes('err-nopipes'));
  });

  it('returns non-zero status', () => {
    const r = withNoPipes(() =>
      spawnSyncCapture(process.execPath, ['-e', 'process.exit(3)'], { encoding: 'utf8' }),
    );
    assert.equal(r.status, 3);
  });

  it('passes stdin input via temp file', () => {
    const r = withNoPipes(() =>
      spawnSyncCapture(
        process.execPath,
        ['-e', "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(d.trim()))"],
        { encoding: 'utf8', input: 'nopipes-stdin' },
      ),
    );
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('nopipes-stdin'));
  });

  it('noPipes option also forces file-backed fallback', () => {
    const r = spawnSyncCapture(process.execPath, ['-e', "console.log('opt-nopipes')"], {
      encoding: 'utf8',
      noPipes: true,
    });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('opt-nopipes'));
  });
});
