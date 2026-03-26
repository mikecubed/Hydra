/**
 * Routing panel — renders the routing decision and history for a selected work item.
 *
 * Displays the current route and mode, plus a history timeline of routing
 * changes with reasons. Shows contextual empty states for loading, partial,
 * and unavailable detail availability.
 */
import type { CSSProperties, JSX } from 'react';
import type {
  DetailAvailability,
  RoutingDecisionView,
  RoutingHistoryEntry,
} from '@hydra/web-contracts';
import type { DetailFetchStatus } from '../model/operations-types.ts';

// ─── Styles ─────────────────────────────────────────────────────────────────

const panelStyle: CSSProperties = {
  display: 'grid',
  gap: '0.5rem',
};

const headingStyle: CSSProperties = {
  margin: 0,
  fontSize: '0.9rem',
  fontWeight: 600,
  color: '#e2e8f0',
};

const listStyle: CSSProperties = {
  display: 'grid',
  gap: '0.375rem',
  margin: 0,
  padding: 0,
  listStyle: 'none',
};

const entryStyle: CSSProperties = {
  border: '1px solid rgba(148, 163, 184, 0.2)',
  borderRadius: '0.375rem',
  background: 'rgba(148, 163, 184, 0.03)',
  padding: '0.4rem 0.6rem',
  display: 'grid',
  gap: '0.2rem',
};

const labelStyle: CSSProperties = {
  fontWeight: 600,
  fontSize: '0.8rem',
  color: '#e2e8f0',
};

const metaStyle: CSSProperties = {
  fontSize: '0.7rem',
  color: '#64748b',
};

const reasonStyle: CSSProperties = {
  fontSize: '0.75rem',
  color: '#94a3b8',
  fontStyle: 'italic',
};

const emptyStyle: CSSProperties = {
  fontSize: '0.8rem',
  color: '#64748b',
  fontStyle: 'italic',
  margin: 0,
};

const currentSectionStyle: CSSProperties = {
  display: 'grid',
  gap: '0.25rem',
  padding: '0.5rem 0.75rem',
  border: '1px solid rgba(56, 189, 248, 0.2)',
  borderRadius: '0.375rem',
  background: 'rgba(56, 189, 248, 0.03)',
};

const currentRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
};

const currentLabelStyle: CSSProperties = {
  fontSize: '0.75rem',
  color: '#94a3b8',
  fontWeight: 500,
};

const currentValueStyle: CSSProperties = {
  fontSize: '0.8rem',
  fontWeight: 600,
  color: '#e2e8f0',
};

const nullValueStyle: CSSProperties = {
  ...currentValueStyle,
  color: '#64748b',
  fontStyle: 'italic',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  try {
    const date = new Date(iso);
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

function resolveStatusNotice(fetchStatus: DetailFetchStatus): string | null {
  if (fetchStatus === 'loading') return 'Loading routing data\u2026';
  if (fetchStatus === 'error') return 'Failed to load routing data.';
  return null;
}

function resolveEmptyMessage(
  availability: DetailAvailability | null,
  fetchStatus: DetailFetchStatus,
): string {
  const notice = resolveStatusNotice(fetchStatus);
  if (notice !== null) return notice;
  if (availability === 'unavailable') return 'Routing data is currently unavailable.';
  return 'No routing data recorded yet.';
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function CurrentRoutingSection({
  routing,
}: {
  readonly routing: RoutingDecisionView;
}): JSX.Element {
  return (
    <div style={currentSectionStyle}>
      <div style={currentRowStyle}>
        <span style={currentLabelStyle}>Route</span>
        <span
          data-testid="routing-current-route"
          style={routing.currentRoute === null ? nullValueStyle : currentValueStyle}
        >
          {routing.currentRoute ?? 'none'}
        </span>
      </div>
      <div style={currentRowStyle}>
        <span style={currentLabelStyle}>Mode</span>
        <span
          data-testid="routing-current-mode"
          style={routing.currentMode === null ? nullValueStyle : currentValueStyle}
        >
          {routing.currentMode ?? 'none'}
        </span>
      </div>
    </div>
  );
}

function HistoryEntryRow({ entry }: { readonly entry: RoutingHistoryEntry }): JSX.Element {
  return (
    <div style={entryStyle} data-testid={`routing-history-${entry.id}`}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={labelStyle}>{entry.route ?? 'none'}</span>
        {entry.mode != null && (
          <span style={{ fontSize: '0.7rem', color: '#94a3b8' }}>{entry.mode}</span>
        )}
      </div>
      <span style={metaStyle}>{formatTimestamp(entry.changedAt)}</span>
      {entry.reason != null && <span style={reasonStyle}>{entry.reason}</span>}
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export interface RoutingPanelProps {
  readonly routing: RoutingDecisionView | null;
  readonly detailAvailability: DetailAvailability | null;
  readonly detailFetchStatus: DetailFetchStatus;
}

export function RoutingPanel({
  routing,
  detailAvailability,
  detailFetchStatus,
}: RoutingPanelProps): JSX.Element {
  const statusNotice = resolveStatusNotice(detailFetchStatus);
  const hasData = routing !== null;
  const hasHistory = routing !== null && routing.history.length > 0;

  return (
    <div style={panelStyle} data-testid="routing-panel">
      <h4 style={headingStyle}>Routing</h4>
      {statusNotice !== null && <p style={emptyStyle}>{statusNotice}</p>}
      {hasData && <CurrentRoutingSection routing={routing} />}
      {!hasData && statusNotice === null && (
        <p style={emptyStyle}>{resolveEmptyMessage(detailAvailability, detailFetchStatus)}</p>
      )}
      {hasHistory && (
        <ol aria-label="Routing history" style={listStyle}>
          {routing.history.map((entry) => (
            <li key={entry.id}>
              <HistoryEntryRow entry={entry} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
