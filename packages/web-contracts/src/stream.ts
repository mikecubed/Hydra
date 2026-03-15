/**
 * StreamEvent — incremental updates produced during a streaming turn.
 *
 * Sequence numbers align with the daemon's EventRecord.seq for unified replay.
 * The kind discriminator determines the payload shape.
 */
import { z } from 'zod';

export const StreamEventKind = z.enum([
  'stream-started',
  'stream-completed',
  'stream-failed',
  'text-delta',
  'status-change',
  'activity-marker',
  'approval-prompt',
  'approval-response',
  'artifact-notice',
  'checkpoint',
  'warning',
  'error',
  'cancellation',
]);
export type StreamEventKind = z.infer<typeof StreamEventKind>;

export const StreamEvent = z.object({
  seq: z.number().int().nonnegative(),
  turnId: z.string().min(1),
  kind: StreamEventKind,
  payload: z.record(z.string(), z.unknown()),
  timestamp: z.iso.datetime(),
});
export type StreamEvent = z.infer<typeof StreamEvent>;
