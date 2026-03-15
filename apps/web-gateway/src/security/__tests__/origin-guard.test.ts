import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOriginGuard } from '../origin-guard.ts';
import { createMockReqRes } from '../../shared/__tests__/test-helpers.ts';

describe('Origin guard', () => {
  const guard = createOriginGuard('http://127.0.0.1:4174');

  it('GET without origin passes', () => {
    const { req, res } = createMockReqRes('GET');
    let called = false;
    guard(req, res, () => {
      called = true;
    });
    assert.equal(called, true);
  });

  it('POST with matching origin passes', () => {
    const { req, res } = createMockReqRes('POST', { origin: 'http://127.0.0.1:4174' });
    let called = false;
    guard(req, res, () => {
      called = true;
    });
    assert.equal(called, true);
  });

  it('POST with mismatched origin returns 403', () => {
    const { req, res } = createMockReqRes('POST', { origin: 'http://evil.com' });
    guard(req, res, () => {});
    assert.equal(res.statusCode, 403);
  });

  it('POST with missing origin returns 403', () => {
    const { req, res } = createMockReqRes('POST');
    guard(req, res, () => {});
    assert.equal(res.statusCode, 403);
  });

  it('WebSocket upgrade with wrong origin returns 403', () => {
    const { req, res } = createMockReqRes('GET', {
      upgrade: 'websocket',
      origin: 'http://evil.com',
    });
    guard(req, res, () => {});
    assert.equal(res.statusCode, 403);
  });
});
