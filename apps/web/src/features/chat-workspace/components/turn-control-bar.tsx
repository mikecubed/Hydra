/**
 * TurnControlBar — per-turn action buttons for cancel, retry, branch, follow-up.
 *
 * Parallel to PromptControlBar (which owns prompt-response buttons). This
 * component is mounted inside TranscriptTurn and driven by the existing
 * selectCanCancel / selectCanRetry / selectCanBranch / selectCanFollowUp
 * selectors from T034.
 *
 * Design rules:
 *   - Cancel is exclusive: when a turn is cancellable no other actions show.
 *   - Retry and branch are peers for completed/failed turns.
 *   - Follow-up only appears on the latest completed turn.
 *   - All visibility is store-driven (no local component state for eligibility).
 */

import type { JSX } from 'react';
import { resolveTurnActions, hasTurnActions } from './turn-control-logic.ts';
import type { TurnActionFlags } from './turn-control-logic.ts';

// ─── Props ──────────────────────────────────────────────────────────────────

export interface TurnControlBarProps extends TurnActionFlags {
  readonly entryId: string;
  readonly turnId: string;
  readonly onCancel: (turnId: string) => void;
  readonly onRetry: (turnId: string) => void;
  readonly onBranch: (turnId: string) => void;
  readonly onFollowUp: (turnId: string) => void;
}

// Re-export for external consumers
export type { TurnActionSet, TurnActionFlags } from './turn-control-logic.ts';
export { resolveTurnActions, hasTurnActions } from './turn-control-logic.ts';

// ─── Styles ─────────────────────────────────────────────────────────────────

const barStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.4rem',
  marginTop: '0.25rem',
} as const;

const buttonBaseStyle = {
  border: '1px solid rgba(148, 163, 184, 0.3)',
  borderRadius: '0.375rem',
  background: 'rgba(30, 41, 59, 0.85)',
  color: 'inherit',
  cursor: 'pointer',
  padding: '0.3rem 0.6rem',
  fontSize: '0.78rem',
  fontWeight: 500,
  transition: 'border-color 0.15s, background 0.15s',
} as const;

const cancelButtonStyle = {
  ...buttonBaseStyle,
  borderColor: 'rgba(248, 113, 113, 0.4)',
  color: '#fca5a5',
} as const;

const followUpButtonStyle = {
  ...buttonBaseStyle,
  borderColor: 'rgba(56, 189, 248, 0.3)',
  color: '#7dd3fc',
} as const;

// ─── Component ──────────────────────────────────────────────────────────────

export function TurnControlBar(props: TurnControlBarProps): JSX.Element | null {
  const actions = resolveTurnActions(props);

  if (!hasTurnActions(actions)) return null;

  return (
    <div style={barStyle} data-testid="turn-actions" role="group" aria-label="Turn control actions">
      {actions.cancel && (
        <button
          type="button"
          style={cancelButtonStyle}
          data-testid="turn-action-cancel"
          onClick={() => {
            props.onCancel(props.turnId);
          }}
        >
          Cancel
        </button>
      )}

      {actions.retry && (
        <button
          type="button"
          style={buttonBaseStyle}
          data-testid="turn-action-retry"
          onClick={() => {
            props.onRetry(props.turnId);
          }}
        >
          Retry
        </button>
      )}

      {actions.branch && (
        <button
          type="button"
          style={buttonBaseStyle}
          data-testid="turn-action-branch"
          onClick={() => {
            props.onBranch(props.turnId);
          }}
        >
          Branch
        </button>
      )}

      {actions.followUp && (
        <button
          type="button"
          style={followUpButtonStyle}
          data-testid="turn-action-follow-up"
          onClick={() => {
            props.onFollowUp(props.turnId);
          }}
        >
          Follow up
        </button>
      )}
    </div>
  );
}
