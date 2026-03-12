/**
 * Hydra Prompt Choice - Interactive numbered-choice prompt for the operator console.
 *
 * Provides a reusable `promptChoice()` API that renders a branded selection UI,
 * cooperatively locks the readline instance, and supports auto-accept, freeform
 * input, and optional timeouts.
 *
 * Dependency: picocolors (via hydra-ui.mjs)
 */

/* eslint-disable @typescript-eslint/strict-boolean-expressions, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- prompt-choice handles dynamic readline state */

import { box, DIM, ACCENT, WARNING, ERROR, SUCCESS, stripAnsi } from './hydra-ui.ts';
import pc from 'picocolors';

// ── Auto-Accept Session State ───────────────────────────────────────────────

let sessionAutoAccept = false;

export function isAutoAccepting(): boolean {
  return sessionAutoAccept;
}

export function setAutoAccept(value: boolean): void {
  sessionAutoAccept = value;
}

export function resetAutoAccept(): void {
  sessionAutoAccept = false;
}

// ── Choice Active Flag (for guarding rl.prompt calls) ───────────────────────

let choiceActive = false;

export function isChoiceActive(): boolean {
  return choiceActive;
}

// ── Render Helpers ──────────────────────────────────────────────────────────

/**
 * Compute dynamic box width based on terminal width.
 * Clamps between 60 and 120 columns.
 */
function computeBoxWidth() {
  const termWidth = process.stdout.columns || 80;
  const targetWidth = Math.floor(termWidth * 0.9);
  return Math.max(60, Math.min(120, targetWidth));
}

/**
 * Word-wrap a value string to fit within the inner width.
 * Returns an array of lines, with continuation lines indented to align.
 *
 * @param {string} key - The context key label
 * @param {string} value - The value to wrap
 * @param {number} innerWidth - Available width inside the box
 * @returns {string[]} Array of formatted lines
 */
