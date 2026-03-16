/**
 * ActivityEntry — structured record of agent-level work within a multi-agent turn.
 *
 * Nested within a Turn, not a top-level entity.
 * Supports hierarchical nesting via parentActivityId for sub-tasks and deliberation steps.
 */
import { z } from 'zod';
import { Attribution } from './attribution.ts';

export const ActivityKind = z.enum([
  'task-started',
  'task-completed',
  'task-failed',
  'proposal',
  'vote',
  'consensus',
  'delegation',
  'checkpoint',
]);
export type ActivityKind = z.infer<typeof ActivityKind>;

export const ActivityEntry = z.object({
  id: z.string().min(1),
  attribution: Attribution,
  kind: ActivityKind,
  summary: z.string().min(1),
  detail: z.string().optional(),
  parentActivityId: z.string().min(1).optional(),
  timestamp: z.iso.datetime(),
});
export type ActivityEntry = z.infer<typeof ActivityEntry>;
