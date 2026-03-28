/**
 * T7 — BudgetsSection browser specs: rows re-sync when model IDs change after refetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, act } from '@testing-library/react';

import type { SafeConfigView } from '@hydra/web-contracts';
import type { MutationsClient } from '../api/mutations-client.ts';
import { BudgetsSection } from '../components/budgets-section.tsx';

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

function makeConfig(modelIds: string[]): SafeConfigView {
  const daily: Record<string, number> = {};
  const weekly: Record<string, number> = {};
  for (const id of modelIds) {
    daily[id] = 1000;
    weekly[id] = 5000;
  }
  return {
    routing: { mode: 'economy' },
    usage: { dailyTokenBudget: daily, weeklyTokenBudget: weekly },
  } as SafeConfigView;
}

describe('BudgetsSection — row sync', () => {
  it('adds a row when a new model ID appears after re-render', async () => {
    const client = makeMockClient();
    const onSuccess = vi.fn();
    const onBudgetMutated = vi.fn();
    const config1 = makeConfig(['gpt-4']);
    const config2 = makeConfig(['gpt-4', 'claude-opus']);

    let rerender!: ReturnType<typeof render>['rerender'];
    await act(async () => {
      ({ rerender } = render(
        <BudgetsSection
          config={config1}
          revision="r1"
          client={client}
          onSuccess={onSuccess}
          onBudgetMutated={onBudgetMutated}
        />,
      ));
    });
    expect(screen.getByLabelText(/Budget for gpt-4/i)).toBeDefined();
    expect(screen.queryByLabelText(/Budget for claude-opus/i)).toBeNull();

    await act(async () => {
      rerender(
        <BudgetsSection
          config={config2}
          revision="r2"
          client={client}
          onSuccess={onSuccess}
          onBudgetMutated={onBudgetMutated}
        />,
      );
    });
    expect(screen.getByLabelText(/Budget for gpt-4/i)).toBeDefined();
    expect(screen.getByLabelText(/Budget for claude-opus/i)).toBeDefined();
  });

  it('removes a row when a model ID disappears after re-render', async () => {
    const client = makeMockClient();
    const onSuccess = vi.fn();
    const onBudgetMutated = vi.fn();
    const config1 = makeConfig(['gpt-4', 'claude-opus']);
    const config2 = makeConfig(['gpt-4']);

    let rerender!: ReturnType<typeof render>['rerender'];
    await act(async () => {
      ({ rerender } = render(
        <BudgetsSection
          config={config1}
          revision="r1"
          client={client}
          onSuccess={onSuccess}
          onBudgetMutated={onBudgetMutated}
        />,
      ));
    });
    expect(screen.getByLabelText(/Budget for claude-opus/i)).toBeDefined();

    await act(async () => {
      rerender(
        <BudgetsSection
          config={config2}
          revision="r2"
          client={client}
          onSuccess={onSuccess}
          onBudgetMutated={onBudgetMutated}
        />,
      );
    });
    expect(screen.queryByLabelText(/Budget for claude-opus/i)).toBeNull();
  });
});
