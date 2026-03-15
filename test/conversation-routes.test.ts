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
    assert.ok((res.body as Record<string, unknown>)['artifact'], 'should have artifact object');
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

// ── Blocker 2: Reconnect/resume semantics ────────────────────────────────────

describe('Conversation routes — resume returns StreamEvents', () => {
  it('resume returns StreamEvent[] not ConversationEventRecords', async () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    deps.store.updateTurnStatus(turn.id, 'executing');
    deps.streamManager.createStream(turn.id);
    deps.streamManager.emitEvent(turn.id, 'text-delta', { text: 'chunk' });

    const req = createMockReq('POST', `/conversations/${conv.id}/resume`, {
      lastAcknowledgedSeq: 0,
    });
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    await waitForResponse(res);
    assert.equal(res.statusCode, 200);
    const body = res.body as Record<string, unknown>;
    const events = body['events'] as Array<Record<string, unknown>>;
    assert.ok(events.length >= 2, 'should have stream-started + text-delta');
    // StreamEvents have seq, turnId, kind, payload, timestamp — NOT category
    for (const ev of events) {
      assert.ok('seq' in ev, 'event should have seq');
      assert.ok('turnId' in ev, 'event should have turnId');
      assert.ok('kind' in ev, 'event should have kind');
      assert.ok(
        !('category' in ev),
        'event should not have category (that is ConversationEventRecord)',
      );
    }
  });

  it('resume since is exclusive — does not duplicate last acknowledged event', async () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    deps.store.updateTurnStatus(turn.id, 'executing');
    deps.streamManager.createStream(turn.id);
    deps.streamManager.emitEvent(turn.id, 'text-delta', { text: 'a' });
    deps.streamManager.emitEvent(turn.id, 'text-delta', { text: 'b' });

    // Get all events to find the last seq
    const allEvents = deps.streamManager.getStreamEvents(turn.id);
    const lastSeq = allEvents.at(-1)!.seq;

    const req = createMockReq('POST', `/conversations/${conv.id}/resume`, {
      lastAcknowledgedSeq: lastSeq,
    });
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    await waitForResponse(res);
    assert.equal(res.statusCode, 200);
    const body = res.body as Record<string, unknown>;
    const events = body['events'] as Array<Record<string, unknown>>;
    assert.equal(events.length, 0, 'should not include already-acknowledged events');
  });
});

// ── Blocker 2 (continued): Resume input validation ───────────────────────────

describe('Conversation routes — resume input validation', () => {
  it('resume rejects negative lastAcknowledgedSeq', async () => {
    const conv = deps.store.createConversation();
    const req = createMockReq('POST', `/conversations/${conv.id}/resume`, {
      lastAcknowledgedSeq: -1,
    });
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    await waitForResponse(res);
    assert.equal(res.statusCode, 400);
    const body = res.body as Record<string, unknown>;
    assert.ok(
      (body['error'] as string).includes('lastAcknowledgedSeq'),
      'error should mention lastAcknowledgedSeq',
    );
  });

  it('resume rejects fractional lastAcknowledgedSeq', async () => {
    const conv = deps.store.createConversation();
    const req = createMockReq('POST', `/conversations/${conv.id}/resume`, {
      lastAcknowledgedSeq: 1.5,
    });
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    await waitForResponse(res);
    assert.equal(res.statusCode, 400);
  });

  it('resume rejects non-number lastAcknowledgedSeq', async () => {
    const conv = deps.store.createConversation();
    const req = createMockReq('POST', `/conversations/${conv.id}/resume`, {
      lastAcknowledgedSeq: 'abc',
    });
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    await waitForResponse(res);
    // String value for a numeric field is correctly rejected
    assert.equal(res.statusCode, 400);
  });

  it('resume defaults missing lastAcknowledgedSeq to 0', async () => {
    const conv = deps.store.createConversation();
    const req = createMockReq('POST', `/conversations/${conv.id}/resume`, {});
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    await waitForResponse(res);
    assert.equal(res.statusCode, 200, 'omitted lastAcknowledgedSeq defaults to 0');
  });

  it('resume accepts zero lastAcknowledgedSeq (means "give me everything")', async () => {
    const conv = deps.store.createConversation();
    const req = createMockReq('POST', `/conversations/${conv.id}/resume`, {
      lastAcknowledgedSeq: 0,
    });
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    await waitForResponse(res);
    assert.equal(res.statusCode, 200);
  });
});

// ── Blocker 2 (continued): Turn history position validation (positive ints) ─

describe('Conversation routes — turn history position validation', () => {
  it('GET /conversations/:id/turns rejects from=0 (positions are positive)', () => {
    const conv = deps.store.createConversation();
    const req = createMockReq('GET', `/conversations/${conv.id}/turns?from=0`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 400);
    const body = res.body as Record<string, unknown>;
    assert.ok((body['error'] as string).includes('positive'));
  });

  it('GET /conversations/:id/turns rejects to=0 (positions are positive)', () => {
    const conv = deps.store.createConversation();
    const req = createMockReq('GET', `/conversations/${conv.id}/turns?from=1&to=0`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 400);
    const body = res.body as Record<string, unknown>;
    assert.ok((body['error'] as string).includes('positive'));
  });
});

// ── Blocker 3: Cross-conversation turn validation ────────────────────────────

