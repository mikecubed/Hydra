/**
 * Conversation protocol route handlers for the daemon HTTP server.
 *
 * Implements all 6 owned contract families as daemon routes:
 * 1. Conversation Lifecycle — CRUD + archive + list
 * 2. Turn Submission — submit instruction, subscribe to stream, load history
 * 3. Approval Flow — get pending, respond
 * 4. Work Control — cancel, retry, fork, queue
 * 5. Artifacts — list per turn, get content, list per conversation
 * 6. Multi-Agent Activity — get entries, filter by agent
 *
 * Routes consume ConversationStore and StreamManager instances.
 * Transport-agnostic: request/response shapes match contract schemas.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConversationStore } from './conversation-store.ts';
import type { StreamManager } from './stream-manager.ts';
import { sendJson, sendError, readJsonBody } from './http-utils.ts';

// ── Route registration ───────────────────────────────────────────────────────

export interface ConversationRouteDeps {
  store: ConversationStore;
  streamManager: StreamManager;
  /**
   * Optional callback invoked after a turn is marked executing and a stream is
   * allocated.  The callback is responsible for driving stream events
   * (text-delta, approval-prompt, etc.) and ultimately calling
   * `streamManager.completeStream` / `failStream`.
   *
   * When absent the route still creates the turn + stream but nothing drives
   * execution — useful for tests that manually control the stream.
   */
  executeTurn?: (turnId: string, instruction: string) => void;
}

// ── Sub-routers (split to keep main function below complexity threshold) ────

function routeLifecycle(
  method: string,
  path: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConversationRouteDeps,
): boolean {
  if (method === 'POST' && path === '/conversations') {
    handleCreateConversation(req, res, deps).catch((err: unknown) => {
      sendError(res, 500, (err as Error).message);
    });
    return true;
  }
  if (method === 'GET' && path === '/conversations') {
    handleListConversations(url, res, deps);
    return true;
  }
  const convMatch = path.match(/^\/conversations\/([^/]+)$/);
  if (convMatch !== null && method === 'GET') {
    handleGetConversation(convMatch[1], res, deps);
    return true;
  }
  const archiveMatch = path.match(/^\/conversations\/([^/]+)\/archive$/);
  if (archiveMatch !== null && method === 'POST') {
    handleArchiveConversation(archiveMatch[1], res, deps);
    return true;
  }
  const resumeMatch = path.match(/^\/conversations\/([^/]+)\/resume$/);
  if (resumeMatch !== null && method === 'POST') {
    handleResumeConversation(resumeMatch[1], req, res, deps).catch((err: unknown) => {
      sendError(res, 500, (err as Error).message);
    });
    return true;
  }
  return false;
}

function routeTurns(
  method: string,
  path: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConversationRouteDeps,
): boolean {
  const turnsMatch = path.match(/^\/conversations\/([^/]+)\/turns$/);
  if (turnsMatch !== null && method === 'POST') {
    handleSubmitInstruction(turnsMatch[1], req, res, deps).catch((err: unknown) => {
      sendError(res, 500, (err as Error).message);
    });
    return true;
  }
  if (turnsMatch !== null && method === 'GET') {
    handleLoadTurnHistory(turnsMatch[1], url, res, deps);
    return true;
  }
  const streamMatch = path.match(/^\/conversations\/([^/]+)\/turns\/([^/]+)\/stream$/);
  if (streamMatch !== null && method === 'GET') {
    handleSubscribeToStream(streamMatch[1], streamMatch[2], url, res, deps);
    return true;
  }
  return false;
}

function routeApprovals(
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConversationRouteDeps,
): boolean {
  const approvalsMatch = path.match(/^\/conversations\/([^/]+)\/approvals$/);
  if (approvalsMatch !== null && method === 'GET') {
    handleGetPendingApprovals(approvalsMatch[1], res, deps);
    return true;
  }
  const respondMatch = path.match(/^\/approvals\/([^/]+)\/respond$/);
  if (respondMatch !== null && method === 'POST') {
    handleRespondToApproval(respondMatch[1], req, res, deps).catch((err: unknown) => {
      sendError(res, 500, (err as Error).message);
    });
    return true;
  }
  return false;
}

