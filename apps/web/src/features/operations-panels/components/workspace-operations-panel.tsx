import { useEffect, useMemo, useReducer, type JSX } from 'react';

import { createOperationsClient } from '../api/operations-client.ts';
import {
  createRouteInitialOperationsState,
  reduceOperationsState,
} from '../model/operations-reducer.ts';
import {
  selectAvailability,
  selectFilteredQueueItems,
  selectFreshness,
  selectHasPendingControl,
  selectSelectedWorkItemId,
  selectSnapshotStatus,
} from '../model/selectors.ts';
import { OperationsPanelShell } from './operations-panel-shell.tsx';
import { QueuePanel } from './queue-panel.tsx';

function useOperationsPanelState() {
  const operationsClient = useMemo(() => createOperationsClient({ baseUrl: '' }), []);
  const [state, dispatch] = useReducer(
    reduceOperationsState,
    undefined,
    createRouteInitialOperationsState,
  );

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
    };
  }, [operationsClient]);

  return { state, dispatch };
}

export function WorkspaceOperationsPanel(): JSX.Element {
  const { state, dispatch } = useOperationsPanelState();

  return (
    <OperationsPanelShell
      snapshotStatus={selectSnapshotStatus(state)}
      freshness={selectFreshness(state)}
    >
      <QueuePanel
        items={selectFilteredQueueItems(state)}
        snapshotStatus={selectSnapshotStatus(state)}
        availability={selectAvailability(state)}
        selectedWorkItemId={selectSelectedWorkItemId(state)}
        onSelectItem={(workItemId) => {
          dispatch({ type: 'selection/select', workItemId });
        }}
        hasPendingControl={(workItemId) => selectHasPendingControl(state, workItemId)}
      />
    </OperationsPanelShell>
  );
}
