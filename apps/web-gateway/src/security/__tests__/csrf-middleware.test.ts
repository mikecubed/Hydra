import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createCsrfMiddleware } from '../csrf-middleware.ts';

function createTestApp() {
  const app = new Hono();
  app.use('*', createCsrfMiddleware());
  app.all('/test', (c) => c.json({ ok: true }));
  return app;
}

describe('CSRF middleware', () => {
  it('GET bypasses CSRF check', async () => {
    const app = createTestApp();
    const res = await app.request('/test');
    assert.equal(res.status, 200);
  });

  it('HEAD bypasses CSRF check', async () => {
    const app = createTestApp();
    const res = await app.request('/test', { method: 'HEAD' });
    assert.equal(res.status, 200);
  });

  it('OPTIONS bypasses CSRF check', async () => {
    const app = createTestApp();
    const res = await app.request('/test', { method: 'OPTIONS' });
    assert.equal(res.status, 200);
  });

  it('POST with valid token passes', async () => {
    const app = createTestApp();
    const res = await app.request('/test', {
      method: 'POST',
      headers: {
        Cookie: '__csrf=tok123',
        'X-CSRF-Token': 'tok123',
      },
    });
    assert.equal(res.status, 200);
  });

  it('POST without header returns 403', async () => {
    const app = createTestApp();
    const res = await app.request('/test', {
      method: 'POST',
      headers: { Cookie: '__csrf=tok123' },
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { ok: boolean; code: string; category: string };
    assert.equal(body.ok, false);
    assert.equal(body.code, 'CSRF_INVALID');
    assert.equal(body.category, 'validation');
  });

  it('POST with wrong token returns 403', async () => {
    const app = createTestApp();
    const res = await app.request('/test', {
      method: 'POST',
      headers: {
        Cookie: '__csrf=tok123',
        'X-CSRF-Token': 'wrong',
      },
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { ok: boolean; code: string; category: string };
    assert.equal(body.ok, false);
    assert.equal(body.code, 'CSRF_INVALID');
    assert.equal(body.category, 'validation');
  });
});
