/**
 * DestructiveConfirmDialog — two-step typed-phrase confirm dialog (T030).
 *
 * Step 1: Standard ConfirmDialog summary (from/to).
 * Step 2: Operator must type the exact requiredPhrase to unlock Submit.
 * Exact match only — no trim, no normalize (SEC-09 / R-4).
 * Cancel at Step 2 closes the entire flow; re-initiating starts at Step 1.
 */
import { useState, useCallback, useEffect, type JSX, type ChangeEvent } from 'react';
import { ConfirmDialog } from './confirm-dialog.tsx';

export interface DestructiveConfirmDialogProps {
  isOpen: boolean;
  title: string;
  from: string;
  to: string;
  requiredPhrase: string;
  onConfirm: () => void;
  onCancel: () => void;
  isLoading: boolean;
}

export function DestructiveConfirmDialog({
  isOpen,
  title,
  from,
  to,
  requiredPhrase,
  onConfirm,
  onCancel,
  isLoading,
}: DestructiveConfirmDialogProps): JSX.Element | null {
  const [step, setStep] = useState<1 | 2>(1);
  const [phraseInput, setPhraseInput] = useState('');

  useEffect(() => {
    if (!isOpen) {
      setStep(1);
      setPhraseInput('');
    }
  }, [isOpen]);

  const handleStep1Confirm = useCallback(() => {
    setStep(2);
    setPhraseInput('');
  }, []);

  const handleCancel = useCallback(() => {
    setStep(1);
    setPhraseInput('');
    onCancel();
  }, [onCancel]);

  const handlePhraseChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setPhraseInput(e.target.value);
  }, []);

  const handleStep2Submit = useCallback(() => {
    if (phraseInput !== requiredPhrase) return;
    onConfirm();
    setStep(1);
    setPhraseInput('');
  }, [phraseInput, requiredPhrase, onConfirm]);

  if (!isOpen) return null;

  if (step === 1) {
    return (
      <ConfirmDialog
        isOpen={true}
        title={title}
        from={from}
        to={to}
        onConfirm={handleStep1Confirm}
        onCancel={handleCancel}
        isLoading={false}
      />
    );
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="destructive-dialog-title">
      <h2 id="destructive-dialog-title">{title} — Confirm destructive action</h2>
      <p>
        Type <strong>{requiredPhrase}</strong> to confirm:
      </p>
      <label htmlFor="destructive-phrase-input">Confirmation phrase</label>
      <input
        id="destructive-phrase-input"
        type="text"
        value={phraseInput}
        onChange={handlePhraseChange}
        autoComplete="off"
        disabled={isLoading}
      />
      <div>
        <button type="button" onClick={handleCancel}>
          Cancel
        </button>
        <button
          type="button"
          onClick={handleStep2Submit}
          disabled={phraseInput !== requiredPhrase || isLoading}
        >
          {isLoading ? 'Launching…' : 'Submit'}
        </button>
      </div>
    </div>
  );
}
