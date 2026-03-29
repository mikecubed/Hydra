import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { SafeConfigView } from '@hydra/web-contracts';
import type { MutationsClient } from '../api/mutations-client.ts';
import { MutationsRequestError } from '../api/mutations-client.ts';
import { RoutingSection } from '../components/routing-section.tsx';

afterEach(() => {
  cleanup();
});

function makeMockClient(overrides: Partial<MutationsClient> = {}): MutationsClient {
  return {
    getSafeConfig: vi.fn(),
    postRoutingMode: vi.fn().mockResolvedValue({
      snapshot: { routing: { mode: 'balanced' } },
      appliedRevision: 'rev-2',
      timestamp: '2026-03-29T00:00:00.000Z',
    }),
    postModelTier: vi.fn(),
    postBudget: vi.fn(),
    postWorkflowLaunch: vi.fn(),
    getAudit: vi.fn(),
    ...overrides,
  };
}

const config = {
  routing: { mode: 'economy' },
} as SafeConfigView;

describe('RoutingSection', () => {
  it('describes the routing selector with the current mode summary', () => {
    const client = makeMockClient();

    render(<RoutingSection config={config} revision="rev-1" client={client} onSuccess={vi.fn()} />);

    expect(screen.getByLabelText('Change routing mode')).toHaveAttribute(
      'aria-describedby',
      'routing-current-mode',
    );
  });

  it('shows stale-revision guidance from the live routing panel', async () => {
    const client = makeMockClient({
      postRoutingMode: vi.fn().mockRejectedValue(
        new MutationsRequestError(409, {
          ok: false,
          code: 'STALE_REVISION',
          category: 'stale-revision',
          message: 'Revision mismatch',
          httpStatus: 409,
        }),
      ),
    });

    render(<RoutingSection config={config} revision="rev-1" client={client} onSuccess={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Change routing mode'), {
      target: { value: 'balanced' },
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Confirm'));
    });

    expect(screen.getByTestId('mutation-error-guidance')).toHaveTextContent(
      'Refresh to load the latest version',
    );
  });
});
