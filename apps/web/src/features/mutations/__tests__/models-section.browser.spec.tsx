/**
 * T6 — ModelsSection browser specs: rows re-sync when agents change after refetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, act } from '@testing-library/react';

import type { SafeConfigView } from '@hydra/web-contracts';
import type { MutationsClient } from '../api/mutations-client.ts';
import { ModelsSection } from '../components/models-section.tsx';

afterEach(() => {
  cleanup();
});

function makeMockClient(): MutationsClient {
  return {
    getSafeConfig: vi.fn(),
    postRoutingMode: vi.fn(),
    postModelTier: vi.fn(),
    postBudget: vi.fn(),
    postWorkflowLaunch: vi.fn(),
    getAudit: vi.fn(),
  };
}

function makeConfig(agents: string[]): SafeConfigView {
  const models: Record<string, { default: string; active?: string }> = {};
  for (const a of agents) {
    models[a] = { default: `${a}-model`, active: 'default' };
  }
  return { routing: { mode: 'economy' }, models } as SafeConfigView;
}

describe('ModelsSection — row sync', () => {
  it('adds a row when a new agent appears after re-render', async () => {
    const client = makeMockClient();
    const onSuccess = vi.fn();
    const config1 = makeConfig(['claude']);
    const config2 = makeConfig(['claude', 'gemini']);

    let rerender!: ReturnType<typeof render>['rerender'];
    await act(async () => {
      ({ rerender } = render(
        <ModelsSection config={config1} revision="r1" client={client} onSuccess={onSuccess} />,
      ));
    });
    expect(screen.getByLabelText(/Model config for claude/i)).toBeDefined();
    expect(screen.queryByLabelText(/Model config for gemini/i)).toBeNull();

    await act(async () => {
      rerender(
        <ModelsSection config={config2} revision="r2" client={client} onSuccess={onSuccess} />,
      );
    });
    expect(screen.getByLabelText(/Model config for claude/i)).toBeDefined();
    expect(screen.getByLabelText(/Model config for gemini/i)).toBeDefined();
  });

  it('removes a row when an agent disappears after re-render', async () => {
    const client = makeMockClient();
    const onSuccess = vi.fn();
    const config1 = makeConfig(['claude', 'gemini']);
    const config2 = makeConfig(['claude']);

    let rerender!: ReturnType<typeof render>['rerender'];
    await act(async () => {
      ({ rerender } = render(
        <ModelsSection config={config1} revision="r1" client={client} onSuccess={onSuccess} />,
      ));
    });
    expect(screen.getByLabelText(/Model config for gemini/i)).toBeDefined();

    await act(async () => {
      rerender(
        <ModelsSection config={config2} revision="r2" client={client} onSuccess={onSuccess} />,
      );
    });
    expect(screen.queryByLabelText(/Model config for gemini/i)).toBeNull();
  });
});
