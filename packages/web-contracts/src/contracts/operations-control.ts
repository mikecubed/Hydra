/**
 * Operations Control contracts — daemon-authorized control requests and results.
 *
 * Controls are limited to safe, daemon-authorized, work-item-scoped routing,
 * mode, agent, and council-related actions discovered through the read surface.
 * The daemon determines eligibility, concurrency checks, and final outcomes.
 *
 * Optimistic concurrency: every mutation carries an expectedRevision token
 * from the most recent read. The daemon rejects stale requests rather than
 * silently applying them.
 */
import { z } from 'zod';
import { OperationalControlView, ControlKind, DataAvailability } from '../operations.ts';

// ── ControlOutcome ───────────────────────────────────────────────────────────

/** Authoritative outcome of a control request — not merely acceptance of receipt. */
export const ControlOutcome = z.enum(['accepted', 'rejected', 'stale', 'superseded']);
export type ControlOutcome = z.infer<typeof ControlOutcome>;

// ── SubmitControlAction ──────────────────────────────────────────────────────
//
// Gateway route: POST /operations/work-items/:workItemId/controls/:controlId
// Sends a daemon-authorized control action for a specific work item and control.

export const SubmitControlActionRequest = z.object({
  workItemId: z.string().min(1),
  controlId: z.string().min(1),
  /** The option the operator selected from the control's available options. */
  requestedOptionId: z.string().min(1),
  /** Concurrency token from the most recent read of this control. */
  expectedRevision: z.string().min(1),
  /** Optional idempotency/tracing key for duplicate detection. */
  requestId: z.string().min(1).optional(),
});
export type SubmitControlActionRequest = z.infer<typeof SubmitControlActionRequest>;

export const SubmitControlActionResponse = z.object({
  outcome: ControlOutcome,
  /** Updated control view reflecting the authoritative post-mutation state. */
  control: OperationalControlView,
  workItemId: z.string().min(1),
  resolvedAt: z.iso.datetime(),
  /** Human-readable explanation when the outcome is not 'accepted'. */
  message: z.string().optional(),
});
export type SubmitControlActionResponse = z.infer<typeof SubmitControlActionResponse>;

// ── BatchControlDiscovery ────────────────────────────────────────────────────
//
// Gateway route: POST /operations/controls/discover
// Retrieves the current control affordances for one or more work items in a
// single round-trip. Useful when the browser needs to render actionable state
// for multiple items without N+1 detail fetches.

export const BatchControlDiscoveryRequest = z.object({
  workItemIds: z.array(z.string().min(1)).min(1),
  /** Optional filter to a specific control kind. */
  kindFilter: ControlKind.optional(),
});
export type BatchControlDiscoveryRequest = z.infer<typeof BatchControlDiscoveryRequest>;

/** Controls grouped by work item. */
export const WorkItemControlEntry = z.object({
  workItemId: z.string().min(1),
  controls: z.array(OperationalControlView),
  availability: DataAvailability,
});
export type WorkItemControlEntry = z.infer<typeof WorkItemControlEntry>;

export const BatchControlDiscoveryResponse = z.object({
  items: z.array(WorkItemControlEntry),
});
export type BatchControlDiscoveryResponse = z.infer<typeof BatchControlDiscoveryResponse>;
