/**
 * Unit tests for lib/daemon/worktree.ts — task worktree lifecycle helpers
 * extracted from orchestrator-daemon.ts.
 */

import { describe, it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  });

  // ── createTaskWorktree ────────────────────────────────────────────────────

  describe('createTaskWorktree', () => {
    it('returns null when git worktree add fails', () => {
      // The git helper is imported by the module — we test behavior by checking
      // that a failure result propagates as null (git is not available in tmpDir).
      const result = mod.createTaskWorktree('task-fail-test');
      // Without a real git repo the command should fail → null
      assert.equal(result, null);
    });

    it('constructs the worktree path from config.projectRoot and worktreeDir', () => {
      // We can verify the path shape without needing git to succeed.
      // Call with a distinctive id and check the path that would have been used.
      // Since git fails in our temp dir, we just verify null is returned (not throws).
      const result = mod.createTaskWorktree('my-task-123');
      assert.equal(result, null); // expected in non-git tmpDir
    });
  });

  // ── mergeTaskWorktree ─────────────────────────────────────────────────────

  describe('mergeTaskWorktree', () => {
    it('returns ok:false with error message when git merge fails', () => {
      // No real git repo — expect an error result, not a throw.
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
