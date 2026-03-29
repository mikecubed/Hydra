/**
 * MutationErrorBanner — category-aware dismissible inline error banner (T023, T013).
 *
 * Renders nothing when message is null. Surfaces stale-revision conflict
 * guidance (FD-8), rate-limit retry-after hint (FD-7), and a generic
 * retry/dismiss affordance for other rejection categories (FD-4).
 */
import type { JSX } from 'react';
import type { ErrorCategory } from '../../../shared/gateway-errors.ts';

export interface MutationErrorBannerProps {
  message: string | null;
  onDismiss: () => void;
  /** Gateway error category — enables category-specific recovery guidance. */
  category?: ErrorCategory | null;
  /** Rate-limit retry-after hint in ms, when provided by the gateway. */
  retryAfterMs?: number | null;
  /** Optional retry callback — renders a "Retry" button when provided. */
  onRetry?: () => void;
}

function formatRetryDelay(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  return seconds === 1 ? '1 second' : `${String(seconds)} seconds`;
}

function categoryGuidance(category: ErrorCategory | null | undefined): string | null {
  if (category === 'stale-revision') {
    return 'Another session updated this value. Refresh to load the latest version, then retry.';
  }
  if (category === 'workflow-conflict') {
    return 'A conflicting workflow is already running. Wait for it to complete or cancel it first.';
  }
  return null;
}

export function MutationErrorBanner({
  message,
  onDismiss,
  category,
  retryAfterMs,
  onRetry,
}: MutationErrorBannerProps): JSX.Element | null {
  if (message === null) return null;

  const guidance = categoryGuidance(category);
  const retryHint =
    category === 'rate-limit' && retryAfterMs != null && retryAfterMs > 0
      ? `Rate limited — try again in ${formatRetryDelay(retryAfterMs)}.`
      : null;

  return (
    <div
      role="alert"
      aria-live="polite"
      data-testid="mutation-error-banner"
      style={{
        color: 'red',
        padding: '8px',
        border: '1px solid red',
        borderRadius: '4px',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span>{message}</span>
        <button type="button" aria-label="Dismiss error" onClick={onDismiss}>
          ✕
        </button>
      </div>
      {guidance !== null && (
        <span data-testid="mutation-error-guidance" style={{ fontSize: '0.85em', opacity: 0.85 }}>
          {guidance}
        </span>
      )}
      {retryHint !== null && (
        <span data-testid="mutation-retry-hint" style={{ fontSize: '0.85em', opacity: 0.85 }}>
          {retryHint}
        </span>
      )}
      {onRetry != null && (
        <button type="button" data-testid="mutation-retry-button" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
