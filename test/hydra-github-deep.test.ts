/**
 * Deep coverage tests for lib/hydra-github.ts
 *
 * Uses mock.module() to mock hydra-proc.ts (spawnSyncCapture) and hydra-config.ts
 * so we can test all gh wrapper functions without a real gh CLI.
 */

import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock spawnSyncCapture ────────────────────────────────────────────────────

const mockSpawnSyncCapture = mock.fn(
  (_cmd: string, _args: string[], _opts?: Record<string, unknown>) => ({
    status: 0,
    stdout: '',
    stderr: '',
    error: null as Error | null,
    signal: null as string | null,
  }),
);

mock.module('../lib/hydra-proc.ts', {
  namedExports: {
    spawnSyncCapture: mockSpawnSyncCapture,
  },
});

// Mock git-ops to avoid real git calls
const mockPushBranch = mock.fn(
  (_cwd: string, _branch: string, _opts?: Record<string, unknown>) => ({
    ok: true,
    stdout: '',
    stderr: '',
  }),
);
const mockGetCurrentBranch = mock.fn((_cwd: string) => 'feat/test-branch');
const mockGetBranchLog = mock.fn(
  (_cwd: string, _branch: string, _base: string) => 'abc1234 first commit\ndef5678 second commit',
);

mock.module('../lib/hydra-shared/git-ops.ts', {
  namedExports: {
    pushBranch: mockPushBranch,
    getCurrentBranch: mockGetCurrentBranch,
    getBranchLog: mockGetBranchLog,
    parseRemoteUrl: (url: string | null) => {
      if (!url) return null;
      return { host: 'github.com', owner: 'test', repo: 'repo' };
    },
  },
});

// Mock config
const mockLoadHydraConfig = mock.fn(
  (): Record<string, unknown> => ({
    github: {
      enabled: false,
      defaultBase: '',
      draft: false,
      labels: [] as string[],
      reviewers: [] as string[],
      prBodyFooter: '',
    },
  }),
);

mock.module('../lib/hydra-config.ts', {
  namedExports: {
    loadHydraConfig: mockLoadHydraConfig,
  },
});

const {
  gh,
  isGhAvailable,
  isGhAuthenticated,
  detectRepo,
  createPR,
  listPRs,
  getPR,
  mergePR,
  closePR,
  listIssues,
  getGitHubConfig,
  verifyRequiredChecks,
  pushBranchAndCreatePR,
} = await import('../lib/hydra-github.ts');

// ── Helpers ─────────────────────────────────────────────────────────────────

function setSpawnResult(result: {
  status?: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error | null;
  signal?: string | null;
}) {
  mockSpawnSyncCapture.mock.mockImplementation(() => ({
    status: result.status ?? 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null,
    signal: result.signal ?? null,
  }));
}

// ── gh() ────────────────────────────────────────────────────────────────────

describe('gh() wrapper', () => {
  beforeEach(() => {
    mockSpawnSyncCapture.mock.resetCalls();
  });

  it('passes args to spawnSyncCapture', () => {
    setSpawnResult({ status: 0, stdout: 'ok' });
    const result = gh(['pr', 'list'], '/tmp');
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'ok');
    assert.equal(mockSpawnSyncCapture.mock.callCount(), 1);
    const call = mockSpawnSyncCapture.mock.calls[0];
    assert.equal(call.arguments[0], 'gh');
    assert.deepEqual(call.arguments[1], ['pr', 'list']);
  });

  it('returns error when spawn fails', () => {
    setSpawnResult({ status: 1, stderr: 'not found', error: new Error('ENOENT') });
    const result = gh(['--version']);
    assert.equal(result.status, 1);
    assert.ok(result.error instanceof Error);
  });

  it('includes signal in result', () => {
    setSpawnResult({ status: null, signal: 'SIGTERM' });
    const result = gh(['pr', 'list']);
    assert.equal(result.signal, 'SIGTERM');
  });
});

// ── isGhAvailable / isGhAuthenticated ───────────────────────────────────────

