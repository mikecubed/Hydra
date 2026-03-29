/**
 * RoutingSection — routing mode display + mutation trigger (T025).
 *
 * Selecting the currently-active mode is a no-op (no dialog opened).
 * Selecting a different mode opens ConfirmDialog; on confirm calls postRoutingMode.
 */
import { useState, useCallback, type JSX } from 'react';
import type { ChangeEvent } from 'react';
import type { SafeConfigView } from '@hydra/web-contracts';
import type { MutationsClient } from '../api/mutations-client.ts';
import { useMutation } from '../model/use-mutation.ts';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { MutationErrorBanner } from './mutation-error-banner.tsx';

const ROUTING_MODES = ['economy', 'balanced', 'performance'] as const;
type RoutingMode = (typeof ROUTING_MODES)[number];

export interface RoutingSectionProps {
  config: SafeConfigView;
  revision: string;
  client: MutationsClient;
  onSuccess: () => void;
}

export function RoutingSection({
  config,
  revision,
  client,
  onSuccess,
}: RoutingSectionProps): JSX.Element {
  const rawMode = config.routing.mode;
  const currentMode: RoutingMode = rawMode;
  const [pendingMode, setPendingMode] = useState<RoutingMode | null>(null);

  const { mutate, isLoading, error, errorCategory, retryAfterMs, reset } = useMutation(
    (body: { mode: RoutingMode; expectedRevision: string }) => client.postRoutingMode(body),
    { onSuccess },
  );

  const handleSelectChange = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => {
      const val = e.target.value;
      const selected = val as RoutingMode;
      if (selected === currentMode) return;
      setPendingMode(selected);
    },
    [currentMode],
  );

  const handleConfirm = useCallback(async () => {
    if (pendingMode === null) return;
    await mutate({ mode: pendingMode, expectedRevision: revision });
    setPendingMode(null);
  }, [mutate, pendingMode, revision]);

  const handleCancel = useCallback(() => {
    setPendingMode(null);
  }, []);

  return (
    <section aria-labelledby="routing-section-heading">
      <h3 id="routing-section-heading">Routing Mode</h3>
      <p>
        Current: <strong>{currentMode}</strong>
      </p>
      <label htmlFor="routing-mode-select">Change routing mode</label>
      <select
        id="routing-mode-select"
        value={currentMode}
        onChange={handleSelectChange}
        disabled={isLoading}
      >
        {ROUTING_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {mode}
          </option>
        ))}
      </select>
      <MutationErrorBanner
        message={error}
        category={errorCategory}
        retryAfterMs={retryAfterMs}
        onDismiss={reset}
      />
      <ConfirmDialog
        isOpen={pendingMode !== null}
        title="Change Routing Mode"
        from={currentMode}
        to={pendingMode ?? ''}
        onConfirm={() => void handleConfirm()}
        onCancel={handleCancel}
        isLoading={isLoading}
      />
    </section>
  );
}
