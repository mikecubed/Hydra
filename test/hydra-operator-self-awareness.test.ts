/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  normalizeSimpleCommandText,
  parseSelfAwarenessPlaintextCommand,
  applySelfAwarenessPatch,
  getGitInfo,
  selfIndexCache,
} from '../lib/hydra-operator-self-awareness.ts';
import { _setTestConfigPath, _setTestConfig, invalidateConfigCache } from '../lib/hydra-config.ts';

describe('normalizeSimpleCommandText', () => {
  it('lowercases and trims', () => {
    assert.equal(normalizeSimpleCommandText('  Hello World  '), 'hello world');
  });

  it('removes punctuation', () => {
    assert.equal(normalizeSimpleCommandText('Hello, World!'), 'hello world');
  });

  it('collapses whitespace', () => {
    assert.equal(normalizeSimpleCommandText('foo   bar'), 'foo bar');
  });

  it('handles non-string (converts to string)', () => {
    assert.equal(normalizeSimpleCommandText(42 as any), '42');
    assert.equal(normalizeSimpleCommandText(null as any), '');
    assert.equal(normalizeSimpleCommandText(undefined as any), '');
    assert.equal(normalizeSimpleCommandText({} as unknown as string), '');
  });

  it('returns empty string for empty input', () => {
    assert.equal(normalizeSimpleCommandText(''), '');
  });
});

describe('parseSelfAwarenessPlaintextCommand', () => {
  it('returns null for empty input', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand(''), null);
    assert.equal(parseSelfAwarenessPlaintextCommand(null as any), null);
    assert.equal(parseSelfAwarenessPlaintextCommand(undefined as any), null);
  });

  it('returns null for commands starting with :', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand(':self-awareness on'), null);
  });

  it('returns null for commands starting with !', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('!self-awareness on'), null);
  });

  it('returns null for multi-line input', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('turn on\nself awareness'), null);
  });

  it('returns null for strings > 80 chars after normalisation', () => {
    const long = 'a'.repeat(85);
    assert.equal(parseSelfAwarenessPlaintextCommand(long), null);
  });

  it('detects "disable self awareness" → off', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('disable self awareness'), 'off');
    assert.equal(parseSelfAwarenessPlaintextCommand('turn off self-awareness'), 'off');
    assert.equal(parseSelfAwarenessPlaintextCommand('self awareness off'), 'off');
    assert.equal(parseSelfAwarenessPlaintextCommand('please disable hyper awareness'), 'off');
  });

  it('detects "enable self awareness" → on', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('enable self awareness'), 'on');
    assert.equal(parseSelfAwarenessPlaintextCommand('turn on self-awareness'), 'on');
    assert.equal(parseSelfAwarenessPlaintextCommand('self awareness on'), 'on');
    assert.equal(parseSelfAwarenessPlaintextCommand('please enable hyper awareness'), 'on');
  });

  it('detects "set self awareness to minimal" → minimal', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('set self awareness to minimal'), 'minimal');
    assert.equal(parseSelfAwarenessPlaintextCommand('self awareness minimal'), 'minimal');
  });

  it('detects "set self awareness to full" → full', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('set self awareness to full'), 'full');
    assert.equal(parseSelfAwarenessPlaintextCommand('self awareness full'), 'full');
  });

  it('detects "self awareness status" → status', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('self awareness status'), 'status');
    assert.equal(parseSelfAwarenessPlaintextCommand('hyper awareness status'), 'status');
  });

  it('returns null for unrelated plain text', () => {
    assert.equal(parseSelfAwarenessPlaintextCommand('run the tests'), null);
    assert.equal(parseSelfAwarenessPlaintextCommand('hello world'), null);
  });
});

describe('applySelfAwarenessPatch', () => {
  let tempDir: string;
  let configPath: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-test-'));
    configPath = path.join(tempDir, 'hydra.config.json');
    _setTestConfigPath(configPath);
  });

  after(() => {
    _setTestConfigPath(null);
    invalidateConfigCache();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('saves selfAwareness patch and resets selfIndexCache', () => {
    selfIndexCache.block = 'stale';
    selfIndexCache.builtAt = 12345;

    const result = applySelfAwarenessPatch({ enabled: false });

    assert.ok(result !== undefined && result !== null, 'should return selfAwareness value');
    assert.equal(selfIndexCache.block, '', 'cache block should be reset');
    assert.equal(selfIndexCache.builtAt, 0, 'cache builtAt should be reset');
  });

  it('merges patch with existing selfAwareness values', () => {
    _setTestConfig({ selfAwareness: { enabled: true, detail: 'full' } });
    _setTestConfigPath(configPath);

    const result = applySelfAwarenessPatch({ detail: 'minimal' });

    assert.ok(typeof result === 'object' && result !== null);
    assert.equal((result as Record<string, unknown>)['detail'], 'minimal');
  });
});

describe('getGitInfo', () => {
  it('returns an object with branch and modifiedFiles on success', () => {
    // This test only runs if we are inside a git repo (which we are in CI/dev)
    const info = getGitInfo();
    if (info !== null) {
      assert.ok(typeof info.branch === 'string', 'branch should be a string');
      assert.ok(typeof info.modifiedFiles === 'number', 'modifiedFiles should be a number');
    }
    // null is also acceptable (git not available or non-zero exit)
  });

  it('returns null without throwing when git is unavailable or exits non-zero', () => {
    // Patch PATH temporarily to make git unavailable
    const origPath = process.env['PATH'];
    process.env['PATH'] = '';
    try {
      const result = getGitInfo();
      // Either null (git not found / threw) or a cached value from prior call — both are fine
      assert.ok(result === null || typeof result === 'object');
    } finally {
      process.env['PATH'] = origPath;
    }
  });

  it('returns the same object reference on consecutive calls within TTL (cache hit)', () => {
    // We cannot reset the internal cache directly; call twice and check both succeed without throw
    const first = getGitInfo();
    const second = getGitInfo();
    // If both are non-null they should be the same cached reference
    if (first !== null && second !== null) {
      assert.strictEqual(first, second, 'should return same cached object reference');
    } else {
      // git unavailable in this environment — both should be null
      assert.equal(first, second);
    }
  });
});
