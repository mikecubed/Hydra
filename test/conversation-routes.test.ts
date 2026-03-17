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
import { computeApprovalContextHash } from '../lib/daemon/conversation-executor.ts';

const operatorAttribution = { type: 'operator' as const, label: 'Admin' };

/**
 * Compute a context hash the same way the executor + route do — over a full
 * approval context record.  Test callers pass a minimal context for brevity.
 */
function contextHash(context: Record<string, unknown>): string {
  return computeApprovalContextHash(context);
}

// ── Mock helpers ─────────────────────────────────────────────────────────────

function createMockReq(
  method: string,
  url: string,
  body?: Record<string, unknown>,
  headers?: Record<string, string>,
): IncomingMessage {
  const readable = body ? Readable.from([Buffer.from(JSON.stringify(body))]) : Readable.from([]);

  const req = Object.assign(readable, {
    method,
    url,
    headers: { host: 'localhost:4173', ...headers },
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

  it('GET /conversations/:id/turns/:turnId/stream returns 410 when terminal stream history was purged and client is not caught up', () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    deps.store.updateTurnStatus(turn.id, 'executing');
    deps.streamManager.createStream(turn.id);
    deps.streamManager.completeStream(turn.id);
    deps.streamManager.purgeTerminalStreams(0);

    const req = createMockReq('GET', `/conversations/${conv.id}/turns/${turn.id}/stream?since=0`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);

    assert.equal(res.statusCode, 410);
    const body = res.body as Record<string, unknown>;
    assert.equal(body['error'], 'Stream history expired for turn');
  });

  it('GET /conversations/:id/turns/:turnId/stream returns 200 empty when terminal turn has no stream and no purge tombstone', () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    // Manually finalize the turn so it's in a terminal state without ever
    // having created a stream (simulates a turn that completed outside the
    // stream lifecycle, or whose tombstone has already been evicted).
    deps.store.finalizeTurn(turn.id, 'completed', 'done');

    const req = createMockReq('GET', `/conversations/${conv.id}/turns/${turn.id}/stream?since=0`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);

    assert.equal(res.statusCode, 200);
    const body = res.body as Record<string, unknown>;
    assert.deepEqual(body['events'], []);
  });

  it('GET /conversations/:id/turns/:turnId/stream returns empty when the purged terminal stream was fully acknowledged', () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    deps.store.updateTurnStatus(turn.id, 'executing');
    deps.streamManager.createStream(turn.id);
    deps.streamManager.emitEvent(turn.id, 'text-delta', { text: 'chunk' });
    deps.streamManager.completeStream(turn.id);

    const highSeq = deps.streamManager.getStreamEvents(turn.id).at(-1)?.seq ?? 0;
    deps.streamManager.purgeTerminalStreams(0);

    const req = createMockReq(
      'GET',
      `/conversations/${conv.id}/turns/${turn.id}/stream?lastAcknowledgedSeq=${String(highSeq)}`,
    );
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);

    assert.equal(res.statusCode, 200);
    const body = res.body as Record<string, unknown>;
    assert.deepEqual(body['events'], []);
  });

  it('GET /conversations/:id/turns/:turnId/stream still returns 410 after purge tombstone eviction for streamed terminal turns', () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    deps.store.updateTurnStatus(turn.id, 'executing');
    deps.streamManager.createStream(turn.id);
    deps.streamManager.completeStream(turn.id);
    deps.streamManager.purgeTerminalStreams(0);
    deps.streamManager.clearTombstones();

    const req = createMockReq('GET', `/conversations/${conv.id}/turns/${turn.id}/stream?since=0`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);

    assert.equal(res.statusCode, 410);
    assert.equal((res.body as Record<string, unknown>)['error'], 'Stream history expired for turn');
  });

  it('GET /conversations/:id/turns/:turnId/stream returns empty after tombstone eviction when streamed terminal turn is fully acknowledged', () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    deps.store.updateTurnStatus(turn.id, 'executing');
    deps.streamManager.createStream(turn.id);
    deps.streamManager.emitEvent(turn.id, 'text-delta', { text: 'chunk' });
    deps.streamManager.completeStream(turn.id);
    const allEvents = deps.streamManager.getStreamEvents(turn.id);
    const finalSeq = allEvents.at(-1)?.seq;
    assert.notEqual(finalSeq, undefined);
    deps.streamManager.purgeTerminalStreams(0);
    deps.streamManager.clearTombstones();

    const req = createMockReq(
      'GET',
      `/conversations/${conv.id}/turns/${turn.id}/stream?since=${String(finalSeq)}`,
    );
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);

    assert.equal(res.statusCode, 200);
    assert.deepEqual((res.body as Record<string, unknown>)['events'], []);
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
      contextHash: contextHash({ instruction: 'A' }),
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
      contextHash: contextHash({ instruction: 'A' }),
      responseOptions: [{ key: 'ok', label: 'OK' }],
    });

    const req = createMockReq(
      'POST',
      `/approvals/${approval.id}/respond`,
      {
        response: 'ok',
      },
      { 'x-session-id': 'sess-1' },
    );
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

