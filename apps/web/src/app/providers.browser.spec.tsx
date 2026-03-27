import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from './providers.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AppProviders', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: string | URL | Request) => {
        let url: string;
        if (typeof input === 'string') {
          url = input;
        } else if (input instanceof URL) {
          url = input.toString();
        } else {
          url = input.url;
        }
        if (url === '/session/info') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                operatorId: 'test-operator',
                state: 'active',
                expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
                lastActivityAt: new Date().toISOString(),
                createdAt: new Date().toISOString(),
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
          );
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      }),
    );
  });

  it('renders the workspace shell and workspace route layout', async () => {
    render(<AppProviders />);

    expect(await screen.findByRole('heading', { name: 'Hydra Workspace' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Conversation workspace' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Conversations' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Transcript' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Composer' })).toBeTruthy();
  });
});
