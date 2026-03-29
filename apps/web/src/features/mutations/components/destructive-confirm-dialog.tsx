/**
 * DestructiveConfirmDialog — two-step typed-phrase confirm dialog (T030).
 *
 * Step 1: Standard ConfirmDialog summary (from/to).
 * Step 2: Operator must type the exact requiredPhrase to unlock Submit.
 * Exact match only — no trim, no normalize (SEC-09 / R-4).
 * Cancel at Step 2 closes the entire flow; re-initiating starts at Step 1.
 */
import {
  useState,
  useCallback,
  useEffect,
  useRef,
  type JSX,
  type ChangeEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
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

interface StepTwoDialogProps {
  title: string;
  requiredPhrase: string;
  phraseInput: string;
  isLoading: boolean;
  phraseInputRef: RefObject<HTMLInputElement | null>;
  cancelButtonRef: RefObject<HTMLButtonElement | null>;
  submitButtonRef: RefObject<HTMLButtonElement | null>;
  onPhraseChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

function trapDialogTab(
  event: KeyboardEvent<HTMLDivElement>,
  focusable: Array<HTMLInputElement | HTMLButtonElement | null>,
): void {
  if (event.key !== 'Tab') return;
  const activeElements = focusable.filter(
    (element): element is HTMLInputElement | HTMLButtonElement =>
      element !== null && !element.disabled,
  );
  if (activeElements.length === 0) return;

  const first = activeElements[0];
  const last = activeElements.at(-1) ?? first;
  if (!event.shiftKey && globalThis.document.activeElement === last) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && globalThis.document.activeElement === first) {
    event.preventDefault();
    last.focus();
  }
}

function StepTwoDialog({
  title,
  requiredPhrase,
  phraseInput,
  isLoading,
  phraseInputRef,
  cancelButtonRef,
  submitButtonRef,
  onPhraseChange,
  onCancel,
  onSubmit,
}: StepTwoDialogProps): JSX.Element {
  const phraseMismatch = phraseInput.length > 0 && phraseInput !== requiredPhrase;

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
        return;
      }

      trapDialogTab(event, [
        phraseInputRef.current,
        cancelButtonRef.current,
        submitButtonRef.current,
      ]);
    },
    [cancelButtonRef, onCancel, phraseInputRef, submitButtonRef],
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="destructive-dialog-title"
      onKeyDown={handleKeyDown}
    >
      <h2 id="destructive-dialog-title">{title} — Confirm destructive action</h2>
      <p>
        Type <strong>{requiredPhrase}</strong> to confirm:
      </p>
      <label htmlFor="destructive-phrase-input">Confirmation phrase</label>
      <input
        ref={phraseInputRef}
        id="destructive-phrase-input"
        type="text"
        value={phraseInput}
        onChange={onPhraseChange}
        autoComplete="off"
        disabled={isLoading}
        aria-invalid={phraseMismatch}
      />
      <div>
        <button ref={cancelButtonRef} type="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          ref={submitButtonRef}
          type="button"
          onClick={onSubmit}
          disabled={phraseInput !== requiredPhrase || isLoading}
        >
          {isLoading ? 'Launching…' : 'Submit'}
        </button>
      </div>
    </div>
  );
}

function useDialogFocusReset(
  isOpen: boolean,
  setStep: (step: 1 | 2) => void,
  setPhraseInput: (value: string) => void,
): RefObject<HTMLElement | null> {
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (isOpen && previousFocusRef.current === null) {
      previousFocusRef.current =
        globalThis.document.activeElement instanceof HTMLElement
          ? globalThis.document.activeElement
          : null;
    }
    if (!isOpen) {
      setStep(1);
      setPhraseInput('');
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    }
  }, [isOpen, setPhraseInput, setStep]);

  return previousFocusRef;
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
  const phraseInputRef = useRef<HTMLInputElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const submitButtonRef = useRef<HTMLButtonElement | null>(null);

  useDialogFocusReset(isOpen, setStep, setPhraseInput);

  useEffect(() => {
    if (isOpen && step === 2) {
      phraseInputRef.current?.focus();
    }
  }, [isOpen, step]);

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
  }, [onConfirm, phraseInput, requiredPhrase]);

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
    <StepTwoDialog
      title={title}
      requiredPhrase={requiredPhrase}
      phraseInput={phraseInput}
      isLoading={isLoading}
      phraseInputRef={phraseInputRef}
      cancelButtonRef={cancelButtonRef}
      submitButtonRef={submitButtonRef}
      onPhraseChange={handlePhraseChange}
      onCancel={handleCancel}
      onSubmit={handleStep2Submit}
    />
  );
}
