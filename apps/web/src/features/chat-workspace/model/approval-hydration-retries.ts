const DEFAULT_APPROVAL_HYDRATION_MAX_RETRIES = 3;

export function claimApprovalHydrationRetry(
  retryCounts: Map<string, number>,
  key: string,
  maxRetries = DEFAULT_APPROVAL_HYDRATION_MAX_RETRIES,
): boolean {
  const retryCount = retryCounts.get(key) ?? 0;
  if (retryCount >= maxRetries) {
    retryCounts.delete(key);
    return false;
  }

  retryCounts.set(key, retryCount + 1);
  return true;
}