describe('isGhAvailable', () => {
  beforeEach(() => {
    mockSpawnSyncCapture.mock.resetCalls();
  });

  it('returns true when gh --version succeeds', () => {
    setSpawnResult({ status: 0, stdout: 'gh version 2.40.0' });
    assert.equal(isGhAvailable(), true);
  });

  it('returns false when gh --version fails', () => {
    setSpawnResult({ status: 1, stderr: 'not found' });
    assert.equal(isGhAvailable(), false);
  });

  it('returns false when spawn throws', () => {
    mockSpawnSyncCapture.mock.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    assert.equal(isGhAvailable(), false);
  });
});

describe('isGhAuthenticated', () => {
  beforeEach(() => {
    mockSpawnSyncCapture.mock.resetCalls();
  });

  it('returns true when gh auth status succeeds', () => {
    setSpawnResult({ status: 0 });
    assert.equal(isGhAuthenticated(), true);
  });

  it('returns false when gh auth status fails', () => {
    setSpawnResult({ status: 1 });
    assert.equal(isGhAuthenticated(), false);
  });

  it('returns false when spawn throws', () => {
    mockSpawnSyncCapture.mock.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    assert.equal(isGhAuthenticated(), false);
  });
});

// ── detectRepo ──────────────────────────────────────────────────────────────

describe('detectRepo', () => {
  beforeEach(() => {
    mockSpawnSyncCapture.mock.resetCalls();
  });

  it('parses repo info from gh output', () => {
    setSpawnResult({
      status: 0,
      stdout: JSON.stringify({
        owner: { login: 'myorg' },
        name: 'myrepo',
        defaultBranchRef: { name: 'main' },
      }),
    });
    const result = detectRepo('/tmp');
    assert.deepEqual(result, { owner: 'myorg', repo: 'myrepo', defaultBranch: 'main' });
  });

  it('handles owner as string', () => {
    setSpawnResult({
      status: 0,
      stdout: JSON.stringify({
        owner: 'directowner',
        name: 'myrepo',
        defaultBranchRef: { name: 'develop' },
      }),
    });
    const result = detectRepo('/tmp');
    assert.deepEqual(result, { owner: 'directowner', repo: 'myrepo', defaultBranch: 'develop' });
  });

  it('returns null when gh fails', () => {
    setSpawnResult({ status: 1 });
    assert.equal(detectRepo('/tmp'), null);
  });

  it('returns null when output is invalid JSON', () => {
    setSpawnResult({ status: 0, stdout: 'not json' });
    assert.equal(detectRepo('/tmp'), null);
  });

  it('defaults branch to main when not present', () => {
    setSpawnResult({
      status: 0,
      stdout: JSON.stringify({ owner: { login: 'o' }, name: 'r' }),
    });
    const result = detectRepo('/tmp');
    assert.equal(result?.defaultBranch, 'main');
  });
});

// ── createPR ────────────────────────────────────────────────────────────────