function wrapContextValue(key: string, value: string, innerWidth: number) {
  const keyLabel = DIM(`${key}:`);
  const keyLabelWidth = stripAnsi(keyLabel).length + 1; // +1 for the space
  const firstLineWidth = innerWidth - keyLabelWidth;
  const continuationIndent = ' '.repeat(keyLabelWidth);

  const valueStr = value;
  const words = valueStr.split(/\s+/);
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const targetWidth: number = lines.length === 0 ? firstLineWidth : innerWidth - keyLabelWidth;

    if (stripAnsi(testLine).length <= targetWidth) {
      currentLine = testLine;
    } else {
      // If current line has content, save it
      if (currentLine) {
        lines.push(currentLine);
      }

      // Handle words longer than target width by breaking them
      if (stripAnsi(word).length > targetWidth) {
        let remaining = word;
        while (stripAnsi(remaining).length > targetWidth) {
          lines.push(`${remaining.slice(0, targetWidth - 1)}-`);
          remaining = remaining.slice(targetWidth - 1);
        }
        currentLine = remaining;
      } else {
        currentLine = word;
      }
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  // Format the lines with key label on first line, indent on continuation
  return lines.map((line, i) => (i === 0 ? `${keyLabel} ${line}` : `${continuationIndent}${line}`));
}

function renderChoiceUI({
  title,
  context,
  choices,
}: {
  title: string;
  context: any;
  choices: any[];
}) {
  const boxWidth = computeBoxWidth();
  const padding = 1;
  const innerWidth = boxWidth - 2 - padding * 2;
  const boxLines = [];

  // Context key/value pairs with word wrapping
  if (context && typeof context === 'object') {
    for (const [key, value] of Object.entries(context)) {
      if (value !== undefined && value !== null && value !== '') {
        const wrappedLines = wrapContextValue(key, value as string, innerWidth);
        boxLines.push(...wrappedLines);
      }
    }
    boxLines.push(DIM('\u2500'.repeat(innerWidth)));
  }

  // Numbered choices
  for (const [i, choice] of choices.entries()) {
    const num = ACCENT(String(i + 1).padStart(2));
    const choiceLabel = pc.white(choice.label);
    const hint = choice.hint ? DIM(`  ${String(choice.hint)}`) : '';
    boxLines.push(` ${num}  ${choiceLabel}${hint}`);
  }

  return `\n${box(title || 'Selection', boxLines, { style: 'rounded', padding, width: boxWidth })}`;
}

/**
 * Animate the box drawing in progressively: top → sides → bottom.
 * Returns a promise that resolves when animation completes.
 */
function animateBoxDrawIn({
  title,
  context,
  choices,
}: {
  title: string;
  context: any;
  choices: any[];
}) {
  const isTTY = process.stdout.isTTY;
  if (!isTTY) {
    // No animation in non-TTY
    console.log(renderChoiceUI({ title, context, choices }));
    return Promise.resolve();
  }

  // Use dynamic width matching renderChoiceUI
  const boxWidth = computeBoxWidth();
  const padding = 1;
  const innerWidth = boxWidth - 2 - padding * 2;

  // Build the complete box content first with word wrapping
  const boxLines = [];

  if (context && typeof context === 'object') {
    for (const [key, value] of Object.entries(context)) {
      if (value !== undefined && value !== null && value !== '') {
        const wrappedLines = wrapContextValue(key, value as string, innerWidth);
        boxLines.push(...wrappedLines);
      }
    }
    boxLines.push(DIM('\u2500'.repeat(innerWidth)));
  }

  for (const [i, choice] of choices.entries()) {
    const num = ACCENT(String(i + 1).padStart(2));
    const choiceLabel = pc.white(choice.label);
    const hint = choice.hint ? DIM(`  ${String(choice.hint)}`) : '';
    boxLines.push(` ${num}  ${choiceLabel}${hint}`);
  }

  // Build box with rounded style
  const s = { tl: '\u256D', tr: '\u256E', bl: '\u2570', br: '\u256F', h: '\u2500', v: '\u2502' };
  const padStr = ' '.repeat(padding);
  const totalInner = innerWidth + padding * 2;
  const titleStr = title ? ` ${title} ` : '';
  const topPad = totalInner - titleStr.length;
  const top = `${s.tl}${titleStr}${s.h.repeat(Math.max(topPad, 0))}${s.tr}`;
  const bot = `${s.bl}${s.h.repeat(totalInner)}${s.br}`;

  const bodyLines = boxLines.map((line) => {
    const stripped = stripAnsi(line);
    const pad = Math.max(innerWidth - stripped.length, 0);
    return `${s.v}${padStr}${line}${' '.repeat(pad)}${padStr}${s.v}`;
  });

  const blank = `${s.v}${' '.repeat(totalInner)}${s.v}`;
  const fullBox = [top, blank, ...bodyLines, blank, bot];

  return new Promise<void>((resolve) => {
    console.log(''); // empty line

    let lineIdx = 0;
    const delayMs = 20;

    function printNextLine() {
      if (lineIdx < fullBox.length) {
        console.log(fullBox[lineIdx]);
        lineIdx++;
        setTimeout(printNextLine, delayMs);
      } else {
        resolve();
      }
    }

    printNextLine();
  });
}

// ── Freeform Sub-Prompt ─────────────────────────────────────────────────────

function collectFreeform(rl: any) {
  return new Promise((resolve) => {
    const freeformPrompt = `${ACCENT('hydra')}${pc.yellow(':')}${DIM('>')} `;
    rl.question(freeformPrompt, (answer: string) => {
      resolve((answer || '').trim());
    });
  });
}

// ── Multi-Select Helpers ─────────────────────────────────────────────────────

/**
 * Parse multi-select input: numbers, comma-separated, ranges, 'a' for all.
 * @param {string} input - Raw user input
 * @param {number} maxIndex - Maximum valid 1-based index
 * @returns {number[]|'all'|null} Array of 0-based indices, 'all', or null for invalid
 */
export function parseMultiSelectInput(input: string, maxIndex: number): number[] | 'all' | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === 'a' || trimmed === 'all') return 'all';
  if (!trimmed) return null;

  const indices = new Set<number>();
  const parts = trimmed.split(/[,\s]+/).filter(Boolean);

  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1], 10);
      const end = Number.parseInt(rangeMatch[2], 10);
      if (start < 1 || end > maxIndex || start > end) return null;
      for (let i = start; i <= end; i++) indices.add(i - 1);
    } else {
      const num = Number.parseInt(part, 10);
      if (Number.isNaN(num) || num < 1 || num > maxIndex) return null;
      indices.add(num - 1);
    }
  }

  return indices.size > 0 ? [...indices].sort((a, b) => a - b) : null;
}

