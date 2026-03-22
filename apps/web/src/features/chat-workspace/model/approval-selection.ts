/**
 * Deterministic selection of the best approval per turn when the daemon
 * returns multiple approvals for the same turnId (e.g. stale + pending).
 *
 * Rules (highest priority first):
 *   1. Prefer status 'pending' over 'stale'.
 *   2. Within the same status, prefer the newest createdAt.
 *   3. If timestamps tie or are invalid, fall back to lexicographic id compare.
 */
import type { ApprovalRequest } from '@hydra/web-contracts';

import { mergePromptState } from './workspace-reducer.ts';
import type { PromptViewState } from './workspace-types.ts';

const STATUS_PRIORITY: Record<string, number> = {
  pending: 0,
  stale: 1,
};

function statusPriority(status: string): number {
  return STATUS_PRIORITY[status] ?? 2;
}

/**
 * Compare two approvals – negative means `a` wins, positive means `b` wins.
 */
function compareApprovals(a: ApprovalRequest, b: ApprovalRequest): number {
  const statusDiff = statusPriority(a.status) - statusPriority(b.status);
  if (statusDiff !== 0) return statusDiff;

  const aTime = new Date(a.createdAt).getTime();
  const bTime = new Date(b.createdAt).getTime();
  const aValid = Number.isFinite(aTime);
  const bValid = Number.isFinite(bTime);

  if (aValid && bValid && aTime !== bTime) {
    // Newer (larger timestamp) wins → sort descending
    return bTime - aTime;
  }

  // Both invalid, or exact tie → stable fallback on id
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Given a flat list of approvals (possibly several per turn), return a Map
 * of turnId → single best approval.
 */
export function pickBestApprovalPerTurn(
  approvals: readonly ApprovalRequest[],
): Map<string, ApprovalRequest> {
  const result = new Map<string, ApprovalRequest>();

  for (const approval of approvals) {
    const existing = result.get(approval.turnId);
    if (existing == null || compareApprovals(approval, existing) < 0) {
      result.set(approval.turnId, approval);
    }
  }

  return result;
}

/**
 * REST approval hydration may restore a different prompt cycle for the same
 * turn, but it should not blindly clobber a newer stream-owned prompt. Only
 * replace a different promptId when REST is restoring a more actionable state
 * over an older stale/unavailable prompt. For the same promptId, preserve the
 * existing mergePromptState behavior so richer stream-owned lifecycle state
 * survives.
 */
export function selectHydratedApprovalPrompt(
  existingPrompt: PromptViewState | null,
  restPrompt: PromptViewState,
): PromptViewState {
  if (existingPrompt == null) {
    return restPrompt;
  }

  if (existingPrompt.promptId !== restPrompt.promptId) {
    if (
      restPrompt.status === 'pending' &&
      (existingPrompt.status === 'stale' || existingPrompt.status === 'unavailable')
    ) {
      return restPrompt;
    }

    return existingPrompt;
  }

  return mergePromptState(existingPrompt, restPrompt) ?? restPrompt;
}
