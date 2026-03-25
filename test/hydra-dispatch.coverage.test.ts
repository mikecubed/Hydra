/**
 * Executor seam tests for lib/hydra-dispatch.ts.
 *
 * These assertions intentionally cover the exported executor override seam, not
 * the full live dispatch pipeline.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setDispatchExecutor } from '../lib/hydra-dispatch.ts';
import type { IAgentExecutor } from '../lib/hydra-shared/agent-executor.ts';
import type { ExecuteResult } from '../lib/types.ts';

function makeMockResult(output: string, ok = true): ExecuteResult {
  return {
    ok,
    output,
    stderr: ok ? '' : 'err',
    error: ok ? null : 'test error',
    exitCode: ok ? 0 : 1,
    signal: null,
    durationMs: 0,
    timedOut: false,
  } as ExecuteResult;
}

function makeMockExecutor(output: string, ok = true): IAgentExecutor {
  const fn = async () => makeMockResult(output, ok);
  return { executeAgent: fn, executeAgentWithRecovery: fn };
}

// ── setDispatchExecutor ──────────────────────────────────────────────────────

describe('setDispatchExecutor', () => {
  // Store the original executor so we can restore it after tests
  let original: IAgentExecutor | undefined;

  afterEach(() => {
    if (original) {
      setDispatchExecutor(original);
    }
  });

  it('returns the previous executor when setting a new one', () => {
    const mockExecutor = makeMockExecutor('mock');

    // First call captures the default executor
    const prev = setDispatchExecutor(mockExecutor);
    original = prev; // Save for restoration

    assert.ok(prev !== null && prev !== undefined);
    assert.equal(typeof prev.executeAgent, 'function');
  });

  it('replaces the executor and can be restored', () => {
    const mock1 = makeMockExecutor('mock1');
    const mock2 = makeMockExecutor('mock2');

    // Set first mock, capturing the default
    original = setDispatchExecutor(mock1);

    // Set second mock, should return mock1
    const displaced = setDispatchExecutor(mock2);
    assert.strictEqual(displaced, mock1);

    // Restore original
    const displaced2 = setDispatchExecutor(original);
    assert.strictEqual(displaced2, mock2);
  });

  it('returned executor has the correct interface', () => {
    const mock = makeMockExecutor('', false);

    original = setDispatchExecutor(mock);
    const returned = setDispatchExecutor(original);
    assert.strictEqual(returned, mock);
  });
});
