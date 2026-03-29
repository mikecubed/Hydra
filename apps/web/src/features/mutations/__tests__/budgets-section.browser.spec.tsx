/**
 * T7 — BudgetsSection browser specs: rows re-sync when model IDs change after refetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, act, fireEvent } from '@testing-library/react';

import type { SafeConfigView } from '@hydra/web-contracts';
import type { MutationsClient } from '../api/mutations-client.ts';
import { MutationsRequestError } from '../api/mutations-client.ts';
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

function makeConfigWithBudgets(
  budgets: Record<string, { daily: number; weekly: number }>,
): SafeConfigView {
  const daily: Record<string, number> = {};
  const weekly: Record<string, number> = {};
  for (const [id, values] of Object.entries(budgets)) {
    daily[id] = values.daily;
    weekly[id] = values.weekly;
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

  it('re-syncs a clean existing row when server budget values change without key changes', async () => {
    const client = makeMockClient();
    const onSuccess = vi.fn();
    const onBudgetMutated = vi.fn();
    const config1 = makeConfigWithBudgets({ 'gpt-4': { daily: 1000, weekly: 5000 } });
    const config2 = makeConfigWithBudgets({ 'gpt-4': { daily: 2000, weekly: 8000 } });

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

    const initialDaily = screen.getByLabelText('Daily limit', {
      selector: '#daily-gpt-4',
    });
    const initialWeekly = screen.getByLabelText('Weekly limit', {
      selector: '#weekly-gpt-4',
    });
    if (
      !(initialDaily instanceof HTMLInputElement) ||
      !(initialWeekly instanceof HTMLInputElement)
    ) {
      throw new TypeError('Expected gpt-4 budget controls to be input elements');
    }
    expect(initialDaily.value).toBe('1000');
    expect(initialWeekly.value).toBe('5000');

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

    const refreshedDaily = screen.getByLabelText('Daily limit', {
      selector: '#daily-gpt-4',
    });
    const refreshedWeekly = screen.getByLabelText('Weekly limit', {
      selector: '#weekly-gpt-4',
    });
    if (
      !(refreshedDaily instanceof HTMLInputElement) ||
      !(refreshedWeekly instanceof HTMLInputElement)
    ) {
      throw new TypeError('Expected refreshed gpt-4 budget controls to be input elements');
    }
    expect(refreshedDaily.value).toBe('2000');
    expect(refreshedWeekly.value).toBe('8000');
  });

  it('shows rate-limit retry guidance from the live budget row', async () => {
    const client = makeMockClient();
    client.postBudget = vi.fn().mockRejectedValue(
      new MutationsRequestError(429, {
        ok: false,
        code: 'RATE_LIMITED',
        category: 'rate-limit',
        message: 'Too many updates',
        httpStatus: 429,
        retryAfterMs: 4000,
      }),
    );

    render(
      <BudgetsSection
        config={makeConfigWithBudgets({ 'gpt-4': { daily: 1000, weekly: 5000 } })}
        revision="r1"
        client={client}
        onSuccess={vi.fn()}
        onBudgetMutated={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Apply'));
    fireEvent.click(screen.getByText('Confirm'));

    await act(async () => {});

    expect(screen.getByTestId('mutation-retry-hint')).toHaveTextContent('try again in 4 seconds');
  });
});
