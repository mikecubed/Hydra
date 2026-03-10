/**
 * Hydra Google — Streaming client for Google Gemini Generative Language API.
 *
 * Mirrors hydra-openai.mjs pattern for the Google Gemini API.
 * Used by the concierge fallback chain when OpenAI and Anthropic are unavailable.
 *
 * Uses hydra-streaming-middleware.mjs for rate limiting, circuit breaking,
 * retry, usage tracking, and latency measurement.
 */

import { createStreamingPipeline } from './hydra-streaming-middleware.ts';

interface GooglePart {
  text?: string;
  thought?: boolean;
}

interface GoogleBody {
  contents: Array<{ role: string; parts: Array<{ text: string }> }>;
  systemInstruction?: { parts: Array<{ text: string }> };
  generationConfig?: {
    maxOutputTokens?: number;
    responseMimeType?: string;
  };
}

interface GoogleApiError extends Error {
  status?: number;
  isRateLimit?: boolean;
  retryAfterMs?: number | null;
}

/**
 * Core Google streaming function — ONLY does the HTTP call + SSE parsing.
 * All cross-cutting concerns (rate limit, retry, usage, etc.) are handled by middleware.
 */
async function coreStreamGoogle(
  messages: unknown[],
  cfg: Record<string, unknown> & { model?: string },
  onChunk: ((chunk: string) => void) | null,
) {
  const apiKey = process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY'];
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY or GOOGLE_API_KEY not set');
  }

  if (!cfg.model) {
    throw new Error('streamGoogleCompletion requires cfg.model to be set');
  }

  // Extract system message and map roles
  let systemText = '';
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    const role = m['role'];
    const content = typeof m['content'] === 'string' ? m['content'] : '';
    if (role === 'system') {
      systemText += (systemText ? '\n\n' : '') + content;
    } else {
      // Map assistant → model for Gemini API
      const mappedRole = role === 'assistant' ? 'model' : 'user';
      contents.push({ role: mappedRole, parts: [{ text: content }] });
    }
  }

  const body: GoogleBody = { contents };

  if (systemText) {
    body.systemInstruction = { parts: [{ text: systemText }] };
  }

  if (cfg['maxTokens']) {
    body.generationConfig = {
      ...body.generationConfig,
      maxOutputTokens: cfg['maxTokens'] as number,
    };
  }

  if (cfg['responseType'] === 'json') {
    body.generationConfig ??= {};
    body.generationConfig.responseMimeType = 'application/json';
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err: GoogleApiError = new Error(
      `Google API error ${String(res.status)}: ${errText.slice(0, 200)}`,
    );
    err.status = res.status;
    // Attach rate limit metadata for callers to handle
    if (res.status === 429 || /RESOURCE_EXHAUSTED|QUOTA_EXHAUSTED/i.test(errText)) {
      err.isRateLimit = true;
      const retryAfter = res.headers.get('retry-after');
      err.retryAfterMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : null;
    }
    throw err;
  }

  // Parse SSE stream
  if (!res.body) throw new Error('Response body is null');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullResponse = '';
  let usage: { prompt_tokens: number; completion_tokens: number } | null = null;

  for (;;) {
    const chunk = (await reader.read()) as { done: boolean; value: Uint8Array };
    if (chunk.done) break;

    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;

      try {
        const data = JSON.parse(trimmed.slice(6)) as Record<string, unknown>;

        // Extract text from candidates (skip thinking/thought parts)
        type GeminiCandidate = { content?: { parts?: GooglePart[] } };
        const candidates = data['candidates'] as GeminiCandidate[] | undefined;
        const parts = candidates?.[0]?.content?.parts;
        if (parts) {
          for (const part of parts) {
            if (part.text && !part.thought) {
              fullResponse += part.text;
              if (onChunk) onChunk(part.text);
            }
          }
        }

        // Extract usage metadata
        type GeminiUsage = { promptTokenCount?: number; candidatesTokenCount?: number };
        const usageMetadata = data['usageMetadata'] as GeminiUsage | undefined;
        if (usageMetadata) {
          usage = {
            prompt_tokens: usageMetadata.promptTokenCount ?? 0,
            completion_tokens: usageMetadata.candidatesTokenCount ?? 0,
          };
        }
      } catch {
        // Skip malformed SSE chunks
      }
    }
  }

  // Google doesn't send rate limit headers on success — return null rateLimits
  return { fullResponse, usage, rateLimits: null };
}

// Create the pipeline-wrapped version
const pipelinedStream = createStreamingPipeline('google', coreStreamGoogle);

/**
 * Stream a chat completion from the Google Gemini API.
 *
 * @param {Array<{role: string, content: string}>} messages - Chat messages
 * @param {object} cfg - Configuration
 * @param {string} cfg.model - Model identifier (required)
 * @param {number} [cfg.maxTokens] - Optional max output tokens
 * @param {Function} [onChunk] - Called with each streamed text chunk
 * @returns {Promise<{fullResponse: string, usage: {prompt_tokens: number, completion_tokens: number}|null}>}
 */
export async function streamGoogleCompletion(
  messages: unknown[],
  cfg: Record<string, unknown> & { model?: string },
  onChunk: ((chunk: string) => void) | null,
): Promise<{
  fullResponse: string;
  usage: { prompt_tokens: number; completion_tokens: number } | null;
  rateLimits: null;
}> {
  return pipelinedStream(messages, cfg, onChunk) as Promise<{
    fullResponse: string;
    usage: { prompt_tokens: number; completion_tokens: number } | null;
    rateLimits: null;
  }>;
}
