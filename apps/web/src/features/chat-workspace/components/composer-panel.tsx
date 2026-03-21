import type { JSX, KeyboardEvent } from 'react';
import type { DraftSubmitState } from '../model/workspace-store.ts';

export interface ComposerPanelProps {
  readonly draftText: string;
  readonly submitState: DraftSubmitState;
  readonly validationMessage: string | null;
  readonly canSubmit: boolean;
  readonly policyLabel: string;
  readonly onDraftChange: (text: string) => void;
  readonly onSubmit: () => void;
}

const textareaStyle = {
  width: '100%',
  minHeight: '4rem',
  resize: 'vertical' as const,
  fontFamily: 'inherit',
  fontSize: 'inherit',
  padding: '0.5rem',
  borderRadius: '0.375rem',
  border: '1px solid rgba(148, 163, 184, 0.3)',
  background: 'rgba(15, 23, 42, 0.4)',
  color: 'inherit',
  boxSizing: 'border-box' as const,
};

const buttonStyle = {
  padding: '0.5rem 1.25rem',
  borderRadius: '0.375rem',
  border: 'none',
  fontWeight: 600,
  cursor: 'pointer',
  fontSize: 'inherit',
};

const errorStyle = {
  color: '#f87171',
  fontSize: '0.875rem',
  margin: 0,
};

const policyStyle = {
  color: 'rgba(148, 163, 184, 0.8)',
  fontSize: '0.8125rem',
  margin: 0,
};

export function ComposerPanel({
  draftText,
  submitState,
  validationMessage,
  canSubmit,
  policyLabel,
  onDraftChange,
  onSubmit,
}: ComposerPanelProps): JSX.Element {
  const isSubmitting = submitState === 'submitting';
  const hasError = submitState === 'error' && validationMessage != null;

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && canSubmit) {
      event.preventDefault();
      onSubmit();
    }
  }

  return (
    <div style={{ display: 'grid', gap: '0.5rem' }}>
      <label htmlFor="composer-instruction" style={{ fontWeight: 500, fontSize: '0.875rem' }}>
        Instruction
      </label>
      <textarea
        id="composer-instruction"
        style={textareaStyle}
        value={draftText}
        disabled={isSubmitting}
        placeholder="Type an instruction…"
        onChange={(e) => {
          onDraftChange(e.target.value);
        }}
        onKeyDown={handleKeyDown}
      />

      {hasError && (
        <p role="alert" style={errorStyle}>
          {validationMessage}
        </p>
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.75rem',
        }}
      >
        <p style={policyStyle}>{policyLabel}</p>
        <button
          type="button"
          disabled={!canSubmit || isSubmitting}
          style={{
            ...buttonStyle,
            opacity: canSubmit && !isSubmitting ? 1 : 0.5,
            background: canSubmit && !isSubmitting ? '#3b82f6' : '#475569',
            color: '#fff',
          }}
          onClick={onSubmit}
        >
          {isSubmitting ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
