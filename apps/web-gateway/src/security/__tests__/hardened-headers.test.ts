import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createHardenedHeaders } from '../hardened-headers.ts';

describe('Hardened headers', () => {
  it('sets CSP', async () => {
    const app = new Hono();
    app.use('*', createHardenedHeaders());
    app.get('/test', (c) => c.json({ ok: true }));
    const res = await app.request('/test');
    assert.ok(res.headers.get('Content-Security-Policy'));
  });

  it('sets X-Content-Type-Options', async () => {
    const app = new Hono();
    app.use('*', createHardenedHeaders());
    app.get('/test', (c) => c.json({ ok: true }));
    const res = await app.request('/test');
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  });

  it('sets X-Frame-Options', async () => {
    const app = new Hono();
    app.use('*', createHardenedHeaders());
    app.get('/test', (c) => c.json({ ok: true }));
    const res = await app.request('/test');
    assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
  });

  it('sets Referrer-Policy', async () => {
    const app = new Hono();
    app.use('*', createHardenedHeaders());
    app.get('/test', (c) => c.json({ ok: true }));
    const res = await app.request('/test');
    assert.equal(res.headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin');
  });

  it('HSTS present only when TLS active', async () => {
    const withTls = new Hono();
    withTls.use('*', createHardenedHeaders({ tlsActive: true }));
    withTls.get('/test', (c) => c.json({ ok: true }));
    const r1 = await withTls.request('/test');
    assert.ok(r1.headers.get('Strict-Transport-Security'));

    const withoutTls = new Hono();
    withoutTls.use('*', createHardenedHeaders({ tlsActive: false }));
    withoutTls.get('/test', (c) => c.json({ ok: true }));
    const r2 = await withoutTls.request('/test');
    assert.equal(r2.headers.get('Strict-Transport-Security'), null);
  });
});