describe('createPR', () => {
  beforeEach(() => {
    mockSpawnSyncCapture.mock.resetCalls();
  });

  it('returns ok with url and PR number on success', () => {
    setSpawnResult({ status: 0, stdout: 'https://github.com/org/repo/pull/42\n' });
    const result = createPR({
      head: 'feat/test',
      base: 'main',
      title: 'Test PR',
    });
    assert.equal(result.ok, true);
    assert.equal(result.url, 'https://github.com/org/repo/pull/42');
    assert.equal(result.number, 42);
  });

  it('includes draft flag when set', () => {
    setSpawnResult({ status: 0, stdout: 'https://github.com/org/repo/pull/1\n' });
    createPR({ head: 'a', base: 'b', title: 'T', draft: true });
    const args = mockSpawnSyncCapture.mock.calls[0].arguments[1];
    assert.ok(args.includes('--draft'));
  });

  it('includes labels and reviewers', () => {
    setSpawnResult({ status: 0, stdout: 'https://github.com/org/repo/pull/1\n' });
    createPR({
      head: 'a',
      base: 'b',
      title: 'T',
      labels: ['bug', 'fix'],
      reviewers: ['alice'],
    });
    const args = mockSpawnSyncCapture.mock.calls[0].arguments[1];
    assert.ok(args.includes('--label'));
    assert.ok(args.includes('bug'));
    assert.ok(args.includes('fix'));
    assert.ok(args.includes('--reviewer'));
    assert.ok(args.includes('alice'));
  });

  it('returns error on failure with stderr', () => {
    setSpawnResult({ status: 1, stderr: 'PR already exists' });
    const result = createPR({ head: 'a', base: 'b', title: 'T' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'PR already exists');
  });

  it('returns error from stdout when stderr is empty', () => {
    setSpawnResult({ status: 1, stdout: 'error from stdout', stderr: '' });
    const result = createPR({ head: 'a', base: 'b', title: 'T' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'error from stdout');
  });

  it('handles url without PR number match', () => {
    setSpawnResult({ status: 0, stdout: 'https://github.com/org/repo\n' });
    const result = createPR({ head: 'a', base: 'b', title: 'T' });
    assert.equal(result.ok, true);
    assert.equal(result.number, undefined);
  });
});

// ── listPRs ─────────────────────────────────────────────────────────────────

describe('listPRs', () => {
  beforeEach(() => {
    mockSpawnSyncCapture.mock.resetCalls();
  });

  it('parses PR list from JSON output', () => {
    const prs = [
      {
        number: 1,
        title: 'First PR',
        headRefName: 'feat/a',
        author: { login: 'alice' },
        state: 'OPEN',
      },
      {
        number: 2,
        title: 'Second PR',
        headRefName: 'feat/b',
        author: 'bob',
        state: 'OPEN',
      },
    ];
    setSpawnResult({ status: 0, stdout: JSON.stringify(prs) });
    const result = listPRs();
    assert.equal(result.length, 2);
    assert.equal(result[0].number, 1);
    assert.equal(result[0].author, 'alice');
    assert.equal(result[1].author, 'bob');
  });

  it('returns empty array on failure', () => {
    setSpawnResult({ status: 1 });
    assert.deepEqual(listPRs(), []);
  });

  it('returns empty array on invalid JSON', () => {
    setSpawnResult({ status: 0, stdout: 'not json' });
    assert.deepEqual(listPRs(), []);
  });

  it('passes state, base and head filters', () => {
    setSpawnResult({ status: 0, stdout: '[]' });
    listPRs({ state: 'closed', base: 'main', head: 'feat/x' });
    const args = mockSpawnSyncCapture.mock.calls[0].arguments[1];
    assert.ok(args.includes('closed'));
    assert.ok(args.includes('--base'));
    assert.ok(args.includes('main'));
    assert.ok(args.includes('--head'));
    assert.ok(args.includes('feat/x'));
  });

  it('omits base/head when not provided', () => {
    setSpawnResult({ status: 0, stdout: '[]' });
    listPRs({});
    const args = mockSpawnSyncCapture.mock.calls[0].arguments[1];
    assert.ok(!args.includes('--base'));
    assert.ok(!args.includes('--head'));
  });
});

// ── getPR ───────────────────────────────────────────────────────────────────

describe('getPR', () => {
  beforeEach(() => {
    mockSpawnSyncCapture.mock.resetCalls();
  });

  it('returns parsed PR data', () => {
    const prData = { number: 5, title: 'PR #5', state: 'OPEN' };
    setSpawnResult({ status: 0, stdout: JSON.stringify(prData) });
    const result = getPR({ ref: 5 });
    assert.deepEqual(result, prData);
  });

  it('returns null on failure', () => {
    setSpawnResult({ status: 1 });
    assert.equal(getPR({ ref: 999 }), null);
  });

  it('returns null on invalid JSON', () => {
    setSpawnResult({ status: 0, stdout: 'bad' });
    assert.equal(getPR({ ref: 1 }), null);
  });

  it('accepts string ref', () => {
    setSpawnResult({ status: 0, stdout: '{}' });
    getPR({ ref: 'feat/branch' });
    const args = mockSpawnSyncCapture.mock.calls[0].arguments[1];
    assert.ok(args.includes('feat/branch'));
  });
});

// ── mergePR ─────────────────────────────────────────────────────────────────

describe('mergePR', () => {
  beforeEach(() => {
    mockSpawnSyncCapture.mock.resetCalls();
  });

  it('returns ok on success', () => {
    setSpawnResult({ status: 0 });
    const result = mergePR({ ref: 10 });
    assert.equal(result.ok, true);
  });

  it('uses merge method by default', () => {
    setSpawnResult({ status: 0 });
    mergePR({ ref: 10 });
    const args = mockSpawnSyncCapture.mock.calls[0].arguments[1];
    assert.ok(args.includes('--merge'));
    assert.ok(args.includes('--delete-branch'));
  });

  it('supports squash method without delete', () => {
    setSpawnResult({ status: 0 });
    mergePR({ ref: 10, method: 'squash', deleteAfter: false });
    const args = mockSpawnSyncCapture.mock.calls[0].arguments[1];
    assert.ok(args.includes('--squash'));
    assert.ok(!args.includes('--delete-branch'));
  });

  it('returns error on failure', () => {
    setSpawnResult({ status: 1, stderr: 'merge conflict' });
    const result = mergePR({ ref: 10 });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'merge conflict');
  });
});

// ── closePR ─────────────────────────────────────────────────────────────────

describe('closePR', () => {
  beforeEach(() => {
    mockSpawnSyncCapture.mock.resetCalls();
  });

  it('returns ok on success', () => {
    setSpawnResult({ status: 0 });
    const result = closePR({ ref: 10 });
    assert.equal(result.ok, true);
  });

  it('returns error on failure', () => {
    setSpawnResult({ status: 1, stderr: 'not found' });
    const result = closePR({ ref: 999 });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'not found');
  });
});

