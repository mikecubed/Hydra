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

function makeConfigWithActive(
  agents: Record<string, 'default' | 'fast' | 'cheap'>,
): SafeConfigView {
  const models: Record<string, { default: string; active?: string }> = {};
  for (const [agent, active] of Object.entries(agents)) {
    models[agent] = { default: `${agent}-model`, active };
  }
  return { routing: { mode: 'economy' }, models } as SafeConfigView;
}

describe('ModelsSection — row sync', () => {
  it('describes each tier selector with the current active tier', () => {
    const client = makeMockClient();

    render(
      <ModelsSection
        config={makeConfigWithActive({ claude: 'cheap' })}
        revision="r1"
        client={client}
        onSuccess={vi.fn()}
      />,
    );

    expect(
      screen.getByLabelText('Tier', {
        selector: '#tier-select-claude',
      }),
    ).toHaveAttribute('aria-describedby', 'model-tier-current-claude');
  });

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

  it('changing tier on a newly-appeared agent retains a valid selected value', async () => {
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

    // Rerender with a new agent
    await act(async () => {
      rerender(
        <ModelsSection config={config2} revision="r2" client={client} onSuccess={onSuccess} />,
      );
    });

    // The new agent row should exist
    expect(screen.getByLabelText(/Model config for gemini/i)).toBeDefined();

    // Change its tier — this exercises updateRow for an agent not in `rows` state
    const geminiSelect = screen.getByLabelText('Tier', {
      selector: '#tier-select-gemini',
    });
    if (!(geminiSelect instanceof HTMLSelectElement)) {
      throw new TypeError('Expected gemini tier control to be a select element');
    }
    await act(async () => {
      geminiSelect.value = 'fast';
      geminiSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // The select should now reflect the new value (not crash or show undefined)
    expect(geminiSelect.value).toBe('fast');
  });

  it('re-syncs a clean existing row when the server tier changes without key changes', async () => {
    const client = makeMockClient();
    const onSuccess = vi.fn();
    const config1 = makeConfigWithActive({ claude: 'default' });
    const config2 = makeConfigWithActive({ claude: 'fast' });

    let rerender!: ReturnType<typeof render>['rerender'];
    await act(async () => {
      ({ rerender } = render(
        <ModelsSection config={config1} revision="r1" client={client} onSuccess={onSuccess} />,
      ));
    });

    const initialSelect = screen.getByLabelText('Tier', {
      selector: '#tier-select-claude',
    });
    if (!(initialSelect instanceof HTMLSelectElement)) {
      throw new TypeError('Expected claude tier control to be a select element');
    }
    expect(initialSelect.value).toBe('default');

    await act(async () => {
      rerender(
        <ModelsSection config={config2} revision="r2" client={client} onSuccess={onSuccess} />,
      );
    });

    const refreshedSelect = screen.getByLabelText('Tier', {
      selector: '#tier-select-claude',
    });
    if (!(refreshedSelect instanceof HTMLSelectElement)) {
      throw new TypeError('Expected claude tier control to be a select element');
    }
    expect(refreshedSelect.value).toBe('fast');
  });
});