function renderMultiSelectUI({
  title,
  context,
  choices,
  selected,
}: {
  title: string;
  context: any;
  choices: any[];
  selected: Set<number>;
}) {
  const boxWidth = computeBoxWidth();
  const padding = 1;
  const innerWidth = boxWidth - 2 - padding * 2;
  const boxLines = [];

  if (context && typeof context === 'object') {
    for (const [key, value] of Object.entries(context)) {
      if (value !== undefined && value !== null && value !== '') {
        const wrappedLines = wrapContextValue(key, value as string, innerWidth);
        boxLines.push(...wrappedLines);
      }
    }
    boxLines.push(DIM('\u2500'.repeat(innerWidth)));
  }

  for (const [i, choice] of choices.entries()) {
    const num = ACCENT(String(i + 1).padStart(2));
    const check = selected.has(i) ? SUCCESS('[x]') : DIM('[ ]');
    const choiceLabel = pc.white(choice.label);
    const hint = choice.hint ? DIM(`  ${String(choice.hint)}`) : '';
    boxLines.push(` ${num} ${check} ${choiceLabel}${hint}`);
  }

  boxLines.push(DIM('\u2500'.repeat(innerWidth)));
  boxLines.push(DIM(' Toggle: 1,3,5 | Range: 1-3 | a=all | Enter=confirm | ?=refresh'));

  return `\n${box(title || 'Multi-Select', boxLines, { style: 'rounded', padding, width: boxWidth })}`;
}

// ── Main API ────────────────────────────────────────────────────────────────

/**
 * Show an interactive numbered-choice prompt.
 *
 * Cooperatively takes over the readline instance by saving + removing existing
 * 'line' listeners, installing a one-shot handler, then restoring on resolve.
 *
 * @param {readline.Interface} rl - The operator's readline instance
 * @param {object} opts
 * @param {string} opts.title - Section header title
 * @param {object} [opts.context] - Key/value pairs to display above choices
 * @param {Array<{label: string, value: any, hint?: string, freeform?: boolean}>} opts.choices
 * @param {any} [opts.defaultValue] - Value to return on timeout or non-TTY
 * @param {number} [opts.timeoutMs] - Auto-select default after this many ms (0 = no timeout)
 * @param {boolean} [opts.multiSelect] - Enable multi-select checkbox mode
 * @param {any[]} [opts.preSelected] - Values to pre-check in multi-select mode
 * @returns {Promise<{value: any, values?: any[], autoAcceptAll: boolean, timedOut: boolean}>}
 */
