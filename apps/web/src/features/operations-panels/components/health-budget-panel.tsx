/**
 * Health and budget panel — displays global daemon health status and budget
 * posture within the operations sidebar.
 *
 * Renders health status (healthy/degraded/unavailable/recovering) and budget
 * severity (normal/warning/exceeded/unavailable) from the daemon snapshot.
 * Returns null when both health and budget are absent, so the panel shell can
 * skip rendering the slot entirely.
 */
import type { CSSProperties, JSX } from 'react';
import type {
  BudgetSeverity,
  BudgetStatusView,
  DaemonHealthStatus,
  DaemonHealthView,
  HealthDetailsAvailability,
} from '@hydra/web-contracts';

// ─── Health status colour map ───────────────────────────────────────────────

const healthStatusColors: Record<DaemonHealthStatus, { text: string; border: string; bg: string }> =
  {
    healthy: {
      text: '#4ade80',
      border: 'rgba(74, 222, 128, 0.25)',
      bg: 'rgba(74, 222, 128, 0.05)',
    },
    degraded: {
      text: '#fbbf24',
      border: 'rgba(251, 191, 36, 0.25)',
      bg: 'rgba(251, 191, 36, 0.05)',
    },
    unavailable: {
      text: '#f87171',
      border: 'rgba(248, 113, 113, 0.25)',
      bg: 'rgba(248, 113, 113, 0.05)',
    },
    recovering: {
      text: '#38bdf8',
      border: 'rgba(56, 189, 248, 0.25)',
      bg: 'rgba(56, 189, 248, 0.05)',
    },
  };

// ─── Budget severity colour map ─────────────────────────────────────────────

const budgetSeverityColors: Record<BudgetSeverity, { text: string; border: string; bg: string }> = {
  normal: {
    text: '#4ade80',
    border: 'rgba(74, 222, 128, 0.25)',
    bg: 'rgba(74, 222, 128, 0.05)',
  },
  warning: {
    text: '#fbbf24',
    border: 'rgba(251, 191, 36, 0.25)',
    bg: 'rgba(251, 191, 36, 0.05)',
  },
  exceeded: {
    text: '#f87171',
    border: 'rgba(248, 113, 113, 0.25)',
    bg: 'rgba(248, 113, 113, 0.05)',
  },
  unavailable: {
    text: '#94a3b8',
    border: 'rgba(148, 163, 184, 0.2)',
    bg: 'rgba(148, 163, 184, 0.03)',
  },
};

// ─── Shared styles ──────────────────────────────────────────────────────────

const panelStyle: CSSProperties = {
  display: 'grid',
  gap: '0.5rem',
};

const sectionStyle: CSSProperties = {
  display: 'grid',
  gap: '0.25rem',
  padding: '0.5rem 0.75rem',
  borderRadius: '0.375rem',
};

const headingStyle: CSSProperties = {
  margin: 0,
  fontSize: '0.8rem',
  fontWeight: 600,
  color: '#e2e8f0',
};

const badgeBase: CSSProperties = {
  fontSize: '0.65rem',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  padding: '0.1rem 0.35rem',
  borderRadius: '0.2rem',
  display: 'inline-block',
};

const metaStyle: CSSProperties = {
  fontSize: '0.75rem',
  color: '#94a3b8',
};

const hintStyle: CSSProperties = {
  fontSize: '0.7rem',
  color: '#64748b',
  fontStyle: 'italic',
};

// ─── Formatters ─────────────────────────────────────────────────────────────

function formatNumber(value: number): string {
  return value.toLocaleString();
}

// ─── Health section ─────────────────────────────────────────────────────────

function HealthSection({ health }: { readonly health: DaemonHealthView }): JSX.Element {
  const palette = healthStatusColors[health.status];
  const resolvedSectionStyle: CSSProperties = {
    ...sectionStyle,
    border: `1px solid ${palette.border}`,
    background: palette.bg,
  };

  return (
    <div style={resolvedSectionStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={headingStyle}>Daemon Health</span>
        <span
          data-testid="health-status"
          style={{
            ...badgeBase,
            color: palette.text,
            background: palette.bg,
            border: `1px solid ${palette.border}`,
          }}
        >
          {health.status}
        </span>
      </div>
      {health.message != null && (
        <span data-testid="health-message" style={metaStyle}>
          {health.message}
        </span>
      )}
      <HealthAvailabilityNotice availability={health.detailsAvailability} />
    </div>
  );
}

function HealthAvailabilityNotice({
  availability,
}: {
  readonly availability: HealthDetailsAvailability;
}): JSX.Element | null {
  if (availability === 'ready') {
    return null;
  }

  return (
    <span data-testid="health-availability" style={hintStyle}>
      Health details {availability}
    </span>
  );
}

// ─── Budget section ─────────────────────────────────────────────────────────

function BudgetSection({ budget }: { readonly budget: BudgetStatusView }): JSX.Element {
  const palette = budgetSeverityColors[budget.status];
  const resolvedSectionStyle: CSSProperties = {
    ...sectionStyle,
    border: `1px solid ${palette.border}`,
    background: palette.bg,
  };

  const unitSuffix = budget.unit === null ? '' : ` ${budget.unit}`;
  let usageBreakdown: JSX.Element | null = null;
  const used = budget.used;
  const limit = budget.limit;

  if (used !== null && limit !== null) {
    const formattedUsed = formatNumber(used);
    const formattedLimit = formatNumber(limit);
    usageBreakdown = (
      <span data-testid="budget-usage" style={metaStyle}>
        {formattedUsed} / {formattedLimit}
        {unitSuffix}
      </span>
    );
  }

  return (
    <div style={resolvedSectionStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={headingStyle}>Budget</span>
        <span
          data-testid="budget-status"
          style={{
            ...badgeBase,
            color: palette.text,
            background: palette.bg,
            border: `1px solid ${palette.border}`,
          }}
        >
          {budget.status}
        </span>
      </div>
      <span data-testid="budget-summary" style={metaStyle}>
        {budget.summary}
      </span>
      {usageBreakdown}
      {budget.complete ? null : (
        <span data-testid="budget-incomplete" style={hintStyle}>
          Budget data incomplete
        </span>
      )}
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export interface HealthBudgetPanelProps {
  readonly health: DaemonHealthView | null;
  readonly budget: BudgetStatusView | null;
}

export function HealthBudgetPanel({ health, budget }: HealthBudgetPanelProps): JSX.Element | null {
  if (health == null && budget == null) {
    return null;
  }

  return (
    <div style={panelStyle} data-testid="health-budget-panel">
      {health != null && <HealthSection health={health} />}
      {budget != null && <BudgetSection budget={budget} />}
    </div>
  );
}
