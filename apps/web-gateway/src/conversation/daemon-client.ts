/**
 * Typed HTTP client for daemon conversation endpoints (FR-018, FR-019).
 *
 * Wraps fetch() for all 19 daemon conversation routes plus the per-turn
 * stream replay route. Returns parsed data on success or a translated
 * GatewayErrorResponse on failure. Configurable timeout (default 5s).
 *
 * This is the sole point of daemon communication for conversation operations.
 */
import type { GatewayErrorResponse } from '../shared/gateway-error-response.ts';
import { translateDaemonResponse, translateFetchFailure } from './response-translator.ts';
import type {
  CreateConversationResponse,
  ListConversationsResponse,
  OpenConversationResponse,
  ResumeConversationResponse,
  ArchiveConversationResponse,
  SubmitInstructionResponse,
  LoadTurnHistoryResponse,
  GetPendingApprovalsResponse,
  RespondToApprovalResponse,
  CancelWorkResponse,
  RetryTurnResponse,
  ForkConversationResponse,
  ManageQueueResponse,
  ListArtifactsForTurnResponse,
  ListArtifactsForConversationResponse,
  GetArtifactContentResponse,
  GetActivityEntriesResponse,
  FilterActivityByAgentResponse,
  SubscribeToStreamResponse,
} from '@hydra/web-contracts';

/** Result type: either data or a translated gateway error. */
export type DaemonResult<T> = { data: T } | { error: GatewayErrorResponse };

export interface DaemonClientOptions {
  /** Base URL of the daemon (e.g. http://localhost:4173). */
  readonly baseUrl: string;
  /** Optional fetch implementation for testing. Defaults to globalThis.fetch. */
  readonly fetchFn?: typeof globalThis.fetch;
  /** Request timeout in milliseconds. Default: 5000. */
  readonly timeoutMs?: number;
}

