import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSessionContext } from '../context/session-context.ts';

/** Timeout (ms) for the extend/reauth call before showing a timeout error. */
const EXTEND_TIMEOUT_MS = 10_000;

const bannerStyle: React.CSSProperties = {
  background: '#78350f',
  color: '#fef3c7',
  border: '1px solid #d97706',
  padding: '12px 16px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
  borderRadius: '6px',
};

const extendButtonStyle: React.CSSProperties = {
  background: '#d97706',
  color: '#fff',
  border: 'none',
  padding: '6px 14px',
  borderRadius: '4px',
  cursor: 'pointer',
  fontWeight: 600,
};

const dismissButtonStyle: React.CSSProperties = {
  background: 'transparent',
  color: '#fef3c7',
  border: 'none',
  cursor: 'pointer',
  fontSize: '18px',
  lineHeight: 1,
  padding: '4px 8px',
};

const errorStyle: React.CSSProperties = {
  color: '#fca5a5',
  fontSize: '0.8125rem',
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('Session extension timed out. Please try again.'));
      }, ms);
    }),
  ]);
}

export function ExpiryBanner(): React.JSX.Element | null {
  const { session, extend } = useSessionContext();
  const [dismissed, setDismissed] = useState(false);
  const [extending, setExtending] = useState(false);
  const [extendError, setExtendError] = useState<string | null>(null);
  const activeExtendRef = useRef<AbortController | null>(null);

  const sessionState = session?.state;

  // Cancel stale extend attempt and reset UI when banner stops being relevant.
  useEffect(() => {
    if (sessionState !== 'expiring-soon') {
      setDismissed(false);
      setExtendError(null);
      setExtending(false);
      activeExtendRef.current?.abort();
      activeExtendRef.current = null;
    }
  }, [sessionState]);

  // Cancel on unmount so a pending timeout cannot write state after teardown.
  useEffect(
    () => () => {
      activeExtendRef.current?.abort();
      activeExtendRef.current = null;
    },
    [],
  );

  const handleExtend = useCallback(async () => {
    activeExtendRef.current?.abort();
    const controller = new AbortController();
    activeExtendRef.current = controller;

    setExtending(true);
    setExtendError(null);
    try {
      await withTimeout(extend(), EXTEND_TIMEOUT_MS);
    } catch (err: unknown) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : 'Failed to extend session';
      setExtendError(message);
    } finally {
      if (!controller.signal.aborted) {
        setExtending(false);
      }
    }
  }, [extend]);

  if (sessionState !== 'expiring-soon' || dismissed) {
    return null;
  }

  return (
    <div role="alert" data-testid="expiry-banner" style={bannerStyle}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <span>Your session is about to expire.</span>
        {extendError != null && (
          <span data-testid="extend-error" style={errorStyle}>
            {extendError}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <button
          data-testid="extend-session-button"
          aria-label="Extend Session"
          style={extendButtonStyle}
          disabled={extending}
          onClick={() => {
            void handleExtend();
          }}
        >
          Extend Session
        </button>
        <button
          data-testid="expiry-banner-dismiss"
          aria-label="Dismiss"
          style={dismissButtonStyle}
          onClick={() => {
            setDismissed(true);
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}
