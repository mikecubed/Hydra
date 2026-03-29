/**
 * T2 — useSession hook unit tests.
 *
 * Tests the core session manager logic directly (no React renderer needed).
 * Uses the same globalThis stub pattern as auth-client.test.ts.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import type { SessionInfo as SessionInfoType } from '@hydra/web-contracts';
import { createSessionManager, type SessionManagerDeps } from '../hooks/use-session.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

const NOW = '2025-01-15T12:00:00.000Z';
const FUTURE = '2025-01-15T13:00:00.000Z';
const EXTENDED = '2025-01-15T14:00:00.000Z';

function makeSession(overrides: Partial<SessionInfoType> = {}): SessionInfoType {
  return {
    operatorId: 'op-1',
    state: 'active',
    expiresAt: FUTURE,
    lastActivityAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

/** Minimal fake WebSocket that records calls and allows manual event dispatch. */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  CONNECTING = 0;
  OPEN = 1;
  CLOSING = 2;
  CLOSED = 3;

  url: string;
  readyState = FakeWebSocket.OPEN;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code?: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  closeCalled = false;

  constructor(url: string) {
    this.url = url;
    // Auto-fire onopen in next microtask
    queueMicrotask(() => {
      if (this.onopen) this.onopen({});
    });
  }

  close() {
    this.closeCalled = true;
    this.readyState = FakeWebSocket.CLOSED;
  }

  /** Test helper: simulate a server message. */
  simulateMessage(data: unknown) {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(data) });
    }
  }
}

// ─── Fake timers ────────────────────────────────────────────────────────────

interface PendingTimer {
  id: number;
  cb: () => void;
  delay: number;
}

let timerIdCounter = 0;
let pendingTimers: PendingTimer[] = [];
let originalSetTimeout: typeof globalThis.setTimeout;
let originalClearTimeout: typeof globalThis.clearTimeout;
let originalDocument: unknown;
let visibilityState = 'visible';
let visibilityListeners: Array<() => void> = [];

function installFakeTimers() {
  timerIdCounter = 0;
  pendingTimers = [];
  originalSetTimeout = globalThis.setTimeout;
  originalClearTimeout = globalThis.clearTimeout;

  (globalThis as Record<string, unknown>)['setTimeout'] = ((
    cb: () => void,
    delay?: number,
  ): number => {
    const id = ++timerIdCounter;
    pendingTimers.push({ id, cb, delay: delay ?? 0 });
    return id;
  }) as unknown as typeof globalThis.setTimeout;

  (globalThis as Record<string, unknown>)['clearTimeout'] = ((id?: number): void => {
    pendingTimers = pendingTimers.filter((t) => t.id !== id);
  }) as unknown as typeof globalThis.clearTimeout;
}

function restoreFakeTimers() {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}

/** Flush all pending timers synchronously (run their callbacks). */
function flushTimers() {
  const toRun = [...pendingTimers];
  pendingTimers = [];
  for (const t of toRun) t.cb();
}

/** Return the last scheduled timer delay. */
function lastTimerDelay(): number | undefined {
  return pendingTimers.at(-1)?.delay;
}

function installFakeDocument() {
  visibilityState = 'visible';
  visibilityListeners = [];
  originalDocument = (globalThis as Record<string, unknown>)['document'];
  Object.defineProperty(globalThis, 'document', {
    value: {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener(event: string, cb: () => void) {
        if (event === 'visibilitychange') visibilityListeners.push(cb);
      },
      removeEventListener(event: string, cb: () => void) {
        if (event === 'visibilitychange') {
          visibilityListeners = visibilityListeners.filter((l) => l !== cb);
        }
      },
      cookie: '',
    },
    configurable: true,
  });
}

function restoreFakeDocument() {
  if (originalDocument === undefined) {
    delete (globalThis as Record<string, unknown>)['document'];
  } else {
    (globalThis as Record<string, unknown>)['document'] = originalDocument;
  }
}

function setVisibility(state: string) {
  visibilityState = state;
  for (const cb of visibilityListeners) cb();
}

/** Wait one microtask tick. */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => {
    queueMicrotask(() => {
      resolve();
    });
  });
}

// ─── Default deps factory ───────────────────────────────────────────────────

/** Captured FakeWebSocket instances from tests that need WS inspection. */
let lastCreatedWs: FakeWebSocket | null = null;

function makeWsCtor(): SessionManagerDeps['WebSocketCtor'] {
  const Ctor =
    class TrackedWs extends FakeWebSocket {} as unknown as SessionManagerDeps['WebSocketCtor'];
  return new Proxy(Ctor, {
    construct(Target, args: [string]) {
      const instance = Reflect.construct(Target, args) as unknown as FakeWebSocket;
      lastCreatedWs = instance;
      return instance;
    },
  });
}

