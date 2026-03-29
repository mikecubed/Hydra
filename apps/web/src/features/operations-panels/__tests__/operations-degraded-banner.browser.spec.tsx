/**
 * OperationsDegradedBanner browser specs (T013, FD-5).
 *
 * Covers:
 * - renders the error message with role="alert"
 * - has data-testid sentinel
 * - retry button rendered when onRetry provided
 * - retry button fires callback
 * - no retry button when onRetry not provided
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

import { OperationsDegradedBanner } from '../components/operations-degraded-banner.tsx';

afterEach(() => {
  cleanup();
});

describe('OperationsDegradedBanner', () => {
  it('renders the error message in an alert region', () => {
    render(<OperationsDegradedBanner message="Snapshot fetch failed" />);
    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent('Snapshot fetch failed');
  });

  it('has aria-live="polite"', () => {
    render(<OperationsDegradedBanner message="error" />);
    expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'polite');
  });

  it('has the data-testid sentinel', () => {
    render(<OperationsDegradedBanner message="error" />);
    expect(screen.getByTestId('operations-degraded-banner')).toBeInTheDocument();
  });

  it('renders retry button when onRetry is provided', () => {
    const onRetry = vi.fn();
    render(<OperationsDegradedBanner message="error" onRetry={onRetry} />);
    const button = screen.getByTestId('operations-retry-button');
    expect(button).toBeInTheDocument();
    expect(button).toHaveTextContent('Retry');
  });

  it('fires onRetry when retry button is clicked', () => {
    const onRetry = vi.fn();
    render(<OperationsDegradedBanner message="error" onRetry={onRetry} />);
    fireEvent.click(screen.getByTestId('operations-retry-button'));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('does not render retry button when onRetry is not provided', () => {
    render(<OperationsDegradedBanner message="error" />);
    expect(screen.queryByTestId('operations-retry-button')).toBeNull();
  });
});
