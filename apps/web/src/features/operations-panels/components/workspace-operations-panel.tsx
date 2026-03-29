import { useCallback, useEffect, useMemo, useReducer, useRef, type JSX } from 'react';

import { createOperationsClient } from '../api/operations-client.ts';
import { submitControl } from '../model/control-actions.ts';
import {
  createRouteInitialOperationsState,
  reduceOperationsState,
} from '../model/operations-reducer.ts';
import {
  selectAvailability,
  selectBudgetStatus,
  selectControlsForSelectedItem,
  selectDetailAvailability,
  selectDetailFetchStatus,
  selectFilteredQueueItems,
  selectFreshness,
  selectHasPendingControl,
  selectHealthStatus,
  selectSelectedAssignments,
  selectSelectedCheckpoints,
  selectSelectedCouncil,
  selectSelectedRouting,
  selectSelectedWorkItemId,
  selectSnapshotErrorMessage,
  selectSnapshotStatus,
} from '../model/selectors.ts';
import { createSyncController } from '../model/sync-controller.ts';
import { CheckpointPanel } from './checkpoint-panel.tsx';
import { ControlStrip } from './control-strip.tsx';
import { ExecutionPanel } from './execution-panel.tsx';
import { HealthBudgetPanel } from './health-budget-panel.tsx';
import { OperationsDegradedBanner } from './operations-degraded-banner.tsx';
import { OperationsPanelShell } from './operations-panel-shell.tsx';
import { QueuePanel } from './queue-panel.tsx';
import { RoutingPanel } from './routing-panel.tsx';

interface UseOperationsPanelStateOptions {
  readonly refreshNonce?: number;
}

