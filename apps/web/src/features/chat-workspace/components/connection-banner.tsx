/**
 * Connection status banner — operator-visible reconnect and sync indicator.
 *
 * Pure presentational component. Renders nothing when the workspace is fully
 * operational; shows a banner with ARIA live region semantics when the
 * connection degrades.
 *
 * Severity mapping:
 *   alert  (assertive) — terminal session, sync error, daemon down,
 *                        exhausted reconnect retries
 *   status (polite)    — connecting, disconnected, reconnecting, syncing,
 *                        expiring-soon, daemon recovering
 */

import { createContext, type JSX } from 'react';
import type { WorkspaceConnectionState } from '../../../shared/session-state.ts';
import {
  describeConnectionState,
  hasExhaustedRetries,
  isOperational,
  isSessionTerminal,
} from '../../../shared/session-state.ts';

// ─── Context for cross-component wiring ─────────────────────────────────────

/**
 * Optional context so layout or sibling components can access the connection
 * state without owning the workspace store. The workspace route (or another
 * feature boundary) provides the state; consumers own their own banner /
 * indicator rendering.
 */
export const ConnectionStateContext = createContext<WorkspaceConnectionState | null>(null);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ConnectionBannerProps {
  readonly connection: WorkspaceConnectionState;
  /** Stale-control reason from multi-session convergence (warning severity). */
  readonly staleControlReason?: string | null;
  /** General convergence hint for informational display (info severity). */
  readonly convergenceHint?: string | null;
}

type BannerSeverity = 'info' | 'warning' | 'error';

function hasBannerText(value: string | null | undefined): value is string {
  return value != null && value.length > 0;
}

// ─── Severity derivation ────────────────────────────────────────────────────

function deriveSeverity(connection: WorkspaceConnectionState): BannerSeverity {
  if (isSessionTerminal(connection)) return 'error';
  if (hasExhaustedRetries(connection)) return 'error';
  if (connection.syncStatus === 'error') return 'error';
  if (connection.daemonStatus === 'unavailable') return 'error';

  if (connection.transportStatus === 'reconnecting') return 'warning';
  if (connection.daemonStatus === 'recovering') return 'warning';
  if (connection.sessionStatus === 'expiring-soon') return 'warning';

  return 'info';
}

// ─── Visual styles ──────────────────────────────────────────────────────────

const SEVERITY_STYLES: Record<BannerSeverity, { background: string; borderColor: string }> = {
  info: {
    background: 'rgba(56, 189, 248, 0.12)',
    borderColor: 'rgba(56, 189, 248, 0.4)',
  },
  warning: {
    background: 'rgba(251, 191, 36, 0.12)',
    borderColor: 'rgba(251, 191, 36, 0.4)',
  },
  error: {
    background: 'rgba(248, 113, 113, 0.12)',
    borderColor: 'rgba(248, 113, 113, 0.4)',
  },
};

const SEVERITY_TEXT_COLORS: Record<BannerSeverity, string> = {
  info: '#7dd3fc',
  warning: '#fbbf24',
  error: '#fca5a5',
};

// ─── Component ──────────────────────────────────────────────────────────────

/**
 * Whether the connection state warrants hiding the banner entirely.
 * Fully operational = transport live, sync idle/recovered, session active
 * (not expiring-soon), and daemon healthy.
 */
function isFullyQuiet(connection: WorkspaceConnectionState): boolean {
  return (
    isOperational(connection) &&
    connection.daemonStatus === 'healthy' &&
    connection.sessionStatus === 'active'
  );
}

function resolveBannerSeverity(
  quiet: boolean,
  connectionSeverity: BannerSeverity,
  hasStale: boolean,
): BannerSeverity {
  if (!quiet) {
    return connectionSeverity;
  }

  return hasStale ? 'warning' : 'info';
}

function resolveBannerMessage(
  connection: WorkspaceConnectionState,
  quiet: boolean,
  extraMessage: string | null,
): string {
  if (quiet) {
    return extraMessage ?? 'Connected';
  }

  const connectionMessage = describeConnectionState(connection);
  if (extraMessage == null) {
    return connectionMessage;
  }

  return `${connectionMessage} · ${extraMessage}`;
}

function resolveExtraMessage(
  staleControlReason: string | null | undefined,
  convergenceHint: string | null | undefined,
): string | null {
  if (hasBannerText(staleControlReason)) {
    return staleControlReason;
  }

  if (hasBannerText(convergenceHint)) {
    return convergenceHint;
  }

  return null;
}

/**
 * Displays a connection status banner when the workspace is not fully
 * operational. Returns `null` when everything is healthy.
 *
 * When `staleControlReason` is provided (controls invalidated by another
 * session), a warning-severity banner is shown even on a fully operational
 * connection. Connection-level issues take precedence over stale-control
 * messaging. `convergenceHint` provides lighter informational messaging.
 */
export function ConnectionBanner({
  connection,
  staleControlReason,
  convergenceHint,
}: ConnectionBannerProps): JSX.Element | null {
  const hasStale = hasBannerText(staleControlReason);
  const extraMessage = resolveExtraMessage(staleControlReason, convergenceHint);
  const quiet = isFullyQuiet(connection);

  if (quiet && extraMessage == null) return null;

  // Connection issues always take precedence over stale-control/convergence messaging
  const connectionSeverity = deriveSeverity(connection);
  const severity = resolveBannerSeverity(quiet, connectionSeverity, hasStale);
  const message = resolveBannerMessage(connection, quiet, extraMessage);
  const isAlert = severity === 'error';

  const severityStyle = SEVERITY_STYLES[severity];

  return (
    <div
      role={isAlert ? 'alert' : 'status'}
      aria-live={isAlert ? 'assertive' : 'polite'}
      style={{
        padding: '0.625rem 2rem',
        fontSize: '0.875rem',
        lineHeight: 1.5,
        color: SEVERITY_TEXT_COLORS[severity],
        background: severityStyle.background,
        borderBottom: `1px solid ${severityStyle.borderColor}`,
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
      }}
    >
      <span aria-hidden="true">{isAlert ? '⚠' : '◌'}</span>
      <span>{message}</span>
    </div>
  );
}
