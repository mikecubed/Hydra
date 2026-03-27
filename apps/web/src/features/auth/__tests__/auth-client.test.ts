// @vitest-environment jsdom
/**
 * T5 — Auth API client unit tests.
 *
 * Covers login(), getSessionInfo(), logout() from the auth-client module.
 * Uses Vitest with jsdom environment for document.cookie access.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { login, getSessionInfo, logout } from '../api/auth-client.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

const mockFetch = (status: number, body: unknown) =>
  vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });

// ─── Fixtures ───────────────────────────────────────────────────────────────

const validLoginResponse = {
  operatorId: 'op-1',
  expiresAt: '2026-01-01T00:00:00.000Z',
  state: 'active',
};

const validSessionInfo = {
  operatorId: 'op-1',
  state: 'active',
  expiresAt: '2026-01-01T00:00:00.000Z',
  lastActivityAt: '2025-12-31T23:00:00.000Z',
  createdAt: '2025-12-31T22:00:00.000Z',
};

// ─── Teardown ───────────────────────────────────────────────────────────────

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── login() ────────────────────────────────────────────────────────────────

describe('login()', () => {
  it('sends POST /auth/login with correct JSON body and credentials: include', async () => {
    const fetchMock = mockFetch(200, validLoginResponse);
    vi.stubGlobal('fetch', fetchMock);

    await login('admin', 's3cret');

    expect(fetchMock).toHaveBeenCalledWith('/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: 'admin', secret: 's3cret' }),
    });
  });

  it('returns parsed LoginResponse on 200', async () => {
    vi.stubGlobal('fetch', mockFetch(200, validLoginResponse));

    const result = await login('admin', 's3cret');

    expect(result).toEqual(validLoginResponse);
  });

  it('throws with code INVALID_CREDENTIALS on 401', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(401, { code: 'INVALID_CREDENTIALS', message: 'Bad credentials' }),
    );

    await expect(login('admin', 'wrong')).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
      message: 'Bad credentials',
    });
  });

  it('throws with code RATE_LIMITED on 429', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(429, { code: 'RATE_LIMITED', message: 'Too many requests' }),
    );

    await expect(login('admin', 'pass')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      message: 'Too many requests',
    });
  });
});

// ─── getSessionInfo() ───────────────────────────────────────────────────────

describe('getSessionInfo()', () => {
  it('returns SessionInfo on 200', async () => {
    vi.stubGlobal('fetch', mockFetch(200, validSessionInfo));

    const result = await getSessionInfo();

    expect(result).toEqual(validSessionInfo);
  });

  it('returns null on 401', async () => {
    vi.stubGlobal('fetch', mockFetch(401, {}));

    const result = await getSessionInfo();

    expect(result).toBeNull();
  });
});

// ─── logout() ───────────────────────────────────────────────────────────────

describe('logout()', () => {
  it('sends POST /auth/logout with credentials: include and x-csrf-token header', async () => {
    const fetchMock = mockFetch(200, { success: true });
    vi.stubGlobal('fetch', fetchMock);
    document.cookie = '__csrf=test-token';

    await logout();

    expect(fetchMock).toHaveBeenCalledWith('/auth/logout', {
      method: 'POST',
      credentials: 'include',
      headers: { 'x-csrf-token': 'test-token' },
    });
  });

  it('resolves without throwing even when server returns 500', async () => {
    vi.stubGlobal('fetch', mockFetch(500, { error: 'Internal Server Error' }));

    await expect(logout()).resolves.toBeUndefined();
  });
});
