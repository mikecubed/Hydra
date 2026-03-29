/**
 * T027 — ConfirmDialog dedicated browser spec.
 * (Additional confirm-dialog coverage as a separate spec file per T027 AC)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

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

  it('multiple dialogs produce unique title IDs and valid aria-labelledby', () => {
    const { container } = render(
      <>
        <ConfirmDialog
          isOpen={true}
          title="Dialog A"
          from="a1"
          to="a2"
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
          isLoading={false}
        />
        <ConfirmDialog
          isOpen={true}
          title="Dialog B"
          from="b1"
          to="b2"
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
          isLoading={false}
        />
      </>,
    );

    const dialogs = container.querySelectorAll('[role="dialog"]');
    expect(dialogs.length).toBe(2);

    const ids = [...dialogs].map((d) => {
      const labelledBy = d.getAttribute('aria-labelledby');
      expect(labelledBy).toBeTruthy();
      const heading = d.querySelector('h2');
      expect(heading).toBeTruthy();
      expect(heading!.id).toBe(labelledBy);
      return labelledBy;
    });

    // IDs must be distinct across instances
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('moves initial focus to the cancel button when opened', () => {
    render(
      <ConfirmDialog
        isOpen={true}
        title="Focus Dialog"
        from="old"
        to="new"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        isLoading={false}
      />,
    );

    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('closes on Escape key', () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        isOpen={true}
        title="Escape Dialog"
        from="old"
        to="new"
        onConfirm={vi.fn()}
        onCancel={onCancel}
        isLoading={false}
      />,
    );

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('traps tab focus within the dialog actions', async () => {
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        isOpen={true}
        title="Tab Dialog"
        from="old"
        to="new"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        isLoading={false}
      />,
    );

    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });
});
