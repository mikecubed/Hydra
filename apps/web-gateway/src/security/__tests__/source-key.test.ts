/**
 * Tests for source-key derivation — verifies that spoofed X-Forwarded-For
 * cannot bypass rate limits without explicit trusted-proxy configuration.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { resolveSourceKey, createSourceKeyMiddleware } from '../source-key.ts';
import type { Context } from 'hono';
import type { GatewayEnv } from '../../shared/types.ts';

/** Build a minimal Hono context with optional env.incoming socket mock. */
function buildApp(trustedProxies?: string[]): { app: Hono<GatewayEnv>; receivedKeys: string[] } {
  const receivedKeys: string[] = [];
  const app = new Hono<GatewayEnv>();
  app.use('*', createSourceKeyMiddleware({ trustedProxies }));
  app.all('/test', (c) => {
    receivedKeys.push(c.get('sourceKey'));
    return c.json({ key: c.get('sourceKey') });
  });
  return { app, receivedKeys };
}

describe('Source-key derivation', () => {
  describe('resolveSourceKey (unit)', () => {
    it('returns "unknown" when no socket and no trusted proxies', () => {
      // Simulate Hono test context (no env.incoming)
      const fakeCtx = {
        env: {},
        // eslint-disable-next-line unicorn/no-useless-undefined -- explicitly models missing header
        req: { header: () => undefined },
      } as unknown as Context;
      const key = resolveSourceKey(fakeCtx);
      assert.equal(key, 'unknown');
    });

    it('returns remoteAddress when no trusted proxies, even with X-Forwarded-For', () => {
      const fakeCtx = {
        env: { incoming: { socket: { remoteAddress: '10.0.0.5' } } },
        req: { header: () => '192.168.1.100, 10.0.0.1' },
      } as unknown as Context;
      const key = resolveSourceKey(fakeCtx);
      assert.equal(key, '10.0.0.5', 'must ignore X-Forwarded-For without trusted proxies');
    });

    it('returns remoteAddress when trusted proxies configured but socket is not in the set', () => {
      const trusted = new Set(['10.0.0.1']);
      const fakeCtx = {
        env: { incoming: { socket: { remoteAddress: '192.168.1.50' } } },
        req: { header: () => '1.2.3.4, 10.0.0.1' },
      } as unknown as Context;
      const key = resolveSourceKey(fakeCtx, trusted);
      assert.equal(key, '192.168.1.50', 'direct connection is not from a trusted proxy');
    });

    it('walks X-Forwarded-For right-to-left when socket is a trusted proxy', () => {
      const trusted = new Set(['10.0.0.1', '10.0.0.2']);
      const fakeCtx = {
        env: { incoming: { socket: { remoteAddress: '10.0.0.1' } } },
        req: {
          header: (name: string) => (name === 'x-forwarded-for' ? '1.2.3.4, 10.0.0.2' : undefined),
        },
      } as unknown as Context;
      const key = resolveSourceKey(fakeCtx, trusted);
      assert.equal(key, '1.2.3.4', 'first untrusted IP from right');
    });

    it('returns remoteAddress when X-Forwarded-For contains only trusted IPs', () => {
      const trusted = new Set(['10.0.0.1', '10.0.0.2']);
      const fakeCtx = {
        env: { incoming: { socket: { remoteAddress: '10.0.0.1' } } },
        req: {
          header: (name: string) => (name === 'x-forwarded-for' ? '10.0.0.2, 10.0.0.1' : undefined),
        },
      } as unknown as Context;
      const key = resolveSourceKey(fakeCtx, trusted);
      assert.equal(key, '10.0.0.1', 'all IPs trusted, fall back to remoteAddress');
    });

    it('returns remoteAddress when X-Forwarded-For is absent but socket is trusted', () => {
      const trusted = new Set(['10.0.0.1']);
      const fakeCtx = {
        env: { incoming: { socket: { remoteAddress: '10.0.0.1' } } },
        // eslint-disable-next-line unicorn/no-useless-undefined -- explicitly models missing header
        req: { header: () => undefined },
      } as unknown as Context;
      const key = resolveSourceKey(fakeCtx, trusted);
      assert.equal(key, '10.0.0.1');
    });
  });

  describe('createSourceKeyMiddleware (integration)', () => {
    it('defaults to "unknown" in Hono test env without trusted proxies', async () => {
      const { app, receivedKeys } = buildApp();
      const res = await app.request('/test', {
        method: 'GET',
        headers: { 'x-forwarded-for': '1.2.3.4' },
      });
      assert.equal(res.status, 200);
      assert.equal(receivedKeys[0], 'unknown', 'must not use X-Forwarded-For without trust');
    });

    it('spoofed X-Forwarded-For is ignored without trusted proxies', async () => {
      const { app, receivedKeys } = buildApp();
      await app.request('/test', {
        method: 'GET',
        headers: { 'x-forwarded-for': 'spoofed-ip' },
      });
      assert.equal(receivedKeys[0], 'unknown');
    });

    it('sets sourceKey in context for downstream consumers', async () => {
      const { app } = buildApp();
      const res = await app.request('/test');
      const body = (await res.json()) as { key: string };
      assert.equal(typeof body.key, 'string');
    });
  });
});
