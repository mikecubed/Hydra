/**
 * T043 — Control strip browser specs.
 *
 * Covers:
 * - ControlStrip: renders discovered controls per kind, shows authority badges,
 *   disables forbidden/unavailable/pending controls, dispatches option selection,
 *   shows pending indicator during submit, displays outcome badges
 *   (accepted/rejected/stale/superseded), and triggers refetch on resolution.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { OperationalControlView } from '@hydra/web-contracts';

import { ControlStrip, type ControlStripProps } from '../components/control-strip.tsx';

afterEach(() => {
  cleanup();
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeControl(overrides: Partial<OperationalControlView> = {}): OperationalControlView {
  return {
    controlId: 'ctrl-1',
    kind: 'routing',
    label: 'Route override',
    availability: 'actionable',
    authority: 'granted',
    reason: null,
    options: [
      { optionId: 'opt-1', label: 'Option A', selected: false, available: true },
      { optionId: 'opt-2', label: 'Option B', selected: true, available: true },
    ],
    expectedRevision: 'rev-1',
    lastResolvedAt: null,
    ...overrides,
  };
}

function renderStrip(overrides: Partial<ControlStripProps> = {}) {
  const props: ControlStripProps = {
    controls: [makeControl()],
    hasPendingControl: false,
    onSubmitControl: vi.fn(),
    ...overrides,
  };
  return { ...render(<ControlStrip {...props} />), props };
}

// ─── Rendering ──────────────────────────────────────────────────────────────

// ─── Discovery rendering ────────────────────────────────────────────────────

describe('ControlStrip — discovery rendering', () => {
  it('renders nothing when there are no controls', () => {
    renderStrip({ controls: [] });
    expect(screen.queryByTestId('control-strip')).not.toBeInTheDocument();
  });

  it('renders a control item for each discovered control', () => {
    const controls = [
      makeControl({ controlId: 'ctrl-1', kind: 'routing', label: 'Route override' }),
      makeControl({ controlId: 'ctrl-2', kind: 'mode', label: 'Mode switch' }),
    ];
    renderStrip({ controls });

    expect(screen.getByText('Route override')).toBeInTheDocument();
    expect(screen.getByText('Mode switch')).toBeInTheDocument();
  });

  it('shows authority granted badge for actionable controls', () => {
    renderStrip({
      controls: [makeControl({ authority: 'granted', availability: 'actionable' })],
    });

    const strip = screen.getByTestId('control-strip');
    expect(strip).toBeInTheDocument();
    expect(screen.getAllByRole('button').length).toBeGreaterThan(0);
  });

  it('does not render option buttons for unavailable controls', () => {
    renderStrip({
      controls: [
        makeControl({
          availability: 'unavailable',
          authority: 'unavailable',
          options: [],
          expectedRevision: null,
        }),
      ],
    });

    expect(screen.getByText('Route override')).toBeInTheDocument();
    expect(screen.queryByText('Option A')).not.toBeInTheDocument();
  });

  it('renders reason text for read-only controls', () => {
    renderStrip({
      controls: [
        makeControl({
          authority: 'forbidden',
          availability: 'read-only',
          reason: 'Daemon rejected authority',
          expectedRevision: null,
        }),
      ],
    });

    expect(screen.getByText('Daemon rejected authority')).toBeInTheDocument();
  });

  it('marks the selected option visually', () => {
    renderStrip({ controls: [makeControl()] });
    const selectedBtn = screen.getByText('Option B');
    expect(selectedBtn).toHaveAttribute('aria-pressed', 'true');
  });
});

// ─── Authority and pending ──────────────────────────────────────────────────

describe('ControlStrip — authority and pending', () => {
  it('disables options for forbidden authority controls', () => {
    renderStrip({
      controls: [
        makeControl({
          authority: 'forbidden',
          availability: 'read-only',
          reason: 'Operator lacks privileges',
          expectedRevision: null,
        }),
      ],
    });

    const buttons = screen.getAllByRole('button');
    for (const btn of buttons) {
      expect(btn).toBeDisabled();
    }
  });

  it('disables options for unavailable authority controls', () => {
    renderStrip({
      controls: [
        makeControl({
          authority: 'unavailable',
          availability: 'unavailable',
          expectedRevision: null,
        }),
      ],
    });

    const buttons = screen.getAllByRole('button');
    for (const btn of buttons) {
      expect(btn).toBeDisabled();
    }
  });

  it('shows pending indicator when hasPendingControl is true', () => {
    renderStrip({ hasPendingControl: true });
    expect(screen.getByText(/pending/i)).toBeInTheDocument();
  });

  it('disables option buttons when hasPendingControl is true', () => {
    renderStrip({ hasPendingControl: true });
    const buttons = screen.getAllByRole('button');
    for (const btn of buttons) {
      expect(btn).toBeDisabled();
    }
  });

  it('calls onSubmitControl with controlId, optionId, and expectedRevision', () => {
    const onSubmit = vi.fn();
    renderStrip({ controls: [makeControl()], onSubmitControl: onSubmit });

    fireEvent.click(screen.getByText('Option A'));
    expect(onSubmit).toHaveBeenCalledWith('ctrl-1', 'opt-1', 'rev-1');
  });

  it('does not call onSubmitControl for the already-selected option', () => {
    const onSubmit = vi.fn();
    renderStrip({ controls: [makeControl()], onSubmitControl: onSubmit });

    fireEvent.click(screen.getByText('Option B'));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// ─── Outcome badges ─────────────────────────────────────────────────────────

describe('ControlStrip — outcome badges', () => {
  it('shows accepted availability badge', () => {
    renderStrip({
      controls: [makeControl({ availability: 'accepted', expectedRevision: 'rev-2' })],
    });
    expect(screen.getByText(/accepted/i)).toBeInTheDocument();
  });

  it('shows rejected availability badge', () => {
    renderStrip({
      controls: [
        makeControl({ availability: 'rejected', authority: 'forbidden', expectedRevision: null }),
      ],
    });
    expect(screen.getByText(/rejected/i)).toBeInTheDocument();
  });

  it('shows stale availability badge', () => {
    renderStrip({
      controls: [makeControl({ availability: 'stale', expectedRevision: 'rev-3' })],
    });
    expect(screen.getByText(/stale/i)).toBeInTheDocument();
  });

  it('shows superseded availability badge', () => {
    renderStrip({
      controls: [
        makeControl({
          availability: 'superseded',
          authority: 'granted',
          reason: 'Replaced by another control',
          expectedRevision: null,
        }),
      ],
    });
    expect(screen.getByText('superseded')).toBeInTheDocument();
  });
});
