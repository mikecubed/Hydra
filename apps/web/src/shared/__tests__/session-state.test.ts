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
  describeConnectionState,
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
      transportStatus: 'live',
      syncStatus: 'idle',
      sessionStatus: 'active',
      daemonStatus: 'healthy',
      lastAuthoritativeUpdate: null,
    };
    assert.ok(isOperational(state));
  });

  it('returns true when sync is recovered', () => {
    const state: WorkspaceConnectionState = {
      transportStatus: 'live',
      syncStatus: 'recovered',
      sessionStatus: 'active',
      daemonStatus: 'healthy',
      lastAuthoritativeUpdate: null,
    };
    assert.ok(isOperational(state));
  });

  it('returns true when session is expiring-soon (still operational)', () => {
    const state: WorkspaceConnectionState = {
      transportStatus: 'live',
      syncStatus: 'idle',
      sessionStatus: 'expiring-soon',
      daemonStatus: 'healthy',
      lastAuthoritativeUpdate: null,
    };
    assert.ok(isOperational(state));
  });

  it('returns false when transport is not live', () => {
    const state: WorkspaceConnectionState = {
      transportStatus: 'reconnecting',
      syncStatus: 'idle',
      sessionStatus: 'active',
      daemonStatus: 'healthy',
      lastAuthoritativeUpdate: null,
    };
    assert.ok(!isOperational(state));
  });

  it('returns false when sync is in error', () => {
    const state: WorkspaceConnectionState = {
      transportStatus: 'live',
      syncStatus: 'error',
      sessionStatus: 'active',
      daemonStatus: 'healthy',
      lastAuthoritativeUpdate: null,
    };
    assert.ok(!isOperational(state));
  });

  it('returns false when session is expired', () => {
    const state: WorkspaceConnectionState = {
      transportStatus: 'live',
      syncStatus: 'idle',
      sessionStatus: 'expired',
      daemonStatus: 'healthy',
      lastAuthoritativeUpdate: null,
    };
    assert.ok(!isOperational(state));
  });

  it('returns false when session is invalidated', () => {
    const state: WorkspaceConnectionState = {
      transportStatus: 'live',
      syncStatus: 'idle',
      sessionStatus: 'invalidated',
      daemonStatus: 'healthy',
      lastAuthoritativeUpdate: null,
    };
    assert.ok(!isOperational(state));
  });
});

// ─── canSubmitWork ──────────────────────────────────────────────────────────

describe('canSubmitWork', () => {
  it('returns true when operational and daemon is healthy', () => {
    const state: WorkspaceConnectionState = {
      transportStatus: 'live',
      syncStatus: 'idle',
      sessionStatus: 'active',
      daemonStatus: 'healthy',
      lastAuthoritativeUpdate: null,
    };
    assert.ok(canSubmitWork(state));
  });

  it('returns false when daemon is unavailable', () => {
    const state: WorkspaceConnectionState = {
      transportStatus: 'live',
      syncStatus: 'idle',
      sessionStatus: 'active',
      daemonStatus: 'unavailable',
      lastAuthoritativeUpdate: null,
    };
    assert.ok(!canSubmitWork(state));
  });

  it('returns false when daemon is recovering', () => {
    const state: WorkspaceConnectionState = {
      transportStatus: 'live',
      syncStatus: 'idle',
      sessionStatus: 'active',
      daemonStatus: 'recovering',
      lastAuthoritativeUpdate: null,
    };
    assert.ok(!canSubmitWork(state));
  });

  it('returns false when not operational even if daemon is healthy', () => {
    const state: WorkspaceConnectionState = {
      transportStatus: 'disconnected',
      syncStatus: 'idle',
      sessionStatus: 'active',
      daemonStatus: 'healthy',
      lastAuthoritativeUpdate: null,
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
      transportStatus: 'live',
      syncStatus: 'idle',
      sessionStatus: 'active',
      daemonStatus: 'healthy',
      lastAuthoritativeUpdate: null,
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
});
