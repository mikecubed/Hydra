/**
 * Conversation REST routes — mediation layer between browser and daemon (T010–T014).
 *
 * All routes validate request payloads against @hydra/web-contracts schemas (FR-006)
 * and require an authenticated session (FR-007). Daemon responses are forwarded
 * to the browser with appropriate HTTP status codes. Errors are translated into
 * the GatewayErrorResponse shape (FR-026, FR-028).
 *
 * Route groups:
 *   - Lifecycle (T010): create, list, open, resume, archive
 *   - Turns (T011): submit instruction, load turn history
 *   - Approvals (T012): get pending, respond to approval
 *   - Work Control (T013): cancel, retry
 *   - Artifacts & Activities (T014): list/get artifacts, get activities
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { GatewayEnv } from '../shared/types.ts';
import {
  CreateConversationRequest,
  ListConversationsRequest,
  ResumeConversationRequest,
  SubmitInstructionRequest,
  LoadTurnHistoryRequest,
  RespondToApprovalRequest,
  ListArtifactsForConversationRequest,
} from '@hydra/web-contracts';
import type { DaemonClient, DaemonResult } from './daemon-client.ts';
import { validateBody, validateQuery } from './request-validator.ts';
import {
  createGatewayErrorResponse,
  type ErrorCategory,
  type GatewayErrorResponse,
} from '../shared/gateway-error-response.ts';

// Query-only schemas: omit fields that come from URL path params
const LoadTurnHistoryQuery = LoadTurnHistoryRequest.omit({ conversationId: true });
const ListArtifactsForConversationQuery = ListArtifactsForConversationRequest.omit({
  conversationId: true,
});

// ── Daemon error → HTTP status mapping ───────────────────────────────────────

const CATEGORY_STATUS_MAP: Record<ErrorCategory, number> = {
  auth: 401,
  session: 409,
  validation: 400,
  daemon: 503,
  'rate-limit': 429,
};

function sendDaemonError(c: Context<GatewayEnv>, error: GatewayErrorResponse): Response {
  // Prefer the daemon's original HTTP status when available; fall back to category default
  const status = error.httpStatus ?? CATEGORY_STATUS_MAP[error.category];
  return c.json(error, status as ContentfulStatusCode);
}

function handleResult<T>(
  c: Context<GatewayEnv>,
  result: DaemonResult<T>,
  successStatus = 200,
): Response {
  if ('error' in result) {
    return sendDaemonError(c, result.error);
  }
  return c.json(result.data, successStatus as ContentfulStatusCode);
}

// ── Sub-routers ──────────────────────────────────────────────────────────────

function registerLifecycleRoutes(app: Hono<GatewayEnv>, dc: DaemonClient): void {
  app.post('/conversations', validateBody(CreateConversationRequest), async (c) => {
    const body = c.get('validatedBody' as never) as CreateConversationRequest;
    const parentConversationId = body.parentConversationId;
    const forkPointTurnId = body.forkPointTurnId;

    const hasParent = parentConversationId !== undefined;
    const hasForkPoint = forkPointTurnId !== undefined;

    // Reject partial fork fields — both must be present or both absent
    if (hasParent !== hasForkPoint) {
      return sendDaemonError(
        c,
        createGatewayErrorResponse({
          code: 'VALIDATION_FAILED',
          category: 'validation',
          message: 'parentConversationId and forkPointTurnId must both be present or both absent',
        }),
      );
    }

    // Fork-intended request: route to the daemon fork endpoint
    if (hasParent && hasForkPoint) {
      const forkResult = await dc.forkConversation(parentConversationId, {
        conversationId: parentConversationId,
        forkPointTurnId,
        title: body.title,
      });
      if ('error' in forkResult) {
        return sendDaemonError(c, forkResult.error);
      }
      // Unwrap { conversation: Conversation } → Conversation for a consistent 201 shape
      return c.json(forkResult.data.conversation, 201 as ContentfulStatusCode);
    }

    return handleResult(c, await dc.createConversation(body), 201);
  });

  app.get('/conversations', validateQuery(ListConversationsRequest), async (c) => {
    const query = c.get('validatedQuery' as never) as ListConversationsRequest;
    return handleResult(c, await dc.listConversations(query));
  });

  app.get('/conversations/:id', async (c) =>
    handleResult(c, await dc.openConversation(c.req.param('id'))),
  );

  app.post('/conversations/:id/resume', validateBody(ResumeConversationRequest), async (c) => {
    const id = c.req.param('id');
    const body = c.get('validatedBody' as never) as ResumeConversationRequest;
    return handleResult(c, await dc.resumeConversation(id, body));
  });

  app.post('/conversations/:id/archive', async (c) =>
    handleResult(c, await dc.archiveConversation(c.req.param('id'))),
  );
}

function registerTurnRoutes(app: Hono<GatewayEnv>, dc: DaemonClient): void {
  app.post('/conversations/:convId/turns', validateBody(SubmitInstructionRequest), async (c) => {
    const convId = c.req.param('convId');
    const sessionId = c.get('sessionId' as never) as string;
    const body = c.get('validatedBody' as never) as SubmitInstructionRequest;
    return handleResult(c, await dc.submitInstruction(convId, body, { sessionId }), 201);
  });

  app.get('/conversations/:convId/turns', validateQuery(LoadTurnHistoryQuery), async (c) => {
    const convId = c.req.param('convId');
    const query = c.get('validatedQuery' as never) as Omit<
      LoadTurnHistoryRequest,
      'conversationId'
    >;
    return handleResult(c, await dc.loadTurnHistory(convId, { conversationId: convId, ...query }));
  });
}

function registerApprovalRoutes(app: Hono<GatewayEnv>, dc: DaemonClient): void {
  app.get('/conversations/:convId/approvals', async (c) =>
    handleResult(c, await dc.getPendingApprovals(c.req.param('convId'))),
  );

  app.post('/approvals/:approvalId/respond', validateBody(RespondToApprovalRequest), async (c) => {
    const approvalId = c.req.param('approvalId');
    const sessionId = c.get('sessionId' as never) as string;
    const body = c.get('validatedBody' as never) as RespondToApprovalRequest;
    return handleResult(c, await dc.respondToApproval(approvalId, { ...body, sessionId }));
  });
}

function registerWorkControlRoutes(app: Hono<GatewayEnv>, dc: DaemonClient): void {
  app.post('/conversations/:convId/turns/:turnId/cancel', async (c) =>
    handleResult(c, await dc.cancelWork(c.req.param('convId'), c.req.param('turnId'))),
  );

  app.post('/conversations/:convId/turns/:turnId/retry', async (c) =>
    handleResult(c, await dc.retryTurn(c.req.param('convId'), c.req.param('turnId'))),
  );
}

function registerArtifactActivityRoutes(app: Hono<GatewayEnv>, dc: DaemonClient): void {
  app.get('/turns/:turnId/artifacts', async (c) =>
    handleResult(c, await dc.listArtifactsForTurn(c.req.param('turnId'))),
  );

  app.get(
    '/conversations/:convId/artifacts',
    validateQuery(ListArtifactsForConversationQuery),
    async (c) => {
      const convId = c.req.param('convId');
      const query = c.get('validatedQuery' as never) as {
        kind?: string;
        cursor?: string;
        limit: number;
      };
      return handleResult(
        c,
        await dc.listArtifactsForConversation(convId, { conversationId: convId, ...query }),
      );
    },
  );

  app.get('/artifacts/:artifactId', async (c) =>
    handleResult(c, await dc.getArtifactContent(c.req.param('artifactId'))),
  );

  app.get('/turns/:turnId/activities', async (c) =>
    handleResult(c, await dc.getActivityEntries(c.req.param('turnId'))),
  );
}

// ── Route factory ────────────────────────────────────────────────────────────

export function createConversationRoutes(daemonClient: DaemonClient): Hono<GatewayEnv> {
  const app = new Hono<GatewayEnv>();
  registerLifecycleRoutes(app, daemonClient);
  registerTurnRoutes(app, daemonClient);
  registerApprovalRoutes(app, daemonClient);
  registerWorkControlRoutes(app, daemonClient);
  registerArtifactActivityRoutes(app, daemonClient);
  return app;
}
