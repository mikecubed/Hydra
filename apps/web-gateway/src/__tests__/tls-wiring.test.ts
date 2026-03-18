/**
 * Tests for TLS validation and secure-cookie wiring in createGatewayApp().
 *
 * Verifies:
 * - Non-loopback bind without TLS config throws at startup
 * - Loopback bind without TLS succeeds
 * - TLS config sets secure cookies and HSTS
 * - secureCookies defaults correctly based on TLS presence
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayApp, type GatewayApp } from '../index.ts';
import { FakeClock } from '../shared/clock.ts';

const ORIGIN = 'http://127.0.0.1:4174';

let gw: GatewayApp | undefined;

afterEach(() => {
  gw?.heartbeat.stop();
  gw = undefined;
});

function createGw(overrides: Parameters<typeof createGatewayApp>[0] = {}): GatewayApp {
  gw = createGatewayApp({
    clock: new FakeClock(Date.now()),
    allowedOrigin: ORIGIN,
    healthChecker: async () => true,
    heartbeatConfig: { intervalMs: 60_000 },
    ...overrides,
  });
  return gw;
}

describe('TLS wiring in createGatewayApp', () => {
  it('throws on non-loopback bind without TLS config', () => {
    assert.throws(
      () =>
        createGw({
          tlsConfig: { bindAddress: '192.168.1.100' },
        }),
      { message: /requires TLS/i },
    );
  });

  it('allows loopback bind without TLS config', () => {
    assert.doesNotThrow(() => createGw({ tlsConfig: { bindAddress: '127.0.0.1' } }));
  });

  it('allows non-loopback with TLS certs', () => {
    assert.doesNotThrow(() =>
      createGw({
        tlsConfig: {
          bindAddress: '0.0.0.0',
          certPath: '/path/to/cert.pem',
          keyPath: '/path/to/key.pem',
        },
      }),
    );
  });

  it('works without tlsConfig (backward compatibility)', () => {
    assert.doesNotThrow(() => createGw());
  });

  it('secureCookies defaults to false without TLS config', async () => {
    const gateway = createGw();
    await gateway.operatorStore.createOperator('admin', 'Admin');
    await gateway.operatorStore.addCredential('admin', 'pass');

    const res = await gateway.app.request(
      new Request(`${ORIGIN}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ identity: 'admin', secret: 'pass' }),
      }),
    );
    assert.equal(res.status, 200);

    const setCookies = res.headers.getSetCookie();
    const sessionCookie = setCookies.find((c) => c.startsWith('__session='));
    assert.ok(sessionCookie, 'should set __session cookie');
    assert.ok(!sessionCookie.includes('Secure'), 'should NOT have Secure flag without TLS');
  });

  it('secureCookies defaults to true with TLS config', async () => {
    const gateway = createGw({
      tlsConfig: {
        bindAddress: '0.0.0.0',
        certPath: '/path/to/cert.pem',
        keyPath: '/path/to/key.pem',
      },
    });
    await gateway.operatorStore.createOperator('admin', 'Admin');
    await gateway.operatorStore.addCredential('admin', 'pass');

    const res = await gateway.app.request(
      new Request(`${ORIGIN}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ identity: 'admin', secret: 'pass' }),
      }),
    );
    assert.equal(res.status, 200);

    const setCookies = res.headers.getSetCookie();
    const sessionCookie = setCookies.find((c) => c.startsWith('__session='));
    assert.ok(sessionCookie, 'should set __session cookie');
    assert.ok(sessionCookie.includes('Secure'), 'should have Secure flag with TLS');
  });

  it('explicit secureCookies overrides TLS derivation', async () => {
    const gateway = createGw({
      tlsConfig: {
        bindAddress: '0.0.0.0',
        certPath: '/path/to/cert.pem',
        keyPath: '/path/to/key.pem',
      },
      authRoutesConfig: { secureCookies: false },
    });
    await gateway.operatorStore.createOperator('admin', 'Admin');
    await gateway.operatorStore.addCredential('admin', 'pass');

    const res = await gateway.app.request(
      new Request(`${ORIGIN}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ identity: 'admin', secret: 'pass' }),
      }),
    );
    assert.equal(res.status, 200);

    const setCookies = res.headers.getSetCookie();
    const sessionCookie = setCookies.find((c) => c.startsWith('__session='));
    assert.ok(sessionCookie);
    assert.ok(!sessionCookie.includes('Secure'), 'explicit override should win');
  });

  it('HSTS header set when TLS is active', async () => {
    const gateway = createGw({
      tlsConfig: {
        bindAddress: '0.0.0.0',
        certPath: '/path/to/cert.pem',
        keyPath: '/path/to/key.pem',
      },
    });

    const res = await gateway.app.request(new Request(`${ORIGIN}/session/info`, { method: 'GET' }));
    // Even a 401 should have security headers
    const hsts = res.headers.get('strict-transport-security');
    assert.ok(hsts, 'should include HSTS header when TLS is active');
    assert.ok(hsts.includes('max-age='), 'HSTS should have max-age directive');
  });

  it('no HSTS header without TLS', async () => {
    const gateway = createGw();

    const res = await gateway.app.request(new Request(`${ORIGIN}/session/info`, { method: 'GET' }));
    const hsts = res.headers.get('strict-transport-security');
    assert.equal(hsts, null, 'should NOT include HSTS without TLS');
  });

  it('secureCookies on loopback without TLS defaults to false', async () => {
    const gateway = createGw({
      tlsConfig: { bindAddress: '127.0.0.1' },
    });
    await gateway.operatorStore.createOperator('admin', 'Admin');
    await gateway.operatorStore.addCredential('admin', 'pass');

    const res = await gateway.app.request(
      new Request(`${ORIGIN}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ identity: 'admin', secret: 'pass' }),
      }),
    );
    assert.equal(res.status, 200);

    const setCookies = res.headers.getSetCookie();
    const sessionCookie = setCookies.find((c) => c.startsWith('__session='));
    assert.ok(sessionCookie);
    assert.ok(!sessionCookie.includes('Secure'), 'loopback without TLS should not set Secure');
  });
});
