/**
 * T1 — reauth() unit tests.
 *
 * Uses Node.js native test runner. Mocks globalThis.fetch and
 * globalThis.document.cookie directly.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { reauth } from '../api/auth-client.ts';

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

const validExtendResponse = {
  newExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

describe('reauth()', () => {
  it('returns parsed ExtendResponse on 200', async () => {
    globalThis.fetch = stubFetch(200, validExtendResponse) as typeof globalThis.fetch;

    const result = await reauth();

    assert.equal(result.newExpiresAt, validExtendResponse.newExpiresAt);
  });

  it('includes x-csrf-token header from document.cookie', async () => {
    Object.defineProperty(globalThis, 'document', {
      value: { cookie: '__csrf=reauth-csrf-tok; other=value' },
      configurable: true,
    });

    globalThis.fetch = stubFetchTracked(200, validExtendResponse) as typeof globalThis.fetch;

    await reauth();

    assert.equal(lastFetchInput, '/auth/reauth');
    assert.equal(lastFetchInit?.method, 'POST');
    assert.equal(lastFetchInit?.credentials, 'include');
    assert.equal(
      (lastFetchInit?.headers as Record<string, string>)?.['x-csrf-token'],
      'reauth-csrf-tok',
    );
  });

  it('omits x-csrf-token header when CSRF cookie is absent (no throw)', async () => {
    Object.defineProperty(globalThis, 'document', {
      value: { cookie: 'session=abc' },
      configurable: true,
    });

    globalThis.fetch = stubFetchTracked(200, validExtendResponse) as typeof globalThis.fetch;

    await reauth();

    assert.equal(
      (lastFetchInit?.headers as Record<string, string>)?.['x-csrf-token'],
      undefined,
    );
  });

  it('throws with correct .code on non-2xx response', async () => {
    globalThis.fetch = stubFetch(401, {
      code: 'SESSION_EXPIRED',
      message: 'Session has expired',
    }) as typeof globalThis.fetch;

    await assert.rejects(
      () => reauth(),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, 'Session has expired');
        assert.equal((err as Error & { code: string }).code, 'SESSION_EXPIRED');
        return true;
      },
    );
  });
});
