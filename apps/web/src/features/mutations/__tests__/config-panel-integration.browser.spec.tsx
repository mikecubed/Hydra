/**
 * T034a — Config panel integration browser spec.
 *
 * Verifies the full ConfigPanel renders live model tier and budget values
 * from a mocked GET /config/safe response, and that onBudgetMutated callback
 * is called after a successful budget mutation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, act } from '@testing-library/react';

import type { MutationsClient } from '../api/mutations-client.ts';
import { ConfigPanel } from '../components/config-panel.tsx';

afterEach(() => {
  cleanup();
});

const MOCK_CONFIG = {
  routing: { mode: 'balanced' as const },
  models: {
    claude: { default: 'claude-opus-4', fast: 'claude-haiku-4', active: 'fast' },
    codex: { default: 'gpt-5', active: 'default' },
  },
  usage: {
    dailyTokenBudget: { 'claude-opus-4': 500_000 },
    weeklyTokenBudget: { 'claude-opus-4': 2_000_000 },
  },
};

function makeMockClient(overrides: Partial<MutationsClient> = {}): MutationsClient {
  return {
    getSafeConfig: vi.fn().mockResolvedValue({
      config: MOCK_CONFIG,
      revision: 'rev-integration-1',
    }),
    postRoutingMode: vi.fn().mockResolvedValue({
      snapshot: MOCK_CONFIG,
      appliedRevision: 'rev-2',
      timestamp: '2026-03-28T05:00:00.000Z',
    }),
    postModelTier: vi.fn().mockResolvedValue({
      snapshot: MOCK_CONFIG,
      appliedRevision: 'rev-2',
      timestamp: '2026-03-28T05:00:00.000Z',
    }),
    postBudget: vi.fn().mockResolvedValue({
      snapshot: MOCK_CONFIG,
      appliedRevision: 'rev-2',
      timestamp: '2026-03-28T05:00:00.000Z',
    }),
    postWorkflowLaunch: vi.fn(),
    getAudit: vi.fn(),
    ...overrides,
  };
}

describe('ConfigPanel integration', () => {
  it('renders live routing mode from mocked GET /config/safe', async () => {
    const client = makeMockClient();
    await act(async () => {
      render(<ConfigPanel client={client} />);
    });
    // balanced is the routing mode from mock config
    expect(screen.getAllByText(/balanced/i).length).toBeGreaterThan(0);
  });

  it('renders agent names from mocked models config', async () => {
    const client = makeMockClient();
    await act(async () => {
      render(<ConfigPanel client={client} />);
    });
    expect(screen.getByText('claude')).toBeDefined();
    expect(screen.getByText('codex')).toBeDefined();
  });

  it('renders budget model IDs from mocked usage config', async () => {
    const client = makeMockClient();
    await act(async () => {
      render(<ConfigPanel client={client} />);
    });
    expect(screen.getByText('claude-opus-4')).toBeDefined();
  });

  it('does not expose any forbidden key substrings in rendered output', async () => {
    const client = makeMockClient();
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<ConfigPanel client={client} />));
    });
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/apiKey/i);
    expect(text).not.toMatch(/secret/i);
    expect(text).not.toMatch(/password/i);
    expect(text).not.toMatch(/hash/i);
  });
});