describe('Conversation routes — fork approval isolation via routes', () => {
  it('GET approvals on forked conversation does NOT return inherited parent approvals', () => {
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
      contextHash: contextHash({ instruction: 'A' }),
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
      0,
      'fork route must NOT show inherited parent approvals',
    );
  });

  it('GET approvals on parent still returns its own approvals after fork', () => {
    const parent = deps.store.createConversation();
    const t1 = deps.store.appendTurn(parent.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    deps.store.createApprovalRequest(t1.id, {
      prompt: 'Parent approval?',
      context: {},
      contextHash: contextHash({ instruction: 'A' }),
      responseOptions: [{ key: 'ok', label: 'OK' }],
    });

    deps.store.forkConversation(parent.id, t1.id);

    const req = createMockReq('GET', `/conversations/${parent.id}/approvals`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);
    const body = res.body as Record<string, unknown>;
    assert.equal(
      (body['approvals'] as unknown[]).length,
      1,
      'parent should still see its own approvals',
    );
  });

  it('GET approvals on fork returns only fork-owned approvals', () => {
    const parent = deps.store.createConversation();
    const t1 = deps.store.appendTurn(parent.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    deps.store.createApprovalRequest(t1.id, {
      prompt: 'Parent approval?',
      context: {},
      contextHash: contextHash({ instruction: 'A' }),
      responseOptions: [{ key: 'ok', label: 'OK' }],
    });

    const fork = deps.store.forkConversation(parent.id, t1.id);
    const forkTurn = deps.store.appendTurn(fork.id, {
      kind: 'operator',
      instruction: 'Fork work',
      attribution: operatorAttribution,
    });
    deps.store.createApprovalRequest(forkTurn.id, {
      prompt: 'Fork approval?',
      context: {},
      contextHash: contextHash({ instruction: 'Fork work' }),
      responseOptions: [{ key: 'ok', label: 'OK' }],
    });

    const req = createMockReq('GET', `/conversations/${fork.id}/approvals`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);
    const body = res.body as Record<string, unknown>;
    const approvals = body['approvals'] as Array<Record<string, unknown>>;
    assert.equal(approvals.length, 1, 'fork should only see its own approvals');
    assert.equal(approvals[0]['prompt'], 'Fork approval?');
  });
});

describe('Conversation routes — fork artifact inheritance via routes', () => {
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
    assert.ok((body['error'] as string).includes('Invalid lastAcknowledgedSeq'));
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
      contextHash: contextHash({ instruction: 'Deploy' }),
      responseOptions: [
        { key: 'approve', label: 'Approve' },
        { key: 'reject', label: 'Reject' },
      ],
    });
    deps.streamManager.emitEvent(turn.id, 'approval-prompt', {
      approvalId: approval.id,
    });

    const req = createMockReq(
      'POST',
      `/approvals/${approval.id}/respond`,
      {
        response: 'approve',
      },
      { 'x-session-id': 'sess-1' },
    );
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
      contextHash: contextHash({ instruction: 'Deploy to production' }),
      responseOptions: [{ key: 'approve', label: 'Approve' }],
    });

    const req = createMockReq(
      'POST',
      `/approvals/${approval.id}/respond`,
      {
        response: 'approve',
      },
      { 'x-session-id': 'sess-1' },
    );
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
      contextHash: contextHash({ instruction: 'Deploy' }),
      responseOptions: [{ key: 'approve', label: 'Approve' }],
    });

    const req = createMockReq(
      'POST',
      `/approvals/${approval.id}/respond`,
      {
        response: 'approve',
      },
      { 'x-session-id': 'sess-1' },
    );
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
      contextHash: contextHash({ instruction: 'Deploy' }),
      responseOptions: [{ key: 'ok', label: 'OK' }],
    });

    // First response succeeds
    deps.store.respondToApproval(approval.id, 'ok', 'sess-1');

    const eventsBefore = deps.streamManager.getStreamEvents(turn.id);

    // Second response via route — should conflict (409), no new stream event
    const req = createMockReq(
      'POST',
      `/approvals/${approval.id}/respond`,
      {
        response: 'ok',
      },
      { 'x-session-id': 'sess-2' },
    );
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
      contextHash: contextHash({ instruction: 'Deploy' }),
      responseOptions: [{ key: 'ok', label: 'OK' }],
    });

    const req = createMockReq(
      'POST',
      `/approvals/${approval.id}/respond`,
      {
        response: 'ok',
      },
      { 'x-session-id': 'sess-1' },
    );
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
      contextHash: contextHash({ instruction: 'Deploy' }),
      responseOptions: [{ key: 'ok', label: 'OK' }],
    });

    const req = createMockReq(
      'POST',
      `/approvals/${approval.id}/respond`,
      {
        response: 'ok',
      },
      { 'x-session-id': 'sess-1' },
    );
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    await waitForResponse(res);

    assert.equal(res.statusCode, 200, 'route still responds 200 when sync throw occurs');
    const events = deps.streamManager.getStreamEvents(turn.id);
    const failEvents = events.filter((e) => e.kind === 'stream-failed');
    assert.equal(failEvents.length, 1, 'stream should be failed after sync throw');
  });
});