export function promptChoice(
  rl: any, // eslint-disable-line @typescript-eslint/explicit-module-boundary-types -- callers pass readline instances typed as unknown; full typing requires codebase-wide refactor
  opts: {
    title?: string;
    context?: any;
    choices?: any[];
    defaultValue?: any;
    timeoutMs?: number;
    multiSelect?: boolean;
    preSelected?: any[];
    message?: string;
    [key: string]: unknown;
  } = {},
): Promise<{ value?: unknown; values?: unknown[]; autoAcceptAll: boolean; timedOut: boolean }> {
  const {
    title = 'Selection',
    context = null,
    choices = [],
    defaultValue = choices[0]?.value,
    timeoutMs = 0,
    multiSelect = false,
    preSelected = [],
  } = opts;

  // Multi-select mode
  if (multiSelect) {
    return promptMultiSelect(rl, { title, context, choices, preSelected, timeoutMs });
  }

  // Non-TTY or auto-accept: return default immediately
  if (!process.stdout.isTTY || sessionAutoAccept) {
    return Promise.resolve({
      value: defaultValue,
      autoAcceptAll: sessionAutoAccept,
      timedOut: false,
    });
  }

  if (choices.length === 0) {
    return Promise.resolve({ value: defaultValue, autoAcceptAll: false, timedOut: false });
  }

  return new Promise((resolve) => {
    choiceActive = true;

    // Save existing 'line' listeners and detach them
    const savedListeners = rl.listeners('line').slice();
    rl.removeAllListeners('line');

    // Track if we've already resolved (timeout vs input race)
    let resolved = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const choicePrompt = `${ACCENT('hydra')}${pc.yellow('?')}${DIM('>')} `;

    // Find if any choice is freeform
    const freeformChoice = choices.find((c: any) => c.freeform);

    function cleanup() {
      choiceActive = false;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      // Remove our handler
      rl.removeAllListeners('line');
      // Restore original listeners
      for (const listener of savedListeners) {
        rl.on('line', listener);
      }
      // Restore normal prompt
      const normalPrompt = `${ACCENT('hydra')}${DIM('>')} `;
      rl.setPrompt(normalPrompt);
    }

    function finish(result: any) {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(result);
    }

    // Render the choice UI with animation
    void animateBoxDrawIn({ title, context, choices }).then(() => {
      // After animation completes, show the prompt
      rl.setPrompt(choicePrompt);
      rl.prompt();
    });

    // Install one-shot line handler
    async function handleLine(input: string) {
      if (resolved) return;
      const trimmed = (input || '').trim();

      if (!trimmed) {
        // Empty input: re-prompt
        rl.prompt();
        return;
      }

      // Try parsing as a number
      const num = Number.parseInt(trimmed, 10);
      if (num >= 1 && num <= choices.length) {
        const picked = choices[num - 1];

        // Special: auto-accept-all
        if (picked.value === '__auto_accept__') {
          sessionAutoAccept = true;
          // Return the default value (proceed), but flag autoAcceptAll
          finish({ value: defaultValue, autoAcceptAll: true, timedOut: false });
          return;
        }

        // Freeform: collect additional input
        if (picked.freeform) {
          // Temporarily remove our handler for freeform collection
          rl.removeAllListeners('line');
          const text = await collectFreeform(rl);
          // Re-attach our handler in case of empty text
          if (!text) {
            rl.on('line', (lineInput: string) => {
              void handleLine(lineInput);
            });
            console.log(`  ${ERROR('Empty input, try again.')}`);
            rl.setPrompt(choicePrompt);
            rl.prompt();
            return;
          }
          finish({ value: text, autoAcceptAll: false, timedOut: false });
          return;
        }

        finish({ value: picked.value, autoAcceptAll: false, timedOut: false });
        return;
      }

      // Not a valid number — check if it's freeform text (> 2 chars and a freeform option exists)
      if (freeformChoice && trimmed.length > 2) {
        finish({ value: trimmed, autoAcceptAll: false, timedOut: false });
        return;
      }

      // Invalid input
      console.log(
        `  ${ERROR('Invalid selection.')} Pick ${ACCENT('1')}-${ACCENT(String(choices.length))}${freeformChoice ? ' or type your response' : ''}`,
      );
      rl.prompt();
    }

    rl.on('line', (lineInput: string) => {
      void handleLine(lineInput);
    });

    // Timeout
    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        if (!resolved) {
          console.log(
            DIM(
              `  (timed out after ${String(Math.round(timeoutMs / 1000))}s, auto-selecting default)`,
            ),
          );
          finish({ value: defaultValue, autoAcceptAll: false, timedOut: true });
        }
      }, timeoutMs);
      // Don't keep process alive for timeout
      timeoutId.unref();
    }
  });
}

