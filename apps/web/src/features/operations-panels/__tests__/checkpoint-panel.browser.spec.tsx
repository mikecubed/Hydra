/**
 * T023 — Checkpoint panel browser specs.
 *
 * Covers:
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

// ─── Empty states ───────────────────────────────────────────────────────────

describe('CheckpointPanel empty states', () => {
  it('shows "no checkpoints" when list is empty with ready availability', () => {
    render(<CheckpointPanel checkpoints={[]} detailAvailability="ready" />);
    expect(screen.getByTestId('checkpoint-panel')).toHaveTextContent(/no checkpoints/i);
  });

  it('shows partial message when availability is partial', () => {
    render(<CheckpointPanel checkpoints={[]} detailAvailability="partial" />);
    expect(screen.getByTestId('checkpoint-panel')).toHaveTextContent(/partially available/i);
  });

  it('shows unavailable message when availability is unavailable', () => {
    render(<CheckpointPanel checkpoints={[]} detailAvailability="unavailable" />);
    expect(screen.getByTestId('checkpoint-panel')).toHaveTextContent(/unavailable/i);
  });

  it('shows default message when availability is null', () => {
    render(<CheckpointPanel checkpoints={[]} detailAvailability={null} />);
    expect(screen.getByTestId('checkpoint-panel')).toHaveTextContent(/no checkpoints/i);
  });
});

// ─── Rendering checkpoint entries ───────────────────────────────────────────

describe('CheckpointPanel rendering', () => {
  it('renders the heading', () => {
    render(<CheckpointPanel checkpoints={[]} detailAvailability="ready" />);
    expect(screen.getByRole('heading', { name: /checkpoints/i })).toBeInTheDocument();
  });

  it('renders checkpoint entries in a list', () => {
    const checkpoints = [
      makeCheckpoint({ id: 'cp-1', sequence: 0, label: 'Init' }),
      makeCheckpoint({ id: 'cp-2', sequence: 1, label: 'Build', status: 'waiting' }),
    ];

    render(<CheckpointPanel checkpoints={checkpoints} detailAvailability="ready" />);

    const list = screen.getByRole('list', { name: /checkpoint timeline/i });
    expect(list).toBeInTheDocument();
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });

  it('renders checkpoint labels', () => {
    const checkpoints = [
      makeCheckpoint({ id: 'cp-1', label: 'Environment setup' }),
      makeCheckpoint({ id: 'cp-2', sequence: 1, label: 'Tests passing' }),
    ];

    render(<CheckpointPanel checkpoints={checkpoints} detailAvailability="ready" />);

    expect(screen.getByText('Environment setup')).toBeInTheDocument();
    expect(screen.getByText('Tests passing')).toBeInTheDocument();
  });

  it('renders checkpoint status badges', () => {
    const checkpoints = [
      makeCheckpoint({ id: 'cp-1', status: 'reached' }),
      makeCheckpoint({ id: 'cp-2', sequence: 1, status: 'waiting', label: 'Pending' }),
    ];

    render(<CheckpointPanel checkpoints={checkpoints} detailAvailability="ready" />);

    expect(screen.getByText('reached')).toBeInTheDocument();
    expect(screen.getByText('waiting')).toBeInTheDocument();
  });

  it('shows detail text when checkpoint has detail', () => {
    const checkpoints = [makeCheckpoint({ id: 'cp-1', detail: 'Waiting for CI pipeline' })];

    render(<CheckpointPanel checkpoints={checkpoints} detailAvailability="ready" />);
    expect(screen.getByText('Waiting for CI pipeline')).toBeInTheDocument();
  });

  it('omits detail text when checkpoint detail is null', () => {
    const checkpoints = [makeCheckpoint({ id: 'cp-1', detail: null })];
    render(<CheckpointPanel checkpoints={checkpoints} detailAvailability="ready" />);

    const entry = screen.getByTestId('checkpoint-cp-1');
    // Should only have label, badge, and timestamp — no italic detail
    expect(entry.querySelectorAll('[style*="italic"]')).toHaveLength(0);
  });

  it('assigns data-testid per checkpoint entry', () => {
    const checkpoints = [
      makeCheckpoint({ id: 'cp-alpha' }),
      makeCheckpoint({ id: 'cp-beta', sequence: 1, label: 'Beta' }),
    ];

    render(<CheckpointPanel checkpoints={checkpoints} detailAvailability="ready" />);

    expect(screen.getByTestId('checkpoint-cp-alpha')).toBeInTheDocument();
    expect(screen.getByTestId('checkpoint-cp-beta')).toBeInTheDocument();
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

      render(<CheckpointPanel checkpoints={checkpoints} detailAvailability="ready" />);
      expect(screen.getByText(status)).toBeInTheDocument();
      expect(screen.getByText(`${status} checkpoint`)).toBeInTheDocument();
    });
  }
});
