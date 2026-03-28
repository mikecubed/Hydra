/**
 * ConfigPanel — Phase 6: routing + models + budgets + workflow launch (T034).
 *
 * Calls useSafeConfig on mount. Shows loading indicator, 503 message, and
 * MutationErrorBanner for top-level errors. Does not render stale data on error.
 * BudgetsSection receives onBudgetMutated prop for operations-panels gauge
 * invalidation per spec §6.4.
 */
import { useCallback, type JSX } from 'react';
import type { MutationsClient } from '../api/mutations-client.ts';
import { useSafeConfig } from '../model/use-safe-config.ts';
import { RoutingSection } from './routing-section.tsx';
import { ModelsSection } from './models-section.tsx';
import { BudgetsSection } from './budgets-section.tsx';
import { WorkflowLaunchPanel } from './workflow-launch-panel.tsx';
import { MutationErrorBanner } from './mutation-error-banner.tsx';

export interface ConfigPanelProps {
  client: MutationsClient;
  /** Called when a budget mutation succeeds — invalidates operations-panels budget gauge. */
  onBudgetMutated?: () => void;
}

export function ConfigPanel({ client, onBudgetMutated }: ConfigPanelProps): JSX.Element {
  const { config, revision, isLoading, error, errorCategory, refetch } = useSafeConfig(client);

  const handleBudgetMutated = useCallback(() => {
    onBudgetMutated?.();
  }, [onBudgetMutated]);

  if (isLoading) {
    return <div aria-busy="true">Loading config…</div>;
  }

  if (error !== null) {
    const isDaemonUnavailable = errorCategory === 'daemon-unavailable';
    return (
      <div>
        {isDaemonUnavailable ? (
          <p role="alert">Config unavailable — daemon unreachable</p>
        ) : (
          <MutationErrorBanner message={error} onDismiss={refetch} />
        )}
      </div>
    );
  }

  if (config === null) {
    return <div aria-busy="true">Loading config…</div>;
  }

  const rev = revision ?? '';

  return (
    <div>
      <RoutingSection config={config} revision={rev} client={client} onSuccess={refetch} />
      <ModelsSection config={config} revision={rev} client={client} onSuccess={refetch} />
      <BudgetsSection
        config={config}
        revision={rev}
        client={client}
        onSuccess={refetch}
        onBudgetMutated={handleBudgetMutated}
      />
      <WorkflowLaunchPanel revision={rev} client={client} />
    </div>
  );
}
