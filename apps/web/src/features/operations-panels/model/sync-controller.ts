/**
 * Detail-sync controller — orchestrates work-item detail fetching
 * when the browser selection changes, and control discovery hydration
 * for the visible queue.
 *
 * Pure orchestration: accepts an OperationsClient and a dispatch callback,
 * tracks the current fetch to prevent stale responses from racing, and
 * aborts in-flight HTTP requests when the selection changes before completion.
 */

import type { OperationsClient } from '../api/operations-client.ts';
import type { OperationsAction } from './operations-reducer.ts';

export interface SyncControllerOptions {
  readonly client: OperationsClient;
  readonly dispatch: (action: OperationsAction) => void;
}

export interface SyncController {
  /** Trigger detail fetch for the given work item. Aborts any in-flight fetch. */
  syncDetail(workItemId: string): void;
  /**
   * Post-control reconciliation: refetch detail only if the controlled item
   * is still the selected item. Never aborts an in-flight fetch for a
   * different item — prevents stale control responses from clobbering the
   * active detail view.
   */
  reconcileDetail(workItemId: string, currentSelectedId: string | null): void;
  /** Cancel any in-flight detail fetch (e.g. on deselect). */
  cancelSync(): void;
  /** Fetch batch control discovery for the given work item IDs. */
  syncControlDiscovery(workItemIds: readonly string[]): void;
  /** Dispose the controller — aborts in-flight and prevents future fetches. */
  dispose(): void;
}

export function createSyncController(options: SyncControllerOptions): SyncController {
  const { client, dispatch } = options;
  let currentRequestId = 0;
  let currentAbortController: AbortController | null = null;
  let discoveryRequestId = 0;
  const lifecycle = { disposed: false };

  function abortCurrent(): void {
    if (currentAbortController !== null) {
      currentAbortController.abort();
      currentAbortController = null;
    }
  }

  function syncDetail(workItemId: string): void {
    if (lifecycle.disposed) return;

    abortCurrent();
    currentRequestId += 1;
    const requestId = currentRequestId;
    const abortController = new AbortController();
    currentAbortController = abortController;

    dispatch({ type: 'selection/detail-loading' });

    void (async () => {
      try {
        const detail = await client.getWorkItemDetail(workItemId, {
          signal: abortController.signal,
        });
        if (lifecycle.disposed || requestId !== currentRequestId) return;
        dispatch({ type: 'selection/detail-loaded', detail });
      } catch (err: unknown) {
        if (lifecycle.disposed || requestId !== currentRequestId) return;
        // Aborted requests are not failures — they are expected cancellations
        if (err instanceof DOMException && err.name === 'AbortError') return;
        dispatch({ type: 'selection/detail-failed' });
      }
    })();
  }

  function syncControlDiscovery(workItemIds: readonly string[]): void {
    if (lifecycle.disposed || workItemIds.length === 0) return;

    discoveryRequestId += 1;
    const myRequestId = discoveryRequestId;

    void (async () => {
      try {
        const discovery = await client.discoverControls({ workItemIds });
        if (lifecycle.disposed || myRequestId !== discoveryRequestId) return;
        dispatch({ type: 'controls/discovery-loaded', discovery });
      } catch {
        // Discovery is best-effort — silently drop errors
      }
    })();
  }

  function cancelSync(): void {
    abortCurrent();
    currentRequestId += 1;
  }

  function reconcileDetail(workItemId: string, currentSelectedId: string | null): void {
    if (lifecycle.disposed) return;
    if (currentSelectedId !== workItemId) return;
    syncDetail(workItemId);
  }

  function dispose(): void {
    lifecycle.disposed = true;
    abortCurrent();
    currentRequestId += 1;
    discoveryRequestId += 1;
  }

  return { syncDetail, reconcileDetail, cancelSync, syncControlDiscovery, dispose };
}
