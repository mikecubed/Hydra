/**
 * Ghost Text Helpers for the Hydra Operator Console.
 *
 * Provides greyed-out placeholder text (Claude Code CLI style) that appears
 * after the readline prompt cursor. Disappears on first keystroke; re-appears
 * on blank submissions or after command completion.
 *
 * Uses a factory pattern because the helpers share mutable state and need
 * access to the readline interface and a concierge-active getter.
 */

import type { Interface as ReadlineInterface } from 'node:readline';
import { DIM, stripAnsi } from './hydra-ui.ts';

export interface GhostTextDeps {
  /** The active readline interface. */
  rl: ReadlineInterface;
  /** Returns true when the concierge chat mode is active. */
  getConciergeActive: () => boolean;
  /** Returns a short display label for the active concierge model. */
  getConciergeModelLabel: () => string;
}

export interface GhostTextHelpers {
  /** Returns the next cycling hint string (advances the internal index). */
  getGhostText: () => string;
  /**
   * Renders dim ghost text after the prompt cursor.
   * @param overrideText Custom text instead of the cycling hints.
   * @param acceptableText If set, Tab will accept + submit this text.
   */
  showGhostAfterPrompt: (overrideText?: string, acceptableText?: string) => void;
  /**
   * Replaces the displayed ghost text with an AI-generated suggestion.
   * No-op if the user has already started typing.
   */
  upgradeGhostText: (newText: string) => void;
  /**
   * Removes any registered stdin ghost-cleanup listener.
   * Call from the readline `close` handler.
   */
  cleanup: () => void;
}

// ── Shared mutable state for ghost text ────────────────────────────────────

interface GhostState {
  cleanup: (() => void) | null;
  acceptableText: string | null;
  upgradeAborted: boolean;
  idx: number;
}

interface ReadlineInternals {
  _ttyWrite?: (s: string | null, key: { name: string; ctrl?: boolean; shift?: boolean }) => void;
}

// ── Extracted helpers (keep factory under max-lines-per-function) ──────────

function writeGhostToStdout(text: string): void {
  const plain = stripAnsi(text);
  process.stdout.write(DIM(text));
  if (plain.length > 0) {
    process.stdout.write(`\x1b[${String(plain.length)}D`);
  }
}

function createHintPools(
  getConciergeActive: () => boolean,
  getConciergeModelLabel: () => string,
): { getConciergeActive: () => boolean; concierge: (() => string)[]; normal: (() => string)[] } {
  return {
    getConciergeActive,
    concierge: [
      () => `Chat with ${getConciergeModelLabel()} — prefix ! to dispatch`,
      () => 'Ask a question or describe what you need',
      () => `Talking to ${getConciergeModelLabel()} — :chat off to disable`,
      () => 'What would you like to work on?',
    ],
    normal: [
      () => 'Describe a task to dispatch to agents',
      () => ':help for commands, or type a prompt',
      () => 'What would you like to work on?',
    ],
  };
}

function wrapRlPrompt(rl: ReadlineInterface, showGhostAfterPrompt: () => void): void {
  const origPrompt = rl.prompt.bind(rl);
  rl.prompt = function (preserveCursor?: boolean) {
    origPrompt(preserveCursor);
    if (preserveCursor !== true) {
      showGhostAfterPrompt();
    }
  };
}

function installTabInterception(rl: ReadlineInterface, state: GhostState): void {
  const rlInternal = rl as unknown as ReadlineInternals;
  const origTtyWrite = rlInternal._ttyWrite?.bind(rl);
  if (origTtyWrite == null) return;
  rlInternal._ttyWrite = function (
    s: string | null,
    key: { name: string; ctrl?: boolean; shift?: boolean },
  ) {
    if (key.name === 'tab' && state.acceptableText != null && rl.line.length === 0) {
      process.stdout.write('\x1b[K');
      const text = state.acceptableText;
      state.acceptableText = null;
      state.upgradeAborted = true;
      if (state.cleanup != null) {
        process.stdin.removeListener('data', state.cleanup);
        state.cleanup = null;
      }
      rl.write(text);
      setImmediate(() => {
        rl.write(null, { name: 'return' });
      });
      return;
    }
    origTtyWrite(s, key);
  };
}

/**
 * Creates the ghost text helpers and installs prompt-wrapping and Tab
 * interception on the provided readline interface.
 *
 * The factory must be called **after** `rl` has been created and before
 * `rl.prompt()` is first called.
 */
export function createGhostTextHelpers({
  rl,
  getConciergeActive,
  getConciergeModelLabel,
}: GhostTextDeps): GhostTextHelpers {
  const state: GhostState = { cleanup: null, acceptableText: null, upgradeAborted: false, idx: 0 };
  const hints = createHintPools(getConciergeActive, getConciergeModelLabel);

  function getGhostText(): string {
    const pool = hints.getConciergeActive() ? hints.concierge : hints.normal;
    const text = pool[state.idx % pool.length]();
    state.idx++;
    return text;
  }

  function showGhostAfterPrompt(overrideText?: string, acceptableText?: string): void {
    if (!process.stdout.isTTY) return;
    const base = overrideText ?? getGhostText();
    if (base === '') return;
    state.acceptableText = acceptableText ?? null;
    state.upgradeAborted = false;
    const text = state.acceptableText == null ? base : `${base}  [Tab]`;
    writeGhostToStdout(text);
    if (state.cleanup != null) {
      process.stdin.removeListener('data', state.cleanup);
      state.cleanup = null;
    }
    const ghostClear = () => {
      process.stdout.write('\x1b[K');
      state.acceptableText = null;
      state.upgradeAborted = true;
      process.stdin.removeListener('data', ghostClear);
      if (state.cleanup === ghostClear) state.cleanup = null;
    };
    state.cleanup = ghostClear;
    process.stdin.on('data', ghostClear);
  }

  function upgradeGhostText(newText: string): void {
    if (state.upgradeAborted) return;
    if (!process.stdout.isTTY) return;
    if (rl.line.length > 0) {
      state.upgradeAborted = true;
      return;
    }
    process.stdout.write('\x1b[K');
    writeGhostToStdout(`${newText}  [Tab]`);
    state.acceptableText = newText;
  }

  function cleanup(): void {
    if (state.cleanup != null) {
      process.stdin.removeListener('data', state.cleanup);
      state.cleanup = null;
    }
  }

  wrapRlPrompt(rl, showGhostAfterPrompt);
  installTabInterception(rl, state);

  return { getGhostText, showGhostAfterPrompt, upgradeGhostText, cleanup };
}
