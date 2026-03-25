/**
 * Tests for lib/hydra-resume-scanner.ts
 *
 * Covers:
 *   - scanResumableState — with mocked external dependencies
 *   - Item builders tested via scanResumableState with controlled inputs
 *   - Error resilience — individual scanner failures don't crash the whole scan
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { scanResumableState } from '../lib/hydra-resume-scanner.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-resume-test-'));
}

function cleanupDir(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

// ── scanResumableState ──────────────────────────────────────────────────────

describe('scanResumableState', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
    mock.restoreAll();
  });

  it('returns empty array when no resumable state exists', async () => {
    // No daemon, no evolve session, no council checkpoints, no branches, no suggestions
    const items = await scanResumableState({
      baseUrl: '', // empty = scanDaemon returns null
      projectRoot: tmpDir,
    });
    assert.ok(Array.isArray(items));
    assert.equal(items.length, 0);
  });

  it('finds evolve session state when resumable', async () => {
    const evolveDir = path.join(tmpDir, 'docs', 'coordination', 'evolve');
    fs.mkdirSync(evolveDir, { recursive: true });
    const sessionState = {
      resumable: true,
      status: 'partial',
      completedRounds: [1, 2],
      maxRounds: 5,
      actionNeeded: 'continue from round 3',
      sessionId: 'test-session-123',
    };
    fs.writeFileSync(
      path.join(evolveDir, 'EVOLVE_SESSION_STATE.json'),
      JSON.stringify(sessionState),
      'utf8',
    );

    const items = await scanResumableState({
      baseUrl: '',
      projectRoot: tmpDir,
    });

    const evolveItems = items.filter((i) => i.source === 'evolve');
    assert.equal(evolveItems.length, 1);
    assert.ok(evolveItems[0].label.includes('2/5'));
    assert.equal(evolveItems[0].hint, 'continue from round 3');
    assert.equal(evolveItems[0].value, 'evolve');
    assert.equal(evolveItems[0].detail, 'test-session-123');
  });

  it('skips evolve session when resumable is false', async () => {
    const evolveDir = path.join(tmpDir, 'docs', 'coordination', 'evolve');
    fs.mkdirSync(evolveDir, { recursive: true });
    fs.writeFileSync(
      path.join(evolveDir, 'EVOLVE_SESSION_STATE.json'),
      JSON.stringify({ resumable: false, status: 'partial' }),
      'utf8',
    );

    const items = await scanResumableState({ baseUrl: '', projectRoot: tmpDir });
    const evolveItems = items.filter((i) => i.source === 'evolve');
    assert.equal(evolveItems.length, 0);
  });

  it('skips evolve session when status is "completed"', async () => {
    const evolveDir = path.join(tmpDir, 'docs', 'coordination', 'evolve');
    fs.mkdirSync(evolveDir, { recursive: true });
    fs.writeFileSync(
      path.join(evolveDir, 'EVOLVE_SESSION_STATE.json'),
      JSON.stringify({ resumable: true, status: 'completed' }),
      'utf8',
    );

    const items = await scanResumableState({ baseUrl: '', projectRoot: tmpDir });
    const evolveItems = items.filter((i) => i.source === 'evolve');
    assert.equal(evolveItems.length, 0);
  });

  it('handles evolve session with status "failed"', async () => {
    const evolveDir = path.join(tmpDir, 'docs', 'coordination', 'evolve');
    fs.mkdirSync(evolveDir, { recursive: true });
    fs.writeFileSync(
      path.join(evolveDir, 'EVOLVE_SESSION_STATE.json'),
      JSON.stringify({ resumable: true, status: 'failed', completedRounds: [], maxRounds: 3 }),
      'utf8',
    );

    const items = await scanResumableState({ baseUrl: '', projectRoot: tmpDir });
    const evolveItems = items.filter((i) => i.source === 'evolve');
    assert.equal(evolveItems.length, 1);
    assert.ok(evolveItems[0].label.includes('0/3'));
  });

  it('handles evolve session with status "interrupted"', async () => {
    const evolveDir = path.join(tmpDir, 'docs', 'coordination', 'evolve');
    fs.mkdirSync(evolveDir, { recursive: true });
    fs.writeFileSync(
      path.join(evolveDir, 'EVOLVE_SESSION_STATE.json'),
      JSON.stringify({ resumable: true, status: 'interrupted' }),
      'utf8',
    );

    const items = await scanResumableState({ baseUrl: '', projectRoot: tmpDir });
    const evolveItems = items.filter((i) => i.source === 'evolve');
    assert.equal(evolveItems.length, 1);
  });

  it('finds council checkpoint files', async () => {
    const coordDir = path.join(tmpDir, 'docs', 'coordination');
    fs.mkdirSync(coordDir, { recursive: true });
    const checkpointData = { prompt: 'test prompt for council', phase: 'deliberate' };
    fs.writeFileSync(
      path.join(coordDir, 'COUNCIL_CHECKPOINT_abc123.json'),
      JSON.stringify(checkpointData),
      'utf8',
    );

    const items = await scanResumableState({ baseUrl: '', projectRoot: tmpDir });
    const councilItems = items.filter((i) => i.source === 'council');
    assert.equal(councilItems.length, 1);
    assert.ok(councilItems[0].label.includes('test prompt for council'));
    assert.equal(councilItems[0].hint, 'Phase: deliberate');
    assert.equal(councilItems[0].value, 'council:abc123');
  });

  it('limits council checkpoints to 3', async () => {
    const coordDir = path.join(tmpDir, 'docs', 'coordination');
    fs.mkdirSync(coordDir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(
        path.join(coordDir, `COUNCIL_CHECKPOINT_cp${String(i)}.json`),
        JSON.stringify({ prompt: `prompt ${String(i)}`, phase: 'research' }),
        'utf8',
      );
    }

    const items = await scanResumableState({ baseUrl: '', projectRoot: tmpDir });
    const councilItems = items.filter((i) => i.source === 'council');
    assert.ok(councilItems.length <= 3);
  });

  it('skips malformed council checkpoint JSON', async () => {
    const coordDir = path.join(tmpDir, 'docs', 'coordination');
    fs.mkdirSync(coordDir, { recursive: true });
    // Write a valid checkpoint
    fs.writeFileSync(
      path.join(coordDir, 'COUNCIL_CHECKPOINT_good.json'),
      JSON.stringify({ prompt: 'valid', phase: 'test' }),
      'utf8',
    );
    // Write a malformed checkpoint
    fs.writeFileSync(
      path.join(coordDir, 'COUNCIL_CHECKPOINT_bad.json'),
      'not valid json!!!',
      'utf8',
    );

    const items = await scanResumableState({ baseUrl: '', projectRoot: tmpDir });
    const councilItems = items.filter((i) => i.source === 'council');
    // Should have at least the valid one
    assert.ok(councilItems.length >= 1);
  });

  it('handles malformed evolve session JSON gracefully', async () => {
    const evolveDir = path.join(tmpDir, 'docs', 'coordination', 'evolve');
    fs.mkdirSync(evolveDir, { recursive: true });
    fs.writeFileSync(path.join(evolveDir, 'EVOLVE_SESSION_STATE.json'), 'this is not json', 'utf8');

    // Should not throw — scanner catches parse errors
    const items = await scanResumableState({ baseUrl: '', projectRoot: tmpDir });
    const evolveItems = items.filter((i) => i.source === 'evolve');
    assert.equal(evolveItems.length, 0);
  });

  it('handles missing docs/coordination directory gracefully', async () => {
    // tmpDir exists but has no docs/coordination
    const items = await scanResumableState({ baseUrl: '', projectRoot: tmpDir });
    assert.ok(Array.isArray(items));
    // No crash — council scanner returns null when dir doesn't exist
  });

  it('individual scanner failures do not crash the entire scan', async () => {
    // Even with a bad baseUrl that would fail, other scanners should still work
    const evolveDir = path.join(tmpDir, 'docs', 'coordination', 'evolve');
    fs.mkdirSync(evolveDir, { recursive: true });
    fs.writeFileSync(
      path.join(evolveDir, 'EVOLVE_SESSION_STATE.json'),
      JSON.stringify({ resumable: true, status: 'partial', completedRounds: [1] }),
      'utf8',
    );

    // bad daemon URL — daemon scanner will fail/return null
    const items = await scanResumableState({
      baseUrl: 'http://127.0.0.1:99999',
      projectRoot: tmpDir,
    });
    // Evolve item should still be found even though daemon scanner failed
    const evolveItems = items.filter((i) => i.source === 'evolve');
    assert.equal(evolveItems.length, 1);
  });

  it('evolve session defaults actionNeeded from status', async () => {
    const evolveDir = path.join(tmpDir, 'docs', 'coordination', 'evolve');
    fs.mkdirSync(evolveDir, { recursive: true });
    fs.writeFileSync(
      path.join(evolveDir, 'EVOLVE_SESSION_STATE.json'),
      JSON.stringify({ resumable: true, status: 'partial', completedRounds: [] }),
      'utf8',
    );

    const items = await scanResumableState({ baseUrl: '', projectRoot: tmpDir });
    const evolveItems = items.filter((i) => i.source === 'evolve');
    assert.equal(evolveItems.length, 1);
    // When actionNeeded is not set, it defaults to "status — can resume"
    assert.ok(evolveItems[0].hint.includes('partial'));
  });
});

// ── ResumableItem shape ──────────────────────────────────────────────────────

describe('ResumableItem shape contract', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it('every returned item has required fields', async () => {
    const evolveDir = path.join(tmpDir, 'docs', 'coordination', 'evolve');
    const coordDir = path.join(tmpDir, 'docs', 'coordination');
    fs.mkdirSync(evolveDir, { recursive: true });
    fs.writeFileSync(
      path.join(evolveDir, 'EVOLVE_SESSION_STATE.json'),
      JSON.stringify({ resumable: true, status: 'partial', completedRounds: [1] }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(coordDir, 'COUNCIL_CHECKPOINT_x1.json'),
      JSON.stringify({ prompt: 'test', phase: 'plan' }),
      'utf8',
    );

    const items = await scanResumableState({ baseUrl: '', projectRoot: tmpDir });

    for (const item of items) {
      assert.equal(typeof item.source, 'string', 'source must be a string');
      assert.equal(typeof item.label, 'string', 'label must be a string');
      assert.equal(typeof item.hint, 'string', 'hint must be a string');
      assert.equal(typeof item.value, 'string', 'value must be a string');
      assert.ok(item.source.length > 0, 'source must be non-empty');
      assert.ok(item.label.length > 0, 'label must be non-empty');
      assert.ok(item.value.length > 0, 'value must be non-empty');
    }
  });
});