describe('Conversation routes — cross-conversation validation', () => {
  it('cancel rejects turn from different conversation', () => {
    const conv1 = deps.store.createConversation({ title: 'Conv 1' });
    const conv2 = deps.store.createConversation({ title: 'Conv 2' });
    const turn1 = deps.store.appendTurn(conv1.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    deps.store.updateTurnStatus(turn1.id, 'executing');
    deps.streamManager.createStream(turn1.id);

    // Try to cancel conv1's turn via conv2's path
    const req = createMockReq('POST', `/conversations/${conv2.id}/turns/${turn1.id}/cancel`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 400);
    const body = res.body as Record<string, unknown>;
    assert.ok(
      (body['error'] as string).includes('does not belong'),
      'should indicate turn does not belong to conversation',
    );
  });

  it('stream rejects turn from different conversation', () => {
    const conv1 = deps.store.createConversation({ title: 'Conv 1' });
    const conv2 = deps.store.createConversation({ title: 'Conv 2' });
    const turn1 = deps.store.appendTurn(conv1.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    deps.streamManager.createStream(turn1.id);

    const req = createMockReq('GET', `/conversations/${conv2.id}/turns/${turn1.id}/stream?since=0`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 400);
  });

  it('retry rejects turn from different conversation', () => {
    const conv1 = deps.store.createConversation({ title: 'Conv 1' });
    const conv2 = deps.store.createConversation({ title: 'Conv 2' });
    const turn1 = deps.store.appendTurn(conv1.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    deps.store.finalizeTurn(turn1.id, 'failed', 'Error');

    const req = createMockReq('POST', `/conversations/${conv2.id}/turns/${turn1.id}/retry`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 400);
  });

  it('fork rejects turn from different conversation', async () => {
    const conv1 = deps.store.createConversation({ title: 'Conv 1' });
    const conv2 = deps.store.createConversation({ title: 'Conv 2' });
    const turn1 = deps.store.appendTurn(conv1.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });

    const req = createMockReq('POST', `/conversations/${conv2.id}/fork`, {
      forkPointTurnId: turn1.id,
    });
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    await waitForResponse(res);
    assert.equal(res.statusCode, 400);
  });

  it('fork accepts turn from parent conversation lineage', async () => {
    const parent = deps.store.createConversation({ title: 'Parent' });
    const turn1 = deps.store.appendTurn(parent.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    deps.store.appendTurn(parent.id, {
      kind: 'operator',
      instruction: 'B',
      attribution: operatorAttribution,
    });

    // Fork the parent at turn1
    const forked = deps.store.forkConversation(parent.id, turn1.id, 'Forked');
    // The forked conversation inherits parent turns up to the fork point.
    // Forking the forked conversation at turn1 (which is a parent turn) should succeed.
    const req = createMockReq('POST', `/conversations/${forked.id}/fork`, {
      forkPointTurnId: turn1.id,
    });
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    await waitForResponse(res);
    assert.equal(res.statusCode, 201, 'should accept turn from parent lineage');
  });
});

// ── Blocker 4: Artifact content contract compliance ──────────────────────────

describe('Conversation routes — artifact content contract', () => {
  it('GET /artifacts/:id returns { artifact, content } matching contract', () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    const art = deps.store.createArtifact(turn.id, {
      kind: 'file',
      label: 'out.ts',
      size: 12,
      content: 'const x = 1;',
    });

    const req = createMockReq('GET', `/artifacts/${art.id}`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);
    const body = res.body as Record<string, unknown>;

    // Must have 'artifact' (full object), not 'artifactId' (string)
    assert.ok(!('artifactId' in body), 'should not have artifactId key');
    assert.ok('artifact' in body, 'should have artifact key');
    assert.ok('content' in body, 'should have content key');

    const artifact = body['artifact'] as Record<string, unknown>;
    assert.equal(artifact['id'], art.id);
    assert.equal(artifact['turnId'], turn.id);
    assert.equal(artifact['kind'], 'file');
    assert.equal(artifact['label'], 'out.ts');
    assert.equal(artifact['size'], 12);
    assert.ok('createdAt' in artifact, 'artifact should have createdAt');
    assert.equal(body['content'], 'const x = 1;');
  });
});

// ── Blocker 1: Turn execution pipeline ───────────────────────────────────────

describe('Conversation routes — turn execution pipeline', () => {
  it('submit instruction invokes executeTurn callback', async () => {
    const executedTurns: Array<{ turnId: string; instruction: string }> = [];
    const depsWithExecutor: ConversationRouteDeps = {
      ...deps,
      executeTurn(turnId: string, instruction: string) {
        executedTurns.push({ turnId, instruction });
      },
    };
    const conv = depsWithExecutor.store.createConversation();
    const req = createMockReq('POST', `/conversations/${conv.id}/turns`, {
      instruction: 'Hello world',
    });
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, depsWithExecutor);
    await waitForResponse(res);
    assert.equal(res.statusCode, 201);
    assert.equal(executedTurns.length, 1, 'executeTurn should have been called');
    assert.equal(executedTurns[0].instruction, 'Hello world');
  });

  it('submit + executeTurn drives stream to completion', async () => {
    const depsWithExecutor: ConversationRouteDeps = {
      ...deps,
      executeTurn(turnId: string, _instruction: string) {
        deps.streamManager.emitEvent(turnId, 'text-delta', { text: 'response text' });
        deps.streamManager.completeStream(turnId);
      },
    };
    const conv = depsWithExecutor.store.createConversation();
    const req = createMockReq('POST', `/conversations/${conv.id}/turns`, {
      instruction: 'Test execution',
    });
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, depsWithExecutor);
    await waitForResponse(res);
    assert.equal(res.statusCode, 201);
    const body = res.body as Record<string, unknown>;
    const turnObj = body['turn'] as Record<string, unknown>;
    const turnId = turnObj['id'] as string;

    // Verify the turn reached completed state
    const finalTurn = deps.store.getTurn(turnId);
    assert.equal(finalTurn?.status, 'completed');
    assert.equal(finalTurn?.response, 'response text');

    // Verify stream events were emitted
    const events = deps.streamManager.getStreamEvents(turnId);
    assert.ok(events.some((e) => e.kind === 'stream-started'));
    assert.ok(events.some((e) => e.kind === 'text-delta'));
    assert.ok(events.some((e) => e.kind === 'stream-completed'));
  });

  it('submit + executeTurn handles failure', async () => {
    const depsWithExecutor: ConversationRouteDeps = {
      ...deps,
      executeTurn(turnId: string, _instruction: string) {
        deps.streamManager.failStream(turnId, 'Agent crashed');
      },
    };
    const conv = depsWithExecutor.store.createConversation();
    const req = createMockReq('POST', `/conversations/${conv.id}/turns`, {
      instruction: 'Will fail',
    });
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, depsWithExecutor);
    await waitForResponse(res);
    assert.equal(res.statusCode, 201);
    const body = res.body as Record<string, unknown>;
    const turnObj = body['turn'] as Record<string, unknown>;
    const turnId = turnObj['id'] as string;

    const finalTurn = deps.store.getTurn(turnId);
    assert.equal(finalTurn?.status, 'failed');

    const events = deps.streamManager.getStreamEvents(turnId);
    assert.ok(events.some((e) => e.kind === 'stream-failed'));
  });

  it('retry invokes executeTurn on the new turn', () => {
    const executedTurns: Array<{ turnId: string; instruction: string }> = [];
    const depsWithExecutor: ConversationRouteDeps = {
      ...deps,
      executeTurn(turnId: string, instruction: string) {
        executedTurns.push({ turnId, instruction });
      },
    };
    const conv = depsWithExecutor.store.createConversation();
    const turn = depsWithExecutor.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Retry me',
      attribution: operatorAttribution,
    });
    depsWithExecutor.store.finalizeTurn(turn.id, 'failed', 'Error');

    const req = createMockReq('POST', `/conversations/${conv.id}/turns/${turn.id}/retry`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, depsWithExecutor);
    assert.equal(res.statusCode, 201);
    assert.equal(executedTurns.length, 1, 'executeTurn should be called for retry');
    assert.equal(executedTurns[0].instruction, 'Retry me');
  });

  it('retry + executeTurn drives new stream to completion', () => {
    const depsWithExecutor: ConversationRouteDeps = {
      ...deps,
      executeTurn(turnId: string, _instruction: string) {
        deps.streamManager.emitEvent(turnId, 'text-delta', { text: 'retry success' });
        deps.streamManager.completeStream(turnId);
      },
    };
    const conv = depsWithExecutor.store.createConversation();
    const turn = depsWithExecutor.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Retry me',
      attribution: operatorAttribution,
    });
    depsWithExecutor.store.finalizeTurn(turn.id, 'failed', 'Error');

    const req = createMockReq('POST', `/conversations/${conv.id}/turns/${turn.id}/retry`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, depsWithExecutor);
    assert.equal(res.statusCode, 201);
    const body = res.body as Record<string, unknown>;
    const newTurn = body['turn'] as Record<string, unknown>;
    const newTurnId = newTurn['id'] as string;

    const finalTurn = deps.store.getTurn(newTurnId);
    assert.equal(finalTurn?.status, 'completed');
    assert.equal(finalTurn?.response, 'retry success');
  });

  it('works without executeTurn callback (backward compat)', async () => {
    const conv = deps.store.createConversation();
    const req = createMockReq('POST', `/conversations/${conv.id}/turns`, {
      instruction: 'No executor',
    });
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    await waitForResponse(res);
    assert.equal(res.statusCode, 201);
    const body = res.body as Record<string, unknown>;
    const turnObj = body['turn'] as Record<string, unknown>;
    // Turn is executing but not completed (no executor)
    assert.equal(turnObj['status'], 'executing');
  });
});

