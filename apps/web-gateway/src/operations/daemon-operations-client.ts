/**
 * Typed daemon client for operations-panel snapshot/detail/control routes.
 *
 * This module is the sole gateway-side adapter for daemon operations endpoints.
 * Later phases add concrete route usage on top of these typed helpers.
 */
import type {
  BatchControlDiscoveryRequest,
  BatchControlDiscoveryResponse as BatchControlDiscoveryResponseType,
  GetOperationsSnapshotRequest,
  GetOperationsSnapshotResponse,
  GetWorkItemControlsResponse as GetWorkItemControlsResponseType,
  GetWorkItemDetailResponse,
  GetWorkItemExecutionResponse,
  GetWorkItemCheckpointsResponse,
  SubmitControlActionBody,
  SubmitControlActionResponse as SubmitControlActionResponseType,
} from '@hydra/web-contracts';
import {
  BatchControlDiscoveryResponse,
  GetWorkItemControlsResponse,
  SubmitControlActionResponse,
} from '@hydra/web-contracts';
import type { GatewayErrorResponse } from '../shared/gateway-error-response.ts';
import { createGatewayErrorResponse } from '../shared/gateway-error-response.ts';
import {
  translateOperationsDaemonResponse,
  translateOperationsFetchFailure,
} from './response-translator.ts';

export type DaemonOperationsResult<T> = { data: T } | { error: GatewayErrorResponse };

export interface DaemonOperationsClientOptions {
  readonly baseUrl: string;
  readonly fetchFn?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

type QueryValue = string | number | boolean | null | undefined | readonly string[];

function extractStructuredStaleOutcome(payload: unknown): SubmitControlActionResponse | null {
  if (payload === null || typeof payload !== 'object') return null;

  const body = payload as Record<string, unknown>;
  if (body['outcome'] !== 'stale') return null;
  if (typeof body['workItemId'] !== 'string' || typeof body['resolvedAt'] !== 'string') return null;
  if (body['control'] === null || typeof body['control'] !== 'object') return null;

  return payload as SubmitControlActionResponse;
}

interface SafeParseSchema<T> {
  safeParse(
    data: unknown,
  ): { success: true; data: T } | { success: false; error: { message: string } };
}

function parseDaemonPayload<T>(
  payload: unknown,
  schema: SafeParseSchema<T>,
  label: string,
): DaemonOperationsResult<T> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return {
      error: createGatewayErrorResponse({
        code: 'DAEMON_INVALID_RESPONSE',
        category: 'daemon',
        message: `Invalid daemon ${label} response: ${parsed.error.message}`,
        httpStatus: 502,
      }),
    };
  }

  return { data: parsed.data };
}

function appendQuery(search: URLSearchParams, key: string, value: QueryValue): void {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        search.append(key, item);
      }
    }
    return;
  }
  search.set(key, String(value));
}

export class DaemonOperationsClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: DaemonOperationsClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  getOperationsSnapshot(
    query: Partial<GetOperationsSnapshotRequest> = {},
  ): Promise<DaemonOperationsResult<GetOperationsSnapshotResponse>> {
    return this.get('/operations/snapshot', query);
  }

  getWorkItemDetail(
    workItemId: string,
  ): Promise<DaemonOperationsResult<GetWorkItemDetailResponse>> {
    return this.get(`/operations/work-items/${encodeURIComponent(workItemId)}`);
  }

  getWorkItemCheckpoints(
    workItemId: string,
  ): Promise<DaemonOperationsResult<GetWorkItemCheckpointsResponse>> {
    return this.get(`/operations/work-items/${encodeURIComponent(workItemId)}/checkpoints`);
  }

  getWorkItemExecution(
    workItemId: string,
  ): Promise<DaemonOperationsResult<GetWorkItemExecutionResponse>> {
    return this.get(`/operations/work-items/${encodeURIComponent(workItemId)}/execution`);
  }

  getWorkItemControls(
    workItemId: string,
  ): Promise<DaemonOperationsResult<GetWorkItemControlsResponseType>> {
    return this.get(
      `/operations/work-items/${encodeURIComponent(workItemId)}/controls`,
      undefined,
      (payload) => parseDaemonPayload(payload, GetWorkItemControlsResponse, 'work item controls'),
    );
  }

  submitControlAction(
    workItemId: string,
    controlId: string,
    body: SubmitControlActionBody,
  ): Promise<DaemonOperationsResult<SubmitControlActionResponseType>> {
    return this.post(
      `/operations/work-items/${encodeURIComponent(workItemId)}/controls/${encodeURIComponent(controlId)}`,
      body,
      (payload) => parseDaemonPayload(payload, SubmitControlActionResponse, 'control submit'),
    );
  }

  discoverControls(
    body: BatchControlDiscoveryRequest,
  ): Promise<DaemonOperationsResult<BatchControlDiscoveryResponseType>> {
    return this.post('/operations/controls/discover', body, (payload) =>
      parseDaemonPayload(payload, BatchControlDiscoveryResponse, 'control discovery'),
    );
  }

  private async get<T>(
    path: string,
    query: Record<string, QueryValue> = {},
    parse?: (payload: unknown) => DaemonOperationsResult<T>,
  ): Promise<DaemonOperationsResult<T>> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      appendQuery(url.searchParams, key, value);
    }
    return this.request<T>(url.toString(), { method: 'GET' }, parse);
  }

  private post<T>(
    path: string,
    body: unknown,
    parse?: (payload: unknown) => DaemonOperationsResult<T>,
  ): Promise<DaemonOperationsResult<T>> {
    return this.request<T>(
      `${this.baseUrl}${path}`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      parse,
    );
  }

  private async request<T>(
    url: string,
    init: RequestInit,
    parse?: (payload: unknown) => DaemonOperationsResult<T>,
  ): Promise<DaemonOperationsResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.fetchFn(url, { ...init, signal: controller.signal });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 409 && parse != null) {
          const staleOutcome = extractStructuredStaleOutcome(payload);
          if (staleOutcome !== null) {
            return parse(staleOutcome);
          }
        }
        return { error: translateOperationsDaemonResponse(response.status, payload) };
      }
      if (parse != null) {
        return parse(payload);
      }
      return { data: payload as T };
    } catch (err) {
      return { error: translateOperationsFetchFailure(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}