function makeDeps(overrides: Partial<SessionManagerDeps> = {}): SessionManagerDeps {
  return {
    getSessionInfo: async () => makeSession(),
    reauth: async () => ({ newExpiresAt: EXTENDED }),
    logout: async () => {},
    pollIntervalMs: 1000,
    WebSocketCtor: FakeWebSocket as unknown as SessionManagerDeps['WebSocketCtor'],
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('useSession', () => {
  beforeEach(() => {
    lastCreatedWs = null;
    installFakeTimers();
    installFakeDocument();
  });

  afterEach(() => {
    restoreFakeTimers();
    restoreFakeDocument();
  });

  it('isLoading is true until initial getSessionInfo settles', async () => {
    let resolveInfo!: (v: SessionInfoType | null) => void;
    const pending = new Promise<SessionInfoType | null>((resolve) => {
      resolveInfo = resolve;
    });
    const deps = makeDeps({ getSessionInfo: () => pending });
    const mgr = createSessionManager(deps);

    assert.equal(mgr.getState().isLoading, true);
    assert.equal(mgr.getState().session, null);

    resolveInfo(makeSession());
    await pending;
    await tick();

    assert.equal(mgr.getState().isLoading, false);

    mgr.destroy();
  });

  it('session is populated after initial fetch', async () => {
    const session = makeSession({ operatorId: 'op-42' });
    const deps = makeDeps({ getSessionInfo: async () => session });
    const mgr = createSessionManager(deps);

    await tick();
    await tick();

    const state = mgr.getState();
    assert.equal(state.isLoading, false);
    assert.equal(state.session?.operatorId, 'op-42');
    assert.equal(state.session?.state, 'active');

    mgr.destroy();
  });

  it('polling fires at configured interval with jitter', async () => {
    let callCount = 0;
    const deps = makeDeps({
      getSessionInfo: async () => {
        callCount++;
        return makeSession();
      },
      pollIntervalMs: 10_000,
    });

    const mgr = createSessionManager(deps);
    await tick();
    await tick();

    assert.equal(callCount, 1);
    assert.ok(pendingTimers.length > 0, 'polling timer should be scheduled');

    const delay = lastTimerDelay();
    assert.ok(delay !== undefined);
    assert.ok(delay >= 9500, `delay ${String(delay)} should be >= 9500`);
    assert.ok(delay <= 10500, `delay ${String(delay)} should be <= 10500`);

    flushTimers();
    await tick();
    await tick();

    assert.equal(callCount, 2);

    mgr.destroy();
  });

  it('polling pauses when visibilityState becomes hidden', async () => {
    let callCount = 0;
    const deps = makeDeps({
      getSessionInfo: async () => {
        callCount++;
        return makeSession();
      },
    });

    const mgr = createSessionManager(deps);
    await tick();
    await tick();

    assert.equal(callCount, 1);

    setVisibility('hidden');

    assert.equal(pendingTimers.length, 0, 'timers should be cleared when hidden');

    mgr.destroy();
  });

  it('polling resumes when visibilityState returns to visible', async () => {
    let callCount = 0;
    const deps = makeDeps({
      getSessionInfo: async () => {
        callCount++;
        return makeSession();
      },
    });

    const mgr = createSessionManager(deps);
    await tick();
    await tick();
    assert.equal(callCount, 1);

    setVisibility('hidden');
    assert.equal(pendingTimers.length, 0);

    setVisibility('visible');
    await tick();
    await tick();

    assert.equal(callCount, 2, 'should have re-polled on visibility return');
    assert.ok(pendingTimers.length > 0, 'should have re-scheduled polling');

    mgr.destroy();
  });

  it('polling stops when session enters terminal state', async () => {
    let callCount = 0;
    const deps = makeDeps({
      getSessionInfo: async () => {
        callCount++;
        return callCount === 1
          ? makeSession({ state: 'active' })
          : makeSession({ state: 'expired' });
      },
    });

    const mgr = createSessionManager(deps);
    await tick();
    await tick();

    assert.equal(callCount, 1);

    flushTimers();
    await tick();
    await tick();

    assert.equal(callCount, 2);
    assert.equal(mgr.getState().session?.state, 'expired');
    assert.equal(pendingTimers.length, 0, 'no timers after terminal state');

    mgr.destroy();
  });

  it('WebSocket state-change frame updates session.state immediately', async () => {
    const deps = makeDeps({ WebSocketCtor: makeWsCtor() });

    const mgr = createSessionManager(deps);
    await tick();
    await tick();

    assert.ok(lastCreatedWs !== null, 'WebSocket should have been created');

    lastCreatedWs.simulateMessage({
      type: 'state-change',
      newState: 'expiring-soon',
    });

    assert.equal(mgr.getState().session?.state, 'expiring-soon');

    mgr.destroy();
  });

  it('forced-logout frame stops polling', async () => {
    const deps = makeDeps({ WebSocketCtor: makeWsCtor() });

    const mgr = createSessionManager(deps);
    await tick();
    await tick();

    assert.ok(lastCreatedWs !== null);
    assert.ok(pendingTimers.length > 0, 'should have polling timer before forced-logout');

    lastCreatedWs.simulateMessage({
      type: 'forced-logout',
      newState: 'logged-out',
    });

    assert.equal(mgr.getState().session?.state, 'logged-out');
    assert.equal(pendingTimers.length, 0, 'polling should stop after forced-logout');

    mgr.destroy();
  });

  it('extend() calls reauth() and updates expiresAt and resets state to active', async () => {
    let reauthCalled = false;
    const deps = makeDeps({
      getSessionInfo: async () => makeSession({ state: 'expiring-soon' }),
      reauth: async () => {
        reauthCalled = true;
        return { newExpiresAt: EXTENDED };
      },
    });

    const mgr = createSessionManager(deps);
    await tick();
    await tick();

    assert.equal(mgr.getState().session?.state, 'expiring-soon');

    await mgr.extend();

    assert.equal(reauthCalled, true);
    assert.equal(mgr.getState().session?.expiresAt, EXTENDED);
    assert.equal(mgr.getState().session?.state, 'active');

    mgr.destroy();
  });

  it('logout() calls auth-client logout and sets session to null', async () => {
    let logoutCalled = false;
    const deps = makeDeps({
      logout: async () => {
        logoutCalled = true;
      },
    });

    const mgr = createSessionManager(deps);
    await tick();
    await tick();

    assert.ok(mgr.getState().session !== null);

    await mgr.logout();

    assert.equal(logoutCalled, true);
    assert.equal(mgr.getState().session, null);

    mgr.destroy();
  });

  it('cleanup cancels polling timer and closes WebSocket', async () => {
    const deps = makeDeps({ WebSocketCtor: makeWsCtor() });

    const mgr = createSessionManager(deps);
    await tick();
    await tick();

    assert.ok(lastCreatedWs !== null, 'WebSocket should exist');
    assert.ok(pendingTimers.length > 0, 'polling timer should exist');

    mgr.destroy();

    assert.equal(lastCreatedWs.closeCalled, true, 'WebSocket should be closed');
    assert.equal(pendingTimers.length, 0, 'polling timers should be cleared');
  });

  // ── Poll error tracking (T012 / FD-1) ──────────────────────────────────

  it('pollErrorCount starts at 0 after successful initial fetch', async () => {
    const deps = makeDeps();
    const mgr = createSessionManager(deps);
    await tick();
    await tick();

    assert.equal(mgr.getState().pollErrorCount, 0);
    mgr.destroy();
  });

  it('pollErrorCount increments on consecutive poll failures', async () => {
    let callCount = 0;
    const deps = makeDeps({
      getSessionInfo: async () => {
        callCount++;
        if (callCount === 1) return makeSession();
        throw new Error('network error');
      },
    });

    const mgr = createSessionManager(deps);
    await tick();
    await tick();
    assert.equal(mgr.getState().pollErrorCount, 0, 'initial fetch succeeds');

    // First poll failure
    flushTimers();
    await tick();
    await tick();
    assert.equal(mgr.getState().pollErrorCount, 1, 'first poll error');

    // Second poll failure
    flushTimers();
    await tick();
    await tick();
    assert.equal(mgr.getState().pollErrorCount, 2, 'second poll error');

    mgr.destroy();
  });

  it('pollErrorCount resets to 0 on successful poll after errors', async () => {
    let callCount = 0;
    const deps = makeDeps({
      getSessionInfo: async () => {
        callCount++;
        if (callCount === 1) return makeSession();
        if (callCount === 2) throw new Error('network error');
        return makeSession(); // third call succeeds
      },
    });

    const mgr = createSessionManager(deps);
    await tick();
    await tick();
    assert.equal(mgr.getState().pollErrorCount, 0);

    flushTimers();
    await tick();
    await tick();
    assert.equal(mgr.getState().pollErrorCount, 1, 'error incremented');

    flushTimers();
    await tick();
    await tick();
    assert.equal(mgr.getState().pollErrorCount, 0, 'reset after success');

    mgr.destroy();
  });

  it('pollErrorCount is 1 when initial fetch fails', async () => {
    const deps = makeDeps({
      getSessionInfo: async () => {
        throw new Error('initial fetch failed');
      },
    });

    const mgr = createSessionManager(deps);
    await tick();
    await tick();

    assert.equal(mgr.getState().pollErrorCount, 1);
    assert.equal(mgr.getState().session, null);
    assert.equal(mgr.getState().isLoading, false);

    mgr.destroy();
  });
});
