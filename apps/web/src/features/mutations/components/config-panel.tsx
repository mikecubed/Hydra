/**
 * ConfigPanel — Phase 5 shell: routing section + stubs for models/budgets (T026).
 *
 * Calls useSafeConfig on mount. Shows loading indicator, 503 message, and
 * MutationErrorBanner for top-level errors. Does not render stale data on error.
 */
import type { JSX } from 'react';
import type { MutationsClient } from '../api/mutations-client.ts';
import { useSafeConfig } from '../model/use-safe-config.ts';
import { RoutingSection } from './routing-section.tsx';
import { MutationErrorBanner } from './mutation-error-banner.tsx';

export interface ConfigPanelProps {
  client: MutationsClient;
}

export function ConfigPanel({ client }: ConfigPanelProps): JSX.Element {
  const { config, revision, isLoading, error, refetch } = useSafeConfig(client);

  if (isLoading) {
    return <div aria-busy="true">Loading config…</div>;
  }

  if (error !== null) {
    const isDaemonUnavailable =
      error.toLowerCase().includes('unreachable') ||
      error.toLowerCase().includes('daemon');
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

  return (
    <div>
      <RoutingSection
        config={config}
        revision={revision ?? ''}
        client={client}
        onSuccess={refetch}
      />
      {/* ModelsSection stub — wired in T035 */}
      <section aria-label="Models configuration (coming soon)" />
      {/* BudgetsSection stub — wired in T035 */}
      <section aria-label="Budgets configuration (coming soon)" />
    </div>
  );
}
