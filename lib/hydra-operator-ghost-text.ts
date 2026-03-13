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
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment */

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
  showGhostAfterPrompt: (overrideText?: any, acceptableText?: any) => void;
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
  // ── Internal state ──────────────────────────────────────────────────────
  let _ghostCleanup: ((...args: any[]) => void) | null = null;
  let _acceptableGhostText: string | null = null;
  let _ghostUpgradeAborted = false;
  let _ghostIdx = 0;

  // Hint pool factories — use getConciergeModelLabel() lazily so the label
  // always reflects the current concierge model when the hint is rendered.
  const GHOST_HINTS_CONCIERGE = [
    () => `Chat with ${getConciergeModelLabel()} — prefix ! to dispatch`,
    () => 'Ask a question or describe what you need',
    () => `Talking to ${getConciergeModelLabel()} — :chat off to disable`,
    () => 'What would you like to work on?',
  ];
  const GHOST_HINTS_NORMAL = [
    () => 'Describe a task to dispatch to agents',
    () => ':help for commands, or type a prompt',
    () => 'What would you like to work on?',
  ];

  // ── Core helpers ────────────────────────────────────────────────────────

  function getGhostText(): string {
    const pool = getConciergeActive() ? GHOST_HINTS_CONCIERGE : GHOST_HINTS_NORMAL;
    const text = pool[_ghostIdx % pool.length]();
    _ghostIdx++;
    return text;
  }

  function showGhostAfterPrompt(overrideText?: any, acceptableText?: any): void {
    if (!process.stdout.isTTY) return;
    const base = overrideText ?? getGhostText();
    if (!base) return;

    _acceptableGhostText = acceptableText ?? null;
    _ghostUpgradeAborted = false;

    const text = _acceptableGhostText ? `${String(base)}  [Tab]` : base;
    const plain = stripAnsi(text);

    process.stdout.write(DIM(text));
    if (plain.length > 0) {
      process.stdout.write(`\x1b[${String(plain.length)}D`);
    }

    // One-shot: clear ghost text on first keystroke
    if (_ghostCleanup) {
      process.stdin.removeListener('data', _ghostCleanup);
      _ghostCleanup = null;
    }
    const ghostClear = () => {
      process.stdout.write('\x1b[K');
      _acceptableGhostText = null;
      _ghostUpgradeAborted = true;
      process.stdin.removeListener('data', ghostClear);
      if (_ghostCleanup === ghostClear) _ghostCleanup = null;
    };
    _ghostCleanup = ghostClear;
    process.stdin.on('data', ghostClear);
  }

  function upgradeGhostText(newText: string): void {
    if (_ghostUpgradeAborted) return;
    if (!process.stdout.isTTY) return;
    if (rl.line && rl.line.length > 0) {
      _ghostUpgradeAborted = true;
      return;
    }
    process.stdout.write('\x1b[K');
    const display = `${newText}  [Tab]`;
    const plain = stripAnsi(display);
    process.stdout.write(DIM(display));
    if (plain.length > 0) {
      process.stdout.write(`\x1b[${String(plain.length)}D`);
    }
    _acceptableGhostText = newText;
  }

  function cleanup(): void {
    if (_ghostCleanup) {
      process.stdin.removeListener('data', _ghostCleanup);
      _ghostCleanup = null;
    }
  }

  // ── Wrap rl.prompt to auto-show ghost text on fresh prompts ─────────────
  const _origPrompt = rl.prompt.bind(rl);
  rl.prompt = function (preserveCursor?: boolean) {
    _origPrompt(preserveCursor);
    if (!preserveCursor) {
      showGhostAfterPrompt();
    }
  };

  // ── Tab interception: accept + submit ghost text ─────────────────────────
  // Override readline's internal _ttyWrite to intercept Tab when acceptable
  // ghost text is displayed. Standard pattern used by inquirer/ora.
  const _origTtyWrite = (rl as any)._ttyWrite?.bind(rl);
  if (_origTtyWrite) {
    (rl as any)._ttyWrite = function (s: any, key: any) {
      if (key.name === 'tab' && _acceptableGhostText && !rl.line.length) {
        process.stdout.write('\x1b[K');
        const text = _acceptableGhostText;
        _acceptableGhostText = null;
        _ghostUpgradeAborted = true;
        if (_ghostCleanup) {
          process.stdin.removeListener('data', _ghostCleanup);
          _ghostCleanup = null;
        }
        rl.write(text);
        setImmediate(() => {
          rl.write(null, { name: 'return' });
        });
        return;
      }
      _origTtyWrite(s, key);
    };
  }

  return { getGhostText, showGhostAfterPrompt, upgradeGhostText, cleanup };
}
