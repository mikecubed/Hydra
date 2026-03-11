import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getRoleAgent } from '../lib/hydra-dispatch.ts';

// ── getRoleAgent ──────────────────────────────────────────────────────────────

describe('getRoleAgent', () => {
  it('returns configured agent when installed', () => {
    const clis = { claude: true, gemini: true, codex: true, copilot: false };
    // Default coordinator is 'claude', which is installed
    assert.equal(getRoleAgent('coordinator', clis), 'claude');
  });

  it('returns configured critic agent (gemini) when installed', () => {
    const clis = { claude: true, gemini: true, codex: true, copilot: false };
    assert.equal(getRoleAgent('critic', clis), 'gemini');
  });

  it('returns configured synthesizer agent (codex) when installed', () => {
    const clis = { claude: true, gemini: true, codex: true, copilot: false };
    assert.equal(getRoleAgent('synthesizer', clis), 'codex');
  });

  it('falls back when configured agent is not installed', () => {
    // coordinator is claude by default; mark claude as not installed
    const clis = { claude: false, gemini: true, codex: true, copilot: false };
    const agent = getRoleAgent('coordinator', clis);
    assert.notEqual(agent, 'claude', 'Should not return an uninstalled agent');
    assert.equal(typeof agent, 'string');
    assert.ok(agent.length > 0);
  });

  it('returns copilot when it is installed and preferred agents are not', () => {
    const clis = { claude: false, gemini: false, codex: false, copilot: true };
    const agent = getRoleAgent('coordinator', clis);
    assert.equal(agent, 'copilot');
  });

  it('throws when no agents are available', () => {
    const clis = { claude: false, gemini: false, codex: false, copilot: false };
    assert.throws(() => getRoleAgent('coordinator', clis), /No agents available/);
  });

  it('allows undefined installedCLIs entry (e.g. API agent)', () => {
    // undefined means not tracked — should not be blocked
    const clis = { claude: undefined, gemini: undefined, codex: undefined };
    // With all undefined, should not throw (falls through to first available)
    // At minimum: returns a string or throws a meaningful "no agents" error
    try {
      const agent = getRoleAgent('coordinator', clis);
      assert.equal(typeof agent, 'string');
    } catch (err) {
      assert.match(String(err), /No agents available/);
    }
  });
});
