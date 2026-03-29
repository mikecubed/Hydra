/**
 * ConfirmDialog — reusable single-step confirm dialog (T024).
 *
 * Renders nothing when isOpen is false.
 * Confirm button is disabled while isLoading is true.
 * Optional children are rendered between the from/to summary and the buttons
 * (e.g., advisory warnings from BudgetsSection).
 */
import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
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
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      previousFocusRef.current = null;
      return;
    }

    previousFocusRef.current =
      globalThis.document.activeElement instanceof HTMLElement
        ? globalThis.document.activeElement
        : null;
    cancelButtonRef.current?.focus();

    return () => {
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
      return;
    }

    if (event.key !== 'Tab') return;
    const focusable = [cancelButtonRef.current, confirmButtonRef.current].filter(
      (element): element is HTMLButtonElement => element !== null && !element.disabled,
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable.at(-1) ?? first;
    if (!event.shiftKey && globalThis.document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && globalThis.document.activeElement === first) {
      event.preventDefault();
      last.focus();
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={handleKeyDown}>
      <h2 id={titleId}>{title}</h2>
      <p>
        Change from <strong>{from}</strong> to <strong>{to}</strong>
      </p>
      {children}
      <div>
        <button ref={cancelButtonRef} type="button" onClick={onCancel}>
          Cancel
        </button>
        <button ref={confirmButtonRef} type="button" onClick={onConfirm} disabled={isLoading}>
          {isLoading ? 'Applying…' : 'Confirm'}
        </button>
      </div>
    </div>
  );
}
