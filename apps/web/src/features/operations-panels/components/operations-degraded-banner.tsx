/**
 * OperationsDegradedBanner — async-error degraded state indicator (T013, FD-5).
 *
 * Renders when snapshot or detail fetches fail asynchronously — the error
 * boundary only catches synchronous render errors, so this component covers
 * the async gap identified in the failure-drill matrix.
 */
import type { JSX } from 'react';

export interface OperationsDegradedBannerProps {
  /** Error message to display. */
  readonly message: string;
  /** Optional retry callback — renders a "Retry" button when provided. */
  readonly onRetry?: () => void;
}

const bannerStyle = {
  border: '1px solid rgba(251, 191, 36, 0.3)',
  borderRadius: '0.5rem',
  background: 'rgba(251, 191, 36, 0.08)',
  padding: '0.75rem 1rem',
  display: 'flex',
  flexDirection: 'column' as const,
  gap: '0.5rem',
};

const messageStyle = {
  margin: 0,
  fontSize: '0.8rem',
  color: '#fbbf24',
  lineHeight: 1.5,
};

const retryButtonStyle = {
  alignSelf: 'flex-start' as const,
  fontSize: '0.75rem',
  padding: '0.25rem 0.5rem',
  borderRadius: '0.25rem',
  border: '1px solid rgba(251, 191, 36, 0.4)',
  background: 'rgba(251, 191, 36, 0.1)',
  color: '#fbbf24',
  cursor: 'pointer',
};

export function OperationsDegradedBanner({
  message,
  onRetry,
}: OperationsDegradedBannerProps): JSX.Element {
  return (
    <div
      role="alert"
      aria-live="polite"
      data-testid="operations-degraded-banner"
      style={bannerStyle}
    >
      <p style={messageStyle}>{message}</p>
      {onRetry != null && (
        <button
          type="button"
          data-testid="operations-retry-button"
          style={retryButtonStyle}
          onClick={onRetry}
        >
          Retry
        </button>
      )}
    </div>
  );
}
