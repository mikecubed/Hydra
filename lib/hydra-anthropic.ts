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
  model: string;
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

/**
 * Core Anthropic streaming function — ONLY does the HTTP call + SSE parsing.
 * All cross-cutting concerns (rate limit, retry, usage, etc.) are handled by middleware.
 */
async function coreStreamAnthropic(
  messages: ChatMessage[],
  cfg: AnthropicStreamCfg,
  onChunk: ((chunk: string) => void) | undefined,
): Promise<AnthropicStreamResult> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }

  if (!cfg.model) {
    throw new Error('streamAnthropicCompletion requires cfg.model to be set');
  }

  // Extract system message from array → separate system param (Anthropic requirement)
  let systemText = '';
  const filteredMessages = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemText += (systemText ? '\n\n' : '') + msg.content;
    } else {
      filteredMessages.push({ role: msg.role, content: msg.content });
    }
  }

  const body: AnthropicBody = {
    model: cfg.model,
    messages: filteredMessages,
    max_tokens: cfg.maxTokens ?? 4096,
    stream: true,
  };

  if (systemText) {
    body.system = systemText;
  }

  // Extended thinking support
  if (cfg.thinkingBudget && cfg.thinkingBudget > 0) {
    body.thinking = {
      type: 'enabled',
      budget_tokens: cfg.thinkingBudget,
    };
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  // Capture rate limit headers (Anthropic sends these on every response)
  const parseRateHeader = (h: string | null): number | null => {
    const v = Number.parseInt(h ?? '');
    return Number.isNaN(v) ? null : v;
  };
  const rateLimits: AnthropicRateLimits = {
    remainingRequests: parseRateHeader(
      res.headers.get('anthropic-ratelimit-requests-remaining'),
    ),
    remainingInputTokens: parseRateHeader(
      res.headers.get('anthropic-ratelimit-input-tokens-remaining'),
    ),
    remainingOutputTokens: parseRateHeader(
      res.headers.get('anthropic-ratelimit-output-tokens-remaining'),
    ),
    remainingTokens: parseRateHeader(res.headers.get('anthropic-ratelimit-tokens-remaining')),
    resetRequests: res.headers.get('anthropic-ratelimit-requests-reset'),
  };

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err = Object.assign(new Error(`Anthropic API error ${String(res.status)}: ${errText.slice(0, 200)}`), {
      status: res.status,
    });
    throw err;
  }

  // Parse SSE stream
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullResponse = '';
  let usage: AnthropicUsage | null = null;

  for (;;) {
    const readResult = await reader.read();
    if (readResult.done) break;
    const value = readResult.value as Uint8Array;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue;

      if (trimmed.startsWith('event: ')) continue; // skip event type lines

      if (!trimmed.startsWith('data: ')) continue;

      try {
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
        const data = JSON.parse(trimmed.slice(6)) as AnthropicSSEChunk;

        // content_block_delta → only process text_delta, skip thinking_delta
        if (
          data.type === 'content_block_delta' &&
          data.delta?.type === 'text_delta' &&
          data.delta.text
        ) {
          fullResponse += data.delta.text;
          if (onChunk) onChunk(data.delta.text);
        }

        // message_delta → usage (stop reason + output tokens)
        if (data.type === 'message_delta' && data.usage) {
          usage ??= { prompt_tokens: 0, completion_tokens: 0 };
          usage.completion_tokens = data.usage.output_tokens ?? 0;
        }

        // message_start → input usage
        if (data.type === 'message_start' && data.message?.usage) {
          usage ??= { prompt_tokens: 0, completion_tokens: 0 };
          usage.prompt_tokens = data.message.usage.input_tokens ?? 0;
        }
      } catch {
        // Skip malformed SSE chunks
      }
    }
  }

  return { fullResponse, usage, rateLimits };
}

// Create the pipeline-wrapped version
const pipelinedStream = createStreamingPipeline('anthropic', coreStreamAnthropic as unknown as (
  messages: unknown[],
  cfg: Record<string, unknown>,
  onChunk: ((chunk: string) => void) | null,
) => Promise<unknown>) as (
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
