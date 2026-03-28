/**
 * Tests for mutations response-translator — maps ErrorCategory to HTTP status + code.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { translateMutationError } from '../response-translator.ts';

describe('translateMutationError', () => {
  it('maps validation category to VALIDATION_FAILED with 400', () => {
    const result = translateMutationError('validation');
    assert.equal(result.status, 400);
    assert.equal(result.code, 'VALIDATION_FAILED');
    assert.equal(result.message, 'Validation error');
  });

  it('maps stale-revision category to STALE_REVISION with 409', () => {
    const result = translateMutationError('stale-revision');
    assert.equal(result.status, 409);
    assert.equal(result.code, 'STALE_REVISION');
  });

  it('maps daemon-unavailable category to DAEMON_UNAVAILABLE with 503', () => {
    const result = translateMutationError('daemon-unavailable');
    assert.equal(result.status, 503);
    assert.equal(result.code, 'DAEMON_UNAVAILABLE');
  });

  it('maps workflow-conflict category to WORKFLOW_CONFLICT with 409', () => {
    const result = translateMutationError('workflow-conflict');
    assert.equal(result.status, 409);
    assert.equal(result.code, 'WORKFLOW_CONFLICT');
  });

  it('maps auth category to UNAUTHORIZED with 401', () => {
    const result = translateMutationError('auth');
    assert.equal(result.status, 401);
    assert.equal(result.code, 'UNAUTHORIZED');
  });

  it('maps rate-limit category to RATE_LIMITED with 429', () => {
    const result = translateMutationError('rate-limit');
    assert.equal(result.status, 429);
    assert.equal(result.code, 'RATE_LIMITED');
  });
});
