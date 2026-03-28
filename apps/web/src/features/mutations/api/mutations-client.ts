/**
 * Browser-side gateway client for config mutations feature (T020).
 *
 * Follows the operations-client.ts pattern: typed fetch wrappers,
 * CSRF token injection for mutating POST requests, zero `any` escapes.
 */
import type {
  GetSafeConfigResponse as GetSafeConfigResponseType,
  PatchRoutingModeRequest,
  PatchRoutingModeResponse as PatchRoutingModeResponseType,
  PatchModelTierRequest,
  PatchModelTierResponse as PatchModelTierResponseType,
  PatchBudgetRequest,
  PatchBudgetResponse as PatchBudgetResponseType,
  PostWorkflowLaunchRequest,
  PostWorkflowLaunchResponse as PostWorkflowLaunchResponseType,
  GetAuditRequest,
  GetAuditResponse as GetAuditResponseType,
} from '@hydra/web-contracts';
import { type GatewayErrorBody, parseGatewayError } from '../../../shared/gateway-errors.ts';

export interface MutationsClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly getCsrfToken?: () => string | null | undefined;
}

export class MutationsRequestError extends Error {
  readonly status: number;
  readonly gatewayError: GatewayErrorBody;

  constructor(status: number, gatewayError: GatewayErrorBody) {
    super(`Gateway ${String(status)}: ${gatewayError.message}`);
    this.name = 'MutationsRequestError';
    this.status = status;
    this.gatewayError = gatewayError;
  }
}

export interface MutationsClient {
  getSafeConfig(): Promise<GetSafeConfigResponseType>;
  postRoutingMode(body: PatchRoutingModeRequest): Promise<PatchRoutingModeResponseType>;
  postModelTier(
    agent: string,
    body: Omit<PatchModelTierRequest, 'agent'>,
  ): Promise<PatchModelTierResponseType>;
  postBudget(body: PatchBudgetRequest): Promise<PatchBudgetResponseType>;
  postWorkflowLaunch(body: PostWorkflowLaunchRequest): Promise<PostWorkflowLaunchResponseType>;
  getAudit(params?: GetAuditRequest): Promise<GetAuditResponseType>;
}

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
      if (rawValue === '') return null;
      try {
        return decodeURIComponent(rawValue);
      } catch {
        return null;
      }
    }
  }

  return null;
}

async function extractGatewayError(response: Response): Promise<GatewayErrorBody> {
  try {
    const parsed = parseGatewayError((await response.json()) as unknown);
    if (parsed) return parsed;
  } catch {
    // fall through to synthetic error
  }
  return {
    ok: false,
    code: 'HTTP_ERROR',
    category: response.status >= 500 ? 'daemon' : 'validation',
    message: response.statusText === '' ? `HTTP ${String(response.status)}` : response.statusText,
    httpStatus: response.status,
  };
}

interface RequestHelperDeps {
  readonly baseUrl: string;
  readonly fetchFn: typeof globalThis.fetch;
  readonly getCsrfToken: () => string | null | undefined;
}

function createRequestHelper(deps: RequestHelperDeps) {
  const { baseUrl, fetchFn, getCsrfToken } = deps;

  return async function request<T>(
    path: string,
    init: RequestInit = {},
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    let url = `${baseUrl}${path}`;
    if (query != null) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value != null) params.set(key, String(value));
      }
      const qs = params.toString();
      if (qs !== '') url = `${url}?${qs}`;
    }

    const headers = new Headers(init.headers ?? {});
    headers.set('Accept', 'application/json');
    if (init.body != null) {
      headers.set('Content-Type', 'application/json');
      const csrfToken = getCsrfToken();
      if (csrfToken != null && csrfToken !== '') headers.set('x-csrf-token', csrfToken);
    }

    const response = await fetchFn(url, { ...init, credentials: 'include', headers });

    if (!response.ok) {
      throw new MutationsRequestError(response.status, await extractGatewayError(response));
    }

    return (await response.json()) as T;
  };
}

export function createMutationsClient(options: MutationsClientOptions): MutationsClient {
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const fetchFn = options.fetch ?? globalThis.fetch;
  const getCsrfToken = options.getCsrfToken ?? readCsrfTokenFromDocument;
  const request = createRequestHelper({ baseUrl, fetchFn, getCsrfToken });

  return {
    getSafeConfig() {
      return request<GetSafeConfigResponseType>('/config/safe', { method: 'GET' });
    },

    postRoutingMode(body) {
      return request<PatchRoutingModeResponseType>('/config/routing/mode', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    postModelTier(agent, body) {
      return request<PatchModelTierResponseType>(
        `/config/models/${encodeURIComponent(agent)}/active`,
        { method: 'POST', body: JSON.stringify(body) },
      );
    },

    postBudget(body) {
      return request<PatchBudgetResponseType>('/config/usage/budget', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    postWorkflowLaunch(body) {
      return request<PostWorkflowLaunchResponseType>('/workflows/launch', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    getAudit(params) {
      return request<GetAuditResponseType>(
        '/audit',
        { method: 'GET' },
        {
          limit: params?.limit,
          cursor: params?.cursor,
        },
      );
    },
  };
}
