/**
 * PromptControlBar — actionable response buttons for a pending prompt.
 *
 * Renders the allowed response options as buttons. Only mounted when
 * the prompt is actionable (status === 'pending'). The parent PromptCard
 * guards this — ControlBar assumes it's in an actionable context.
 */

import type { JSX } from 'react';

export interface PromptControlBarProps {
  readonly promptId: string;
  readonly allowedResponses: readonly string[];
  readonly onRespond: (promptId: string, response: string) => void;
}

const barStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.4rem',
  marginTop: '0.15rem',
} as const;

const buttonStyle = {
  border: '1px solid rgba(148, 163, 184, 0.3)',
  borderRadius: '0.375rem',
  background: 'rgba(30, 41, 59, 0.85)',
  color: 'inherit',
  cursor: 'pointer',
  padding: '0.35rem 0.65rem',
  fontSize: '0.8rem',
  fontWeight: 500,
  transition: 'border-color 0.15s, background 0.15s',
} as const;

export function PromptControlBar({
  promptId,
  allowedResponses,
  onRespond,
}: PromptControlBarProps): JSX.Element {
  return (
    <div style={barStyle} data-testid="prompt-actions" role="group" aria-label="Response options">
      {allowedResponses.map((response) => (
        <button
          key={response}
          type="button"
          style={buttonStyle}
          data-testid={`prompt-action-${response}`}
          onClick={() => {
            onRespond(promptId, response);
          }}
        >
          {response}
        </button>
      ))}
    </div>
  );
}