export class DaemonClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(opts: DaemonClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async createConversation(body: {
    title?: string;
    parentConversationId?: string;
    forkPointTurnId?: string;
  }): Promise<DaemonResult<CreateConversationResponse>> {
    return this.post('/conversations', body);
  }

  async listConversations(query: {
    status?: string;
    cursor?: string;
    limit?: number;
  }): Promise<DaemonResult<ListConversationsResponse>> {
    return this.get('/conversations', query);
  }

  async openConversation(conversationId: string): Promise<DaemonResult<OpenConversationResponse>> {
    return this.get(`/conversations/${encodeURIComponent(conversationId)}`);
  }

  async resumeConversation(
    conversationId: string,
    body: { conversationId: string; lastAcknowledgedSeq: number },
  ): Promise<DaemonResult<ResumeConversationResponse>> {
    return this.post(`/conversations/${encodeURIComponent(conversationId)}/resume`, body);
  }

  async archiveConversation(
    conversationId: string,
  ): Promise<DaemonResult<ArchiveConversationResponse>> {
    return this.post(`/conversations/${encodeURIComponent(conversationId)}/archive`, {});
  }

  // ─── Turns ────────────────────────────────────────────────────────────────

  async submitInstruction(
    conversationId: string,
    body: { conversationId: string; instruction: string; metadata?: Record<string, unknown> },
    opts?: { sessionId: string },
  ): Promise<DaemonResult<SubmitInstructionResponse>> {
    const extraHeaders: Record<string, string> = {};
    if (opts && opts.sessionId !== '') {
      extraHeaders['X-Session-Id'] = opts.sessionId;
    }
    return this.post(
      `/conversations/${encodeURIComponent(conversationId)}/turns`,
      body,
      extraHeaders,
    );
  }

  async loadTurnHistory(
    conversationId: string,
    query: {
      conversationId: string;
      fromPosition?: number;
      toPosition?: number;
      limit?: number;
    },
  ): Promise<DaemonResult<LoadTurnHistoryResponse>> {
    const { conversationId: _id, ...rest } = query;
    return this.get(`/conversations/${encodeURIComponent(conversationId)}/turns`, rest);
  }

  // ─── Approvals ────────────────────────────────────────────────────────────

  async getPendingApprovals(
    conversationId: string,
  ): Promise<DaemonResult<GetPendingApprovalsResponse>> {
    return this.get(`/conversations/${encodeURIComponent(conversationId)}/approvals`);
  }

  async respondToApproval(
    approvalId: string,
    body: { response: string; acknowledgeStaleness?: boolean; sessionId: string },
  ): Promise<DaemonResult<RespondToApprovalResponse>> {
    const { sessionId, ...jsonBody } = body;
    return this.post(`/approvals/${encodeURIComponent(approvalId)}/respond`, jsonBody, {
      'X-Session-Id': sessionId,
    });
  }

  // ─── Work Control ─────────────────────────────────────────────────────────

  async cancelWork(
    conversationId: string,
    turnId: string,
  ): Promise<DaemonResult<CancelWorkResponse>> {
    return this.post(
      `/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/cancel`,
      {},
    );
  }

  async retryTurn(
    conversationId: string,
    turnId: string,
  ): Promise<DaemonResult<RetryTurnResponse>> {
    return this.post(
      `/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/retry`,
      {},
    );
  }

  async forkConversation(
    conversationId: string,
    body: { conversationId: string; forkPointTurnId: string; title?: string },
  ): Promise<DaemonResult<ForkConversationResponse>> {
    return this.post(`/conversations/${encodeURIComponent(conversationId)}/fork`, body);
  }

  async manageQueue(
    conversationId: string,
    body: {
      conversationId: string;
      action: 'list' | 'reorder' | 'remove';
      instructionId?: string;
      newPosition?: number;
    },
  ): Promise<DaemonResult<ManageQueueResponse>> {
    return this.post(`/conversations/${encodeURIComponent(conversationId)}/queue`, body);
  }

  // ─── Artifacts ────────────────────────────────────────────────────────────

  async listArtifactsForTurn(turnId: string): Promise<DaemonResult<ListArtifactsForTurnResponse>> {
    return this.get(`/turns/${encodeURIComponent(turnId)}/artifacts`);
  }

  async listArtifactsForConversation(
    conversationId: string,
    query: { conversationId: string; kind?: string; cursor?: string; limit?: number },
  ): Promise<DaemonResult<ListArtifactsForConversationResponse>> {
    const { conversationId: _id, ...rest } = query;
    return this.get(`/conversations/${encodeURIComponent(conversationId)}/artifacts`, rest);
  }

  async getArtifactContent(artifactId: string): Promise<DaemonResult<GetArtifactContentResponse>> {
    return this.get(`/artifacts/${encodeURIComponent(artifactId)}`);
  }

  // ─── Activities ───────────────────────────────────────────────────────────

  async getActivityEntries(turnId: string): Promise<DaemonResult<GetActivityEntriesResponse>> {
    return this.get(`/turns/${encodeURIComponent(turnId)}/activities`);
  }

  async filterActivityByAgent(
    turnId: string,
    agentId: string,
  ): Promise<DaemonResult<FilterActivityByAgentResponse>> {
    return this.get(`/turns/${encodeURIComponent(turnId)}/activities`, { agentId });
  }

  // ─── Stream Replay (critical for reconnect — consumed by T032) ────────────

  async getStreamReplay(
    conversationId: string,
    turnId: string,
    lastAcknowledgedSeq: number,
  ): Promise<DaemonResult<SubscribeToStreamResponse>> {
    const path =
      `/conversations/${encodeURIComponent(conversationId)}` +
      `/turns/${encodeURIComponent(turnId)}/stream`;
    return this.get(path, { lastAcknowledgedSeq });
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  private async get<T>(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<DaemonResult<T>> {
    const url = this.buildUrl(path, query);
    return this.execute(url, { method: 'GET' });
  }

  private async post<T>(
    path: string,
    body: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<DaemonResult<T>> {
    const url = this.buildUrl(path);
    return this.execute(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
    });
  }

  private buildUrl(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): string {
    const url = `${this.baseUrl}${path}`;
    if (!query) return url;

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        params.set(key, String(value));
      }
    }
    const qs = params.toString();
    return qs.length > 0 ? `${url}?${qs}` : url;
  }

  private async execute<T>(url: string, init: RequestInit): Promise<DaemonResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.fetchFn(url, {
        ...init,
        signal: controller.signal,
      });

      if (response.ok) {
        const data = (await response.json()) as T;
        return { data };
      }

      // Non-2xx: parse error body and translate
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // Body not valid JSON — will be handled by translateDaemonResponse
      }

      return { error: translateDaemonResponse(response.status, body) };
    } catch (err: unknown) {
      return { error: translateFetchFailure(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}
