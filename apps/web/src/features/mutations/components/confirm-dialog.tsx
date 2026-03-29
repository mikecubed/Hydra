/**
 * ConfirmDialog — reusable single-step confirm dialog (T024).
 *
 * Renders nothing when isOpen is false.
 * Confirm button is disabled while isLoading is true.
 * Optional children are rendered between the from/to summary and the buttons
 * (e.g., advisory warnings from BudgetsSection).
 */
import { useId } from 'react';
import type { JSX, ReactNode } from 'react';

export interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  from: string;
  to: string;
  onConfirm: () => void;
  onCancel: () => void;
  isLoading: boolean;
  children?: ReactNode;
}

export function ConfirmDialog({
  isOpen,
  title,
  from,
  to,
  onConfirm,
  onCancel,
  isLoading,
  children,
}: ConfirmDialogProps): JSX.Element | null {
  const titleId = useId();

  if (!isOpen) return null;

  return (
    <div role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <h2 id={titleId}>{title}</h2>
      <p>
        Change from <strong>{from}</strong> to <strong>{to}</strong>
      </p>
      {children}
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
