import type { JSX } from 'react';
import { useEffect, type CSSProperties } from 'react';
import { useNavigate, useLocation } from '@tanstack/react-router';
import { LoginForm } from '../features/auth/components/login-form.tsx';
import { getSessionInfo } from '../features/auth/api/auth-client.ts';
import { TERMINAL_STATES } from '@hydra/web-contracts';

const containerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: '100vh',
  background: '#0f172a',
};

export function LoginRoute(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const rawRedirect = params.get('redirectTo');
  const redirectTo = isSameOriginPath(rawRedirect) ? rawRedirect : '/workspace';

  useEffect(() => {
    void getSessionInfo()
      .then((session) => {
        if (session !== null && !TERMINAL_STATES.includes(session.state)) {
          void navigate({ to: redirectTo, replace: true });
        }
      })
      .catch((err: unknown) => {
        // Network error — stay on the login page.
        console.error('Failed to check session on login route', err);
      });
  }, [navigate, redirectTo]);

  function handleSuccess(_operatorId: string): void {
    void navigate({ to: redirectTo, replace: true });
  }

  return (
    <div style={containerStyle}>
      <LoginForm onSuccess={handleSuccess} />
    </div>
  );
}

/** Guard against open-redirect: only allow same-origin relative paths. */
function isSameOriginPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//');
}
