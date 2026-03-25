/**
 * Tests for lib/hydra-shared/review-common.ts — loadLatestReport, cleanBranches,
 * displayBranchInfo, handleEmptyBranch, handleBranchAction.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type readline from 'node:readline';

import {
  cleanBranches,
  displayBranchInfo,
  handleBranchAction,
  handleEmptyBranch,
  loadLatestReport,
} from '../lib/hydra-shared/review-common.ts';
import type { IGitOperations } from '../lib/types.ts';

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

function makeAnsweringRl(answers: string[]): readline.Interface {
  return {
    question: (_q: string, callback: (answer: string) => void) => {
      callback(answers.shift() ?? '');
    },
  } as unknown as readline.Interface;
}

/** Env override that strips parent git vars so temp repos work during hooks. */
const CLEAN_GIT_ENV = (() => {
  const env = { ...process.env };
  Reflect.deleteProperty(env, 'GIT_DIR');
  Reflect.deleteProperty(env, 'GIT_WORK_TREE');
  Reflect.deleteProperty(env, 'GIT_INDEX_FILE');
  return env;
})();

function initTempRepo(repoDir: string): void {
  const opts = { cwd: repoDir, env: CLEAN_GIT_ENV };
  execFileSync('git', ['init', '-b', 'main'], opts);
  execFileSync('git', ['config', 'user.name', 'Hydra Test'], opts);
  execFileSync('git', ['config', 'user.email', 'hydra-test@example.com'], opts);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# review-common test\n');
  execFileSync('git', ['add', 'README.md'], opts);
  execFileSync('git', ['commit', '-m', 'init'], opts);
}

describe('loadLatestReport', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-review-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when report directory does not exist', () => {
    assert.strictEqual(loadLatestReport('/nonexistent/path', 'NIGHTLY'), null);
  });

  it('returns null when directory exists but has no matching files', () => {
    assert.strictEqual(loadLatestReport(tmpDir, 'NIGHTLY'), null);
  });

  it('loads a report by date filter', () => {
    const report = { summary: 'test report', date: '2025-01-15' };
    fs.writeFileSync(path.join(tmpDir, 'NIGHTLY_2025-01-15.json'), JSON.stringify(report));
    assert.deepStrictEqual(loadLatestReport(tmpDir, 'NIGHTLY', '2025-01-15'), report);
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
    const result = loadLatestReport(tmpDir, 'NIGHTLY') as Record<string, unknown>;
    assert.equal(result['date'], '2025-01-15');
  });

  it('returns null for invalid JSON or wrong extension', () => {
    fs.writeFileSync(path.join(tmpDir, 'NIGHTLY_2025-01-15.json'), '{broken');
    fs.writeFileSync(path.join(tmpDir, 'NIGHTLY_2025-01-15.txt'), 'not json');
    assert.strictEqual(loadLatestReport(tmpDir, 'NIGHTLY', '2025-01-15'), null);
  });
});

describe('cleanBranches', () => {
  let repoDir: string;
  let originalLog: typeof console.log;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-review-clean-'));
    initTempRepo(repoDir);
    originalLog = console.log;
    console.log = () => {};
  });

  afterEach(() => {
    console.log = originalLog;
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  function createBranch(name: string): void {
    execFileSync('git', ['branch', name], { cwd: repoDir, env: CLEAN_GIT_ENV });
  }

  it('deletes matching branches without checkout when already on base branch', () => {
    const deleted: string[] = [];
    createBranch('tasks/branch1');
    createBranch('tasks/branch2');
    cleanBranches(
      repoDir,
      'tasks',
      'main',
      null,
      makeMockGitOps({
        getCurrentBranch: () => 'main',
        deleteBranch: (_cwd: string, branch: string) => {
          deleted.push(branch);
          return true;
        },
      }),
    );
    assert.deepStrictEqual(deleted, ['tasks/branch1', 'tasks/branch2']);
  });

  it('checks out the base branch before deleting when current branch differs', () => {
    const deleted: string[] = [];
    const checkedOut: string[] = [];
    createBranch('tasks/branch1');
    cleanBranches(
      repoDir,
      'tasks',
      'main',
      null,
      makeMockGitOps({
        getCurrentBranch: () => 'feature/current',
        checkoutBranch: (_cwd: string, branch: string) => {
          checkedOut.push(branch);
          return { ok: true, status: 0, stdout: '', stderr: '', error: null, signal: null };
        },
        deleteBranch: (_cwd: string, branch: string) => {
          deleted.push(branch);
          return true;
        },
      }),
    );
    assert.deepStrictEqual(checkedOut, ['main']);
    assert.deepStrictEqual(deleted, ['tasks/branch1']);
  });

  it('continues deleting later branches when one deletion fails', () => {
    const deleted: string[] = [];
    createBranch('tasks/fail');
    createBranch('tasks/ok');
    cleanBranches(
      repoDir,
      'tasks',
      'main',
      null,
      makeMockGitOps({
        deleteBranch: (_cwd: string, branch: string) => {
          deleted.push(branch);
          return branch !== 'tasks/fail';
        },
      }),
    );
    assert.deepStrictEqual(deleted, ['tasks/fail', 'tasks/ok']);
  });
});

describe('displayBranchInfo', () => {
  it('returns commitLog and diffStat strings', () => {
    const result = displayBranchInfo('/tmp', 'nonexistent-branch', 'main');
    assert.equal(typeof result.commitLog, 'string');
    assert.equal(typeof result.diffStat, 'string');
  });
});

describe('handleEmptyBranch', () => {
  it('deletes the branch when the user confirms', async () => {
    const deleted: string[] = [];
    await handleEmptyBranch(
      makeAnsweringRl(['y']),
      '/tmp/project',
      'feature/empty',
      makeMockGitOps({
        deleteBranch: (_cwd: string, branch: string) => {
          deleted.push(branch);
          return true;
        },
      }),
    );
    assert.deepStrictEqual(deleted, ['feature/empty']);
  });
});

describe('handleBranchAction', () => {
  it('merges and deletes the branch when the user chooses merge', async () => {
    const deleted: string[] = [];
    const merges: string[] = [];
    const result = await handleBranchAction(
      makeAnsweringRl(['m', 'y']),
      '/tmp/project',
      'feature/merge-me',
      'main',
      { useSmartMerge: false },
      makeMockGitOps({
        mergeBranch: (_cwd: string, branch: string, baseBranch: string) => {
          merges.push(`${branch}->${baseBranch}`);
          return true;
        },
        deleteBranch: (_cwd: string, branch: string) => {
          deleted.push(branch);
          return true;
        },
      }),
    );
    assert.equal(result, 'merged');
    assert.deepStrictEqual(merges, ['feature/merge-me->main']);
    assert.deepStrictEqual(deleted, ['feature/merge-me']);
  });

  it('deletes the branch directly when the user chooses delete', async () => {
    const deleted: string[] = [];
    const result = await handleBranchAction(
      makeAnsweringRl(['x']),
      '/tmp/project',
      'feature/delete-me',
      'main',
      {},
      makeMockGitOps({
        deleteBranch: (_cwd: string, branch: string) => {
          deleted.push(branch);
          return true;
        },
      }),
    );
    assert.equal(result, 'deleted');
    assert.deepStrictEqual(deleted, ['feature/delete-me']);
  });
});
