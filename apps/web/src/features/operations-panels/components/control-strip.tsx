/**
 * Control strip — renders discovered operational controls for a work item.
 *
 * Displays each control as a labeled row with option buttons. Enforces
 * authority and availability constraints: forbidden/unavailable/pending
 * controls disable interaction, and outcome badges (accepted/rejected/stale/
 * superseded) are displayed when the daemon resolves a control action.
 *
 * The browser is non-authoritative: pending UI is shown optimistically,
 * but all final state comes from daemon refetch/reconciliation.
 */
import type { CSSProperties, JSX } from 'react';
import type {
  ControlAvailability,
  OperationalControlView,
} from '@hydra/web-contracts';

export interface ControlStripProps {
  readonly controls: readonly OperationalControlView[];
  readonly hasPendingControl: boolean;
  readonly onSubmitControl: (
    controlId: string,
    optionId: string,
    expectedRevision: string,
  ) => void;
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const stripStyle: CSSProperties = {
  display: 'grid',
  gap: '0.5rem',
  padding: '0.5rem 0',
};

const controlRowStyle: CSSProperties = {
  display: 'grid',
  gap: '0.25rem',
};

const labelRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
};

const controlLabelStyle: CSSProperties = {
  fontWeight: 600,
  fontSize: '0.8rem',
};

const badgeBase: CSSProperties = {
  fontSize: '0.65rem',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  padding: '0.1rem 0.35rem',
  borderRadius: '0.2rem',
};

const availabilityBadgeStyles: Partial<Record<ControlAvailability, CSSProperties>> = {
  accepted: {
    ...badgeBase,
    color: '#4ade80',
    background: 'rgba(74, 222, 128, 0.1)',
  },
  rejected: {
    ...badgeBase,
    color: '#f87171',
    background: 'rgba(248, 113, 113, 0.1)',
  },
  stale: {
    ...badgeBase,
    color: '#fbbf24',
    background: 'rgba(251, 191, 36, 0.1)',
  },
  superseded: {
    ...badgeBase,
    color: '#94a3b8',
    background: 'rgba(148, 163, 184, 0.1)',
  },
  pending: {
    ...badgeBase,
    color: '#38bdf8',
    background: 'rgba(56, 189, 248, 0.1)',
  },
};

const optionRowStyle: CSSProperties = {
  display: 'flex',
  gap: '0.35rem',
  flexWrap: 'wrap',
};

const optionBtnBase: CSSProperties = {
  appearance: 'none',
  font: 'inherit',
  fontSize: '0.75rem',
  padding: '0.2rem 0.5rem',
  borderRadius: '0.25rem',
  cursor: 'pointer',
  border: '1px solid rgba(148, 163, 184, 0.2)',
  background: 'rgba(15, 23, 42, 0.4)',
  color: '#e2e8f0',
};

const optionBtnSelected: CSSProperties = {
  ...optionBtnBase,
  border: '1px solid rgba(56, 189, 248, 0.5)',
  background: 'rgba(56, 189, 248, 0.1)',
  color: '#38bdf8',
};

const optionBtnDisabled: CSSProperties = {
  ...optionBtnBase,
  cursor: 'not-allowed',
  opacity: 0.5,
};

const reasonStyle: CSSProperties = {
  fontSize: '0.7rem',
  color: '#94a3b8',
  fontStyle: 'italic',
};

const pendingLabelStyle: CSSProperties = {
  fontSize: '0.7rem',
  color: '#fbbf24',
  fontStyle: 'italic',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function isInteractive(control: OperationalControlView, hasPending: boolean): boolean {
  if (hasPending) return false;
  return control.availability === 'actionable' && control.authority === 'granted';
}

const OUTCOME_AVAILABILITIES = new Set<ControlAvailability>([
  'accepted',
  'rejected',
  'stale',
  'superseded',
]);

function AvailabilityBadge({
  availability,
}: {
  readonly availability: ControlAvailability;
}): JSX.Element | null {
  const style = availabilityBadgeStyles[availability];
  if (style == null) return null;
  return <span style={style}>{availability}</span>;
}

function ControlItem({
  control,
  hasPendingControl,
  onSubmitControl,
}: {
  readonly control: OperationalControlView;
  readonly hasPendingControl: boolean;
  readonly onSubmitControl: ControlStripProps['onSubmitControl'];
}): JSX.Element {
  const interactive = isInteractive(control, hasPendingControl);
  const showBadge = OUTCOME_AVAILABILITIES.has(control.availability);

  return (
    <div style={controlRowStyle} data-testid={`control-item-${control.controlId}`}>
      <div style={labelRowStyle}>
        <span style={controlLabelStyle}>{control.label}</span>
        {showBadge && <AvailabilityBadge availability={control.availability} />}
      </div>
      {control.options.length > 0 && (
        <div style={optionRowStyle}>
          {control.options.map((option) => {
            const isDisabled = !interactive || option.selected || !option.available;

            let resolvedStyle = optionBtnBase;
            if (isDisabled) resolvedStyle = optionBtnDisabled;
            else if (option.selected) resolvedStyle = optionBtnSelected;

            return (
              <button
                key={option.optionId}
                type="button"
                disabled={isDisabled}
                aria-pressed={option.selected}
                style={option.selected ? optionBtnSelected : resolvedStyle}
                onClick={() => {
                  if (!option.selected && interactive && control.expectedRevision != null) {
                    onSubmitControl(control.controlId, option.optionId, control.expectedRevision);
                  }
                }}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      )}
      {control.reason != null && <span style={reasonStyle}>{control.reason}</span>}
      {hasPendingControl && <span style={pendingLabelStyle}>Control pending</span>}
    </div>
  );
}

// ─── ControlStrip ───────────────────────────────────────────────────────────

export function ControlStrip({
  controls,
  hasPendingControl,
  onSubmitControl,
}: ControlStripProps): JSX.Element | null {
  if (controls.length === 0) return null;

  return (
    <div data-testid="control-strip" style={stripStyle}>
      {controls.map((control) => (
        <ControlItem
          key={control.controlId}
          control={control}
          hasPendingControl={hasPendingControl}
          onSubmitControl={onSubmitControl}
        />
      ))}
    </div>
  );
}
