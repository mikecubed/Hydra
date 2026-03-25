/**
 * Additional coverage tests for lib/hydra-shared/gemini-executor.ts.
 *
 * Focuses on token/config management functions and executeGeminiDirect error paths.
 */
import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getGeminiToken,
  getGeminiProjectId,
  executeGeminiDirect,
  _resetGeminiTokenCache,
  _setGeminiOAuthConfig,
} from '../lib/hydra-shared/gemini-executor.ts';

// ── _setGeminiOAuthConfig / _resetGeminiTokenCache ───────────────────────────

describe('_setGeminiOAuthConfig', () => {
  afterEach(() => {
    _setGeminiOAuthConfig(null);
    _resetGeminiTokenCache();
  });

  it('accepts a config object without throwing', () => {
    assert.doesNotThrow(() => {
      _setGeminiOAuthConfig({ clientId: 'test-id', clientSecret: 'test-secret' });
    });
  });

  it('accepts null to reset override', () => {
    _setGeminiOAuthConfig({ clientId: 'test', clientSecret: 'test' });
    assert.doesNotThrow(() => {
      _setGeminiOAuthConfig(null);
    });
  });
});

describe('_resetGeminiTokenCache', () => {
  it('can be called multiple times without error', () => {
    assert.doesNotThrow(() => {
      _resetGeminiTokenCache();
      _resetGeminiTokenCache();
    });
  });
});

// ── getGeminiToken — cached token path ───────────────────────────────────────

describe('getGeminiToken — cached valid access_token', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-gemini-cached-'));
    mock.method(os, 'homedir', () => tmpDir);
    _resetGeminiTokenCache();
  });

  afterEach(() => {
    mock.restoreAll();
    _resetGeminiTokenCache();
    _setGeminiOAuthConfig(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns cached access_token when not expired', async () => {
    const geminiDir = path.join(tmpDir, '.gemini');
    fs.mkdirSync(geminiDir, { recursive: true });
    const creds = {
      access_token: 'cached-token-123',
      expiry_date: Date.now() + 600_000, // 10 minutes in future
      refresh_token: 'rt-123',
    };
    fs.writeFileSync(path.join(geminiDir, 'oauth_creds.json'), JSON.stringify(creds));

    const token = await getGeminiToken();
    assert.equal(token, 'cached-token-123');
  });

  it('returns null when refresh_token is missing and access_token expired', async () => {
    const geminiDir = path.join(tmpDir, '.gemini');
    fs.mkdirSync(geminiDir, { recursive: true });
    const creds = {
      access_token: 'expired-token',
      expiry_date: Date.now() - 600_000, // expired
    };
    fs.writeFileSync(path.join(geminiDir, 'oauth_creds.json'), JSON.stringify(creds));

    const token = await getGeminiToken();
    assert.equal(token, null);
  });

  it('uses module-level cache on second call', async () => {
    const geminiDir = path.join(tmpDir, '.gemini');
    fs.mkdirSync(geminiDir, { recursive: true });
    const creds = {
      access_token: 'cached-token-abc',
      expiry_date: Date.now() + 600_000,
    };
    fs.writeFileSync(path.join(geminiDir, 'oauth_creds.json'), JSON.stringify(creds));

    const token1 = await getGeminiToken();
    const token2 = await getGeminiToken();
    assert.equal(token1, 'cached-token-abc');
    assert.equal(token2, 'cached-token-abc');
  });
});

// ── getGeminiProjectId ───────────────────────────────────────────────────────

describe('getGeminiProjectId', () => {
  beforeEach(() => {
    _resetGeminiTokenCache();
  });

  afterEach(() => {
    mock.restoreAll();
    _resetGeminiTokenCache();
  });

  it('returns null when API responds with non-ok status', async () => {
    mock.method(globalThis, 'fetch', async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
    }));

    const result = await getGeminiProjectId('fake-token');
    assert.equal(result, null);
  });

  it('returns project ID from successful response', async () => {
    mock.method(globalThis, 'fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({ cloudaicompanionProject: 'my-project-123' }),
    }));

    const result = await getGeminiProjectId('fake-token');
    assert.equal(result, 'my-project-123');
  });

  it('returns null when response has no cloudaicompanionProject', async () => {
    // Reset cache so it does the fetch
    _resetGeminiTokenCache();
    mock.method(globalThis, 'fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));

    const result = await getGeminiProjectId('fake-token');
    assert.equal(result, null);
  });
});

// ── executeGeminiDirect — error paths ────────────────────────────────────────

describe('executeGeminiDirect — error paths', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-gemini-exec-'));
    mock.method(os, 'homedir', () => tmpDir);
    _resetGeminiTokenCache();
    _setGeminiOAuthConfig(null);
  });

  afterEach(() => {
    mock.restoreAll();
    _resetGeminiTokenCache();
    _setGeminiOAuthConfig(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns error result when no OAuth credentials exist', async () => {
    const noopMetrics = {
      recordCallStart: () => 'handle',
      recordCallComplete: () => {},
      recordCallError: () => {},
      recordExecution: async <T>(_a: string, _m: string | undefined, fn: () => Promise<T>) => fn(),
    };

    const result = await executeGeminiDirect('test prompt', {}, noopMetrics);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /No Gemini OAuth credentials/);
  });

  it('returns error result when project ID cannot be resolved', async () => {
    // Set up valid token file
    const geminiDir = path.join(tmpDir, '.gemini');
    fs.mkdirSync(geminiDir, { recursive: true });
    const creds = {
      access_token: 'valid-token',
      expiry_date: Date.now() + 600_000,
    };
    fs.writeFileSync(path.join(geminiDir, 'oauth_creds.json'), JSON.stringify(creds));

    // Mock fetch to return non-ok for project ID request
    mock.method(globalThis, 'fetch', async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    }));

    const noopMetrics = {
      recordCallStart: () => 'handle',
      recordCallComplete: () => {},
      recordCallError: () => {},
      recordExecution: async <T>(_a: string, _m: string | undefined, fn: () => Promise<T>) => fn(),
    };

    const result = await executeGeminiDirect('test prompt', {}, noopMetrics);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /Could not resolve Gemini project ID/);
  });

  it('handles timeout errors gracefully', async () => {
    // Set up valid token file
    const geminiDir = path.join(tmpDir, '.gemini');
    fs.mkdirSync(geminiDir, { recursive: true });
    const creds = {
      access_token: 'valid-token',
      expiry_date: Date.now() + 600_000,
    };
    fs.writeFileSync(path.join(geminiDir, 'oauth_creds.json'), JSON.stringify(creds));

    // Mock fetch: first call returns project, second throws timeout
    let callCount = 0;
    mock.method(globalThis, 'fetch', async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ cloudaicompanionProject: 'proj-1' }),
        };
      }
      const err = new Error('Request timed out');
      err.name = 'TimeoutError';
      throw err;
    });

    const noopMetrics = {
      recordCallStart: () => 'handle',
      recordCallComplete: () => {},
      recordCallError: () => {},
      recordExecution: async <T>(_a: string, _m: string | undefined, fn: () => Promise<T>) => fn(),
    };

    const result = await executeGeminiDirect('test prompt', { timeoutMs: 100 }, noopMetrics);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /timeout/i);
    assert.equal(result.timedOut, true);
  });
});