function routeWorkControl(
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConversationRouteDeps,
): boolean {
  const cancelMatch = path.match(/^\/conversations\/([^/]+)\/turns\/([^/]+)\/cancel$/);
  if (cancelMatch !== null && method === 'POST') {
    handleCancelWork(cancelMatch[1], cancelMatch[2], res, deps);
    return true;
  }
  const retryMatch = path.match(/^\/conversations\/([^/]+)\/turns\/([^/]+)\/retry$/);
  if (retryMatch !== null && method === 'POST') {
    handleRetryTurn(retryMatch[1], retryMatch[2], res, deps);
    return true;
  }
  const forkMatch = path.match(/^\/conversations\/([^/]+)\/fork$/);
  if (forkMatch !== null && method === 'POST') {
    handleForkConversation(forkMatch[1], req, res, deps).catch((err: unknown) => {
      sendError(res, 500, (err as Error).message);
    });
    return true;
  }
  const queueMatch = path.match(/^\/conversations\/([^/]+)\/queue$/);
  if (queueMatch !== null && method === 'GET') {
    handleGetQueue(queueMatch[1], res, deps);
    return true;
  }
  if (queueMatch !== null && method === 'POST') {
    handleManageQueue(queueMatch[1], req, res, deps).catch((err: unknown) => {
      sendError(res, 500, (err as Error).message);
    });
    return true;
  }
  return false;
}

function routeArtifactsAndActivities(
  method: string,
  path: string,
  url: URL,
  res: ServerResponse,
  deps: ConversationRouteDeps,
): boolean {
  const turnArtifactsMatch = path.match(/^\/turns\/([^/]+)\/artifacts$/);
  if (turnArtifactsMatch !== null && method === 'GET') {
    handleListArtifactsForTurn(turnArtifactsMatch[1], res, deps);
    return true;
  }
  const artifactMatch = path.match(/^\/artifacts\/([^/]+)$/);
  if (artifactMatch !== null && method === 'GET') {
    handleGetArtifactContent(artifactMatch[1], res, deps);
    return true;
  }
  const convArtifactsMatch = path.match(/^\/conversations\/([^/]+)\/artifacts$/);
  if (convArtifactsMatch !== null && method === 'GET') {
    handleListArtifactsForConversation(convArtifactsMatch[1], url, res, deps);
    return true;
  }
  const activitiesMatch = path.match(/^\/turns\/([^/]+)\/activities$/);
  if (activitiesMatch !== null && method === 'GET') {
    handleGetActivities(activitiesMatch[1], url, res, deps);
    return true;
  }
  return false;
}

/**
 * Attempt to handle a conversation protocol route.
 * Returns true if the route was handled, false if not (fall through to other handlers).
 */
export function handleConversationRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConversationRouteDeps,
): boolean {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  return (
    routeLifecycle(method, path, url, req, res, deps) ||
    routeTurns(method, path, url, req, res, deps) ||
    routeApprovals(method, path, req, res, deps) ||
    routeWorkControl(method, path, req, res, deps) ||
    routeArtifactsAndActivities(method, path, url, res, deps)
  );
}

// ── Handler implementations ──────────────────────────────────────────────────

async function handleCreateConversation(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConversationRouteDeps,
): Promise<void> {
  const body = await readJsonBody(req);
  const title = typeof body['title'] === 'string' ? body['title'] : undefined;
  const conv = deps.store.createConversation({ title });
  sendJson(res, 201, conv);
}

function handleListConversations(url: URL, res: ServerResponse, deps: ConversationRouteDeps): void {
  const status = url.searchParams.get('status') ?? undefined;
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const limitParam = url.searchParams.get('limit');
  const limit = Math.min(Math.max(limitParam === null ? 20 : Number(limitParam), 1), 100);

  const all = deps.store.listConversations(
    status !== undefined && status !== '' ? { status } : undefined,
  );
  const totalCount = all.length;

  // Sort by createdAt descending, then id for stable ordering
  all.sort((a, b) => {
    const cmp = b.createdAt.localeCompare(a.createdAt);
    return cmp === 0 ? b.id.localeCompare(a.id) : cmp;
  });

  // Cursor-based pagination: cursor is the id of the last item seen
  let startIdx = 0;
  if (cursor !== undefined && cursor !== '') {
    const cursorIdx = all.findIndex((c) => c.id === cursor);
    if (cursorIdx >= 0) {
      startIdx = cursorIdx + 1;
    }
  }

  const page = all.slice(startIdx, startIdx + limit);
  const nextCursor = startIdx + limit < all.length ? page.at(-1)?.id : undefined;

  sendJson(res, 200, { conversations: page, nextCursor, totalCount });
}

