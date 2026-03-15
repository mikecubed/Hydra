/**
 * Multi-Agent Activity contracts — get activity entries, filter by agent.
 */
import { z } from 'zod';
import { ActivityEntry } from '../activity.ts';

// ── GetActivityEntries ───────────────────────────────────────────────────────

export const GetActivityEntriesRequest = z.object({
  turnId: z.string().min(1),
});
export type GetActivityEntriesRequest = z.infer<typeof GetActivityEntriesRequest>;

export const GetActivityEntriesResponse = z.object({
  activities: z.array(ActivityEntry),
});
export type GetActivityEntriesResponse = z.infer<typeof GetActivityEntriesResponse>;

// ── FilterActivityByAgent ────────────────────────────────────────────────────

export const FilterActivityByAgentRequest = z.object({
  turnId: z.string().min(1),
  agentId: z.string().min(1),
});
export type FilterActivityByAgentRequest = z.infer<typeof FilterActivityByAgentRequest>;

export const FilterActivityByAgentResponse = z.object({
  activities: z.array(ActivityEntry),
});
export type FilterActivityByAgentResponse = z.infer<typeof FilterActivityByAgentResponse>;
