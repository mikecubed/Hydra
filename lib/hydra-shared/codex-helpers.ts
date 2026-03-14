/**
 * Codex JSONL helper utilities.
 *
 * Extracted into a standalone module to break the circular ESM dependency
 * between hydra-agents.ts and agent-executor.ts — both previously needed
 * these functions but importing them from agent-executor.ts caused a cycle.
 */

interface CodexMessageObj {
  message?: { content?: unknown };
  content?: unknown;
  text?: unknown;
}

interface CodexUsageObj {
  usage?: {
    input_tokens?: number;
    prompt_tokens?: number;
    output_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  token_usage?: {
    input_tokens?: number;
    prompt_tokens?: number;
    output_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface CodexErrorObj {
  type?: string;
  message?: string;
  error?: { message?: string } | string;
}

function tryParseJsonLine(line: string): unknown {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed[0] !== '{') return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/** Extract human-readable text from Codex --json JSONL output. */
export function extractCodexText(raw: string | null | undefined): string | null | undefined {
  if (raw == null || typeof raw !== 'string') return raw;
  const lines = raw.split('\n');
  const textParts: string[] = [];
  for (const line of lines) {
    const obj = tryParseJsonLine(line);
    if (obj === undefined || typeof obj !== 'object' || obj === null) continue;
    const o = obj as CodexMessageObj;
    if (typeof o.message?.content === 'string') textParts.push(o.message.content);
    else if (typeof o.content === 'string') textParts.push(o.content);
    else if (typeof o.text === 'string') textParts.push(o.text);
  }
  return textParts.length > 0 ? textParts.join('') : raw;
}

/** Extract token usage from Codex --json JSONL output. Returns null if not found. */
export function extractCodexUsage(
  raw: string | null | undefined,
): { inputTokens: number; outputTokens: number; totalTokens: number } | null {
  if (raw == null || typeof raw !== 'string') return null;
  const lines = raw.split('\n');
  let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null = null;
  for (const line of lines) {
    const obj = tryParseJsonLine(line);
    if (obj === undefined || typeof obj !== 'object' || obj === null) continue;
    const o = obj as CodexUsageObj;
    const u = o.usage ?? o.token_usage;
    if (u) {
      usage ??= { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      const inputTokens = u.input_tokens ?? u.prompt_tokens ?? 0;
      const outputTokens = u.output_tokens ?? u.completion_tokens ?? 0;
      usage.inputTokens += inputTokens;
      usage.outputTokens += outputTokens;
      usage.totalTokens += u.total_tokens ?? inputTokens + outputTokens;
    }
  }
  return usage;
}

/** Extract error objects from Codex --json JSONL output. */
export function extractCodexErrors(raw: string | null | undefined): string[] {
  if (raw == null || typeof raw !== 'string') return [];
  const lines = raw.split('\n');
  const errors: string[] = [];
  for (const line of lines) {
    const obj = tryParseJsonLine(line);
    if (obj === undefined || typeof obj !== 'object' || obj === null) continue;
    const o = obj as CodexErrorObj;
    if (o.type === 'error' && typeof o.message === 'string') {
      errors.push(o.message);
    } else if (typeof o.error === 'object' && typeof o.error.message === 'string') {
      errors.push(o.error.message);
    } else if (typeof o.error === 'string') {
      errors.push(o.error);
    }
  }
  return errors;
}
