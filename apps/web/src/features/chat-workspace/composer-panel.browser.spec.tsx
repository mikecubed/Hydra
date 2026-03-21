import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ComposerPanel, type ComposerPanelProps } from './components/composer-panel.tsx';

afterEach(() => {
  cleanup();
});

function renderComposer(overrides: Partial<ComposerPanelProps> = {}) {
  const defaults: ComposerPanelProps = {
    draftText: '',
    submitState: 'idle',
    validationMessage: null,
    canSubmit: false,
    policyLabel: 'Ready for operator input',
    onDraftChange: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  };
  return render(<ComposerPanel {...defaults} />);
}

describe('ComposerPanel', () => {
  it('renders a labeled textarea and submit button', () => {
    renderComposer();

    expect(screen.getByRole('textbox', { name: /instruction/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /send/i })).toBeTruthy();
  });

  it('displays the current draft text in the textarea', () => {
    renderComposer({ draftText: 'hello agent' });

    const textarea: HTMLTextAreaElement = screen.getByRole('textbox', { name: /instruction/i });
    expect(textarea.value).toBe('hello agent');
  });

  it('fires onDraftChange when the operator types', () => {
    const onDraftChange = vi.fn();
    renderComposer({ onDraftChange });

    const textarea = screen.getByRole('textbox', { name: /instruction/i });
    fireEvent.change(textarea, { target: { value: 'new text' } });

    expect(onDraftChange).toHaveBeenCalledWith('new text');
  });

  it('disables the submit button when canSubmit is false', () => {
    renderComposer({ canSubmit: false });

    const button: HTMLButtonElement = screen.getByRole('button', { name: /send/i });
    expect(button.disabled).toBe(true);
  });

  it('enables the submit button when canSubmit is true', () => {
    renderComposer({ canSubmit: true, draftText: 'submit me' });

    const button: HTMLButtonElement = screen.getByRole('button', { name: /send/i });
    expect(button.disabled).toBe(false);
  });

  it('fires onSubmit when the submit button is clicked', () => {
    const onSubmit = vi.fn();
    renderComposer({ canSubmit: true, draftText: 'go', onSubmit });

    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('fires onSubmit on Ctrl+Enter in the textarea', () => {
    const onSubmit = vi.fn();
    renderComposer({ canSubmit: true, draftText: 'go', onSubmit });

    const textarea = screen.getByRole('textbox', { name: /instruction/i });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('fires onSubmit on Meta+Enter in the textarea', () => {
    const onSubmit = vi.fn();
    renderComposer({ canSubmit: true, draftText: 'go', onSubmit });

    const textarea = screen.getByRole('textbox', { name: /instruction/i });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('does not fire onSubmit on bare Enter', () => {
    const onSubmit = vi.fn();
    renderComposer({ canSubmit: true, draftText: 'go', onSubmit });

    const textarea = screen.getByRole('textbox', { name: /instruction/i });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not fire onSubmit on Ctrl+Enter when canSubmit is false', () => {
    const onSubmit = vi.fn();
    renderComposer({ canSubmit: false, draftText: 'go', onSubmit });

    const textarea = screen.getByRole('textbox', { name: /instruction/i });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('ComposerPanel submit states', () => {
  it('shows submitting state on the button', () => {
    renderComposer({ submitState: 'submitting', canSubmit: false, draftText: 'sending' });

    const button: HTMLButtonElement = screen.getByRole('button', { name: /sending/i });
    expect(button.disabled).toBe(true);
  });

  it('disables the textarea while submitting', () => {
    renderComposer({ submitState: 'submitting', canSubmit: false, draftText: 'sending' });

    const textarea: HTMLTextAreaElement = screen.getByRole('textbox', { name: /instruction/i });
    expect(textarea.disabled).toBe(true);
  });

  it('displays a validation error message', () => {
    renderComposer({
      submitState: 'error',
      validationMessage: 'Gateway 502: Bad Gateway',
      draftText: 'failed text',
    });

    expect(screen.getByRole('alert').textContent).toContain('Gateway 502: Bad Gateway');
  });

  it('does not render an error region when there is no validation message', () => {
    renderComposer({ submitState: 'idle', validationMessage: null });

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the submission policy label', () => {
    renderComposer({ policyLabel: 'Awaiting agent response' });

    expect(screen.getByText('Awaiting agent response')).toBeTruthy();
  });

  it('disables the textarea when the disabled prop is true (loading, no active conversation)', () => {
    renderComposer({ disabled: true, submitState: 'idle', draftText: '' });

    const textarea: HTMLTextAreaElement = screen.getByRole('textbox', { name: /instruction/i });
    expect(textarea.disabled).toBe(true);
  });

  it('keeps the textarea enabled when disabled prop is false and not submitting', () => {
    renderComposer({ disabled: false, submitState: 'idle', draftText: '' });

    const textarea: HTMLTextAreaElement = screen.getByRole('textbox', { name: /instruction/i });
    expect(textarea.disabled).toBe(false);
  });
});
