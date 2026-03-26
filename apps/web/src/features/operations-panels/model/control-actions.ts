/**
 * Control actions — orchestrates control submission lifecycle.
 *
 * Manages the pending → resolved flow for control actions: dispatches
 * a pending marker before the HTTP request, submits through the gateway,
 * resolves the pending state regardless of outcome, and triggers an
 * authoritative refetch so the browser never presents false-success state.
 */
import type { SubmitControlActionResponse } from '@hydra/web-contracts';

import type { OperationsClient } from '../api/operations-client.ts';
import type { OperationsAction } from './operations-reducer.ts';

export interface SubmitControlOptions {
  readonly client: OperationsClient;
  readonly dispatch: (action: OperationsAction) => void;
  readonly workItemId: string;
  readonly controlId: string;
  readonly requestedOptionId: string;
  readonly expectedRevision: string;
  readonly onRefetchDetail?: (workItemId: string) => void;
}

function generateRequestId(): string {
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Submit a control action with full pending/resolved lifecycle.
 *
 * 1. Dispatches `controls/submit-pending` synchronously.
 * 2. Calls `client.submitControlAction`.
 * 3. Always dispatches `controls/submit-resolved` (even on error).
 * 4. On a successful gateway response, calls `onRefetchDetail` so the
 *    browser reconciles with authoritative daemon state.
 * 5. On HTTP error, rethrows after cleaning up pending state.
 */
export async function submitControl(
  options: SubmitControlOptions,
): Promise<SubmitControlActionResponse> {
  const {
    client,
    dispatch,
    workItemId,
    controlId,
    requestedOptionId,
    expectedRevision,
    onRefetchDetail,
  } = options;

  const requestId = generateRequestId();

  dispatch({
    type: 'controls/submit-pending',
    pending: {
      requestId,
      workItemId,
      controlId,
      submittedAt: new Date().toISOString(),
      requestedOptionId,
    },
  });

  let response: SubmitControlActionResponse;
  try {
    response = await client.submitControlAction(workItemId, controlId, {
      requestedOptionId,
      expectedRevision,
    });
  } catch (err: unknown) {
    dispatch({ type: 'controls/submit-resolved', workItemId });
    throw err;
  }

  dispatch({ type: 'controls/submit-resolved', workItemId });

  // Trigger authoritative refetch for all outcomes so the browser
  // never shows stale optimistic state.
  onRefetchDetail?.(workItemId);

  return response;
}
