/**
 * Typed daemon client for operations-panel snapshot/detail/control routes.
 *
 * This module is the sole gateway-side adapter for daemon operations endpoints.
 * Later phases add concrete route usage on top of these typed helpers.
 */
import type {
  BatchControlDiscoveryRequest,
  BatchControlDiscoveryResponse,
  GetOperationsSnapshotRequest,
  GetOperationsSnapshotResponse,
  GetWorkItemControlsResponse,
  GetWorkItemDetailResponse,
  GetWorkItemExecutionResponse,
  GetWorkItemCheckpointsResponse,
  SubmitControlActionBody,
  SubmitControlActionResponse,
} from '@hydra/web-contracts';
import type { GatewayErrorResponse } from '../shared/gateway-error-response.ts';
import {
  translateDaemonResponse,
  translateFetchFailure,
} from '../conversation/response-translator.ts';

export type DaemonOperationsResult<T> = { data: T } | { error: GatewayErrorResponse };

export interface DaemonOperationsClientOptions {
  readonly baseUrl: string;
  readonly fetchFn?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

type QueryValue = string | number | boolean | null | undefined | readonly string[];

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
  ): Promise<DaemonOperationsResult<GetWorkItemControlsResponse>> {
    return this.get(`/operations/work-items/${encodeURIComponent(workItemId)}/controls`);
  }

  submitControlAction(
    workItemId: string,
    controlId: string,
    body: SubmitControlActionBody,
  ): Promise<DaemonOperationsResult<SubmitControlActionResponse>> {
    return this.post(
      `/operations/work-items/${encodeURIComponent(workItemId)}/controls/${encodeURIComponent(controlId)}`,
      body,
    );
  }

  discoverControls(
    body: BatchControlDiscoveryRequest,
  ): Promise<DaemonOperationsResult<BatchControlDiscoveryResponse>> {
    return this.post('/operations/controls/discover', body);
  }

  private async get<T>(
    path: string,
    query: Record<string, QueryValue> = {},
  ): Promise<DaemonOperationsResult<T>> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      appendQuery(url.searchParams, key, value);
    }
    return this.request<T>(url.toString(), { method: 'GET' });
  }

  private post<T>(path: string, body: unknown): Promise<DaemonOperationsResult<T>> {
    return this.request<T>(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  private async request<T>(url: string, init: RequestInit): Promise<DaemonOperationsResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.fetchFn(url, { ...init, signal: controller.signal });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        return { error: translateDaemonResponse(response.status, payload) };
      }
      return { data: payload as T };
    } catch (err) {
      return { error: translateFetchFailure(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}
