/**
 * Deep coverage tests for lib/hydra-cleanup.ts
 *
 * Uses mock.module() to mock hydra-utils.ts (request), hydra-config.ts,
 * hydra-shared/git-ops.ts, and hydra-evolve-suggestions.ts for scanner/executor testing.
 */

import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ActionItem } from '../lib/hydra-action-pipeline.ts';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockRequest = mock.fn(
  async (_method: string, _base: string, _path: string, _body?: unknown) => ({}),
);

mock.module('../lib/hydra-utils.ts', {
  namedExports: {
    request: mockRequest,
  },
});

const mockLoadHydraConfig = mock.fn(() => ({
  routing: {
    worktreeIsolation: {
      worktreeDir: '.hydra/worktrees',
    },
  },
}));

mock.module('../lib/hydra-config.ts', {
  namedExports: {
    loadHydraConfig: mockLoadHydraConfig,
  },
});

const mockListBranches = mock.fn((_root: string, _prefix: string) => [] as string[]);
const mockBranchHasCommits = mock.fn((_root: string, _branch: string, _base: string) => false);
const mockGitFn = mock.fn((_args: string[], _cwd: string) => ({
  status: 0,
  stdout: '',
  stderr: '',
  error: null,
  signal: null,
}));

mock.module('../lib/hydra-shared/git-ops.ts', {
  namedExports: {
    listBranches: mockListBranches,
    branchHasCommits: mockBranchHasCommits,
    git: mockGitFn,
    gitOperations: {
      getCurrentBranch: () => 'main',
      branchExists: () => false,
      createBranch: () => true,
      checkoutBranch: () => ({ status: 0, stdout: '', stderr: '', error: null, signal: null }),
      mergeBranch: () => true,
      deleteBranch: () => true,
      stageAndCommit: () => true,
    },
  },
});

const mockLoadSuggestions = mock.fn((_path: string) => ({ suggestions: [] }));
const mockGetPendingSuggestions = mock.fn((_sg: unknown) => [] as Array<Record<string, unknown>>);
const mockSaveSuggestions = mock.fn((_path: string, _sg: unknown) => {});
const mockRemoveSuggestion = mock.fn((_sg: unknown, _id: string) => {});

mock.module('../lib/hydra-evolve-suggestions.ts', {
  namedExports: {
    loadSuggestions: mockLoadSuggestions,
    getPendingSuggestions: mockGetPendingSuggestions,
    saveSuggestions: mockSaveSuggestions,
    removeSuggestion: mockRemoveSuggestion,
  },
});

const {
  scanArchivableTasks,
  scanOldHandoffs,
  scanStaleBranches,
  scanStaleTasks,
  scanAbandonedSuggestions,
  scanStaleTaskWorktrees,
  executeCleanupAction,
  enrichCleanupWithSitrep,
} = await import('../lib/hydra-cleanup.ts');

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeMockItem(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    id: 'test-item',
    title: 'Test Item',
    description: 'A test item',
    category: 'delete',
    severity: 'low',
    source: 'test',
    ...overrides,
  };
}

// ── scanArchivableTasks ─────────────────────────────────────────────────────

describe('scanArchivableTasks (mocked)', () => {
  beforeEach(() => {
    mockRequest.mock.resetCalls();
  });

  it('finds done tasks', async () => {
    mockRequest.mock.mockImplementation(async () => ({
      tasks: [
        { id: 't1', title: 'Done task', status: 'done', completedAt: '2025-01-01' },
        { id: 't2', title: 'Active task', status: 'in_progress' },
      ],
    }));
    const items = await scanArchivableTasks('http://localhost:4173');
    assert.equal(items.length, 1);
    assert.ok(items[0].id.includes('t1'));
    assert.equal(items[0].category, 'archive');
  });

  it('finds cancelled tasks', async () => {
    mockRequest.mock.mockImplementation(async () => ({
      tasks: [{ id: 't1', title: 'Cancelled', status: 'cancelled' }],
    }));
    const items = await scanArchivableTasks('http://localhost:4173');
    assert.equal(items.length, 1);
    assert.ok(items[0].title.includes('cancelled'));
  });

  it('returns empty when no tasks', async () => {
    mockRequest.mock.mockImplementation(async () => ({ tasks: [] }));
    const items = await scanArchivableTasks('http://localhost:4173');
    assert.deepEqual(items, []);
  });

  it('returns empty when tasks is not an array', async () => {
    mockRequest.mock.mockImplementation(async () => ({ tasks: 'not-an-array' }));
    const items = await scanArchivableTasks('http://localhost:4173');
    assert.deepEqual(items, []);
  });

  it('returns empty when request fails', async () => {
    mockRequest.mock.mockImplementation(async () => {
      throw new Error('connection refused');
    });
    const items = await scanArchivableTasks('http://localhost:4173');
    assert.deepEqual(items, []);
  });
});

