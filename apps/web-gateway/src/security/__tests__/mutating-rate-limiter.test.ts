import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createMutatingRateLimiter } from '../mutating-rate-limiter.ts';
import { FakeClock } from '../../shared/clock.ts';

describe('Mutating rate limiter', () => {
  let clock: FakeClock;

  beforeEach(() => {
    clock = new FakeClock(Date.now());
  });

  it('GET passes through', async () => {
    const app = new Hono();
    app.use('*', createMutatingRateLimiter(clock, { maxAttempts: 3 }));
    app.get('/test', (c) => c.json({ ok: true }));
    const res = await app.request('/test');
    assert.equal(res.status, 200);
  });

  it('POST under threshold passes', async () => {
    const app = new Hono();
    app.use('*', createMutatingRateLimiter(clock, { maxAttempts: 3 }));
    app.post('/test', (c) => c.json({ ok: true }));
    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'X-Forwarded-For': '127.0.0.1' },
    });
    assert.equal(res.status, 200);
  });

  it('at threshold returns 429', async () => {
    const app = new Hono();
    app.use('*', createMutatingRateLimiter(clock, { maxAttempts: 2 }));
    app.post('/test', (c) => c.json({ ok: true }));
    for (let i = 0; i < 2; i++) {
      await app.request('/test', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '127.0.0.1' },
      });
    }
    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'X-Forwarded-For': '127.0.0.1' },
    });
    assert.equal(res.status, 429);
  });

  it('window slides after lockout', async () => {
    const app = new Hono();
    app.use('*', createMutatingRateLimiter(clock, { maxAttempts: 2, lockoutMs: 60_000 }));
    app.post('/test', (c) => c.json({ ok: true }));
    for (let i = 0; i < 2; i++) {
      await app.request('/test', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '127.0.0.1' },
      });
    }
    // Advance past lockout
    clock.advance(120_001);
    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'X-Forwarded-For': '127.0.0.1' },
    });
    assert.equal(res.status, 200);
  });
});
