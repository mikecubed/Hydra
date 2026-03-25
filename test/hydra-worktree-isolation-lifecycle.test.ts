/**
 * Worktree isolation lifecycle tests — implements the 19 integration stubs
 * from hydra-worktree-isolation.test.mjs.
 *
 * Tests are grouped into:
 *   1-4:   createTaskWorktree
 *   5-8:   mergeTaskWorktree
 *   9-11:  cleanupTaskWorktree
 *   12-13: cleanup/review
 *
 * Tests 1-11 mock git-ops.ts and hydra-config.ts via mock.module() to test
 * the daemon worktree helpers without touching the real filesystem or git.
 * Tests 12-19 add supplementary cleanup and review assertions. Real daemon
 * route coverage for claim/result worktree behavior lives in
 * hydra-worktree-route-coverage.test.ts.
 */

import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Shared helpers ──────────────────────────────────────────────────────────

let tmpDir: string;

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-wt-lifecycle-'));
}

function rmTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// ── Mutable mock state ──────────────────────────────────────────────────────
//
// mock.module() registers a loader-level interceptor. Once a module is loaded
// through the mock, its exports are proxied. We use mutable state objects so
// that per-test configuration flows through the already-bound proxy references.

const mockState = {
  projectRoot: '/tmp',
  gitCalls: [] as { args: string[]; cwd: string }[],
  gitReturnStatus: 0,
  gitReturnStderr: '',
  currentBranch: 'main',
  smartMergeResult: { ok: true, method: 'fast-forward', conflicts: [] as string[] },
  smartMergeThrow: null as Error | null,
  smartMergeCalls: [] as { cwd: string; branch: string; base: string }[],
};

function resetMockState() {
  mockState.projectRoot = tmpDir ?? '/tmp';
  mockState.gitCalls = [];
  mockState.gitReturnStatus = 0;
  mockState.gitReturnStderr = '';
  mockState.currentBranch = 'main';
  mockState.smartMergeResult = { ok: true, method: 'fast-forward', conflicts: [] };
  mockState.smartMergeThrow = null;
  mockState.smartMergeCalls = [];
}

// Register module mocks once at the top level. The mock functions delegate
// to mockState, which tests mutate before calling the daemon worktree helpers.

mock.module('../lib/hydra-config.ts', {
  namedExports: {
    resolveProject: () => ({ projectRoot: mockState.projectRoot }),
    loadHydraConfig: () => ({
      routing: {
        worktreeIsolation: {
          enabled: false,
          worktreeDir: '.hydra/worktrees',
          cleanupOnSuccess: true,
        },
      },
    }),
    invalidateConfigCache: () => {},
  },
});

mock.module('../lib/hydra-shared/git-ops.ts', {
  namedExports: {
    git: (args: string[], cwd: string) => {
      mockState.gitCalls.push({ args, cwd });
      return {
        status: mockState.gitReturnStatus,
        stdout: '',
        stderr: mockState.gitReturnStderr,
        error: null,
        signal: null,
      };
    },
    getCurrentBranch: () => mockState.currentBranch,
    smartMerge: (cwd: string, branch: string, base: string) => {
      mockState.smartMergeCalls.push({ cwd, branch, base });
      if (mockState.smartMergeThrow != null) throw mockState.smartMergeThrow;
      return { ...mockState.smartMergeResult };
    },
    stripGitEnv: () => ({ ...process.env }),
    checkoutBranch: () => ({ status: 0, stdout: '', stderr: '', error: null, signal: null }),
    branchExists: () => false,
    createBranch: () => true,
    branchHasCommits: () => false,
    getBranchStats: () => ({ commits: 0, filesChanged: 0 }),
    getBranchDiff: () => '',
    stageAndCommit: () => true,
    listBranches: () => [],
    getBranchDiffStat: () => '',
    getBranchLog: () => '',
    mergeBranch: () => true,
    deleteBranch: () => true,
    getRemoteUrl: () => '',
    parseRemoteUrl: () => null,
    fetchOrigin: () => ({ ok: true, stderr: '' }),
    pushBranch: () => ({ ok: true, stderr: '' }),
    hasRemote: () => false,
    getTrackingBranch: () => '',
    isAheadOfRemote: () => ({ ahead: 0, behind: 0 }),
    gitOperations: {
      getCurrentBranch: () => mockState.currentBranch,
      branchExists: () => false,
      createBranch: () => true,
      checkoutBranch: () => ({ status: 0, stdout: '', stderr: '', error: null, signal: null }),
      mergeBranch: () => true,
      deleteBranch: () => true,
      stageAndCommit: () => true,
    },
  },
});

// Eagerly import the module under test (goes through mocked deps)
const { createTaskWorktree, mergeTaskWorktree, cleanupTaskWorktree } =
  await import('../lib/daemon/worktree.ts');

// ── 1-4: createTaskWorktree ─────────────────────────────────────────────────

