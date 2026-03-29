import React, { useState, useCallback } from 'react';
import { useSessionContext } from '../context/session-context.ts';

const containerStyle: React.CSSProperties = {
  width: '100%',
  background: '#1e293b',
  color: '#f1f5f9',
  padding: '24px',
  textAlign: 'center',
  boxSizing: 'border-box',
};

const headingStyle: React.CSSProperties = {
  color: '#f87171',
  margin: '0 0 8px',
  fontSize: '1.125rem',
  fontWeight: 600,
};

const messageStyle: React.CSSProperties = {
  margin: '0 0 16px',
  fontSize: '0.875rem',
  opacity: 0.85,
};

const buttonStyle: React.CSSProperties = {
  background: '#f87171',
  color: '#1e293b',
  border: 'none',
  borderRadius: '6px',
  padding: '8px 20px',
  fontSize: '0.875rem',
  fontWeight: 600,
  cursor: 'pointer',
};

const buttonDisabledStyle: React.CSSProperties = {
  ...buttonStyle,
  opacity: 0.6,
  cursor: 'not-allowed',
};

const errorStyle: React.CSSProperties = {
  color: '#fca5a5',
  fontSize: '0.8125rem',
  margin: '0 0 12px',
};

const retryCountStyle: React.CSSProperties = {
  fontSize: '0.75rem',
  opacity: 0.6,
  margin: '8px 0 0',
};

export function DaemonUnreachable(): React.JSX.Element | null {
  const { session, refresh } = useSessionContext();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const handleRetry = useCallback(async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      await refresh();
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Could not reach the daemon. Try again shortly.';
      setRetryError(message);
      setRetryCount((c) => c + 1);
    } finally {
      setRetrying(false);
    }
  }, [refresh]);

  if (session?.state !== 'daemon-unreachable') {
    return null;
  }

  return (
    <div role="status" data-testid="daemon-unreachable" style={containerStyle}>
      <p style={headingStyle}>Hydra daemon is temporarily unavailable</p>
      <p style={messageStyle}>Your session is still active.</p>
      {retryError != null && (
        <p data-testid="daemon-retry-error" style={errorStyle}>
          {retryError}
        </p>
      )}
      <button
        data-testid="daemon-unreachable-retry"
        aria-label="Check again"
        disabled={retrying}
        onClick={() => void handleRetry()}
        style={retrying ? buttonDisabledStyle : buttonStyle}
      >
        Check again
      </button>
      {retryCount > 0 && (
        <p data-testid="daemon-retry-count" style={retryCountStyle}>
          {retryCount} failed {retryCount === 1 ? 'attempt' : 'attempts'}
        </p>
      )}
    </div>
  );
}
