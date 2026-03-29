import { useCallback, useEffect, useMemo, useReducer, useRef, type JSX } from 'react';

import { createOperationsClient } from '../api/operations-client.ts';
import { submitControl } from '../model/control-actions.ts';
import {
  createRouteInitialOperationsState,
  reduceOperationsState,
} from '../model/operations-reducer.ts';
import type { OperationsWorkspaceState } from '../model/operations-types.ts';
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

function useWorkspaceOperationsSelectors(state: OperationsWorkspaceState) {
  const snapshotStatus = selectSnapshotStatus(state);

  return {
    snapshotStatus,
    snapshotErrorMessage: selectSnapshotErrorMessage(state),
    selectedWorkItemId: selectSelectedWorkItemId(state),
    checkpoints: selectSelectedCheckpoints(state),
    routing: selectSelectedRouting(state),
    assignments: selectSelectedAssignments(state),
    council: selectSelectedCouncil(state),
    detailAvailability: selectDetailAvailability(state),
    detailFetchStatus: selectDetailFetchStatus(state),
    health: selectHealthStatus(state),
    budget: selectBudgetStatus(state),
    controls: selectControlsForSelectedItem(state),
    freshness: selectFreshness(state),
    availability: selectAvailability(state),
    filteredQueueItems: selectFilteredQueueItems(state),
  };
}

interface OperationsPanelSlots {
  readonly controlStripSlot: JSX.Element | undefined;
  readonly detailPanel: JSX.Element | undefined;
  readonly healthBudgetPanel: JSX.Element | undefined;
  readonly degradedBanner: JSX.Element | undefined;
}

function buildOperationsPanelSlots({
  selectedWorkItemId,
  controls,
  hasPendingControl,
  handleSubmitControl,
  routing,
  assignments,
  council,
  checkpoints,
  detailAvailability,
  detailFetchStatus,
  health,
  budget,
  snapshotStatus,
  snapshotErrorMessage,
  handleRetrySnapshot,
}: {
  readonly selectedWorkItemId: string | null;
  readonly controls: ReturnType<typeof selectControlsForSelectedItem>;
  readonly hasPendingControl: boolean;
  readonly handleSubmitControl: (
    controlId: string,
    optionId: string,
    expectedRevision: string,
  ) => void;
  readonly routing: ReturnType<typeof selectSelectedRouting>;
  readonly assignments: ReturnType<typeof selectSelectedAssignments>;
  readonly council: ReturnType<typeof selectSelectedCouncil>;
  readonly checkpoints: ReturnType<typeof selectSelectedCheckpoints>;
  readonly detailAvailability: ReturnType<typeof selectDetailAvailability>;
  readonly detailFetchStatus: ReturnType<typeof selectDetailFetchStatus>;
  readonly health: ReturnType<typeof selectHealthStatus>;
  readonly budget: ReturnType<typeof selectBudgetStatus>;
  readonly snapshotStatus: ReturnType<typeof selectSnapshotStatus>;
  readonly snapshotErrorMessage: string | null;
  readonly handleRetrySnapshot: () => void;
}): OperationsPanelSlots {
  return {
    controlStripSlot:
      selectedWorkItemId === null || controls.length === 0 ? undefined : (
        <ControlStrip
          controls={controls}
          hasPendingControl={hasPendingControl}
          onSubmitControl={handleSubmitControl}
        />
      ),
    detailPanel:
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
      ),
    healthBudgetPanel:
      health == null && budget == null ? undefined : (
        <HealthBudgetPanel health={health} budget={budget} />
      ),
    degradedBanner:
      snapshotStatus === 'error' && snapshotErrorMessage !== null ? (
        <OperationsDegradedBanner message={snapshotErrorMessage} onRetry={handleRetrySnapshot} />
      ) : undefined,
  };
}

export function WorkspaceOperationsPanel({
  refreshNonce = 0,
}: WorkspaceOperationsPanelProps): JSX.Element {
  const { state, handleSelectItem, handleSubmitControl, handleRetrySnapshot } =
    useOperationsPanelState({
      refreshNonce,
    });

  const {
    snapshotStatus,
    snapshotErrorMessage,
    selectedWorkItemId,
    checkpoints,
    routing,
    assignments,
    council,
    detailAvailability,
    detailFetchStatus,
    health,
    budget,
    controls,
    freshness,
    availability,
    filteredQueueItems,
  } = useWorkspaceOperationsSelectors(state);
  const hasPendingControl =
    selectedWorkItemId !== null && selectHasPendingControl(state, selectedWorkItemId);

  // Stable callback: identity changes only when the pendingByWorkItem Map changes,
  // not on every render.
  const pendingByWorkItem = state.controls.pendingByWorkItem;
  const hasPendingControlForItem = useCallback(
    (workItemId: string) => pendingByWorkItem.has(workItemId),
    [pendingByWorkItem],
  );

  const { controlStripSlot, detailPanel, healthBudgetPanel, degradedBanner } =
    buildOperationsPanelSlots({
      selectedWorkItemId,
      controls,
      hasPendingControl,
      handleSubmitControl,
      routing,
      assignments,
      council,
      checkpoints,
      detailAvailability,
      detailFetchStatus,
      health,
      budget,
      snapshotStatus,
      snapshotErrorMessage,
      handleRetrySnapshot,
    });

  return (
    <OperationsPanelShell
      snapshotStatus={snapshotStatus}
      freshness={freshness}
      detailPanel={detailPanel}
      healthBudgetPanel={healthBudgetPanel}
      controlStripSlot={controlStripSlot}
    >
      {degradedBanner}
      <QueuePanel
        items={filteredQueueItems}
        snapshotStatus={snapshotStatus}
        availability={availability}
        selectedWorkItemId={selectedWorkItemId}
        onSelectItem={handleSelectItem}
        hasPendingControl={hasPendingControlForItem}
      />
    </OperationsPanelShell>
  );
}