// ── Blocker fix: reject approvals on cancelled/terminal turns ────────────────

describe('Conversation routes — approval rejection on terminal turns', () => {
  it('POST /approvals/:id/respond returns failure when owning turn is cancelled', async () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Deploy',
      attribution: operatorAttribution,
    });
    deps.store.updateTurnStatus(turn.id, 'executing');
    deps.streamManager.createStream(turn.id);

    const approval = deps.store.createApprovalRequest(turn.id, {
      prompt: 'Continue?',
      context: {},
      contextHash: contextHash({ instruction: 'Deploy' }),
      responseOptions: [{ key: 'yes', label: 'Yes' }],
    });

    // Cancel the turn — this should expire the pending approval
    deps.streamManager.cancelStream(turn.id);

    const req = createMockReq(
      'POST',
      `/approvals/${approval.id}/respond`,
      {
        response: 'yes',
      },
      { 'x-session-id': 'sess-1' },
    );
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    await waitForResponse(res);

    assert.equal(res.statusCode, 409, 'should reject approval on cancelled turn');
    assert.equal((res.body as Record<string, unknown>)['success'], false);
  });

  it('POST /approvals/:id/respond returns failure when owning turn is completed', async () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Do work',
      attribution: operatorAttribution,
    });
    deps.store.updateTurnStatus(turn.id, 'executing');
    deps.streamManager.createStream(turn.id);

    const approval = deps.store.createApprovalRequest(turn.id, {
      prompt: 'OK?',
      context: {},
      contextHash: contextHash({ instruction: 'Do work' }),
      responseOptions: [{ key: 'ok', label: 'OK' }],
    });

    // Complete the turn — should expire approvals
    deps.streamManager.completeStream(turn.id);

    const req = createMockReq(
      'POST',
      `/approvals/${approval.id}/respond`,
      {
        response: 'ok',
      },
      { 'x-session-id': 'sess-1' },
    );
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    await waitForResponse(res);

    assert.equal(res.statusCode, 409, 'should reject approval on completed turn');
    assert.equal((res.body as Record<string, unknown>)['success'], false);
  });

  it('POST /approvals/:id/respond returns failure when owning turn is failed', async () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Do work',
      attribution: operatorAttribution,
    });
    deps.store.updateTurnStatus(turn.id, 'executing');
    deps.streamManager.createStream(turn.id);

    const approval = deps.store.createApprovalRequest(turn.id, {
      prompt: 'OK?',
      context: {},
      contextHash: contextHash({ instruction: 'Do work' }),
      responseOptions: [{ key: 'ok', label: 'OK' }],
    });

    // Fail the turn — should expire approvals
    deps.streamManager.failStream(turn.id, 'boom');

    const req = createMockReq(
      'POST',
      `/approvals/${approval.id}/respond`,
      {
        response: 'ok',
      },
      { 'x-session-id': 'sess-1' },
    );
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    await waitForResponse(res);

    assert.equal(res.statusCode, 409, 'should reject approval on failed turn');
    assert.equal((res.body as Record<string, unknown>)['success'], false);
  });

  it('does not invoke continueAfterApproval when turn is cancelled', async () => {
    let continueCalled = false;
    deps.continueAfterApproval = () => {
      continueCalled = true;
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
      prompt: 'Continue?',
      context: {},
      contextHash: contextHash({ instruction: 'Deploy' }),
      responseOptions: [{ key: 'yes', label: 'Yes' }],
    });

    deps.streamManager.cancelStream(turn.id);

    const req = createMockReq(
      'POST',
      `/approvals/${approval.id}/respond`,
      {
        response: 'yes',
      },
      { 'x-session-id': 'sess-1' },
    );
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    await waitForResponse(res);

    assert.equal(
      continueCalled,
      false,
      'continueAfterApproval must not be called on cancelled turn',
    );
  });

  it('cancellation expires pending approvals so getPendingApprovals returns empty', () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Deploy',
      attribution: operatorAttribution,
    });
    deps.store.updateTurnStatus(turn.id, 'executing');
    deps.streamManager.createStream(turn.id);

    deps.store.createApprovalRequest(turn.id, {
      prompt: 'Continue?',
      context: {},
      contextHash: contextHash({ instruction: 'Deploy' }),
      responseOptions: [{ key: 'yes', label: 'Yes' }],
    });

    assert.equal(deps.store.getPendingApprovals(conv.id).length, 1, 'should have 1 pending');

    deps.streamManager.cancelStream(turn.id);

    assert.equal(
      deps.store.getPendingApprovals(conv.id).length,
      0,
      'should have 0 pending after cancel',
    );
  });
});

