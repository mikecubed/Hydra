import { useCallback, useEffect, useMemo, useReducer, useRef, type JSX } from 'react';

import { createOperationsClient } from '../api/operations-client.ts';
import {
  createRouteInitialOperationsState,
  reduceOperationsState,
} from '../model/operations-reducer.ts';
import {
  selectAvailability,
  selectBudgetStatus,
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

  // Initialize sync controller once
  syncControllerRef.current ??= createSyncController({
    client: operationsClient,
    dispatch,
  });

  useEffect(() => {
    const lifecycle = { disposed: false };

    void (async () => {
      try {
        const snapshot = await operationsClient.getSnapshot();
        if (lifecycle.disposed) {
          return;
        }

        dispatch({ type: 'snapshot/success', snapshot });
      } catch {
        if (lifecycle.disposed) {
          return;
        }

        dispatch({ type: 'snapshot/failure' });
      }
    })();

    return () => {
      lifecycle.disposed = true;
      syncControllerRef.current?.dispose();
      syncControllerRef.current = null;
    };
  }, [operationsClient]);

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

  return { state, dispatch, handleSelectItem };
}

export function WorkspaceOperationsPanel(): JSX.Element {
  const { state, handleSelectItem } = useOperationsPanelState();

  const selectedWorkItemId = selectSelectedWorkItemId(state);
  const checkpoints = selectSelectedCheckpoints(state);
  const routing = selectSelectedRouting(state);
  const assignments = selectSelectedAssignments(state);
  const council = selectSelectedCouncil(state);
  const detailAvailability = selectDetailAvailability(state);
  const detailFetchStatus = selectDetailFetchStatus(state);
  const health = selectHealthStatus(state);
  const budget = selectBudgetStatus(state);

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
