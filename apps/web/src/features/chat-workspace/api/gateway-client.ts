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
  GetPendingApprovalsResponse,
  RespondToApprovalResponse,
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

/** Body for respondToApproval — acknowledgeStaleness defaults to false server-side. */
export interface RespondToApprovalBody {
  readonly response: string;
  readonly acknowledgeStaleness?: boolean;
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
  getPendingApprovals(conversationId: string): Promise<GetPendingApprovalsResponse>;
  respondToApproval(
    approvalId: string,
    body: RespondToApprovalBody,
  ): Promise<RespondToApprovalResponse>;
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
    super(`Gateway ${String(status)}: ${gatewayError.message}`);
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
  const documentLike = Reflect.get(globalThis, 'document') as { cookie?: string } | undefined;
  const cookieSource = documentLike?.cookie;

  if (typeof cookieSource !== 'string' || cookieSource === '') {
    return null;
  }

  for (const entry of cookieSource.split(';')) {
    const trimmed = entry.trim();
    if (trimmed.startsWith('__csrf=')) {
      const rawValue = trimmed.slice('__csrf='.length);
      if (rawValue === '') {
        return null;
      }

      try {
        return decodeURIComponent(rawValue);
      } catch {
        return null;
      }
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
    message: res.statusText === '' ? `HTTP ${String(res.status)}` : res.statusText,
    httpStatus: res.status,
  };
}

type QueryParamValue = string | number | boolean | null | undefined;

/** Append defined key-value pairs as query params. */
function appendParams(
  params: URLSearchParams,
  entries: ReadonlyArray<readonly [string, QueryParamValue]>,
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
  entries: ReadonlyArray<readonly [string, QueryParamValue]>,
): string {
  const url = `${baseUrl}${path}`;
  const params = new URLSearchParams();
  appendParams(params, entries);
  const query = params.toString();
  return query === '' ? url : `${url}?${query}`;
}

function buildHeaders(method: string, getCsrfToken: () => string | null | undefined): Headers {
  const headers = new Headers(JSON_HEADERS);

  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
    const csrfToken = getCsrfToken();
    if (csrfToken != null && csrfToken !== '') {
      headers.set('x-csrf-token', csrfToken);
    }
  }

  return headers;
}

async function requestJson<T>(
  fetchFn: typeof globalThis.fetch,
  baseUrl: string,
  getCsrfToken: () => string | null | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const init: RequestInit = {
    method,
    headers: buildHeaders(method, getCsrfToken),
    credentials: 'include',
  };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const res = await fetchFn(`${baseUrl}${path}`, init);
  if (!res.ok) {
    throw new GatewayRequestError(res.status, await extractGatewayError(res));
  }

  return (await res.json()) as T;
}

async function getJson<T>(
  fetchFn: typeof globalThis.fetch,
  baseUrl: string,
  getCsrfToken: () => string | null | undefined,
  path: string,
): Promise<T> {
  return requestJson<T>(fetchFn, baseUrl, getCsrfToken, 'GET', path);
}

async function postJson<T>(
  fetchFn: typeof globalThis.fetch,
  baseUrl: string,
  getCsrfToken: () => string | null | undefined,
  path: string,
  body: unknown,
): Promise<T> {
  return requestJson<T>(fetchFn, baseUrl, getCsrfToken, 'POST', path, body);
}

async function fetchQueryJson<T>(
  fetchFn: typeof globalThis.fetch,
  getCsrfToken: () => string | null | undefined,
  method: string,
  url: string,
): Promise<T> {
  const res = await fetchFn(url, {
    method,
    headers: buildHeaders(method, getCsrfToken),
    credentials: 'include',
  });

  if (!res.ok) {
    throw new GatewayRequestError(res.status, await extractGatewayError(res));
  }

  return (await res.json()) as T;
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createGatewayClient(options: GatewayClientOptions): GatewayClient {
  const { baseUrl } = options;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const getCsrfToken = options.getCsrfToken ?? readCsrfTokenFromDocument;

  return {
    async listConversations(params) {
      const url = buildRequestUrl(baseUrl, '/conversations', [
        ['status', params?.status],
        ['cursor', params?.cursor],
        ['limit', params?.limit],
      ]);
      return fetchQueryJson<ListConversationsResponse>(fetchFn, getCsrfToken, 'GET', url);
    },

    async openConversation(conversationId) {
      return getJson<OpenConversationResponse>(
        fetchFn,
        baseUrl,
        getCsrfToken,
        `/conversations/${encodeURIComponent(conversationId)}`,
      );
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
      return fetchQueryJson<LoadTurnHistoryResponse>(fetchFn, getCsrfToken, 'GET', url);
    },

    async createConversation(body) {
      return postJson<CreateConversationResponse>(
        fetchFn,
        baseUrl,
        getCsrfToken,
        '/conversations',
        body ?? {},
      );
    },

    async submitInstruction(conversationId, body) {
      return postJson<SubmitInstructionResponse>(
        fetchFn,
        baseUrl,
        getCsrfToken,
        `/conversations/${encodeURIComponent(conversationId)}/turns`,
        body,
      );
    },

    async getPendingApprovals(conversationId) {
      return getJson<GetPendingApprovalsResponse>(
        fetchFn,
        baseUrl,
        getCsrfToken,
        `/conversations/${encodeURIComponent(conversationId)}/approvals`,
      );
    },

    async respondToApproval(approvalId, body) {
      return postJson<RespondToApprovalResponse>(
        fetchFn,
        baseUrl,
        getCsrfToken,
        `/approvals/${encodeURIComponent(approvalId)}/respond`,
        body,
      );
    },
  };
}