// ── scanOldHandoffs ─────────────────────────────────────────────────────────

describe('scanOldHandoffs (mocked)', () => {
  beforeEach(() => {
    mockRequest.mock.resetCalls();
  });

  it('finds old acknowledged handoffs', async () => {
    const oldTs = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    mockRequest.mock.mockImplementation(async () => ({
      handoffs: [{ id: 'h1', summary: 'Old handoff', acknowledged: true, ts: oldTs }],
    }));
    const items = await scanOldHandoffs('http://localhost:4173');
    assert.equal(items.length, 1);
    assert.ok(items[0].id.includes('h1'));
    assert.equal(items[0].category, 'archive');
  });

  it('ignores recent acknowledged handoffs', async () => {
    const recentTs = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
    mockRequest.mock.mockImplementation(async () => ({
      handoffs: [{ id: 'h1', summary: 'Recent', acknowledged: true, ts: recentTs }],
    }));
    const items = await scanOldHandoffs('http://localhost:4173');
    assert.deepEqual(items, []);
  });

  it('ignores unacknowledged handoffs', async () => {
    const oldTs = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    mockRequest.mock.mockImplementation(async () => ({
      handoffs: [{ id: 'h1', summary: 'Unack', acknowledged: false, ts: oldTs }],
    }));
    const items = await scanOldHandoffs('http://localhost:4173');
    assert.deepEqual(items, []);
  });

  it('returns empty when handoffs is not array', async () => {
    mockRequest.mock.mockImplementation(async () => ({ handoffs: null }));
    const items = await scanOldHandoffs('http://localhost:4173');
    assert.deepEqual(items, []);
  });

  it('returns empty on request failure', async () => {
    mockRequest.mock.mockImplementation(async () => {
      throw new Error('timeout');
    });
    const items = await scanOldHandoffs('http://localhost:4173');
    assert.deepEqual(items, []);
  });

  it('uses createdAt fallback when ts is missing', async () => {
    const oldCreatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    mockRequest.mock.mockImplementation(async () => ({
      handoffs: [{ id: 'h1', summary: 'Fallback', acknowledged: true, createdAt: oldCreatedAt }],
    }));
    const items = await scanOldHandoffs('http://localhost:4173');
    assert.equal(items.length, 1);
  });
});

// ── scanStaleBranches ───────────────────────────────────────────────────────

