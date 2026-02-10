/**
 * Hydra Model Recovery — Post-hoc detection and fallback for model errors.
 *
 * When an agent CLI fails because the configured model is unavailable
 * (e.g. Codex rejecting codex-5.3 on a ChatGPT account), this module detects
 * the error, offers fallback selection, and retries — so a single bad model
 * config doesn't kill an entire session.
 *
 * Pattern: check the result AFTER failure, then decide whether to recover.
 * Zero overhead on successful calls. Callers opt in explicitly.
 */

import { loadHydraConfig } from './hydra-config.mjs';
import { getActiveModel, setActiveModel } from './hydra-agents.mjs';

// ── Rate Limit Detection Patterns ───────────────────────────────────────────

const RATE_LIMIT_PATTERNS = [
  // Google / Gemini
  /RESOURCE_EXHAUSTED/i,
  /QUOTA_EXHAUSTED/i,
  /429\s*(?:Too Many Requests|Resource Exhausted)/i,
  /rate[_ ]?limit/i,
  /quota[_ ]?exceeded/i,

  // OpenAI / Codex
  /Rate limit reached/i,
  /Too Many Requests/i,
  /tokens per min/i,
  /requests per min/i,

  // Anthropic / Claude
  /overloaded_error/i,
  /rate_limit_error/i,

  // HTTP status
  /\b429\b.*(?:error|status|code)/i,
  /(?:error|status|code).*\b429\b/i,

  // Generic
  /too many requests/i,
  /capacity/i,
];

/**
 * Extract a Retry-After delay (in ms) from error text, if present.
 * Looks for "Retry-After: N" header or "retry after N seconds" prose.
 */
function extractRetryAfterMs(text) {
  // "Retry-After: 30" (HTTP header style)
  const header = text.match(/retry[- ]after[:\s]+(\d+)/i);
  if (header) {
    const val = parseInt(header[1], 10);
    // If value > 1000, it's probably already in ms; if small, treat as seconds
    return val > 1000 ? val : val * 1000;
  }
  // "retry after 30 seconds" / "wait 30s"
  const prose = text.match(/(?:retry|wait)\s+(?:after\s+)?(\d+)\s*(?:s(?:ec(?:ond)?s?)?|ms)/i);
  if (prose) {
    const val = parseInt(prose[1], 10);
    const unit = prose[0].toLowerCase();
    return unit.includes('ms') ? val : val * 1000;
  }
  return null;
}

// ── Error Detection Patterns ────────────────────────────────────────────────

const MODEL_ERROR_PATTERNS = [
  // Codex / OpenAI
  /model\b.*\bis[_ ]not[_ ]supported/i,
  /model\b.*\bdoes[_ ]not[_ ]exist/i,
  /model[_-]?not[_-]?found/i,
  /that model is not available/i,

  // Claude / Anthropic
  /model\b.*\bis[_ ]not[_ ]available/i,
  /invalid[_-]?model/i,
  /model:.*not found/i,

  // Gemini / Google
  /Model not found/i,
  /PERMISSION_DENIED.*model/i,
  /models\/\S+ is not found/i,

  // Generic
  /unsupported model/i,
  /model.*unavailable/i,
  /unknown model/i,
  /could not find model/i,
];

/**
 * Extract the failed model ID from an error message, if possible.
 */
