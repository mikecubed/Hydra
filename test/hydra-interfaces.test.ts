/**
 * TDD contract tests for IContextProvider, IGitOperations, IMetricsRecorder interfaces.
 *
 * Written BEFORE the interfaces were added to lib/types.ts (Red phase).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { IContextProvider, IGitOperations, IMetricsRecorder } from '../lib/types.ts';

// ── IContextProvider ──────────────────────────────────────────────────────────

describe('IContextProvider interface', () => {
  it('buildAgentContext satisfies IContextProvider contract', async () => {
    const { buildAgentContext } = await import('../lib/hydra-context.ts');
    // Type-level assertion: cast verifies structural compatibility at compile time
    const provider: IContextProvider = { buildAgentContext };
    assert.equal(typeof provider.buildAgentContext, 'function');
  });

  it('can be implemented by a mock object', () => {
    const calls: string[] = [];

    const mock: IContextProvider = {
      buildAgentContext(
        agentName = 'claude',
        _taskContext = {},
        _projectConfig = null,
        _promptText = null,
      ) {
        calls.push(agentName);
        return `context-for-${agentName}`;
      },
    };

    assert.equal(typeof mock.buildAgentContext, 'function');
    const result = mock.buildAgentContext('gemini');
    assert.equal(result, 'context-for-gemini');
    assert.deepEqual(calls, ['gemini']);
  });

  it('mock returns a string context', () => {
    const mock: IContextProvider = {
      buildAgentContext() {
        return 'mocked-context-string';
      },
    };

    const ctx = mock.buildAgentContext('codex', { files: ['src/foo.ts'] }, null, 'some prompt');
    assert.equal(typeof ctx, 'string');
    assert.equal(ctx, 'mocked-context-string');
  });
});

// ── IGitOperations ───────────────────────────────────────────────────────────

describe('IGitOperations interface', () => {
  it('git-ops module exports satisfy IGitOperations contract', async () => {
    const gitOps = await import('../lib/hydra-shared/git-ops.ts');
    const impl: IGitOperations = {
      getCurrentBranch: gitOps.getCurrentBranch,
      branchExists: gitOps.branchExists,
      createBranch: gitOps.createBranch,
      checkoutBranch: gitOps.checkoutBranch,
      mergeBranch: gitOps.mergeBranch,
      deleteBranch: gitOps.deleteBranch,
      stageAndCommit: gitOps.stageAndCommit,
    };
    assert.equal(typeof impl.getCurrentBranch, 'function');
    assert.equal(typeof impl.branchExists, 'function');
    assert.equal(typeof impl.createBranch, 'function');
    assert.equal(typeof impl.checkoutBranch, 'function');
    assert.equal(typeof impl.mergeBranch, 'function');
    assert.equal(typeof impl.deleteBranch, 'function');
    assert.equal(typeof impl.stageAndCommit, 'function');
  });

  it('can be implemented by a mock object', () => {
    const ops: string[] = [];

    const mock: IGitOperations = {
      getCurrentBranch(_cwd) {
        ops.push('getCurrentBranch');
        return 'main';
      },
      branchExists(_cwd, _name) {
        ops.push('branchExists');
        return false;
      },
      createBranch(_cwd, _name, _from) {
        ops.push('createBranch');
        return true;
      },
      checkoutBranch(_cwd, _branch) {
        ops.push('checkoutBranch');
        return { status: 0, stdout: '', stderr: '', error: null, signal: null };
      },
      mergeBranch(_cwd, _branch, _base) {
        ops.push('mergeBranch');
        return true;
      },
      deleteBranch(_cwd, _branch) {
        ops.push('deleteBranch');
        return true;
      },
      stageAndCommit(_cwd, _message, _opts) {
        ops.push('stageAndCommit');
        return true;
      },
    };

    assert.equal(mock.getCurrentBranch('/tmp'), 'main');
    assert.equal(mock.branchExists('/tmp', 'feat/x'), false);
    assert.equal(mock.createBranch('/tmp', 'feat/x', 'main'), true);
    assert.deepEqual(mock.checkoutBranch('/tmp', 'main'), {
      status: 0,
      stdout: '',
      stderr: '',
      error: null,
      signal: null,
    });
    assert.equal(mock.mergeBranch('/tmp', 'feat/x'), true);
    assert.equal(mock.deleteBranch('/tmp', 'feat/x'), true);
    assert.equal(mock.stageAndCommit('/tmp', 'chore: test'), true);
    assert.deepEqual(ops, [
      'getCurrentBranch',
      'branchExists',
      'createBranch',
      'checkoutBranch',
      'mergeBranch',
      'deleteBranch',
      'stageAndCommit',
    ]);
  });
});

// ── IMetricsRecorder ─────────────────────────────────────────────────────────

describe('IMetricsRecorder interface', () => {
  it('hydra-metrics exports satisfy IMetricsRecorder contract', async () => {
    const metrics = await import('../lib/hydra-metrics.ts');
    const impl: IMetricsRecorder = {
      recordCallStart: metrics.recordCallStart,
      recordCallComplete: metrics.recordCallComplete,
      recordCallError: metrics.recordCallError,
    };
    assert.equal(typeof impl.recordCallStart, 'function');
    assert.equal(typeof impl.recordCallComplete, 'function');
    assert.equal(typeof impl.recordCallError, 'function');
  });

  it('can be implemented by a mock object', () => {
    const log: Array<{ op: string; args: unknown[] }> = [];

    const mock: IMetricsRecorder = {
      recordCallStart(agentName, model) {
        log.push({ op: 'start', args: [agentName, model] });
        return `handle_${agentName}`;
      },
      recordCallComplete(handle, result) {
        log.push({ op: 'complete', args: [handle, result] });
      },
      recordCallError(handle, error) {
        log.push({ op: 'error', args: [handle, error] });
      },
    };

    const handle = mock.recordCallStart('claude', 'claude-opus-4-6');
    assert.equal(handle, 'handle_claude');

    mock.recordCallComplete(handle, { stdout: 'ok output', outcome: 'success' });
    mock.recordCallError('handle_gemini', new Error('timeout'));

    assert.equal(log.length, 3);
    assert.equal(log[0]?.op, 'start');
    assert.equal(log[1]?.op, 'complete');
    assert.equal(log[2]?.op, 'error');
  });

  it('mock recordCallStart returns a string handle', () => {
    const mock: IMetricsRecorder = {
      recordCallStart(agentName) {
        return `handle_${agentName}_${String(Date.now())}`;
      },
      recordCallComplete(_handle, _result) {},
      recordCallError(_handle, _error) {},
    };

    const h = mock.recordCallStart('codex');
    assert.equal(typeof h, 'string');
    assert.ok(h.startsWith('handle_codex_'));
  });
});
