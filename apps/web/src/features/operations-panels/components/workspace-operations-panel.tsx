import { useCallback, useEffect, useMemo, useReducer, useRef, type JSX } from 'react';

import { createOperationsClient } from '../api/operations-client.ts';
import {
  createRouteInitialOperationsState,
  reduceOperationsState,
} from '../model/operations-reducer.ts';
import {
  selectAvailability,
  selectDetailAvailability,
  selectFilteredQueueItems,
  selectFreshness,
  selectHasPendingControl,
  selectSelectedCheckpoints,
  selectSelectedWorkItemId,
  selectSnapshotStatus,
} from '../model/selectors.ts';
import { createSyncController } from '../model/sync-controller.ts';
import { CheckpointPanel } from './checkpoint-panel.tsx';
import { OperationsPanelShell } from './operations-panel-shell.tsx';
import { QueuePanel } from './queue-panel.tsx';

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

  const handleSelectItem = useCallback((workItemId: string) => {
    dispatch({ type: 'selection/select', workItemId });
    syncControllerRef.current?.syncDetail(workItemId);
  }, []);

  return { state, dispatch, handleSelectItem };
}

export function WorkspaceOperationsPanel(): JSX.Element {
  const { state, handleSelectItem } = useOperationsPanelState();

  const selectedWorkItemId = selectSelectedWorkItemId(state);
  const checkpoints = selectSelectedCheckpoints(state);
  const detailAvailability = selectDetailAvailability(state);

  const detailPanel =
    selectedWorkItemId === null ? undefined : (
      <CheckpointPanel checkpoints={checkpoints} detailAvailability={detailAvailability} />
    );

  return (
    <OperationsPanelShell
      snapshotStatus={selectSnapshotStatus(state)}
      freshness={selectFreshness(state)}
      detailPanel={detailPanel}
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
