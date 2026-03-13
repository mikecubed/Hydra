import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  stripGitEnv,
  parseRemoteUrl,
  getCurrentBranch,
  branchExists,
  getBranchDiff,
  getBranchDiffStat,
  getBranchLog,
  getBranchStats,
  listBranches,
  isAheadOfRemote,
  getRemoteUrl,
  hasRemote,
  branchHasCommits,
  deleteBranch,
  getTrackingBranch,
} from '../lib/hydra-shared/git-ops.ts';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../');

// ---------------------------------------------------------------------------
// stripGitEnv() — pure function
// ---------------------------------------------------------------------------

describe('stripGitEnv()', () => {
  it('strips GIT_DIR when set', () => {
    const original = process.env['GIT_DIR'];
    try {
      process.env['GIT_DIR'] = '/some/path';
      const result = stripGitEnv();
      assert.ok(!('GIT_DIR' in result), 'GIT_DIR should be removed');
    } finally {
      if (original === undefined) {
        delete process.env['GIT_DIR'];
      } else {
        process.env['GIT_DIR'] = original;
      }
    }
  });

  it('strips GIT_WORK_TREE when set', () => {
    const original = process.env['GIT_WORK_TREE'];
    try {
      process.env['GIT_WORK_TREE'] = '/work';
      const result = stripGitEnv();
      assert.ok(!('GIT_WORK_TREE' in result));
    } finally {
      if (original === undefined) {
        delete process.env['GIT_WORK_TREE'];
      } else {
        process.env['GIT_WORK_TREE'] = original;
      }
    }
  });

  it('strips GIT_INDEX_FILE when set', () => {
    const original = process.env['GIT_INDEX_FILE'];
    try {
      process.env['GIT_INDEX_FILE'] = '/index';
      const result = stripGitEnv();
      assert.ok(!('GIT_INDEX_FILE' in result));
    } finally {
      if (original === undefined) {
        delete process.env['GIT_INDEX_FILE'];
      } else {
        process.env['GIT_INDEX_FILE'] = original;
      }
    }
  });

  it('strips GIT_OBJECT_DIRECTORY when set', () => {
    const original = process.env['GIT_OBJECT_DIRECTORY'];
    try {
      process.env['GIT_OBJECT_DIRECTORY'] = '/objects';
      const result = stripGitEnv();
      assert.ok(!('GIT_OBJECT_DIRECTORY' in result));
    } finally {
      if (original === undefined) {
        delete process.env['GIT_OBJECT_DIRECTORY'];
      } else {
        process.env['GIT_OBJECT_DIRECTORY'] = original;
      }
    }
  });

  it('strips all 4 git env vars simultaneously', () => {
    const saved: Record<string, string | undefined> = {};
    const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY'];
    for (const k of keys) saved[k] = process.env[k];
    try {
      process.env['GIT_DIR'] = '/a';
      process.env['GIT_WORK_TREE'] = '/b';
      process.env['GIT_INDEX_FILE'] = '/c';
      process.env['GIT_OBJECT_DIRECTORY'] = '/d';
      const result = stripGitEnv();
      for (const k of keys) {
        assert.ok(!(k in result), `${k} should be removed`);
      }
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) {
          Reflect.deleteProperty(process.env, k);
        } else {
          process.env[k] = saved[k];
        }
      }
    }
  });

  it('preserves non-GIT env vars', () => {
    const original = process.env['PATH'];
    const result = stripGitEnv();
    assert.equal(result['PATH'], original);
  });

  it('returns a new object each call', () => {
    const a = stripGitEnv();
    const b = stripGitEnv();
    assert.notEqual(a, b);
  });
});

// ---------------------------------------------------------------------------
// parseRemoteUrl() — pure URL parser
// ---------------------------------------------------------------------------

describe('parseRemoteUrl()', () => {
  it('parses SSH URL with .git suffix', () => {
    const result = parseRemoteUrl('git@github.com:owner/repo.git');
    assert.ok(result !== null);
    assert.equal(result.host, 'github.com');
    assert.equal(result.owner, 'owner');
    assert.equal(result.repo, 'repo');
  });

  it('parses SSH URL without .git suffix', () => {
    const result = parseRemoteUrl('git@github.com:myorg/myrepo');
    assert.ok(result !== null);
    assert.equal(result.owner, 'myorg');
    assert.equal(result.repo, 'myrepo');
  });

  it('parses SSH URL for non-github host', () => {
    const result = parseRemoteUrl('git@bitbucket.org:team/proj.git');
    assert.ok(result !== null);
    assert.equal(result.host, 'bitbucket.org');
    assert.equal(result.owner, 'team');
    assert.equal(result.repo, 'proj');
  });

  it('parses SSH URL with ssh+git protocol prefix', () => {
    const result = parseRemoteUrl('ssh+git@gitlab.com:ns/proj.git');
    assert.ok(result !== null);
    assert.equal(result.host, 'gitlab.com');
    assert.equal(result.owner, 'ns');
    assert.equal(result.repo, 'proj');
  });

  it('parses HTTPS URL with .git suffix', () => {
    const result = parseRemoteUrl('https://github.com/owner/repo.git');
    assert.ok(result !== null);
    assert.equal(result.host, 'github.com');
    assert.equal(result.owner, 'owner');
    assert.equal(result.repo, 'repo');
  });

  it('parses HTTPS URL without .git suffix', () => {
    const result = parseRemoteUrl('https://github.com/owner/repo');
    assert.ok(result !== null);
    assert.equal(result.owner, 'owner');
    assert.equal(result.repo, 'repo');
  });

  it('parses HTTPS GitLab URL', () => {
    const result = parseRemoteUrl('https://gitlab.com/company/product.git');
    assert.ok(result !== null);
    assert.equal(result.host, 'gitlab.com');
    assert.equal(result.owner, 'company');
    assert.equal(result.repo, 'product');
  });

  it('returns null for empty string', () => {
    assert.equal(parseRemoteUrl(''), null);
  });

  it('returns null for non-URL string', () => {
    assert.equal(parseRemoteUrl('not-a-url'), null);
  });

  it('returns null for HTTPS URL with single segment path', () => {
    assert.equal(parseRemoteUrl('https://github.com/onlyone'), null);
  });

  it('returns null for HTTPS URL with empty path', () => {
    assert.equal(parseRemoteUrl('https://github.com/'), null);
  });
});