describe('scanStaleBranches (mocked)', () => {
  beforeEach(() => {
    mockListBranches.mock.resetCalls();
    mockBranchHasCommits.mock.resetCalls();
  });

  it('finds branches across all prefixes', async () => {
    mockListBranches.mock.mockImplementation((_root: string, prefix: string) => {
      if (prefix === 'evolve') return ['evolve/a'];
      if (prefix === 'tasks') return ['tasks/b'];
      return [];
    });
    mockBranchHasCommits.mock.mockImplementation(() => true);

    const items = await scanStaleBranches('/tmp/project');
    assert.equal(items.length, 2);
    assert.ok(items.some((i) => i.title.includes('evolve/a')));
    assert.ok(items.some((i) => i.title.includes('tasks/b')));
  });

  it('labels branches with commits as Unmerged', async () => {
    mockListBranches.mock.mockImplementation((_root: string, prefix: string) =>
      prefix === 'evolve' ? ['evolve/x'] : [],
    );
    mockBranchHasCommits.mock.mockImplementation(() => true);

    const items = await scanStaleBranches('/tmp/project');
    assert.equal(items.length, 1);
    assert.ok(items[0].title.includes('Unmerged'));
    assert.equal(items[0].severity, 'medium');
  });

  it('labels branches without commits as Empty', async () => {
    mockListBranches.mock.mockImplementation((_root: string, prefix: string) =>
      prefix === 'tasks' ? ['tasks/y'] : [],
    );
    mockBranchHasCommits.mock.mockImplementation(() => false);

    const items = await scanStaleBranches('/tmp/project');
    assert.equal(items.length, 1);
    assert.ok(items[0].title.includes('Empty'));
    assert.equal(items[0].severity, 'low');
  });

  it('returns empty when no branches found', async () => {
    mockListBranches.mock.mockImplementation(() => []);
    const items = await scanStaleBranches('/tmp/project');
    assert.deepEqual(items, []);
  });

  it('returns empty on error', async () => {
    mockListBranches.mock.mockImplementation(() => {
      throw new Error('git not found');
    });
    const items = await scanStaleBranches('/tmp/project');
    assert.deepEqual(items, []);
  });
});

// ── scanStaleTasks ──────────────────────────────────────────────────────────

describe('scanStaleTasks (mocked)', () => {
  beforeEach(() => {
    mockRequest.mock.resetCalls();
  });

  it('finds stale in_progress tasks', async () => {
    const oldUpdate = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    mockRequest.mock.mockImplementation(async () => ({
      tasks: [{ id: 't1', title: 'Stale', status: 'in_progress', updatedAt: oldUpdate }],
    }));
    const items = await scanStaleTasks('http://localhost:4173');
    assert.equal(items.length, 1);
    assert.equal(items[0].category, 'requeue');
    assert.equal(items[0].severity, 'medium');
  });

  it('ignores recently updated in_progress tasks', async () => {
    const recentUpdate = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    mockRequest.mock.mockImplementation(async () => ({
      tasks: [{ id: 't1', title: 'Active', status: 'in_progress', updatedAt: recentUpdate }],
    }));
    const items = await scanStaleTasks('http://localhost:4173');
    assert.deepEqual(items, []);
  });

  it('ignores done tasks', async () => {
    mockRequest.mock.mockImplementation(async () => ({
      tasks: [{ id: 't1', status: 'done' }],
    }));
    const items = await scanStaleTasks('http://localhost:4173');
    assert.deepEqual(items, []);
  });

  it('uses claimedAt fallback when updatedAt missing', async () => {
    const oldClaimed = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    mockRequest.mock.mockImplementation(async () => ({
      tasks: [{ id: 't1', title: 'Stale', status: 'in_progress', claimedAt: oldClaimed }],
    }));
    const items = await scanStaleTasks('http://localhost:4173');
    assert.equal(items.length, 1);
  });

  it('returns empty on request failure', async () => {
    mockRequest.mock.mockImplementation(async () => {
      throw new Error('down');
    });
    const items = await scanStaleTasks('http://localhost:4173');
    assert.deepEqual(items, []);
  });
});

// ── scanAbandonedSuggestions ────────────────────────────────────────────────

describe('scanAbandonedSuggestions (mocked)', () => {
  beforeEach(() => {
    mockLoadSuggestions.mock.resetCalls();
    mockGetPendingSuggestions.mock.resetCalls();
  });

  it('finds suggestions with 3+ attempts', async () => {
    mockLoadSuggestions.mock.mockImplementation(() => ({ suggestions: [] }));
    mockGetPendingSuggestions.mock.mockImplementation(() => [
      { id: 's1', title: 'Failed many', attempts: 5, createdAt: '2025-01-01' },
      { id: 's2', title: 'New one', attempts: 0 },
    ]);
    const items = await scanAbandonedSuggestions();
    assert.equal(items.length, 1);
    assert.ok(items[0].id.includes('s1'));
    assert.equal(items[0].category, 'cleanup');
  });

  it('returns empty when no abandoned suggestions', async () => {
    mockLoadSuggestions.mock.mockImplementation(() => ({ suggestions: [] }));
    mockGetPendingSuggestions.mock.mockImplementation(() => [{ id: 's1', attempts: 1 }]);
    const items = await scanAbandonedSuggestions();
    assert.deepEqual(items, []);
  });

  it('returns empty on error', async () => {
    mockLoadSuggestions.mock.mockImplementation(() => {
      throw new Error('file not found');
    });
    const items = await scanAbandonedSuggestions();
    assert.deepEqual(items, []);
  });
});

