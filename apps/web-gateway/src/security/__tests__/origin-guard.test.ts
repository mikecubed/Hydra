import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createOriginGuard } from '../origin-guard.ts';

function createTestApp() {
  const app = new Hono();
  app.use('*', createOriginGuard('http://127.0.0.1:4174'));
  app.all('/test', (c) => c.json({ ok: true }));
  return app;
}

describe('Origin guard', () => {
  it('GET without origin passes', async () => {
    const app = createTestApp();
    const res = await app.request('/test');
    assert.equal(res.status, 200);
  });

  it('POST with matching origin passes', async () => {
    const app = createTestApp();
    const res = await app.request('/test', {
      method: 'POST',
      headers: { Origin: 'http://127.0.0.1:4174' },
    });
    assert.equal(res.status, 200);
  });

  it('POST with mismatched origin returns 403', async () => {
    const app = createTestApp();
    const res = await app.request('/test', {
      method: 'POST',
      headers: { Origin: 'http://evil.com' },
    });
    assert.equal(res.status, 403);
  });

  it('POST with missing origin returns 403', async () => {
    const app = createTestApp();
    const res = await app.request('/test', { method: 'POST' });
    assert.equal(res.status, 403);
  });

  it('WebSocket upgrade with wrong origin returns 403', async () => {
    const app = createTestApp();
    const res = await app.request('/test', {
      headers: {
        Upgrade: 'websocket',
        Origin: 'http://evil.com',
      },
    });
    assert.equal(res.status, 403);
  });
});
