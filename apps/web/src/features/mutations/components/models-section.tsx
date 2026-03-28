/**
 * ModelsSection — per-agent tier selector with ConfirmDialog (T028).
 *
 * Renders one row per agent in SafeConfigView.models. On stale-revision
 * error (409), shows a non-blocking inline toast per row.
 */
import { useState, useCallback, useMemo, type JSX } from 'react';
import type { SafeConfigView, ModelTier } from '@hydra/web-contracts';
import type { MutationsClient } from '../api/mutations-client.ts';
import { MutationsRequestError } from '../api/mutations-client.ts';
import { ConfirmDialog } from './confirm-dialog.tsx';

const MODEL_TIERS: ModelTier[] = ['default', 'fast', 'cheap'];

interface RowState {
  selectedTier: ModelTier;
  isDialogOpen: boolean;
  isLoading: boolean;
  toast: string | null;
}

export interface ModelsSectionProps {
  config: SafeConfigView;
  revision: string;
  client: MutationsClient;
  onSuccess: () => void;
}

function resolveCurrentTier(modelConfig: NonNullable<SafeConfigView['models']>[string]): ModelTier {
  const active = modelConfig.active;
  if (active === 'fast' || active === 'cheap') return active;
  return 'default';
}

function resolveToast(err: unknown, isStale: boolean): string {
  if (isStale) return 'Config changed — refresh to retry';
  if (err instanceof MutationsRequestError) return err.gatewayError.message;
  return 'Unexpected error';
}

interface ModelRowProps {
  agent: string;
  currentTier: ModelTier;
  row: RowState;
  onTierChange: (tier: ModelTier) => void;
  onOpen: () => void;
  onClose: () => void;
  onConfirm: () => void;
}

function ModelRow({
  agent,
  currentTier,
  row,
  onTierChange,
  onOpen,
  onClose,
  onConfirm,
}: ModelRowProps): JSX.Element {
  const isUnchanged = row.selectedTier === currentTier;
  return (
    <div aria-label={`Model config for ${agent}`}>
      <span>{agent}</span>
      <span aria-label={`Current tier: ${currentTier}`}>{currentTier}</span>
      <label htmlFor={`tier-select-${agent}`}>Tier</label>
      <select
        id={`tier-select-${agent}`}
        value={row.selectedTier}
        onChange={(e) => {
          onTierChange(e.target.value as ModelTier);
        }}
        disabled={row.isLoading}
      >
        {MODEL_TIERS.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <button type="button" onClick={onOpen} disabled={isUnchanged || row.isLoading}>
        Apply
      </button>
      {row.toast !== null && (
        <span role="status" aria-live="polite">
          {row.toast}
        </span>
      )}
      <ConfirmDialog
        isOpen={row.isDialogOpen}
        title={`Change ${agent} model tier`}
        from={currentTier}
        to={row.selectedTier}
        onConfirm={onConfirm}
        onCancel={onClose}
        isLoading={row.isLoading}
      />
    </div>
  );
}

function buildModelRows(
  agents: string[],
  models: NonNullable<SafeConfigView['models']>,
  prev: Record<string, RowState>,
): Record<string, RowState> {
  return Object.fromEntries(
    agents.map((a) => [
      a,
      Object.hasOwn(prev, a)
        ? prev[a]
        : {
            selectedTier: resolveCurrentTier(models[a]),
            isDialogOpen: false,
            isLoading: false,
            toast: null,
          },
    ]),
  );
}

export function ModelsSection({
  config,
  revision,
  client,
  onSuccess,
}: ModelsSectionProps): JSX.Element {
  const models = config.models ?? {};
  const agents = Object.keys(models);

  const [rows, setRows] = useState<Record<string, RowState>>(() =>
    buildModelRows(agents, models, {}),
  );

  const agentsKey = agents.join(',');

  // Derive rows for all current agents without a render-phase setState.
  // `agentsKey` proxies `agents` as a stable string; `rows` tracks user
  // interaction state. `models` changes reference every render but is only
  // needed when the agent set changes — already covered by `agentsKey`.
  const effectiveRows = useMemo(() => buildModelRows(agents, models, rows), [agentsKey, rows]);

  const updateRow = useCallback((agent: string, patch: Partial<RowState>) => {
    setRows((prev) => ({ ...prev, [agent]: { ...prev[agent], ...patch } }));
  }, []);

  const handleConfirm = useCallback(
    async (agent: string) => {
      const row = effectiveRows[agent];
      updateRow(agent, { isLoading: true });
      try {
        await client.postModelTier(agent, { tier: row.selectedTier, expectedRevision: revision });
        updateRow(agent, { isLoading: false, isDialogOpen: false, toast: null });
        onSuccess();
      } catch (err: unknown) {
        const isStale = err instanceof MutationsRequestError && err.gatewayError.httpStatus === 409;
        updateRow(agent, {
          isLoading: false,
          isDialogOpen: false,
          toast: resolveToast(err, isStale),
        });
      }
    },
    [effectiveRows, client, revision, onSuccess, updateRow],
  );

  if (agents.length === 0) {
    return (
      <section aria-label="Models configuration">
        <p>No model configuration available.</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="models-section-heading">
      <h3 id="models-section-heading">Model Tiers</h3>
      {agents.map((agent) => (
        <ModelRow
          key={agent}
          agent={agent}
          currentTier={resolveCurrentTier(models[agent])}
          row={effectiveRows[agent]}
          onTierChange={(tier) => {
            updateRow(agent, { selectedTier: tier });
          }}
          onOpen={() => {
            updateRow(agent, { isDialogOpen: true });
          }}
          onClose={() => {
            updateRow(agent, { isDialogOpen: false });
          }}
          onConfirm={() => {
            void handleConfirm(agent);
          }}
        />
      ))}
    </section>
  );
}