// ── Blocker fix: approval response validation and context-hash staleness ─────

describe('Conversation routes — approval response validation', () => {
  it('POST /approvals/:id/respond returns 400 for invalid response option', async () => {
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
      contextHash: contextHash({ instruction: 'Deploy' }),
      responseOptions: [
        { key: 'approve', label: 'Approve' },
        { key: 'reject', label: 'Reject' },
      ],
    });

    const req = createMockReq(
      'POST',
      `/approvals/${approval.id}/respond`,
      {
        response: 'maybe',
      },
      { 'x-session-id': 'sess-1' },
    );
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    await waitForResponse(res);

    assert.equal(res.statusCode, 400, 'invalid response option should return 400');
    assert.equal((res.body as Record<string, unknown>)['success'], false);
    assert.equal((res.body as Record<string, unknown>)['reason'], 'invalid_response');
  });

  it('POST /approvals/:id/respond accepts declared response option', async () => {
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
      contextHash: contextHash({ instruction: 'Deploy' }),
      responseOptions: [
        { key: 'approve', label: 'Approve' },
        { key: 'reject', label: 'Reject' },
      ],
    });

    const req = createMockReq(
      'POST',
      `/approvals/${approval.id}/respond`,
      {
        response: 'approve',
      },
      { 'x-session-id': 'sess-1' },
    );
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    await waitForResponse(res);

    assert.equal(res.statusCode, 200);
    assert.equal((res.body as Record<string, unknown>)['success'], true);
  });

  it('POST /approvals/:id/respond rejects with 401 when X-Session-Id header is missing', async () => {
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
      contextHash: contextHash({ instruction: 'Deploy' }),
      responseOptions: [{ key: 'approve', label: 'Approve' }],
    });

    const req = createMockReq('POST', `/approvals/${approval.id}/respond`, {
      response: 'approve',
    });
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    await waitForResponse(res);

    assert.equal(res.statusCode, 401, 'missing header should be rejected');
  });

  it('POST /approvals/:id/respond rejects with 401 when X-Session-Id header is empty', async () => {
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
      contextHash: contextHash({ instruction: 'Deploy' }),
      responseOptions: [{ key: 'approve', label: 'Approve' }],
    });

    const req = createMockReq(
      'POST',
      `/approvals/${approval.id}/respond`,
      {
        response: 'approve',
      },
      { 'x-session-id': '' },
    );
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    await waitForResponse(res);

    assert.equal(res.statusCode, 401, 'empty header should be rejected');
  });

  it('POST /approvals/:id/respond uses X-Session-Id header for attribution', async () => {
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
      contextHash: contextHash({ instruction: 'Deploy' }),
      responseOptions: [{ key: 'approve', label: 'Approve' }],
    });

    const req = createMockReq(
      'POST',
      `/approvals/${approval.id}/respond`,
      {
        response: 'approve',
      },
      { 'x-session-id': 'gateway-session-42' },
    );
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    await waitForResponse(res);

    assert.equal(res.statusCode, 200);
    const updated = deps.store.getApproval(approval.id);
    assert.deepStrictEqual(updated?.respondedBy, { type: 'operator', label: 'gateway-session-42' });
  });
});

