/**
 * Tests for hydra-models.ts — model discovery / fetchModels
 *
 * NOTE: `claude` and `gemini` CLIs are present in this environment, so we ONLY
 * test the path that returns immediately — unknown agent names — which bypass
 * all API and CLI strategies. This keeps tests fast and deterministic.
 *
 * We also verify the return-shape contract is honoured for one unknown-agent
 * call, confirming the fast-exit path returns the correct shape without error.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchModels } from '../lib/hydra-models.ts';

// ── fetchModels — unknown agent (fast path) ───────────────────────────────────

describe('fetchModels — unknown agent name', () => {
  it('returns empty models array for a completely unrecognised agent', async () => {
    const result = await fetchModels('totally-unknown-agent-xyz');
    assert.deepEqual(result.models, []);
  });

  it('returns source "none" for a completely unrecognised agent', async () => {
    const result = await fetchModels('totally-unknown-agent-xyz');
    assert.equal(result.source, 'none');
  });

  it('handles empty-string agent name without throwing', async () => {
    const result = await fetchModels('');
    assert.deepEqual(result.models, []);
    assert.equal(result.source, 'none');
  });

  it('handles numeric-string agent name without throwing', async () => {
    const result = await fetchModels('123');
    assert.deepEqual(result.models, []);
    assert.equal(result.source, 'none');
  });

  it('handles agent name with special characters without throwing', async () => {
    const result = await fetchModels('agent/with/slashes');
    assert.deepEqual(result.models, []);
    assert.equal(result.source, 'none');
  });

  it('always returns a plain object with models array and source string', async () => {
    const result = await fetchModels('nonexistent');
    assert.ok(typeof result === 'object');
    assert.ok(Array.isArray(result.models));
    assert.ok(typeof result.source === 'string');
  });

  it('returns the same shape for every call (idempotent on unknown agent)', async () => {
    const r1 = await fetchModels('no-such-agent');
    const r2 = await fetchModels('no-such-agent');
    assert.deepEqual(r1, r2);
  });
});

// ── fetchModels — return shape contract (unknown agents only) ─────────────────

describe('fetchModels — return shape contract', () => {
  const unknownAgents = ['noop', 'fake-agent-a', 'fake-agent-b'];

  for (const agent of unknownAgents) {
    it(`fetchModels("${agent}") returns { models: string[], source: string }`, async () => {
      const result = await fetchModels(agent);
      assert.ok(Array.isArray(result.models));
      assert.ok(typeof result.source === 'string');
      for (const m of result.models) {
        assert.ok(typeof m === 'string', `model entry must be string, got ${typeof m}`);
      }
    });
  }
});
