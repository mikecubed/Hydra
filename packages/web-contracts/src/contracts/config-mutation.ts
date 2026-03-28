/**
 * Config mutation contracts — gateway-layer request/response types for
 * reading safe config and applying config mutations.
 */
import { z } from 'zod';
import {
  SafeConfigView,
  RoutingModeMutationRequest,
  AgentId,
  ModelTier,
  BudgetMutationRequest,
  ConfigMutationResponse,
} from '../config-mutation.ts';

// ─── GET safe config ─────────────────────────────────────────────────────────

export const GetSafeConfigResponse = z
  .object({
    config: SafeConfigView,
    revision: z.string(),
  })
  .strict();
export type GetSafeConfigResponse = z.infer<typeof GetSafeConfigResponse>;

// ─── PATCH routing mode ──────────────────────────────────────────────────────

export const PatchRoutingModeRequest = RoutingModeMutationRequest;
export type PatchRoutingModeRequest = z.infer<typeof PatchRoutingModeRequest>;

export const PatchRoutingModeResponse = ConfigMutationResponse;
export type PatchRoutingModeResponse = z.infer<typeof PatchRoutingModeResponse>;

// ─── PATCH model tier ────────────────────────────────────────────────────────

export const PatchModelTierRequest = z
  .object({
    agent: AgentId,
    tier: ModelTier,
    expectedRevision: z.string(),
  })
  .strict();
export type PatchModelTierRequest = z.infer<typeof PatchModelTierRequest>;

export const PatchModelTierResponse = ConfigMutationResponse;
export type PatchModelTierResponse = z.infer<typeof PatchModelTierResponse>;

// ─── PATCH budget ────────────────────────────────────────────────────────────

export const PatchBudgetRequest = BudgetMutationRequest;
export type PatchBudgetRequest = z.infer<typeof PatchBudgetRequest>;

export const PatchBudgetResponse = ConfigMutationResponse;
export type PatchBudgetResponse = z.infer<typeof PatchBudgetResponse>;
