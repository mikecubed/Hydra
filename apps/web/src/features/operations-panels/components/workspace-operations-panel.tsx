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
  selectSnapshotStatus,
} from '../model/selectors.ts';
import { createSyncController } from '../model/sync-controller.ts';
import { CheckpointPanel } from './checkpoint-panel.tsx';
import { ControlStrip } from './control-strip.tsx';
import { ExecutionPanel } from './execution-panel.tsx';
import { HealthBudgetPanel } from './health-budget-panel.tsx';
import { OperationsPanelShell } from './operations-panel-shell.tsx';
import { QueuePanel } from './queue-panel.tsx';
import { RoutingPanel } from './routing-panel.tsx';

function useOperationsPanelState() {
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

  const fetchSnapshot = useCallback(async () => {
    dispatch({ type: 'snapshot/request' });
    try {
      const snapshot = await operationsClient.getSnapshot();
      dispatch({ type: 'snapshot/success', snapshot });

      const workItemIds = snapshot.queue.map((item) => item.id);
      if (workItemIds.length > 0) {
        syncControllerRef.current?.syncControlDiscovery(workItemIds);
      }
    } catch {
      dispatch({ type: 'snapshot/failure' });
    }
  }, [operationsClient]);

  useEffect(() => {
    void fetchSnapshot();

    return () => {
      syncControllerRef.current?.dispose();
      syncControllerRef.current = null;
    };
  }, [fetchSnapshot]);

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

      void submitControl({
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
          void fetchSnapshot();
        },
      });
    },
    [fetchSnapshot, operationsClient, selectedWorkItemId],
  );

  return { state, dispatch, handleSelectItem, handleSubmitControl };
}

export function WorkspaceOperationsPanel(): JSX.Element {
  const { state, handleSelectItem, handleSubmitControl } = useOperationsPanelState();

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

  return (
    <OperationsPanelShell
      snapshotStatus={selectSnapshotStatus(state)}
      freshness={selectFreshness(state)}
      detailPanel={detailPanel}
      healthBudgetPanel={healthBudgetPanel}
      controlStripSlot={controlStripSlot}
    >
      <QueuePanel
        items={selectFilteredQueueItems(state)}
        snapshotStatus={selectSnapshotStatus(state)}
        availability={selectAvailability(state)}
        selectedWorkItemId={selectedWorkItemId}
        onSelectItem={handleSelectItem}
        hasPendingControl={(workItemId) => selectHasPendingControl(state, workItemId)}
      />
    </OperationsPanelShell>
  );
}
