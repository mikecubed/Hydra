/**
 * FD-5 — Async-error → degraded-panel path in operations panels (T016).
 *
 * Covers the integration scenario where one operations sub-panel experiences
 * an async fetch failure: the degraded banner appears, sibling panels remain
 * healthy, and the retry button initiates recovery. Also tests the error
 * boundary + degraded banner coexistence and sequential failure/recovery.
 */

import type { JSX } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

import { OperationsDegradedBanner } from '../components/operations-degraded-banner.tsx';
import { OperationsErrorBoundary } from '../components/operations-error-boundary.tsx';

afterEach(() => {
  cleanup();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function HealthyPanel({ label }: { readonly label: string }): JSX.Element {
  return <div data-testid={`panel-${label}`}>Panel {label} OK</div>;
}

function ThrowingPanel({ message }: { readonly message: string }): never {
  throw new Error(message);
}

function suppressConsoleError(): () => void {
  const original = console.error;
  console.error = () => {};
  return () => {
    console.error = original;
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('FD-5: async error → degraded panel path', () => {
  it('degraded banner appears while sibling panels remain healthy', () => {
    render(
      <div>
        <OperationsDegradedBanner message="Snapshot fetch failed for queue panel" />
        <HealthyPanel label="execution" />
        <HealthyPanel label="checkpoint" />
      </div>,
    );

    // Degraded banner is visible
    expect(screen.getByTestId('operations-degraded-banner')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Snapshot fetch failed for queue panel');

    // Sibling panels are unaffected
    expect(screen.getByTestId('panel-execution')).toHaveTextContent('Panel execution OK');
    expect(screen.getByTestId('panel-checkpoint')).toHaveTextContent('Panel checkpoint OK');
  });

  it('retry button in degraded banner triggers recovery callback', () => {
    const onRetry = vi.fn();

    render(
      <div>
        <OperationsDegradedBanner message="Detail fetch failed" onRetry={onRetry} />
        <HealthyPanel label="queue" />
      </div>,
    );

    expect(screen.getByTestId('operations-retry-button')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('operations-retry-button'));
    expect(onRetry).toHaveBeenCalledOnce();

    // Sibling still healthy after retry
    expect(screen.getByTestId('panel-queue')).toHaveTextContent('Panel queue OK');
  });

  it('error boundary catches sync render crash while sibling degraded banner is separate', () => {
    const restore = suppressConsoleError();

    render(
      <div>
        <OperationsErrorBoundary>
          <ThrowingPanel message="Execution panel crash" />
        </OperationsErrorBoundary>
        <OperationsDegradedBanner message="Queue snapshot stale" />
        <HealthyPanel label="routing" />
      </div>,
    );

    restore();

    // Error boundary caught the crash
    expect(screen.getByTestId('operations-panel-error-boundary')).toBeInTheDocument();
    expect(screen.getByTestId('operations-panel-error-boundary')).toHaveTextContent(
      'Execution panel crash',
    );

    // Degraded banner independently visible for async failure
    expect(screen.getByTestId('operations-degraded-banner')).toHaveTextContent(
      'Queue snapshot stale',
    );

    // Routing panel remains healthy
    expect(screen.getByTestId('panel-routing')).toHaveTextContent('Panel routing OK');
  });

  it('error boundary "Try again" resets while degraded banner persists independently', () => {
    const restore = suppressConsoleError();

    render(
      <div>
        <OperationsErrorBoundary>
          <ThrowingPanel message="Panel crash" />
        </OperationsErrorBoundary>
        <OperationsDegradedBanner message="Async error remains" />
      </div>,
    );

    restore();

    // Both error surfaces present
    expect(screen.getByTestId('operations-panel-error-boundary')).toBeInTheDocument();
    expect(screen.getByTestId('operations-degraded-banner')).toBeInTheDocument();

    // Click "Try again" on error boundary — child still throws so boundary re-catches
    const restoreAgain = suppressConsoleError();
    fireEvent.click(screen.getByTestId('operations-error-retry'));
    restoreAgain();

    // Error boundary still in fallback (child still throws)
    expect(screen.getByTestId('operations-panel-error-boundary')).toBeInTheDocument();

    // Degraded banner is independent and unaffected
    expect(screen.getByTestId('operations-degraded-banner')).toHaveTextContent(
      'Async error remains',
    );
  });

  it('multiple degraded banners can coexist for different sub-panels', () => {
    render(
      <div>
        <OperationsDegradedBanner message="Queue panel: snapshot timeout" />
        <OperationsDegradedBanner message="Health panel: budget fetch failed" />
        <HealthyPanel label="execution" />
      </div>,
    );

    const banners = screen.getAllByTestId('operations-degraded-banner');
    expect(banners).toHaveLength(2);
    expect(banners[0]).toHaveTextContent('Queue panel: snapshot timeout');
    expect(banners[1]).toHaveTextContent('Health panel: budget fetch failed');

    // Healthy sibling unaffected
    expect(screen.getByTestId('panel-execution')).toBeInTheDocument();
  });

  it('degraded banner with no onRetry omits retry button gracefully', () => {
    render(
      <div>
        <OperationsDegradedBanner message="Transient error — will auto-recover" />
        <HealthyPanel label="queue" />
      </div>,
    );

    expect(screen.getByTestId('operations-degraded-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('operations-retry-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('panel-queue')).toBeInTheDocument();
  });

  it('degraded banner aria attributes support screen reader announcement', () => {
    render(<OperationsDegradedBanner message="Panel degraded" />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('aria-live', 'polite');
    expect(alert).toHaveTextContent('Panel degraded');
  });
});
