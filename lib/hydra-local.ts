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

interface SSEChunkDelta {
  content?: string;
}

interface SSEChunkChoice {
  delta?: SSEChunkDelta;
}

interface SSEChunkData {
  choices?: SSEChunkChoice[];
  usage?: Record<string, number>;
}

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

function makeUnavailableResult(): LocalCompletionResult {
  return {
    ok: false,
    errorCategory: 'local-unavailable',
    output: '',
    fullResponse: '',
    usage: null,
    rateLimits: null,
  };
}

function isUnreachableError(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException };
  const errCode = e.cause?.code ?? e.code ?? '';
  return UNREACHABLE_CODES.has(errCode);
}

function parseSSELine(
  line: string,
  state: { fullResponse: string; usage: Record<string, number> | null },
  onChunk?: (chunk: string) => void,
): void {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed === 'data: [DONE]' || !trimmed.startsWith('data: ')) return;
  try {
    const data = JSON.parse(trimmed.slice(6)) as SSEChunkData;
    const content = data.choices?.[0]?.delta?.content;
    if (typeof content === 'string' && content !== '') {
      state.fullResponse += content;
      if (onChunk) onChunk(content);
    }
    if (data.usage != null) state.usage = data.usage;
  } catch {
    // Skip malformed SSE chunks
  }
}

async function readSSEStream(
  body: ReadableStream<Uint8Array>,
  onChunk?: (chunk: string) => void,
): Promise<LocalCompletionResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const state = { fullResponse: '', usage: null as Record<string, number> | null };

  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- intentionally sequential: SSE stream must be read chunk-by-chunk in order; each chunk depends on the previous reader state
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      parseSSELine(line, state, onChunk);
    }
  }

  return {
    ok: true,
    fullResponse: state.fullResponse,
    output: state.fullResponse,
    usage: state.usage,
    rateLimits: null,
  };
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
  if (maxTokens != null && maxTokens !== 0) body['max_tokens'] = maxTokens;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal == null ? {} : { signal }),
    });
  } catch (err: unknown) {
    if (isUnreachableError(err)) return makeUnavailableResult();
    throw err;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err = new Error(`Local API error ${String(res.status)}: ${errText.slice(0, 200)}`);
    (err as NodeJS.ErrnoException & { status?: number }).status = res.status;
    throw err;
  }

  if (res.body == null) {
    throw new Error('Local API response has no body');
  }

  return readSSEStream(res.body, onChunk);
}