function extractModelFromError(text) {
  // "The model `gpt-999` does not exist" / "model 'gpt-999' not found"
  const quoted = text.match(/model\s+[`'"]([\w.:-]+)[`'"]/i);
  if (quoted) return quoted[1];
  // "The 'gpt-999' model is not supported" (reversed order)
  const preQuoted = text.match(/[`'"]([\w.:-]+)[`'"]\s+model/i);
  if (preQuoted) return preQuoted[1];
  // "model gpt-999 is not supported"
  const bare = text.match(/model\s+([\w.:-]+)\s+(?:is|does|not)/i);
  if (bare && !['is', 'does', 'not'].includes(bare[1].toLowerCase())) return bare[1];
  // "models/gemini-999 is not found"
  const modelsSlash = text.match(/models\/([\w.:-]+)/i);
  if (modelsSlash) return modelsSlash[1];
  return null;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Check whether a failed agent result is due to a rate limit / quota error.
 *
 * @param {string} agent - Agent name (claude, codex, gemini)
 * @param {object} result - executeAgent result: { ok, output, stderr, error }
 * @returns {{ isRateLimit: boolean, retryAfterMs: number|null, errorMessage: string }}
 */
export function detectRateLimitError(agent, result) {
  if (!result || result.ok) {
    return { isRateLimit: false, retryAfterMs: null, errorMessage: '' };
  }

  const sources = [
    result.stderr || '',
    result.output || '',
    result.error || '',
  ].join('\n');

  for (const pattern of RATE_LIMIT_PATTERNS) {
    if (pattern.test(sources)) {
      const retryAfterMs = extractRetryAfterMs(sources);
      const matchLine = sources.split('\n').find(l => pattern.test(l)) || sources.slice(0, 200);
      return {
        isRateLimit: true,
        retryAfterMs,
        errorMessage: matchLine.trim().slice(0, 300),
      };
    }
  }

  return { isRateLimit: false, retryAfterMs: null, errorMessage: '' };
}

/**
 * Calculate exponential backoff delay with jitter.
 *
 * @param {number} attempt - 0-indexed attempt number
 * @param {object} [opts]
 * @param {number} [opts.baseDelayMs=5000] - Base delay for first retry
 * @param {number} [opts.maxDelayMs=60000] - Maximum delay cap
 * @param {number} [opts.retryAfterMs] - Server-suggested delay (overrides calculation)
 * @returns {number} delay in ms
 */
export function calculateBackoff(attempt, opts = {}) {
  const { baseDelayMs = 5000, maxDelayMs = 60_000, retryAfterMs } = opts;

  // Honour server-suggested delay if present
  if (retryAfterMs && retryAfterMs > 0) {
    return Math.min(retryAfterMs, maxDelayMs);
  }

  // Exponential backoff: base * 2^attempt + jitter (0-25% of delay)
  const exponential = baseDelayMs * Math.pow(2, attempt);
  const capped = Math.min(exponential, maxDelayMs);
  const jitter = Math.random() * capped * 0.25;
  return Math.round(capped + jitter);
}

/**
 * Check whether a failed agent result is due to a model error.
 *
 * @param {string} agent - Agent name (claude, codex, gemini)
 * @param {object} result - executeAgent result: { ok, output, stderr, error }
 * @returns {{ isModelError: boolean, failedModel: string|null, errorMessage: string }}
 */
export function detectModelError(agent, result) {
  if (!result || result.ok) {
    return { isModelError: false, failedModel: null, errorMessage: '' };
  }

  // Combine all text sources to scan
  const sources = [
    result.stderr || '',
    result.output || '',
    result.error || '',
  ].join('\n');

  for (const pattern of MODEL_ERROR_PATTERNS) {
    if (pattern.test(sources)) {
      const failedModel = extractModelFromError(sources) || getActiveModel(agent) || null;
      // Find the matching line for a descriptive error message
      const matchLine = sources.split('\n').find(l => pattern.test(l)) || sources.slice(0, 200);
      return {
        isModelError: true,
        failedModel,
        errorMessage: matchLine.trim().slice(0, 300),
      };
    }
  }

  return { isModelError: false, failedModel: null, errorMessage: '' };
}

/**
 * Get fallback model candidates for an agent, excluding the failed model.
 * Reads config presets (default, fast, cheap) + aliases. Does NOT call
 * the expensive fetchModels() API — keeps it fast.
 *
 * @param {string} agent - Agent name
 * @param {string} failedModel - The model that failed
 * @returns {Array<{ id: string, label: string, source: string }>}
 */
export function getFallbackCandidates(agent, failedModel) {
  const cfg = loadHydraConfig();
  const agentModels = cfg.models?.[agent] || {};
  const aliases = cfg.aliases?.[agent] || {};

  const seen = new Set();
  const failed = (failedModel || '').toLowerCase();
  const candidates = [];

  // 1. Config presets in priority order
  for (const preset of ['default', 'fast', 'cheap']) {
    const modelId = agentModels[preset];
    if (modelId && modelId.toLowerCase() !== failed && !seen.has(modelId.toLowerCase())) {
      seen.add(modelId.toLowerCase());
      candidates.push({ id: modelId, label: `${preset}: ${modelId}`, source: 'preset' });
    }
  }

  // 2. Aliases (deduplicated)
  for (const [alias, modelId] of Object.entries(aliases)) {
    if (modelId && modelId.toLowerCase() !== failed && !seen.has(modelId.toLowerCase())) {
      seen.add(modelId.toLowerCase());
      candidates.push({ id: modelId, label: `${alias}: ${modelId}`, source: 'alias' });
    }
  }

  return candidates;
}

/**
 * Attempt to recover from a model error by selecting a fallback model.
 *
 * Two modes:
 * - **Interactive** (opts.rl + TTY): Uses promptChoice() for user selection
 * - **Headless** (no rl / no TTY): Auto-selects the first candidate
 *
 * On success, persists via setActiveModel() if autoPersist is enabled.
 *
 * @param {string} agent - Agent name
 * @param {string} failedModel - The model that failed
 * @param {object} [opts]
 * @param {object} [opts.rl] - readline interface for interactive mode
 * @returns {Promise<{ recovered: boolean, newModel: string|null }>}
 */
export async function recoverFromModelError(agent, failedModel, opts = {}) {
  const cfg = loadHydraConfig();
  const recoveryCfg = cfg.modelRecovery || {};

  if (recoveryCfg.enabled === false) {
    return { recovered: false, newModel: null };
  }

  const candidates = getFallbackCandidates(agent, failedModel);
  if (candidates.length === 0) {
    return { recovered: false, newModel: null };
  }

  const isInteractive = opts.rl && process.stdout.isTTY;

  let selected = null;

  if (isInteractive) {
    // Interactive mode — use promptChoice if available
    try {
      const { promptChoice } = await import('./hydra-prompt-choice.mjs');
      const { pickModel } = await import('./hydra-models-select.mjs');

      const options = candidates.map(c => c.label);
      options.push('Browse all models...');
      options.push('Skip (disable agent)');

      const { value } = await promptChoice(opts.rl, {
        title: `Model error: ${failedModel || 'unknown'} is unavailable for ${agent}`,
        context: { 'Failed model': failedModel || 'unknown', Agent: agent },
        options,
      });

      if (value === 'Skip (disable agent)') {
        return { recovered: false, newModel: null };
      }

      if (value === 'Browse all models...') {
        // Delegate to full model picker
        const pickedModel = await pickModel(agent);
        if (pickedModel) {
          selected = pickedModel;
        } else {
          return { recovered: false, newModel: null };
        }
      } else {
        // Find the candidate matching the selected label
        const match = candidates.find(c => c.label === value);
        selected = match ? match.id : null;
      }
    } catch {
      // promptChoice not available or failed — fall through to headless
      selected = candidates[0].id;
    }
  } else {
    // Headless mode — auto-select first candidate
    if (recoveryCfg.headlessFallback === false) {
      return { recovered: false, newModel: null };
    }
    selected = candidates[0].id;
  }

  if (!selected) {
    return { recovered: false, newModel: null };
  }

  // Persist the new model selection
  if (recoveryCfg.autoPersist !== false) {
    setActiveModel(agent, selected);
  }

  return { recovered: true, newModel: selected };
}

/**
 * Check whether model recovery is enabled in config.
 * @returns {boolean}
 */
export function isModelRecoveryEnabled() {
  const cfg = loadHydraConfig();
  return cfg.modelRecovery?.enabled !== false;
}