// ── Blocker 2: Pagination contracts ──────────────────────────────────────────

describe('Conversation routes — list conversations pagination', () => {
  it('GET /conversations respects limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      deps.store.createConversation({ title: `Conv ${String(i)}` });
    }
    const req = createMockReq('GET', '/conversations?limit=2');
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);
    const body = res.body as Record<string, unknown>;
    const convs = body['conversations'] as unknown[];
    assert.equal(convs.length, 2);
    assert.equal(body['totalCount'], 5);
    assert.ok(body['nextCursor'], 'should have nextCursor when more items exist');
  });

  it('GET /conversations returns all when limit >= total', () => {
    for (let i = 0; i < 3; i++) {
      deps.store.createConversation({ title: `Conv ${String(i)}` });
    }
    const req = createMockReq('GET', '/conversations?limit=10');
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    const body = res.body as Record<string, unknown>;
    assert.equal((body['conversations'] as unknown[]).length, 3);
    assert.equal(body['nextCursor'], undefined);
  });

  it('GET /conversations cursor paginates through all items', () => {
    for (let i = 0; i < 5; i++) {
      deps.store.createConversation({ title: `Conv ${String(i)}` });
    }

    // Page 1
    const req1 = createMockReq('GET', '/conversations?limit=2');
    const res1 = createMockRes();
    handleConversationRoute(req1, res1 as unknown as ServerResponse, deps);
    const body1 = res1.body as Record<string, unknown>;
    const page1 = body1['conversations'] as Array<Record<string, unknown>>;
    assert.equal(page1.length, 2);
    const cursor1 = body1['nextCursor'] as string;
    assert.ok(cursor1);

    // Page 2
    const req2 = createMockReq('GET', `/conversations?limit=2&cursor=${cursor1}`);
    const res2 = createMockRes();
    handleConversationRoute(req2, res2 as unknown as ServerResponse, deps);
    const body2 = res2.body as Record<string, unknown>;
    const page2 = body2['conversations'] as Array<Record<string, unknown>>;
    assert.equal(page2.length, 2);
    const cursor2 = body2['nextCursor'] as string;
    assert.ok(cursor2);

    // Page 3 (last)
    const req3 = createMockReq('GET', `/conversations?limit=2&cursor=${cursor2}`);
    const res3 = createMockRes();
    handleConversationRoute(req3, res3 as unknown as ServerResponse, deps);
    const body3 = res3.body as Record<string, unknown>;
    const page3 = body3['conversations'] as Array<Record<string, unknown>>;
    assert.equal(page3.length, 1);
    assert.equal(body3['nextCursor'], undefined, 'no nextCursor on last page');

    // No duplicates across pages
    const allIds = [...page1, ...page2, ...page3].map((c) => c['id'] as string);
    const unique = new Set(allIds);
    assert.equal(unique.size, 5, 'should have 5 unique conversations across all pages');
  });

  it('GET /conversations default limit is 20', () => {
    for (let i = 0; i < 25; i++) {
      deps.store.createConversation({ title: `Conv ${String(i)}` });
    }
    const req = createMockReq('GET', '/conversations');
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    const body = res.body as Record<string, unknown>;
    assert.equal((body['conversations'] as unknown[]).length, 20);
    assert.ok(body['nextCursor']);
    assert.equal(body['totalCount'], 25);
  });
});

