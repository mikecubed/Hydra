import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

const mockNavigate = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: vi.fn(() => mockNavigate),
}));

const mockLogout = vi.fn();

vi.mock('../context/session-context.ts', () => ({
  useSessionContext: vi.fn(() => ({
    session: null,
    isLoading: false,
    extend: vi.fn(),
    logout: mockLogout,
    refresh: vi.fn(),
  })),
}));

import { LogoutButton } from '../components/logout-button.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mockNavigate.mockReset();
  mockLogout.mockReset();
});

describe('LogoutButton', () => {
  it('is a native <button> element', () => {
    render(<LogoutButton />);
    const btn = screen.getByTestId('logout-button');
    expect(btn.tagName).toBe('BUTTON');
  });

  it('calls logout() from context on click', async () => {
    const user = userEvent.setup();
    mockLogout.mockResolvedValue(null);

    render(<LogoutButton />);
    await user.click(screen.getByTestId('logout-button'));

    expect(mockLogout).toHaveBeenCalledTimes(1);
  });

  it('navigates to /login after logout() resolves', async () => {
    const user = userEvent.setup();
    mockLogout.mockResolvedValue(null);

    render(<LogoutButton />);
    await user.click(screen.getByTestId('logout-button'));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/login' });
    });
  });

  it('is disabled while logout() is in flight', async () => {
    const user = userEvent.setup();
    mockLogout.mockReturnValue(new Promise(() => {}));

    render(<LogoutButton />);
    await user.click(screen.getByTestId('logout-button'));

    expect(screen.getByTestId('logout-button')).toBeDisabled();
  });
});
