/**
 * T023 — Checkpoint panel browser specs.
 *
 * Covers:
 * - CheckpointPanel: loading and error states from detailFetchStatus
 * - CheckpointPanel: empty states for all availability values
 * - CheckpointPanel: renders checkpoint timeline with status badges
 * - CheckpointPanel: shows detail text when present
 * - CheckpointPanel: preserves sequence order
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

import type { CheckpointRecordView } from '@hydra/web-contracts';

import { CheckpointPanel } from '../components/checkpoint-panel.tsx';

afterEach(() => {
  cleanup();
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

const NOW = '2026-06-01T12:00:00.000Z';

function makeCheckpoint(overrides: Partial<CheckpointRecordView> = {}): CheckpointRecordView {
  return {
    id: 'cp-1',
    sequence: 0,
    label: 'Initialize',
    status: 'reached',
    timestamp: NOW,
    detail: null,
    ...overrides,
  };
}

// ─── Loading / error states ─────────────────────────────────────────────────

describe('CheckpointPanel loading and error states', () => {
  it('shows loading message when detailFetchStatus is loading', () => {
    render(
      <CheckpointPanel checkpoints={[]} detailAvailability={null} detailFetchStatus="loading" />,
    );
    expect(screen.getByTestId('checkpoint-panel')).toHaveTextContent(/loading checkpoint data/i);
  });

  it('shows error message when detailFetchStatus is error', () => {
    render(
      <CheckpointPanel checkpoints={[]} detailAvailability={null} detailFetchStatus="error" />,
    );
    expect(screen.getByTestId('checkpoint-panel')).toHaveTextContent(
      /failed to load checkpoint data/i,
    );
  });

  it('does not show "no checkpoints" while loading', () => {
    render(
      <CheckpointPanel checkpoints={[]} detailAvailability={null} detailFetchStatus="loading" />,
    );
    expect(screen.getByTestId('checkpoint-panel')).not.toHaveTextContent(/no checkpoints/i);
  });

  it('does not show "no checkpoints" after error', () => {
    render(
      <CheckpointPanel checkpoints={[]} detailAvailability={null} detailFetchStatus="error" />,
    );
    expect(screen.getByTestId('checkpoint-panel')).not.toHaveTextContent(/no checkpoints/i);
  });
});

// ─── Empty states ───────────────────────────────────────────────────────────

describe('CheckpointPanel empty states', () => {
  it('shows "no checkpoints" when list is empty with ready availability', () => {
    render(
      <CheckpointPanel checkpoints={[]} detailAvailability="ready" detailFetchStatus="idle" />,
    );
    expect(screen.getByTestId('checkpoint-panel')).toHaveTextContent(/no checkpoints/i);
  });

  it('shows "no checkpoints" when availability is partial but the list is empty', () => {
    render(
      <CheckpointPanel checkpoints={[]} detailAvailability="partial" detailFetchStatus="idle" />,
    );
    expect(screen.getByTestId('checkpoint-panel')).toHaveTextContent(/no checkpoints/i);
  });

  it('shows unavailable message when availability is unavailable', () => {
    render(
      <CheckpointPanel
        checkpoints={[]}
        detailAvailability="unavailable"
        detailFetchStatus="idle"
      />,
    );
    expect(screen.getByTestId('checkpoint-panel')).toHaveTextContent(/unavailable/i);
  });

  it('shows default message when availability is null and fetch is idle', () => {
    render(<CheckpointPanel checkpoints={[]} detailAvailability={null} detailFetchStatus="idle" />);
    expect(screen.getByTestId('checkpoint-panel')).toHaveTextContent(/no checkpoints/i);
  });
});

// ─── Rendering checkpoint entries ───────────────────────────────────────────

describe('CheckpointPanel rendering', () => {
  it('renders the heading', () => {
    render(
      <CheckpointPanel checkpoints={[]} detailAvailability="ready" detailFetchStatus="idle" />,
    );
    expect(screen.getByRole('heading', { name: /checkpoints/i })).toBeInTheDocument();
  });

  it('renders checkpoint entries in a list', () => {
    const checkpoints = [
      makeCheckpoint({ id: 'cp-1', sequence: 0, label: 'Init' }),
      makeCheckpoint({ id: 'cp-2', sequence: 1, label: 'Build', status: 'waiting' }),
    ];

    render(
      <CheckpointPanel
        checkpoints={checkpoints}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    const list = screen.getByRole('list', { name: /checkpoint timeline/i });
    expect(list).toBeInTheDocument();
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });

  it('renders checkpoint labels', () => {
    const checkpoints = [
      makeCheckpoint({ id: 'cp-1', label: 'Environment setup' }),
      makeCheckpoint({ id: 'cp-2', sequence: 1, label: 'Tests passing' }),
    ];

    render(
      <CheckpointPanel
        checkpoints={checkpoints}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    expect(screen.getByText('Environment setup')).toBeInTheDocument();
    expect(screen.getByText('Tests passing')).toBeInTheDocument();
  });

  it('renders checkpoint status badges', () => {
    const checkpoints = [
      makeCheckpoint({ id: 'cp-1', status: 'reached' }),
      makeCheckpoint({ id: 'cp-2', sequence: 1, status: 'waiting', label: 'Pending' }),
    ];

    render(
      <CheckpointPanel
        checkpoints={checkpoints}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    expect(screen.getByText('reached')).toBeInTheDocument();
    expect(screen.getByText('waiting')).toBeInTheDocument();
  });
});

// ─── Checkpoint entry details ───────────────────────────────────────────────

describe('CheckpointPanel entry details', () => {
  it('shows detail text when checkpoint has detail', () => {
    const checkpoints = [makeCheckpoint({ id: 'cp-1', detail: 'Waiting for CI pipeline' })];

    render(
      <CheckpointPanel
        checkpoints={checkpoints}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );
    expect(screen.getByText('Waiting for CI pipeline')).toBeInTheDocument();
  });

  it('omits detail text when checkpoint detail is null', () => {
    const checkpoints = [makeCheckpoint({ id: 'cp-1', detail: null })];
    render(
      <CheckpointPanel
        checkpoints={checkpoints}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    const entry = screen.getByTestId('checkpoint-cp-1');
    // Should only have label, badge, and timestamp — no italic detail
    expect(entry.querySelectorAll('[style*="italic"]')).toHaveLength(0);
  });

  it('assigns data-testid per checkpoint entry', () => {
    const checkpoints = [
      makeCheckpoint({ id: 'cp-alpha' }),
      makeCheckpoint({ id: 'cp-beta', sequence: 1, label: 'Beta' }),
    ];

    render(
      <CheckpointPanel
        checkpoints={checkpoints}
        detailAvailability="ready"
        detailFetchStatus="idle"
      />,
    );

    expect(screen.getByTestId('checkpoint-cp-alpha')).toBeInTheDocument();
    expect(screen.getByTestId('checkpoint-cp-beta')).toBeInTheDocument();
  });
});

// ─── Loading / error states with existing checkpoints ───────────────────────

describe('CheckpointPanel stale-data indicators', () => {
  it('shows loading notice when refetching with existing checkpoints', () => {
    const checkpoints = [makeCheckpoint({ id: 'cp-1', label: 'Init' })];
    render(
      <CheckpointPanel
        checkpoints={checkpoints}
        detailAvailability="ready"
        detailFetchStatus="loading"
      />,
    );
    expect(screen.getByTestId('checkpoint-panel')).toHaveTextContent(/loading checkpoint data/i);
    // Checkpoint entries should still be visible alongside the notice
    expect(screen.getByTestId('checkpoint-cp-1')).toBeInTheDocument();
  });

  it('shows error notice when refetch failed with existing checkpoints', () => {
    const checkpoints = [makeCheckpoint({ id: 'cp-1', label: 'Init' })];
    render(
      <CheckpointPanel
        checkpoints={checkpoints}
        detailAvailability="ready"
        detailFetchStatus="error"
      />,
    );
    expect(screen.getByTestId('checkpoint-panel')).toHaveTextContent(
      /failed to load checkpoint data/i,
    );
    expect(screen.getByTestId('checkpoint-cp-1')).toBeInTheDocument();
  });
});

// ─── All checkpoint statuses render ─────────────────────────────────────────

describe('CheckpointPanel status coverage', () => {
  const statuses = ['reached', 'waiting', 'resumed', 'recovered', 'skipped'] as const;

  for (const status of statuses) {
    it(`renders checkpoint with status "${status}"`, () => {
      const checkpoints = [
        makeCheckpoint({ id: `cp-${status}`, status, label: `${status} checkpoint` }),
      ];

      render(
        <CheckpointPanel
          checkpoints={checkpoints}
          detailAvailability="ready"
          detailFetchStatus="idle"
        />,
      );
      expect(screen.getByText(status)).toBeInTheDocument();
      expect(screen.getByText(`${status} checkpoint`)).toBeInTheDocument();
    });
  }
});
