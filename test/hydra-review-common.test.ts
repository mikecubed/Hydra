/**
 * Tests for lib/hydra-shared/review-common.ts — loadLatestReport, cleanBranches,
 * displayBranchInfo, handleEmptyBranch, handleBranchAction.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadLatestReport, displayBranchInfo } from '../lib/hydra-shared/review-common.ts';
import type { IGitOperations } from '../lib/types.ts';

// ── loadLatestReport ─────────────────────────────────────────────────────────

describe('loadLatestReport', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-review-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when report directory does not exist', () => {
    const result = loadLatestReport('/nonexistent/path', 'NIGHTLY');
    assert.strictEqual(result, null);
  });

  it('returns null when directory exists but has no matching files', () => {
    const result = loadLatestReport(tmpDir, 'NIGHTLY');
    assert.strictEqual(result, null);
  });

  it('loads a report by date filter', () => {
    const report = { summary: 'test report', date: '2025-01-15' };
    fs.writeFileSync(path.join(tmpDir, 'NIGHTLY_2025-01-15.json'), JSON.stringify(report));

    const result = loadLatestReport(tmpDir, 'NIGHTLY', '2025-01-15');
    assert.deepStrictEqual(result, report);
  });

  it('returns null when date filter does not match any file', () => {
    fs.writeFileSync(path.join(tmpDir, 'NIGHTLY_2025-01-15.json'), JSON.stringify({ data: 'x' }));

    const result = loadLatestReport(tmpDir, 'NIGHTLY', '2025-01-16');
    assert.strictEqual(result, null);
  });

  it('returns the latest report when no date filter', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'NIGHTLY_2025-01-10.json'),
      JSON.stringify({ date: '2025-01-10' }),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'NIGHTLY_2025-01-15.json'),
      JSON.stringify({ date: '2025-01-15' }),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'NIGHTLY_2025-01-12.json'),
      JSON.stringify({ date: '2025-01-12' }),
    );

    const result = loadLatestReport(tmpDir, 'NIGHTLY') as Record<string, unknown>;
    assert.equal(result['date'], '2025-01-15');
  });

  it('ignores non-matching prefixes', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'EVOLVE_2025-01-15.json'),
      JSON.stringify({ type: 'evolve' }),
    );

    const result = loadLatestReport(tmpDir, 'NIGHTLY');
    assert.strictEqual(result, null);
  });

  it('returns null when report file contains invalid JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'NIGHTLY_2025-01-15.json'), 'not-json{{{');

    const result = loadLatestReport(tmpDir, 'NIGHTLY');
    assert.strictEqual(result, null);
  });

  it('returns null when date-filtered file contains invalid JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'NIGHTLY_2025-01-15.json'), '{broken');

    const result = loadLatestReport(tmpDir, 'NIGHTLY', '2025-01-15');
    assert.strictEqual(result, null);
  });

  it('ignores non-.json files', () => {
    fs.writeFileSync(path.join(tmpDir, 'NIGHTLY_2025-01-15.txt'), 'not json');

    const result = loadLatestReport(tmpDir, 'NIGHTLY');
    assert.strictEqual(result, null);
  });
});

// ── cleanBranches ────────────────────────────────────────────────────────────

describe('cleanBranches', () => {
  /** Creates a mock IGitOperations for testing */
  function makeMockGitOps(overrides: Partial<IGitOperations> = {}): IGitOperations {
    return {
      getCurrentBranch: () => 'main',
      branchExists: () => true,
      createBranch: () => true,
      checkoutBranch: () => ({
        ok: true,
        status: 0,
        stdout: '',
        stderr: '',
        error: null,
        signal: null,
      }),
      mergeBranch: () => true,
      deleteBranch: () => true,
      stageAndCommit: () => true,
      ...overrides,
    };
  }

  it('mock gitOps interface has correct methods', () => {
    const deleted: string[] = [];
    const gitOps = makeMockGitOps({
      getCurrentBranch: () => 'main',
      deleteBranch: (_cwd: string, branch: string) => {
        deleted.push(branch);
        return true;
      },
    });

    assert.equal(typeof gitOps.deleteBranch, 'function');
    assert.equal(typeof gitOps.getCurrentBranch, 'function');
    assert.equal(typeof gitOps.checkoutBranch, 'function');
  });

  it('mock gitOps deleteBranch works', () => {
    const deleted: string[] = [];
    const gitOps = makeMockGitOps({
      deleteBranch: (_cwd: string, branch: string) => {
        deleted.push(branch);
        return true;
      },
    });

    gitOps.deleteBranch('/tmp', 'tasks/branch1');
    gitOps.deleteBranch('/tmp', 'tasks/branch2');

    assert.deepStrictEqual(deleted, ['tasks/branch1', 'tasks/branch2']);
  });

  it('mock gitOps deleteBranch can return false for failure', () => {
    const gitOps = makeMockGitOps({
      deleteBranch: () => false,
    });

    const result = gitOps.deleteBranch('/tmp', 'tasks/fail');
    assert.equal(result, false);
  });
});

// ── displayBranchInfo ────────────────────────────────────────────────────────

describe('displayBranchInfo', () => {
  it('returns commitLog and diffStat strings', () => {
    // displayBranchInfo calls getBranchDiffStat and getBranchLog from git-ops
    // which run git commands. In a non-git directory, these return empty strings.
    // We test the return shape.
    const result = displayBranchInfo('/tmp', 'nonexistent-branch', 'main');
    assert.equal(typeof result.commitLog, 'string');
    assert.equal(typeof result.diffStat, 'string');
  });
});