describe('Conversation routes — list artifacts pagination', () => {
  it('GET /conversations/:id/artifacts respects limit', () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    for (let i = 0; i < 5; i++) {
      deps.store.createArtifact(turn.id, {
        kind: 'file',
        label: `file${String(i)}.ts`,
        size: 100,
        content: `c${String(i)}`,
      });
    }

    const req = createMockReq('GET', `/conversations/${conv.id}/artifacts?limit=2`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);
    const body = res.body as Record<string, unknown>;
    assert.equal((body['artifacts'] as unknown[]).length, 2);
    assert.equal(body['totalCount'], 5);
    assert.ok(body['nextCursor']);
  });

  it('GET /conversations/:id/artifacts filters by kind', () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    deps.store.createArtifact(turn.id, {
      kind: 'file',
      label: 'a.ts',
      size: 100,
      content: '',
    });
    deps.store.createArtifact(turn.id, {
      kind: 'diff',
      label: 'b.diff',
      size: 50,
      content: '',
    });
    deps.store.createArtifact(turn.id, {
      kind: 'file',
      label: 'c.ts',
      size: 100,
      content: '',
    });

    const req = createMockReq('GET', `/conversations/${conv.id}/artifacts?kind=file`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);
    const body = res.body as Record<string, unknown>;
    const artifacts = body['artifacts'] as Array<Record<string, unknown>>;
    assert.equal(artifacts.length, 2);
    assert.ok(artifacts.every((a) => a['kind'] === 'file'));
    assert.equal(body['totalCount'], 2);
  });

  it('GET /conversations/:id/artifacts cursor paginates correctly', () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    for (let i = 0; i < 5; i++) {
      deps.store.createArtifact(turn.id, {
        kind: 'file',
        label: `file${String(i)}.ts`,
        size: 100,
        content: `c${String(i)}`,
      });
    }

    // Page 1
    const req1 = createMockReq('GET', `/conversations/${conv.id}/artifacts?limit=2`);
    const res1 = createMockRes();
    handleConversationRoute(req1, res1 as unknown as ServerResponse, deps);
    const body1 = res1.body as Record<string, unknown>;
    const page1 = body1['artifacts'] as Array<Record<string, unknown>>;
    assert.equal(page1.length, 2);
    const cursor1 = body1['nextCursor'] as string;
    assert.ok(cursor1);

    // Page 2
    const req2 = createMockReq(
      'GET',
      `/conversations/${conv.id}/artifacts?limit=2&cursor=${cursor1}`,
    );
    const res2 = createMockRes();
    handleConversationRoute(req2, res2 as unknown as ServerResponse, deps);
    const body2 = res2.body as Record<string, unknown>;
    const page2 = body2['artifacts'] as Array<Record<string, unknown>>;
    assert.equal(page2.length, 2);

    // Page 3 (last)
    const cursor2 = body2['nextCursor'] as string;
    const req3 = createMockReq(
      'GET',
      `/conversations/${conv.id}/artifacts?limit=2&cursor=${cursor2}`,
    );
    const res3 = createMockRes();
    handleConversationRoute(req3, res3 as unknown as ServerResponse, deps);
    const body3 = res3.body as Record<string, unknown>;
    const page3 = body3['artifacts'] as Array<Record<string, unknown>>;
    assert.equal(page3.length, 1);
    assert.equal(body3['nextCursor'], undefined);

    // No duplicates
    const allIds = [...page1, ...page2, ...page3].map((a) => a['id'] as string);
    assert.equal(new Set(allIds).size, 5);
  });

  it('GET /conversations/:id/artifacts kind + cursor combined', () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    for (let i = 0; i < 4; i++) {
      deps.store.createArtifact(turn.id, {
        kind: 'file',
        label: `file${String(i)}.ts`,
        size: 100,
        content: '',
      });
    }
    deps.store.createArtifact(turn.id, { kind: 'diff', label: 'x.diff', size: 10, content: '' });

    // First page of kind=file with limit 2
    const req1 = createMockReq('GET', `/conversations/${conv.id}/artifacts?kind=file&limit=2`);
    const res1 = createMockRes();
    handleConversationRoute(req1, res1 as unknown as ServerResponse, deps);
    const body1 = res1.body as Record<string, unknown>;
    assert.equal((body1['artifacts'] as unknown[]).length, 2);
    assert.equal(body1['totalCount'], 4);
    assert.ok(body1['nextCursor']);
  });
});