function handleGetConversation(id: string, res: ServerResponse, deps: ConversationRouteDeps): void {
  const conv = deps.store.getConversation(id);
  if (!conv) {
    sendError(res, 404, 'Conversation not found');
    return;
  }
  const turns = deps.store.getTurns(conv.id);
  const recentTurns = turns.slice(-20);
  const pendingApprovals = deps.store.getPendingApprovals(conv.id);
  sendJson(res, 200, {
    conversation: conv,
    recentTurns,
    totalTurnCount: turns.length,
    pendingApprovals,
  });
}

function handleArchiveConversation(
  id: string,
  res: ServerResponse,
  deps: ConversationRouteDeps,
): void {
  try {
    deps.store.archiveConversation(id);
    sendJson(res, 200, { success: true });
  } catch {
    sendError(res, 404, 'Conversation not found');
  }
}

async function handleResumeConversation(
  id: string,
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConversationRouteDeps,
): Promise<void> {
  const body = await readJsonBody(req);
  const lastSeq = typeof body['lastAcknowledgedSeq'] === 'number' ? body['lastAcknowledgedSeq'] : 0;
  const conv = deps.store.getConversation(id);
  if (!conv) {
    sendError(res, 404, 'Conversation not found');
    return;
  }
  // Collect stream events across all turns in this conversation since lastSeq (exclusive)
  const turns = deps.store.getTurns(id);
  const allStreamEvents = [];
  for (const turn of turns) {
    const turnEvents = deps.streamManager.getStreamEventsSince(turn.id, lastSeq);
    allStreamEvents.push(...turnEvents);
  }
  allStreamEvents.sort((a, b) => a.seq - b.seq);
  const pendingApprovals = deps.store.getPendingApprovals(id);
  sendJson(res, 200, { conversation: conv, events: allStreamEvents, pendingApprovals });
}

async function handleSubmitInstruction(
  conversationId: string,
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConversationRouteDeps,
): Promise<void> {
  const body = await readJsonBody(req);
  const instruction = typeof body['instruction'] === 'string' ? body['instruction'] : '';
  if (instruction === '') {
    sendError(res, 400, 'instruction is required');
    return;
  }
  const conv = deps.store.getConversation(conversationId);
  if (conv === undefined) {
    sendError(res, 404, 'Conversation not found');
    return;
  }
  if (conv.status === 'archived') {
    sendError(res, 400, 'Conversation is archived');
    return;
  }

  const turn = deps.store.appendTurn(conversationId, {
    kind: 'operator',
    instruction,
    attribution: { type: 'operator', label: 'operator' },
  });
  deps.store.updateTurnStatus(turn.id, 'executing');
  const streamId = deps.streamManager.createStream(turn.id);

  // Kick off async execution if an executor is wired up
  if (deps.executeTurn) {
    deps.executeTurn(turn.id, instruction);
  }

  sendJson(res, 201, { turn, streamId });
}

function handleLoadTurnHistory(
  conversationId: string,
  url: URL,
  res: ServerResponse,
  deps: ConversationRouteDeps,
): void {
  const conv = deps.store.getConversation(conversationId);
  if (!conv) {
    sendError(res, 404, 'Conversation not found');
    return;
  }
  const fromParam = url.searchParams.get('from');
  const toParam = url.searchParams.get('to');
  const limitParam = url.searchParams.get('limit');
  const from = fromParam === null ? undefined : Number(fromParam);
  const to = toParam === null ? undefined : Number(toParam);
  const limit = Math.min(limitParam === null ? 50 : Number(limitParam), 100);

  let turns;
  if (from !== undefined && to !== undefined && !Number.isNaN(from) && !Number.isNaN(to)) {
    turns = deps.store.getTurnsByRange(conversationId, from, to);
  } else {
    turns = deps.store.getTurns(conversationId);
    if (turns.length > limit) {
      turns = turns.slice(-limit);
    }
  }
  sendJson(res, 200, {
    turns,
    totalCount: deps.store.getTurns(conversationId).length,
    hasMore: deps.store.getTurns(conversationId).length > turns.length,
  });
}

