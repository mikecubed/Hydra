/**
 * Hydra Anthropic — Streaming client for Anthropic Messages API.
 *
 * Mirrors hydra-openai.mjs pattern for the Anthropic Claude API.
 * Used by the concierge fallback chain when OpenAI is unavailable.
 *
 * Uses hydra-streaming-middleware.mjs for rate limiting, circuit breaking,
 * retry, usage tracking, and latency measurement.
 */

import { createStreamingPipeline } from './hydra-streaming-middleware.ts';

interface ChatMessage {
  role: string;
  content: string;
}

interface AnthropicStreamCfg {
  model?: string;
  maxTokens?: number;
  thinkingBudget?: number;
}

interface AnthropicUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

interface AnthropicRateLimits {
  remainingRequests: number | null;
  remainingInputTokens: number | null;
  remainingOutputTokens: number | null;
  remainingTokens: number | null;
  resetRequests: string | null;
}

interface AnthropicStreamResult {
  fullResponse: string;
  usage: AnthropicUsage | null;
  rateLimits: AnthropicRateLimits;
}

interface AnthropicBody {
  model: string;
  messages: { role: string; content: string }[];
  max_tokens: number;
  stream: boolean;
  system?: string;
  thinking?: { type: 'enabled'; budget_tokens: number };
}

interface AnthropicSSEDelta {
  type?: string;
  text?: string;
  output_tokens?: number;
}

interface AnthropicSSEChunk {
  type?: string;
  delta?: AnthropicSSEDelta;
  usage?: { output_tokens?: number };
  message?: { usage?: { input_tokens?: number } };
}

function buildAnthropicBody(
  messages: ChatMessage[],
  cfg: AnthropicStreamCfg,
): { body: AnthropicBody; systemText: string } {
  let systemText = '';
  const filteredMessages: { role: string; content: string }[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemText += (systemText === '' ? '' : '\n\n') + msg.content;
    } else {
      filteredMessages.push({ role: msg.role, content: msg.content });
    }
  }
  const body: AnthropicBody = {
    model: cfg.model ?? '',
    messages: filteredMessages,
    max_tokens: cfg.maxTokens ?? 4096,
    stream: true,
  };
  if (systemText !== '') body.system = systemText;
  if (cfg.thinkingBudget != null && cfg.thinkingBudget > 0) {
    body.thinking = { type: 'enabled', budget_tokens: cfg.thinkingBudget };
  }
  return { body, systemText };
}

function parseAnthropicRateLimits(headers: Headers): AnthropicRateLimits {
  const parse = (h: string | null): number | null => {
    const v = Number.parseInt(h ?? '');
    return Number.isNaN(v) ? null : v;
  };
  return {
    remainingRequests: parse(headers.get('anthropic-ratelimit-requests-remaining')),
    remainingInputTokens: parse(headers.get('anthropic-ratelimit-input-tokens-remaining')),
    remainingOutputTokens: parse(headers.get('anthropic-ratelimit-output-tokens-remaining')),
    remainingTokens: parse(headers.get('anthropic-ratelimit-tokens-remaining')),
    resetRequests: headers.get('anthropic-ratelimit-requests-reset'),
  };
}

function updateAnthropicUsage(
  data: AnthropicSSEChunk,
  currentUsage: AnthropicUsage | null,
): AnthropicUsage | null {
  let usage = currentUsage;
  if (data.type === 'message_delta' && data.usage != null) {
    usage ??= { prompt_tokens: 0, completion_tokens: 0 };
    usage.completion_tokens = data.usage.output_tokens ?? 0;
  }
  if (data.type === 'message_start' && data.message?.usage != null) {
    usage ??= { prompt_tokens: 0, completion_tokens: 0 };
    usage.prompt_tokens = data.message.usage.input_tokens ?? 0;
  }
  return usage;
}

function parseAnthropicSSELine(
  line: string,
  currentUsage: AnthropicUsage | null,
  onText: (text: string) => void,
): AnthropicUsage | null {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith(':')) return currentUsage;
  if (trimmed.startsWith('event: ')) return currentUsage;
  if (!trimmed.startsWith('data: ')) return currentUsage;
  try {
    const data = JSON.parse(trimmed.slice(6)) as AnthropicSSEChunk;
    if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
      const text = data.delta.text;
      if (text != null && text !== '') onText(text);
    }
    return updateAnthropicUsage(data, currentUsage);
  } catch {
    // Skip malformed SSE chunks
  }
  return currentUsage;
}

/**
 * Core Anthropic streaming function — ONLY does the HTTP call + SSE parsing.
 * All cross-cutting concerns (rate limit, retry, usage, etc.) are handled by middleware.
 */
async function coreStreamAnthropic(
  messages: ChatMessage[],
  cfg: AnthropicStreamCfg,
  onChunk: ((chunk: string) => void) | undefined,
): Promise<AnthropicStreamResult> {
  const apiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
  if (apiKey === '') throw new Error('ANTHROPIC_API_KEY not set');
  if (cfg.model == null || cfg.model === '') {
    throw new Error('streamAnthropicCompletion requires cfg.model to be set');
  }

  const { body } = buildAnthropicBody(messages, cfg);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  const rateLimits = parseAnthropicRateLimits(res.headers);

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw Object.assign(
      new Error(`Anthropic API error ${String(res.status)}: ${errText.slice(0, 200)}`),
      { status: res.status },
    );
  }

  if (!res.body) throw new Error('Response body is null');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullResponse = '';
  let usage: AnthropicUsage | null = null;

  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- intentionally sequential: SSE stream must be read chunk-by-chunk in order; each chunk depends on the previous reader state
    const readResult = await reader.read();
    if (readResult.done) break;

    buffer += decoder.decode(readResult.value as Uint8Array, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      usage = parseAnthropicSSELine(line, usage, (text) => {
        fullResponse += text;
        if (onChunk) onChunk(text);
      });
    }
  }

  return { fullResponse, usage, rateLimits };
}

// Create the pipeline-wrapped version
const pipelinedStream = createStreamingPipeline(
  'anthropic',
  coreStreamAnthropic as unknown as (
    messages: unknown[],
    cfg: Record<string, unknown>,
    onChunk: ((chunk: string) => void) | null,
  ) => Promise<unknown>,
) as (
  messages: ChatMessage[],
  cfg: AnthropicStreamCfg,
  onChunk: ((chunk: string) => void) | undefined,
) => Promise<AnthropicStreamResult>;

export function streamAnthropicCompletion(
  messages: ChatMessage[],
  cfg: AnthropicStreamCfg,
  onChunk?: (chunk: string) => void,
): Promise<AnthropicStreamResult> {
  return pipelinedStream(messages, cfg, onChunk);
}
