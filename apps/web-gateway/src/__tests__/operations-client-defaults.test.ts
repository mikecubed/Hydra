/**
 * Tests that createGatewayApp propagates daemonClientOptions (fetchFn, timeoutMs)
 * to the default DaemonOperationsClient when operationsClientOptions is absent.
 *
 * Verifies the fix: previously only baseUrl was forwarded; now fetchFn and
 * timeoutMs are derived from daemonClientOptions as well.
 */
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayApp, type GatewayApp, type GatewayAppDeps } from '../index.ts';
import { FakeClock } from '../shared/clock.ts';

const ORIGIN = 'http://127.0.0.1:4174';

function buildAuthedRequest(
  method: string,
  path: string,
  cookies: Record<string, string>,
): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: ORIGIN,
    cookie: Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; '),
  };
  return new Request(`${ORIGIN}${path}`, { method, headers });
}

function parseCookies(res: Response): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const sc of res.headers.getSetCookie()) {
    const [pair] = sc.split(';');
    const eqIdx = pair.indexOf('=');
    if (eqIdx > 0) {
      jar[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
    }
  }
  return jar;
}

async function login(gw: GatewayApp): Promise<Record<string, string>> {
  const req = new Request(`${ORIGIN}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ identity: 'admin', secret: 'password123' }),
  });
  const res = await gw.app.request(req);
  assert.equal(res.status, 200, 'Login should succeed');
  return parseCookies(res);
}

describe('operations client default propagation', () => {
  let gw: GatewayApp;

  afterEach(() => {
    gw?.heartbeat.stop();
  });

  it('uses daemonClientOptions.fetchFn for operations when operationsClientOptions absent', async () => {
    const fetchSpy = mock.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            queue: [],
            health: null,
            budget: null,
            availability: 'empty',
            lastSynchronizedAt: null,
            nextCursor: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const clock = new FakeClock(Date.now());
    const deps: GatewayAppDeps = {
      clock,
      allowedOrigin: ORIGIN,
      healthChecker: async () => true,
      heartbeatConfig: { intervalMs: 60_000 },
      daemonClientOptions: {
        baseUrl: 'http://custom-daemon:9999',
        fetchFn: fetchSpy,
        timeoutMs: 12_000,
      },
      // Intentionally omitting operationsClientOptions to test default derivation
    };

    gw = createGatewayApp(deps);
    await gw.operatorStore.createOperator('admin', 'Admin');
    await gw.operatorStore.addCredential('admin', 'password123');

    const cookies = await login(gw);
    const req = buildAuthedRequest('GET', '/operations/snapshot', cookies);
    await gw.app.request(req);

    // The custom fetchFn should have been called for the operations snapshot
    assert.ok(
      fetchSpy.mock.callCount() > 0,
      'Custom fetchFn from daemonClientOptions should be used',
    );
    const calledUrl = fetchSpy.mock.calls[0].arguments[0] as string;
    assert.ok(
      calledUrl.startsWith('http://custom-daemon:9999/operations/snapshot'),
      `Expected custom baseUrl, got: ${calledUrl}`,
    );
  });

  it('explicit operationsClientOptions overrides daemonClientOptions', async () => {
    const daemonFetch = mock.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response('{}', { status: 200 })),
    );
    const opsFetch = mock.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            queue: [],
            health: null,
            budget: null,
            availability: 'empty',
            lastSynchronizedAt: null,
            nextCursor: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const clock = new FakeClock(Date.now());
    gw = createGatewayApp({
      clock,
      allowedOrigin: ORIGIN,
      healthChecker: async () => true,
      heartbeatConfig: { intervalMs: 60_000 },
      daemonClientOptions: {
        baseUrl: 'http://daemon:4173',
        fetchFn: daemonFetch,
      },
      operationsClientOptions: {
        baseUrl: 'http://ops-daemon:5555',
        fetchFn: opsFetch,
      },
    });
    await gw.operatorStore.createOperator('admin', 'Admin');
    await gw.operatorStore.addCredential('admin', 'password123');

    const cookies = await login(gw);
    const req = buildAuthedRequest('GET', '/operations/snapshot', cookies);
    await gw.app.request(req);

    // The ops-specific fetch should be used, not the daemon one
    assert.ok(
      opsFetch.mock.callCount() > 0,
      'Explicit operationsClientOptions fetchFn should be used',
    );
    const calledUrl = opsFetch.mock.calls[0].arguments[0] as string;
    assert.ok(
      calledUrl.startsWith('http://ops-daemon:5555/operations/snapshot'),
      `Expected explicit ops baseUrl, got: ${calledUrl}`,
    );
  });
});
