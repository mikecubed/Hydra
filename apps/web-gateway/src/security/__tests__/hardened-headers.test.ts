import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHardenedHeaders } from '../hardened-headers.ts';
import { createMockReqRes } from '../../shared/__tests__/test-helpers.ts';

describe('Hardened headers', () => {
  it('sets CSP', () => {
    const middleware = createHardenedHeaders();
    const { req, res } = createMockReqRes('GET');
    middleware(req, res, () => {});
    assert.ok(res.getHeader('Content-Security-Policy'));
  });

  it('sets X-Content-Type-Options', () => {
    const middleware = createHardenedHeaders();
    const { req, res } = createMockReqRes('GET');
    middleware(req, res, () => {});
    assert.equal(res.getHeader('X-Content-Type-Options'), 'nosniff');
  });

  it('sets X-Frame-Options', () => {
    const middleware = createHardenedHeaders();
    const { req, res } = createMockReqRes('GET');
    middleware(req, res, () => {});
    assert.equal(res.getHeader('X-Frame-Options'), 'DENY');
  });

  it('sets Referrer-Policy', () => {
    const middleware = createHardenedHeaders();
    const { req, res } = createMockReqRes('GET');
    middleware(req, res, () => {});
    assert.equal(res.getHeader('Referrer-Policy'), 'strict-origin-when-cross-origin');
  });

  it('HSTS present only when TLS active', () => {
    const withTls = createHardenedHeaders({ tlsActive: true });
    const withoutTls = createHardenedHeaders({ tlsActive: false });

    const r1 = createMockReqRes('GET');
    withTls(r1.req, r1.res, () => {});
    assert.ok(r1.res.getHeader('Strict-Transport-Security'));

    const r2 = createMockReqRes('GET');
    withoutTls(r2.req, r2.res, () => {});
    assert.equal(r2.res.getHeader('Strict-Transport-Security'), undefined);
  });
});
