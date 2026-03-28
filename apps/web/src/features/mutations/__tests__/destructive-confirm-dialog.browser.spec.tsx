/**
 * T032 — DestructiveConfirmDialog browser specs.
 *
 * Covers strict phrase-match gating (SEC-09 / SC-006):
 * - Submit disabled before any input
 * - Submit disabled with wrong case
 * - Submit disabled with trailing/leading space
 * - Submit enabled only on exact match
 * - Cancel at Step 2: onConfirm not called
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { DestructiveConfirmDialog } from '../components/destructive-confirm-dialog.tsx';

afterEach(() => {
  cleanup();
});

function renderAtStep2(): void {
  render(
    <DestructiveConfirmDialog
      isOpen={true}
      title="Launch evolve"
      from="idle"
      to="running"
      requiredPhrase="CONFIRM"
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
      isLoading={false}
    />,
  );
  // advance to step 2
  fireEvent.click(screen.getByText('Confirm'));
}

describe('DestructiveConfirmDialog', () => {
  it('submit button is disabled before any phrase is typed', () => {
    renderAtStep2();
    expect(screen.getByText('Submit')).toHaveAttribute('disabled');
  });

  it('submit button is disabled with wrong case: "confirm" vs "CONFIRM"', () => {
    renderAtStep2();
    fireEvent.change(screen.getByLabelText('Confirmation phrase'), {
      target: { value: 'confirm' },
    });
    expect(screen.getByText('Submit')).toHaveAttribute('disabled');
  });

  it('submit button is disabled with trailing space: "CONFIRM "', () => {
    renderAtStep2();
    fireEvent.change(screen.getByLabelText('Confirmation phrase'), {
      target: { value: 'CONFIRM ' },
    });
    expect(screen.getByText('Submit')).toHaveAttribute('disabled');
  });

  it('submit button is disabled with leading space: " CONFIRM"', () => {
    renderAtStep2();
    fireEvent.change(screen.getByLabelText('Confirmation phrase'), {
      target: { value: ' CONFIRM' },
    });
    expect(screen.getByText('Submit')).toHaveAttribute('disabled');
  });

  it('submit button is ENABLED only on exact phrase match', () => {
    renderAtStep2();
    fireEvent.change(screen.getByLabelText('Confirmation phrase'), {
      target: { value: 'CONFIRM' },
    });
    expect(screen.getByText('Submit')).not.toHaveAttribute('disabled');
  });

  it('cancel at Step 2: onConfirm is never called', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <DestructiveConfirmDialog
        isOpen={true}
        title="Launch evolve"
        from="idle"
        to="running"
        requiredPhrase="CONFIRM"
        onConfirm={onConfirm}
        onCancel={onCancel}
        isLoading={false}
      />,
    );
    fireEvent.click(screen.getByText('Confirm')); // advance to step 2
    fireEvent.click(screen.getByText('Cancel'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when isOpen=false', () => {
    const { container } = render(
      <DestructiveConfirmDialog
        isOpen={false}
        title="Launch evolve"
        from="idle"
        to="running"
        requiredPhrase="CONFIRM"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        isLoading={false}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('resets to step 1 when isOpen transitions from true to false and back', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const props = {
      title: 'Launch evolve',
      from: 'idle',
      to: 'running',
      requiredPhrase: 'CONFIRM',
      onConfirm,
      onCancel,
      isLoading: false,
    };
    const { rerender } = render(<DestructiveConfirmDialog isOpen={true} {...props} />);
    // advance to step 2
    fireEvent.click(screen.getByText('Confirm'));
    expect(screen.getByLabelText('Confirmation phrase')).toBeDefined();

    // parent closes dialog
    rerender(<DestructiveConfirmDialog isOpen={false} {...props} />);

    // parent re-opens dialog
    rerender(<DestructiveConfirmDialog isOpen={true} {...props} />);

    // should be back at step 1 (ConfirmDialog with from/to), not step 2
    expect(screen.getByText('idle')).toBeDefined();
    expect(screen.getByText('running')).toBeDefined();
    expect(screen.queryByLabelText('Confirmation phrase')).toBeNull();
  });
});