// ── Blocker 3 route-level: fork inherits approvals/artifacts via routes ──────

describe('Conversation routes — fork inheritance via routes', () => {
  it('GET approvals on forked conversation returns inherited approvals', () => {
    const parent = deps.store.createConversation();
    const t1 = deps.store.appendTurn(parent.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    const t2 = deps.store.appendTurn(parent.id, {
      kind: 'operator',
      instruction: 'B',
      attribution: operatorAttribution,
    });
    deps.store.createApprovalRequest(t1.id, {
      prompt: 'Parent approval?',
      context: {},
      contextHash: 'hash-p',
      responseOptions: [{ key: 'ok', label: 'OK' }],
    });

    const fork = deps.store.forkConversation(parent.id, t2.id);

    const req = createMockReq('GET', `/conversations/${fork.id}/approvals`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);
    const body = res.body as Record<string, unknown>;
    assert.equal(
      (body['approvals'] as unknown[]).length,
      1,
      'fork route should show inherited approvals',
    );
  });

  it('GET artifacts on forked conversation returns inherited artifacts', () => {
    const parent = deps.store.createConversation();
    const t1 = deps.store.appendTurn(parent.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    deps.store.createArtifact(t1.id, { kind: 'file', label: 'parent.ts', size: 100, content: 'p' });

    const fork = deps.store.forkConversation(parent.id, t1.id);

    const req = createMockReq('GET', `/conversations/${fork.id}/artifacts`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);
    const body = res.body as Record<string, unknown>;
    assert.equal(
      (body['artifacts'] as unknown[]).length,
      1,
      'fork route should show inherited artifacts',
    );
  });
});

// ── Blocker: Executor startup failures ───────────────────────────────────────

describe('Conversation routes — executor startup failures', () => {
  it('submit catches thrown executeTurn and fails stream/turn', async () => {
    const depsWithThrow: ConversationRouteDeps = {
      ...deps,
      executeTurn() {
        throw new Error('Agent binary not found');
      },
    };
    const conv = depsWithThrow.store.createConversation();
    const req = createMockReq('POST', `/conversations/${conv.id}/turns`, {
      instruction: 'Hello',
    });
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, depsWithThrow);
    await waitForResponse(res);
    assert.equal(res.statusCode, 201, 'should still return 201 — turn was created');
    const body = res.body as Record<string, unknown>;
    const turnObj = body['turn'] as Record<string, unknown>;
    const turnId = turnObj['id'] as string;

    const finalTurn = deps.store.getTurn(turnId);
    assert.equal(finalTurn?.status, 'failed', 'turn should be failed after thrown executor');

    const events = deps.streamManager.getStreamEvents(turnId);
    assert.ok(
      events.some((e) => e.kind === 'stream-failed'),
      'stream should have a stream-failed event',
    );
  });

  it('submit catches rejected executeTurn promise and fails stream/turn', async () => {
    const depsWithReject: ConversationRouteDeps = {
      ...deps,
      executeTurn() {
        return Promise.reject(new Error('Connection refused'));
      },
    };
    const conv = depsWithReject.store.createConversation();
    const req = createMockReq('POST', `/conversations/${conv.id}/turns`, {
      instruction: 'Hello',
    });
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, depsWithReject);
    await waitForResponse(res);
    assert.equal(res.statusCode, 201);
    const body = res.body as Record<string, unknown>;
    const turnObj = body['turn'] as Record<string, unknown>;
    const turnId = turnObj['id'] as string;

    // Allow microtask queue to settle for promise rejection handler
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });

    const finalTurn = deps.store.getTurn(turnId);
    assert.equal(finalTurn?.status, 'failed', 'turn should be failed after rejected executor');

    const events = deps.streamManager.getStreamEvents(turnId);
    assert.ok(
      events.some((e) => e.kind === 'stream-failed'),
      'stream should have a stream-failed event',
    );
  });

  it('retry catches thrown executeTurn and fails stream/turn', () => {
    const depsWithThrow: ConversationRouteDeps = {
      ...deps,
      executeTurn() {
        throw new Error('Agent crashed');
      },
    };
    const conv = depsWithThrow.store.createConversation();
    const turn = depsWithThrow.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Retry me',
      attribution: operatorAttribution,
    });
    depsWithThrow.store.finalizeTurn(turn.id, 'failed', 'Error');

    const req = createMockReq('POST', `/conversations/${conv.id}/turns/${turn.id}/retry`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, depsWithThrow);
    assert.equal(res.statusCode, 201, 'should still return 201 — retry turn was created');

    const body = res.body as Record<string, unknown>;
    const newTurn = body['turn'] as Record<string, unknown>;
    const newTurnId = newTurn['id'] as string;

    const finalTurn = deps.store.getTurn(newTurnId);
    assert.equal(finalTurn?.status, 'failed', 'retried turn should be failed');

    const events = deps.streamManager.getStreamEvents(newTurnId);
    assert.ok(events.some((e) => e.kind === 'stream-failed'));
  });

  it('retry catches rejected executeTurn promise and fails stream/turn', async () => {
    const depsWithReject: ConversationRouteDeps = {
      ...deps,
      executeTurn() {
        return Promise.reject(new Error('Timeout'));
      },
    };
    const conv = depsWithReject.store.createConversation();
    const turn = depsWithReject.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Retry me',
      attribution: operatorAttribution,
    });
    depsWithReject.store.finalizeTurn(turn.id, 'failed', 'Error');

    const req = createMockReq('POST', `/conversations/${conv.id}/turns/${turn.id}/retry`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, depsWithReject);
    assert.equal(res.statusCode, 201);

    const body = res.body as Record<string, unknown>;
    const newTurn = body['turn'] as Record<string, unknown>;
    const newTurnId = newTurn['id'] as string;

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });

    const finalTurn = deps.store.getTurn(newTurnId);
    assert.equal(finalTurn?.status, 'failed');

    const events = deps.streamManager.getStreamEvents(newTurnId);
    assert.ok(events.some((e) => e.kind === 'stream-failed'));
  });
});

