/**
 * Typed daemon client for config mutation endpoints.
 *
 * Follows the DaemonOperationsClient pattern — sole gateway-side adapter for
 * daemon config read/write endpoints. Error mapping distinguishes stale-revision,
 * workflow-conflict, and daemon-unavailable from generic validation errors.
 */
import type {
  GetSafeConfigResponse,
  PatchRoutingModeRequest,
  PatchRoutingModeResponse,
  PatchModelTierRequest,
  PatchModelTierResponse,
  PatchBudgetRequest,
  PatchBudgetResponse,
  PostWorkflowLaunchRequest,
  PostWorkflowLaunchResponse,
  GetAuditRequest,
  GetAuditResponse,
} from '@hydra/web-contracts';
import type { ErrorCategory, GatewayErrorResponse } from '../shared/gateway-error-response.ts';
import { createGatewayErrorResponse } from '../shared/gateway-error-response.ts';

export type DaemonMutationsResult<T> = { data: T } | { error: GatewayErrorResponse };

export interface DaemonMutationsClientOptions {
  readonly baseUrl: string;
  readonly fetchFn?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

function categoryFromStatus(status: number, payload: unknown): ErrorCategory {
  if (status === 503) return 'daemon-unavailable';
  if (status === 409) {
    if (payload !== null && typeof payload === 'object') {
      const body = payload as Record<string, unknown>;
      if (body['error'] === 'stale-revision') return 'stale-revision';
      if (body['error'] === 'workflow-conflict') return 'workflow-conflict';
    }
    return 'stale-revision';
  }
  if (status === 400) return 'validation';
  return 'daemon';
}

function codeFromCategory(category: ErrorCategory): string {
  if (category === 'stale-revision') return 'STALE_REVISION';
  if (category === 'daemon-unavailable') return 'DAEMON_UNAVAILABLE';
  if (category === 'workflow-conflict') return 'WORKFLOW_CONFLICT';
  if (category === 'validation') return 'VALIDATION_FAILED';
  return 'DAEMON_ERROR';
}

function translateMutationsDaemonResponse(status: number, payload: unknown): GatewayErrorResponse {
  const category = categoryFromStatus(status, payload);
  const message =
    payload !== null && typeof payload === 'object' && 'message' in payload
      ? String((payload as Record<string, unknown>)['message'])
      : `Daemon returned HTTP ${String(status)}`;

  return createGatewayErrorResponse({
    code: codeFromCategory(category),
    category,
    message,
    httpStatus: status,
  });
}

function translateMutationsFetchFailure(): GatewayErrorResponse {
  return createGatewayErrorResponse({
    code: 'DAEMON_UNAVAILABLE',
    category: 'daemon-unavailable',
    message: 'Daemon unreachable',
  });
}

export class DaemonMutationsClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: DaemonMutationsClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  getSafeConfig(): Promise<DaemonMutationsResult<GetSafeConfigResponse>> {
    return this.get('/config/safe');
  }

  postRoutingMode(
    body: PatchRoutingModeRequest,
  ): Promise<DaemonMutationsResult<PatchRoutingModeResponse>> {
    return this.post('/config/routing/mode', body);
  }

  postModelTier(
    agent: string,
    body: Omit<PatchModelTierRequest, 'agent'>,
  ): Promise<DaemonMutationsResult<PatchModelTierResponse>> {
    return this.post(`/config/models/${encodeURIComponent(agent)}/active`, body);
  }

  postBudget(body: PatchBudgetRequest): Promise<DaemonMutationsResult<PatchBudgetResponse>> {
    return this.post('/config/usage/budget', body);
  }

  postWorkflowLaunch(
    body: PostWorkflowLaunchRequest,
  ): Promise<DaemonMutationsResult<PostWorkflowLaunchResponse>> {
    return this.post('/workflows/launch', body);
  }

  getAudit(params?: GetAuditRequest): Promise<DaemonMutationsResult<GetAuditResponse>> {
    const query: Record<string, string | undefined> = {};
    if (params?.limit != null) query['limit'] = String(params.limit);
    if (params?.cursor != null) query['cursor'] = params.cursor;
    return this.get('/audit', query);
  }

  private async get<T>(
    path: string,
    query: Record<string, string | undefined> = {},
  ): Promise<DaemonMutationsResult<T>> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value != null) url.searchParams.set(key, value);
    }
    return this.request<T>(url.toString(), { method: 'GET' });
  }

  private post<T>(path: string, body: unknown): Promise<DaemonMutationsResult<T>> {
    return this.request<T>(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  private async request<T>(url: string, init: RequestInit): Promise<DaemonMutationsResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.fetchFn(url, { ...init, signal: controller.signal });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        return { error: translateMutationsDaemonResponse(response.status, payload) };
      }
      return { data: payload as T };
    } catch {
      return { error: translateMutationsFetchFailure() };
    } finally {
      clearTimeout(timer);
    }
  }
}
