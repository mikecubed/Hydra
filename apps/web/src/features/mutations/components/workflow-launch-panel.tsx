/**
 * WorkflowLaunchPanel — workflow selector + gated launch (T031).
 *
 * - tasks → standard ConfirmDialog (non-destructive).
 * - evolve/nightly → DestructiveConfirmDialog (requiredPhrase = workflow name uppercase).
 * - Cancel always sends no network request.
 * - On success: shows "Workflow launched — Task #<taskId>" with anchor.
 * - On 409 workflow-conflict: shows "Workflow already running" inline.
 */
import { useState, useCallback, type JSX } from 'react';
import type { WorkflowName } from '@hydra/web-contracts';
import type { MutationsClient } from '../api/mutations-client.ts';
import { MutationsRequestError } from '../api/mutations-client.ts';
import type { ErrorCategory } from '../../../shared/gateway-errors.ts';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { DestructiveConfirmDialog } from './destructive-confirm-dialog.tsx';
import { MutationErrorBanner } from './mutation-error-banner.tsx';
import { randomUUID } from '../model/uuid-helper.ts';

const WORKFLOWS: WorkflowName[] = ['evolve', 'tasks', 'nightly'];
const DESTRUCTIVE_WORKFLOWS = new Set<WorkflowName>(['evolve', 'nightly']);

export interface WorkflowLaunchPanelProps {
  revision: string;
  client: MutationsClient;
}

interface LaunchDialogProps {
  isOpen: boolean;
  workflow: WorkflowName;
  isLoading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function LaunchDialog({
  isOpen,
  workflow,
  isLoading,
  onConfirm,
  onCancel,
}: LaunchDialogProps): JSX.Element {
  if (DESTRUCTIVE_WORKFLOWS.has(workflow)) {
    return (
      <DestructiveConfirmDialog
        isOpen={isOpen}
        title={`Launch ${workflow}`}
        from="idle"
        to="running"
        requiredPhrase={workflow.toUpperCase()}
        onConfirm={onConfirm}
        onCancel={onCancel}
        isLoading={isLoading}
      />
    );
  }
  return (
    <ConfirmDialog
      isOpen={isOpen}
      title={`Launch ${workflow}`}
      from="idle"
      to="running"
      onConfirm={onConfirm}
      onCancel={onCancel}
      isLoading={isLoading}
    />
  );
}

interface LaunchOutcomeNoticeProps {
  conflictMessage: string | null;
  launchedTaskId: string | null;
}

function LaunchOutcomeNotice({
  conflictMessage,
  launchedTaskId,
}: LaunchOutcomeNoticeProps): JSX.Element | null {
  if (conflictMessage !== null) {
    return <p role="alert">{conflictMessage}</p>;
  }
  if (launchedTaskId !== null) {
    return (
      <p>
        Workflow launched — <a href={`#task-${launchedTaskId}`}>Task #{launchedTaskId}</a>
      </p>
    );
  }
  return null;
}

interface WorkflowSelectorProps {
  selectedWorkflow: WorkflowName;
  onSelect: (workflow: WorkflowName) => void;
}

function WorkflowSelector({ selectedWorkflow, onSelect }: WorkflowSelectorProps): JSX.Element {
  return (
    <fieldset>
      <legend>Select workflow</legend>
      {WORKFLOWS.map((workflow) => (
        <label key={workflow}>
          <input
            type="radio"
            name="workflow"
            value={workflow}
            checked={selectedWorkflow === workflow}
            onChange={() => {
              onSelect(workflow);
            }}
          />
          {workflow}
        </label>
      ))}
    </fieldset>
  );
}

type LaunchOutcome =
  | { taskId: string }
  | { conflict: string }
  | { error: string; category: ErrorCategory | null; retryAfterMs: number | null };

async function executeLaunch(
  client: MutationsClient,
  workflow: WorkflowName,
  revision: string,
): Promise<LaunchOutcome> {
  try {
    const result = await client.postWorkflowLaunch({
      workflow,
      idempotencyKey: randomUUID(),
      expectedRevision: revision,
    });
    return { taskId: result.taskId };
  } catch (err: unknown) {
    if (err instanceof MutationsRequestError) {
      if (err.gatewayError.category === 'workflow-conflict')
        return { conflict: 'Workflow already running' };
      if (err.gatewayError.category === 'daemon-unavailable')
        return {
          error: 'Config unavailable — daemon unreachable',
          category: err.gatewayError.category,
          retryAfterMs: err.gatewayError.retryAfterMs ?? null,
        };
      return {
        error: err.gatewayError.message,
        category: err.gatewayError.category,
        retryAfterMs: err.gatewayError.retryAfterMs ?? null,
      };
    }
    return { error: 'Unexpected error', category: null, retryAfterMs: null };
  }
}

export function WorkflowLaunchPanel({ revision, client }: WorkflowLaunchPanelProps): JSX.Element {
  const [selectedWorkflow, setSelectedWorkflow] = useState<WorkflowName>('tasks');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCategory, setErrorCategory] = useState<ErrorCategory | null>(null);
  const [retryAfterMs, setRetryAfterMs] = useState<number | null>(null);
  const [launchedTaskId, setLaunchedTaskId] = useState<string | null>(null);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);

  const handleLaunch = useCallback(() => {
    setIsDialogOpen(true);
    setConflictMessage(null);
    setError(null);
    setErrorCategory(null);
    setRetryAfterMs(null);
    setLaunchedTaskId(null);
  }, []);

  const handleCancel = useCallback(() => {
    setIsDialogOpen(false);
  }, []);

  const handleConfirm = useCallback(async () => {
    setIsLoading(true);
    setIsDialogOpen(false);
    try {
      const outcome = await executeLaunch(client, selectedWorkflow, revision);
      if ('taskId' in outcome) setLaunchedTaskId(outcome.taskId);
      else if ('conflict' in outcome) setConflictMessage(outcome.conflict);
      else {
        setError(outcome.error);
        setErrorCategory(outcome.category);
        setRetryAfterMs(outcome.retryAfterMs);
      }
    } finally {
      setIsLoading(false);
    }
  }, [client, selectedWorkflow, revision]);

  return (
    <section aria-labelledby="workflow-launch-heading">
      <h3 id="workflow-launch-heading">Launch Workflow</h3>
      <WorkflowSelector selectedWorkflow={selectedWorkflow} onSelect={setSelectedWorkflow} />
      <button type="button" onClick={handleLaunch} disabled={isLoading}>
        Launch
      </button>
      <LaunchOutcomeNotice conflictMessage={conflictMessage} launchedTaskId={launchedTaskId} />
      <MutationErrorBanner
        message={error}
        category={errorCategory}
        retryAfterMs={retryAfterMs}
        onDismiss={() => {
          setError(null);
          setErrorCategory(null);
          setRetryAfterMs(null);
        }}
      />
      <LaunchDialog
        isOpen={isDialogOpen}
        workflow={selectedWorkflow}
        isLoading={isLoading}
        onConfirm={() => {
          void handleConfirm();
        }}
        onCancel={handleCancel}
      />
    </section>
  );
}