function useOperationsPanelState(options: UseOperationsPanelStateOptions = {}) {
  const { refreshNonce = 0 } = options;
  const operationsClient = useMemo(() => createOperationsClient({ baseUrl: '' }), []);
  const [state, dispatch] = useReducer(
    reduceOperationsState,
    undefined,
    createRouteInitialOperationsState,
  );

  const syncControllerRef = useRef<ReturnType<typeof createSyncController> | null>(null);

  // Track current selection via ref so async control callbacks read
  // the live value rather than a stale closure capture.
  const selectedWorkItemIdRef = useRef<string | null>(null);
  selectedWorkItemIdRef.current = state.selection.selectedWorkItemId;

  // Initialize sync controller once
  syncControllerRef.current ??= createSyncController({
    client: operationsClient,
    dispatch,
  });

  useEffect(() => {
    syncControllerRef.current?.fetchSnapshot();

    return () => {
      syncControllerRef.current?.dispose();
      syncControllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (refreshNonce > 0) {
      syncControllerRef.current?.fetchSnapshot();
    }
  }, [refreshNonce]);

  const selectedWorkItemId = state.selection.selectedWorkItemId;
  const selectedDetail = state.selection.detail;
  const detailFetchStatus = state.selection.detailFetchStatus;
  const handleSelectItem = useCallback(
    (workItemId: string) => {
      if (workItemId === selectedWorkItemId) {
        if (selectedDetail === null && detailFetchStatus !== 'loading') {
          syncControllerRef.current?.syncDetail(workItemId);
        }
        return;
      }

      dispatch({ type: 'selection/select', workItemId });
      syncControllerRef.current?.syncDetail(workItemId);
    },
    [detailFetchStatus, selectedDetail, selectedWorkItemId],
  );

  const handleSubmitControl = useCallback(
    (controlId: string, optionId: string, expectedRevision: string) => {
      if (selectedWorkItemId === null) return;

      submitControl({
        client: operationsClient,
        dispatch,
        workItemId: selectedWorkItemId,
        controlId,
        requestedOptionId: optionId,
        expectedRevision,
        onRefetchDetail: (id) => {
          syncControllerRef.current?.reconcileDetail(id, selectedWorkItemIdRef.current);
        },
        onRefetchSnapshot: () => {
          syncControllerRef.current?.fetchSnapshot();
        },
      }).catch((err: unknown) => {
        // State is already reconciled (controls/submit-resolved dispatched)
        // inside submitControl before it rethrows — report without re-throwing.
        console.error('[operations] control submission failed:', err);
      });
    },
    [operationsClient, selectedWorkItemId],
  );

  const handleRetrySnapshot = useCallback(() => {
    syncControllerRef.current?.fetchSnapshot();
  }, []);

  return { state, dispatch, handleSelectItem, handleSubmitControl, handleRetrySnapshot };
}

export interface WorkspaceOperationsPanelProps {
  readonly refreshNonce?: number;
}

export function WorkspaceOperationsPanel({
  refreshNonce = 0,
}: WorkspaceOperationsPanelProps): JSX.Element {
  const { state, handleSelectItem, handleSubmitControl, handleRetrySnapshot } =
    useOperationsPanelState({
      refreshNonce,
    });

  const snapshotStatus = selectSnapshotStatus(state);
  const snapshotErrorMessage = selectSnapshotErrorMessage(state);
  const selectedWorkItemId = selectSelectedWorkItemId(state);
  const checkpoints = selectSelectedCheckpoints(state);
  const routing = selectSelectedRouting(state);
  const assignments = selectSelectedAssignments(state);
  const council = selectSelectedCouncil(state);
  const detailAvailability = selectDetailAvailability(state);
  const detailFetchStatus = selectDetailFetchStatus(state);
  const health = selectHealthStatus(state);
  const budget = selectBudgetStatus(state);
  const controls = selectControlsForSelectedItem(state);
  const hasPendingControl =
    selectedWorkItemId !== null && selectHasPendingControl(state, selectedWorkItemId);

  // Stable callback: identity changes only when the pendingByWorkItem Map changes,
  // not on every render.
  const pendingByWorkItem = state.controls.pendingByWorkItem;
  const hasPendingControlForItem = useCallback(
    (workItemId: string) => pendingByWorkItem.has(workItemId),
    [pendingByWorkItem],
  );

  const controlStripSlot =
    selectedWorkItemId === null || controls.length === 0 ? undefined : (
      <ControlStrip
        controls={controls}
        hasPendingControl={hasPendingControl}
        onSubmitControl={handleSubmitControl}
      />
    );

  const detailPanel =
    selectedWorkItemId === null ? undefined : (
      <>
        <RoutingPanel
          routing={routing}
          detailAvailability={detailAvailability}
          detailFetchStatus={detailFetchStatus}
        />
        <ExecutionPanel
          assignments={assignments}
          council={council}
          detailAvailability={detailAvailability}
          detailFetchStatus={detailFetchStatus}
        />
        <CheckpointPanel
          checkpoints={checkpoints}
          detailAvailability={detailAvailability}
          detailFetchStatus={detailFetchStatus}
        />
      </>
    );

  const healthBudgetPanel =
    health == null && budget == null ? undefined : (
      <HealthBudgetPanel health={health} budget={budget} />
    );

  const degradedBanner =
    snapshotStatus === 'error' && snapshotErrorMessage !== null ? (
      <OperationsDegradedBanner message={snapshotErrorMessage} onRetry={handleRetrySnapshot} />
    ) : undefined;

  return (
    <OperationsPanelShell
      snapshotStatus={snapshotStatus}
      freshness={selectFreshness(state)}
      detailPanel={detailPanel}
      healthBudgetPanel={healthBudgetPanel}
      controlStripSlot={controlStripSlot}
    >
      {degradedBanner}
      <QueuePanel
        items={selectFilteredQueueItems(state)}
        snapshotStatus={selectSnapshotStatus(state)}
        availability={selectAvailability(state)}
        selectedWorkItemId={selectedWorkItemId}
        onSelectItem={handleSelectItem}
        hasPendingControl={hasPendingControlForItem}
      />
    </OperationsPanelShell>
  );
}
