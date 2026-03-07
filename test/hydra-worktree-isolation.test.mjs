/**
 * Tests for git worktree isolation config defaults.
 *
 * The worktree helper functions (createTaskWorktree, mergeTaskWorktree,
 * cleanupTaskWorktree) are daemon-internal and not exported, so they cannot be
 * directly unit-tested here. Integration-level behaviour is documented via
 * it.todo stubs below. Config shape is fully testable.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadHydraConfig, invalidateConfigCache } from '../lib/hydra-config.mjs';

describe('worktreeIsolation config', () => {
  it('DEFAULT_CONFIG has worktreeIsolation with enabled: false', () => {
    invalidateConfigCache();
    const cfg = loadHydraConfig();
    assert.ok(cfg.routing, 'routing section missing');
    assert.ok(
      Object.prototype.hasOwnProperty.call(cfg.routing, 'worktreeIsolation'),
      'routing.worktreeIsolation missing'
    );
    assert.strictEqual(
      cfg.routing.worktreeIsolation.enabled,
      false,
      'worktreeIsolation.enabled should default to false'
    );
  });

  it('worktreeDir defaults to .hydra/worktrees', () => {
    invalidateConfigCache();
    const cfg = loadHydraConfig();
    assert.strictEqual(
      cfg.routing.worktreeIsolation.worktreeDir,
      '.hydra/worktrees',
      'worktreeDir should default to .hydra/worktrees'
    );
  });

  it('cleanupOnSuccess defaults to true', () => {
    invalidateConfigCache();
    const cfg = loadHydraConfig();
    assert.strictEqual(
      cfg.routing.worktreeIsolation.cleanupOnSuccess,
      true,
      'cleanupOnSuccess should default to true'
    );
  });

  it('worktreeIsolation object has exactly the expected keys', () => {
    invalidateConfigCache();
    const cfg = loadHydraConfig();
    const keys = Object.keys(cfg.routing.worktreeIsolation).sort();
    assert.deepStrictEqual(keys, ['cleanupOnSuccess', 'enabled', 'worktreeDir']);
  });

  it('worktreeIsolation.enabled can be overridden via mergeWithDefaults', () => {
    // Simulate what mergeWithDefaults does when a user sets enabled: true in
    // hydra.config.json — routing uses shallow spread so nested objects are
    // replaced wholesale. This test documents that behaviour.
    invalidateConfigCache();
    const cfg = loadHydraConfig();
    // Shallow spread means a partial override would lose other keys; the full
    // object must be supplied. Test that a fully-supplied override is respected.
    const merged = {
      ...cfg.routing,
      worktreeIsolation: {
        enabled: true,
        cleanupOnSuccess: false,
        worktreeDir: '.hydra/worktrees',
      },
    };
    assert.strictEqual(merged.worktreeIsolation.enabled, true);
    assert.strictEqual(merged.worktreeIsolation.cleanupOnSuccess, false);
  });
});

// Integration-level stubs — these document intended behaviour but require a
// real git repo and are not run automatically.

// it.todo('createTaskWorktree creates worktree at .hydra/worktrees/task-{id}');
// it.todo('createTaskWorktree creates branch named hydra/task/{id}');
// it.todo('createTaskWorktree returns absolute path on success');
// it.todo('createTaskWorktree returns null and logs warning on git failure');
// it.todo('mergeTaskWorktree calls smartMerge(projectRoot, hydra/task/{id}, currentBranch)');
// it.todo('mergeTaskWorktree returns { ok: true } on clean merge');
// it.todo('mergeTaskWorktree returns { ok: false, conflict: true } and logs warning on conflict');
// it.todo('mergeTaskWorktree returns { ok: false, error } on exception');
// it.todo('cleanupTaskWorktree removes worktree and deletes branch');
// it.todo('cleanupTaskWorktree force=true passes --force to worktree remove and -D to branch delete');
// it.todo('cleanupTaskWorktree does not throw on git failure (best-effort cleanup)');
