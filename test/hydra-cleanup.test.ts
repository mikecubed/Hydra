/**
 * Tests for hydra-cleanup.ts — scanners and executors.
 *
 * Uses temp directories for file-based scanners and mock gitOps for executors.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ActionItem } from '../lib/hydra-action-pipeline.ts';
import type { IGitOperations } from '../lib/types.ts';

import {
  scanOldCheckpoints,
  scanOldArtifacts,
  enrichCleanupWithSitrep,
  executeCleanupAction,
} from '../lib/hydra-cleanup.ts';

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-cleanup-test-'));
}

function makeOldFile(filePath: string, daysOld: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'test-content', 'utf8');
  const oldTime = Date.now() - daysOld * 24 * 60 * 60 * 1000;
  fs.utimesSync(filePath, new Date(oldTime), new Date(oldTime));
}

function makeNewFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'test-content', 'utf8');
}

function makeMockItem(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    id: 'test-item',
    title: 'Test Item',
    description: 'A test item',
    category: 'delete',
    severity: 'low',
    source: 'test',
    ...overrides,
  };
}

function makeMockGitOps(overrides: Partial<IGitOperations> = {}): IGitOperations {
  return {
    getCurrentBranch: () => 'main',
    branchExists: () => false,
    createBranch: () => true,
    checkoutBranch: () => ({ status: 0, stdout: '', stderr: '', error: null, signal: null }),
    mergeBranch: () => true,
    deleteBranch: () => true,
    stageAndCommit: () => true,
    ...overrides,
  };
}

// ── scanOldCheckpoints ──────────────────────────────────────────────────────

describe('scanOldCheckpoints', () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty when coordination dir does not exist', async () => {
    const items = await scanOldCheckpoints(tmpDir);
    assert.deepEqual(items, []);
  });

  it('returns empty when council dir has no json files', async () => {
    fs.mkdirSync(path.join(tmpDir, 'docs', 'coordination', 'council'), { recursive: true });
    const items = await scanOldCheckpoints(tmpDir);
    assert.deepEqual(items, []);
  });

  it('returns empty for recent json files (< 7 days)', async () => {
    makeNewFile(path.join(tmpDir, 'docs', 'coordination', 'council', 'session-1.json'));
    const items = await scanOldCheckpoints(tmpDir);
    assert.deepEqual(items, []);
  });

  it('returns items for old json files (> 7 days)', async () => {
    makeOldFile(path.join(tmpDir, 'docs', 'coordination', 'council', 'session-old.json'), 10);
    const items = await scanOldCheckpoints(tmpDir);
    assert.equal(items.length, 1);
    assert.equal(items[0].category, 'delete');
    assert.equal(items[0].source, 'checkpoints');
    assert.ok(items[0].title.includes('session-old.json'));
  });

  it('filters by age - mix of old and new files', async () => {
    makeOldFile(path.join(tmpDir, 'docs', 'coordination', 'council', 'old.json'), 10);
    makeNewFile(path.join(tmpDir, 'docs', 'coordination', 'council', 'new.json'));
    const items = await scanOldCheckpoints(tmpDir);
    assert.equal(items.length, 1);
    assert.ok(items[0].title.includes('old.json'));
  });

  it('ignores non-json files', async () => {
    makeOldFile(path.join(tmpDir, 'docs', 'coordination', 'council', 'readme.md'), 10);
    const items = await scanOldCheckpoints(tmpDir);
    assert.deepEqual(items, []);
  });
});

// ── scanOldArtifacts ────────────────────────────────────────────────────────

describe('scanOldArtifacts', () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty when coordination dir does not exist', async () => {
    const items = await scanOldArtifacts(tmpDir);
    assert.deepEqual(items, []);
  });

  it('returns items for old task reports (> 14 days)', async () => {
    makeOldFile(path.join(tmpDir, 'docs', 'coordination', 'tasks', 'report.json'), 20);
    const items = await scanOldArtifacts(tmpDir);
    assert.equal(items.length, 1);
    assert.equal(items[0].category, 'delete');
    assert.equal(items[0].source, 'artifacts');
  });

  it('returns items for old nightly reports (> 14 days)', async () => {
    makeOldFile(path.join(tmpDir, 'docs', 'coordination', 'nightly', 'run.md'), 20);
    const items = await scanOldArtifacts(tmpDir);
    assert.equal(items.length, 1);
    assert.ok(items[0].title.includes('nightly'));
  });

  it('ignores recent reports (< 14 days)', async () => {
    makeNewFile(path.join(tmpDir, 'docs', 'coordination', 'tasks', 'recent.json'));
    const items = await scanOldArtifacts(tmpDir);
    assert.deepEqual(items, []);
  });

  it('detects large doctor log (> 500KB)', async () => {
    const doctorLog = path.join(tmpDir, 'docs', 'coordination', 'doctor', 'DOCTOR_LOG.ndjson');
    fs.mkdirSync(path.dirname(doctorLog), { recursive: true });
    // Create a file > 500KB
    const bigContent = 'x'.repeat(600 * 1024);
    fs.writeFileSync(doctorLog, bigContent, 'utf8');
    const items = await scanOldArtifacts(tmpDir);
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'artifact-doctor-log');
    assert.equal(items[0].category, 'cleanup');
  });

  it('does not flag small doctor log', async () => {
    const doctorLog = path.join(tmpDir, 'docs', 'coordination', 'doctor', 'DOCTOR_LOG.ndjson');
    fs.mkdirSync(path.dirname(doctorLog), { recursive: true });
    fs.writeFileSync(doctorLog, 'small log\n', 'utf8');
    const items = await scanOldArtifacts(tmpDir);
    assert.deepEqual(items, []);
  });
});

// ── enrichCleanupWithSitrep ─────────────────────────────────────────────────

describe('enrichCleanupWithSitrep', () => {
  it('returns items as-is (pass-through)', async () => {
    const items: ActionItem[] = [
      makeMockItem({ id: 'a' }),
      makeMockItem({ id: 'b' }),
    ];
    const enriched = await enrichCleanupWithSitrep(items);
    assert.deepEqual(enriched, items);
  });

  it('returns empty array for empty input', async () => {
    const enriched = await enrichCleanupWithSitrep([]);
    assert.deepEqual(enriched, []);
  });
});

// ── executeCleanupAction — delete branch ────────────────────────────────────

describe('executeCleanupAction — delete branch', () => {
  it('calls gitOps.deleteBranch for branch items', async () => {
    let deletedBranch = '';
    const mockGitOps = makeMockGitOps({
      deleteBranch: (_cwd: string, branch: string) => {
        deletedBranch = branch;
        return true;
      },
    });

    const item = makeMockItem({
      category: 'delete',
      source: 'branches',
      meta: { branch: 'evolve/test-branch' },
    });

    const result = await executeCleanupAction(
      item,
      { projectRoot: '/tmp/fake' },
      mockGitOps,
    );

    assert.equal(result.ok, true);
    assert.equal(result.output, 'Branch deleted');
    assert.equal(deletedBranch, 'evolve/test-branch');
  });

  it('reports failure when deleteBranch returns false', async () => {
    const mockGitOps = makeMockGitOps({
      deleteBranch: () => false,
    });

    const item = makeMockItem({
      category: 'delete',
      source: 'branches',
      meta: { branch: 'tasks/old' },
    });

    const result = await executeCleanupAction(
      item,
      { projectRoot: '/tmp/fake' },
      mockGitOps,
    );

    assert.equal(result.ok, false);
    assert.ok(result.output?.includes('Failed'));
  });
});

// ── executeCleanupAction — delete file ──────────────────────────────────────

describe('executeCleanupAction — delete file', () => {
  let fileToDelete: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
    fileToDelete = path.join(tmpDir, 'old-checkpoint.json');
    fs.writeFileSync(fileToDelete, '{}', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('deletes a file when filePath is in meta', async () => {
    const item = makeMockItem({
      category: 'delete',
      source: 'checkpoints',
      meta: { filePath: fileToDelete },
    });

    const result = await executeCleanupAction(item, { projectRoot: tmpDir });
    assert.equal(result.ok, true);
    assert.equal(result.output, 'File deleted');
    assert.equal(fs.existsSync(fileToDelete), false);
  });

  it('returns error for non-existent file', async () => {
    const item = makeMockItem({
      category: 'delete',
      source: 'checkpoints',
      meta: { filePath: path.join(tmpDir, 'no-such-file.json') },
    });

    const result = await executeCleanupAction(item, { projectRoot: tmpDir });
    assert.equal(result.ok, false);
    assert.ok(result.error);
  });
});

// ── executeCleanupAction — no target ────────────────────────────────────────

describe('executeCleanupAction — no delete target', () => {
  it('returns error when no branch or file path found', async () => {
    const item = makeMockItem({
      category: 'delete',
      source: 'unknown',
      meta: {},
    });

    const result = await executeCleanupAction(item, {});
    assert.equal(result.ok, false);
    assert.equal(result.error, 'No delete target found');
  });
});

// ── executeCleanupAction — fix / acknowledge ────────────────────────────────

describe('executeCleanupAction — fix and acknowledge', () => {
  it('returns ok with "No action needed" for fix category', async () => {
    const item = makeMockItem({ category: 'fix' });
    const result = await executeCleanupAction(item, {});
    assert.equal(result.ok, true);
    assert.equal(result.output, 'No action needed');
  });

  it('returns ok with "No action needed" for acknowledge category', async () => {
    const item = makeMockItem({ category: 'acknowledge' });
    const result = await executeCleanupAction(item, {});
    assert.equal(result.ok, true);
    assert.equal(result.output, 'No action needed');
  });
});

// ── executeCleanupAction — durationMs ───────────────────────────────────────

describe('executeCleanupAction — result shape', () => {
  it('always includes item and durationMs in result', async () => {
    const item = makeMockItem({ category: 'fix' });
    const result = await executeCleanupAction(item, {});
    assert.ok(result.item === item);
    assert.ok(typeof result.durationMs === 'number');
    assert.ok(result.durationMs >= 0);
  });
});
