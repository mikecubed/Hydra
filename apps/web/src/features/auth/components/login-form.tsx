import { type CSSProperties, type JSX, useState } from 'react';
import type { SyntheticEvent } from 'react';
import { login } from '../api/auth-client.ts';

interface LoginFormProps {
  onSuccess: (operatorId: string) => void;
}

interface AuthErrorShape {
  code: string;
  message: string;
}

function isAuthError(err: unknown): err is AuthErrorShape {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as Record<string, unknown>)['code'] === 'string' &&
    typeof (err as Record<string, unknown>)['message'] === 'string'
  );
}

const ERROR_MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: 'Invalid identity or password.',
  ACCOUNT_DISABLED: 'Account is disabled — contact your administrator.',
  RATE_LIMITED: 'Too many attempts — please wait before trying again.',
};

const styles = {
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    padding: '2rem',
    background: 'rgba(15, 23, 42, 0.85)',
    borderRadius: '0.5rem',
    maxWidth: '24rem',
    width: '100%',
  } satisfies CSSProperties,

  input: {
    padding: '0.625rem 0.75rem',
    background: 'rgba(30, 41, 59, 0.8)',
    border: '1px solid rgba(148, 163, 184, 0.2)',
    borderRadius: '0.375rem',
    color: '#e2e8f0',
    fontSize: '0.875rem',
    outline: 'none',
  } satisfies CSSProperties,

  button: {
    padding: '0.625rem 1rem',
    background: '#3b82f6',
    color: '#ffffff',
    border: 'none',
    borderRadius: '0.375rem',
    fontSize: '0.875rem',
    fontWeight: 600,
    cursor: 'pointer',
  } satisfies CSSProperties,

  buttonDisabled: {
    background: 'rgba(59, 130, 246, 0.4)',
    cursor: 'not-allowed',
  } satisfies CSSProperties,

  error: {
    color: '#f87171',
    fontSize: '0.8125rem',
  } satisfies CSSProperties,
};

export function LoginForm({ onSuccess }: LoginFormProps): JSX.Element {
  const [identity, setIdentity] = useState('');
  const [secret, setSecret] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: SyntheticEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await login(identity, secret);
      onSuccess(result.operatorId);
    } catch (err: unknown) {
      const code = isAuthError(err) ? err.code : undefined;
      const mappedMessage = code === undefined ? undefined : ERROR_MESSAGES[code];
      const message = mappedMessage ?? (isAuthError(err) ? err.message : 'Login failed.');
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form data-testid="login-form" onSubmit={handleSubmit} style={styles.form}>
      <input
        data-testid="login-identity"
        type="text"
        placeholder="Identity"
        value={identity}
        onChange={(e) => {
          setIdentity(e.target.value);
        }}
        style={styles.input}
        autoComplete="username"
      />
      <input
        data-testid="login-secret"
        type="password"
        placeholder="Secret"
        value={secret}
        onChange={(e) => {
          setSecret(e.target.value);
        }}
        style={styles.input}
        autoComplete="current-password"
      />
      <button
        data-testid="login-submit"
        type="submit"
        disabled={loading}
        style={{ ...styles.button, ...(loading ? styles.buttonDisabled : {}) }}
      >
        {loading ? 'Signing in…' : 'Sign in'}
      </button>
      {error !== null && (
        <div data-testid="login-error" style={styles.error}>
          {error}
        </div>
      )}
    </form>
  );
}
