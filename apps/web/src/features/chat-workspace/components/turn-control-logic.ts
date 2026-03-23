/**
 * Pure logic for turn control bar visibility and action resolution.
 *
 * Separated from the React component (turn-control-bar.tsx) so that
 * node:test can import without JSX/tsx loader support.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TurnActionFlags {
  readonly canCancel: boolean;
  readonly canRetry: boolean;
  readonly canBranch: boolean;
  readonly canFollowUp: boolean;
}

export interface TurnActionSet {
  readonly cancel: boolean;
  readonly retry: boolean;
  readonly branch: boolean;
  readonly followUp: boolean;
}

// ─── Logic ──────────────────────────────────────────────────────────────────

/**
 * Compute which actions are visible for a turn.
 *
 * Cancel is exclusive — a running turn only exposes cancel.
 * Completed/failed turns may expose retry, branch, follow-up.
 */
export function resolveTurnActions(flags: TurnActionFlags): TurnActionSet {
  if (flags.canCancel) {
    return { cancel: true, retry: false, branch: false, followUp: false };
  }

  return {
    cancel: false,
    retry: flags.canRetry,
    branch: flags.canBranch,
    followUp: flags.canFollowUp,
  };
}

export function hasTurnActions(actions: TurnActionSet): boolean {
  return actions.cancel || actions.retry || actions.branch || actions.followUp;
}
