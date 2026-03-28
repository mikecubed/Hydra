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

function LaunchDialog({ isOpen, workflow, isLoading, onConfirm, onCancel }: LaunchDialogProps): JSX.Element {
  if (DESTRUCTIVE_WORKFLOWS.has(workflow)) {
    return (
      <DestructiveConfirmDialog
        isOpen={isOpen}
        title={`Launch ${workflow}`}
        from="idle" to="running"
        requiredPhrase={workflow.toUpperCase()}
        onConfirm={onConfirm} onCancel={onCancel}
        isLoading={isLoading}
      />
    );
  }
  return (
    <ConfirmDialog
      isOpen={isOpen}
      title={`Launch ${workflow}`}
      from="idle" to="running"
      onConfirm={onConfirm} onCancel={onCancel}
      isLoading={isLoading}
    />
  );
}

export function WorkflowLaunchPanel({ revision, client }: WorkflowLaunchPanelProps): JSX.Element {
  const [selectedWorkflow, setSelectedWorkflow] = useState<WorkflowName>('tasks');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launchedTaskId, setLaunchedTaskId] = useState<string | null>(null);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);

  const handleLaunch = useCallback(() => {
    setIsDialogOpen(true);
    setConflictMessage(null);
    setError(null);
    setLaunchedTaskId(null);
  }, []);

  const handleCancel = useCallback(() => { setIsDialogOpen(false); }, []);

  const handleConfirm = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await client.postWorkflowLaunch({
        workflow: selectedWorkflow,
        idempotencyKey: randomUUID(),
        expectedRevision: revision,
      });
      setLaunchedTaskId(result.taskId);
      setIsDialogOpen(false);
    } catch (err: unknown) {
      setIsDialogOpen(false);
      if (err instanceof MutationsRequestError) {
        if (err.gatewayError.code === 'workflow-conflict') {
          setConflictMessage('Workflow already running');
        } else if (err.gatewayError.httpStatus === 503) {
          setError('Config unavailable — daemon unreachable');
        } else {
          setError(err.gatewayError.message);
        }
      } else {
        setError('Unexpected error');
      }
    } finally {
      setIsLoading(false);
    }
  }, [client, selectedWorkflow, revision]);

  return (
    <section aria-labelledby="workflow-launch-heading">
      <h3 id="workflow-launch-heading">Launch Workflow</h3>
      <fieldset>
        <legend>Select workflow</legend>
        {WORKFLOWS.map((wf) => (
          <label key={wf}>
            <input type="radio" name="workflow" value={wf}
              checked={selectedWorkflow === wf}
              onChange={() => { setSelectedWorkflow(wf); }}
            />
            {wf}
          </label>
        ))}
      </fieldset>
      <button type="button" onClick={handleLaunch} disabled={isLoading}>Launch</button>
      {conflictMessage !== null && <p role="alert">{conflictMessage}</p>}
      {launchedTaskId !== null && (
        <p>Workflow launched — <a href={`#task-${launchedTaskId}`}>Task #{launchedTaskId}</a></p>
      )}
      <MutationErrorBanner message={error} onDismiss={() => { setError(null); }} />
      <LaunchDialog
        isOpen={isDialogOpen}
        workflow={selectedWorkflow}
        isLoading={isLoading}
        onConfirm={() => { void handleConfirm(); }}
        onCancel={handleCancel}
      />
    </section>
  );
}
