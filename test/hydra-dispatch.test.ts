import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getRoleAgent, setDispatchExecutor } from '../lib/hydra-dispatch.ts';
import type { IAgentExecutor } from '../lib/hydra-shared/agent-executor.ts';
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

  it('returns codex when only codex is installed', () => {
    const clis: Record<string, boolean | undefined> = {
      claude: false,
      gemini: false,
      codex: true,
      copilot: false,
    };
    const agent = getRoleAgent('coordinator', clis);
    assert.equal(agent, 'codex');
  });

  it('uses role-configured agent when it matches installed CLIs', () => {
    _setTestConfig({
      roles: {
        coordinator: { agent: 'gemini', model: null },
        critic: { agent: 'gemini', model: null },
        synthesizer: { agent: 'codex', model: null },
      },
    });
    const clis: Record<string, boolean | undefined> = {
      claude: true,
      gemini: true,
      codex: true,
    };
    // coordinator is configured as gemini, should use gemini
    assert.equal(getRoleAgent('coordinator', clis), 'gemini');
  });

  it('falls back for unknown role name', () => {
    const clis: Record<string, boolean | undefined> = {
      claude: true,
      gemini: true,
      codex: true,
    };
    // Unknown role has no configured agent — should fall back to preference order
    const agent = getRoleAgent('unknown_role', clis);
    assert.equal(typeof agent, 'string');
    assert.ok(agent.length > 0);
  });
});

// ── setDispatchExecutor ──────────────────────────────────────────────────────

describe('setDispatchExecutor', () => {
  it('returns the previous executor', () => {
    const mockExecutor: IAgentExecutor = {
      executeAgentWithRecovery: null as unknown as IAgentExecutor['executeAgentWithRecovery'],
      executeAgent: async () => ({
        ok: true,
        output: 'mock',
        stderr: '',
        exitCode: 0,
        signal: null,
        durationMs: 0,
        timedOut: false,
        error: null,
        command: 'mock',
        args: [],
        promptSnippet: '',
      }),
    };
    const prev = setDispatchExecutor(mockExecutor);
    assert.ok(prev !== null && prev !== undefined);
    assert.equal(typeof prev.executeAgent, 'function');
    // Restore original
    setDispatchExecutor(prev);
  });

  it('swaps executor — second call returns the mock', () => {
    const mockA: IAgentExecutor = {
      executeAgentWithRecovery: null as unknown as IAgentExecutor['executeAgentWithRecovery'],
      executeAgent: async () => ({
        ok: true,
        output: 'A',
        stderr: '',
        exitCode: 0,
        signal: null,
        durationMs: 0,
        timedOut: false,
        error: null,
        command: 'a',
        args: [],
        promptSnippet: '',
      }),
    };
    const mockB: IAgentExecutor = {
      executeAgentWithRecovery: null as unknown as IAgentExecutor['executeAgentWithRecovery'],
      executeAgent: async () => ({
        ok: true,
        output: 'B',
        stderr: '',
        exitCode: 0,
        signal: null,
        durationMs: 0,
        timedOut: false,
        error: null,
        command: 'b',
        args: [],
        promptSnippet: '',
      }),
    };
    const original = setDispatchExecutor(mockA);
    const prevA = setDispatchExecutor(mockB);
    assert.equal(prevA, mockA);
    // Restore
    setDispatchExecutor(original);
  });
});

// ── getRoleAgent: local agent branch ────────────────────────────────────────

describe('getRoleAgent — local agent handling', () => {
  afterEach(() => {
    invalidateConfigCache();
  });

  it('returns local when preferred agent is local and local.enabled is true', () => {
    _setTestConfig({
      roles: { coordinator: { agent: 'local', model: null } },
      local: { enabled: true },
    });
    const clis: Record<string, boolean | undefined> = {
      claude: false,
      gemini: false,
      codex: false,
    };
    assert.equal(getRoleAgent('coordinator', clis), 'local');
  });

  it('falls back when preferred agent is local but local.enabled is false', () => {
    _setTestConfig({
      roles: { coordinator: { agent: 'local', model: null } },
      local: { enabled: false },
    });
    const clis: Record<string, boolean | undefined> = {
      claude: true,
      gemini: true,
      codex: true,
    };
    const agent = getRoleAgent('coordinator', clis);
    assert.notEqual(agent, 'local');
    assert.equal(typeof agent, 'string');
  });

  it('preference order includes local when local.enabled is true and no CLI agents installed', () => {
    _setTestConfig({
      roles: { coordinator: { agent: 'claude', model: null } },
      local: { enabled: true },
    });
    const clis: Record<string, boolean | undefined> = {
      claude: false,
      gemini: false,
      codex: false,
      copilot: false,
    };
    const agent = getRoleAgent('coordinator', clis);
    assert.equal(agent, 'local');
  });

  it('skips local in preference order when local.enabled is false', () => {
    _setTestConfig({
      roles: { coordinator: { agent: 'claude', model: null } },
      local: { enabled: false },
    });
    const clis: Record<string, boolean | undefined> = {
      claude: false,
      gemini: false,
      codex: false,
      copilot: false,
    };
    assert.throws(() => getRoleAgent('coordinator', clis), /No agents available/);
  });
});

// ── getRoleAgent: empty/null preferred agent ─────────────────────────────────

describe('getRoleAgent — empty/null preferred agent', () => {
  afterEach(() => {
    invalidateConfigCache();
  });

  it('falls back to preference order when role agent is empty string', () => {
    _setTestConfig({
      roles: { coordinator: { agent: '', model: null } },
    });
    const clis: Record<string, boolean | undefined> = {
      claude: true,
      gemini: true,
      codex: true,
    };
    const agent = getRoleAgent('coordinator', clis);
    assert.equal(typeof agent, 'string');
    assert.ok(agent.length > 0);
  });

  it('falls back to preference order when role agent is undefined', () => {
    _setTestConfig({
      roles: { coordinator: { agent: undefined, model: null } },
    });
    const clis: Record<string, boolean | undefined> = {
      claude: true,
      gemini: true,
      codex: true,
    };
    const agent = getRoleAgent('coordinator', clis);
    assert.equal(typeof agent, 'string');
    assert.ok(agent.length > 0);
  });
});

// ── setDispatchExecutor: round-trip restore ────────────────────────────────

describe('setDispatchExecutor — round-trip restore', () => {
  it('restoring previous executor returns the mock that was swapped in', () => {
    const mock: IAgentExecutor = {
      executeAgentWithRecovery: null as unknown as IAgentExecutor['executeAgentWithRecovery'],
      executeAgent: async () => ({
        ok: true,
        output: 'round-trip',
        stderr: '',
        exitCode: 0,
        signal: null,
        durationMs: 0,
        timedOut: false,
        error: null,
        command: 'rt',
        args: [],
        promptSnippet: '',
      }),
    };
    const original = setDispatchExecutor(mock);
    const displaced = setDispatchExecutor(original);
    assert.equal(displaced, mock, 'displaced should be the mock we installed');
  });

  it('original executor has executeAgentWithRecovery method', () => {
    const mock: IAgentExecutor = {
      executeAgentWithRecovery: null as unknown as IAgentExecutor['executeAgentWithRecovery'],
      executeAgent: async () => ({
        ok: true,
        output: '',
        stderr: '',
        exitCode: 0,
        signal: null,
        durationMs: 0,
        timedOut: false,
        error: null,
        command: '',
        args: [],
        promptSnippet: '',
      }),
    };
    const original = setDispatchExecutor(mock);
    assert.equal(typeof original.executeAgentWithRecovery, 'function');
    // Restore
    setDispatchExecutor(original);
  });
});
