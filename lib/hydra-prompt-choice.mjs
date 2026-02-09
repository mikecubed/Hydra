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

function renderChoiceUI({ title, context, choices }) {
  const lines = [];

  lines.push(sectionHeader(title || 'Selection'));
  lines.push('');

  // Context key/value pairs
  if (context && typeof context === 'object') {
    for (const [key, value] of Object.entries(context)) {
      if (value !== undefined && value !== null && value !== '') {
        lines.push(label(key, String(value)));
      }
    }
    lines.push('');
  }

  // Numbered choices
  for (let i = 0; i < choices.length; i++) {
    const num = ACCENT(String(i + 1).padStart(2));
    const choiceLabel = pc.white(choices[i].label);
    const hint = choices[i].hint ? DIM(`  ${choices[i].hint}`) : '';
    lines.push(`  ${num}  ${choiceLabel}${hint}`);
  }

  lines.push('');
  return lines.join('\n');
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

    // Render the choice UI
    console.log(renderChoiceUI({ title, context, choices }));

    // Set choice prompt
    rl.setPrompt(choicePrompt);
    rl.prompt();

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
