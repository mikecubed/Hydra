/**
 * Browser-side session and connection status vocabulary.
 *
 * Defines the WorkspaceConnectionState model and helpers for the
 * operator-visible transport, sync, session, and daemon statuses.
 *
 * Session status values align with the subset of SessionState from
 * @hydra/web-contracts that are relevant in the browser workspace
 * (excludes 'logged-out' and 'daemon-unreachable' which the browser
 * models through separate daemonStatus / auth redirect flows).
 *
 * **Ownership boundary**: This module is chat-workspace-owned state only.
 * Operations panel synchronization state lives entirely in
 * `features/operations-panels/model/` and is managed by
 * `WorkspaceOperationsPanel` independently. These two state trees must
 * never be merged — the chat workspace owns conversation/stream state
 * and the operations panel owns queue/detail/control state. Composition
 * happens at the layout layer (`workspace-layout.tsx`) via slot injection,
 * ensuring neither surface can corrupt the other's state.
 */

// ─── Transport Status ───────────────────────────────────────────────────────

/** WebSocket / session transport visibility from the operator's perspective. */
export type TransportStatus = 'connecting' | 'live' | 'reconnecting' | 'disconnected';

export const TRANSPORT_STATUSES: readonly TransportStatus[] = Object.freeze([
  'connecting',
  'live',
  'reconnecting',
  'disconnected',
] as const);

// ─── Sync Status ────────────────────────────────────────────────────────────

/** Transcript / state reconciliation visibility. */
export type SyncStatus = 'idle' | 'syncing' | 'recovered' | 'error';

export const SYNC_STATUSES: readonly SyncStatus[] = Object.freeze([
  'idle',
  'syncing',
  'recovered',
  'error',
] as const);

// ─── Browser Session Status ─────────────────────────────────────────────────

/**
 * Browser-side session lifecycle visibility.
 *
 * Subset of the gateway's SessionState — 'logged-out' triggers an auth
 * redirect rather than a connection state, and 'daemon-unreachable' is
 * modeled via daemonStatus.
 */
export type BrowserSessionStatus = 'active' | 'expiring-soon' | 'expired' | 'invalidated';

export const BROWSER_SESSION_STATUSES: readonly BrowserSessionStatus[] = Object.freeze([
  'active',
  'expiring-soon',
  'expired',
  'invalidated',
] as const);

/** Session statuses that are terminal — no further useful transitions. */
const TERMINAL_SESSION_STATUSES: ReadonlySet<BrowserSessionStatus> = new Set([
  'expired',
  'invalidated',
]);

// ─── Daemon Status ──────────────────────────────────────────────────────────

/** Gateway / daemon reachability from the browser's perspective. */
export type DaemonStatus = 'healthy' | 'unavailable' | 'recovering';

export const DAEMON_STATUSES: readonly DaemonStatus[] = Object.freeze([
  'healthy',
  'unavailable',
  'recovering',
] as const);

// ─── WorkspaceConnectionState ───────────────────────────────────────────────

/**
 * Operator-visible connection state for the browser workspace.
 *
 * Combines transport, sync, session, and daemon dimensions so
 * the UI can communicate distinct failure modes to the operator.
 */
export interface WorkspaceConnectionState {
  readonly transportStatus: TransportStatus;
  readonly syncStatus: SyncStatus;
  readonly sessionStatus: BrowserSessionStatus;
  readonly daemonStatus: DaemonStatus;
  readonly lastAuthoritativeUpdate: string | null;
  /** Current reconnect attempt number (0 = not reconnecting / first connect). */
  readonly reconnectAttempt: number;
  /** ISO timestamp of the most recent transport disconnect, or null if never disconnected. */
  readonly lastDisconnectedAt: string | null;
}

/** Initial connection state for a fresh workspace load. */
export function initialConnectionState(): WorkspaceConnectionState {
  return {
    transportStatus: 'connecting',
    syncStatus: 'idle',
    sessionStatus: 'active',
    daemonStatus: 'healthy',
    lastAuthoritativeUpdate: null,
    reconnectAttempt: 0,
    lastDisconnectedAt: null,
  };
}

