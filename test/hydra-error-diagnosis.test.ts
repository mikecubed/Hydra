/**
 * Tests for lib/hydra-shared/error-diagnosis.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseAgentError } from '../lib/hydra-shared/error-diagnosis.ts';
import type { ExecuteResult } from '../lib/types.ts';

function makeResult(overrides: Partial<ExecuteResult> = {}): ExecuteResult {
  return {
    ok: false,
    output: '',
    stderr: '',
    error: null,
    exitCode: 1,
    signal: null,
    durationMs: 100,
    timedOut: false,
    ...overrides,
  };
}

describe('diagnoseAgentError', () => {
  it('returns result unchanged when ok is true', () => {
    const result = makeResult({ ok: true, exitCode: 0 });
    const out = diagnoseAgentError('claude', result);
    assert.equal(out.errorCategory, undefined);
    assert.equal(out.errorDetail, undefined);
  });

  it('classifies auth errors', () => {
    const result = makeResult({ stderr: 'Authentication failed: invalid API key' });
    diagnoseAgentError('claude', result);
    assert.equal(result.errorCategory, 'auth');
    assert.equal(result.errorDetail, 'Authentication or API key issue');
  });

  it('classifies OPENAI_API_KEY missing as auth', () => {
    const result = makeResult({ stderr: 'OPENAI_API_KEY is not set' });
    diagnoseAgentError('claude', result);
    assert.equal(result.errorCategory, 'auth');
  });

  it('classifies 401 Unauthorized as auth', () => {
    const result = makeResult({ stderr: 'received 401 unauthorized' });
    diagnoseAgentError('claude', result);
    assert.equal(result.errorCategory, 'auth');
  });

  it('classifies ENOENT as invocation', () => {
    const result = makeResult({ stderr: 'spawn claude ENOENT' });
    diagnoseAgentError('claude', result);
    assert.equal(result.errorCategory, 'invocation');
  });

  it('classifies command not found as invocation', () => {
    const result = makeResult({ stderr: 'command not found: claude-code' });
    diagnoseAgentError('claude', result);
    assert.equal(result.errorCategory, 'invocation');
  });

  it('classifies permission denied as permission', () => {
    const result = makeResult({ stderr: 'permission denied: /usr/local/bin/claude' });
    diagnoseAgentError('claude', result);
    assert.equal(result.errorCategory, 'permission');
  });

  it('classifies ECONNREFUSED as network error', () => {
    const result = makeResult({ stderr: 'ECONNREFUSED 127.0.0.1:8080' });
    diagnoseAgentError('claude', result);
    assert.equal(result.errorCategory, 'network');
  });

  it('classifies sandbox violation', () => {
    const result = makeResult({ stderr: 'sandbox violation: execution not permitted' });
    diagnoseAgentError('claude', result);
    assert.equal(result.errorCategory, 'sandbox');
  });

  it('classifies OOM via pattern', () => {
    const result = makeResult({ stderr: 'JavaScript heap out of memory' });
    diagnoseAgentError('claude', result);
    assert.equal(result.errorCategory, 'oom');
  });

  it('classifies usage limit', () => {
    const result = makeResult({ stderr: "You've hit your usage limit" });
    diagnoseAgentError('claude', result);
    assert.equal(result.errorCategory, 'usage-limit');
  });

  it('classifies SIGKILL signal as oom', () => {
    const result = makeResult({ exitCode: null, signal: 'SIGKILL', stderr: '' });
    diagnoseAgentError('claude', result);
    assert.equal(result.errorCategory, 'oom');
    assert.equal(result.errorDetail, 'killed (SIGKILL / OOM)');
  });

  it('classifies SIGTERM signal', () => {
    const result = makeResult({ exitCode: null, signal: 'SIGTERM', stderr: '' });
    diagnoseAgentError('claude', result);
    assert.equal(result.errorCategory, 'signal');
    assert.equal(result.errorDetail, 'terminated (SIGTERM)');
  });

  it('classifies unknown signal generically', () => {
    const result = makeResult({ exitCode: null, signal: 'SIGUSR2', stderr: '' });
    diagnoseAgentError('claude', result);
    assert.equal(result.errorCategory, 'signal');
    assert.match(result.errorDetail ?? '', /SIGUSR2/);
  });

  it('classifies exit code 127 as invocation', () => {
    const result = makeResult({ exitCode: 127, stderr: '' });
    diagnoseAgentError('claude', result);
    assert.equal(result.errorCategory, 'invocation');
    assert.equal(result.errorDetail, 'command not found');
  });

  it('classifies exit code 126 as permission', () => {
    const result = makeResult({ exitCode: 126, stderr: '' });
    diagnoseAgentError('claude', result);
    assert.equal(result.errorCategory, 'permission');
  });

  it('classifies exit code 137 as oom', () => {
    const result = makeResult({ exitCode: 137, stderr: '' });
    diagnoseAgentError('claude', result);
    assert.equal(result.errorCategory, 'oom');
  });

  it('classifies exit code 139 as crash', () => {
    const result = makeResult({ exitCode: 139, stderr: '' });
    diagnoseAgentError('claude', result);
    assert.equal(result.errorCategory, 'crash');
  });

  it('classifies null exit code with no stderr as silent-crash', () => {
    const result = makeResult({ exitCode: null, signal: null, stderr: '', error: null });
    diagnoseAgentError('claude', result);
    assert.equal(result.errorCategory, 'silent-crash');
  });

  it('classifies null exit code with stderr as unclassified', () => {
    const result = makeResult({ exitCode: null, signal: null, stderr: 'some error output' });
    diagnoseAgentError('claude', result);
    assert.equal(result.errorCategory, 'unclassified');
  });

  it('classifies silent crash on empty output with non-zero exit (code not in label map)', () => {
    // Exit code 5 is NOT in EXIT_CODE_LABELS, so step 4 is skipped.
    // With empty stdout+stderr, step 6 sets silent-crash.
    const result = makeResult({ exitCode: 5, stderr: '', output: '' });
    diagnoseAgentError('claude', result);
    assert.equal(result.errorCategory, 'silent-crash');
  });

  it('sets errorContext from matching line', () => {
    const result = makeResult({
      stderr: 'line1\nAuthentication failed: token expired\nline3',
    });
    diagnoseAgentError('claude', result);
    assert.ok(result.errorContext?.includes('Authentication failed'));
  });

  it('enriches generic error message with diagnosis (unclassified path)', () => {
    // Exit code 5 (not in EXIT_CODE_LABELS) with stderr triggers step 7 (unclassified),
    // then step 8 enriches the generic 'Exit code 5' error string.
    const result = makeResult({ exitCode: 5, stderr: 'some error output', error: 'Exit code 5' });
    diagnoseAgentError('claude', result);
    // After diagnosis, errorCategory should be set to unclassified
    assert.equal(result.errorCategory, 'unclassified');
    // The generic error string is replaced with [category] detail
    assert.ok(result.error?.includes('[unclassified]'));
  });

  it('does not overwrite a specific error message', () => {
    const result = makeResult({
      exitCode: 1,
      stderr: '',
      error: 'Very specific error message from agent',
    });
    diagnoseAgentError('claude', result);
    // Specific message should be preserved
    assert.equal(result.error, 'Very specific error message from agent');
  });
});