describe('Conversation routes — context-hash staleness detection', () => {
  it('GET /conversations/:id/approvals detects stale when turn instruction changes', () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'deploy to production',
      attribution: operatorAttribution,
    });

    // Approval created with original context matching the instruction
    const originalContext = { instruction: 'deploy to production', env: 'prod' };
    const approval = deps.store.createApprovalRequest(turn.id, {
      prompt: 'Approve?',
      context: originalContext,
      contextHash: contextHash(originalContext),
      responseOptions: [{ key: 'ok', label: 'OK' }],
    });

    assert.equal(approval.status, 'pending');

    // Simulate context drift: mutate the turn instruction to a new value.
    // In production this would happen via a retry creating a new turn, but
    // we mutate directly to prove the staleness mechanism works.
    (turn as { instruction: string }).instruction = 'deploy to staging';

    const req = createMockReq('GET', `/conversations/${conv.id}/approvals`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);

    const approvals = (res.body as Record<string, unknown>)['approvals'] as Array<
      Record<string, unknown>
    >;
    assert.equal(approvals.length, 1);
    assert.equal(
      approvals[0]['status'],
      'stale',
      'instruction change should auto-mark approval stale',
    );
  });

  it('GET /conversations/:id/approvals keeps pending when context is unchanged', () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'some instruction',
      attribution: operatorAttribution,
    });

    const approvalContext = { instruction: 'some instruction' };
    const correctHash = contextHash(approvalContext);

    deps.store.createApprovalRequest(turn.id, {
      prompt: 'Approve?',
      context: approvalContext,
      contextHash: correctHash,
      responseOptions: [{ key: 'ok', label: 'OK' }],
    });

    const req = createMockReq('GET', `/conversations/${conv.id}/approvals`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);

    const approvals = (res.body as Record<string, unknown>)['approvals'] as Array<
      Record<string, unknown>
    >;
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]['status'], 'pending', 'unchanged context should stay pending');
  });

  it('POST /approvals/:id/respond auto-detects staleness from real context drift', async () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'deploy to production',
      attribution: operatorAttribution,
    });
    deps.store.updateTurnStatus(turn.id, 'executing');
    deps.streamManager.createStream(turn.id);

    const originalContext = { instruction: 'deploy to production' };
    const approval = deps.store.createApprovalRequest(turn.id, {
      prompt: 'Deploy?',
      context: originalContext,
      contextHash: contextHash(originalContext),
      responseOptions: [{ key: 'approve', label: 'Approve' }],
    });

    // Mutate the turn instruction to simulate context drift
    (turn as { instruction: string }).instruction = 'deploy to staging';

    const req = createMockReq(
      'POST',
      `/approvals/${approval.id}/respond`,
      {
        response: 'approve',
      },
      { 'x-session-id': 'sess-1' },
    );
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    await waitForResponse(res);

    assert.equal(res.statusCode, 409, 'drifted context should return 409');
    assert.equal((res.body as Record<string, unknown>)['success'], false);
    assert.equal((res.body as Record<string, unknown>)['reason'], 'stale');
  });

  it('POST /approvals/:id/respond succeeds with acknowledgeStaleness on drifted context', async () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'deploy to production',
      attribution: operatorAttribution,
    });
    deps.store.updateTurnStatus(turn.id, 'executing');
    deps.streamManager.createStream(turn.id);

    const originalContext = { instruction: 'deploy to production' };
    const approval = deps.store.createApprovalRequest(turn.id, {
      prompt: 'Deploy?',
      context: originalContext,
      contextHash: contextHash(originalContext),
      responseOptions: [{ key: 'approve', label: 'Approve' }],
    });

    // Mutate instruction to create staleness
    (turn as { instruction: string }).instruction = 'deploy to staging';

    const req = createMockReq(
      'POST',
      `/approvals/${approval.id}/respond`,
      {
        response: 'approve',
        acknowledgeStaleness: true,
      },
      { 'x-session-id': 'sess-1' },
    );
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    await waitForResponse(res);

    assert.equal(res.statusCode, 200, 'should succeed with acknowledgeStaleness');
    assert.equal((res.body as Record<string, unknown>)['success'], true);
  });

  it('shared hash function produces identical hashes for identical contexts', () => {
    const ctx = { instruction: 'test', taskType: 'analysis', agent: 'gemini' };
    const hash1 = contextHash(ctx);
    const hash2 = contextHash(ctx);
    assert.equal(hash1, hash2, 'same context must produce same hash');
    assert.equal(hash1.length, 16, 'hash should be truncated to 16 hex chars');
  });

  it('shared hash is key-order independent', () => {
    const ctx1 = { instruction: 'test', agent: 'codex' };
    const ctx2 = { agent: 'codex', instruction: 'test' };
    assert.equal(contextHash(ctx1), contextHash(ctx2), 'key insertion order must not affect hash');
  });

  it('nested object field changes produce different hashes', () => {
    const ctx1 = { instruction: 'deploy', meta: { env: 'staging', region: 'us-east-1' } };
    const ctx2 = { instruction: 'deploy', meta: { env: 'production', region: 'us-east-1' } };
    assert.notEqual(
      contextHash(ctx1),
      contextHash(ctx2),
      'different nested values must produce different hashes',
    );
  });

  it('deeply nested key-order differences do not affect hash', () => {
    const ctx1 = { a: { z: 1, y: 2 }, b: 'ok' };
    const ctx2 = { b: 'ok', a: { y: 2, z: 1 } };
    assert.equal(
      contextHash(ctx1),
      contextHash(ctx2),
      'key order at any depth must not affect hash',
    );
  });

  it('added nested key produces a different hash', () => {
    const ctx1 = { instruction: 'run', opts: { verbose: true } };
    const ctx2 = { instruction: 'run', opts: { verbose: true, dryRun: false } };
    assert.notEqual(
      contextHash(ctx1),
      contextHash(ctx2),
      'additional nested key must change the hash',
    );
  });

  it('array element order matters for hash', () => {
    const ctx1 = { tags: ['a', 'b', 'c'] };
    const ctx2 = { tags: ['c', 'b', 'a'] };
    assert.notEqual(
      contextHash(ctx1),
      contextHash(ctx2),
      'array order should affect hash (positional semantics)',
    );
  });

  it('handles null and undefined nested values deterministically', () => {
    const ctx1 = { a: null, b: { c: undefined } };
    const hash1 = contextHash(ctx1);
    const hash2 = contextHash(ctx1);
    assert.equal(hash1, hash2, 'null/undefined values must hash deterministically');
    assert.equal(hash1.length, 16);
  });
});

