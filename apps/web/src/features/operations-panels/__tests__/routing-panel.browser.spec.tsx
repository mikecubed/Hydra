/**
 * T034 — Routing panel browser specs.
 *
 * Covers:
 * - RoutingPanel: loading and error states from detailFetchStatus
 * - RoutingPanel: empty states for all availability values
 * - RoutingPanel: renders current route and mode
 * - RoutingPanel: renders routing history entries with reasons
 * - RoutingPanel: handles null optional fields (route, mode, reason)
 * - RoutingPanel: formats timestamps in history entries
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

import type { RoutingDecisionView, RoutingHistoryEntry } from '@hydra/web-contracts';

import { RoutingPanel } from '../components/routing-panel.tsx';

afterEach(() => {
  cleanup();
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

const NOW = '2026-06-01T12:00:00.000Z';
const EARLIER = '2026-06-01T11:30:00.000Z';

function makeHistoryEntry(overrides: Partial<RoutingHistoryEntry> = {}): RoutingHistoryEntry {
  return {
    id: 'rh-1',
    route: 'claude',
    mode: 'balanced',
    changedAt: NOW,
    reason: null,
    ...overrides,
  };
}

function makeRouting(overrides: Partial<RoutingDecisionView> = {}): RoutingDecisionView {
  return {
    currentRoute: 'claude',
    currentMode: 'balanced',
    changedAt: NOW,
    history: [],
    ...overrides,
  };
}

// ─── Loading / error states ─────────────────────────────────────────────────

describe('RoutingPanel loading and error states', () => {
  it('shows loading message when detailFetchStatus is loading', () => {
    render(<RoutingPanel routing={null} detailAvailability={null} detailFetchStatus="loading" />);
    expect(screen.getByTestId('routing-panel')).toHaveTextContent(/loading routing data/i);
  });

  it('shows error message when detailFetchStatus is error', () => {
    render(<RoutingPanel routing={null} detailAvailability={null} detailFetchStatus="error" />);
    expect(screen.getByTestId('routing-panel')).toHaveTextContent(/failed to load routing data/i);
  });

  it('does not show "no routing" while loading', () => {
    render(<RoutingPanel routing={null} detailAvailability={null} detailFetchStatus="loading" />);
    expect(screen.getByTestId('routing-panel')).not.toHaveTextContent(/no routing/i);
  });

  it('does not show "no routing" after error', () => {
    render(<RoutingPanel routing={null} detailAvailability={null} detailFetchStatus="error" />);
    expect(screen.getByTestId('routing-panel')).not.toHaveTextContent(/no routing/i);
  });
});

// ─── Empty states ───────────────────────────────────────────────────────────

describe('RoutingPanel empty states', () => {
  it('shows "no routing" when routing is null with ready availability', () => {
    render(<RoutingPanel routing={null} detailAvailability="ready" detailFetchStatus="idle" />);
    expect(screen.getByTestId('routing-panel')).toHaveTextContent(/no routing/i);
  });

  it('shows "no routing" when routing is null with partial availability', () => {
    render(<RoutingPanel routing={null} detailAvailability="partial" detailFetchStatus="idle" />);
    expect(screen.getByTestId('routing-panel')).toHaveTextContent(/no routing/i);
  });

  it('shows unavailable message when availability is unavailable', () => {
    render(
      <RoutingPanel routing={null} detailAvailability="unavailable" detailFetchStatus="idle" />,
    );
    expect(screen.getByTestId('routing-panel')).toHaveTextContent(/unavailable/i);
  });

  it('shows default message when availability is null and fetch is idle', () => {
    render(<RoutingPanel routing={null} detailAvailability={null} detailFetchStatus="idle" />);
    expect(screen.getByTestId('routing-panel')).toHaveTextContent(/no routing/i);
  });
});

// ─── Heading ────────────────────────────────────────────────────────────────

describe('RoutingPanel heading', () => {
  it('renders the heading', () => {
    render(<RoutingPanel routing={null} detailAvailability="ready" detailFetchStatus="idle" />);
    expect(screen.getByRole('heading', { name: /routing/i })).toBeInTheDocument();
  });
});

// ─── Current route and mode ─────────────────────────────────────────────────

describe('RoutingPanel current route and mode', () => {
  it('renders current route', () => {
    render(
      <RoutingPanel
        routing={makeRouting({ currentRoute: 'gemini' })}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );
    expect(screen.getByTestId('routing-current-route')).toHaveTextContent('gemini');
  });

  it('renders current mode', () => {
    render(
      <RoutingPanel
        routing={makeRouting({ currentMode: 'performance' })}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );
    expect(screen.getByTestId('routing-current-mode')).toHaveTextContent('performance');
  });

  it('shows placeholder when currentRoute is null', () => {
    render(
      <RoutingPanel
        routing={makeRouting({ currentRoute: null })}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );
    expect(screen.getByTestId('routing-current-route')).toHaveTextContent(/none/i);
  });

  it('shows placeholder when currentMode is null', () => {
    render(
      <RoutingPanel
        routing={makeRouting({ currentMode: null })}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );
    expect(screen.getByTestId('routing-current-mode')).toHaveTextContent(/none/i);
  });
});

// ─── History entries ────────────────────────────────────────────────────────

/* eslint-disable max-lines-per-function -- broad DOM coverage for routing history states is kept in one scenario block */
describe('RoutingPanel history entries', () => {
  it('renders history entries in a list', () => {
    const history = [
      makeHistoryEntry({ id: 'rh-1', route: 'claude', changedAt: NOW }),
      makeHistoryEntry({ id: 'rh-2', route: 'gemini', changedAt: EARLIER }),
    ];

    render(
      <RoutingPanel
        routing={makeRouting({ history })}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    const list = screen.getByRole('list', { name: /routing history/i });
    expect(list).toBeInTheDocument();
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });

  it('renders route and mode for each history entry', () => {
    const history = [makeHistoryEntry({ id: 'rh-1', route: 'codex', mode: 'economy' })];

    render(
      <RoutingPanel
        routing={makeRouting({ history })}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    const entry = screen.getByTestId('routing-history-rh-1');
    expect(entry).toHaveTextContent('codex');
    expect(entry).toHaveTextContent('economy');
  });

  it('renders reason when present in history entry', () => {
    const history = [makeHistoryEntry({ id: 'rh-1', reason: 'Capacity rebalancing' })];

    render(
      <RoutingPanel
        routing={makeRouting({ history })}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    expect(screen.getByText('Capacity rebalancing')).toBeInTheDocument();
  });

  it('omits reason text when reason is null', () => {
    const history = [makeHistoryEntry({ id: 'rh-1', reason: null })];

    render(
      <RoutingPanel
        routing={makeRouting({ history })}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    const entry = screen.getByTestId('routing-history-rh-1');
    expect(entry.querySelectorAll('[style*="italic"]')).toHaveLength(0);
  });

  it('handles null route in history entry', () => {
    const history = [makeHistoryEntry({ id: 'rh-1', route: null, mode: 'balanced' })];

    render(
      <RoutingPanel
        routing={makeRouting({ history })}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    const entry = screen.getByTestId('routing-history-rh-1');
    expect(entry).toBeInTheDocument();
  });

  it('handles null mode in history entry', () => {
    const history = [makeHistoryEntry({ id: 'rh-1', route: 'claude', mode: null })];

    render(
      <RoutingPanel
        routing={makeRouting({ history })}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    const entry = screen.getByTestId('routing-history-rh-1');
    expect(entry).toBeInTheDocument();
  });

  it('shows empty history message when routing has no history', () => {
    render(
      <RoutingPanel
        routing={makeRouting({ history: [] })}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );
    expect(screen.queryByRole('list', { name: /routing history/i })).not.toBeInTheDocument();
  });

  it('assigns data-testid per history entry', () => {
    const history = [
      makeHistoryEntry({ id: 'rh-alpha' }),
      makeHistoryEntry({ id: 'rh-beta', changedAt: EARLIER }),
    ];

    render(
      <RoutingPanel
        routing={makeRouting({ history })}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    expect(screen.getByTestId('routing-history-rh-alpha')).toBeInTheDocument();
    expect(screen.getByTestId('routing-history-rh-beta')).toBeInTheDocument();
  });
});
/* eslint-enable max-lines-per-function */

// ─── Loading with existing data ─────────────────────────────────────────────

describe('RoutingPanel stale-data indicators', () => {
  it('shows loading notice when refetching with existing routing data', () => {
    render(
      <RoutingPanel
        routing={makeRouting({ currentRoute: 'claude' })}
        detailAvailability="ready"
        detailFetchStatus="loading"
      />,
    );
    expect(screen.getByTestId('routing-panel')).toHaveTextContent(/loading routing data/i);
    expect(screen.getByTestId('routing-current-route')).toHaveTextContent('claude');
  });

  it('shows error notice when refetch failed with existing routing data', () => {
    render(
      <RoutingPanel
        routing={makeRouting({ currentRoute: 'claude' })}
        detailAvailability="ready"
        detailFetchStatus="error"
      />,
    );
    expect(screen.getByTestId('routing-panel')).toHaveTextContent(/failed to load routing data/i);
    expect(screen.getByTestId('routing-current-route')).toHaveTextContent('claude');
  });
});
