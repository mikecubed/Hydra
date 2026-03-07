/**
 * Tests for diffConfig() in hydra-config.mjs.
 *
 * diffConfig compares a raw user config object against DEFAULT_CONFIG and
 * returns { missing, stale, typeMismatches } without touching the filesystem.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diffConfig } from '../lib/hydra-config.mjs';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal fake DEFAULT_CONFIG for isolated unit testing.
 * This avoids coupling tests to the real DEFAULT_CONFIG shape while still
 * exercising all diffConfig code paths.
 */
function makeDefault() {
  return {
    version: 2,
    mode: 'performance',
    routing: {
      mode: 'balanced',
      councilGate: true,
      intentGate: { enabled: true, confidenceThreshold: 0.55 },
    },
    context: {
      hierarchical: { enabled: true, maxFiles: 3 },
    },
    workers: {
      autoStart: false,
      pollIntervalMs: 1500,
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('diffConfig()', () => {
  it('returns correct shape { missing, stale, typeMismatches }', () => {
    const result = diffConfig({}, makeDefault());
    assert.ok(Array.isArray(result.missing), 'missing should be an array');
    assert.ok(Array.isArray(result.stale), 'stale should be an array');
    assert.ok(Array.isArray(result.typeMismatches), 'typeMismatches should be an array');
  });

  it('empty user config — all top-level DEFAULT_CONFIG keys reported as missing', () => {
    const def = makeDefault();
    const { missing, stale, typeMismatches } = diffConfig({}, def);

    const missingPaths = missing.map((m) => m.path);
    for (const key of Object.keys(def)) {
      assert.ok(missingPaths.includes(key), `expected "${key}" in missing`);
    }
    assert.equal(stale.length, 0, 'no stale keys expected for empty user config');
    assert.equal(typeMismatches.length, 0, 'no type mismatches expected for empty user config');
  });

  it('fully matching config — no missing, no stale, no type mismatches', () => {
    const def = makeDefault();
    // Deep clone so we use an identical but separate object
    const user = JSON.parse(JSON.stringify(def));
    const { missing, stale, typeMismatches } = diffConfig(user, def);

    assert.equal(missing.length, 0, 'no keys should be missing');
    assert.equal(stale.length, 0, 'no stale keys expected');
    assert.equal(typeMismatches.length, 0, 'no type mismatches expected');
  });

  it('stale top-level key in user config is reported in stale', () => {
    const def = makeDefault();
    const user = { ...JSON.parse(JSON.stringify(def)), legacyOption: true };
    const { stale } = diffConfig(user, def);

    const stalePaths = stale.map((s) => s.path);
    assert.ok(stalePaths.includes('legacyOption'), 'legacyOption should be reported as stale');
  });

  it('stale nested key in user config section is reported in stale', () => {
    const def = makeDefault();
    const user = JSON.parse(JSON.stringify(def));
    user.routing.oldFlag = 'removed-in-v3';
    const { stale } = diffConfig(user, def);

    const stalePaths = stale.map((s) => s.path);
    assert.ok(stalePaths.includes('routing.oldFlag'), 'routing.oldFlag should be reported as stale');
  });

  it('type mismatch at top level is reported in typeMismatches', () => {
    const def = makeDefault();
    const user = { ...JSON.parse(JSON.stringify(def)), mode: 42 }; // expected string, got number
    const { typeMismatches } = diffConfig(user, def);

    const mismatchPaths = typeMismatches.map((m) => m.path);
    assert.ok(mismatchPaths.includes('mode'), 'mode type mismatch should be reported');
    const mismatch = typeMismatches.find((m) => m.path === 'mode');
    assert.equal(mismatch.expectedType, 'string');
    assert.equal(mismatch.gotType, 'number');
  });

  it('type mismatch at nested level is reported in typeMismatches', () => {
    const def = makeDefault();
    const user = JSON.parse(JSON.stringify(def));
    user.routing.councilGate = 'yes'; // expected boolean, got string
    const { typeMismatches } = diffConfig(user, def);

    const mismatchPaths = typeMismatches.map((m) => m.path);
    assert.ok(mismatchPaths.includes('routing.councilGate'), 'routing.councilGate type mismatch should be reported');
    const mismatch = typeMismatches.find((m) => m.path === 'routing.councilGate');
    assert.equal(mismatch.expectedType, 'boolean');
    assert.equal(mismatch.gotType, 'string');
  });

  it('partial section — user has routing but missing routing.intentGate', () => {
    const def = makeDefault();
    const user = JSON.parse(JSON.stringify(def));
    delete user.routing.intentGate;
    const { missing } = diffConfig(user, def);

    const missingPaths = missing.map((m) => m.path);
    assert.ok(missingPaths.includes('routing.intentGate'), 'routing.intentGate should be reported missing');
    // routing itself should NOT be in missing (the key exists)
    assert.ok(!missingPaths.includes('routing'), 'routing should not be reported as missing');
  });

  it('missing items include the defaultValue', () => {
    const def = makeDefault();
    const { missing } = diffConfig({}, def);

    for (const item of missing) {
      assert.ok('path' in item, 'each missing item must have a path');
      assert.ok('defaultValue' in item, 'each missing item must have a defaultValue');
    }
  });

  it('stale items include the userValue', () => {
    const def = makeDefault();
    const user = { ...JSON.parse(JSON.stringify(def)), deprecatedKey: { old: true } };
    const { stale } = diffConfig(user, def);

    const item = stale.find((s) => s.path === 'deprecatedKey');
    assert.ok(item, 'deprecatedKey should be in stale');
    assert.ok('userValue' in item, 'stale item must have a userValue');
    assert.deepEqual(item.userValue, { old: true });
  });

  it('does not recurse into arrays', () => {
    const def = {
      tags: ['a', 'b', 'c'],
    };
    // User has a different array — should not be flagged as type mismatch or recurse
    const user = { tags: ['x'] };
    const { missing, stale, typeMismatches } = diffConfig(user, def);

    // Same type (object... actually array is typeof 'object'), same key — no issues
    assert.equal(missing.length, 0);
    assert.equal(stale.length, 0);
    assert.equal(typeMismatches.length, 0);
  });

  it('works against the real DEFAULT_CONFIG with a partial user config', () => {
    // Smoke test: ensure it works with the real DEFAULT_CONFIG (no supplied reference)
    const user = { version: 2, mode: 'balanced' };
    const result = diffConfig(user);

    assert.ok(Array.isArray(result.missing));
    assert.ok(Array.isArray(result.stale));
    assert.ok(Array.isArray(result.typeMismatches));
    // version and mode exist in both → not missing, not stale
    const missingPaths = result.missing.map((m) => m.path);
    assert.ok(!missingPaths.includes('version'), 'version should not be missing');
    assert.ok(!missingPaths.includes('mode'), 'mode should not be missing');
  });
});
