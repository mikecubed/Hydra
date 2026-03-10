/**
 * Hydra OpenAI — Shared streaming client for OpenAI chat completions API.
 *
 * Extracted from hydra-concierge.mjs so both the concierge and the evolve
 * investigator can use the same SSE streaming logic without duplication.
 *
 * Uses hydra-streaming-middleware.mjs for rate limiting, circuit breaking,
 * retry, usage tracking, and latency measurement.
 */

import { createStreamingPipeline } from './hydra-streaming-middleware.ts';

interface ChatMessage {
  role: string;
  content: string;
}

interface StreamCfg {
  model: string;
  reasoningEffort?: string;
  maxTokens?: number;
  thinkingBudget?: number;
}

interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
}

interface RateLimits {
  remainingRequests: number | null;
  remainingTokens: number | null;
  resetRequests: string | null;
  resetTokens: string | null;
}

interface StreamResult {
  fullResponse: string;
  usage: OpenAIUsage | null;
  rateLimits: RateLimits;
}

interface OpenAIBody {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  reasoning?: { effort: string };
  max_completion_tokens?: number;
}

/**
 * Core OpenAI streaming function — ONLY does the HTTP call + SSE parsing.
 * All cross-cutting concerns (rate limit, retry, usage, etc.) are handled by middleware.
 */
async function coreStreamOpenAI(
  messages: ChatMessage[],
  cfg: StreamCfg,
  onChunk: ((chunk: string) => void) | undefined,
): Promise<StreamResult> {
  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not set');
  }

  if (!cfg.model) {
    throw new Error('streamCompletion requires cfg.model to be set');
  }
  const model = cfg.model;
  const reasoningEffort = cfg.reasoningEffort ?? 'xhigh';

  // Reasoning models: o-series only (o1, o3, o4-mini) — gpt-5 does NOT support `reasoning`
  const isReasoningModel = /^o\d/.test(model);

  const body: OpenAIBody = {
    model,
    messages,
    stream: true,
  };

  if (isReasoningModel) {
    body.reasoning = { effort: reasoningEffort };
  }

  if (cfg.maxTokens) {
    body.max_completion_tokens = cfg.maxTokens;
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  // Capture rate limit headers (available on both success and error responses)
  const parseRateHeader = (h: string | null): number | null => {
    const v = Number.parseInt(h ?? '');
    return Number.isNaN(v) ? null : v;
  };
  const rateLimits = {
    remainingRequests: parseRateHeader(res.headers.get('x-ratelimit-remaining-requests')),
    remainingTokens: parseRateHeader(res.headers.get('x-ratelimit-remaining-tokens')),
    resetRequests: res.headers.get('x-ratelimit-reset-requests'),
    resetTokens: res.headers.get('x-ratelimit-reset-tokens'),
  };

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err = Object.assign(new Error(`OpenAI API error ${String(res.status)}: ${errText.slice(0, 200)}`), {
      status: res.status,
    });
    throw err;
  }

  // Parse SSE stream
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullResponse = '';
  let usage: OpenAIUsage | null = null;

  for (;;) {
    const readResult = await reader.read();
    if (readResult.done) break;
    const value = readResult.value as Uint8Array;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data: ')) continue;

      try {
        interface SSEChunk {
          choices?: Array<{ delta?: { content?: string } }>;
          usage?: OpenAIUsage;
        }
        const data = JSON.parse(trimmed.slice(6)) as SSEChunk;
        const delta = data.choices?.[0]?.delta;
        if (delta?.content) {
          fullResponse += delta.content;
          if (onChunk) onChunk(delta.content);
        }
        // Capture usage from final chunk if present
        if (data.usage) {
          usage = data.usage;
        }
      } catch {
        // Skip malformed SSE chunks
      }
    }
  }

  return { fullResponse, usage, rateLimits };
}

// Create the pipeline-wrapped version
const pipelinedStream = createStreamingPipeline('openai', coreStreamOpenAI as unknown as (
  messages: unknown[],
  cfg: Record<string, unknown>,
  onChunk: ((chunk: string) => void) | null,
) => Promise<unknown>) as (
  messages: ChatMessage[],
  cfg: StreamCfg,
  onChunk: ((chunk: string) => void) | undefined,
) => Promise<StreamResult>;

export function streamCompletion(
  messages: ChatMessage[],
  cfg: StreamCfg,
  onChunk?: (chunk: string) => void,
): Promise<StreamResult> {
  return pipelinedStream(messages, cfg, onChunk);
}
