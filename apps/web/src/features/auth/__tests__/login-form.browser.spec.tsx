import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

vi.mock('../api/auth-client.ts', () => ({
  login: vi.fn(),
}));

import { login } from '../api/auth-client.ts';
import { LoginForm } from '../components/login-form.tsx';

const mockLogin = login as ReturnType<typeof vi.fn>;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('LoginForm', () => {
  it('renders identity input, secret input, and submit button', () => {
    render(<LoginForm onSuccess={() => {}} />);

    expect(screen.getByTestId('login-identity')).toBeInTheDocument();
    expect(screen.getByTestId('login-secret')).toBeInTheDocument();
    expect(screen.getByTestId('login-submit')).toBeInTheDocument();
  });

  it('submit button is disabled while loading', async () => {
    const user = userEvent.setup();
    mockLogin.mockReturnValue(new Promise(() => {}));

    render(<LoginForm onSuccess={() => {}} />);

    await user.type(screen.getByTestId('login-identity'), 'operator');
    await user.type(screen.getByTestId('login-secret'), 'pass');
    await user.click(screen.getByTestId('login-submit'));

    expect(screen.getByTestId('login-submit')).toBeDisabled();
  });

  it('calls login(identity, secret) with typed values on submit', async () => {
    const user = userEvent.setup();
    mockLogin.mockResolvedValue({ operatorId: 'op-1' });

    render(<LoginForm onSuccess={() => {}} />);

    await user.type(screen.getByTestId('login-identity'), 'admin');
    await user.type(screen.getByTestId('login-secret'), 'secret123');
    await user.click(screen.getByTestId('login-submit'));

    expect(mockLogin).toHaveBeenCalledWith('admin', 'secret123');
  });

  it('calls onSuccess(operatorId) after successful login', async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    mockLogin.mockResolvedValue({ operatorId: 'op-42' });

    render(<LoginForm onSuccess={onSuccess} />);

    await user.type(screen.getByTestId('login-identity'), 'admin');
    await user.type(screen.getByTestId('login-secret'), 'pass');
    await user.click(screen.getByTestId('login-submit'));

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledWith('op-42');
    });
  });

  it('displays "Invalid identity or password." on INVALID_CREDENTIALS', async () => {
    const user = userEvent.setup();
    mockLogin.mockRejectedValue({ code: 'INVALID_CREDENTIALS', message: 'bad creds' });

    render(<LoginForm onSuccess={() => {}} />);

    await user.type(screen.getByTestId('login-identity'), 'admin');
    await user.type(screen.getByTestId('login-secret'), 'wrong');
    await user.click(screen.getByTestId('login-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('login-error')).toHaveTextContent('Invalid identity or password.');
    });
  });

  it('displays "Too many attempts — please wait before trying again." on RATE_LIMITED', async () => {
    const user = userEvent.setup();
    mockLogin.mockRejectedValue({ code: 'RATE_LIMITED', message: 'rate limited' });

    render(<LoginForm onSuccess={() => {}} />);

    await user.type(screen.getByTestId('login-identity'), 'admin');
    await user.type(screen.getByTestId('login-secret'), 'pass');
    await user.click(screen.getByTestId('login-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('login-error')).toHaveTextContent(
        'Too many attempts — please wait before trying again.',
      );
    });
  });

  it('displays "Account is disabled" message on ACCOUNT_DISABLED', async () => {
    const user = userEvent.setup();
    mockLogin.mockRejectedValue({ code: 'ACCOUNT_DISABLED', message: 'Account is disabled' });

    render(<LoginForm onSuccess={() => {}} />);

    await user.type(screen.getByTestId('login-identity'), 'admin');
    await user.type(screen.getByTestId('login-secret'), 'pass');
    await user.click(screen.getByTestId('login-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('login-error')).toHaveTextContent(
        'Account is disabled — contact your administrator.',
      );
    });
  });

  it('falls back to "Login failed." for unknown error shapes', async () => {
    const user = userEvent.setup();
    mockLogin.mockRejectedValue(null);

    render(<LoginForm onSuccess={() => {}} />);

    await user.type(screen.getByTestId('login-identity'), 'admin');
    await user.type(screen.getByTestId('login-secret'), 'pass');
    await user.click(screen.getByTestId('login-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('login-error')).toHaveTextContent('Login failed.');
    });
  });

  it('clears error message on next submit attempt', async () => {
    const user = userEvent.setup();
    mockLogin.mockRejectedValueOnce({ code: 'INVALID_CREDENTIALS', message: 'bad' });
    mockLogin.mockResolvedValueOnce({ operatorId: 'op-1' });

    render(<LoginForm onSuccess={() => {}} />);

    await user.type(screen.getByTestId('login-identity'), 'admin');
    await user.type(screen.getByTestId('login-secret'), 'wrong');
    await user.click(screen.getByTestId('login-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('login-error')).toBeInTheDocument();
    });

    await user.clear(screen.getByTestId('login-secret'));
    await user.type(screen.getByTestId('login-secret'), 'correct');
    await user.click(screen.getByTestId('login-submit'));

    await waitFor(() => {
      expect(screen.queryByTestId('login-error')).not.toBeInTheDocument();
    });
  });
});
