import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AppProviders } from './providers.tsx';

afterEach(() => {
  cleanup();
});

describe('AppProviders', () => {
  it('renders the workspace shell and workspace route layout', async () => {
    render(<AppProviders />);

    expect(await screen.findByRole('heading', { name: 'Hydra Workspace' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Conversation workspace' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Conversations' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Transcript' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Composer' })).toBeTruthy();
  });
});
