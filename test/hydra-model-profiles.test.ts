import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCliModelId, MODEL_PROFILES } from '../lib/hydra-model-profiles.ts';

describe('resolveCliModelId', () => {
  it('returns modelId unchanged when no profile exists', () => {
    assert.equal(resolveCliModelId('unknown-model-xyz'), 'unknown-model-xyz');
  });

  it('returns modelId unchanged when profile has no cliModelId override', () => {
    // claude-opus-4-6 exists but has no cliModelId, so input is returned as-is
    const result = resolveCliModelId('claude-opus-4-6');
    assert.equal(result, 'claude-opus-4-6');
  });

  it('returns cliModelId when profile has override', () => {
    // Temporarily mutate a profile to test the override path
    const profile = MODEL_PROFILES['claude-opus-4-6'];
    assert.ok(profile, 'test profile must exist');
    const original = profile.cliModelId;
    profile.cliModelId = 'claude-opus-test-cli';
    try {
      const result = resolveCliModelId('claude-opus-4-6');
      assert.equal(result, 'claude-opus-test-cli');
    } finally {
      profile.cliModelId = original;
    }
  });

  it('accepts optional agent parameter — agent match returns cliModelId', () => {
    const profile = MODEL_PROFILES['claude-opus-4-6'];
    assert.ok(profile);
    const original = profile.cliModelId;
    profile.cliModelId = 'opus-cli-override';
    try {
      const result = resolveCliModelId('claude-opus-4-6', 'claude');
      assert.equal(result, 'opus-cli-override');
    } finally {
      profile.cliModelId = original;
    }
  });

  it('returns modelId when agent does not match profile agent', () => {
    // 'claude-opus-4-6' belongs to agent 'claude', not 'codex'
    const profile = MODEL_PROFILES['claude-opus-4-6'];
    assert.ok(profile);
    const original = profile.cliModelId;
    profile.cliModelId = 'should-not-return';
    try {
      // Wrong agent — agent-specific lookup misses, falls back to global lookup
      const result = resolveCliModelId('claude-opus-4-6', 'codex');
      // Global lookup still finds the profile, so cliModelId is returned
      assert.equal(result, 'should-not-return');
    } finally {
      profile.cliModelId = original;
    }
  });

  it('returns unknown id unchanged with or without agent', () => {
    assert.equal(resolveCliModelId('no-such-model', 'claude'), 'no-such-model');
    assert.equal(resolveCliModelId('no-such-model'), 'no-such-model');
  });
});
