/**
 * MutationErrorBanner — dismissible inline error banner (T023).
 *
 * Renders nothing when message is null.
 */
import type { JSX } from 'react';

export interface MutationErrorBannerProps {
  message: string | null;
  onDismiss: () => void;
}

export function MutationErrorBanner({ message, onDismiss }: MutationErrorBannerProps): JSX.Element | null {
  if (message === null) return null;

  return (
    <div role="alert" aria-live="polite" style={{ color: 'red', padding: '8px', border: '1px solid red', borderRadius: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span>{message}</span>
      <button type="button" aria-label="Dismiss error" onClick={onDismiss}>✕</button>
    </div>
  );
}