function handleSubscribeToStream(
  conversationId: string,
  turnId: string,
  url: URL,
  res: ServerResponse,
  deps: ConversationRouteDeps,
): void {
  const turn = deps.store.getTurn(turnId);
  if (!turn) {
    sendError(res, 404, 'Turn not found');
    return;
  }
  if (turn.conversationId !== conversationId) {
    sendError(res, 400, 'Turn does not belong to this conversation');
    return;
  }
  const sinceParam = url.searchParams.get('since');
  const sinceSeq = sinceParam === null ? 0 : Number(sinceParam);
  const events = deps.streamManager.getStreamEventsSince(turnId, sinceSeq);
  sendJson(res, 200, { events });
}

function handleGetPendingApprovals(
  conversationId: string,
  res: ServerResponse,
  deps: ConversationRouteDeps,
): void {
  const conv = deps.store.getConversation(conversationId);
  if (!conv) {
    sendError(res, 404, 'Conversation not found');
    return;
  }
  const approvals = deps.store.getPendingApprovals(conversationId);
  sendJson(res, 200, { approvals });
}

async function handleRespondToApproval(
  approvalId: string,
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConversationRouteDeps,
): Promise<void> {
  const body = await readJsonBody(req);
  const response = typeof body['response'] === 'string' ? body['response'] : '';
  const sessionId = typeof body['sessionId'] === 'string' ? body['sessionId'] : 'unknown';
  const acknowledgeStaleness = body['acknowledgeStaleness'] === true;

  if (response === '') {
    sendError(res, 400, 'response is required');
    return;
  }

  try {
    const result = deps.store.respondToApproval(
      approvalId,
      response,
      sessionId,
      acknowledgeStaleness,
    );
    sendJson(res, result.success ? 200 : 409, result);
  } catch {
    sendError(res, 404, 'Approval not found');
  }
}

function handleCancelWork(
  conversationId: string,
  turnId: string,
  res: ServerResponse,
  deps: ConversationRouteDeps,
): void {
  const turn = deps.store.getTurn(turnId);
  if (!turn) {
    sendError(res, 404, 'Turn not found');
    return;
  }
  if (turn.conversationId !== conversationId) {
    sendError(res, 400, 'Turn does not belong to this conversation');
    return;
  }
  deps.streamManager.cancelStream(turnId);
  const updated = deps.store.getTurn(turnId);
  sendJson(res, 200, { success: true, turn: updated });
}

function handleRetryTurn(
  conversationId: string,
  turnId: string,
  res: ServerResponse,
  deps: ConversationRouteDeps,
): void {
  const original = deps.store.getTurn(turnId);
  if (!original) {
    sendError(res, 404, 'Turn not found');
    return;
  }
  if (original.conversationId !== conversationId) {
    sendError(res, 400, 'Turn does not belong to this conversation');
    return;
  }
  try {
    const newTurn = deps.store.retryTurn(conversationId, turnId);
    deps.store.updateTurnStatus(newTurn.id, 'executing');
    const streamId = deps.streamManager.createStream(newTurn.id);

    // Kick off async execution if an executor is wired up
    if (deps.executeTurn) {
      deps.executeTurn(newTurn.id, newTurn.instruction ?? '');
    }

    sendJson(res, 201, { turn: newTurn, streamId });
  } catch (err) {
    sendError(res, 400, (err as Error).message);
  }
}

