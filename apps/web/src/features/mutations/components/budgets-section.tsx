/**
 * BudgetsSection — per-model budget inputs with cross-field advisory (T029).
 *
 * On success calls both onSuccess (config refetch) and onBudgetMutated
 * (operations-panels budget gauge invalidation per spec §6.4).
 */
import { useState, useCallback, useMemo, type JSX } from 'react';
import type { SafeConfigView } from '@hydra/web-contracts';
import type { MutationsClient } from '../api/mutations-client.ts';
import { MutationsRequestError } from '../api/mutations-client.ts';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { MutationErrorBanner } from './mutation-error-banner.tsx';

interface BudgetRowState {
  dailyInput: string;
  weeklyInput: string;
  isDialogOpen: boolean;
  isLoading: boolean;
  error: string | null;
}

export interface BudgetsSectionProps {
  config: SafeConfigView;
  revision: string;
  client: MutationsClient;
  onSuccess: () => void;
  onBudgetMutated: () => void;
}

function parsePositiveInt(val: string): number | null {
  const n = Number(val);
  if (Number.isInteger(n) && n > 0) return n;
  return null;
}

function validateRow(row: BudgetRowState): string | null {
  const d = parsePositiveInt(row.dailyInput);
  const w = parsePositiveInt(row.weeklyInput);
  if (row.dailyInput !== '' && d === null) return 'Daily limit must be a positive integer';
  if (row.weeklyInput !== '' && w === null) return 'Weekly limit must be a positive integer';
  if (row.dailyInput === '' && row.weeklyInput === '') return 'At least one limit is required';
  return null;
}

function formatLimit(val: number | undefined): string {
  return val === undefined ? 'none' : String(val);
}

interface BudgetRowProps {
  id: string;
  row: BudgetRowState;
  currentDaily: number | undefined;
  currentWeekly: number | undefined;
  onDailyChange: (v: string) => void;
  onWeeklyChange: (v: string) => void;
  onOpenDialog: () => void;
  onCloseDialog: () => void;
  onConfirm: () => void;
  onDismissError: () => void;
}

function BudgetRow({
  id,
  row,
  currentDaily,
  currentWeekly,
  onDailyChange,
  onWeeklyChange,
  onOpenDialog,
  onCloseDialog,
  onConfirm,
  onDismissError,
}: BudgetRowProps): JSX.Element {
  const d = parsePositiveInt(row.dailyInput);
  const w = parsePositiveInt(row.weeklyInput);
  const validationError = validateRow(row);
  const showAdvisory = d !== null && w !== null && d > w;
  const hasInput = row.dailyInput !== '' || row.weeklyInput !== '';
  return (
    <div aria-label={`Budget for ${id}`}>
      <span>{id}</span>
      <label htmlFor={`daily-${id}`}>Daily limit</label>
      <input
        id={`daily-${id}`}
        type="number"
        value={row.dailyInput}
        onChange={(e) => {
          onDailyChange(e.target.value);
        }}
        disabled={row.isLoading}
      />
      <label htmlFor={`weekly-${id}`}>Weekly limit</label>
      <input
        id={`weekly-${id}`}
        type="number"
        value={row.weeklyInput}
        onChange={(e) => {
          onWeeklyChange(e.target.value);
        }}
        disabled={row.isLoading}
      />
      <button
        type="button"
        onClick={onOpenDialog}
        disabled={validationError !== null || row.isLoading}
      >
        Apply
      </button>
      {validationError !== null && hasInput && <span role="alert">{validationError}</span>}
      <MutationErrorBanner message={row.error} onDismiss={onDismissError} />
      <ConfirmDialog
        isOpen={row.isDialogOpen}
        title={`Update ${id} budget`}
        from={`daily:${formatLimit(currentDaily)} weekly:${formatLimit(currentWeekly)}`}
        to={`daily:${row.dailyInput === '' ? 'none' : row.dailyInput} weekly:${row.weeklyInput === '' ? 'none' : row.weeklyInput}`}
        onConfirm={onConfirm}
        onCancel={onCloseDialog}
        isLoading={row.isLoading}
      >
        {showAdvisory && <p role="note">Advisory: daily limit exceeds weekly limit</p>}
      </ConfirmDialog>
    </div>
  );
}

function buildInitialRows(
  modelIds: string[],
  daily: Record<string, number>,
  weekly: Record<string, number>,
): Record<string, BudgetRowState> {
  return Object.fromEntries(
    modelIds.map((id) => [
      id,
      {
        dailyInput: Object.hasOwn(daily, id) ? String(daily[id]) : '',
        weeklyInput: Object.hasOwn(weekly, id) ? String(weekly[id]) : '',
        isDialogOpen: false,
        isLoading: false,
        error: null,
      },
    ]),
  );
}

