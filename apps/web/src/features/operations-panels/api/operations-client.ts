/**
 * Browser-side gateway client for the operations panels feature.
 *
 * This client defines the typed browser-facing REST surface for snapshot,
 * detail, and control interactions. Phase 0 establishes the adapter scaffold;
 * later phases wire it into reducers, selectors, and UI composition.
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
import { type GatewayErrorBody, parseGatewayError } from '../../../shared/gateway-errors.ts';

export interface OperationsClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly getCsrfToken?: () => string | null | undefined;
}

export class OperationsRequestError extends Error {
  readonly status: number;
  readonly gatewayError: GatewayErrorBody;

  constructor(status: number, gatewayError: GatewayErrorBody) {
    super(`Gateway ${String(status)}: ${gatewayError.message}`);
    this.name = 'OperationsRequestError';
    this.status = status;
    this.gatewayError = gatewayError;
  }
}

export interface OperationsClient {
  getSnapshot(
    query?: Partial<GetOperationsSnapshotRequest>,
  ): Promise<GetOperationsSnapshotResponse>;
  getWorkItemDetail(workItemId: string): Promise<GetWorkItemDetailResponse>;
  getWorkItemCheckpoints(workItemId: string): Promise<GetWorkItemCheckpointsResponse>;
  getWorkItemExecution(workItemId: string): Promise<GetWorkItemExecutionResponse>;
  getWorkItemControls(workItemId: string): Promise<GetWorkItemControlsResponse>;
  submitControlAction(
    workItemId: string,
    controlId: string,
    body: SubmitControlActionBody,
  ): Promise<SubmitControlActionResponse>;
  discoverControls(body: BatchControlDiscoveryRequest): Promise<BatchControlDiscoveryResponse>;
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

async function extractGatewayError(response: Response): Promise<GatewayErrorBody> {
  try {
    const parsed = parseGatewayError((await response.json()) as unknown);
    if (parsed) return parsed;
  } catch {
    // fall through to synthetic error body
  }

  return {
    ok: false,
    code: 'HTTP_ERROR',
    category: response.status >= 500 ? 'daemon' : 'validation',
    message: response.statusText === '' ? `HTTP ${String(response.status)}` : response.statusText,
    httpStatus: response.status,
  };
}

export function createOperationsClient(options: OperationsClientOptions): OperationsClient {
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const fetchFn = options.fetch ?? globalThis.fetch;
  const getCsrfToken = options.getCsrfToken ?? (() => null);

  async function request<T>(
    path: string,
    init: RequestInit = {},
    query?: Record<string, QueryValue>,
  ): Promise<T> {
    const url = new URL(`${baseUrl}${path}`);
    if (query != null) {
      for (const [key, value] of Object.entries(query)) appendQuery(url.searchParams, key, value);
    }

    const headers = new Headers(init.headers ?? {});
    headers.set('Accept', 'application/json');
    if (init.body != null) {
      headers.set('Content-Type', 'application/json');
      const csrfToken = getCsrfToken();
      if (csrfToken != null && csrfToken !== '') headers.set('x-csrf-token', csrfToken);
    }

    const response = await fetchFn(url.toString(), {
      ...init,
      credentials: 'include',
      headers,
    });

    if (!response.ok) {
      throw new OperationsRequestError(response.status, await extractGatewayError(response));
    }

    return (await response.json()) as T;
  }

  return {
    getSnapshot(query = {}) {
      return request<GetOperationsSnapshotResponse>(
        '/operations/snapshot',
        { method: 'GET' },
        query,
      );
    },
    getWorkItemDetail(workItemId) {
      return request<GetWorkItemDetailResponse>(
        `/operations/work-items/${encodeURIComponent(workItemId)}`,
        { method: 'GET' },
      );
    },
    getWorkItemCheckpoints(workItemId) {
      return request<GetWorkItemCheckpointsResponse>(
        `/operations/work-items/${encodeURIComponent(workItemId)}/checkpoints`,
        { method: 'GET' },
      );
    },
    getWorkItemExecution(workItemId) {
      return request<GetWorkItemExecutionResponse>(
        `/operations/work-items/${encodeURIComponent(workItemId)}/execution`,
        { method: 'GET' },
      );
    },
    getWorkItemControls(workItemId) {
      return request<GetWorkItemControlsResponse>(
        `/operations/work-items/${encodeURIComponent(workItemId)}/controls`,
        { method: 'GET' },
      );
    },
    submitControlAction(workItemId, controlId, body) {
      return request<SubmitControlActionResponse>(
        `/operations/work-items/${encodeURIComponent(workItemId)}/controls/${encodeURIComponent(controlId)}`,
        { method: 'POST', body: JSON.stringify(body) },
      );
    },
    discoverControls(body) {
      return request<BatchControlDiscoveryResponse>('/operations/controls/discover', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
  };
}
