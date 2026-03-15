/**
 * Contract tests for IContextProvider, IGitOperations, IMetricsRecorder, IConfigStore interfaces.
 *
 * Primary tests call real implementations and verify return values.
 * One mock test per interface verifies mockability.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type {
  HydraConfig,
  IContextProvider,
  IGitOperations,
  IMetricsRecorder,
  IConfigStore,
} from '../lib/types.ts';

// ── IContextProvider ──────────────────────────────────────────────────────────

describe('IContextProvider interface', () => {
  it('buildAgentContext returns a non-empty string for each built-in agent', async () => {
    const { buildAgentContext } = await import('../lib/hydra-context.ts');
    for (const agent of ['claude', 'gemini', 'codex']) {
      const ctx = buildAgentContext(agent, {}, { projectRoot: process.cwd() });
      assert.equal(typeof ctx, 'string', `expected string for ${agent}`);
      assert.ok(ctx.length > 0, `expected non-empty context for ${agent}`);
    }
  });

  it('buildAgentContext includes project-specific content', async () => {
    const { buildAgentContext } = await import('../lib/hydra-context.ts');
    const ctx = buildAgentContext('claude', {}, { projectRoot: process.cwd() });
    // The context should contain recognisable Hydra project references
    assert.ok(ctx.includes('hydra') || ctx.includes('Hydra'), 'context should mention the project');
  });

  it('can be implemented by a mock object', () => {
    const mock: IContextProvider = {
      buildAgentContext(agentName = 'claude') {
        return `context-for-${agentName}`;
      },
    };

    assert.equal(mock.buildAgentContext('gemini'), 'context-for-gemini');
  });
});

// ── IGitOperations ───────────────────────────────────────────────────────────

describe('IGitOperations interface', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('getCurrentBranch returns the current branch name from a real repo', async () => {
    const { getCurrentBranch } = await import('../lib/hydra-shared/git-ops.ts');
    const branch = getCurrentBranch(process.cwd());
    assert.equal(typeof branch, 'string');
    // In CI, git checkout produces a detached HEAD and getCurrentBranch returns ''.
    // That IS the correct behaviour — skip the non-empty assertion in that case.
    if (branch === '') return;
    assert.ok(branch.length > 0, 'branch name should be non-empty');
  });

  it('branchExists returns true for current branch, false for non-existent', async () => {
    const { branchExists, getCurrentBranch } = await import('../lib/hydra-shared/git-ops.ts');
    const cwd = process.cwd();
    const current = getCurrentBranch(cwd);
    // In CI, git checkout may produce a detached HEAD (empty branch name); skip the
    // branch-existence check in that case since there is no local branch to verify.
    if (current === '') return;
    assert.equal(branchExists(cwd, current), true, 'current branch should exist');
    assert.equal(
      branchExists(cwd, 'nonexistent-branch-abc123xyz'),
      false,
      'random branch should not exist',
    );
  });

  it('createBranch and deleteBranch work in a temp git repo', async () => {
    const { createBranch, branchExists, deleteBranch, checkoutBranch } =
      await import('../lib/hydra-shared/git-ops.ts');
    tempDir = mkdtempSync(join(tmpdir(), 'hydra-git-test-'));
    execSync('git init -b main', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: tempDir, stdio: 'ignore' });
    writeFileSync(join(tempDir, 'README.md'), '# test');
    execSync('git add . && git commit -m "init"', { cwd: tempDir, stdio: 'ignore' });

    const branchName = 'feat/test-branch';
    // createBranch checks out the new branch
    const created = createBranch(tempDir, branchName, 'main');
    assert.equal(created, true, 'createBranch should succeed');
    assert.equal(branchExists(tempDir, branchName), true, 'branch should exist after creation');

    // Switch back to main before deleting
    const co = checkoutBranch(tempDir, 'main');
    assert.equal(co.status, 0, 'checkoutBranch should succeed');

    const deleted = deleteBranch(tempDir, branchName);
    assert.equal(deleted, true, 'deleteBranch should succeed');
    assert.equal(
      branchExists(tempDir, branchName),
      false,
      'branch should not exist after deletion',
    );
  });

  it('gitOperations export satisfies IGitOperations at compile time', async () => {
    const { gitOperations } = await import('../lib/hydra-shared/git-ops.ts');
    // Compile-time contract check — assignment fails if signatures drift
    const _: IGitOperations = gitOperations;
    assert.equal(typeof _.getCurrentBranch, 'function');
    assert.equal(typeof _.stageAndCommit, 'function');
  });

  it('can be implemented by a mock object', () => {
    const mock: IGitOperations = {
      getCurrentBranch() {
        return 'main';
      },
      branchExists() {
        return false;
      },
      createBranch() {
        return true;
      },
      checkoutBranch() {
        return { status: 0, stdout: '', stderr: '', error: null, signal: null };
      },
      mergeBranch() {
        return true;
      },
      deleteBranch() {
        return true;
      },
      stageAndCommit() {
        return true;
      },
    };

    assert.equal(mock.getCurrentBranch('/tmp'), 'main');
    assert.equal(mock.branchExists('/tmp', 'feat/x'), false);
  });
});

// ── IMetricsRecorder ─────────────────────────────────────────────────────────

describe('IMetricsRecorder interface', () => {
  afterEach(async () => {
    const { resetMetrics } = await import('../lib/hydra-metrics.ts');
    resetMetrics();
  });

  it('recordCallStart returns a unique string handle', async () => {
    const { recordCallStart } = await import('../lib/hydra-metrics.ts');
    const h1 = recordCallStart('claude', 'claude-opus-4-6');
    const h2 = recordCallStart('gemini', 'gemini-3-pro');
    assert.equal(typeof h1, 'string');
    assert.equal(typeof h2, 'string');
    assert.ok(h1.startsWith('call_'), 'handle should start with call_');
    assert.notEqual(h1, h2, 'handles should be unique');
  });

  it('recordCallComplete records metrics for a started call', async () => {
    const { recordCallStart, recordCallComplete, getAgentMetrics } =
      await import('../lib/hydra-metrics.ts');
    const handle = recordCallStart('claude', 'claude-opus-4-6');
    recordCallComplete(handle, { stdout: 'hello world', outcome: 'success' });

    const agentMetrics = getAgentMetrics('claude');
    assert.ok(agentMetrics, 'agent metrics should exist after recording');
    assert.ok(agentMetrics.callsTotal >= 1, 'should have at least 1 call recorded');
  });

  it('recordCallError increments the failure counter', async () => {
    const { recordCallStart, recordCallError, getAgentMetrics } =
      await import('../lib/hydra-metrics.ts');
    const handle = recordCallStart('gemini', 'gemini-3-pro');
    recordCallError(handle, new Error('timeout'));

    const agentMetrics = getAgentMetrics('gemini');
    assert.ok(agentMetrics, 'agent metrics should exist after error');
    assert.ok(agentMetrics.callsFailed >= 1, 'should have at least 1 failed call');
  });

  it('metricsRecorder export satisfies IMetricsRecorder at compile time', async () => {
    const { metricsRecorder } = await import('../lib/hydra-metrics.ts');
    // Compile-time check: assignment fails if metricsRecorder doesn't satisfy IMetricsRecorder
    const recorder: IMetricsRecorder = metricsRecorder;
    assert.equal(typeof recorder.recordCallStart, 'function');
    assert.equal(typeof recorder.recordCallComplete, 'function');
    assert.equal(typeof recorder.recordCallError, 'function');
  });

  it('can be implemented by a mock object', () => {
    const mock: IMetricsRecorder = {
      recordCallStart(agentName) {
        return `handle_${agentName}`;
      },
      recordCallComplete() {},
      recordCallError() {},
      async recordExecution<T>(_agent: string, _model: string | undefined, fn: () => Promise<T>) {
        return fn();
      },
    };

    const handle = mock.recordCallStart('claude', 'claude-opus-4-6');
    assert.equal(handle, 'handle_claude');
  });
});

// ── IConfigStore ─────────────────────────────────────────────────────────────

describe('IConfigStore interface', () => {
  it('configStore export satisfies IConfigStore at compile time', async () => {
    const { configStore } = await import('../lib/hydra-config.ts');
    const store: IConfigStore = configStore;
    assert.equal(typeof store.load, 'function');
    assert.equal(typeof store.save, 'function');
    assert.equal(typeof store.invalidate, 'function');
  });

  it('configStore.load returns an object with expected top-level keys', async () => {
    const { configStore } = await import('../lib/hydra-config.ts');
    const cfg = configStore.load();
    assert.equal(typeof cfg, 'object');
    assert.ok('mode' in cfg, 'config should have a mode field');
    assert.ok('routing' in cfg, 'config should have a routing field');
    assert.ok('models' in cfg, 'config should have a models field');
  });

  it('configStore.invalidate clears cache so next load re-reads', async () => {
    const { configStore } = await import('../lib/hydra-config.ts');
    const cfg1 = configStore.load();
    configStore.invalidate();
    const cfg2 = configStore.load();
    // After invalidation, a fresh object is returned (different reference)
    assert.notStrictEqual(cfg1, cfg2);
  });

  it('can be implemented by a mock object', () => {
    const mock: IConfigStore = {
      load() {
        return { mode: 'performance', models: {}, routing: {} } as unknown as HydraConfig;
      },
      save(config) {
        return { ...config, mode: 'performance' } as unknown as HydraConfig;
      },
      invalidate() {},
    };

    const cfg = mock.load();
    assert.equal(cfg.mode, 'performance');
    mock.invalidate(); // should not throw
  });
});
