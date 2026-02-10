/**
 * Hydra Prompt Choice - Interactive numbered-choice prompt for the operator console.
 *
 * Provides a reusable `promptChoice()` API that renders a branded selection UI,
 * cooperatively locks the readline instance, and supports auto-accept, freeform
 * input, and optional timeouts.
 *
 * Dependency: picocolors (via hydra-ui.mjs)
 */

import {
  sectionHeader,
  label,
  box,
  DIM,
  ACCENT,
  WARNING,
  ERROR,
  stripAnsi,
} from './hydra-ui.mjs';
import pc from 'picocolors';

// ── Auto-Accept Session State ───────────────────────────────────────────────

let sessionAutoAccept = false;

export function isAutoAccepting() {
  return sessionAutoAccept;
}

export function setAutoAccept(value) {
  sessionAutoAccept = Boolean(value);
}

export function resetAutoAccept() {
  sessionAutoAccept = false;
}

// ── Choice Active Flag (for guarding rl.prompt calls) ───────────────────────

let choiceActive = false;

export function isChoiceActive() {
  return choiceActive;
}

// ── Render Helpers ──────────────────────────────────────────────────────────

/**
 * Compute dynamic box width based on terminal width.
 * Clamps between 60 and 120 columns.
 */
function computeBoxWidth() {
  const termWidth = process.stdout?.columns || 80;
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
function wrapContextValue(key, value, innerWidth) {
  const keyLabel = DIM(`${key}:`);
  const keyLabelWidth = stripAnsi(keyLabel).length + 1; // +1 for the space
  const firstLineWidth = innerWidth - keyLabelWidth;
  const continuationIndent = ' '.repeat(keyLabelWidth);

  const valueStr = String(value);
  const words = valueStr.split(/\s+/);
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const targetWidth = lines.length === 0 ? firstLineWidth : innerWidth - keyLabelWidth;

    if (stripAnsi(testLine).length <= targetWidth) {
      currentLine = testLine;
    } else {
      // If current line has content, save it
      if (currentLine) {
        lines.push(currentLine);
        currentLine = '';
      }

      // Handle words longer than target width by breaking them
      if (stripAnsi(word).length > targetWidth) {
        let remaining = word;
        while (stripAnsi(remaining).length > targetWidth) {
          lines.push(remaining.slice(0, targetWidth - 1) + '-');
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
  return lines.map((line, i) => {
    if (i === 0) {
      return `${keyLabel} ${line}`;
    } else {
      return `${continuationIndent}${line}`;
    }
  });
}

function renderChoiceUI({ title, context, choices }) {
  const boxWidth = computeBoxWidth();
  const padding = 1;
  const innerWidth = boxWidth - 2 - padding * 2;
  const boxLines = [];

  // Context key/value pairs with word wrapping
  if (context && typeof context === 'object') {
    for (const [key, value] of Object.entries(context)) {
      if (value !== undefined && value !== null && value !== '') {
        const wrappedLines = wrapContextValue(key, value, innerWidth);
        boxLines.push(...wrappedLines);
      }
    }
    boxLines.push(DIM('\u2500'.repeat(innerWidth)));
  }

  // Numbered choices
  for (let i = 0; i < choices.length; i++) {
    const num = ACCENT(String(i + 1).padStart(2));
    const choiceLabel = pc.white(choices[i].label);
    const hint = choices[i].hint ? DIM(`  ${choices[i].hint}`) : '';
    boxLines.push(` ${num}  ${choiceLabel}${hint}`);
  }

  return '\n' + box(title || 'Selection', boxLines, { style: 'rounded', padding, width: boxWidth });
}

/**
 * Animate the box drawing in progressively: top → sides → bottom.
 * Returns a promise that resolves when animation completes.
 */
function animateBoxDrawIn({ title, context, choices }) {
  const isTTY = process.stdout?.isTTY;
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
        const wrappedLines = wrapContextValue(key, value, innerWidth);
        boxLines.push(...wrappedLines);
      }
    }
    boxLines.push(DIM('\u2500'.repeat(innerWidth)));
  }

  for (let i = 0; i < choices.length; i++) {
    const num = ACCENT(String(i + 1).padStart(2));
    const choiceLabel = pc.white(choices[i].label);
    const hint = choices[i].hint ? DIM(`  ${choices[i].hint}`) : '';
    boxLines.push(` ${num}  ${choiceLabel}${hint}`);
  }

  // Build box with rounded style
  const s = { tl: '\u256D', tr: '\u256E', bl: '\u2570', br: '\u256F', h: '\u2500', v: '\u2502' };
  const padStr = ' '.repeat(padding);
  const totalInner = innerWidth + padding * 2;
  const titleStr = title ? ` ${title} ` : '';
  const topPad = totalInner - titleStr.length - 1;
  const top = `${s.tl}${titleStr}${s.h.repeat(Math.max(topPad, 0))}${s.tr}`;
  const bot = `${s.bl}${s.h.repeat(totalInner)}${s.br}`;

  const bodyLines = boxLines.map((line) => {
    const stripped = stripAnsi(line);
    const pad = Math.max(innerWidth - stripped.length, 0);
    return `${s.v}${padStr}${line}${' '.repeat(pad)}${padStr}${s.v}`;
  });

  const blank = `${s.v}${' '.repeat(totalInner)}${s.v}`;
  const fullBox = [top, blank, ...bodyLines, blank, bot];

  return new Promise((resolve) => {
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

function collectFreeform(rl) {
  return new Promise((resolve) => {
    const freeformPrompt = `${ACCENT('hydra')}${pc.yellow(':')}${DIM('>')} `;
    rl.question(freeformPrompt, (answer) => {
      resolve(String(answer || '').trim());
    });
  });
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
 * @returns {Promise<{value: any, autoAcceptAll: boolean, timedOut: boolean}>}
 */
export function promptChoice(rl, opts = {}) {
  const {
    title = 'Selection',
    context = null,
    choices = [],
    defaultValue = choices[0]?.value,
    timeoutMs = 0,
  } = opts;

  // Non-TTY or auto-accept: return default immediately
  if (!process.stdout?.isTTY || sessionAutoAccept) {
    return Promise.resolve({ value: defaultValue, autoAcceptAll: sessionAutoAccept, timedOut: false });
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
    let timeoutId = null;

    const choicePrompt = `${ACCENT('hydra')}${pc.yellow('?')}${DIM('>')} `;

    // Find if any choice is freeform
    const freeformChoice = choices.find((c) => c.freeform);

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

    function finish(result) {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(result);
    }

    // Render the choice UI with animation
    animateBoxDrawIn({ title, context, choices }).then(() => {
      // After animation completes, show the prompt
      rl.setPrompt(choicePrompt);
      rl.prompt();
    });

    // Install one-shot line handler
    async function handleLine(input) {
      if (resolved) return;
      const trimmed = String(input || '').trim();

      if (!trimmed) {
        // Empty input: re-prompt
        rl.prompt();
        return;
      }

      // Try parsing as a number
      const num = parseInt(trimmed, 10);
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
            rl.on('line', handleLine);
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
      console.log(`  ${ERROR('Invalid selection.')} Pick ${ACCENT('1')}-${ACCENT(String(choices.length))}${freeformChoice ? ' or type your response' : ''}`);
      rl.prompt();
    }

    rl.on('line', handleLine);

    // Timeout
    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        if (!resolved) {
          console.log(DIM(`  (timed out after ${Math.round(timeoutMs / 1000)}s, auto-selecting default)`));
          finish({ value: defaultValue, autoAcceptAll: false, timedOut: true });
        }
      }, timeoutMs);
      // Don't keep process alive for timeout
      if (timeoutId.unref) timeoutId.unref();
    }
  });
}
