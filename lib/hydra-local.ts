/**
 * Hydra Local — Streaming client for any OpenAI-compatible local endpoint.
 *
 * Wraps the OpenAI SSE streaming format with a configurable baseUrl.
 * Works with Ollama, LM Studio, vllm, llama.cpp server, and any other
 * OpenAI-compatible runtime.
 */

interface LocalMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface LocalCompletionConfig {
  model: string;
  baseUrl: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

interface LocalCompletionResult {
  ok: boolean;
  fullResponse: string;
  output: string;
  usage: Record<string, number> | null;
  rateLimits: null;
  errorCategory?: string;
}

/**
 * Stream a chat completion from a local OpenAI-compatible endpoint.
 */
export async function streamLocalCompletion(
  messages: LocalMessage[],
  cfg: LocalCompletionConfig,
  onChunk?: (chunk: string) => void,
): Promise<LocalCompletionResult> {
  const { baseUrl, model, maxTokens, signal } = cfg;

  const body: Record<string, unknown> = { model, messages, stream: true };
  if (maxTokens) body['max_tokens'] = maxTokens;

  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException };
    const errCode = e.cause?.code ?? e.code;
    const unreachable = [
      'ECONNREFUSED',
      'ENOTFOUND',
      'ETIMEDOUT',
      'ECONNRESET',
      'EHOSTUNREACH',
      'ENETUNREACH',
    ];
    if (unreachable.includes(errCode ?? '')) {
      return {
        ok: false,
        errorCategory: 'local-unavailable',
        output: '',
        fullResponse: '',
        usage: null,
        rateLimits: null,
      };
    }
    throw err;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err = new Error(`Local API error ${String(res.status)}: ${errText.slice(0, 200)}`);
    (err as NodeJS.ErrnoException & { status?: number }).status = res.status;
    throw err;
  }

  if (!res.body) {
    throw new Error('Local API response has no body');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullResponse = '';
  let usage = null;

  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- intentionally sequential: SSE stream must be read chunk-by-chunk in order; each chunk depends on the previous reader state
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data: ')) continue;
      try {
        const data = JSON.parse(trimmed.slice(6));
        const delta = data.choices?.[0]?.delta;
        if (delta?.content) {
          fullResponse += delta.content as string;
          if (onChunk) onChunk(delta.content);
        }
        if (data.usage) usage = data.usage;
      } catch {
        // Skip malformed SSE chunks
      }
    }
  }

  return { ok: true, fullResponse, output: fullResponse, usage, rateLimits: null };
}
