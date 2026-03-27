import React, { useState, useEffect, useCallback } from 'react';
import { useSessionContext } from '../context/session-context.ts';

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

export function ExpiryBanner(): React.JSX.Element | null {
  const { session, extend } = useSessionContext();
  const [dismissed, setDismissed] = useState(false);
  const [extending, setExtending] = useState(false);

  const sessionState = session?.state;

  useEffect(() => {
    if (sessionState !== 'expiring-soon') {
      setDismissed(false);
    }
  }, [sessionState]);

  const handleExtend = useCallback(async () => {
    setExtending(true);
    try {
      await extend();
    } finally {
      setExtending(false);
    }
  }, [extend]);

  if (sessionState !== 'expiring-soon' || dismissed) {
    return null;
  }

  return (
    <div role="alert" data-testid="expiry-banner" style={bannerStyle}>
      <span>Your session is about to expire.</span>
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
