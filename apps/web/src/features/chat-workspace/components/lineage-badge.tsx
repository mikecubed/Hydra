import type { JSX } from 'react';
import type { ConversationLineageState } from '../model/workspace-types.ts';

export interface LineageBadgeProps {
  readonly lineage: ConversationLineageState | null;
}

const badgeStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.35rem',
  background: 'rgba(148, 163, 184, 0.1)',
  border: '1px solid rgba(148, 163, 184, 0.15)',
  borderRadius: '0.25rem',
  padding: '0.15rem 0.5rem',
  fontSize: '0.75rem',
  color: '#94a3b8',
} as const;

const kindLabelStyle = {
  fontWeight: 600,
  textTransform: 'capitalize',
} as const;

const refStyle = {
  fontFamily: 'monospace',
  fontSize: '0.7rem',
  opacity: 0.7,
} as const;

function formatRelationshipLabel(kind: string): string {
  return kind;
}

export function LineageBadge({ lineage }: LineageBadgeProps): JSX.Element | null {
  if (lineage?.relationshipKind == null) return null;

  return (
    <span data-testid="lineage-badge" style={badgeStyle}>
      <span style={kindLabelStyle}>{formatRelationshipLabel(lineage.relationshipKind)}</span>
      {lineage.sourceConversationId != null && (
        <span style={refStyle}>{lineage.sourceConversationId}</span>
      )}
      {lineage.sourceTurnId != null && <span style={refStyle}>@{lineage.sourceTurnId}</span>}
    </span>
  );
}
