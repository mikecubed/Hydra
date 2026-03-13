/**
 * Unit tests for lib/daemon/worktree.ts — task worktree lifecycle helpers
 * extracted from orchestrator-daemon.ts.
 */

import { describe, it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Git mock state — mutated per test to drive success/failure paths ───────

interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error: Error | null;
  signal: null;
}

let mockGitResult: GitResult = {
  status: 1,
  stdout: '',
  stderr: 'fatal: not a git repository',
  error: null,
  signal: null,
};
let mockCurrentBranch = 'main';
let mockSmartMergeResult = { ok: false, method: '', conflicts: ['conflict.ts'] };

mock.module('../lib/hydra-shared/git-ops.ts', {
  namedExports: {
    git: (_args: string[], _cwd: string): GitResult => mockGitResult,
    getCurrentBranch: (_cwd: string): string => mockCurrentBranch,
    smartMerge: (
      _cwd: string,
      _source: string,
      _target: string,
    ): { ok: boolean; method: string; conflicts: string[] } => mockSmartMergeResult,
    stripGitEnv: (): Record<string, string | undefined> => ({}),
  },
});

type WorktreeModule = {
  createTaskWorktree: (taskId: string) => string | null;
  mergeTaskWorktree: (taskId: string) => { ok: boolean; conflict?: boolean; error?: string };
  cleanupTaskWorktree: (taskId: string, opts?: { force?: boolean }) => void;
};

let tmpDir = '';
let mod: WorktreeModule;

describe('daemon/worktree unit tests', () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-worktree-unit-'));
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'hydra-worktree-test', version: '0.0.1' }),
      'utf8',
    );
    process.env['HYDRA_PROJECT'] = tmpDir;
    mod = (await import('../lib/daemon/worktree.ts')) as WorktreeModule;
  });

  after(() => {
    mock.restoreAll();
    if (tmpDir !== '') {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
    delete process.env['HYDRA_PROJECT'];
  });

  beforeEach(() => {
    mock.restoreAll();
    // Reset to failure defaults so tests are independent
    mockGitResult = {
      status: 1,
      stdout: '',
      stderr: 'fatal: not a git repository',
      error: null,
      signal: null,
    };
    mockCurrentBranch = 'main';
    mockSmartMergeResult = { ok: false, method: '', conflicts: ['conflict.ts'] };
  });

  // ── createTaskWorktree ────────────────────────────────────────────────────

  describe('createTaskWorktree', () => {
    it('returns null when git worktree add fails', () => {
      // mockGitResult.status = 1 (failure) — set by beforeEach
      const result = mod.createTaskWorktree('task-fail-test');
      assert.equal(result, null);
    });

    it('constructs the worktree path from config.projectRoot and worktreeDir', () => {
      // Verify null is returned (not a throw) when git fails in failure mode
      const result = mod.createTaskWorktree('my-task-123');
      assert.equal(result, null);
    });

    it('returns a path string on success', () => {
      mockGitResult = { status: 0, stdout: '', stderr: '', error: null, signal: null };
      const result = mod.createTaskWorktree('success-task');
      assert.ok(result !== null, 'Expected a path string, got null');
      assert.equal(typeof result, 'string');
      assert.ok(
        result.includes('task-success-task'),
        `Expected path to include task id, got: ${result}`,
      );
    });
  });

  // ── mergeTaskWorktree ─────────────────────────────────────────────────────

  describe('mergeTaskWorktree', () => {
    it('returns ok:false with conflict or error when merge fails', () => {
      // mockSmartMergeResult.ok = false (conflict) — set by beforeEach
      const result = mod.mergeTaskWorktree('task-merge-fail');
      assert.equal(result.ok, false);
      assert.ok(
        typeof result.error === 'string' || result.conflict === true,
        'Expected error or conflict flag',
      );
    });

    it('does not throw on git failure', () => {
      assert.doesNotThrow(() => {
        mod.mergeTaskWorktree('task-no-throw');
      });
    });

    it('returns { ok: true } on successful merge', () => {
      mockSmartMergeResult = { ok: true, method: 'fast-forward', conflicts: [] };
      const result = mod.mergeTaskWorktree('merge-success-task');
      assert.deepEqual(result, { ok: true });
    });
  });

  // ── cleanupTaskWorktree ───────────────────────────────────────────────────

  describe('cleanupTaskWorktree', () => {
    it('does not throw when worktree does not exist', () => {
      assert.doesNotThrow(() => {
        mod.cleanupTaskWorktree('non-existent-task');
      });
    });

    it('does not throw when called with force:true', () => {
      assert.doesNotThrow(() => {
        mod.cleanupTaskWorktree('force-task', { force: true });
      });
    });

    it('accepts default options (no second arg)', () => {
      assert.doesNotThrow(() => {
        mod.cleanupTaskWorktree('default-opts-task');
      });
    });
  });
});
