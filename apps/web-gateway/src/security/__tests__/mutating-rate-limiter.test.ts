import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createMutatingRateLimiter } from '../mutating-rate-limiter.ts';
import { createSourceKeyMiddleware } from '../source-key.ts';
import { FakeClock } from '../../shared/clock.ts';
import type { GatewayEnv } from '../../shared/types.ts';

describe('Mutating rate limiter', () => {
  let clock: FakeClock;

  beforeEach(() => {
    clock = new FakeClock(Date.now());
  });

  it('GET passes through', async () => {
    const app = new Hono<GatewayEnv>();
    app.use('*', createSourceKeyMiddleware());
    app.use('*', createMutatingRateLimiter(clock, { maxAttempts: 3 }));
    app.get('/test', (c) => c.json({ ok: true }));
    const res = await app.request('/test');
    assert.equal(res.status, 200);
  });

  it('POST under threshold passes', async () => {
    const app = new Hono<GatewayEnv>();
    app.use('*', createSourceKeyMiddleware());
    app.use('*', createMutatingRateLimiter(clock, { maxAttempts: 3 }));
    app.post('/test', (c) => c.json({ ok: true }));
    const res = await app.request('/test', { method: 'POST' });
    assert.equal(res.status, 200);
  });

  it('at threshold returns 429', async () => {
    const app = new Hono<GatewayEnv>();
    app.use('*', createSourceKeyMiddleware());
    app.use('*', createMutatingRateLimiter(clock, { maxAttempts: 2 }));
    app.post('/test', (c) => c.json({ ok: true }));
    for (let i = 0; i < 2; i++) {
      await app.request('/test', { method: 'POST' });
    }
    const res = await app.request('/test', { method: 'POST' });
    assert.equal(res.status, 429);
  });

  it('window slides after lockout', async () => {
    const app = new Hono<GatewayEnv>();
    app.use('*', createSourceKeyMiddleware());
    app.use('*', createMutatingRateLimiter(clock, { maxAttempts: 2, lockoutMs: 60_000 }));
    app.post('/test', (c) => c.json({ ok: true }));
    for (let i = 0; i < 2; i++) {
      await app.request('/test', { method: 'POST' });
    }
    // Advance past lockout
    clock.advance(120_001);
    const res = await app.request('/test', { method: 'POST' });
    assert.equal(res.status, 200);
  });

  it('spoofed X-Forwarded-For ignored without trusted proxies', async () => {
    const app = new Hono<GatewayEnv>();
    app.use('*', createSourceKeyMiddleware());
    app.use('*', createMutatingRateLimiter(clock, { maxAttempts: 2 }));
    app.post('/test', (c) => c.json({ ok: true }));

    // Exhaust rate limit from the default source key
    for (let i = 0; i < 2; i++) {
      await app.request('/test', { method: 'POST' });
    }

    // Attacker sends a different X-Forwarded-For to try to bypass
    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'x-forwarded-for': 'spoofed-ip' },
    });
    assert.equal(res.status, 429, 'spoofed header must not bypass rate limit');
  });
});
