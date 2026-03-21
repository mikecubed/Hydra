/**
 * PromptCard — inline prompt presentation within a transcript turn.
 *
 * Renders the prompt's context blocks, status indicator, and response
 * controls (via ControlBar). Only pending prompts expose actionable
 * controls; all other states show non-actionable messaging.
 */

import type { JSX } from 'react';
import type { ContentBlockState, PromptViewState } from '../model/workspace-types.ts';
import { getPromptStatusLabel, isPromptActionable } from '../model/prompt-helpers.ts';
import { SafeText } from '../render/safe-text.tsx';
import { PromptControlBar } from './control-bar.tsx';

// ─── Props ──────────────────────────────────────────────────────────────────

export interface PromptCardProps {
  readonly prompt: PromptViewState;
  readonly onRespond?: (promptId: string, response: string) => void;
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const baseCardStyle = {
  borderRadius: '0.375rem',
  padding: '0.5rem 0.75rem',
  fontSize: '0.85rem',
  display: 'grid',
  gap: '0.4rem',
} as const;

const pendingStyle = {
  ...baseCardStyle,
  border: '1px solid rgba(251, 191, 36, 0.25)',
  background: 'rgba(251, 191, 36, 0.05)',
} as const;

const respondingStyle = {
  ...baseCardStyle,
  border: '1px solid rgba(56, 189, 248, 0.25)',
  background: 'rgba(56, 189, 248, 0.05)',
} as const;

const resolvedStyle = {
  ...baseCardStyle,
  border: '1px solid rgba(74, 222, 128, 0.25)',
  background: 'rgba(74, 222, 128, 0.05)',
} as const;

const staleStyle = {
  ...baseCardStyle,
  border: '1px solid rgba(148, 163, 184, 0.2)',
  background: 'rgba(148, 163, 184, 0.03)',
} as const;

const errorStyle = {
  ...baseCardStyle,
  border: '1px solid rgba(248, 113, 113, 0.25)',
  background: 'rgba(248, 113, 113, 0.05)',
} as const;

const labelColors: Record<string, string> = {
  pending: '#fbbf24',
  responding: '#38bdf8',
  resolved: '#4ade80',
  stale: '#94a3b8',
  unavailable: '#94a3b8',
  error: '#f87171',
};

function resolveCardStyle(status: string): Record<string, string | number> {
  switch (status) {
    case 'pending':
      return pendingStyle;
    case 'responding':
      return respondingStyle;
    case 'resolved':
      return resolvedStyle;
    case 'error':
      return errorStyle;
    default:
      return staleStyle;
  }
}

const labelStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.4rem',
  fontSize: '0.75rem',
  fontWeight: 600,
} as const;

const contextBlockStyle = {
  margin: 0,
  lineHeight: 1.6,
  fontSize: '0.8rem',
  color: '#cbd5e1',
} as const;

const summaryStyle = {
  marginTop: '0.1rem',
  fontSize: '0.8rem',
  color: '#cbd5e1',
} as const;

const errorMessageStyle = {
  marginTop: '0.1rem',
  fontSize: '0.8rem',
  color: '#fca5a5',
} as const;

// ─── Sub-components ─────────────────────────────────────────────────────────

function ContextBlock({ block }: { readonly block: ContentBlockState }): JSX.Element | null {
  if (block.text == null) return null;

  if (block.kind === 'code') {
    return (
      <pre
        style={{
          margin: 0,
          padding: '0.4rem 0.6rem',
          background: 'rgba(0, 0, 0, 0.3)',
          borderRadius: '0.25rem',
          fontSize: '0.8rem',
          overflowX: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {block.text}
      </pre>
    );
  }

  return (
    <p style={contextBlockStyle}>
      <SafeText text={block.text} />
    </p>
  );
}

// ─── PromptCard ─────────────────────────────────────────────────────────────

export function PromptCard({ prompt, onRespond }: PromptCardProps): JSX.Element {
  const { status, contextBlocks, allowedResponses, lastResponseSummary, errorMessage } = prompt;
  const actionable = isPromptActionable(status);
  const statusLabel = getPromptStatusLabel(status);
  const labelColor = labelColors[status] ?? '#94a3b8';

  return (
    <div
      style={resolveCardStyle(status)}
      data-testid="approval-prompt"
      data-prompt-status={status}
      role="region"
      aria-label={statusLabel}
    >
      {/* Status label */}
      <div style={{ ...labelStyle, color: labelColor }}>
        <span>{statusLabel}</span>
      </div>

      {/* Context blocks */}
      {contextBlocks.length > 0 && (
        <div style={{ display: 'grid', gap: '0.25rem' }} data-testid="prompt-context">
          {contextBlocks.map((block) => (
            <ContextBlock key={block.blockId} block={block} />
          ))}
        </div>
      )}

      {/* Response actions — only when pending */}
      {actionable && allowedResponses.length > 0 && onRespond != null && (
        <PromptControlBar
          promptId={prompt.promptId}
          allowedResponses={allowedResponses}
          onRespond={onRespond}
        />
      )}

      {/* Responding spinner */}
      {status === 'responding' && (
        <div style={{ fontSize: '0.8rem', color: '#38bdf8' }} data-testid="prompt-responding">
          Submitting response…
        </div>
      )}

      {/* Resolved summary */}
      {status === 'resolved' && lastResponseSummary != null && (
        <div style={summaryStyle} data-testid="prompt-summary">
          Response: <SafeText text={lastResponseSummary} />
        </div>
      )}

      {/* Error message */}
      {status === 'error' && errorMessage != null && (
        <div style={errorMessageStyle} data-testid="prompt-error" role="alert">
          <SafeText text={errorMessage} />
        </div>
      )}

      {/* Stale/unavailable messaging */}
      {status === 'stale' && (
        <div style={{ fontSize: '0.8rem', color: '#94a3b8' }} data-testid="prompt-stale-message">
          This approval is no longer actionable.
        </div>
      )}
      {status === 'unavailable' && (
        <div
          style={{ fontSize: '0.8rem', color: '#94a3b8' }}
          data-testid="prompt-unavailable-message"
        >
          This approval is no longer available.
        </div>
      )}
    </div>
  );
}
