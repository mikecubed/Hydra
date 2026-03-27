/**
 * T5 — Auth API client unit tests.
 *
 * Uses Node.js native test runner. Mocks globalThis.fetch and
 * globalThis.document.cookie directly.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { login, getSessionInfo, logout } from '../api/auth-client.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

type FetchMock = (input: string | URL, init?: RequestInit) => Promise<Response>;

function stubFetch(status: number, body: unknown): FetchMock {
  return async (_input, _init) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
}

// Track calls for assertion
let lastFetchInput: string | URL | undefined;
let lastFetchInit: RequestInit | undefined;

function stubFetchTracked(status: number, body: unknown): FetchMock {
  return async (input, init) => {
    lastFetchInput = input;
    lastFetchInit = init;
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

// ─── Setup / teardown ───────────────────────────────────────────────────────

let originalFetch: typeof globalThis.fetch;
let originalDocument: unknown;

before(() => {
  originalFetch = globalThis.fetch;
  // Set up a minimal document.cookie for logout tests
  originalDocument = (globalThis as Record<string, unknown>)['document'];
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalDocument === undefined) {
    delete (globalThis as Record<string, unknown>)['document'];
  } else {
    (globalThis as Record<string, unknown>)['document'] = originalDocument;
  }
});

beforeEach(() => {
  lastFetchInput = undefined;
  lastFetchInit = undefined;
});

// ─── Tests ──────────────────────────────────────────────────────────────────

const validLoginResponse = {
  operatorId: 'op-1',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  state: 'active',
};

const validSessionInfo = {
  operatorId: 'op-1',
  state: 'active',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  lastActivityAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
};

describe('login()', () => {
  it('sends POST /auth/login with correct JSON body and credentials:include', async () => {
    globalThis.fetch = stubFetchTracked(200, validLoginResponse) as typeof globalThis.fetch;

    await login('admin', 'secret');

    assert.equal(lastFetchInput, '/auth/login');
    assert.equal(lastFetchInit?.method, 'POST');
    assert.equal(lastFetchInit?.credentials, 'include');
    assert.equal(lastFetchInit?.body, JSON.stringify({ identity: 'admin', secret: 'secret' }));
  });

  it('returns parsed LoginResponse on 200', async () => {
    globalThis.fetch = stubFetch(200, validLoginResponse) as typeof globalThis.fetch;

    const result = await login('admin', 'secret');

    assert.equal(result.operatorId, 'op-1');
    assert.equal(result.state, 'active');
  });

  it('throws with code INVALID_CREDENTIALS on 401', async () => {
    globalThis.fetch = stubFetch(401, {
      code: 'INVALID_CREDENTIALS',
      message: 'Bad credentials',
    }) as typeof globalThis.fetch;

    await assert.rejects(
      () => login('admin', 'wrong'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as Error & { code: string }).code, 'INVALID_CREDENTIALS');
        return true;
      },
    );
  });

  it('throws with code RATE_LIMITED on 429', async () => {
    globalThis.fetch = stubFetch(429, {
      code: 'RATE_LIMITED',
      message: 'Too many attempts',
    }) as typeof globalThis.fetch;

    await assert.rejects(
      () => login('admin', 'pass'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as Error & { code: string }).code, 'RATE_LIMITED');
        return true;
      },
    );
  });
});

describe('getSessionInfo()', () => {
  it('returns parsed SessionInfo on 200', async () => {
    globalThis.fetch = stubFetch(200, validSessionInfo) as typeof globalThis.fetch;

    const result = await getSessionInfo();

    assert.ok(result !== null);
    assert.equal(result.operatorId, 'op-1');
    assert.equal(result.state, 'active');
  });

  it('returns null on 401', async () => {
    globalThis.fetch = stubFetch(401, {}) as typeof globalThis.fetch;

    const result = await getSessionInfo();

    assert.equal(result, null);
  });

  it('throws a descriptive error for non-2xx non-401 status', async () => {
    globalThis.fetch = stubFetch(500, { error: 'server error' }) as typeof globalThis.fetch;
    await assert.rejects(
      () => getSessionInfo(),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('500'));
        return true;
      },
    );
  });
});

describe('logout()', () => {
  it('sends POST /auth/logout with credentials:include and x-csrf-token header', async () => {
    Object.defineProperty(globalThis, 'document', {
      value: { cookie: '__csrf=test-token; other=value' },
      configurable: true,
    });

    globalThis.fetch = stubFetchTracked(200, { success: true }) as typeof globalThis.fetch;

    await logout();

    assert.equal(lastFetchInput, '/auth/logout');
    assert.equal(lastFetchInit?.method, 'POST');
    assert.equal(lastFetchInit?.credentials, 'include');
    assert.equal(
      (lastFetchInit?.headers as Record<string, string>)?.['x-csrf-token'],
      'test-token',
    );
  });

  it('resolves without throwing when server returns 500', async () => {
    globalThis.fetch = stubFetch(500, {}) as typeof globalThis.fetch;

    await assert.doesNotReject(() => logout());
  });

  it('sends full x-csrf-token for tokens containing = characters', async () => {
    Object.defineProperty(globalThis, 'document', {
      value: { cookie: '__csrf=tokenpart1=tokenpart2; other=value' },
      configurable: true,
    });
    globalThis.fetch = stubFetchTracked(200, { success: true }) as typeof globalThis.fetch;
    await logout();
    assert.equal(
      (lastFetchInit?.headers as Record<string, string>)?.['x-csrf-token'],
      'tokenpart1=tokenpart2',
    );
  });
});