// ── Multi-Select Mode ───────────────────────────────────────────────────────

function promptMultiSelect(
  rl: any,
  {
    title,
    context,
    choices,
    preSelected,
    timeoutMs,
  }: { title: string; context: any; choices: any[]; preSelected: any[]; timeoutMs: number },
): Promise<{ value?: unknown; values?: unknown[]; autoAcceptAll: boolean; timedOut: boolean }> {
  // Build initial selection set from preSelected values
  const selected = new Set<number>();
  for (const [i, choice] of choices.entries()) {
    if (preSelected.includes(choice.value)) selected.add(i);
  }

  // Non-TTY or auto-accept: return preSelected (or all if none)
  if (!process.stdout.isTTY || sessionAutoAccept) {
    const values =
      selected.size > 0 ? [...selected].map((i) => choices[i].value) : choices.map((c) => c.value);
    return Promise.resolve({ values, autoAcceptAll: sessionAutoAccept, timedOut: false });
  }

  if (choices.length === 0) {
    return Promise.resolve({ values: [], autoAcceptAll: false, timedOut: false });
  }

  return new Promise((resolve) => {
    choiceActive = true;

    const savedListeners = rl.listeners('line').slice();
    rl.removeAllListeners('line');

    let resolved = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const choicePrompt = `${ACCENT('hydra')}${pc.yellow('+')}${DIM('>')} `;

    function cleanup() {
      choiceActive = false;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      rl.removeAllListeners('line');
      for (const listener of savedListeners) rl.on('line', listener);
      const normalPrompt = `${ACCENT('hydra')}${DIM('>')} `;
      rl.setPrompt(normalPrompt);
    }

    function finish(result: any) {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(result);
    }

    function showStatus() {
      const count = selected.size;
      const total = choices.length;
      console.log(
        `  ${DIM(`Selected: ${String(count)}/${String(total)}`)}${count > 0 ? ` ${SUCCESS('\u2713')}` : ''}`,
      );
    }

    // Initial render (no animation for multi-select — it re-renders)
    console.log(renderMultiSelectUI({ title, context, choices, selected }));
    rl.setPrompt(choicePrompt);
    rl.prompt();

    function handleLine(input: string) {
      if (resolved) return;
      const trimmed = (input || '').trim();

      // Empty enter = confirm selection
      if (!trimmed) {
        const values = [...selected].sort((a, b) => a - b).map((i) => choices[i].value);
        finish({ values, autoAcceptAll: false, timedOut: false });
        return;
      }

      // ? = re-render
      if (trimmed === '?') {
        console.log(renderMultiSelectUI({ title, context, choices, selected }));
        rl.prompt();
        return;
      }

      // Parse multi-select input
      const parsed = parseMultiSelectInput(trimmed, choices.length);
      if (parsed === 'all') {
        // Toggle all: if all selected → deselect all, else select all
        if (selected.size === choices.length) {
          selected.clear();
        } else {
          for (let i = 0; i < choices.length; i++) selected.add(i);
        }
        showStatus();
        rl.prompt();
        return;
      }

      if (parsed === null) {
        console.log(
          `  ${ERROR('Invalid input.')} Use numbers (1,3,5), ranges (1-3), a=all, Enter=confirm`,
        );
        rl.prompt();
        return;
      }

      // Toggle each index
      for (const idx of parsed) {
        if (selected.has(idx)) selected.delete(idx);
        else selected.add(idx);
      }
      showStatus();
      rl.prompt();
    }

    rl.on('line', handleLine);

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        if (!resolved) {
          console.log(DIM(`  (timed out, confirming current selection)`));
          const values =
            selected.size > 0
              ? [...selected].sort((a, b) => a - b).map((i) => choices[i].value)
              : choices.map((c) => c.value);
          finish({ values, autoAcceptAll: false, timedOut: true });
        }
      }, timeoutMs);
      timeoutId.unref();
    }
  });
}

