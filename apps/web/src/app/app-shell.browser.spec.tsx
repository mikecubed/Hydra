import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';

/**
 * Mock TanStack Router's Outlet so AppShell renders without a full router.
 * vi.mock is hoisted — factory must be self-contained.
 */
vi.mock('@tanstack/react-router', () => ({
  Outlet: () => createElement('div', { 'data-testid': 'outlet' }, 'child route'),
}));

import { AppShell } from './app-shell.tsx';

afterEach(() => {
  cleanup();
});

describe('AppShell layout', () => {
  it('renders header, main, and outlet', () => {
    render(<AppShell />);
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByTestId('outlet')).toBeInTheDocument();
  });

  it('never renders a connection banner (banner lives in child routes)', () => {
    render(<AppShell />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders the Hydra Workspace heading', () => {
    render(<AppShell />);
    expect(screen.getByRole('heading', { name: 'Hydra Workspace' })).toBeInTheDocument();
  });
});