// ── Blocker: Invalid filter/pagination on list endpoints ─────────────────────

describe('Conversation routes — list validation', () => {
  it('GET /conversations rejects invalid status', () => {
    deps.store.createConversation();
    const req = createMockReq('GET', '/conversations?status=bogus');
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 400);
    const body = res.body as Record<string, unknown>;
    assert.ok((body['error'] as string).includes('Invalid status'));
  });

  it('GET /conversations rejects non-numeric limit', () => {
    deps.store.createConversation();
    const req = createMockReq('GET', '/conversations?limit=abc');
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 400);
    const body = res.body as Record<string, unknown>;
    assert.ok((body['error'] as string).includes('Invalid limit'));
  });

  it('GET /conversations rejects negative limit', () => {
    const req = createMockReq('GET', '/conversations?limit=-5');
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 400);
  });

  it('GET /conversations rejects limit over 100', () => {
    const req = createMockReq('GET', '/conversations?limit=200');
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 400);
  });

  it('GET /conversations rejects fractional limit', () => {
    const req = createMockReq('GET', '/conversations?limit=2.5');
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 400);
  });

  it('GET /conversations accepts valid status=active', () => {
    deps.store.createConversation();
    const req = createMockReq('GET', '/conversations?status=active');
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);
  });

  it('GET /conversations accepts valid status=archived', () => {
    const conv = deps.store.createConversation();
    deps.store.archiveConversation(conv.id);
    const req = createMockReq('GET', '/conversations?status=archived');
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);
    const body = res.body as Record<string, unknown>;
    assert.equal((body['conversations'] as unknown[]).length, 1);
  });

  it('GET /conversations/:id/artifacts rejects non-numeric limit', () => {
    const conv = deps.store.createConversation();
    const req = createMockReq('GET', `/conversations/${conv.id}/artifacts?limit=xyz`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 400);
    const body = res.body as Record<string, unknown>;
    assert.ok((body['error'] as string).includes('Invalid limit'));
  });

  it('GET /conversations/:id/artifacts rejects negative limit', () => {
    const conv = deps.store.createConversation();
    const req = createMockReq('GET', `/conversations/${conv.id}/artifacts?limit=-1`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 400);
  });

  it('GET /conversations/:id/artifacts rejects limit over 100', () => {
    const conv = deps.store.createConversation();
    const req = createMockReq('GET', `/conversations/${conv.id}/artifacts?limit=999`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 400);
  });

  it('GET /conversations/:id/artifacts rejects fractional limit', () => {
    const conv = deps.store.createConversation();
    const req = createMockReq('GET', `/conversations/${conv.id}/artifacts?limit=3.7`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 400);
  });
});

// ── Blocker fix: turn-history and stream query validation ────────────────────

