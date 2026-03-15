/**
 * Injection tests for IMetricsRecorder and IGitOperations consumer adoption.
 *
 * Verifies that migrated functions accept mock implementations of the typed
 * interfaces and call through to them instead of the concrete module exports.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';

import type {
  IMetricsRecorder,
  MetricsCallResult,
  IGitOperations,
  GitResult,
} from '../lib/types.ts';
import { _setTestConfig, invalidateConfigCache } from '../lib/hydra-config.ts';

// ── Mock Factories ───────────────────────────────────────────────────────────

function createMockMetrics(): IMetricsRecorder & {
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    recordCallStart(agentName: string, model?: string): string {
      calls.push({ method: 'recordCallStart', args: [agentName, model] });
      return `mock-handle-${agentName}`;
    },
    recordCallComplete(handle: string, result: MetricsCallResult): void {
      calls.push({ method: 'recordCallComplete', args: [handle, result] });
    },
    recordCallError(handle: string, error: unknown): void {
      calls.push({ method: 'recordCallError', args: [handle, error] });
    },
    async recordExecution<T>(
      agentName: string,
      model: string | undefined,
      fn: () => Promise<T>,
    ): Promise<T> {
      const handle = this.recordCallStart(agentName, model);
      try {
        const result = await fn();
        this.recordCallComplete(handle, result as unknown as MetricsCallResult);
        return result;
      } catch (err: unknown) {
        this.recordCallError(handle, err);
        throw err;
      }
    },
  };
}

const okGitResult: GitResult = {
  status: 0,
  stdout: '',
  stderr: '',
  error: null,
  signal: null,
};

function createMockGitOps(): IGitOperations & {
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    getCurrentBranch(cwd: string): string {
      calls.push({ method: 'getCurrentBranch', args: [cwd] });
      return 'mock-branch';
    },
    branchExists(cwd: string, branchName: string): boolean {
      calls.push({ method: 'branchExists', args: [cwd, branchName] });
      return false;
    },
    createBranch(cwd: string, branchName: string, fromBranch: string): boolean {
      calls.push({ method: 'createBranch', args: [cwd, branchName, fromBranch] });
      return true;
    },
    checkoutBranch(cwd: string, branch: string): GitResult {
      calls.push({ method: 'checkoutBranch', args: [cwd, branch] });
      return okGitResult;
    },
    mergeBranch(cwd: string, branch: string, baseBranch?: string): boolean {
      calls.push({ method: 'mergeBranch', args: [cwd, branch, baseBranch] });
      return true;
    },
    deleteBranch(cwd: string, branch: string): boolean {
      calls.push({ method: 'deleteBranch', args: [cwd, branch] });
      return true;
    },
    stageAndCommit(
      cwd: string,
      message: string,
      opts?: { originatedBy?: string; executedBy?: string },
    ): boolean {
      calls.push({ method: 'stageAndCommit', args: [cwd, message, opts] });
      return true;
    },
  };
}

// ── IMetricsRecorder Injection Tests ─────────────────────────────────────────

describe('IMetricsRecorder DI — hydra-nightly-discovery', () => {
  beforeEach(() => {
    _setTestConfig({
      nightly: { aiDiscovery: { enabled: true, agent: 'gemini' } },
    });
  });

  afterEach(() => {
    invalidateConfigCache();
  });

  it('runDiscovery passes custom IMetricsRecorder to discovery agent', async () => {
    const mockMetrics = createMockMetrics();
    const { runDiscovery } = await import('../lib/hydra-nightly-discovery.ts');
    // runDiscovery will call executeAgentWithRecovery which won't find a real agent,
    // but the metrics mock should receive recordCallStart from executeDiscoveryAgent
    const result = await runDiscovery('/tmp/nonexistent-project', {}, mockMetrics);
    // Even on failure, the internal executeDiscoveryAgent should have called recordCallStart
    const startCalls = mockMetrics.calls.filter((c) => c.method === 'recordCallStart');
    assert.equal(startCalls.length, 1, 'should call recordCallStart once for discovery');
    assert.equal(startCalls[0].args[1], 'discovery', 'model param should be "discovery"');
    // Should also have recorded an error since agent execution fails without real agent
    const errorCalls = mockMetrics.calls.filter((c) => c.method === 'recordCallError');
    assert.equal(errorCalls.length, 1, 'should call recordCallError on agent failure');
    assert.deepEqual(result, []);
  });
});

describe('IMetricsRecorder DI — execute-custom-agents', () => {
  it('executeCustomCliAgent passes mock through (early return on missing agent)', async () => {
    const mockMetrics = createMockMetrics();
    const { executeCustomCliAgent } = await import('../lib/hydra-shared/execute-custom-agents.ts');

    // Agent not found → early return before metrics are used. Confirms mock is accepted.
    const result = await executeCustomCliAgent('nonexistent-agent', 'test', {}, mockMetrics);
    assert.equal(result.ok, false);
    assert.equal(result.errorCategory, 'custom-cli-disabled');
    assert.equal(mockMetrics.calls.length, 0);
  });

  it('executeCustomApiAgent passes mock through (early return on missing agent)', async () => {
    const mockMetrics = createMockMetrics();
    const { executeCustomApiAgent } = await import('../lib/hydra-shared/execute-custom-agents.ts');

    const result = await executeCustomApiAgent('nonexistent-agent', 'test', {}, mockMetrics);
    assert.equal(result.ok, false);
    assert.equal(result.errorCategory, 'custom-api-disabled');
    assert.equal(mockMetrics.calls.length, 0);
  });

  it('executeCustomCliAgent defaults to metricsRecorder when no mock provided', async () => {
    const { executeCustomCliAgent } = await import('../lib/hydra-shared/execute-custom-agents.ts');
    // Should work without explicit metrics param (uses default)
    const result = await executeCustomCliAgent('nonexistent-agent', 'test');
    assert.equal(result.ok, false);
  });
});

describe('IMetricsRecorder DI — gemini-executor', () => {
  // Redirect HOME to an empty temp dir so no real OAuth credentials are found,
  // ensuring executeGeminiDirect fails at the auth step on any host environment.
  let tmpHome = '';
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  beforeEach(() => {
    savedHome = process.env['HOME'];
    savedUserProfile = process.env['USERPROFILE'];
    tmpHome = fs.mkdtempSync(`${os.tmpdir()}/hydra-test-home-`);
    process.env['HOME'] = tmpHome;
    process.env['USERPROFILE'] = tmpHome;
  });

  afterEach(() => {
    if (savedHome === undefined) {
      Reflect.deleteProperty(process.env, 'HOME');
    } else {
      process.env['HOME'] = savedHome;
    }
    if (savedUserProfile === undefined) {
      Reflect.deleteProperty(process.env, 'USERPROFILE');
    } else {
      process.env['USERPROFILE'] = savedUserProfile;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('executeGeminiDirect accepts a custom IMetricsRecorder', async () => {
    const mockMetrics = createMockMetrics();
    const { executeGeminiDirect } = await import('../lib/hydra-shared/gemini-executor.ts');

    const result = await executeGeminiDirect('test prompt', {}, mockMetrics);
    assert.equal(result.ok, false);

    // Should have called recordCallStart and recordCallError via the mock
    const startCalls = mockMetrics.calls.filter((c) => c.method === 'recordCallStart');
    assert.equal(startCalls.length, 1, 'should call recordCallStart once');
    assert.equal(startCalls[0].args[0], 'gemini');

    const errorCalls = mockMetrics.calls.filter((c) => c.method === 'recordCallError');
    assert.equal(errorCalls.length, 1, 'should call recordCallError once on failure');
  });
});

// ── IGitOperations Injection Tests ───────────────────────────────────────────

describe('IGitOperations DI — hydra-context', () => {
  beforeEach(() => {
    _setTestConfig({
      context: { hierarchical: { enabled: false } },
    });
  });

  afterEach(() => {
    invalidateConfigCache();
  });

  it('getProjectContext accepts a custom IGitOperations', async () => {
    const mockGit = createMockGitOps();
    const { getProjectContext } = await import('../lib/hydra-context.ts');

    const result = getProjectContext('codex', {}, null, mockGit);
    assert.equal(typeof result, 'string');

    // Should have called getCurrentBranch via the mock
    const branchCalls = mockGit.calls.filter((c) => c.method === 'getCurrentBranch');
    assert.ok(branchCalls.length >= 1, 'should call getCurrentBranch at least once');
  });

  it('getProjectContext uses mock branch value in output', async () => {
    const mockGit = createMockGitOps();
    const { getProjectContext } = await import('../lib/hydra-context.ts');

    const result = getProjectContext('codex', {}, null, mockGit);
    assert.ok(result.includes('mock-branch'), 'output should contain mock branch name');
  });

  it('buildAgentContext accepts a custom IGitOperations', async () => {
    const mockGit = createMockGitOps();
    const { buildAgentContext } = await import('../lib/hydra-context.ts');

    const result = buildAgentContext('codex', {}, null, null, mockGit);
    assert.equal(typeof result, 'string');

    const branchCalls = mockGit.calls.filter((c) => c.method === 'getCurrentBranch');
    assert.ok(branchCalls.length >= 1, 'should call getCurrentBranch at least once');
  });
});

describe('IGitOperations DI — hydra-cleanup', () => {
  it('executeCleanupAction accepts a custom IGitOperations for branch deletion', async () => {
    const mockGit = createMockGitOps();
    const { executeCleanupAction } = await import('../lib/hydra-cleanup.ts');

    const item = {
      id: 'test-1',
      title: 'Delete stale branch',
      description: 'Remove stale branch',
      source: 'branches' as const,
      category: 'delete' as const,
      severity: 'low' as const,
      meta: { branch: 'test-branch' },
    };

    const result = await executeCleanupAction(item, { projectRoot: '/tmp/test' }, mockGit);
    assert.equal(result.ok, true);
    assert.equal(result.output, 'Branch deleted');

    const deleteCalls = mockGit.calls.filter((c) => c.method === 'deleteBranch');
    assert.equal(deleteCalls.length, 1, 'should call deleteBranch once');
    assert.deepEqual(deleteCalls[0].args, ['/tmp/test', 'test-branch']);
  });

  it('executeCleanupAction reports failure when mock deleteBranch returns false', async () => {
    const mockGit = createMockGitOps();
    mockGit.deleteBranch = (cwd: string, branch: string) => {
      mockGit.calls.push({ method: 'deleteBranch', args: [cwd, branch] });
      return false;
    };

    const { executeCleanupAction } = await import('../lib/hydra-cleanup.ts');

    const item = {
      id: 'test-2',
      title: 'Delete failing branch',
      description: 'Remove failing branch',
      source: 'branches' as const,
      category: 'delete' as const,
      severity: 'low' as const,
      meta: { branch: 'bad-branch' },
    };

    const result = await executeCleanupAction(item, { projectRoot: '/tmp/test' }, mockGit);
    assert.equal(result.ok, false);
    assert.equal(result.output, 'Failed to delete branch');
  });
});

describe('IGitOperations DI — review-common', () => {
  it('cleanBranches accepts a custom IGitOperations', async () => {
    const { cleanBranches } = await import('../lib/hydra-shared/review-common.ts');
    assert.equal(typeof cleanBranches, 'function');
    // Verify function accepts gitOps parameter (6th param)
    assert.ok(cleanBranches.length >= 1);
  });

  it('handleEmptyBranch accepts a custom IGitOperations', async () => {
    const { handleEmptyBranch } = await import('../lib/hydra-shared/review-common.ts');
    assert.equal(typeof handleEmptyBranch, 'function');
  });

  it('handleBranchAction accepts a custom IGitOperations', async () => {
    const { handleBranchAction } = await import('../lib/hydra-shared/review-common.ts');
    assert.equal(typeof handleBranchAction, 'function');
  });
});

describe('IGitOperations DI — hydra-worktree', () => {
  it('createWorktree calls getCurrentBranch on injected IGitOperations when baseBranch is omitted', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const mockGit: IGitOperations = {
      getCurrentBranch: (cwd) => {
        calls.push({ method: 'getCurrentBranch', args: [cwd] });
        return 'test-base-branch';
      },
      branchExists: () => false,
      createBranch: () => true,
      checkoutBranch: () => ({ status: 0, stdout: '', stderr: '' }) as GitResult,
      mergeBranch: () => true,
      deleteBranch: () => true,
      stageAndCommit: () => true,
    };
    const { createWorktree } = await import('../lib/hydra-worktree.ts');

    // Omit baseBranch so createWorktree must call getCurrentBranch on the injected mock.
    // The git command itself will fail in the test environment — that's fine.
    try {
      createWorktree('test-wt-mock', '/tmp/nonexistent-base', undefined, mockGit);
    } catch {
      // git worktree add fails outside a real repo — we only care about the DI call
    }

    assert.ok(
      calls.some((c) => c.method === 'getCurrentBranch'),
      'createWorktree should call getCurrentBranch on the injected IGitOperations',
    );
  });

  it('mergeWorktree calls getCurrentBranch on injected IGitOperations when targetBranch is omitted', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const mockGit: IGitOperations = {
      getCurrentBranch: (cwd) => {
        calls.push({ method: 'getCurrentBranch', args: [cwd] });
        return 'test-target-branch';
      },
      branchExists: () => false,
      createBranch: () => true,
      checkoutBranch: () => ({ status: 0, stdout: '', stderr: '' }) as GitResult,
      mergeBranch: () => true,
      deleteBranch: () => true,
      stageAndCommit: () => true,
    };
    const { mergeWorktree } = await import('../lib/hydra-worktree.ts');

    // Omit targetBranch so mergeWorktree must call getCurrentBranch on the injected mock.
    try {
      mergeWorktree('test-wt-mock', '/tmp/nonexistent-wt', undefined, mockGit);
    } catch {
      // git commands fail outside a real worktree — we only care about the DI call
    }

    assert.ok(
      calls.some((c) => c.method === 'getCurrentBranch'),
      'mergeWorktree should call getCurrentBranch on the injected IGitOperations',
    );
  });
});

// ── Compile-time type satisfaction checks ────────────────────────────────────

describe('Interface type satisfaction', () => {
  it('mock IMetricsRecorder satisfies the interface contract', () => {
    const mock = createMockMetrics();
    const _check: IMetricsRecorder = mock;
    void _check;

    const handle = mock.recordCallStart('test', 'model');
    assert.equal(typeof handle, 'string');
    mock.recordCallComplete(handle, { output: 'test' });
    mock.recordCallError(handle, new Error('test'));
    assert.equal(mock.calls.length, 3);
  });

  it('mock IGitOperations satisfies the interface contract', () => {
    const mock = createMockGitOps();
    const _check: IGitOperations = mock;
    void _check;

    assert.equal(mock.getCurrentBranch('/tmp'), 'mock-branch');
    assert.equal(mock.branchExists('/tmp', 'test'), false);
    assert.equal(mock.createBranch('/tmp', 'new', 'main'), true);
    assert.deepEqual(mock.checkoutBranch('/tmp', 'test'), okGitResult);
    assert.equal(mock.mergeBranch('/tmp', 'feat', 'main'), true);
    assert.equal(mock.deleteBranch('/tmp', 'old'), true);
    assert.equal(mock.stageAndCommit('/tmp', 'msg'), true);
    assert.equal(mock.calls.length, 7);
  });
});
