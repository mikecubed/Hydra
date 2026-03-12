/**
 * Hydra Intent Gate — Normalize and optionally rewrite user prompts
 * before they reach classifyPrompt(), improving routing accuracy for
 * abbreviated or ambiguous inputs.
 *
 * Two phases:
 *   1. normalizeIntent() — synchronous heuristic, always runs, zero cost
 *   2. LLM rewrite — async, only triggered when classifyPrompt confidence is low
 */

import { classifyPrompt } from './hydra-utils.ts';
import { loadHydraConfig } from './hydra-config.ts';

// ── Filler phrases stripped from the start of prompts ────────────────────────
const FILLER_PATTERNS = [
  /^please\s+/i,
  /^can you\s+/i,
  /^could you\s+/i,
  /^would you\s+/i,
  /^just\s+/i,
  /^quickly\s+/i,
  /^help me\s+/i,
  /^i need you to\s+/i,
  /^i want you to\s+/i,
  /^go ahead and\s+/i,
];

// ── Abbreviation expansion pairs ─────────────────────────────────────────────
const ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bimpl\b/gi, 'implement'],
  [/\bfn\b/g, 'function'],
  [/\bauth\b/gi, 'authentication'],
  [/\bconfig\b/gi, 'configuration'],
  [/\butil\b/gi, 'utility'],
  [/\butils\b/gi, 'utilities'],
  [/\bparams\b/gi, 'parameters'],
  [/\bparam\b/gi, 'parameter'],
  [/\benv\b/gi, 'environment'],
  [/\bdoc\b/gi, 'documentation'],
  [/\bdocs\b/gi, 'documentation'],
  [/\bopt\b/gi, 'optimize'],
];

/**
 * Synchronous heuristic normalization. Always runs, zero cost.
 * Strips leading filler words and expands common abbreviations.
 * @param {string} text
 * @returns {string}
 */
export function normalizeIntent(text: string): string {
  if (text.trim() === '') return '';
  let result = text.trim();

  // Strip leading filler — repeat until stable (handles "please just fix")
  let prev;
  do {
    prev = result;
    for (const pattern of FILLER_PATTERNS) {
      result = result.replace(pattern, '').trim();
    }
  } while (result !== prev);

  for (const [pattern, replacement] of ABBREVIATIONS) {
    result = result.replace(pattern, replacement);
  }

  return result.trim();
}

/**
 * Async intent gate. Normalizes first, then optionally rewrites via LLM
 * when classifyPrompt() returns low confidence.
 *
 * @param {string} text - Raw user prompt
 * @param {object} [opts]
 * @param {boolean} [opts.enabled=true] - false = passthrough with no changes
 * @param {number} [opts.confidenceThreshold=0.55] - LLM rewrite triggered below this
 * @param {Function} [opts.rewriteFn] - Override LLM rewrite function (for testing)
 * @param {Function} [opts.onLlmCall] - Called when LLM path is taken (for testing)
 * @returns {Promise<{text: string, classification: object, normalized: boolean, rewritten: boolean}>}
 */
interface GateIntentOpts {
  enabled?: boolean;
  confidenceThreshold?: number;
  rewriteFn?: ((text: string) => Promise<string | null>) | null;
  onLlmCall?: (() => void) | null;
}

export async function gateIntent(
  text: string,
  opts: GateIntentOpts = {},
): Promise<{
  text: string;
  classification: ReturnType<typeof classifyPrompt>;
  normalized: boolean;
  rewritten: boolean;
}> {
  const { enabled = true, confidenceThreshold = 0.55, rewriteFn = null, onLlmCall = null } = opts;

  if (!enabled) {
    return { text, classification: classifyPrompt(text), normalized: false, rewritten: false };
  }

  const normalized = normalizeIntent(text);
  const classification = classifyPrompt(normalized);

  if (classification.confidence >= confidenceThreshold) {
    return { text: normalized, classification, normalized: true, rewritten: false };
  }

  // Low confidence — attempt LLM rewrite
  if (onLlmCall) onLlmCall();

  try {
    const doRewrite = rewriteFn ?? defaultRewriteFn;
    const rewritten = await doRewrite(text);
    if (rewritten != null && rewritten.trim() !== '') {
      const rewrittenClassification = classifyPrompt(rewritten.trim());
      return {
        text: rewritten.trim(),
        classification: rewrittenClassification,
        normalized: true,
        rewritten: true,
      };
    }
  } catch {
    // Fall back silently — never block dispatch
  }

  return { text: normalized, classification, normalized: true, rewritten: false };
}

/**
 * Default LLM rewrite using the local/fast model via hydra-local.ts.
 * Dynamic import avoids circular deps at load time.
 */
async function defaultRewriteFn(text: string): Promise<string | null> {
  let streamLocalCompletion;
  try {
    ({ streamLocalCompletion } = await import('./hydra-local.ts'));
  } catch {
    return null;
  }

  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    {
      role: 'system' as const,
      content: [
        "Rewrite the user's instruction as a clear, direct, one-sentence technical task.",
        'Remove ambiguity. Keep it concise.',
        'Output only the rewritten task, no explanation.',
      ].join(' '),
    },
    { role: 'user' as const, content: text },
  ];

  let result = '';
  const cfg = loadHydraConfig();
  const localCfg = {
    model: (cfg.local.model as string | undefined) ?? 'llama3',
    baseUrl: (cfg.local.baseUrl as string | undefined) ?? 'http://localhost:11434/v1',
  };
  await streamLocalCompletion(messages, localCfg, (chunk: string) => {
    result += chunk;
  });
  return result.trim() === '' ? null : result.trim();
}
