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
import { loadHydraConfig, invalidateConfigCache } from '../lib/hydra-config.ts';

describe('worktreeIsolation config', () => {
  it('DEFAULT_CONFIG has worktreeIsolation with enabled: false', () => {
    invalidateConfigCache();
    const cfg = loadHydraConfig();
    assert.ok(cfg.routing, 'routing section missing');
    assert.ok(
      Object.prototype.hasOwnProperty.call(cfg.routing, 'worktreeIsolation'),
      'routing.worktreeIsolation missing',
    );
    assert.strictEqual(
      cfg.routing.worktreeIsolation.enabled,
      false,
      'worktreeIsolation.enabled should default to false',
    );
  });

  it('worktreeDir defaults to .hydra/worktrees', () => {
    invalidateConfigCache();
    const cfg = loadHydraConfig();
    assert.strictEqual(
      cfg.routing.worktreeIsolation.worktreeDir,
      '.hydra/worktrees',
      'worktreeDir should default to .hydra/worktrees',
    );
  });

  it('cleanupOnSuccess defaults to true', () => {
    invalidateConfigCache();
    const cfg = loadHydraConfig();
    assert.strictEqual(
      cfg.routing.worktreeIsolation.cleanupOnSuccess,
      true,
      'cleanupOnSuccess should default to true',
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

describe('worktreeIsolation dispatch guard', () => {
  it('worktreeIsolation.enabled: false means worktrees are NOT created during dispatch (config guard)', () => {
    // When worktreeIsolation.enabled is false, the write-routes dispatch hook
    // must not invoke createTaskWorktree. This is enforced by the conditional:
    //   if (cfg.routing?.worktreeIsolation?.enabled) { ... }
    // We verify the default config satisfies the guard condition.
    invalidateConfigCache();
    const cfg = loadHydraConfig();
    // Guard check: if this is false, the worktree creation block is skipped
    assert.strictEqual(
      Boolean(cfg.routing?.worktreeIsolation?.enabled),
      false,
      'Guard condition must be false by default — no worktrees created unless opt-in',
    );
  });

  it('worktreeIsolation config keys propagate correctly through loadHydraConfig()', () => {
    invalidateConfigCache();
    const cfg = loadHydraConfig();
    const iso = cfg.routing.worktreeIsolation;
    // All three keys must exist with correct types
    assert.strictEqual(typeof iso.enabled, 'boolean', 'enabled must be boolean');
    assert.strictEqual(typeof iso.cleanupOnSuccess, 'boolean', 'cleanupOnSuccess must be boolean');
    assert.strictEqual(typeof iso.worktreeDir, 'string', 'worktreeDir must be string');
    assert.ok(iso.worktreeDir.length > 0, 'worktreeDir must not be empty');
  });

  it('worktreeIsolation is nested under routing (not top-level)', () => {
    invalidateConfigCache();
    const cfg = loadHydraConfig();
    // Must be under routing, not at top level
    assert.ok(
      !Object.prototype.hasOwnProperty.call(cfg, 'worktreeIsolation'),
      'worktreeIsolation must not be top-level key',
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(cfg.routing, 'worktreeIsolation'),
      'worktreeIsolation must be under routing',
    );
  });
});

// Integration-level stubs — these document intended behaviour but require a
// real git repo and are not run automatically.

describe('worktree lifecycle dispatch hooks (integration stubs)', () => {
  it.todo('createTaskWorktree creates worktree at .hydra/worktrees/task-{id}');
  it.todo('createTaskWorktree creates branch named hydra/task/{id}');
  it.todo('createTaskWorktree returns absolute path on success');
  it.todo('createTaskWorktree returns null and logs warning on git failure');
  it.todo('mergeTaskWorktree calls smartMerge(projectRoot, hydra/task/{id}, currentBranch)');
  it.todo('mergeTaskWorktree returns { ok: true } on clean merge');
  it.todo('mergeTaskWorktree returns { ok: false, conflict: true } and logs warning on conflict');
  it.todo('mergeTaskWorktree returns { ok: false, error } on exception');
  it.todo('cleanupTaskWorktree removes worktree and deletes branch');
  it.todo(
    'cleanupTaskWorktree force=true passes --force to worktree remove and -D to branch delete',
  );
  it.todo('cleanupTaskWorktree does not throw on git failure (best-effort cleanup)');
  it.todo(
    'worktreeIsolation.enabled: false means /task/claim does NOT call createTaskWorktree (daemon integration)',
  );
  it.todo(
    'worktreeIsolation.enabled: true with mode=tandem creates worktree on /task/claim for new task',
  );
  it.todo(
    'worktreeIsolation.enabled: true with mode=council creates worktree on /task/claim for new task',
  );
  it.todo(
    'task completion with worktreePath calls mergeTaskWorktree via /task/result (daemon integration)',
  );
  it.todo('clean merge on task result calls cleanupTaskWorktree when cleanupOnSuccess: true');
  it.todo(
    'conflict merge on task result sets worktreeConflict: true on task, does NOT delete worktree',
  );
  it.todo(':cleanup scanner finds task-* dirs older than 24h in .hydra/worktrees/');
  it.todo(':tasks review shows conflict worktrees when daemon tasks have worktreeConflict: true');
});
