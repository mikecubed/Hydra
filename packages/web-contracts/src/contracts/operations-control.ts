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
import { OperationalControlView, ControlKind, DetailAvailability } from '../operations.ts';

export const ControlOutcome = z.enum(['accepted', 'rejected', 'stale', 'superseded']);
export type ControlOutcome = z.infer<typeof ControlOutcome>;

export const SubmitControlActionRequest = z
  .object({
    workItemId: z.string().min(1),
    controlId: z.string().min(1),
    requestedOptionId: z.string().min(1),
    expectedRevision: z.string().min(1),
    requestId: z.string().min(1).optional(),
  })
  .strict();
export type SubmitControlActionRequest = z.infer<typeof SubmitControlActionRequest>;

export const SubmitControlActionBody = SubmitControlActionRequest.omit({
  workItemId: true,
  controlId: true,
});
export type SubmitControlActionBody = z.infer<typeof SubmitControlActionBody>;

export const SubmitControlActionResponse = z
  .object({
    outcome: ControlOutcome,
    control: OperationalControlView,
    workItemId: z.string().min(1),
    resolvedAt: z.iso.datetime(),
    message: z.string().min(1).optional(),
  })
  .strict();
export type SubmitControlActionResponse = z.infer<typeof SubmitControlActionResponse>;

export const BatchControlDiscoveryRequest = z
  .object({
    workItemIds: z.array(z.string().min(1)).min(1).readonly(),
    kindFilter: ControlKind.optional(),
  })
  .strict();
export type BatchControlDiscoveryRequest = z.infer<typeof BatchControlDiscoveryRequest>;

export const WorkItemControlEntry = z
  .object({
    workItemId: z.string().min(1),
    controls: z.array(OperationalControlView).readonly(),
    availability: DetailAvailability,
  })
  .strict();
export type WorkItemControlEntry = z.infer<typeof WorkItemControlEntry>;

export const BatchControlDiscoveryResponse = z
  .object({
    items: z.array(WorkItemControlEntry).readonly(),
  })
  .strict();
export type BatchControlDiscoveryResponse = z.infer<typeof BatchControlDiscoveryResponse>;
