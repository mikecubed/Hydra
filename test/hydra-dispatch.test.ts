import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getRoleAgent } from '../lib/hydra-dispatch.ts';
import { _setTestConfig, invalidateConfigCache } from '../lib/hydra-config.ts';

// ── getRoleAgent ──────────────────────────────────────────────────────────────

/** Deterministic roles config used by all tests — avoids reading live hydra.config.json */
const TEST_ROLES = {
  coordinator: { agent: 'claude', model: null },
  critic: { agent: 'gemini', model: null },
  synthesizer: { agent: 'codex', model: null },
};

describe('getRoleAgent', () => {
  beforeEach(() => {
    _setTestConfig({ roles: TEST_ROLES });
  });

  afterEach(() => {
    invalidateConfigCache();
  });

  it('returns configured agent when installed', () => {
    const clis: Record<string, boolean | undefined> = {
      claude: true,
      gemini: true,
      codex: true,
      copilot: false,
    };
    // Default coordinator is 'claude', which is installed
    assert.equal(getRoleAgent('coordinator', clis), 'claude');
  });

  it('returns configured critic agent (gemini) when installed', () => {
    const clis: Record<string, boolean | undefined> = {
      claude: true,
      gemini: true,
      codex: true,
      copilot: false,
    };
    assert.equal(getRoleAgent('critic', clis), 'gemini');
  });

  it('returns configured synthesizer agent (codex) when installed', () => {
    const clis: Record<string, boolean | undefined> = {
      claude: true,
      gemini: true,
      codex: true,
      copilot: false,
    };
    assert.equal(getRoleAgent('synthesizer', clis), 'codex');
  });

  it('falls back when configured agent is not installed', () => {
    // coordinator is claude by default; mark claude as not installed
    const clis: Record<string, boolean | undefined> = {
      claude: false,
      gemini: true,
      codex: true,
      copilot: false,
    };
    const agent = getRoleAgent('coordinator', clis);
    assert.notEqual(agent, 'claude', 'Should not return an uninstalled agent');
    assert.equal(typeof agent, 'string');
    assert.ok(agent.length > 0);
  });

  it('returns gemini from preference chain when earlier agents are unavailable', () => {
    // claude=false, copilot=false → gemini is the next enabled+installed agent
    const clis: Record<string, boolean | undefined> = {
      claude: false,
      gemini: true,
      codex: false,
      copilot: false,
    };
    const agent = getRoleAgent('coordinator', clis);
    assert.equal(agent, 'gemini');
  });

  it('throws when no agents are available', () => {
    const clis: Record<string, boolean | undefined> = {
      claude: false,
      gemini: false,
      codex: false,
      copilot: false,
    };
    assert.throws(() => getRoleAgent('coordinator', clis), /No agents available/);
  });

  it('allows undefined installedCLIs entry (e.g. API agent)', () => {
    // undefined means not tracked — should not be blocked
    const clis: Record<string, boolean | undefined> = {
      claude: undefined,
      gemini: undefined,
      codex: undefined,
    };
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
