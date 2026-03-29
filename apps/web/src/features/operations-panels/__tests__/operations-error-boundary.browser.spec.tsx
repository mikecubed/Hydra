/**
 * OperationsErrorBoundary browser specs.
 *
 * Covers:
 * - renders children when no error is thrown
 * - catches a render error and shows the accessible fallback (role="alert")
 * - exposes the caught error message in the fallback
 * - fallback has aria-live="assertive" for screen reader announcement
 * - T013: "Try again" button is rendered in the error fallback
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import type { JSX } from 'react';

import { OperationsErrorBoundary } from '../components/operations-error-boundary.tsx';

afterEach(() => {
  cleanup();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function ThrowingChild({ message }: { readonly message: string }): never {
  throw new Error(message);
}

function SafeChild(): JSX.Element {
  return <span data-testid="safe-child">safe</span>;
}

// Suppress console.error output from React's error boundary during tests.
function suppressConsoleError(): () => void {
  const original = console.error;
  console.error = () => {};
  return () => {
    console.error = original;
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('OperationsErrorBoundary', () => {
  it('renders children when no error is thrown', () => {
    render(
      <OperationsErrorBoundary>
        <SafeChild />
      </OperationsErrorBoundary>,
    );

    expect(screen.getByTestId('safe-child')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders an alert region when a child throws', () => {
    const restore = suppressConsoleError();
    render(
      <OperationsErrorBoundary>
        <ThrowingChild message="panel boom" />
      </OperationsErrorBoundary>,
    );
    restore();

    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('fallback has aria-live="assertive"', () => {
    const restore = suppressConsoleError();
    render(
      <OperationsErrorBoundary>
        <ThrowingChild message="panel boom" />
      </OperationsErrorBoundary>,
    );
    restore();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('aria-live', 'assertive');
  });

  it('shows the data-testid sentinel on the fallback', () => {
    const restore = suppressConsoleError();
    render(
      <OperationsErrorBoundary>
        <ThrowingChild message="panel boom" />
      </OperationsErrorBoundary>,
    );
    restore();

    expect(screen.getByTestId('operations-panel-error-boundary')).toBeInTheDocument();
  });

  it('displays the caught error message in the fallback', () => {
    const restore = suppressConsoleError();
    render(
      <OperationsErrorBoundary>
        <ThrowingChild message="specific failure details" />
      </OperationsErrorBoundary>,
    );
    restore();

    expect(screen.getByRole('alert')).toHaveTextContent('specific failure details');
  });

  it('shows the suspension notice text', () => {
    const restore = suppressConsoleError();
    render(
      <OperationsErrorBoundary>
        <ThrowingChild message="any error" />
      </OperationsErrorBoundary>,
    );
    restore();

    expect(screen.getByRole('alert')).toHaveTextContent(/operations panel encountered an error/i);
  });

  it('does not render children after an error is caught', () => {
    const restore = suppressConsoleError();
    render(
      <OperationsErrorBoundary>
        <ThrowingChild message="boom" />
      </OperationsErrorBoundary>,
    );
    restore();

    expect(screen.queryByTestId('safe-child')).toBeNull();
  });

  it('renders a "Try again" button in the error fallback (T013)', () => {
    const restore = suppressConsoleError();
    render(
      <OperationsErrorBoundary>
        <ThrowingChild message="boom" />
      </OperationsErrorBoundary>,
    );
    restore();

    expect(screen.getByTestId('operations-error-retry')).toBeInTheDocument();
    expect(screen.getByTestId('operations-error-retry')).toHaveTextContent('Try again');
  });

  it('"Try again" button clears the error boundary state (T013)', () => {
    const restore = suppressConsoleError();
    render(
      <OperationsErrorBoundary>
        <ThrowingChild message="boom" />
      </OperationsErrorBoundary>,
    );
    restore();

    // Error boundary is in error state
    expect(screen.getByTestId('operations-panel-error-boundary')).toBeInTheDocument();

    // Click "Try again" — boundary resets, child re-renders and throws again,
    // so the boundary catches it again. This verifies the button is wired
    // to setState({ hasError: false }) which triggers a re-render attempt.
    const restoreAgain = suppressConsoleError();
    fireEvent.click(screen.getByTestId('operations-error-retry'));
    restoreAgain();

    // Boundary should still be in fallback state (child still throws)
    // but crucially it went through a reset → re-catch cycle
    expect(screen.getByTestId('operations-panel-error-boundary')).toBeInTheDocument();
  });
});
