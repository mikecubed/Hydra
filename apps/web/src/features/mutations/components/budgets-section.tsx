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
import type { ErrorCategory } from '../../../shared/gateway-errors.ts';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { MutationErrorBanner } from './mutation-error-banner.tsx';

interface BudgetRowState {
  serverDailyInput: string;
  serverWeeklyInput: string;
  dailyInput: string;
  weeklyInput: string;
  isDialogOpen: boolean;
  isLoading: boolean;
  error: string | null;
  errorCategory: ErrorCategory | null;
  retryAfterMs: number | null;
}

type BudgetValidationField = 'daily' | 'weekly' | 'row';

interface BudgetValidationResult {
  message: string;
  field: BudgetValidationField;
}

interface BudgetRowFeedback {
  validationError: BudgetValidationResult | null;
  showAdvisory: boolean;
  hasInput: boolean;
  errorId: string;
  isDailyInvalid: boolean;
  isWeeklyInvalid: boolean;
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

function validateRow(row: BudgetRowState): BudgetValidationResult | null {
  const d = parsePositiveInt(row.dailyInput);
  const w = parsePositiveInt(row.weeklyInput);
  if (row.dailyInput !== '' && d === null) {
    return { message: 'Daily limit must be a positive integer', field: 'daily' };
  }
  if (row.weeklyInput !== '' && w === null) {
    return { message: 'Weekly limit must be a positive integer', field: 'weekly' };
  }
  if (row.dailyInput === '' && row.weeklyInput === '') {
    return { message: 'At least one limit is required', field: 'row' };
  }
  return null;
}

function getBudgetRowFeedback(id: string, row: BudgetRowState): BudgetRowFeedback {
  const dailyLimit = parsePositiveInt(row.dailyInput);
  const weeklyLimit = parsePositiveInt(row.weeklyInput);
  const validationError = validateRow(row);
  return {
    validationError,
    showAdvisory: dailyLimit !== null && weeklyLimit !== null && dailyLimit > weeklyLimit,
    hasInput: row.dailyInput !== '' || row.weeklyInput !== '',
    errorId: `budget-error-${id}`,
    isDailyInvalid: validationError?.field === 'daily' || validationError?.field === 'row',
    isWeeklyInvalid: validationError?.field === 'weekly' || validationError?.field === 'row',
  };
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

interface RenderBudgetRowsArgs {
  modelIds: string[];
  effectiveRows: Record<string, BudgetRowState>;
  daily: Record<string, number>;
  weekly: Record<string, number>;
  updateRow: (id: string, patch: Partial<BudgetRowState>) => void;
  handleConfirm: (id: string) => void;
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
  const { validationError, showAdvisory, hasInput, errorId, isDailyInvalid, isWeeklyInvalid } =
    getBudgetRowFeedback(id, row);
  return (
    <div aria-label={`Budget for ${id}`}>
      <span>{id}</span>
      <label htmlFor={`daily-${id}`}>Daily limit</label>
      <input
        id={`daily-${id}`}
        type="number"
        value={row.dailyInput}
        aria-invalid={isDailyInvalid || undefined}
        aria-describedby={isDailyInvalid ? errorId : undefined}
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
        aria-invalid={isWeeklyInvalid || undefined}
        aria-describedby={isWeeklyInvalid ? errorId : undefined}
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
      {validationError !== null && hasInput && (
        <span id={errorId} role="alert">
          {validationError.message}
        </span>
      )}
      <MutationErrorBanner
        message={row.error}
        category={row.errorCategory}
        retryAfterMs={row.retryAfterMs}
        onDismiss={onDismissError}
      />
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

function renderBudgetRows({
  modelIds,
  effectiveRows,
  daily,
  weekly,
  updateRow,
  handleConfirm,
}: RenderBudgetRowsArgs): JSX.Element[] {
  return modelIds.map((id) => (
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
        updateRow(id, { error: null, errorCategory: null, retryAfterMs: null });
      }}
    />
  ));
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
        serverDailyInput: Object.hasOwn(daily, id) ? String(daily[id]) : '',
        serverWeeklyInput: Object.hasOwn(weekly, id) ? String(weekly[id]) : '',
        dailyInput: Object.hasOwn(daily, id) ? String(daily[id]) : '',
        weeklyInput: Object.hasOwn(weekly, id) ? String(weekly[id]) : '',
        isDialogOpen: false,
        isLoading: false,
        error: null,
        errorCategory: null,
        retryAfterMs: null,
      },
    ]),
  );
}

function buildBudgetBaseline(
  id: string,
  daily: Record<string, number>,
  weekly: Record<string, number>,
): BudgetRowState {
  const serverDailyInput = Object.hasOwn(daily, id) ? String(daily[id]) : '';
  const serverWeeklyInput = Object.hasOwn(weekly, id) ? String(weekly[id]) : '';
  return {
    serverDailyInput,
    serverWeeklyInput,
    dailyInput: serverDailyInput,
    weeklyInput: serverWeeklyInput,
    isDialogOpen: false,
    isLoading: false,
    error: null,
    errorCategory: null,
    retryAfterMs: null,
  };
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
    updateRow(id, { error: validationError.message, errorCategory: null, retryAfterMs: null });
    return;
  }
  updateRow(id, { isLoading: true, error: null, errorCategory: null, retryAfterMs: null });
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
      dailyInput: row.serverDailyInput,
      weeklyInput: row.serverWeeklyInput,
      isLoading: false,
      isDialogOpen: false,
      error: err instanceof MutationsRequestError ? err.gatewayError.message : 'Unexpected error',
      errorCategory: err instanceof MutationsRequestError ? err.gatewayError.category : null,
      retryAfterMs:
        err instanceof MutationsRequestError ? (err.gatewayError.retryAfterMs ?? null) : null,
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
    modelIds.map((id) => {
      const nextDailyInput = Object.hasOwn(daily, id) ? String(daily[id]) : '';
      const nextWeeklyInput = Object.hasOwn(weekly, id) ? String(weekly[id]) : '';
      if (!Object.hasOwn(prev, id)) return [id, buildBudgetBaseline(id, daily, weekly)];
      const existing = prev[id];
      const isDirty =
        existing.dailyInput !== existing.serverDailyInput ||
        existing.weeklyInput !== existing.serverWeeklyInput;
      return [
        id,
        {
          ...existing,
          serverDailyInput: nextDailyInput,
          serverWeeklyInput: nextWeeklyInput,
          dailyInput:
            !existing.isDialogOpen && !existing.isLoading && !isDirty
              ? nextDailyInput
              : existing.dailyInput,
          weeklyInput:
            !existing.isDialogOpen && !existing.isLoading && !isDirty
              ? nextWeeklyInput
              : existing.weeklyInput,
        },
      ];
    }),
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
  const effectiveRows = useMemo(
    () => syncBudgetRows(modelIds, daily, weekly, rows),
    [daily, modelIdsKey, rows, weekly],
  );
  const updateRow = useCallback(
    (id: string, patch: Partial<BudgetRowState>) => {
      setRows((prev) => {
        const baseline = prev[id] ?? buildBudgetBaseline(id, daily, weekly);
        return { ...prev, [id]: { ...baseline, ...patch } };
      });
    },
    [daily, weekly],
  );
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
      {renderBudgetRows({ modelIds, effectiveRows, daily, weekly, updateRow, handleConfirm })}
    </section>
  );
}
