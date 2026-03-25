/**
 * Tests for hydra-models.ts — expanded coverage for fetchModels with known agents.
 *
 * In test environments without API keys or CLIs, known agents (claude, gemini, codex)
 * should fall through all strategies and return config-only or similar. We verify:
 * - Return shape contract for all known agents
 * - Source is one of the expected values
 * - Models array contains only strings
 * - Concurrent fetches don't interfere
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchModels } from '../lib/hydra-models.ts';

// ── fetchModels — known agents ──────────────────────────────────────────────

describe('fetchModels — known agents', () => {
  const knownAgents = ['claude', 'gemini', 'codex'];
  const validSources = ['api', 'cli', 'config-only', 'none'];

  for (const agent of knownAgents) {
    it(`fetchModels("${agent}") returns { models: string[], source: string }`, async () => {
      const result = await fetchModels(agent);
      assert.ok(Array.isArray(result.models), 'models should be an array');
      assert.ok(typeof result.source === 'string', 'source should be a string');
    });

    it(`fetchModels("${agent}") source is one of expected values`, async () => {
      const result = await fetchModels(agent);
      assert.ok(
        validSources.includes(result.source),
        `source "${result.source}" not in ${JSON.stringify(validSources)}`,
      );
    });

    it(`fetchModels("${agent}") models array contains only strings`, async () => {
      const result = await fetchModels(agent);
      for (const m of result.models) {
        assert.ok(typeof m === 'string', `expected string, got ${typeof m}`);
      }
    });

    it(`fetchModels("${agent}") models are sorted if present`, async () => {
      const result = await fetchModels(agent);
      if (result.models.length > 1) {
        const sorted = [...result.models].sort();
        assert.deepEqual(result.models, sorted, 'models should be sorted');
      }
    });
  }
});

// ── fetchModels — concurrency ───────────────────────────────────────────────

describe('fetchModels — concurrency', () => {
  it('concurrent fetches for different agents do not interfere', async () => {
    const [claude, gemini, codex, unknown] = await Promise.all([
      fetchModels('claude'),
      fetchModels('gemini'),
      fetchModels('codex'),
      fetchModels('nonexistent'),
    ]);

    // All should have valid shapes
    for (const result of [claude, gemini, codex, unknown]) {
      assert.ok(Array.isArray(result.models));
      assert.ok(typeof result.source === 'string');
    }

    // Unknown should always be 'none'
    assert.equal(unknown.source, 'none');
    assert.deepEqual(unknown.models, []);
  });

  it('repeated calls for same agent return valid shape each time', async () => {
    const r1 = await fetchModels('claude');
    const r2 = await fetchModels('claude');
    // Source may vary between calls (CLI flakiness), but shape must be valid
    const validSources = ['api', 'cli', 'config-only', 'none'];
    assert.ok(validSources.includes(r1.source));
    assert.ok(validSources.includes(r2.source));
    assert.ok(Array.isArray(r1.models));
    assert.ok(Array.isArray(r2.models));
  });
});

// ── fetchModels — edge cases ────────────────────────────────────────────────

describe('fetchModels — edge cases', () => {
  it('handles case-sensitive agent names (uppercase returns none)', async () => {
    const result = await fetchModels('Claude');
    assert.equal(result.source, 'none');
    assert.deepEqual(result.models, []);
  });

  it('handles agent name with whitespace', async () => {
    const result = await fetchModels(' claude ');
    assert.equal(result.source, 'none');
    assert.deepEqual(result.models, []);
  });
});