// ── listIssues ──────────────────────────────────────────────────────────────

describe('listIssues', () => {
  beforeEach(() => {
    mockSpawnSyncCapture.mock.resetCalls();
  });

  it('parses issue list from JSON', () => {
    const issues = [{ number: 1, title: 'Bug', state: 'OPEN' }];
    setSpawnResult({ status: 0, stdout: JSON.stringify(issues) });
    const result = listIssues();
    assert.equal(result.length, 1);
    assert.equal(result[0].number, 1);
  });

  it('returns empty array on failure', () => {
    setSpawnResult({ status: 1 });
    assert.deepEqual(listIssues(), []);
  });

  it('returns empty array on invalid JSON', () => {
    setSpawnResult({ status: 0, stdout: 'bad' });
    assert.deepEqual(listIssues(), []);
  });

  it('passes labels to gh args', () => {
    setSpawnResult({ status: 0, stdout: '[]' });
    listIssues({ labels: ['bug', 'p1'] });
    const args = mockSpawnSyncCapture.mock.calls[0].arguments[1];
    assert.ok(args.includes('--label'));
    assert.ok(args.includes('bug'));
    assert.ok(args.includes('p1'));
  });

  it('passes limit and state', () => {
    setSpawnResult({ status: 0, stdout: '[]' });
    listIssues({ state: 'closed', limit: 10 });
    const args = mockSpawnSyncCapture.mock.calls[0].arguments[1];
    assert.ok(args.includes('closed'));
    assert.ok(args.includes('10'));
  });
});

// ── getGitHubConfig ─────────────────────────────────────────────────────────

describe('getGitHubConfig with mock', () => {
  beforeEach(() => {
    mockLoadHydraConfig.mock.resetCalls();
  });

  it('returns defaults when config has no github section', () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({}));
    const cfg = getGitHubConfig();
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.defaultBase, '');
    assert.deepEqual(cfg.labels, []);
  });

  it('merges config values', () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      github: { enabled: true, defaultBase: 'develop', labels: ['auto'] },
    }));
    const cfg = getGitHubConfig();
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.defaultBase, 'develop');
    assert.deepEqual(cfg.labels, ['auto']);
  });
});

// ── verifyRequiredChecks ────────────────────────────────────────────────────

