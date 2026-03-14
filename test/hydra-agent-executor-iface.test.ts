/**
 * TDD tests for IAgentExecutor interface and DefaultAgentExecutor class.
 *
 * These tests were written BEFORE the interface was implemented (Red phase).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Import the types/classes under test — these will fail until implemented
import type { IAgentExecutor } from '../lib/hydra-shared/agent-executor.ts';
import { DefaultAgentExecutor, type ExecuteAgentOpts } from '../lib/hydra-shared/agent-executor.ts';
import type { ExecuteResult } from '../lib/types.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeOkResult(output = 'hello'): ExecuteResult {
  return {
    ok: true,
    output,
    stderr: '',
    error: null,
    exitCode: 0,
    signal: null,
    durationMs: 1,
    timedOut: false,
  };
}

// ── IAgentExecutor interface tests ───────────────────────────────────────────

describe('IAgentExecutor interface', () => {
  it('can be implemented by a mock object', () => {
    const calls: Array<{ method: string; agent: string; prompt: string }> = [];

    const mock: IAgentExecutor = {
      executeAgent(agent: string, prompt: string, _opts?: ExecuteAgentOpts) {
        calls.push({ method: 'executeAgent', agent, prompt });
        return Promise.resolve(makeOkResult(`executeAgent:${agent}`));
      },
      executeAgentWithRecovery(agent: string, prompt: string, _opts?: ExecuteAgentOpts) {
        calls.push({ method: 'executeAgentWithRecovery', agent, prompt });
        return Promise.resolve(makeOkResult(`recovery:${agent}`));
      },
    };

    assert.equal(typeof mock.executeAgent, 'function');
    assert.equal(typeof mock.executeAgentWithRecovery, 'function');
  });

  it('mock executeAgent returns expected result', async () => {
    const mock: IAgentExecutor = {
      executeAgent(_agent: string, _prompt: string, _opts?: ExecuteAgentOpts) {
        return Promise.resolve(makeOkResult('mock-output'));
      },
      executeAgentWithRecovery(_agent: string, _prompt: string, _opts?: ExecuteAgentOpts) {
        return Promise.resolve(makeOkResult('mock-recovery'));
      },
    };

    const result = await mock.executeAgent('claude', 'test prompt');
    assert.equal(result.ok, true);
    assert.equal(result.output, 'mock-output');
  });

  it('mock executeAgentWithRecovery returns expected result', async () => {
    const mock: IAgentExecutor = {
      executeAgent(_agent: string, _prompt: string, _opts?: ExecuteAgentOpts) {
        return Promise.resolve(makeOkResult());
      },
      executeAgentWithRecovery(_agent: string, _prompt: string, _opts?: ExecuteAgentOpts) {
        return Promise.resolve(makeOkResult('recovery-output'));
      },
    };

    const result = await mock.executeAgentWithRecovery('gemini', 'test prompt');
    assert.equal(result.ok, true);
    assert.equal(result.output, 'recovery-output');
  });

  it('interface methods receive agent, prompt, and optional opts', async () => {
    const received: Array<{
      agent: string;
      prompt: string;
      opts: ExecuteAgentOpts | undefined;
    }> = [];

    const mock: IAgentExecutor = {
      executeAgent(agent: string, prompt: string, opts?: ExecuteAgentOpts) {
        received.push({ agent, prompt, opts });
        return Promise.resolve(makeOkResult());
      },
      executeAgentWithRecovery(agent: string, prompt: string, opts?: ExecuteAgentOpts) {
        received.push({ agent, prompt, opts });
        return Promise.resolve(makeOkResult());
      },
    };

    const opts: ExecuteAgentOpts = { timeoutMs: 5000, cwd: '/tmp' };
    await mock.executeAgent('codex', 'my prompt', opts);
    await mock.executeAgentWithRecovery('codex', 'recovery prompt');

    assert.equal(received.length, 2);
    assert.equal(received[0]?.agent, 'codex');
    assert.equal(received[0]?.prompt, 'my prompt');
    assert.deepEqual(received[0]?.opts, opts);
    assert.equal(received[1]?.agent, 'codex');
    assert.equal(received[1]?.opts, undefined);
  });
});

// ── DefaultAgentExecutor tests ────────────────────────────────────────────────

describe('DefaultAgentExecutor', () => {
  it('is a class that can be instantiated', () => {
    const executor = new DefaultAgentExecutor();
    assert.ok(executor instanceof DefaultAgentExecutor);
  });

  it('has executeAgent method', () => {
    const executor = new DefaultAgentExecutor();
    assert.equal(typeof executor.executeAgent, 'function');
  });

  it('has executeAgentWithRecovery method', () => {
    const executor = new DefaultAgentExecutor();
    assert.equal(typeof executor.executeAgentWithRecovery, 'function');
  });

  it('satisfies IAgentExecutor interface structurally', () => {
    const executor: IAgentExecutor = new DefaultAgentExecutor();
    assert.equal(typeof executor.executeAgent, 'function');
    assert.equal(typeof executor.executeAgentWithRecovery, 'function');
  });

  it('executeAgent rejects for unknown agent (delegates to real function)', async () => {
    const executor = new DefaultAgentExecutor();
    await assert.rejects(
      () => executor.executeAgent('__nonexistent_agent__', 'test'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('__nonexistent_agent__'));
        return true;
      },
    );
  });
});

// ── Consumer integration: runCrossVerification with injected executor ─────────

describe('runCrossVerification with IAgentExecutor', () => {
  it('accepts an optional executor parameter', async () => {
    const { runCrossVerification } = await import('../lib/hydra-operator-dispatch.ts');

    // Pass a mock executor that returns a fast stub result
    const mock: IAgentExecutor = {
      executeAgent(_agent: string, _prompt: string, _opts?: ExecuteAgentOpts) {
        return Promise.resolve({
          ok: true,
          output: JSON.stringify({ approved: true, issues: [], suggestions: [] }),
          stdout: JSON.stringify({ approved: true, issues: [], suggestions: [] }),
          stderr: '',
          error: null,
          exitCode: 0,
          signal: null,
          durationMs: 1,
          timedOut: false,
        });
      },
      executeAgentWithRecovery(_agent: string, _prompt: string, _opts?: ExecuteAgentOpts) {
        return Promise.resolve(makeOkResult());
      },
    };

    // Cross-verification is feature-gated; result will be null when disabled in test env
    const result = await runCrossVerification(
      'claude',
      'output text',
      'original prompt',
      null,
      mock,
    );
    // We only assert the call didn't throw — cross-verification may return null when cfg disabled
    assert.ok(result === null || typeof result === 'object');
  });
});
