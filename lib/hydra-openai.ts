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

interface OpenAISSEChunk {
  choices?: Array<{ delta?: { content?: string } }>;
  usage?: OpenAIUsage;
}

function buildOpenAIBody(cfg: StreamCfg, messages: ChatMessage[]): OpenAIBody {
  const reasoningEffort = cfg.reasoningEffort ?? 'xhigh';
  const isReasoningModel = /^o\d/.test(cfg.model);
  const body: OpenAIBody = { model: cfg.model, messages, stream: true };
  if (isReasoningModel) body.reasoning = { effort: reasoningEffort };
  if (cfg.maxTokens != null && cfg.maxTokens !== 0) body.max_completion_tokens = cfg.maxTokens;
  return body;
}

function parseOpenAIRateLimits(headers: Headers): RateLimits {
  const parse = (h: string | null): number | null => {
    const v = Number.parseInt(h ?? '');
    return Number.isNaN(v) ? null : v;
  };
  return {
    remainingRequests: parse(headers.get('x-ratelimit-remaining-requests')),
    remainingTokens: parse(headers.get('x-ratelimit-remaining-tokens')),
    resetRequests: headers.get('x-ratelimit-reset-requests'),
    resetTokens: headers.get('x-ratelimit-reset-tokens'),
  };
}

function parseOpenAISSELine(
  line: string,
  currentUsage: OpenAIUsage | null,
  onText: (text: string) => void,
): OpenAIUsage | null {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed === 'data: [DONE]') return currentUsage;
  if (!trimmed.startsWith('data: ')) return currentUsage;
  try {
    const data = JSON.parse(trimmed.slice(6)) as OpenAISSEChunk;
    const content = data.choices?.[0]?.delta?.content;
    if (content != null && content !== '') onText(content);
    if (data.usage != null) return data.usage;
  } catch {
    // Skip malformed SSE chunks
  }
  return currentUsage;
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
  const apiKey = process.env['OPENAI_API_KEY'] ?? '';
  if (apiKey === '') throw new Error('OPENAI_API_KEY not set');
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime defense: cfg.model may be nullish from untyped callers
  if (cfg.model == null || cfg.model === '')
    throw new Error('streamCompletion requires cfg.model to be set');

  const body = buildOpenAIBody(cfg, messages);

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });

  const rateLimits = parseOpenAIRateLimits(res.headers);

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw Object.assign(
      new Error(`OpenAI API error ${String(res.status)}: ${errText.slice(0, 200)}`),
      { status: res.status },
    );
  }

  if (!res.body) throw new Error('Response body is null');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullResponse = '';
  let usage: OpenAIUsage | null = null;

  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- intentionally sequential: SSE stream must be read chunk-by-chunk in order; each chunk depends on the previous reader state
    const readResult = await reader.read();
    if (readResult.done) break;

    buffer += decoder.decode(readResult.value as Uint8Array, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      usage = parseOpenAISSELine(line, usage, (text) => {
        fullResponse += text;
        if (onChunk) onChunk(text);
      });
    }
  }

  return { fullResponse, usage, rateLimits };
}

// Create the pipeline-wrapped version
const pipelinedStream = createStreamingPipeline(
  'openai',
  coreStreamOpenAI as unknown as (
    messages: unknown[],
    cfg: Record<string, unknown>,
    onChunk: ((chunk: string) => void) | null,
  ) => Promise<unknown>,
) as (
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