describe('Conversation routes — turn-history query validation', () => {
  it('GET /conversations/:id/turns rejects non-numeric from', () => {
    const conv = deps.store.createConversation();
    const req = createMockReq('GET', `/conversations/${conv.id}/turns?from=abc`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 400);
    const body = res.body as Record<string, unknown>;
    assert.ok((body['error'] as string).includes('Invalid from'));
  });

  it('GET /conversations/:id/turns rejects negative from', () => {
    const conv = deps.store.createConversation();
    const req = createMockReq('GET', `/conversations/${conv.id}/turns?from=-1`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 400);
  });

  it('GET /conversations/:id/turns rejects fractional from', () => {
    const conv = deps.store.createConversation();
    const req = createMockReq('GET', `/conversations/${conv.id}/turns?from=1.5`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 400);
  });

  it('GET /conversations/:id/turns rejects non-numeric to', () => {
    const conv = deps.store.createConversation();
    const req = createMockReq('GET', `/conversations/${conv.id}/turns?from=1&to=xyz`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 400);
    const body = res.body as Record<string, unknown>;
    assert.ok((body['error'] as string).includes('Invalid to'));
  });

  it('GET /conversations/:id/turns rejects negative to', () => {
    const conv = deps.store.createConversation();
    const req = createMockReq('GET', `/conversations/${conv.id}/turns?from=1&to=-5`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 400);
  });

  it('GET /conversations/:id/turns rejects non-numeric limit', () => {
    const conv = deps.store.createConversation();
    const req = createMockReq('GET', `/conversations/${conv.id}/turns?limit=xyz`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 400);
    const body = res.body as Record<string, unknown>;
    assert.ok((body['error'] as string).includes('Invalid limit'));
  });

  it('GET /conversations/:id/turns rejects negative limit', () => {
    const conv = deps.store.createConversation();
    const req = createMockReq('GET', `/conversations/${conv.id}/turns?limit=-1`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 400);
  });

  it('GET /conversations/:id/turns rejects limit over 100', () => {
    const conv = deps.store.createConversation();
    const req = createMockReq('GET', `/conversations/${conv.id}/turns?limit=999`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 400);
  });

  it('GET /conversations/:id/turns rejects fractional limit', () => {
    const conv = deps.store.createConversation();
    const req = createMockReq('GET', `/conversations/${conv.id}/turns?limit=2.5`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 400);
  });

  it('GET /conversations/:id/turns accepts valid from/to range', () => {
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
    const req = createMockReq('GET', `/conversations/${conv.id}/turns?from=1&to=2`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);
    assert.equal(((res.body as Record<string, unknown>)['turns'] as unknown[]).length, 2);
  });

  it('GET /conversations/:id/turns accepts valid limit', () => {
    const conv = deps.store.createConversation();
    deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    const req = createMockReq('GET', `/conversations/${conv.id}/turns?limit=10`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);
  });
});

describe('Conversation routes — stream query validation', () => {
  it('GET .../stream rejects non-numeric since', () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    deps.streamManager.createStream(turn.id);

    const req = createMockReq('GET', `/conversations/${conv.id}/turns/${turn.id}/stream?since=abc`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 400);
    const body = res.body as Record<string, unknown>;
    assert.ok((body['error'] as string).includes('Invalid since'));
  });

  it('GET .../stream rejects negative since', () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    deps.streamManager.createStream(turn.id);

    const req = createMockReq('GET', `/conversations/${conv.id}/turns/${turn.id}/stream?since=-5`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 400);
  });

  it('GET .../stream rejects fractional since', () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    deps.streamManager.createStream(turn.id);

    const req = createMockReq('GET', `/conversations/${conv.id}/turns/${turn.id}/stream?since=1.7`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 400);
  });

  it('GET .../stream accepts valid since=0', () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    deps.streamManager.createStream(turn.id);

    const req = createMockReq('GET', `/conversations/${conv.id}/turns/${turn.id}/stream?since=0`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);
  });
});

// ── Blocker fix: approval-response stream event and execution resumption ─────

