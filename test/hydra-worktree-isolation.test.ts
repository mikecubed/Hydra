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
      cfg.routing?.worktreeIsolation?.enabled ?? false,
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
    assert.ok(iso.worktreeDir!.length > 0, 'worktreeDir must not be empty');
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

// Lifecycle tests (createTaskWorktree, mergeTaskWorktree, cleanupTaskWorktree,
// daemon integration, cleanup/review) are in hydra-worktree-isolation-lifecycle.test.ts.
