/**
 * T027 — ConfirmDialog dedicated browser spec.
 * (Additional confirm-dialog coverage as a separate spec file per T027 AC)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ConfirmDialog } from '../components/confirm-dialog.tsx';

afterEach(() => {
  cleanup();
});

describe('ConfirmDialog (confirm-dialog.browser.spec)', () => {
  it('cancel button click does NOT call onConfirm', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        isOpen={true}
        title="Test Dialog"
        from="old-value"
        to="new-value"
        onConfirm={onConfirm}
        onCancel={onCancel}
        isLoading={false}
      />,
    );
    fireEvent.click(screen.getByText('Cancel'));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirm button click calls onConfirm exactly once', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        isOpen={true}
        title="Test Dialog"
        from="old-value"
        to="new-value"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
        isLoading={false}
      />,
    );
    fireEvent.click(screen.getByText('Confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('confirm button is disabled when isLoading={true}', () => {
    render(
      <ConfirmDialog
        isOpen={true}
        title="Test Dialog"
        from="old-value"
        to="new-value"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        isLoading={true}
      />,
    );
    const confirmBtn = screen.getByText('Applying…');
    expect(confirmBtn).toHaveAttribute('disabled');
  });

  it('from and to prop values are visible in the rendered dialog body', () => {
    render(
      <ConfirmDialog
        isOpen={true}
        title="Test Dialog"
        from="source-val"
        to="dest-val"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        isLoading={false}
      />,
    );
    expect(screen.getByText('source-val')).toBeDefined();
    expect(screen.getByText('dest-val')).toBeDefined();
  });
});