// ── Confirm Action Plan ──────────────────────────────────────────────────────

const SEVERITY_ICONS = {
  critical: pc.red('\u2718'), // ✘
  high: pc.red('\u25C6'), // ◆
  medium: WARNING('\u25C7'), // ◇
  low: DIM('\u25CB'), // ○
};

/**
 * Render a non-interactive summary of planned actions and ask for Proceed/Cancel.
 *
 * @param {readline.Interface} rl
 * @param {object} opts
 * @param {string} opts.title - Box title
 * @param {object} [opts.context] - Key/value pairs
 * @param {string} [opts.summary] - Optional summary text
 * @param {Array<{label: string, description?: string, agent?: string, severity?: string}>} opts.actions
 * @param {number} [opts.timeoutMs] - Auto-confirm timeout
 * @returns {Promise<boolean>} true if user confirms
 */
export async function confirmActionPlan(
  rl: any, // eslint-disable-line @typescript-eslint/explicit-module-boundary-types -- callers pass readline instances typed as unknown; full typing requires codebase-wide refactor
  opts: {
    title?: string;
    context?: any;
    summary?: string;
    actions?: any[];
    timeoutMs?: number;
  } = {},
): Promise<boolean> {
  const { title = 'Action Plan', context, summary, actions = [], timeoutMs = 0 } = opts;

  if (actions.length === 0) return true;

  // Build context with action list
  const planContext: Record<string, string> = context
    ? { ...(context as Record<string, string>) }
    : {};
  if (summary) planContext['Summary'] = summary;
  planContext['Actions'] = `${String(actions.length)} item${actions.length === 1 ? '' : 's'}`;

  // Print the action list
  const boxWidth = computeBoxWidth();
  const padding = 1;
  const innerWidth = boxWidth - 2 - padding * 2;
  const boxLines = [];

  if (context && typeof context === 'object') {
    for (const [key, value] of Object.entries(context)) {
      if (value !== undefined && value !== null && value !== '') {
        const wrappedLines = wrapContextValue(key, value as string, innerWidth);
        boxLines.push(...wrappedLines);
      }
    }
  }
  if (summary) {
    boxLines.push(DIM(summary));
  }
  boxLines.push(DIM('\u2500'.repeat(innerWidth)));

  for (const [i, action] of actions.entries()) {
    const num = DIM(`${String(i + 1).padStart(2)}.`);
    const severity = (action.severity as string | undefined) ?? '';
    const icon = (SEVERITY_ICONS as Record<string, string>)[severity] ?? DIM('\u25CB');
    const agentTag = action.agent ? ` ${DIM(`[${String(action.agent)}]`)}` : '';
    boxLines.push(` ${num} ${icon} ${pc.white(action.label)}${agentTag}`);
    if (action.description) {
      boxLines.push(`      ${DIM(action.description.slice(0, innerWidth - 6))}`);
    }
  }

  console.log(`\n${box(title, boxLines, { style: 'rounded', padding, width: boxWidth })}`);

  // Binary confirm via promptChoice
  const result = await promptChoice(rl, {
    title: 'Confirm',
    choices: [
      {
        label: 'Proceed',
        value: true,
        hint: `execute ${String(actions.length)} action${actions.length === 1 ? '' : 's'}`,
      },
      { label: 'Cancel', value: false },
    ],
    defaultValue: true,
    timeoutMs,
  });

  return (result as { value: unknown }).value === true;
}
