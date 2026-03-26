/**
 * Detail-sync controller — orchestrates work-item detail fetching
 * when the browser selection changes.
 *
 * Pure orchestration: accepts an OperationsClient and a dispatch callback,
 * tracks the current fetch to prevent stale responses from racing, and
 * cancels in-flight fetches when the selection changes before completion.
 */

import type { OperationsClient } from '../api/operations-client.ts';
import type { OperationsAction } from './operations-reducer.ts';

export interface SyncControllerOptions {
  readonly client: OperationsClient;
  readonly dispatch: (action: OperationsAction) => void;
}

export interface SyncController {
  /** Trigger detail fetch for the given work item. Cancels any in-flight fetch. */
  syncDetail(workItemId: string): void;
  /** Cancel any in-flight detail fetch (e.g. on deselect). */
  cancelSync(): void;
  /** Dispose the controller — cancels in-flight and prevents future fetches. */
  dispose(): void;
}

export function createSyncController(options: SyncControllerOptions): SyncController {
  const { client, dispatch } = options;
  let currentRequestId = 0;
  const lifecycle = { disposed: false };

  function syncDetail(workItemId: string): void {
    if (lifecycle.disposed) return;

    currentRequestId += 1;
    const requestId = currentRequestId;

    void (async () => {
      try {
        const detail = await client.getWorkItemDetail(workItemId);
        if (lifecycle.disposed || requestId !== currentRequestId) return;
        dispatch({ type: 'selection/detail-loaded', detail });
      } catch {
        // Detail fetch failure is non-fatal — the selection remains,
        // the UI shows the item without detail until next attempt.
        // A future phase may add a detail-error action.
      }
    })();
  }

  function cancelSync(): void {
    currentRequestId += 1;
  }

  function dispose(): void {
    lifecycle.disposed = true;
    currentRequestId += 1;
  }

  return { syncDetail, cancelSync, dispose };
}