// ── scanStaleTaskWorktrees ──────────────────────────────────────────────────

describe('scanStaleTaskWorktrees (mocked)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-cleanup-wt-'));
    mockLoadHydraConfig.mock.resetCalls();
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      routing: { worktreeIsolation: { worktreeDir: '.hydra/worktrees' } },
    }));
  });

  it('finds stale task worktrees', async () => {
    const wtDir = path.join(tmpDir, '.hydra', 'worktrees');
    const taskDir = path.join(wtDir, 'task-abc123');
    fs.mkdirSync(taskDir, { recursive: true });
    // Set mtime to 48 hours ago
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(taskDir, oldTime, oldTime);

    const items = await scanStaleTaskWorktrees(tmpDir);
    assert.equal(items.length, 1);
    assert.ok(items[0].title.includes('task-abc123'));
    assert.equal(items[0].category, 'worktree');
    assert.equal(items[0].severity, 'medium');
  });

  it('ignores recent worktrees', async () => {
    const wtDir = path.join(tmpDir, '.hydra', 'worktrees');
    fs.mkdirSync(path.join(wtDir, 'task-recent'), { recursive: true });
    // No time manipulation - uses current time (< 24h)

    const items = await scanStaleTaskWorktrees(tmpDir);
    assert.deepEqual(items, []);
  });

  it('ignores non-task directories', async () => {
    const wtDir = path.join(tmpDir, '.hydra', 'worktrees');
    const nonTask = path.join(wtDir, 'agent-xyz');
    fs.mkdirSync(nonTask, { recursive: true });
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(nonTask, oldTime, oldTime);

    const items = await scanStaleTaskWorktrees(tmpDir);
    assert.deepEqual(items, []);
  });

  it('returns empty when worktree dir does not exist', async () => {
    const items = await scanStaleTaskWorktrees('/nonexistent/path');
    assert.deepEqual(items, []);
  });

  it('returns empty on config error', async () => {
    mockLoadHydraConfig.mock.mockImplementation(() => {
      throw new Error('config error');
    });
    const items = await scanStaleTaskWorktrees(tmpDir);
    assert.deepEqual(items, []);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── executeCleanupAction — archive ──────────────────────────────────────────

describe('executeCleanupAction — archive (mocked)', () => {
  beforeEach(() => {
    mockRequest.mock.resetCalls();
  });

  it('archives daemon task via POST', async () => {
    mockRequest.mock.mockImplementation(async () => ({}));
    const item = makeMockItem({
      category: 'archive',
      source: 'daemon',
      meta: { taskId: 't1' },
    });
    const result = await executeCleanupAction(item, { baseUrl: 'http://localhost:4173' });
    assert.equal(result.ok, true);
    assert.equal(result.output, 'Task archived');
    assert.equal(mockRequest.mock.callCount(), 1);
  });

  it('returns error when archive request fails', async () => {
    mockRequest.mock.mockImplementation(async () => {
      throw new Error('network error');
    });
    const item = makeMockItem({
      category: 'archive',
      source: 'daemon',
      meta: { taskId: 't1' },
    });
    const result = await executeCleanupAction(item, { baseUrl: 'http://localhost:4173' });
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes('network error'));
  });

  it('returns no action when no taskId', async () => {
    const item = makeMockItem({
      category: 'archive',
      source: 'daemon',
      meta: {},
    });
    const result = await executeCleanupAction(item, { baseUrl: 'http://localhost:4173' });
    assert.equal(result.ok, true);
    assert.equal(result.output, 'No action needed');
  });

  it('returns no action when source is not daemon', async () => {
    const item = makeMockItem({
      category: 'archive',
      source: 'other',
      meta: { taskId: 't1' },
    });
    const result = await executeCleanupAction(item, { baseUrl: 'http://localhost:4173' });
    assert.equal(result.ok, true);
    assert.equal(result.output, 'No action needed');
  });
});

// ── executeCleanupAction — requeue ──────────────────────────────────────────

describe('executeCleanupAction — requeue (mocked)', () => {
  beforeEach(() => {
    mockRequest.mock.resetCalls();
  });

  it('requeues task via POST', async () => {
    mockRequest.mock.mockImplementation(async () => ({}));
    const item = makeMockItem({
      category: 'requeue',
      source: 'daemon',
      meta: { taskId: 't1' },
    });
    const result = await executeCleanupAction(item, { baseUrl: 'http://localhost:4173' });
    assert.equal(result.ok, true);
    assert.equal(result.output, 'Task requeued');
  });

  it('returns error when no taskId', async () => {
    const item = makeMockItem({
      category: 'requeue',
      source: 'daemon',
      meta: {},
    });
    const result = await executeCleanupAction(item, { baseUrl: 'http://localhost:4173' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'No task ID for requeue');
  });

  it('returns error when requeue request fails', async () => {
    mockRequest.mock.mockImplementation(async () => {
      throw new Error('timeout');
    });
    const item = makeMockItem({
      category: 'requeue',
      source: 'daemon',
      meta: { taskId: 't1' },
    });
    const result = await executeCleanupAction(item, { baseUrl: 'http://localhost:4173' });
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes('timeout'));
  });
});

// ── executeCleanupAction — cleanup (suggestions) ────────────────────────────

describe('executeCleanupAction — cleanup suggestions (mocked)', () => {
  beforeEach(() => {
    mockLoadSuggestions.mock.resetCalls();
    mockRemoveSuggestion.mock.resetCalls();
    mockSaveSuggestions.mock.resetCalls();
  });

  it('removes abandoned suggestion', async () => {
    mockLoadSuggestions.mock.mockImplementation(() => ({ suggestions: [] }));
    mockRemoveSuggestion.mock.mockImplementation(() => {});
    mockSaveSuggestions.mock.mockImplementation(() => {});

    const item = makeMockItem({
      category: 'cleanup',
      source: 'suggestions',
      meta: { suggestionId: 's1' },
    });
    const result = await executeCleanupAction(item, {});
    assert.equal(result.ok, true);
    assert.equal(result.output, 'Suggestion removed');
  });

  it('returns error when suggestion removal fails', async () => {
    mockLoadSuggestions.mock.mockImplementation(() => {
      throw new Error('corrupt file');
    });

    const item = makeMockItem({
      category: 'cleanup',
      source: 'suggestions',
      meta: { suggestionId: 's1' },
    });
    const result = await executeCleanupAction(item, {});
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes('corrupt file'));
  });
});