async function handleForkConversation(
  conversationId: string,
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConversationRouteDeps,
): Promise<void> {
  const body = await readJsonBody(req);
  const forkPointTurnId =
    typeof body['forkPointTurnId'] === 'string' ? body['forkPointTurnId'] : '';
  const title = typeof body['title'] === 'string' ? body['title'] : undefined;

  if (forkPointTurnId === '') {
    sendError(res, 400, 'forkPointTurnId is required');
    return;
  }

  const forkTurn = deps.store.getTurn(forkPointTurnId);
  if (!forkTurn) {
    sendError(res, 404, 'Fork point turn not found');
    return;
  }
  // The fork point turn must belong to the conversation being forked or
  // one of its ancestor conversations (reachable through the parent chain).
  const conv = deps.store.getConversation(conversationId);
  if (!conv) {
    sendError(res, 404, 'Conversation not found');
    return;
  }
  const turnsInConversation = deps.store.getTurns(conversationId);
  const turnBelongs = turnsInConversation.some((t) => t.id === forkPointTurnId);
  if (!turnBelongs) {
    sendError(res, 400, 'Fork point turn does not belong to this conversation');
    return;
  }

  try {
    const forked = deps.store.forkConversation(conversationId, forkPointTurnId, title);
    sendJson(res, 201, { conversation: forked });
  } catch (err) {
    sendError(res, 400, (err as Error).message);
  }
}

function handleGetQueue(
  conversationId: string,
  res: ServerResponse,
  deps: ConversationRouteDeps,
): void {
  const queue = deps.store.getInstructionQueue(conversationId);
  sendJson(res, 200, { queue });
}

async function handleManageQueue(
  conversationId: string,
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConversationRouteDeps,
): Promise<void> {
  const body = await readJsonBody(req);
  const action = typeof body['action'] === 'string' ? body['action'] : 'list';
  const instructionId =
    typeof body['instructionId'] === 'string' ? body['instructionId'] : undefined;

  if (action === 'remove' && instructionId !== undefined && instructionId !== '') {
    deps.store.removeFromQueue(conversationId, instructionId);
  }

  const queue = deps.store.getInstructionQueue(conversationId);
  sendJson(res, 200, { queue });
}

function handleListArtifactsForTurn(
  turnId: string,
  res: ServerResponse,
  deps: ConversationRouteDeps,
): void {
  const artifacts = deps.store.getArtifactsForTurn(turnId);
  sendJson(res, 200, { artifacts });
}

function handleGetArtifactContent(
  artifactId: string,
  res: ServerResponse,
  deps: ConversationRouteDeps,
): void {
  const artifact = deps.store.getArtifactMetadata(artifactId);
  if (artifact === undefined) {
    sendError(res, 404, 'Artifact not found');
    return;
  }
  const content = deps.store.getArtifactContent(artifactId);
  sendJson(res, 200, { artifact, content });
}

function handleListArtifactsForConversation(
  conversationId: string,
  url: URL,
  res: ServerResponse,
  deps: ConversationRouteDeps,
): void {
  const conv = deps.store.getConversation(conversationId);
  if (!conv) {
    sendError(res, 404, 'Conversation not found');
    return;
  }

  const kind = url.searchParams.get('kind') ?? undefined;
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const limitParam = url.searchParams.get('limit');
  const limit = Math.min(Math.max(limitParam === null ? 20 : Number(limitParam), 1), 100);

  let all = deps.store.listArtifactsForConversation(conversationId);

  // Filter by kind if specified
  if (kind !== undefined && kind !== '') {
    all = all.filter((a) => a.kind === kind);
  }

  const totalCount = all.length;

  // Cursor-based pagination: cursor is the id of the last item seen
  let startIdx = 0;
  if (cursor !== undefined && cursor !== '') {
    const cursorIdx = all.findIndex((a) => a.id === cursor);
    if (cursorIdx >= 0) {
      startIdx = cursorIdx + 1;
    }
  }

  const page = all.slice(startIdx, startIdx + limit);
  const nextCursor = startIdx + limit < all.length ? page.at(-1)?.id : undefined;

  sendJson(res, 200, { artifacts: page, nextCursor, totalCount });
}

function handleGetActivities(
  turnId: string,
  url: URL,
  res: ServerResponse,
  deps: ConversationRouteDeps,
): void {
  const agentId = url.searchParams.get('agent') ?? undefined;
  const activities =
    agentId !== undefined && agentId !== ''
      ? deps.store.filterActivitiesByAgent(turnId, agentId)
      : deps.store.getActivitiesForTurn(turnId);
  sendJson(res, 200, { activities });
}