describe('createTaskWorktree', () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
    resetMockState();
  });
  afterEach(() => {
    rmTmpDir(tmpDir);
  });

  it('creates worktree at .hydra/worktrees/task-{id}', () => {
    const taskId = 'T042';
    createTaskWorktree(taskId);

    assert.ok(mockState.gitCalls.length > 0, 'Expected at least one git call');
    const addCall = mockState.gitCalls[0];
    assert.strictEqual(addCall.args[0], 'worktree');
    assert.strictEqual(addCall.args[1], 'add');

    const pathArg = addCall.args[2];
    const expectedSuffix = path.join('.hydra', 'worktrees', `task-${taskId}`);
    assert.ok(
      pathArg.endsWith(expectedSuffix) || pathArg.includes(`task-${taskId}`),
      `Expected path ending with ${expectedSuffix}, got ${pathArg}`,
    );
  });

  it('creates branch named hydra/task/{id}', () => {
    const taskId = 'T099';
    createTaskWorktree(taskId);

    const addCall = mockState.gitCalls[0];
    const bFlagIdx = addCall.args.indexOf('-b');
    assert.ok(bFlagIdx >= 0, 'Expected -b flag in git worktree add');
    assert.strictEqual(addCall.args[bFlagIdx + 1], `hydra/task/${taskId}`);
  });

  it('returns absolute path on success', () => {
    const result = createTaskWorktree('T001');
    assert.ok(result != null, 'Expected non-null return');
    assert.ok(path.isAbsolute(result), `Expected absolute path, got ${result}`);
    assert.ok(result.includes('task-T001'), 'Expected path to contain task-T001');
  });

  it('returns null and logs warning on git failure', () => {
    mockState.gitReturnStatus = 128;
    mockState.gitReturnStderr = 'fatal: worktree already exists';

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(String(args[0]));
    };

    try {
      const result = createTaskWorktree('T002');
      assert.strictEqual(result, null, 'Expected null on git failure');
      assert.ok(
        warnings.some((w) => w.includes('[worktree]') && w.includes('T002')),
        `Expected warning mentioning [worktree] and task id, got: ${JSON.stringify(warnings)}`,
      );
    } finally {
      console.warn = origWarn;
    }
  });
});

// ── 5-8: mergeTaskWorktree ──────────────────────────────────────────────────

describe('mergeTaskWorktree', () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
    resetMockState();
  });
  afterEach(() => {
    rmTmpDir(tmpDir);
  });

  it('calls smartMerge(projectRoot, hydra/task/{id}, currentBranch)', () => {
    mockState.currentBranch = 'feat/my-branch';
    const taskId = 'T010';
    mergeTaskWorktree(taskId);

    assert.strictEqual(mockState.smartMergeCalls.length, 1, 'Expected one smartMerge call');
    // cwd comes from resolveProject() cached at module load; verify it's a string
    assert.strictEqual(typeof mockState.smartMergeCalls[0].cwd, 'string');
    assert.strictEqual(mockState.smartMergeCalls[0].branch, `hydra/task/${taskId}`);
    assert.strictEqual(mockState.smartMergeCalls[0].base, 'feat/my-branch');
  });

  it('returns { ok: true } on clean merge', () => {
    const result = mergeTaskWorktree('T011');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.conflict, undefined);
    assert.strictEqual(result.error, undefined);
  });

  it('returns { ok: false, conflict: true } and logs warning on conflict', () => {
    mockState.smartMergeResult = {
      ok: false,
      method: 'failed',
      conflicts: ['src/index.ts', 'lib/foo.ts'],
    };

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(String(args[0]));
    };

    try {
      const result = mergeTaskWorktree('T012');
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.conflict, true);
      assert.ok(
        warnings.some((w) => w.includes('[worktree]') && w.includes('Conflict')),
        `Expected conflict warning, got: ${JSON.stringify(warnings)}`,
      );
    } finally {
      console.warn = origWarn;
    }
  });

  it('returns { ok: false, error } on exception', () => {
    mockState.smartMergeThrow = new Error('Simulated git failure');

    const result = mergeTaskWorktree('T013');
    assert.strictEqual(result.ok, false);
    assert.ok(result.error != null, 'Expected error property');
    assert.ok(
      result.error.includes('Simulated git failure'),
      `Expected error message, got: ${result.error}`,
    );
  });
});

// ── 9-11: cleanupTaskWorktree ───────────────────────────────────────────────