// ---------------------------------------------------------------------------
// Integration-lite tests — real git repo, check return types only
// ---------------------------------------------------------------------------

describe('getCurrentBranch() — integration', () => {
  it('returns a non-empty string', () => {
    const branch = getCurrentBranch(REPO_ROOT);
    assert.equal(typeof branch, 'string');
    assert.ok(branch.length > 0, 'Expected non-empty branch name');
  });
});

describe('branchExists() — integration', () => {
  it('returns true for the current branch', () => {
    const branch = getCurrentBranch(REPO_ROOT);
    const result = branchExists(REPO_ROOT, branch);
    assert.equal(result, true);
  });

  it('returns false for a non-existent branch', () => {
    assert.equal(branchExists(REPO_ROOT, 'this-cannot-exist-xyz-999'), false);
  });
});

describe('getBranchStats() — integration', () => {
  it('returns object with commits and filesChanged as numbers ≥ 0', () => {
    const stats = getBranchStats(REPO_ROOT, 'feat/p3-coverage', 'main');
    assert.equal(typeof stats.commits, 'number');
    assert.equal(typeof stats.filesChanged, 'number');
    assert.ok(stats.commits >= 0);
    assert.ok(stats.filesChanged >= 0);
  });
});

describe('listBranches() — integration', () => {
  it('returns an array for a non-existent prefix', () => {
    const result = listBranches(REPO_ROOT, 'tasks/nonexistent');
    assert.ok(Array.isArray(result));
  });

  it('returns an array for an existing prefix', () => {
    const result = listBranches(REPO_ROOT, 'feat');
    assert.ok(Array.isArray(result));
  });
});

describe('isAheadOfRemote() — integration', () => {
  it('returns { ahead: number, behind: number }', () => {
    const result = isAheadOfRemote(REPO_ROOT);
    assert.equal(typeof result.ahead, 'number');
    assert.equal(typeof result.behind, 'number');
  });
});

describe('hasRemote() — integration', () => {
  it('returns a boolean for "origin"', () => {
    const result = hasRemote(REPO_ROOT, 'origin');
    assert.equal(typeof result, 'boolean');
  });

  it('returns false for a non-existent remote', () => {
    assert.equal(hasRemote(REPO_ROOT, 'remote-xyz-999'), false);
  });
});

describe('getRemoteUrl() — integration', () => {
  it('returns a string for "origin"', () => {
    const result = getRemoteUrl(REPO_ROOT, 'origin');
    assert.equal(typeof result, 'string');
  });

  it('returns empty string for a non-existent remote', () => {
    assert.equal(getRemoteUrl(REPO_ROOT, 'no-such-remote-xyz'), '');
  });
});

describe('branchHasCommits() — integration', () => {
  it('returns a boolean for the current branch vs main', () => {
    const branch = getCurrentBranch(REPO_ROOT);
    const result = branchHasCommits(REPO_ROOT, branch, 'main');
    assert.equal(typeof result, 'boolean');
  });
});

describe('getBranchDiff() — integration', () => {
  it('returns a string', () => {
    const result = getBranchDiff(REPO_ROOT, 'feat/p3-coverage', 'main');
    assert.equal(typeof result, 'string');
  });
});

describe('getBranchDiffStat() — integration', () => {
  it('returns a string for valid branches', () => {
    const result = getBranchDiffStat(REPO_ROOT, 'feat/p3-coverage', 'main');
    assert.equal(typeof result, 'string');
  });

  it('returns a string (possibly empty) for a non-existent branch', () => {
    const result = getBranchDiffStat(REPO_ROOT, 'nonexistent-xyz', 'main');
    assert.equal(typeof result, 'string');
  });
});

describe('getBranchLog() — integration', () => {
  it('returns a string', () => {
    const result = getBranchLog(REPO_ROOT, 'feat/p3-coverage', 'main');
    assert.equal(typeof result, 'string');
  });
});

describe('deleteBranch() — integration', () => {
  it('returns false when branch does not exist', () => {
    const result = deleteBranch(REPO_ROOT, 'this-branch-does-not-exist-xyz-999');
    assert.equal(result, false);
  });
});

describe('getTrackingBranch() — integration', () => {
  it('returns a string (possibly empty)', () => {
    const result = getTrackingBranch(REPO_ROOT);
    assert.equal(typeof result, 'string');
  });

  it('returns empty string for a non-existent branch', () => {
    const result = getTrackingBranch(REPO_ROOT, 'no-upstream-xyz');
    assert.equal(result, '');
  });
});
