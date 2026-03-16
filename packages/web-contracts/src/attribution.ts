/**
 * Attribution — identifies who produced a turn or activity entry.
 *
 * Embedded in Turns and ActivityEntries, not a standalone entity.
 * Type `agent` requires an `agentId`; `operator` and `system` do not.
 */
import { z } from 'zod';

export const AttributionType = z.enum(['operator', 'system', 'agent']);
export type AttributionType = z.infer<typeof AttributionType>;

export const Attribution = z
  .object({
    type: AttributionType,
    agentId: z.string().min(1).optional(),
    label: z.string().min(1),
  })
  .refine(
    (data) => {
      if (data.type === 'agent') return data.agentId !== undefined;
      return true;
    },
    { message: 'agentId is required when type is "agent"', path: ['agentId'] },
  );
export type Attribution = z.infer<typeof Attribution>;
