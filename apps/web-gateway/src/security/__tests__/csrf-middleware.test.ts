import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCsrfMiddleware } from '../csrf-middleware.ts';
import { createMockReqRes } from '../../shared/__tests__/test-helpers.ts';

describe('CSRF middleware', () => {
  const middleware = createCsrfMiddleware();

  it('GET bypasses CSRF check', () => {
    const { req, res } = createMockReqRes('GET');
    let called = false;
    middleware(req, res, () => {
      called = true;
    });
    assert.equal(called, true);
  });

  it('HEAD bypasses CSRF check', () => {
    const { req, res } = createMockReqRes('HEAD');
    let called = false;
    middleware(req, res, () => {
      called = true;
    });
    assert.equal(called, true);
  });

  it('OPTIONS bypasses CSRF check', () => {
    const { req, res } = createMockReqRes('OPTIONS');
    let called = false;
    middleware(req, res, () => {
      called = true;
    });
    assert.equal(called, true);
  });

  it('POST with valid token passes', () => {
    const { req, res } = createMockReqRes('POST', {
      cookie: '__csrf=tok123',
      'x-csrf-token': 'tok123',
    });
    let called = false;
    middleware(req, res, () => {
      called = true;
    });
    assert.equal(called, true);
  });

  it('POST without header returns 403', () => {
    const { req, res } = createMockReqRes('POST', { cookie: '__csrf=tok123' });
    middleware(req, res, () => {});
    assert.equal(res.statusCode, 403);
  });

  it('POST with wrong token returns 403', () => {
    const { req, res } = createMockReqRes('POST', {
      cookie: '__csrf=tok123',
      'x-csrf-token': 'wrong',
    });
    middleware(req, res, () => {});
    assert.equal(res.statusCode, 403);
  });
});
