/**
 * Codex JSONL helper utilities.
 *
 * Extracted into a standalone module to break the circular ESM dependency
 * between hydra-agents.mjs and agent-executor.mjs — both previously needed
 * these functions but importing them from agent-executor.mjs caused a cycle.
 */

/**
 * Extract human-readable text from Codex --json JSONL output.
 */
export function extractCodexText(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  const lines = raw.split('\n');
  const textParts = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.message?.content) textParts.push(obj.message.content);
      else if (obj.content) textParts.push(obj.content);
      else if (obj.text) textParts.push(obj.text);
    } catch {
      /* skip non-JSON lines */
    }
  }
  return textParts.length > 0 ? textParts.join('') : raw;
}

/**
 * Extract token usage from Codex --json JSONL output.
 * Returns { inputTokens, outputTokens, totalTokens } or null.
 */
export function extractCodexUsage(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const lines = raw.split('\n');
  let usage = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    try {
      const obj = JSON.parse(trimmed);
      const u = obj.usage || obj.token_usage;
      if (u) {
        if (!usage) usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        usage.inputTokens += u.input_tokens || u.prompt_tokens || 0;
        usage.outputTokens += u.output_tokens || u.completion_tokens || 0;
        usage.totalTokens +=
          u.total_tokens ||
          (u.input_tokens || u.prompt_tokens || 0) + (u.output_tokens || u.completion_tokens || 0);
      }
    } catch {
      /* skip */
    }
  }
  return usage;
}

/**
 * Extract error objects from Codex --json JSONL output.
 */
export function extractCodexErrors(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const lines = raw.split('\n');
  const errors = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.type === 'error' && obj.message) {
        errors.push(obj.message);
      } else if (obj.error?.message) {
        errors.push(obj.error.message);
      } else if (obj.error && typeof obj.error === 'string') {
        errors.push(obj.error);
      }
    } catch {
      /* skip */
    }
  }
  return errors;
}