describe('Conversation routes — approval response stream notification', () => {
  it('POST /approvals/:id/respond emits approval-response stream event', async () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Deploy',
      attribution: operatorAttribution,
    });
    deps.store.updateTurnStatus(turn.id, 'executing');
    deps.streamManager.createStream(turn.id);

    const approval = deps.store.createApprovalRequest(turn.id, {
      prompt: 'Deploy to prod?',
      context: {},
      contextHash: 'hash-1',
      responseOptions: [
        { key: 'approve', label: 'Approve' },
        { key: 'reject', label: 'Reject' },
      ],
    });
    deps.streamManager.emitEvent(turn.id, 'approval-prompt', {
      approvalId: approval.id,
    });

    const req = createMockReq('POST', `/approvals/${approval.id}/respond`, {
      response: 'approve',
      sessionId: 'sess-1',
    });
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    await waitForResponse(res);

    assert.equal(res.statusCode, 200);
    assert.equal((res.body as Record<string, unknown>)['success'], true);

    // Verify approval-response event was emitted into the turn stream
    const events = deps.streamManager.getStreamEvents(turn.id);
    const approvalResponseEvents = events.filter((e) => e.kind === 'approval-response');
    assert.equal(approvalResponseEvents.length, 1, 'should emit exactly one approval-response');
    assert.equal(approvalResponseEvents[0].payload['approvalId'], approval.id);
    assert.equal(approvalResponseEvents[0].payload['response'], 'approve');
  });

  it('POST /approvals/:id/respond invokes continueAfterApproval to resume paused work', async () => {
    let capturedTurnId = '';
    let capturedApprovalId = '';
    let capturedResponse = '';
    let capturedOriginalInstruction = '';
    deps.continueAfterApproval = (
      turnId: string,
      approvalId: string,
      response: string,
      originalInstruction: string,
    ) => {
      capturedTurnId = turnId;
      capturedApprovalId = approvalId;
      capturedResponse = response;
      capturedOriginalInstruction = originalInstruction;
    };

    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Deploy to production',
      attribution: operatorAttribution,
    });
    deps.store.updateTurnStatus(turn.id, 'executing');
    deps.streamManager.createStream(turn.id);

    const approval = deps.store.createApprovalRequest(turn.id, {
      prompt: 'Deploy to prod?',
      context: {},
      contextHash: 'hash-1',
      responseOptions: [{ key: 'approve', label: 'Approve' }],
    });

    const req = createMockReq('POST', `/approvals/${approval.id}/respond`, {
      response: 'approve',
      sessionId: 'sess-1',
    });
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    await waitForResponse(res);

    assert.equal(res.statusCode, 200);
    assert.equal(capturedTurnId, turn.id, 'should receive the paused turn id');
    assert.equal(capturedApprovalId, approval.id, 'should receive the approval id');
    assert.equal(capturedResponse, 'approve', 'should receive the approval response');
    assert.equal(
      capturedOriginalInstruction,
      'Deploy to production',
      'should receive the original turn instruction for continuation',
    );
  });

  it('POST /approvals/:id/respond does NOT invoke executeTurn (separation of concerns)', async () => {
    let executeTurnCalled = false;
    deps.executeTurn = () => {
      executeTurnCalled = true;
    };

    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Deploy',
      attribution: operatorAttribution,
    });
    deps.store.updateTurnStatus(turn.id, 'executing');
    deps.streamManager.createStream(turn.id);

    const approval = deps.store.createApprovalRequest(turn.id, {
      prompt: 'Deploy?',
      context: {},
      contextHash: 'hash-1',
      responseOptions: [{ key: 'approve', label: 'Approve' }],
    });

    const req = createMockReq('POST', `/approvals/${approval.id}/respond`, {
      response: 'approve',
      sessionId: 'sess-1',
    });
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    await waitForResponse(res);

    assert.equal(res.statusCode, 200);
    assert.equal(
      executeTurnCalled,
      false,
      'executeTurn must not be called for approval responses — only continueAfterApproval',
    );
  });

  it('POST /approvals/:id/respond does not emit event on conflict', async () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Deploy',
      attribution: operatorAttribution,
    });
    deps.store.updateTurnStatus(turn.id, 'executing');
    deps.streamManager.createStream(turn.id);

    const approval = deps.store.createApprovalRequest(turn.id, {
      prompt: 'Deploy?',
      context: {},
      contextHash: 'hash-1',
      responseOptions: [{ key: 'ok', label: 'OK' }],
    });

    // First response succeeds
    deps.store.respondToApproval(approval.id, 'ok', 'sess-1');

    const eventsBefore = deps.streamManager.getStreamEvents(turn.id);

    // Second response via route — should conflict (409), no new stream event
    const req = createMockReq('POST', `/approvals/${approval.id}/respond`, {
      response: 'ok',
      sessionId: 'sess-2',
    });
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    await waitForResponse(res);

    assert.equal(res.statusCode, 409);
    const eventsAfter = deps.streamManager.getStreamEvents(turn.id);
    assert.equal(eventsAfter.length, eventsBefore.length, 'no new stream events on conflict');
  });

  it('POST /approvals/:id/respond handles async continueAfterApproval failure gracefully', async () => {
    deps.continueAfterApproval = () => Promise.reject(new Error('executor crashed'));

    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Deploy',
      attribution: operatorAttribution,
    });
    deps.store.updateTurnStatus(turn.id, 'executing');
    deps.streamManager.createStream(turn.id);

    const approval = deps.store.createApprovalRequest(turn.id, {
      prompt: 'Deploy?',
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

    assert.equal(res.statusCode, 200, 'route responds 200 before async executor fails');

    // Give async rejection time to be caught
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });

    // Stream should be failed by the rejection handler
    const events = deps.streamManager.getStreamEvents(turn.id);
    const failEvents = events.filter((e) => e.kind === 'stream-failed');
    assert.equal(failEvents.length, 1, 'stream should be failed after executor rejection');
  });

  it('POST /approvals/:id/respond handles sync continueAfterApproval throw gracefully', async () => {
    deps.continueAfterApproval = () => {
      throw new Error('sync crash');
    };

    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Deploy',
      attribution: operatorAttribution,
    });
    deps.store.updateTurnStatus(turn.id, 'executing');
    deps.streamManager.createStream(turn.id);

    const approval = deps.store.createApprovalRequest(turn.id, {
      prompt: 'Deploy?',
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

    assert.equal(res.statusCode, 200, 'route still responds 200 when sync throw occurs');
    const events = deps.streamManager.getStreamEvents(turn.id);
    const failEvents = events.filter((e) => e.kind === 'stream-failed');
    assert.equal(failEvents.length, 1, 'stream should be failed after sync throw');
  });
});
