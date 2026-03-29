/**
 * Workflow launch schemas — request/response types for launching daemon workflows.
 */
import { z } from 'zod';

// ─── WorkflowName enum ──────────────────────────────────────────────────────

export const WorkflowName = z.enum(['evolve', 'tasks', 'nightly']);
export type WorkflowName = z.infer<typeof WorkflowName>;

// ─── Launch request / response ───────────────────────────────────────────────

export const WorkflowLaunchRequest = z
  .object({
    workflow: WorkflowName,
    label: z.string().nullable().optional(),
    idempotencyKey: z.uuid(),
    expectedRevision: z.string(),
  })
  .strict();
export type WorkflowLaunchRequest = z.infer<typeof WorkflowLaunchRequest>;

export const WorkflowLaunchResponse = z
  .object({
    taskId: z.string(),
    workflow: WorkflowName,
    launchedAt: z.iso.datetime(),
    destructive: z.boolean(),
    label: z.string().nullable().optional(),
  })
  .strict();
export type WorkflowLaunchResponse = z.infer<typeof WorkflowLaunchResponse>;