// ─── Predicates ─────────────────────────────────────────────────────────────

/**
 * Whether the workspace is in a fully operational state:
 * transport is live, sync is idle or recovered, and session is non-terminal.
 */
export function isOperational(state: WorkspaceConnectionState): boolean {
  return (
    state.transportStatus === 'live' &&
    (state.syncStatus === 'idle' || state.syncStatus === 'recovered') &&
    !TERMINAL_SESSION_STATUSES.has(state.sessionStatus)
  );
}

/**
 * Whether the operator can submit new work.
 * Requires operational state plus a healthy daemon.
 */
export function canSubmitWork(state: WorkspaceConnectionState): boolean {
  return isOperational(state) && state.daemonStatus === 'healthy';
}

/** Whether the session has reached a terminal state. */
export function isSessionTerminal(state: WorkspaceConnectionState): boolean {
  return TERMINAL_SESSION_STATUSES.has(state.sessionStatus);
}

/** Whether the transport needs reconnection. */
export function needsReconnect(state: WorkspaceConnectionState): boolean {
  return state.transportStatus === 'disconnected' || state.transportStatus === 'reconnecting';
}

/**
 * Whether the workspace is actively recovering from a connection loss.
 * True when transport is reconnecting (with attempts in progress) and
 * the session has not reached a terminal state.
 */
export function isRecovering(state: WorkspaceConnectionState): boolean {
  if (TERMINAL_SESSION_STATUSES.has(state.sessionStatus)) return false;
  return (
    state.transportStatus === 'reconnecting' &&
    (state.syncStatus === 'syncing' || state.reconnectAttempt > 0)
  );
}

/**
 * Whether reconnect attempts have been exhausted.
 * True when the transport is disconnected and at least one reconnect
 * attempt was made (reconnectAttempt > 0 implies the client gave up).
 */
export function hasExhaustedRetries(state: WorkspaceConnectionState): boolean {
  return state.transportStatus === 'disconnected' && state.reconnectAttempt > 0;
}

/**
 * Estimate the next reconnect wait in seconds based on deterministic
 * exponential backoff (1–30 s, capped). No jitter is applied — the
 * returned value is always `min(2^(attempt-1), 30)`.
 * Returns null when not reconnecting.
 */
export function estimateReconnectWait(state: WorkspaceConnectionState): number | null {
  if (state.transportStatus !== 'reconnecting' || state.reconnectAttempt <= 0) return null;
  const base = Math.min(2 ** (state.reconnectAttempt - 1), 30);
  return base;
}

// ─── Human-readable description ─────────────────────────────────────────────

/** Produce a concise operator-facing description of the connection state. */
export function describeConnectionState(state: WorkspaceConnectionState): string {
  if (TERMINAL_SESSION_STATUSES.has(state.sessionStatus)) {
    return `Session ${state.sessionStatus} — please sign in again`;
  }

  if (state.transportStatus === 'disconnected') {
    if (state.reconnectAttempt > 0) {
      return 'Disconnected — reconnect attempts exhausted. Reload the page to retry.';
    }
    return 'Disconnected from gateway';
  }

  if (state.transportStatus === 'reconnecting') {
    if (state.reconnectAttempt > 0) {
      const wait = estimateReconnectWait(state);
      const waitSuffix = wait === null ? '' : ` · next attempt in ~${String(wait)}s`;
      return `Reconnecting to gateway… (attempt ${String(state.reconnectAttempt)})${waitSuffix}`;
    }
    return 'Reconnecting to gateway…';
  }

  if (state.transportStatus === 'connecting') {
    return 'Connecting to gateway…';
  }

  if (state.daemonStatus === 'unavailable') {
    return 'Hydra daemon is unavailable';
  }

  if (state.daemonStatus === 'recovering') {
    return 'Hydra daemon is recovering';
  }

  if (state.syncStatus === 'error') {
    return 'Sync error — transcript may be stale';
  }

  if (state.syncStatus === 'syncing') {
    return 'Synchronizing workspace…';
  }

  if (state.sessionStatus === 'expiring-soon') {
    return 'Session expiring soon';
  }

  return 'Connected';
}