interface ApplyBudgetArgs {
  id: string;
  rows: Record<string, BudgetRowState>;
  updateRow: (id: string, patch: Partial<BudgetRowState>) => void;
  client: MutationsClient;
  revision: string;
  onSuccess: () => void;
  onBudgetMutated: () => void;
}

async function applyBudget({
  id,
  rows,
  updateRow,
  client,
  revision,
  onSuccess,
  onBudgetMutated,
}: ApplyBudgetArgs): Promise<void> {
  const row = rows[id];
  const validationError = validateRow(row);
  if (validationError !== null) {
    updateRow(id, { error: validationError });
    return;
  }
  updateRow(id, { isLoading: true, error: null });
  try {
    await client.postBudget({
      modelId: id,
      dailyLimit: parsePositiveInt(row.dailyInput),
      weeklyLimit: parsePositiveInt(row.weeklyInput),
      expectedRevision: revision,
    });
    updateRow(id, { isLoading: false, isDialogOpen: false });
    onSuccess();
    onBudgetMutated();
  } catch (err: unknown) {
    updateRow(id, {
      isLoading: false,
      isDialogOpen: false,
      error: err instanceof MutationsRequestError ? err.gatewayError.message : 'Unexpected error',
    });
  }
}

function collectModelIds(config: SafeConfigView): string[] {
  const daily = config.usage?.dailyTokenBudget ?? {};
  const weekly = config.usage?.weeklyTokenBudget ?? {};
  return [...new Set([...Object.keys(daily), ...Object.keys(weekly)])];
}

function syncBudgetRows(
  modelIds: string[],
  daily: Record<string, number>,
  weekly: Record<string, number>,
  prev: Record<string, BudgetRowState>,
): Record<string, BudgetRowState> {
  return Object.fromEntries(
    modelIds.map((id) => [
      id,
      Object.hasOwn(prev, id)
        ? prev[id]
        : {
            dailyInput: Object.hasOwn(daily, id) ? String(daily[id]) : '',
            weeklyInput: Object.hasOwn(weekly, id) ? String(weekly[id]) : '',
            isDialogOpen: false,
            isLoading: false,
            error: null,
          },
    ]),
  );
}

export function BudgetsSection({
  config,
  revision,
  client,
  onSuccess,
  onBudgetMutated,
}: BudgetsSectionProps): JSX.Element {
  const modelIds = collectModelIds(config);
  const daily = config.usage?.dailyTokenBudget ?? {};
  const weekly = config.usage?.weeklyTokenBudget ?? {};

  const [rows, setRows] = useState<Record<string, BudgetRowState>>(() =>
    buildInitialRows(modelIds, daily, weekly),
  );

  const modelIdsKey = modelIds.join(',');

  // Derive rows for all current model IDs without a render-phase setState.
  // `modelIdsKey` proxies `modelIds` as a stable string; `rows` tracks user
  // interaction state. `daily`/`weekly` change reference every render but are
  // only needed when the model-ID set changes — already covered by `modelIdsKey`.
  const effectiveRows = useMemo(
    () => syncBudgetRows(modelIds, daily, weekly, rows),
    [modelIdsKey, rows],
  );

  const updateRow = useCallback((id: string, patch: Partial<BudgetRowState>) => {
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }, []);

  const handleConfirm = useCallback(
    (id: string) => {
      void applyBudget({
        id,
        rows: effectiveRows,
        updateRow,
        client,
        revision,
        onSuccess,
        onBudgetMutated,
      });
    },
    [effectiveRows, client, revision, onSuccess, onBudgetMutated, updateRow],
  );

  if (modelIds.length === 0) {
    return (
      <section aria-label="Budget configuration">
        <p>No budget configuration available.</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="budgets-section-heading">
      <h3 id="budgets-section-heading">Token Budgets</h3>
      {modelIds.map((id) => (
        <BudgetRow
          key={id}
          id={id}
          row={effectiveRows[id]}
          currentDaily={daily[id]}
          currentWeekly={weekly[id]}
          onDailyChange={(v) => {
            updateRow(id, { dailyInput: v });
          }}
          onWeeklyChange={(v) => {
            updateRow(id, { weeklyInput: v });
          }}
          onOpenDialog={() => {
            updateRow(id, { isDialogOpen: true });
          }}
          onCloseDialog={() => {
            updateRow(id, { isDialogOpen: false });
          }}
          onConfirm={() => {
            handleConfirm(id);
          }}
          onDismissError={() => {
            updateRow(id, { error: null });
          }}
        />
      ))}
    </section>
  );
}