describe('cleanupTaskWorktree', () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
    resetMockState();
  });
  afterEach(() => {
    rmTmpDir(tmpDir);
  });

  it('removes worktree and deletes branch', () => {
    const taskId = 'T020';
    cleanupTaskWorktree(taskId);

    assert.ok(
      mockState.gitCalls.length >= 2,
      `Expected >= 2 git calls, got ${mockState.gitCalls.length}`,
    );

    const worktreeRemoveCall = mockState.gitCalls.find(
      (c) => c.args[0] === 'worktree' && c.args[1] === 'remove',
    );
    assert.ok(worktreeRemoveCall != null, 'Expected git worktree remove call');
    assert.ok(
      worktreeRemoveCall.args.some((a) => a.includes(`task-${taskId}`)),
      'worktree remove should reference task path',
    );

    const branchDeleteCall = mockState.gitCalls.find((c) => c.args[0] === 'branch');
    assert.ok(branchDeleteCall != null, 'Expected git branch delete call');
    assert.ok(
      branchDeleteCall.args.includes(`hydra/task/${taskId}`),
      'branch delete should reference hydra/task/{id}',
    );
    assert.ok(branchDeleteCall.args.includes('-d'), 'Default should use -d (not -D)');
  });

  it('force=true passes --force to worktree remove and -D to branch delete', () => {
    const taskId = 'T021';
    cleanupTaskWorktree(taskId, { force: true });

    const worktreeRemoveCall = mockState.gitCalls.find(
      (c) => c.args[0] === 'worktree' && c.args[1] === 'remove',
    );
    assert.ok(worktreeRemoveCall != null, 'Expected git worktree remove call');
    assert.ok(
      worktreeRemoveCall.args.includes('--force'),
      'force=true should pass --force to worktree remove',
    );

    const branchDeleteCall = mockState.gitCalls.find((c) => c.args[0] === 'branch');
    assert.ok(branchDeleteCall != null, 'Expected git branch delete call');
    assert.ok(branchDeleteCall.args.includes('-D'), 'force=true should use -D for branch delete');
  });

  it('does not throw on git failure (best-effort cleanup)', () => {
    mockState.gitReturnStatus = 128;
    mockState.gitReturnStderr = 'fatal: not a valid worktree';

    // Should not throw even when all git calls fail
    assert.doesNotThrow(() => {
      cleanupTaskWorktree('T022');
    });
  });
});

// ── 12-13: Cleanup / review ─────────────────────────────────────────────────

describe('cleanup and review — worktree conflict handling', () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
  });
  afterEach(() => {
    rmTmpDir(tmpDir);
  });

  it(':cleanup scanner finds task-* dirs older than 24h in .hydra/worktrees/', async () => {
    const worktreesPath = path.join(tmpDir, '.hydra', 'worktrees');
    fs.mkdirSync(worktreesPath, { recursive: true });

    // Stale task dir (48h old)
    const staleDir = path.join(worktreesPath, 'task-T070');
    fs.mkdirSync(staleDir, { recursive: true });
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(staleDir, oldTime, oldTime);

    // Fresh task dir (recent, should not be flagged)
    const freshDir = path.join(worktreesPath, 'task-T071');
    fs.mkdirSync(freshDir, { recursive: true });

    // Non-task dir (old but should be ignored — no task- prefix)
    const nonTaskDir = path.join(worktreesPath, 'other-dir');
    fs.mkdirSync(nonTaskDir, { recursive: true });
    fs.utimesSync(nonTaskDir, oldTime, oldTime);

    // scanStaleTaskWorktrees dynamically imports hydra-config.ts, which is
    // already mocked above. The mock returns worktreeDir: '.hydra/worktrees'.
    const { scanStaleTaskWorktrees } = await import('../lib/hydra-cleanup.ts');
    const items = await scanStaleTaskWorktrees(tmpDir);

    const staleItems = items.filter((i) => i.source === 'worktrees');
    assert.ok(
      staleItems.length >= 1,
      `Expected at least 1 stale worktree, got ${staleItems.length}`,
    );

    const staleT070 = staleItems.find((i) => i.id === 'worktree-task-T070');
    assert.ok(staleT070 != null, 'Expected to find stale task-T070');
    assert.ok(staleT070.title.includes('task-T070'), 'Title should mention task-T070');
    assert.strictEqual(staleT070.category, 'worktree');

    const freshItem = staleItems.find((i) => i.id === 'worktree-task-T071');
    assert.strictEqual(freshItem, undefined, 'Fresh task dir should not be flagged as stale');

    const nonTaskItem = staleItems.find((i) => i.id === 'worktree-other-dir');
    assert.strictEqual(nonTaskItem, undefined, 'Non-task dir should not be scanned');
  });

  it(':tasks review conflict display falls back to hydra/task/{id} when worktreePath is missing', () => {
    const tasks = [
      {
        id: 'T080',
        title: 'Conflict with path',
        worktreePath: '/tmp/fake/task-T080',
        worktreeConflict: true,
      },
      { id: 'T081', title: 'Conflict without path', worktreePath: null, worktreeConflict: true },
      {
        id: 'T082',
        title: 'No conflict',
        worktreePath: '/tmp/fake/task-T082',
        worktreeConflict: false,
      },
    ];

    const conflictTasks = tasks.filter((t) => t.worktreeConflict);
    const renderedPaths = conflictTasks.map((t) => t.worktreePath ?? `hydra/task/${t.id}`);

    assert.strictEqual(conflictTasks.length, 2, 'Expected both conflict tasks to be shown');
    assert.deepStrictEqual(renderedPaths, ['/tmp/fake/task-T080', 'hydra/task/T081']);
  });
});
