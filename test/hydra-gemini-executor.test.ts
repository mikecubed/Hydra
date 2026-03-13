/**
 * Tests for lib/hydra-shared/gemini-executor.ts
 */
import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getGeminiToken,
  executeGeminiDirect,
  _resetGeminiTokenCache,
  _setGeminiOAuthConfig,
} from '../lib/hydra-shared/gemini-executor.ts';

describe('getGeminiToken — no credentials file', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-gemini-nofile-'));
    mock.method(os, 'homedir', () => tmpDir);
    _resetGeminiTokenCache();
  });

  afterEach(() => {
    mock.restoreAll();
    _resetGeminiTokenCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when ~/.gemini/oauth_creds.json does not exist', async () => {
    const token = await getGeminiToken();
    assert.strictEqual(token, null);
  });
});

describe('getGeminiToken — refresh_token present but secret missing', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-gemini-refresh-'));
    mock.method(os, 'homedir', () => tmpDir);
    _resetGeminiTokenCache();
    // Inject empty clientSecret via test seam (avoids env-var const-at-load-time problem)
    _setGeminiOAuthConfig({ clientId: 'test-client-id', clientSecret: '' });
  });

  afterEach(() => {
    mock.restoreAll();
    _resetGeminiTokenCache();
    _setGeminiOAuthConfig(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws when refresh_token present but clientSecret is empty', async () => {
    const geminiDir = path.join(tmpDir, '.gemini');
    fs.mkdirSync(geminiDir, { recursive: true });
    const credsPath = path.join(geminiDir, 'oauth_creds.json');

    // Expired token with a refresh_token to trigger the refresh path
    const pastExpiry = Date.now() - 3600 * 1000;
    fs.writeFileSync(
      credsPath,
      JSON.stringify({
        access_token: 'old-token',
        expiry_date: pastExpiry,
        refresh_token: 'refresh-me',
      }),
    );

    await assert.rejects(
      () => getGeminiToken(),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes('GEMINI_OAUTH_CLIENT_SECRET'),
          `expected error to mention GEMINI_OAUTH_CLIENT_SECRET, got: ${err.message}`,
        );
        return true;
      },
    );
  });
});

describe('executeGeminiDirect — no credentials', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-gemini-exec-'));
    mock.method(os, 'homedir', () => tmpDir);
    _resetGeminiTokenCache();
  });

  afterEach(() => {
    mock.restoreAll();
    _resetGeminiTokenCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns ok:false when no credentials file exists', async () => {
    const result = await executeGeminiDirect('test prompt');
    assert.strictEqual(result.ok, false, 'should return ok:false with no credentials');
    assert.ok(typeof result.output === 'string');
    assert.ok(typeof result.stderr === 'string');
    assert.ok(typeof result.durationMs === 'number');
  });
});
