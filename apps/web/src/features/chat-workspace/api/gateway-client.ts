/**
 * Browser-side gateway conversation client.
 *
 * Typed HTTP methods for conversation lifecycle and turn submission.
 * Uses the gateway structured error parser from `shared/gateway-errors.ts`
 * and contract types from `@hydra/web-contracts`.
 *
 * All requests include `credentials: 'include'` for cookie-based auth
 * and JSON content-type headers.
 */

import type {
  CreateConversationRequest,
  CreateConversationResponse,
  ListConversationsRequest,
  ListConversationsResponse,
  OpenConversationResponse,
  LoadTurnHistoryResponse,
  SubmitInstructionBody,
  SubmitInstructionResponse,
} from '@hydra/web-contracts';

import {
  type GatewayErrorBody,
  type ErrorCategory,
  parseGatewayError,
} from '../../../shared/gateway-errors.ts';

// ─── Options & public interface ─────────────────────────────────────────────

export interface GatewayClientOptions {
  /** Gateway base URL (no trailing slash). */
  readonly baseUrl: string;
  /** Injectable fetch for testing. Defaults to globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** Injectable CSRF token lookup for mutating requests. */
  readonly getCsrfToken?: () => string | null | undefined;
}

/** History pagination parameters (all optional). */
export interface LoadHistoryParams {
  readonly fromPosition?: number;
  readonly toPosition?: number;
  readonly limit?: number;
}

export interface GatewayClient {
  listConversations(params?: Partial<ListConversationsRequest>): Promise<ListConversationsResponse>;
  openConversation(conversationId: string): Promise<OpenConversationResponse>;
  loadHistory(conversationId: string, params?: LoadHistoryParams): Promise<LoadTurnHistoryResponse>;
  createConversation(body?: CreateConversationRequest): Promise<CreateConversationResponse>;
  submitInstruction(
    conversationId: string,
    body: SubmitInstructionBody,
  ): Promise<SubmitInstructionResponse>;
}

// ─── Error class ────────────────────────────────────────────────────────────

/**
 * Thrown when the gateway returns a non-2xx response.
 * Carries the parsed structured error body (if parseable) or a synthetic one.
 */
export class GatewayRequestError extends Error {
  readonly status: number;
  readonly gatewayError: GatewayErrorBody;

  constructor(status: number, gatewayError: GatewayErrorBody) {
    super(`Gateway ${status}: ${gatewayError.message}`);
    this.name = 'GatewayRequestError';
    this.status = status;
    this.gatewayError = gatewayError;
  }
}

// ─── Internals ──────────────────────────────────────────────────────────────

const JSON_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

function readCsrfTokenFromDocument(): string | null {
  if (typeof document === 'undefined') {
    return null;
  }

  for (const entry of document.cookie.split(';')) {
    const trimmed = entry.trim();
    if (trimmed.startsWith('__csrf=')) {
      const rawValue = trimmed.slice('__csrf='.length);
      return rawValue === '' ? null : decodeURIComponent(rawValue);
    }
  }

  return null;
}

/** Map HTTP status ranges to a reasonable default error category. */
function categoryFromStatus(status: number): ErrorCategory {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  if (status >= 400 && status < 500) return 'validation';
  return 'daemon';
}

/**
 * Try to parse the response body as a structured gateway error.
 * Falls back to a synthetic body when JSON is missing or unparseable.
 */
async function extractGatewayError(res: Response): Promise<GatewayErrorBody> {
  try {
    const json: unknown = await res.json();
    const parsed = parseGatewayError(json);
    if (parsed) return parsed;
  } catch {
    // non-JSON body — fall through
  }

  return {
    ok: false,
    code: 'HTTP_ERROR',
    category: categoryFromStatus(res.status),
    message: res.statusText || `HTTP ${res.status}`,
    httpStatus: res.status,
  };
}

/** Append defined key-value pairs as query params. */
function appendParams(
  params: URLSearchParams,
  entries: ReadonlyArray<readonly [string, unknown]>,
): void {
  for (const [key, value] of entries) {
    if (value !== undefined && value !== null) {
      params.set(key, String(value));
    }
  }
}

function buildRequestUrl(
  baseUrl: string,
  path: string,
  entries: ReadonlyArray<readonly [string, unknown]>,
): string {
  const url = `${baseUrl}${path}`;
  const params = new URLSearchParams();
  appendParams(params, entries);
  const query = params.toString();
  return query === '' ? url : `${url}?${query}`;
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createGatewayClient(options: GatewayClientOptions): GatewayClient {
  const { baseUrl } = options;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const getCsrfToken = options.getCsrfToken ?? readCsrfTokenFromDocument;

  function buildHeaders(method: string): Headers {
    const headers = new Headers(JSON_HEADERS);

    if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
      const csrfToken = getCsrfToken();
      if (csrfToken != null && csrfToken !== '') {
        headers.set('x-csrf-token', csrfToken);
      }
    }

    return headers;
  }

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${baseUrl}${path}`;

    const init: RequestInit = {
      method,
      headers: buildHeaders(method),
      credentials: 'include',
    };

    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    const res = await fetchFn(url, init);

    if (!res.ok) {
      const gatewayError = await extractGatewayError(res);
      throw new GatewayRequestError(res.status, gatewayError);
    }

    return (await res.json()) as T;
  }

  async function get<T>(path: string): Promise<T> {
    return request<T>('GET', path);
  }

  async function post<T>(path: string, body: unknown): Promise<T> {
    return request<T>('POST', path, body);
  }

  return {
    async listConversations(params) {
      const url = buildRequestUrl(baseUrl, '/conversations', [
        ['status', params?.status],
        ['cursor', params?.cursor],
        ['limit', params?.limit],
      ]);
      const res = await fetchFn(url, {
        method: 'GET',
        headers: buildHeaders('GET'),
        credentials: 'include',
      });
      if (!res.ok) {
        throw new GatewayRequestError(res.status, await extractGatewayError(res));
      }
      return (await res.json()) as ListConversationsResponse;
    },

    async openConversation(conversationId) {
      return get<OpenConversationResponse>(`/conversations/${encodeURIComponent(conversationId)}`);
    },

    async loadHistory(conversationId, params) {
      const url = buildRequestUrl(
        baseUrl,
        `/conversations/${encodeURIComponent(conversationId)}/turns`,
        [
          ['fromPosition', params?.fromPosition],
          ['toPosition', params?.toPosition],
          ['limit', params?.limit],
        ],
      );
      const res = await fetchFn(url, {
        method: 'GET',
        headers: buildHeaders('GET'),
        credentials: 'include',
      });
      if (!res.ok) {
        throw new GatewayRequestError(res.status, await extractGatewayError(res));
      }
      return (await res.json()) as LoadTurnHistoryResponse;
    },

    async createConversation(body) {
      return post<CreateConversationResponse>('/conversations', body ?? {});
    },

    async submitInstruction(conversationId, body) {
      return post<SubmitInstructionResponse>(
        `/conversations/${encodeURIComponent(conversationId)}/turns`,
        body,
      );
    },
  };
}
