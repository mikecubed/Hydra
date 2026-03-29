/**
 * MutationErrorBanner browser specs (T013).
 *
 * Covers:
 * - renders nothing when message is null
 * - renders error message with role="alert"
 * - dismiss button fires onDismiss
 * - stale-revision category shows conflict guidance (FD-8)
 * - workflow-conflict category shows conflict guidance
 * - rate-limit with retryAfterMs shows retry-after hint (FD-7)
 * - retry button rendered when onRetry provided
 * - no guidance for generic categories
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

import { MutationErrorBanner } from '../components/mutation-error-banner.tsx';

afterEach(() => {
  cleanup();
});

describe('MutationErrorBanner', () => {
  it('renders nothing when message is null', () => {
    const { container } = render(<MutationErrorBanner message={null} onDismiss={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders an alert with the error message', () => {
    render(<MutationErrorBanner message="Something failed" onDismiss={() => {}} />);
    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent('Something failed');
  });

  it('fires onDismiss when dismiss button is clicked', () => {
    const onDismiss = vi.fn();
    render(<MutationErrorBanner message="error" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByLabelText('Dismiss error'));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('shows stale-revision conflict guidance (FD-8)', () => {
    render(
      <MutationErrorBanner
        message="Revision conflict"
        onDismiss={() => {}}
        category="stale-revision"
      />,
    );
    const guidance = screen.getByTestId('mutation-error-guidance');
    expect(guidance).toHaveTextContent(/refresh to load the latest/i);
  });

  it('shows workflow-conflict guidance', () => {
    render(
      <MutationErrorBanner message="Conflict" onDismiss={() => {}} category="workflow-conflict" />,
    );
    const guidance = screen.getByTestId('mutation-error-guidance');
    expect(guidance).toHaveTextContent(/conflicting workflow/i);
  });

  it('shows rate-limit retry-after hint (FD-7)', () => {
    render(
      <MutationErrorBanner
        message="Too many requests"
        onDismiss={() => {}}
        category="rate-limit"
        retryAfterMs={5000}
      />,
    );
    const hint = screen.getByTestId('mutation-retry-hint');
    expect(hint).toHaveTextContent(/try again in 5 seconds/i);
  });

  it('formats single-second retry delay correctly', () => {
    render(
      <MutationErrorBanner
        message="Too many requests"
        onDismiss={() => {}}
        category="rate-limit"
        retryAfterMs={800}
      />,
    );
    const hint = screen.getByTestId('mutation-retry-hint');
    expect(hint).toHaveTextContent(/try again in 1 second\b/i);
  });

  it('does not show retry hint for non-rate-limit categories', () => {
    render(
      <MutationErrorBanner
        message="error"
        onDismiss={() => {}}
        category="daemon"
        retryAfterMs={5000}
      />,
    );
    expect(screen.queryByTestId('mutation-retry-hint')).toBeNull();
  });

  it('does not show guidance for generic categories', () => {
    render(<MutationErrorBanner message="error" onDismiss={() => {}} category="daemon" />);
    expect(screen.queryByTestId('mutation-error-guidance')).toBeNull();
  });

  it('renders retry button when onRetry is provided', () => {
    const onRetry = vi.fn();
    render(<MutationErrorBanner message="error" onDismiss={() => {}} onRetry={onRetry} />);
    const retryButton = screen.getByTestId('mutation-retry-button');
    expect(retryButton).toBeInTheDocument();
    fireEvent.click(retryButton);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('does not render retry button when onRetry is not provided', () => {
    render(<MutationErrorBanner message="error" onDismiss={() => {}} />);
    expect(screen.queryByTestId('mutation-retry-button')).toBeNull();
  });

  it('has data-testid on the banner container', () => {
    render(<MutationErrorBanner message="error" onDismiss={() => {}} />);
    expect(screen.getByTestId('mutation-error-banner')).toBeInTheDocument();
  });
});