// ── executeCleanupAction — cleanup (doctor log) ─────────────────────────────

describe('executeCleanupAction — cleanup doctor log', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-cleanup-doc-'));
  });

  it('truncates doctor log to last 100 entries', async () => {
    const logPath = path.join(tmpDir, 'DOCTOR_LOG.ndjson');
    const lines = Array.from({ length: 200 }, (_, i) => `{"entry":${i}}`);
    fs.writeFileSync(logPath, `${lines.join('\n')}\n`, 'utf8');

    const item = makeMockItem({
      id: 'artifact-doctor-log',
      category: 'cleanup',
      source: 'artifacts',
      meta: { filePath: logPath },
    });
    const result = await executeCleanupAction(item, {});
    assert.equal(result.ok, true);
    assert.ok(result.output?.includes('Truncated'));
    assert.ok(result.output?.includes('200'));
    assert.ok(result.output?.includes('100'));

    const content = fs.readFileSync(logPath, 'utf8');
    const remaining = content.trim().split('\n').filter(Boolean);
    assert.equal(remaining.length, 100);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── executeCleanupAction — cleanup (generic file) ───────────────────────────

describe('executeCleanupAction — cleanup generic file', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-cleanup-gen-'));
  });

  it('deletes generic artifact file', async () => {
    const filePath = path.join(tmpDir, 'old-artifact.json');
    fs.writeFileSync(filePath, '{}', 'utf8');

    const item = makeMockItem({
      id: 'artifact-something',
      category: 'cleanup',
      source: 'artifacts',
      meta: { filePath },
    });
    const result = await executeCleanupAction(item, {});
    assert.equal(result.ok, true);
    assert.equal(result.output, 'File removed');
    assert.equal(fs.existsSync(filePath), false);
  });

  it('returns no action when no filePath and not suggestion', async () => {
    const item = makeMockItem({
      id: 'artifact-x',
      category: 'cleanup',
      source: 'other',
      meta: {},
    });
    const result = await executeCleanupAction(item, {});
    assert.equal(result.ok, true);
    assert.equal(result.output, 'No action needed');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── executeCleanupAction — worktree ─────────────────────────────────────────

describe('executeCleanupAction — worktree (mocked)', () => {
  beforeEach(() => {
    mockGitFn.mock.resetCalls();
  });

  it('removes worktree via git commands', async () => {
    mockGitFn.mock.mockImplementation(() => ({
      status: 0,
      stdout: '',
      stderr: '',
      error: null,
      signal: null,
    }));

    const item = makeMockItem({
      category: 'worktree',
      source: 'worktrees',
      meta: { worktreePath: '/tmp/wt/task-abc', branch: 'hydra/task/abc' },
    });
    const result = await executeCleanupAction(item, { projectRoot: '/tmp/project' });
    assert.equal(result.ok, true);
    assert.ok(result.output?.includes('Removed stale worktree'));
  });

  it('returns error when worktreePath is empty', async () => {
    const item = makeMockItem({
      category: 'worktree',
      source: 'worktrees',
      meta: { worktreePath: '' },
    });
    const result = await executeCleanupAction(item, { projectRoot: '/tmp/project' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'No worktree path found');
  });

  it('falls back to rmSync + prune when git worktree remove fails', async () => {
    let pruned = false;
    mockGitFn.mock.mockImplementation((_args: string[]) => {
      const args = _args;
      if (args.includes('remove')) {
        return { status: 1, stdout: '', stderr: 'error', error: null, signal: null };
      }
      if (args.includes('prune')) {
        pruned = true;
      }
      return { status: 0, stdout: '', stderr: '', error: null, signal: null };
    });

    const item = makeMockItem({
      category: 'worktree',
      source: 'worktrees',
      meta: { worktreePath: '/nonexistent/wt/task-xyz', branch: 'hydra/task/xyz' },
    });
    const result = await executeCleanupAction(item, { projectRoot: '/tmp/project' });
    assert.equal(result.ok, true);
    assert.ok(pruned, 'should have called git worktree prune');
  });

  it('handles missing worktreePath meta', async () => {
    const item = makeMockItem({
      category: 'worktree',
      source: 'worktrees',
      meta: {},
    });
    const result = await executeCleanupAction(item, { projectRoot: '/tmp/project' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'No worktree path found');
  });
});

// ── executeCleanupAction — error handling ───────────────────────────────────

describe('executeCleanupAction — error handling', () => {
  it('catches thrown errors and returns them', async () => {
    // Create an item with an unsupported category to exercise the catch block
    const item = makeMockItem({
      category: 'archive',
      source: 'daemon',
      meta: { taskId: 'crash' },
    });
    // Make request throw
    mockRequest.mock.mockImplementation(async () => {
      throw new Error('kaboom');
    });
    const result = await executeCleanupAction(item, { baseUrl: 'http://localhost:4173' });
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes('kaboom'));
    assert.ok(typeof result.durationMs === 'number');
  });
});

// ── enrichCleanupWithSitrep ─────────────────────────────────────────────────

describe('enrichCleanupWithSitrep (mocked)', () => {
  it('passes items through unchanged', async () => {
    const items = [makeMockItem({ id: 'a' }), makeMockItem({ id: 'b' })];
    const result = await enrichCleanupWithSitrep(items);
    assert.deepEqual(result, items);
  });

  it('handles empty array', async () => {
    const result = await enrichCleanupWithSitrep([]);
    assert.deepEqual(result, []);
  });
});
