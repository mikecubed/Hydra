/**
 * Error boundary for the operations panel companion surface.
 *
 * Catches render errors thrown by any operations panel component and renders
 * a contained fallback so errors in the operations surface never propagate
 * to the chat workspace. Chat ownership is preserved regardless of operations
 * panel health. Includes a "Try again" recovery action (T013, FD-5).
 */
import { Component, type JSX, type ReactNode } from 'react';

interface Props {
  readonly children: ReactNode;
}

interface State {
  readonly hasError: boolean;
  readonly errorMessage: string | null;
}

const fallbackStyle = {
  border: '1px solid rgba(248, 113, 113, 0.25)',
  borderRadius: '0.5rem',
  background: 'rgba(248, 113, 113, 0.05)',
  padding: '0.75rem 1rem',
} as const;

const textStyle = {
  margin: 0,
  fontSize: '0.8rem',
  color: '#f87171',
  lineHeight: 1.5,
} as const;

const retryButtonStyle = {
  marginTop: '0.5rem',
  fontSize: '0.75rem',
  padding: '0.25rem 0.5rem',
  borderRadius: '0.25rem',
  border: '1px solid rgba(248, 113, 113, 0.4)',
  background: 'rgba(248, 113, 113, 0.1)',
  color: '#f87171',
  cursor: 'pointer',
} as const;

export class OperationsErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, errorMessage: null };
  }

  static getDerivedStateFromError(error: unknown): State {
    const message =
      error instanceof Error
        ? error.message
        : 'An unexpected error occurred in the operations panel.';
    return { hasError: true, errorMessage: message };
  }

  override componentDidCatch(error: unknown, info: { componentStack: string }): void {
    // Log for observability without re-throwing — chat workspace must not be affected.
    console.error(
      '[operations-panel] render error caught by boundary:',
      error,
      info.componentStack,
    );
  }

  private readonly handleRetry = (): void => {
    this.setState({ hasError: false, errorMessage: null });
  };

  override render(): JSX.Element {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          aria-live="assertive"
          data-testid="operations-panel-error-boundary"
          style={fallbackStyle}
        >
          <p style={textStyle}>
            Operations panel encountered an error and has been suspended to protect the chat
            workspace.
          </p>
          {this.state.errorMessage !== null && (
            <p style={{ ...textStyle, opacity: 0.7, marginTop: '0.25rem' }}>
              {this.state.errorMessage}
            </p>
          )}
          <button
            type="button"
            data-testid="operations-error-retry"
            style={retryButtonStyle}
            onClick={this.handleRetry}
          >
            Try again
          </button>
        </div>
      );
    }

    return <>{this.props.children}</>;
  }
}
