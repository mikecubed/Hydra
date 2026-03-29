/**
 * Tests for browser-side session/connection status vocabulary.
 *
 * Validates the WorkspaceConnectionState model, factory, predicates,
 * and transition helpers for operator-visible transport/session/sync state.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  type WorkspaceConnectionState,
  TRANSPORT_STATUSES,
  SYNC_STATUSES,
  BROWSER_SESSION_STATUSES,
  DAEMON_STATUSES,
  initialConnectionState,
  isOperational,
  canSubmitWork,
  isSessionTerminal,
  needsReconnect,
  isRecovering,
  hasExhaustedRetries,
  describeConnectionState,
  estimateReconnectWait,
} from '../session-state.ts';

// ─── Constant arrays ────────────────────────────────────────────────────────

describe('status constants', () => {
  it('TRANSPORT_STATUSES contains all transport states', () => {
    assert.deepStrictEqual(TRANSPORT_STATUSES, [
      'connecting',
      'live',
      'reconnecting',
      'disconnected',
    ]);
  });

  it('SYNC_STATUSES contains all sync states', () => {
    assert.deepStrictEqual(SYNC_STATUSES, ['idle', 'syncing', 'recovered', 'error']);
  });

  it('BROWSER_SESSION_STATUSES contains all browser session states', () => {
    assert.deepStrictEqual(BROWSER_SESSION_STATUSES, [
      'active',
      'expiring-soon',
      'expired',
      'invalidated',
    ]);
  });

  it('DAEMON_STATUSES contains all daemon states', () => {
    assert.deepStrictEqual(DAEMON_STATUSES, ['healthy', 'unavailable', 'recovering']);
  });

  it('all constant arrays are frozen', () => {
    assert.ok(Object.isFrozen(TRANSPORT_STATUSES));
    assert.ok(Object.isFrozen(SYNC_STATUSES));
    assert.ok(Object.isFrozen(BROWSER_SESSION_STATUSES));
    assert.ok(Object.isFrozen(DAEMON_STATUSES));
  });
});

// ─── initialConnectionState ─────────────────────────────────────────────────

describe('initialConnectionState', () => {
  it('returns the correct initial state', () => {
    const state = initialConnectionState();
    assert.equal(state.transportStatus, 'connecting');
    assert.equal(state.syncStatus, 'idle');
    assert.equal(state.sessionStatus, 'active');
    assert.equal(state.daemonStatus, 'healthy');
    assert.equal(state.lastAuthoritativeUpdate, null);
  });

  it('returns a new object on each call', () => {
    const a = initialConnectionState();
    const b = initialConnectionState();
    assert.notEqual(a, b);
    assert.deepStrictEqual(a, b);
  });
});

// ─── isOperational ──────────────────────────────────────────────────────────

describe('isOperational', () => {
  it('returns true when transport is live, sync is idle, and session is active', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'live',
    };
    assert.ok(isOperational(state));
  });

  it('returns true when sync is recovered', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'live',
      syncStatus: 'recovered',
    };
    assert.ok(isOperational(state));
  });

  it('returns true when session is expiring-soon (still operational)', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'live',
      sessionStatus: 'expiring-soon',
    };
    assert.ok(isOperational(state));
  });

  it('returns false when transport is not live', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'reconnecting',
    };
    assert.ok(!isOperational(state));
  });

  it('returns false when sync is in error', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'live',
      syncStatus: 'error',
    };
    assert.ok(!isOperational(state));
  });

  it('returns false when session is expired', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'live',
      sessionStatus: 'expired',
    };
    assert.ok(!isOperational(state));
  });

  it('returns false when session is invalidated', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'live',
      sessionStatus: 'invalidated',
    };
    assert.ok(!isOperational(state));
  });
});

// ─── canSubmitWork ──────────────────────────────────────────────────────────

describe('canSubmitWork', () => {
  it('returns true when operational and daemon is healthy', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'live',
    };
    assert.ok(canSubmitWork(state));
  });

  it('returns false when daemon is unavailable', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'live',
      daemonStatus: 'unavailable',
    };
    assert.ok(!canSubmitWork(state));
  });

  it('returns false when daemon is recovering', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'live',
      daemonStatus: 'recovering',
    };
    assert.ok(!canSubmitWork(state));
  });

  it('returns false when not operational even if daemon is healthy', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'disconnected',
    };
    assert.ok(!canSubmitWork(state));
  });
});

// ─── isSessionTerminal ──────────────────────────────────────────────────────

describe('isSessionTerminal', () => {
  it('returns true for expired session', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      sessionStatus: 'expired',
    };
    assert.ok(isSessionTerminal(state));
  });

  it('returns true for invalidated session', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      sessionStatus: 'invalidated',
    };
    assert.ok(isSessionTerminal(state));
  });

  it('returns false for active session', () => {
    assert.ok(!isSessionTerminal(initialConnectionState()));
  });

  it('returns false for expiring-soon session', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      sessionStatus: 'expiring-soon',
    };
    assert.ok(!isSessionTerminal(state));
  });
});

// ─── needsReconnect ─────────────────────────────────────────────────────────

describe('needsReconnect', () => {
  it('returns true when disconnected', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'disconnected',
    };
    assert.ok(needsReconnect(state));
  });

  it('returns true when reconnecting', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'reconnecting',
    };
    assert.ok(needsReconnect(state));
  });

  it('returns false when live', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'live',
    };
    assert.ok(!needsReconnect(state));
  });

  it('returns false when connecting', () => {
    assert.ok(!needsReconnect(initialConnectionState()));
  });
});

// ─── describeConnectionState ────────────────────────────────────────────────

describe('describeConnectionState', () => {
  it('describes a fully operational state', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'live',
    };
    const desc = describeConnectionState(state);
    assert.equal(typeof desc, 'string');
    assert.ok(desc.length > 0);
  });

  it('mentions reconnecting when transport is reconnecting', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'reconnecting',
    };
    const desc = describeConnectionState(state);
    assert.ok(desc.toLowerCase().includes('reconnect'), `expected "reconnect" in: "${desc}"`);
  });

  it('mentions session when session is expired', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'live',
      sessionStatus: 'expired',
    };
    const desc = describeConnectionState(state);
    assert.ok(desc.toLowerCase().includes('session'), `expected "session" in: "${desc}"`);
  });

  it('mentions daemon when daemon is unavailable', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'live',
      daemonStatus: 'unavailable',
    };
    const desc = describeConnectionState(state);
    assert.ok(desc.toLowerCase().includes('daemon'), `expected "daemon" in: "${desc}"`);
  });

  it('mentions sync when sync is in error', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'live',
      syncStatus: 'error',
    };
    const desc = describeConnectionState(state);
    assert.ok(desc.toLowerCase().includes('sync'), `expected "sync" in: "${desc}"`);
  });

  it('shows reconnect attempt number when reconnecting', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'reconnecting',
      reconnectAttempt: 3,
    };
    const desc = describeConnectionState(state);
    assert.ok(desc.includes('3'), `expected attempt "3" in: "${desc}"`);
    assert.ok(desc.toLowerCase().includes('reconnect'), `expected "reconnect" in: "${desc}"`);
  });

  it('mentions exhausted retries when disconnected with attempts > 0', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'disconnected',
      reconnectAttempt: 5,
    };
    const desc = describeConnectionState(state);
    assert.ok(desc.toLowerCase().includes('exhaust'), `expected "exhaust" in: "${desc}"`);
  });
});

// ─── initialConnectionState includes reconnectAttempt ───────────────────────

describe('initialConnectionState — reconnect fields', () => {
  it('includes reconnectAttempt: 0', () => {
    const state = initialConnectionState();
    assert.equal(state.reconnectAttempt, 0);
  });

  it('includes lastDisconnectedAt: null', () => {
    const state = initialConnectionState();
    assert.equal(state.lastDisconnectedAt, null);
  });
});

// ─── isRecovering ───────────────────────────────────────────────────────────

describe('isRecovering', () => {
  it('returns true when transport is reconnecting and sync is syncing', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'reconnecting',
      syncStatus: 'syncing',
    };
    assert.ok(isRecovering(state));
  });

  it('returns true when transport is reconnecting and reconnectAttempt > 0', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'reconnecting',
      reconnectAttempt: 2,
    };
    assert.ok(isRecovering(state));
  });

  it('returns false when transport is live', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'live',
      syncStatus: 'syncing',
    };
    assert.ok(!isRecovering(state));
  });

  it('returns false when connecting (initial, not reconnect)', () => {
    assert.ok(!isRecovering(initialConnectionState()));
  });

  it('returns false when session is terminal even if reconnecting', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'reconnecting',
      sessionStatus: 'expired',
      reconnectAttempt: 1,
    };
    assert.ok(!isRecovering(state));
  });
});

// ─── hasExhaustedRetries ────────────────────────────────────────────────────

describe('hasExhaustedRetries', () => {
  it('returns true when disconnected with reconnectAttempt > 0', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'disconnected',
      reconnectAttempt: 5,
    };
    assert.ok(hasExhaustedRetries(state));
  });

  it('returns false when disconnected with reconnectAttempt === 0', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'disconnected',
      reconnectAttempt: 0,
    };
    assert.ok(!hasExhaustedRetries(state));
  });

  it('returns false when reconnecting (still trying)', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'reconnecting',
      reconnectAttempt: 3,
    };
    assert.ok(!hasExhaustedRetries(state));
  });

  it('returns false when live', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'live',
      reconnectAttempt: 0,
    };
    assert.ok(!hasExhaustedRetries(state));
  });
});

// ─── estimateReconnectWait (T012) ───────────────────────────────────────────

describe('estimateReconnectWait', () => {
  it('returns null when not reconnecting', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'live',
      reconnectAttempt: 0,
    };
    assert.equal(estimateReconnectWait(state), null);
  });

  it('returns null when reconnecting but attempt is 0', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'reconnecting',
      reconnectAttempt: 0,
    };
    assert.equal(estimateReconnectWait(state), null);
  });

  it('returns 1 for first reconnect attempt', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'reconnecting',
      reconnectAttempt: 1,
    };
    assert.equal(estimateReconnectWait(state), 1);
  });

  it('returns exponential backoff for increasing attempts', () => {
    for (const [attempt, expected] of [
      [2, 2],
      [3, 4],
      [4, 8],
      [5, 16],
    ] as const) {
      const state: WorkspaceConnectionState = {
        ...initialConnectionState(),
        transportStatus: 'reconnecting',
        reconnectAttempt: attempt,
      };
      assert.equal(estimateReconnectWait(state), expected, `attempt ${String(attempt)}`);
    }
  });

  it('caps at 30 seconds', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'reconnecting',
      reconnectAttempt: 10,
    };
    assert.equal(estimateReconnectWait(state), 30);
  });

  it('returns null when transport is disconnected', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'disconnected',
      reconnectAttempt: 5,
    };
    assert.equal(estimateReconnectWait(state), null);
  });
});

// ─── describeConnectionState — T012 enhancements ───────────────────────────

describe('describeConnectionState T012 messaging', () => {
  it('exhausted retries message includes reload guidance', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'disconnected',
      reconnectAttempt: 5,
    };
    const msg = describeConnectionState(state);
    assert.ok(msg.includes('Reload the page'), `expected reload guidance in: ${msg}`);
    assert.ok(msg.includes('exhausted'), `expected "exhausted" in: ${msg}`);
  });

  it('reconnecting message includes estimated wait', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      transportStatus: 'reconnecting',
      reconnectAttempt: 3,
    };
    const msg = describeConnectionState(state);
    assert.ok(msg.includes('attempt 3'), `expected attempt count in: ${msg}`);
    assert.ok(msg.includes('~4s'), `expected ~4s wait estimate in: ${msg}`);
  });

  it('terminal session message includes sign-in guidance', () => {
    const state: WorkspaceConnectionState = {
      ...initialConnectionState(),
      sessionStatus: 'expired',
    };
    const msg = describeConnectionState(state);
    assert.ok(msg.includes('sign in again'), `expected sign-in guidance in: ${msg}`);
  });
});