// ── Blocker fix: contract-compliant query parameter names ────────────────────

describe('Conversation routes — contract parameter names', () => {
  it('GET .../stream accepts lastAcknowledgedSeq (contract name)', () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    deps.store.updateTurnStatus(turn.id, 'executing');
    deps.streamManager.createStream(turn.id);
    deps.streamManager.emitEvent(turn.id, 'text-delta', { text: 'hello' });
    deps.streamManager.completeStream(turn.id);

    const allEvents = deps.streamManager.getStreamEvents(turn.id);
    const midSeq = allEvents[0].seq;

    const req = createMockReq(
      'GET',
      `/conversations/${conv.id}/turns/${turn.id}/stream?lastAcknowledgedSeq=${String(midSeq)}`,
    );
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);
    const body = res.body as Record<string, unknown>;
    const events = body['events'] as Array<Record<string, unknown>>;
    assert.ok(events.length > 0, 'should return events after midSeq');
    assert.ok(
      events.every((e) => (e['seq'] as number) > midSeq),
      'all events should be after midSeq',
    );
  });

  it('GET .../stream still supports since as alias', () => {
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

  it('GET .../stream prefers lastAcknowledgedSeq over since when both provided', () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    deps.store.updateTurnStatus(turn.id, 'executing');
    deps.streamManager.createStream(turn.id);
    deps.streamManager.emitEvent(turn.id, 'text-delta', { text: 'a' });
    deps.streamManager.emitEvent(turn.id, 'text-delta', { text: 'b' });
    deps.streamManager.completeStream(turn.id);

    const allEvents = deps.streamManager.getStreamEvents(turn.id);
    const highSeq = allEvents.at(-1)!.seq;

    // lastAcknowledgedSeq = highSeq (returns nothing), since = 0 (would return all)
    const req = createMockReq(
      'GET',
      `/conversations/${conv.id}/turns/${turn.id}/stream?lastAcknowledgedSeq=${String(highSeq)}&since=0`,
    );
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);
    const body = res.body as Record<string, unknown>;
    const events = body['events'] as Array<Record<string, unknown>>;
    assert.equal(events.length, 0, 'lastAcknowledgedSeq should take precedence over since');
  });

  it('GET .../turns accepts fromPosition and toPosition (contract names)', () => {
    const conv = deps.store.createConversation();
    for (let i = 1; i <= 5; i++) {
      deps.store.appendTurn(conv.id, {
        kind: 'operator',
        instruction: `Turn ${String(i)}`,
        attribution: operatorAttribution,
      });
    }

    const req = createMockReq('GET', `/conversations/${conv.id}/turns?fromPosition=2&toPosition=4`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);
    const body = res.body as Record<string, unknown>;
    const turns = body['turns'] as Array<Record<string, unknown>>;
    assert.equal(turns.length, 3, 'should return turns at positions 2, 3, 4');
    assert.equal(turns[0]['position'], 2);
    assert.equal(turns[2]['position'], 4);
  });

  it('GET .../turns still supports from and to as aliases', () => {
    const conv = deps.store.createConversation();
    for (let i = 1; i <= 3; i++) {
      deps.store.appendTurn(conv.id, {
        kind: 'operator',
        instruction: `Turn ${String(i)}`,
        attribution: operatorAttribution,
      });
    }

    const req = createMockReq('GET', `/conversations/${conv.id}/turns?from=1&to=2`);
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);
    const body = res.body as Record<string, unknown>;
    const turns = body['turns'] as Array<Record<string, unknown>>;
    assert.equal(turns.length, 2, 'alias from/to should still work');
  });

  it('GET .../turns prefers fromPosition/toPosition over from/to when both provided', () => {
    const conv = deps.store.createConversation();
    for (let i = 1; i <= 5; i++) {
      deps.store.appendTurn(conv.id, {
        kind: 'operator',
        instruction: `Turn ${String(i)}`,
        attribution: operatorAttribution,
      });
    }

    // fromPosition=4&toPosition=5 (returns 2 turns), from=1&to=3 (would return 3 turns)
    const req = createMockReq(
      'GET',
      `/conversations/${conv.id}/turns?fromPosition=4&toPosition=5&from=1&to=3`,
    );
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 200);
    const body = res.body as Record<string, unknown>;
    const turns = body['turns'] as Array<Record<string, unknown>>;
    assert.equal(turns.length, 2, 'fromPosition/toPosition should take precedence');
    assert.equal(turns[0]['position'], 4);
    assert.equal(turns[1]['position'], 5);
  });

  it('GET .../stream rejects invalid lastAcknowledgedSeq', () => {
    const conv = deps.store.createConversation();
    const turn = deps.store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    deps.streamManager.createStream(turn.id);

    const req = createMockReq(
      'GET',
      `/conversations/${conv.id}/turns/${turn.id}/stream?lastAcknowledgedSeq=abc`,
    );
    const res = createMockRes();
    handleConversationRoute(req, res as unknown as ServerResponse, deps);
    assert.equal(res.statusCode, 400);
    const body = res.body as Record<string, unknown>;
    assert.ok((body['error'] as string).includes('lastAcknowledgedSeq'));
  });
});
