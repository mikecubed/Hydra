/**
 * Config mutation schemas — safe configuration view and mutation request/response types.
 *
 * SafeConfigView uses a z.unknown() → superRefine → pipe → strip pipeline:
 * 1. superRefine recursively rejects any key matching /(apiKey|secret|hash|password)/i
 *    in the raw input (before strip removes undeclared fields)
 * 2. pipe feeds into a stripped object schema so undeclared keys are silently removed
 */
import { z } from 'zod';

// ─── Enums ───────────────────────────────────────────────────────────────────

export const RoutingMode = z.enum(['economy', 'balanced', 'performance']);
export type RoutingMode = z.infer<typeof RoutingMode>;

export const ModelTier = z.enum(['default', 'fast', 'cheap']);
export type ModelTier = z.infer<typeof ModelTier>;

export const AgentId = z.enum(['claude', 'gemini', 'codex', 'local', 'copilot']);
export type AgentId = z.infer<typeof AgentId>;

// ─── SafeConfigView ──────────────────────────────────────────────────────────

const FORBIDDEN_KEY = /(apiKey|secret|hash|password)/i;

function hasForbiddenKey(val: unknown, path: string[] = []): string | null {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return null;
  for (const key of Object.keys(val as Record<string, unknown>)) {
    if (FORBIDDEN_KEY.test(key)) return [...path, key].join('.');
    const nested = hasForbiddenKey((val as Record<string, unknown>)[key], [...path, key]);
    if (nested !== null) return nested;
  }
  return null;
}

const SafeConfigViewInner = z
  .object({
    routing: z.object({ mode: RoutingMode }).strip(),
    models: z
      .record(
        z.string(),
        z
          .object({
            default: z.string(),
            fast: z.string().optional(),
            cheap: z.string().optional(),
            active: z.string().optional(),
          })
          .strip(),
      )
      .optional(),
    usage: z
      .object({
        dailyTokenBudget: z.record(z.string(), z.number()).optional(),
        weeklyTokenBudget: z.record(z.string(), z.number()).optional(),
      })
      .strip()
      .optional(),
  })
  .strip();

export const SafeConfigView = z
  .unknown()
  .superRefine((val, ctx) => {
    const found = hasForbiddenKey(val);
    if (found !== null) {
      ctx.addIssue({ code: 'custom', message: `Forbidden key: ${found}`, path: [found] });
    }
  })
  .pipe(SafeConfigViewInner);
export type SafeConfigView = z.infer<typeof SafeConfigViewInner>;

// ─── Mutation requests ───────────────────────────────────────────────────────

export const RoutingModeMutationRequest = z
  .object({
    mode: RoutingMode,
    expectedRevision: z.string(),
  })
  .strict();
export type RoutingModeMutationRequest = z.infer<typeof RoutingModeMutationRequest>;

export const ModelTierMutationRequest = z
  .object({
    tier: ModelTier,
    expectedRevision: z.string(),
  })
  .strict();
export type ModelTierMutationRequest = z.infer<typeof ModelTierMutationRequest>;

export const BudgetMutationRequest = z
  .object({
    modelId: z.string(),
    dailyLimit: z.int().positive().nullable(),
    weeklyLimit: z.int().positive().nullable(),
    expectedRevision: z.string(),
  })
  .strict()
  .refine((val) => !(val.dailyLimit === null && val.weeklyLimit === null), {
    message: 'At least one limit must be non-null',
  });
export type BudgetMutationRequest = z.infer<typeof BudgetMutationRequest>;

// ─── Mutation response ───────────────────────────────────────────────────────

export const ConfigMutationResponse = z
  .object({
    snapshot: SafeConfigView,
    appliedRevision: z.string(),
    timestamp: z.iso.datetime(),
  })
  .strict();
export type ConfigMutationResponse = z.infer<typeof ConfigMutationResponse>;