describe('verifyRequiredChecks', () => {
  beforeEach(() => {
    mockSpawnSyncCapture.mock.resetCalls();
    mockLoadHydraConfig.mock.resetCalls();
  });

  it('returns ok when no required checks configured', () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({ github: {} }));
    const result = verifyRequiredChecks({ ref: 1 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.pending, []);
    assert.deepEqual(result.failed, []);
  });

  it('detects failed checks', () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      github: { requiredChecks: ['ci', 'lint'] },
    }));
    setSpawnResult({
      status: 0,
      stdout: JSON.stringify([
        { name: 'ci', state: 'SUCCESS' },
        { name: 'lint', state: 'FAILURE' },
      ]),
    });
    const result = verifyRequiredChecks({ ref: 1 });
    assert.equal(result.ok, false);
    assert.deepEqual(result.failed, ['lint']);
  });

  it('detects pending checks', () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      github: { requiredChecks: ['ci', 'deploy'] },
    }));
    setSpawnResult({
      status: 0,
      stdout: JSON.stringify([
        { name: 'ci', state: 'SUCCESS' },
        { name: 'deploy', state: 'PENDING' },
      ]),
    });
    const result = verifyRequiredChecks({ ref: 1 });
    assert.equal(result.ok, false);
    assert.deepEqual(result.pending, ['deploy']);
  });

  it('marks missing checks as pending', () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      github: { requiredChecks: ['ci', 'missing-check'] },
    }));
    setSpawnResult({
      status: 0,
      stdout: JSON.stringify([{ name: 'ci', state: 'SUCCESS' }]),
    });
    const result = verifyRequiredChecks({ ref: 1 });
    assert.equal(result.ok, false);
    assert.deepEqual(result.pending, ['missing-check']);
  });

  it('returns failed when gh command fails', () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      github: { requiredChecks: ['ci'] },
    }));
    setSpawnResult({ status: 1 });
    const result = verifyRequiredChecks({ ref: 1 });
    assert.equal(result.ok, false);
    assert.deepEqual(result.failed, ['(could not fetch checks)']);
  });

  it('returns failed on parse error', () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      github: { requiredChecks: ['ci'] },
    }));
    setSpawnResult({ status: 0, stdout: 'not json' });
    const result = verifyRequiredChecks({ ref: 1 });
    assert.equal(result.ok, false);
    assert.deepEqual(result.failed, ['(parse error)']);
  });

  it('detects ERROR state as failed', () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      github: { requiredChecks: ['ci'] },
    }));
    setSpawnResult({
      status: 0,
      stdout: JSON.stringify([{ name: 'ci', state: 'ERROR' }]),
    });
    const result = verifyRequiredChecks({ ref: 1 });
    assert.equal(result.ok, false);
    assert.deepEqual(result.failed, ['ci']);
  });

  it('returns ok when all checks pass', () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      github: { requiredChecks: ['ci', 'lint'] },
    }));
    setSpawnResult({
      status: 0,
      stdout: JSON.stringify([
        { name: 'ci', state: 'SUCCESS' },
        { name: 'lint', state: 'SUCCESS' },
      ]),
    });
    const result = verifyRequiredChecks({ ref: 1 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.pending, []);
    assert.deepEqual(result.failed, []);
  });
});

// ── pushBranchAndCreatePR ───────────────────────────────────────────────────

