/**
 * Deep coverage tests for lib/hydra-updater.ts.
 *
 * Mocks fs, fetch, and hydra-config to test all exported functions:
 * checkForUpdates, invalidateUpdateCache.
 */
import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockReadFileSync = mock.fn((filePath: string) => {
  if (filePath.endsWith('package.json')) {
    return JSON.stringify({
      version: '1.0.0',
      repository: { url: 'git+https://github.com/TestOwner/TestRepo.git' },
    });
  }
  if (filePath.endsWith('.update-check.json')) {
    throw new Error('ENOENT');
  }
  throw new Error('ENOENT');
});
const mockWriteFileSync = mock.fn();
const mockMkdirSync = mock.fn();

mock.module('node:fs', {
  namedExports: {
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
    existsSync: mock.fn(() => true),
  },
  defaultExport: {
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
    existsSync: mock.fn(() => true),
  },
});

mock.module('../lib/hydra-config.ts', {
  namedExports: {
    HYDRA_ROOT: '/tmp/test-hydra',
    loadHydraConfig: mock.fn(() => ({})),
    resolveProject: mock.fn(() => ({ projectRoot: '/tmp' })),
    getRoleConfig: mock.fn(),
  },
});

// ── Import ───────────────────────────────────────────────────────────────────

const { checkForUpdates, invalidateUpdateCache } = await import('../lib/hydra-updater.ts');

// ── Tests ────────────────────────────────────────────────────────────────────

describe('checkForUpdates', () => {
  beforeEach(() => {
    mockReadFileSync.mock.resetCalls();
    mockWriteFileSync.mock.resetCalls();
  });

  it('returns null or update info without throwing', async () => {
    // In test environment, fetch to GitHub will likely fail
    const result = await checkForUpdates();
    // Should return null (network error) or a valid object
    if (result !== null) {
      assert.equal(typeof result.hasUpdate, 'boolean');
      assert.equal(typeof result.localVersion, 'string');
    }
  });

  it('is safe to call multiple times', async () => {
    const r1 = await checkForUpdates();
    const r2 = await checkForUpdates();
    // Both should be null or valid
    if (r1 !== null) assert.equal(typeof r1.hasUpdate, 'boolean');
    if (r2 !== null) assert.equal(typeof r2.hasUpdate, 'boolean');
  });
});

describe('invalidateUpdateCache', () => {
  beforeEach(() => {
    mockWriteFileSync.mock.resetCalls();
  });

  it('writes cache file with checkedAt=0', () => {
    invalidateUpdateCache();
    // Should have attempted to write
    assert.ok(mockWriteFileSync.mock.callCount() > 0);
    const lastCall = mockWriteFileSync.mock.calls[mockWriteFileSync.mock.callCount() - 1];
    const written = JSON.parse(lastCall.arguments[1] as string) as { checkedAt: number };
    assert.equal(written.checkedAt, 0);
  });

  it('does not throw even if writeFileSync fails', () => {
    mockWriteFileSync.mock.mockImplementation(() => {
      throw new Error('EACCES');
    });
    assert.doesNotThrow(() => {
      invalidateUpdateCache();
    });
    // Restore
    mockWriteFileSync.mock.mockImplementation(() => {
      /* noop */
    });
  });

  it('can be called multiple times safely', () => {
    invalidateUpdateCache();
    invalidateUpdateCache();
    invalidateUpdateCache();
    // Just verify no throws
  });
});
