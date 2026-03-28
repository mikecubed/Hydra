/**
 * ConfirmDialog — reusable single-step confirm dialog (T024).
 *
 * Renders nothing when isOpen is false.
 * Confirm button is disabled while isLoading is true.
 */
import type { JSX } from 'react';

export interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  from: string;
  to: string;
  onConfirm: () => void;
  onCancel: () => void;
  isLoading: boolean;
}

export function ConfirmDialog({
  isOpen,
  title,
  from,
  to,
  onConfirm,
  onCancel,
  isLoading,
}: ConfirmDialogProps): JSX.Element | null {
  if (!isOpen) return null;

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
      <h2 id="confirm-dialog-title">{title}</h2>
      <p>
        Change from <strong>{from}</strong> to <strong>{to}</strong>
      </p>
      <div>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" onClick={onConfirm} disabled={isLoading}>
          {isLoading ? 'Applying…' : 'Confirm'}
        </button>
      </div>
    </div>
  );
}
