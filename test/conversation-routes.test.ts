/**
 * Unit tests for conversation route handlers.
 *
 * Tests the route handler logic using mock HTTP request/response objects.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import {
  handleConversationRoute,
  type ConversationRouteDeps,
} from '../lib/daemon/conversation-routes.ts';
import { ConversationStore } from '../lib/daemon/conversation-store.ts';
import { StreamManager } from '../lib/daemon/stream-manager.ts';

const operatorAttribution = { type: 'operator' as const, label: 'Admin' };

// ── Mock helpers ─────────────────────────────────────────────────────────────

function createMockReq(
  method: string,
  url: string,
  body?: Record<string, unknown>,
): IncomingMessage {
  const readable = body ? Readable.from([Buffer.from(JSON.stringify(body))]) : Readable.from([]);

  const req = Object.assign(readable, {
    method,
    url,
    headers: { host: 'localhost:4173' },
  }) as unknown as IncomingMessage;

  return req;
}

interface MockResponse {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  writeHead: (statusCode: number, headers: Record<string, string>) => void;
  end: (data: string) => void;
}

function createMockRes(): MockResponse {
  const mock: MockResponse = {
    statusCode: 0,
    body: null,
    headers: {},
    writeHead(statusCode: number, headers: Record<string, string>) {
      mock.statusCode = statusCode;
      mock.headers = headers;
    },
    end(data: string) {
      try {
        mock.body = JSON.parse(data);
      } catch {
        mock.body = data;
      }
    },
  };
  return mock;
}

async function waitForResponse(mock: MockResponse, maxWait = 100): Promise<void> {
  const start = Date.now();
  while (mock.body === null && Date.now() - start < maxWait) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

let deps: ConversationRouteDeps;

beforeEach(() => {
  const store = new ConversationStore();
  deps = {
    store,
    streamManager: new StreamManager(store),
  };
});

describe('Conversation routes — lifecycle', () => {
  it('POST /conversations creates a conversation', async () => {
    const req = createMockReq('POST', '/conversations', { title: 'Test Chat' });
    const res = createMockRes();
    const handled = handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.ok(handled);
    await waitForResponse(res);
    assert.equal(res.statusCode, 201);
    assert.ok((res.body as Record<string, unknown>)['id']);
    assert.equal((res.body as Record<string, unknown>)['title'], 'Test Chat');
  });

  it('GET /conversations lists conversations', () => {
    deps.store.createConversation({ title: 'A' });
    deps.store.createConversation({ title: 'B' });
    const req = createMockReq('GET', '/conversations');
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);
    assert.equal(((res.body as Record<string, unknown>)['conversations'] as unknown[]).length, 2);
  });

  it('GET /conversations/:id returns conversation with turns', () => {
    const conv = deps.store.createConversation();
    deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    const req = createMockReq('GET', `/conversations/${conv.id}`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);
    const body = res.body as Record<string, unknown>;
    assert.equal((body['recentTurns'] as unknown[]).length, 1);
  });

  it('GET /conversations/:id returns 404 for unknown', () => {
    const req = createMockReq('GET', '/conversations/unknown');
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 404);
  });

  it('POST /conversations/:id/archive archives conversation', () => {
    const conv = deps.store.createConversation();
    const req = createMockReq('POST', `/conversations/${conv.id}/archive`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);
    assert.equal(deps.store.getConversation(conv.id)?.status, 'archived');
  });
});

describe('Conversation routes — turns', () => {
  it('POST /conversations/:id/turns submits instruction', async () => {
    const conv = deps.store.createConversation();
    const req = createMockReq('POST', `/conversations/${conv.id}/turns`, {
      instruction: 'Explain architecture',
    });
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    await waitForResponse(res);
    assert.equal(res.statusCode, 201);
    const body = res.body as Record<string, unknown>;
    assert.ok(body['turn']);
    assert.ok(body['streamId']);
  });

  it('GET /conversations/:id/turns returns turn history', () => {
    const conv = deps.store.createConversation();
    deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'B',
      attribution: operatorAttribution,
    });
    const req = createMockReq('GET', `/conversations/${conv.id}/turns`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);
    assert.equal(((res.body as Record<string, unknown>)['turns'] as unknown[]).length, 2);
  });

  it('GET /conversations/:id/turns/:turnId/stream returns events', () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    deps.streamManager.createStream(turn.id);
    deps.streamManager.emitEvent(turn.id, 'text-delta', { text: 'chunk' });

    const req = createMockReq('GET', `/conversations/${conv.id}/turns/${turn.id}/stream?since=0`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);
    const events = (res.body as Record<string, unknown>)['events'] as unknown[];
    assert.ok(events.length >= 2, 'should have started + text-delta');
  });
});

describe('Conversation routes — approvals', () => {
  it('GET /conversations/:id/approvals returns pending', () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    deps.store.createApprovalRequest(turn.id, {
      prompt: 'Approve?',
      context: {},
      contextHash: 'hash-1',
      responseOptions: [{ key: 'ok', label: 'OK' }],
    });

    const req = createMockReq('GET', `/conversations/${conv.id}/approvals`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);
    assert.equal(((res.body as Record<string, unknown>)['approvals'] as unknown[]).length, 1);
  });

  it('POST /approvals/:id/respond responds to approval', async () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    const approval = deps.store.createApprovalRequest(turn.id, {
      prompt: 'Approve?',
      context: {},
      contextHash: 'hash-1',
      responseOptions: [{ key: 'ok', label: 'OK' }],
    });

    const req = createMockReq('POST', `/approvals/${approval.id}/respond`, {
      response: 'ok',
      sessionId: 'sess-1',
    });
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    await waitForResponse(res);
    assert.equal(res.statusCode, 200);
    assert.equal((res.body as Record<string, unknown>)['success'], true);
  });
});

describe('Conversation routes — work control', () => {
  it('POST .../cancel cancels work', () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    deps.store.updateTurnStatus(turn.id, 'executing');
    deps.streamManager.createStream(turn.id);

    const req = createMockReq('POST', `/conversations/${conv.id}/turns/${turn.id}/cancel`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);
    assert.equal(deps.store.getTurn(turn.id)?.status, 'cancelled');
  });

  it('POST .../retry retries a failed turn', () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    deps.store.finalizeTurn(turn.id, 'failed', 'Error');

    const req = createMockReq('POST', `/conversations/${conv.id}/turns/${turn.id}/retry`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 201);
    assert.ok((res.body as Record<string, unknown>)['turn']);
  });

  it('POST .../fork forks a conversation', async () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });

    const req = createMockReq('POST', `/conversations/${conv.id}/fork`, {
      forkPointTurnId: turn.id,
    });
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    await waitForResponse(res);
    assert.equal(res.statusCode, 201);
    assert.ok((res.body as Record<string, unknown>)['conversation']);
  });

  it('GET .../queue returns instruction queue', () => {
    const conv = deps.store.createConversation();
    deps.store.queueInstruction(conv.id, 'Do something');

    const req = createMockReq('GET', `/conversations/${conv.id}/queue`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);
    assert.equal(((res.body as Record<string, unknown>)['queue'] as unknown[]).length, 1);
  });
});

describe('Conversation routes — artifacts', () => {
  it('GET /turns/:turnId/artifacts lists artifacts', () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    deps.store.createArtifact(turn.id, {
      kind: 'file',
      label: 'out.ts',
      size: 100,
      content: 'code',
    });

    const req = createMockReq('GET', `/turns/${turn.id}/artifacts`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);
    assert.equal(((res.body as Record<string, unknown>)['artifacts'] as unknown[]).length, 1);
  });

  it('GET /artifacts/:id returns artifact content', () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    const art = deps.store.createArtifact(turn.id, {
      kind: 'file',
      label: 'out.ts',
      size: 100,
      content: 'const x = 1;',
    });

    const req = createMockReq('GET', `/artifacts/${art.id}`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);
    assert.equal((res.body as Record<string, unknown>)['content'], 'const x = 1;');
  });
});

describe('Conversation routes — activities', () => {
  it('GET /turns/:turnId/activities returns activities', () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    deps.store.appendActivity(turn.id, {
      attribution: { type: 'agent', agentId: 'gemini', label: 'Gemini' },
      kind: 'task-started',
      summary: 'Analyzing',
    });

    const req = createMockReq('GET', `/turns/${turn.id}/activities`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);
    assert.equal(((res.body as Record<string, unknown>)['activities'] as unknown[]).length, 1);
  });

  it('GET /turns/:turnId/activities?agent=gemini filters by agent', () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    deps.store.appendActivity(turn.id, {
      attribution: { type: 'agent', agentId: 'gemini', label: 'Gemini' },
      kind: 'task-started',
      summary: 'Gemini',
    });
    deps.store.appendActivity(turn.id, {
      attribution: { type: 'agent', agentId: 'claude', label: 'Claude' },
      kind: 'task-started',
      summary: 'Claude',
    });

    const req = createMockReq('GET', `/turns/${turn.id}/activities?agent=gemini`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);
    const activities = (res.body as Record<string, unknown>)['activities'] as unknown[];
    assert.equal(activities.length, 1);
  });

  it('returns false for unhandled routes', () => {
    const req = createMockReq('GET', '/unknown/route');
    const res = createMockRes();
    const handled = handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.ok(!handled, 'should not handle unknown routes');
  });
});
