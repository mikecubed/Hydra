import React, { useState, useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useSessionContext } from '../context/session-context.ts';

const buttonStyle: React.CSSProperties = {
  background: 'transparent',
  color: '#94a3b8',
  border: '1px solid #334155',
  borderRadius: '4px',
  padding: '4px 12px',
  fontSize: '0.8125rem',
  cursor: 'pointer',
  fontWeight: 500,
};

export function LogoutButton(): React.JSX.Element {
  const { logout } = useSessionContext();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);

  const handleClick = useCallback(async () => {
    setPending(true);
    try {
      await logout();
      await navigate({ to: '/login' });
    } finally {
      setPending(false);
    }
  }, [logout, navigate]);

  return (
    <button
      data-testid="logout-button"
      style={buttonStyle}
      disabled={pending}
      onClick={() => {
        void handleClick();
      }}
    >
      Log out
    </button>
  );
}
