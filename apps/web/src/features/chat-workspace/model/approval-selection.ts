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
