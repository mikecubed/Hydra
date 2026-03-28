/**
 * Mutations request validators.
 *
 * Each validator uses the relevant Zod schema's safeParse(). Never throws;
 * returns { ok: false, message } on parse failure.
 */
import {
  PatchRoutingModeRequest,
  PatchModelTierRequest,
  PatchBudgetRequest,
  PostWorkflowLaunchRequest,
  GetAuditRequest,
} from '@hydra/web-contracts';

export type ValidationSuccess<T> = { ok: true; data: T };
export type ValidationFailure = { ok: false; message: string };
export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

export function validateRoutingModeBody(body: unknown): ValidationResult<PatchRoutingModeRequest> {
  const result = PatchRoutingModeRequest.safeParse(body);
  if (!result.success) {
    return { ok: false, message: result.error.message };
  }
  return { ok: true, data: result.data };
}

export function validateModelTierBody(
  agent: string,
  body: unknown,
): ValidationResult<PatchModelTierRequest> {
  const merged = typeof body === 'object' && body !== null ? { ...body, agent } : { agent };
  const result = PatchModelTierRequest.safeParse(merged);
  if (!result.success) {
    return { ok: false, message: result.error.message };
  }
  return { ok: true, data: result.data };
}

export function validateBudgetBody(body: unknown): ValidationResult<PatchBudgetRequest> {
  const result = PatchBudgetRequest.safeParse(body);
  if (!result.success) {
    return { ok: false, message: result.error.message };
  }
  return { ok: true, data: result.data };
}

export function validateWorkflowLaunchBody(
  body: unknown,
): ValidationResult<PostWorkflowLaunchRequest> {
  const result = PostWorkflowLaunchRequest.safeParse(body);
  if (!result.success) {
    return { ok: false, message: result.error.message };
  }
  return { ok: true, data: result.data };
}

export function validateAuditParams(query: unknown): ValidationResult<GetAuditRequest> {
  const result = GetAuditRequest.safeParse(query);
  if (!result.success) {
    return { ok: false, message: result.error.message };
  }
  return { ok: true, data: result.data };
}
