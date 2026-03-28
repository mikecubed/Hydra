/**
 * Workflow launch contracts — gateway-layer request/response types for
 * launching daemon workflows.
 */
import { z } from 'zod';
import { WorkflowLaunchRequest, WorkflowLaunchResponse } from '../workflow-launch.ts';

// ─── POST workflow launch ────────────────────────────────────────────────────

export const PostWorkflowLaunchRequest = WorkflowLaunchRequest;
export type PostWorkflowLaunchRequest = z.infer<typeof PostWorkflowLaunchRequest>;

export const PostWorkflowLaunchResponse = WorkflowLaunchResponse;
export type PostWorkflowLaunchResponse = z.infer<typeof PostWorkflowLaunchResponse>;
