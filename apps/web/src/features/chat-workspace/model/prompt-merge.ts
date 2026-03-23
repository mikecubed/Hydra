import type { PromptStatus, PromptViewState } from './workspace-types.ts';

const PROMPT_STATUS_RANK: Record<PromptStatus, number> = {
  pending: 0,
  responding: 1,
  error: 2,
  stale: 3,
  unavailable: 3,
  resolved: 4,
};

function shouldPreferFallbackSummary(
  preferred: PromptViewState,
  fallback: PromptViewState,
): boolean {
  if (
    preferred.status !== 'resolved' ||
    fallback.status !== 'resolved' ||
    preferred.lastResponseSummary == null ||
    fallback.lastResponseSummary == null ||
    preferred.lastResponseSummary === fallback.lastResponseSummary
  ) {
    return false;
  }

  return fallback.allowedResponses.some(
    (choice) =>
      typeof choice !== 'string' &&
      choice.key === preferred.lastResponseSummary &&
      choice.label === fallback.lastResponseSummary,
  );
}

export function mergePromptState(
  streamPrompt: PromptViewState | null,
  restPrompt: PromptViewState | null,
): PromptViewState | null {
  if (streamPrompt == null) return restPrompt;
  if (restPrompt == null) return streamPrompt;

  if (streamPrompt.promptId === restPrompt.promptId) {
    const preserveStreamLifecycle =
      (streamPrompt.status === 'responding' || streamPrompt.status === 'error') &&
      (restPrompt.status === 'pending' || restPrompt.status === 'stale');
    const streamRank = PROMPT_STATUS_RANK[streamPrompt.status];
    const restRank = PROMPT_STATUS_RANK[restPrompt.status];
    const preferred = preserveStreamLifecycle || restRank <= streamRank ? streamPrompt : restPrompt;
    const fallback = preferred === streamPrompt ? restPrompt : streamPrompt;
    const lastResponseSummary = shouldPreferFallbackSummary(preferred, fallback)
      ? fallback.lastResponseSummary
      : (preferred.lastResponseSummary ?? fallback.lastResponseSummary);

    return {
      ...preferred,
      allowedResponses:
        preferred.allowedResponses.length > 0
          ? preferred.allowedResponses
          : fallback.allowedResponses,
      contextBlocks:
        preferred.contextBlocks.length > 0 ? preferred.contextBlocks : fallback.contextBlocks,
      lastResponseSummary,
      errorMessage: preferred.errorMessage ?? fallback.errorMessage,
    };
  }

  return streamPrompt;
}