describe('pushBranchAndCreatePR', () => {
  beforeEach(() => {
    mockSpawnSyncCapture.mock.resetCalls();
    mockPushBranch.mock.resetCalls();
    mockGetCurrentBranch.mock.resetCalls();
    mockGetBranchLog.mock.resetCalls();
    mockLoadHydraConfig.mock.resetCalls();
    // Default config
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      github: {
        enabled: false,
        defaultBase: '',
        draft: false,
        labels: [],
        reviewers: [],
        prBodyFooter: '',
      },
    }));
  });

  it('pushes branch and creates PR', () => {
    mockPushBranch.mock.mockImplementation(() => ({ ok: true, stdout: '', stderr: '' }));
    setSpawnResult({ status: 0, stdout: 'https://github.com/o/r/pull/99\n' });

    const result = pushBranchAndCreatePR({
      cwd: '/tmp/repo',
      branch: 'feat/x',
      baseBranch: 'main',
    });
    assert.equal(result.ok, true);
    assert.equal(result.number, 99);
  });

  it('returns error when push fails', () => {
    mockPushBranch.mock.mockImplementation(() => ({ ok: false, stdout: '', stderr: 'rejected' }));

    const result = pushBranchAndCreatePR({ branch: 'feat/x', baseBranch: 'main' });
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes('Push failed'));
  });

  it('auto-generates title from branch name', () => {
    mockPushBranch.mock.mockImplementation(() => ({ ok: true, stdout: '', stderr: '' }));
    setSpawnResult({ status: 0, stdout: 'https://github.com/o/r/pull/1\n' });

    pushBranchAndCreatePR({ branch: 'feat/add-caching', baseBranch: 'main' });
    const args = mockSpawnSyncCapture.mock.calls[0].arguments[1];
    // title should contain humanized branch name
    const titleIdx = args.indexOf('--title');
    assert.ok(titleIdx >= 0);
    const title = args[titleIdx + 1];
    assert.ok(title.includes('Feat'));
  });

  it('uses config defaults for base branch', () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      github: { defaultBase: 'develop', draft: false, labels: [], reviewers: [], prBodyFooter: '' },
    }));
    mockPushBranch.mock.mockImplementation(() => ({ ok: true, stdout: '', stderr: '' }));
    setSpawnResult({ status: 0, stdout: 'https://github.com/o/r/pull/1\n' });

    pushBranchAndCreatePR({ branch: 'feat/x' });
    const args = mockSpawnSyncCapture.mock.calls[0].arguments[1];
    const baseIdx = args.indexOf('--base');
    assert.ok(baseIdx >= 0);
    assert.equal(args[baseIdx + 1], 'develop');
  });

  it('falls back to main when no config base and detectRepo returns null', () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      github: { defaultBase: '', draft: false, labels: [], reviewers: [], prBodyFooter: '' },
    }));
    mockPushBranch.mock.mockImplementation(() => ({ ok: true, stdout: '', stderr: '' }));
    // detectRepo is called internally — first call is for detectRepo, subsequent for createPR
    mockSpawnSyncCapture.mock.mockImplementation((_cmd: string, args: string[]) => {
      // detectRepo call
      if (Array.isArray(args) && args.includes('repo')) {
        return { status: 1, stdout: '', stderr: '', error: null, signal: null };
      }
      // createPR call
      return {
        status: 0,
        stdout: 'https://github.com/o/r/pull/1\n',
        stderr: '',
        error: null,
        signal: null,
      };
    });

    const result = pushBranchAndCreatePR({ branch: 'feat/x' });
    assert.equal(result.ok, true);
  });

  it('strips evolve/ prefix from title', () => {
    mockPushBranch.mock.mockImplementation(() => ({ ok: true, stdout: '', stderr: '' }));
    setSpawnResult({ status: 0, stdout: 'https://github.com/o/r/pull/1\n' });

    pushBranchAndCreatePR({ branch: 'evolve/improve-perf', baseBranch: 'main' });
    const args = mockSpawnSyncCapture.mock.calls[0].arguments[1];
    const titleIdx = args.indexOf('--title');
    const title = args[titleIdx + 1];
    assert.ok(!title.toLowerCase().includes('evolve/'));
    assert.ok(title.includes('Improve'));
  });

  it('includes prBodyFooter from config', () => {
    mockLoadHydraConfig.mock.mockImplementation(() => ({
      github: {
        defaultBase: 'main',
        draft: false,
        labels: [],
        reviewers: [],
        prBodyFooter: 'Auto-generated by Hydra',
      },
    }));
    mockPushBranch.mock.mockImplementation(() => ({ ok: true, stdout: '', stderr: '' }));
    setSpawnResult({ status: 0, stdout: 'https://github.com/o/r/pull/1\n' });

    pushBranchAndCreatePR({ branch: 'feat/x', baseBranch: 'main' });
    const args = mockSpawnSyncCapture.mock.calls[0].arguments[1];
    const bodyIdx = args.indexOf('--body');
    const body = args[bodyIdx + 1];
    assert.ok(body.includes('Auto-generated by Hydra'));
  });
});
