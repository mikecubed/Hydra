/**
 * Integration tests for the conversation protocol.
 *
 * Tests end-to-end flows through the ConversationStore, StreamManager,
 * and route handlers working together, covering all success criteria:
 *
 * SC-001: Conversation persistence and turn ordering
 * SC-002: Stream event ordering and completeness
 * SC-003: Approval lifecycle within turns
 * SC-004: Reconnect/resume from last-acknowledged seq
 * SC-005: Cancel mid-stream and accept new instruction
 * SC-006: Fork from turn N with correct lineage
 * SC-007: Artifact persistence across refreshes
 * SC-008: Multi-agent activity attribution
 * SC-009: Multi-session conflict resolution
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationStore } from '../lib/daemon/conversation-store.ts';
import { StreamManager } from '../lib/daemon/stream-manager.ts';

const operatorAttribution = { type: 'operator' as const, label: 'Admin' };
const agentAttr = (id: string) => ({
  type: 'agent' as const,
  agentId: id,
  label: id,
});

let store: ConversationStore;
let streamManager: StreamManager;

beforeEach(() => {
  store = new ConversationStore();
  streamManager = new StreamManager(store);
});

// ── SC-001: Conversation persistence and turn ordering ───────────────────────

describe('SC-001: Conversation persistence and turn ordering', () => {
  it('creates conversation, adds turns, retrieves all in order', () => {
    const conv = store.createConversation({ title: 'Integration test' });

    // Add 5 turns
    for (let i = 1; i <= 5; i++) {
      store.appendTurn(conv.id, {
        kind: 'operator',
        instruction: `Turn ${String(i)}`,
        attribution: operatorAttribution,
      });
    }

    // Retrieve and verify ordering
    const turns = store.getTurns(conv.id);
    assert.equal(turns.length, 5);
    for (const [i, turn] of turns.entries()) {
      assert.equal(turn.position, i + 1);
      assert.equal(turn.instruction, `Turn ${String(i + 1)}`);
    }

    // Verify conversation metadata
    const updated = store.getConversation(conv.id);
    assert.equal(updated?.turnCount, 5);
  });

  it('supports windowed turn retrieval', () => {
    const conv = store.createConversation();
    for (let i = 1; i <= 100; i++) {
      store.appendTurn(conv.id, {
        kind: 'operator',
        instruction: `Turn ${String(i)}`,
        attribution: operatorAttribution,
      });
    }

    const window = store.getTurnsByRange(conv.id, 50, 60);
    assert.equal(window.length, 11);
    assert.equal(window[0].position, 50);
    assert.equal(window[10].position, 60);
  });
});

// ── SC-002: Stream event ordering and completeness ───────────────────────────

describe('SC-002: Streaming events', () => {
  it('streams events in order and finalizes turn', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    store.updateTurnStatus(turn.id, 'executing');

    const streamId = streamManager.createStream(turn.id);
    assert.ok(streamId);

    // Emit several text chunks
    streamManager.emitEvent(turn.id, 'text-delta', { text: 'Hello ' });
    streamManager.emitEvent(turn.id, 'text-delta', { text: 'World' });
    streamManager.emitEvent(turn.id, 'status-change', {
      status: 'processing',
      reason: 'Agent working',
    });
    streamManager.emitEvent(turn.id, 'text-delta', { text: '!' });

    // Complete the stream
    streamManager.completeStream(turn.id);

    // Verify event ordering
    const events = streamManager.getStreamEvents(turn.id);
    assert.equal(events[0].kind, 'stream-started');
    assert.equal(events.at(-1)?.kind, 'stream-completed');

    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i].seq > events[i - 1].seq, 'seq should be strictly increasing');
    }

    // Verify turn finalization
    const finalTurn = store.getTurn(turn.id);
    assert.equal(finalTurn?.response, 'Hello World!');
    assert.equal(finalTurn?.status, 'completed');
    assert.ok(finalTurn?.completedAt);
  });
});

// ── SC-003: Approval lifecycle within turns ──────────────────────────────────

describe('SC-003: Approval lifecycle', () => {
  it('approval prompt → response → work continues', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Deploy changes',
      attribution: operatorAttribution,
    });
    store.updateTurnStatus(turn.id, 'executing');
    streamManager.createStream(turn.id);

    // System creates approval
    const approval = store.createApprovalRequest(turn.id, {
      prompt: 'Deploy to production?',
      context: { env: 'production', changes: 5 },
      contextHash: 'hash-deploy-v1',
      responseOptions: [
        { key: 'approve', label: 'Deploy' },
        { key: 'reject', label: 'Cancel' },
      ],
    });

    // Emit approval-prompt event into stream
    streamManager.emitEvent(turn.id, 'approval-prompt', {
      approvalId: approval.id,
    });

    // Verify approval is pending
    const pending = store.getPendingApprovals(conv.id);
    assert.equal(pending.length, 1);

    // Operator responds
    const result = store.respondToApproval(approval.id, 'approve', 'sess-1');
    assert.ok(result.success);

    // Emit approval-response event
    streamManager.emitEvent(turn.id, 'approval-response', {
      approvalId: approval.id,
      response: 'approve',
    });

    // Work continues
    streamManager.emitEvent(turn.id, 'text-delta', { text: 'Deploying...' });
    streamManager.completeStream(turn.id);

    // Verify final state
    const finalApproval = store.getApproval(approval.id);
    assert.equal(finalApproval?.status, 'responded');
    assert.equal(finalApproval?.response, 'approve');

    // Approval response is NOT a separate turn
    const turns = store.getTurns(conv.id);
    assert.equal(turns.length, 1, 'approval response should not create a separate turn');

    // Events contain both approval-prompt and approval-response
    const events = streamManager.getStreamEvents(turn.id);
    assert.ok(events.some((e) => e.kind === 'approval-prompt'));
    assert.ok(events.some((e) => e.kind === 'approval-response'));
  });

  it('staleness detection prevents outdated approvals', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Modify file',
      attribution: operatorAttribution,
    });
    const approval = store.createApprovalRequest(turn.id, {
      prompt: 'Override?',
      context: { version: 1 },
      contextHash: 'hash-v1',
      responseOptions: [{ key: 'ok', label: 'OK' }],
    });

    // Context changes — mark stale
    store.markApprovalStale(approval.id, 'hash-v2');

    // Attempt response without acknowledgement fails
    const fail = store.respondToApproval(approval.id, 'ok', 'sess-1', false);
    assert.ok(!fail.success);

    // With acknowledgement succeeds
    const ok = store.respondToApproval(approval.id, 'ok', 'sess-1', true);
    assert.ok(ok.success);
  });
});

// ── SC-004: Reconnect/resume ─────────────────────────────────────────────────

describe('SC-004: Reconnect resume', () => {
  it('resumes from last acknowledged seq without missing events', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    store.updateTurnStatus(turn.id, 'executing');
    streamManager.createStream(turn.id);
    streamManager.emitEvent(turn.id, 'text-delta', { text: 'a' });
    streamManager.emitEvent(turn.id, 'text-delta', { text: 'b' });

    // Client saw up to this point
    const allEvents = streamManager.getStreamEvents(turn.id);
    const midSeq = allEvents[1].seq; // After 'started' and 'a'

    // More events after disconnect
    streamManager.emitEvent(turn.id, 'text-delta', { text: 'c' });
    streamManager.emitEvent(turn.id, 'text-delta', { text: 'd' });
    streamManager.completeStream(turn.id);

    // Resume from midpoint
    const resumed = streamManager.getStreamEventsSince(turn.id, midSeq + 1);
    assert.ok(resumed.length >= 3, 'should get b, c, d, completed events');
    assert.ok(resumed.every((e) => e.seq > midSeq));
  });

  it('conversation events support resume via event log', () => {
    const conv = store.createConversation();
    store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });

    const events = store.getEvents();
    const firstSeq = events[0].seq;

    store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'B',
      attribution: operatorAttribution,
    });

    const newEvents = store.getEventsSince(firstSeq + 1);
    assert.ok(newEvents.length >= 1, 'should have events after the first');
  });

  it('approval issued during disconnection is still pending on reconnect', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    store.updateTurnStatus(turn.id, 'executing');
    streamManager.createStream(turn.id);

    // Approval created during "disconnection"
    store.createApprovalRequest(turn.id, {
      prompt: 'Continue?',
      context: {},
      contextHash: 'hash',
      responseOptions: [{ key: 'yes', label: 'Yes' }],
    });

    // On reconnect, check pending approvals
    const pending = store.getPendingApprovals(conv.id);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, 'pending');
  });
});

// ── SC-005: Cancel mid-stream ────────────────────────────────────────────────

describe('SC-005: Cancel mid-stream', () => {
  it('cancels active stream and accepts new instruction', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Long task',
      attribution: operatorAttribution,
    });
    store.updateTurnStatus(turn.id, 'executing');
    streamManager.createStream(turn.id);
    streamManager.emitEvent(turn.id, 'text-delta', { text: 'partial...' });

    // Cancel
    streamManager.cancelStream(turn.id);
    assert.equal(store.getTurn(turn.id)?.status, 'cancelled');

    // Verify cancellation event
    const events = streamManager.getStreamEvents(turn.id);
    assert.ok(events.some((e) => e.kind === 'cancellation'));

    // New instruction succeeds
    const turn2 = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'New task',
      attribution: operatorAttribution,
    });
    assert.equal(turn2.position, 2);
    assert.equal(turn2.status, 'submitted');
  });
});

// ── SC-006: Fork from turn N ─────────────────────────────────────────────────

describe('SC-006: Fork conversation', () => {
  it('forked conversation has exactly turns 1..N from parent', () => {
    const conv = store.createConversation();
    store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Step 1',
      attribution: operatorAttribution,
    });
    store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Step 2',
      attribution: operatorAttribution,
    });
    const t3 = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Step 3',
      attribution: operatorAttribution,
    });
    store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Step 4',
      attribution: operatorAttribution,
    });

    // Fork at turn 3
    const forked = store.forkConversation(conv.id, t3.id);
    assert.equal(forked.parentConversationId, conv.id);
    assert.equal(forked.forkPointTurnId, t3.id);

    const forkTurns = store.getTurns(forked.id);
    assert.equal(forkTurns.length, 3, 'should have exactly turns 1..3');
    assert.equal(forkTurns[0].instruction, 'Step 1');
    assert.equal(forkTurns[2].instruction, 'Step 3');

    // Can add new turns to fork
    const newTurn = store.appendTurn(forked.id, {
      kind: 'operator',
      instruction: 'Forked Step 4',
      attribution: operatorAttribution,
    });
    assert.equal(newTurn.position, 4);
  });
});

// ── SC-007: Artifact persistence ─────────────────────────────────────────────

describe('SC-007: Artifact persistence', () => {
  it('artifacts persist and are accessible by turn and by id', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Generate file',
      attribution: operatorAttribution,
    });

    const artifact = store.createArtifact(turn.id, {
      kind: 'file',
      label: 'output.ts',
      size: 256,
      content: 'const result = 42;',
      summary: 'Generated output',
    });

    // Retrieve by turn
    const turnArtifacts = store.getArtifactsForTurn(turn.id);
    assert.equal(turnArtifacts.length, 1);
    assert.equal(turnArtifacts[0].label, 'output.ts');

    // Retrieve content by id
    const content = store.getArtifactContent(artifact.id);
    assert.equal(content, 'const result = 42;');

    // List by conversation
    const convArtifacts = store.listArtifactsForConversation(conv.id);
    assert.equal(convArtifacts.length, 1);
  });
});

// ── SC-008: Multi-agent activity attribution ─────────────────────────────────

describe('SC-008: Multi-agent activity attribution', () => {
  it('records and queries per-agent activities', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Council deliberation',
      attribution: operatorAttribution,
    });
    store.updateTurnStatus(turn.id, 'executing');
    streamManager.createStream(turn.id);

    // Multi-agent activity
    store.appendActivity(turn.id, {
      attribution: agentAttr('gemini'),
      kind: 'proposal',
      summary: 'Gemini proposes approach A',
    });
    store.appendActivity(turn.id, {
      attribution: agentAttr('claude'),
      kind: 'vote',
      summary: 'Claude votes for approach A',
    });
    store.appendActivity(turn.id, {
      attribution: agentAttr('codex'),
      kind: 'task-started',
      summary: 'Codex implementing approach A',
    });

    // Query all
    const all = store.getActivitiesForTurn(turn.id);
    assert.equal(all.length, 3);

    // Filter by agent
    const geminiOnly = store.filterActivitiesByAgent(turn.id, 'gemini');
    assert.equal(geminiOnly.length, 1);
    assert.equal(geminiOnly[0].summary, 'Gemini proposes approach A');

    const claudeOnly = store.filterActivitiesByAgent(turn.id, 'claude');
    assert.equal(claudeOnly.length, 1);
  });
});

// ── SC-009: Multi-session conflict resolution ────────────────────────────────

describe('SC-009: Multi-session conflict resolution', () => {
  it('first-write-wins with conflict notification', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Task',
      attribution: operatorAttribution,
    });
    const approval = store.createApprovalRequest(turn.id, {
      prompt: 'Continue?',
      context: {},
      contextHash: 'hash',
      responseOptions: [
        { key: 'yes', label: 'Yes' },
        { key: 'no', label: 'No' },
      ],
    });

    // Session 1 responds first
    const result1 = store.respondToApproval(approval.id, 'yes', 'session-1');
    assert.ok(result1.success);
    assert.equal(result1.approval.status, 'responded');

    // Session 2 tries to respond — gets conflict
    const result2 = store.respondToApproval(approval.id, 'no', 'session-2');
    assert.ok(!result2.success);
    assert.ok(result2.conflictNotification);
    assert.equal(result2.conflictNotification?.conflictingSessionId, 'session-1');
    assert.ok(result2.conflictNotification?.message);
  });
});

// ── Instruction queue integration ────────────────────────────────────────────

describe('Instruction queue integration', () => {
  it('queue → dequeue → execute flow', () => {
    const conv = store.createConversation();
    store.queueInstruction(conv.id, 'Task A');
    store.queueInstruction(conv.id, 'Task B');
    assert.equal(store.getConversation(conv.id)?.pendingInstructionCount, 2);

    const next = store.dequeueInstruction(conv.id);
    assert.equal(next?.instruction, 'Task A');
    assert.equal(store.getConversation(conv.id)?.pendingInstructionCount, 1);

    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: next.instruction,
      attribution: operatorAttribution,
    });
    assert.equal(turn.instruction, 'Task A');
  });
});

// ── Daemon-level HTTP integration: executor wiring ───────────────────────────

import http from 'node:http';
import { handleConversationRoute } from '../lib/daemon/conversation-routes.ts';
import type { ConversationRouteDeps } from '../lib/daemon/conversation-routes.ts';

function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : undefined,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => {
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(text) as Record<string, unknown>;
          } catch {
            /* keep empty */
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('Daemon-level HTTP: submit/retry with executor', () => {
  let server: http.Server;
  let port: number;
  let httpStore: ConversationStore;
  let httpStreamManager: StreamManager;
  let executedTurns: Array<{ turnId: string; instruction: string }>;

  beforeEach(async () => {
    httpStore = new ConversationStore();
    httpStreamManager = new StreamManager(httpStore);
    executedTurns = [];

    const deps: ConversationRouteDeps = {
      store: httpStore,
      streamManager: httpStreamManager,
      executeTurn(turnId: string, instruction: string) {
        executedTurns.push({ turnId, instruction });
        httpStreamManager.emitEvent(turnId, 'text-delta', { text: `echo: ${instruction}` });
        httpStreamManager.completeStream(turnId);
      },
    };

    server = http.createServer((req, res) => {
      if (!handleConversationRoute(req, res, deps)) {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterEach(() => {
    server.close();
  });

  it('submit through HTTP invokes executor and reaches completed state', async () => {
    // Create conversation
    const createRes = await httpRequest(port, 'POST', '/conversations', { title: 'HTTP test' });
    assert.equal(createRes.status, 201);
    const convId = createRes.data['id'] as string;
    assert.ok(convId);

    // Submit instruction
    const submitRes = await httpRequest(port, 'POST', `/conversations/${convId}/turns`, {
      instruction: 'Explain architecture',
    });
    assert.equal(submitRes.status, 201);
    const turnObj = submitRes.data['turn'] as Record<string, unknown>;
    const turnId = turnObj['id'] as string;
    assert.ok(submitRes.data['streamId']);

    // Verify executor was called
    assert.equal(executedTurns.length, 1);
    assert.equal(executedTurns[0].instruction, 'Explain architecture');

    // Verify turn reached terminal state
    const finalTurn = httpStore.getTurn(turnId);
    assert.equal(finalTurn?.status, 'completed');
    assert.equal(finalTurn?.response, 'echo: Explain architecture');

    // Verify stream has completed events
    const events = httpStreamManager.getStreamEvents(turnId);
    assert.ok(events.some((e) => e.kind === 'stream-started'));
    assert.ok(events.some((e) => e.kind === 'stream-completed'));
  });

  it('retry through HTTP invokes executor on new turn', async () => {
    const conv = httpStore.createConversation();
    const turn = httpStore.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Original',
      attribution: operatorAttribution,
    });
    httpStore.finalizeTurn(turn.id, 'failed', 'Error');

    const retryRes = await httpRequest(
      port,
      'POST',
      `/conversations/${conv.id}/turns/${turn.id}/retry`,
    );
    assert.equal(retryRes.status, 201);
    const newTurn = retryRes.data['turn'] as Record<string, unknown>;
    const newTurnId = newTurn['id'] as string;

    assert.equal(executedTurns.length, 1);
    assert.equal(executedTurns[0].turnId, newTurnId);

    const finalTurn = httpStore.getTurn(newTurnId);
    assert.equal(finalTurn?.status, 'completed');
  });

  it('submit through HTTP with failing executor reaches failed state', async () => {
    // Replace server with one using a failing executor
    server.close();
    const failDeps: ConversationRouteDeps = {
      store: httpStore,
      streamManager: httpStreamManager,
      executeTurn(turnId: string) {
        httpStreamManager.failStream(turnId, 'Agent unavailable');
      },
    };
    const failServer = http.createServer((req, res) => {
      if (!handleConversationRoute(req, res, failDeps)) {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    await new Promise<void>((resolve) => {
      failServer.listen(0, '127.0.0.1', () => {
        const addr = failServer.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });

    const conv = httpStore.createConversation();
    const submitRes = await httpRequest(port, 'POST', `/conversations/${conv.id}/turns`, {
      instruction: 'Will fail',
    });
    assert.equal(submitRes.status, 201);
    const turnObj = submitRes.data['turn'] as Record<string, unknown>;
    const turnId = turnObj['id'] as string;

    const finalTurn = httpStore.getTurn(turnId);
    assert.equal(finalTurn?.status, 'failed');

    const events = httpStreamManager.getStreamEvents(turnId);
    assert.ok(events.some((e) => e.kind === 'stream-failed'));

    failServer.close();
  });

  it('approval respond through HTTP invokes continueAfterApproval and reaches completed state', async () => {
    // Replace server with one using both executeTurn and continueAfterApproval
    server.close();
    const approvalStore = new ConversationStore();
    const approvalStreamManager = new StreamManager(approvalStore);
    let continueCallCount = 0;

    const approvalDeps: ConversationRouteDeps = {
      store: approvalStore,
      streamManager: approvalStreamManager,
      executeTurn(turnId: string, instruction: string) {
        // Simulate agent work that pauses for approval
        approvalStreamManager.emitEvent(turnId, 'text-delta', { text: `starting: ${instruction}` });
        // Create an approval request (simulates agent requesting human approval)
        approvalStore.createApprovalRequest(turnId, {
          prompt: 'Deploy to production?',
          context: { env: 'prod' },
          contextHash: 'hash-v1',
          responseOptions: [
            { key: 'approve', label: 'Approve' },
            { key: 'reject', label: 'Reject' },
          ],
        });
        approvalStreamManager.emitEvent(turnId, 'approval-prompt', { turnId });
        // Do NOT complete stream — turn is paused waiting for approval
      },
      continueAfterApproval(turnId: string, _approvalId: string, response: string) {
        continueCallCount++;
        approvalStreamManager.emitEvent(turnId, 'text-delta', {
          text: `resumed with: ${response}`,
        });
        approvalStreamManager.completeStream(turnId);
      },
    };

    const approvalServer = http.createServer((req, res) => {
      if (!handleConversationRoute(req, res, approvalDeps)) {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    await new Promise<void>((resolve) => {
      approvalServer.listen(0, '127.0.0.1', () => {
        const addr = approvalServer.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });

    // 1. Create conversation
    const createRes = await httpRequest(port, 'POST', '/conversations', {
      title: 'Approval test',
    });
    assert.equal(createRes.status, 201);
    const convId = createRes.data['id'] as string;

    // 2. Submit instruction — executor pauses and creates approval
    const submitRes = await httpRequest(port, 'POST', `/conversations/${convId}/turns`, {
      instruction: 'Deploy changes',
    });
    assert.equal(submitRes.status, 201);
    const turnObj = submitRes.data['turn'] as Record<string, unknown>;
    const turnId = turnObj['id'] as string;

    // 3. Check pending approvals
    const pendingRes = await httpRequest(port, 'GET', `/conversations/${convId}/approvals`);
    assert.equal(pendingRes.status, 200);
    const approvals = pendingRes.data['approvals'] as Array<Record<string, unknown>>;
    assert.equal(approvals.length, 1, 'should have 1 pending approval');
    const approvalId = approvals[0]['id'] as string;

    // 4. Respond to approval
    const respondRes = await httpRequest(port, 'POST', `/approvals/${approvalId}/respond`, {
      response: 'approve',
      sessionId: 'operator-1',
    });
    assert.equal(respondRes.status, 200);
    assert.equal(respondRes.data['success'], true);

    // 5. Verify continueAfterApproval was invoked
    assert.equal(continueCallCount, 1, 'continueAfterApproval should be called exactly once');

    // 6. Verify turn reached completed state
    const finalTurn = approvalStore.getTurn(turnId);
    assert.equal(finalTurn?.status, 'completed');

    // 7. Verify stream has full event sequence
    const events = approvalStreamManager.getStreamEvents(turnId);
    assert.ok(events.some((e) => e.kind === 'stream-started'));
    assert.ok(events.some((e) => e.kind === 'approval-prompt'));
    assert.ok(events.some((e) => e.kind === 'approval-response'));
    assert.ok(events.some((e) => e.kind === 'stream-completed'));

    // 8. Verify text-deltas include both initial and resumed content
    const textDeltas = events
      .filter((e) => e.kind === 'text-delta')
      .map((e) => (e.payload as { text: string }).text);
    assert.ok(
      textDeltas.some((t) => t.includes('starting:')),
      'should have initial text',
    );
    assert.ok(
      textDeltas.some((t) => t.includes('resumed with: approve')),
      'should have resumed text',
    );

    approvalServer.close();
  });

  it('approval respond after cancel returns failure and does not resume', async () => {
    server.close();
    const cancelStore = new ConversationStore();
    const cancelStreamManager = new StreamManager(cancelStore);
    let continueCallCount = 0;

    const cancelDeps: ConversationRouteDeps = {
      store: cancelStore,
      streamManager: cancelStreamManager,
      executeTurn(turnId: string, instruction: string) {
        cancelStreamManager.emitEvent(turnId, 'text-delta', { text: instruction });
        cancelStore.createApprovalRequest(turnId, {
          prompt: 'Continue?',
          context: {},
          contextHash: 'hash-1',
          responseOptions: [{ key: 'yes', label: 'Yes' }],
        });
      },
      continueAfterApproval() {
        continueCallCount++;
      },
    };

    const cancelServer = http.createServer((req, res) => {
      if (!handleConversationRoute(req, res, cancelDeps)) {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    await new Promise<void>((resolve) => {
      cancelServer.listen(0, '127.0.0.1', () => {
        const addr = cancelServer.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });

    // Create conversation and submit
    const createRes = await httpRequest(port, 'POST', '/conversations', { title: 'Cancel test' });
    const convId = createRes.data['id'] as string;
    const submitRes = await httpRequest(port, 'POST', `/conversations/${convId}/turns`, {
      instruction: 'Do work',
    });
    const turnId = (submitRes.data['turn'] as Record<string, unknown>)['id'] as string;

    // Get approval
    const pendingRes = await httpRequest(port, 'GET', `/conversations/${convId}/approvals`);
    const approvalId = (pendingRes.data['approvals'] as Array<Record<string, unknown>>)[0][
      'id'
    ] as string;

    // Cancel the turn
    const cancelRes = await httpRequest(
      port,
      'POST',
      `/conversations/${convId}/turns/${turnId}/cancel`,
    );
    assert.equal(cancelRes.status, 200);

    // Attempt to respond to approval — should fail
    const respondRes = await httpRequest(port, 'POST', `/approvals/${approvalId}/respond`, {
      response: 'yes',
      sessionId: 'sess-1',
    });
    assert.equal(respondRes.status, 409, 'should reject approval on cancelled turn');
    assert.equal(respondRes.data['success'], false);
    assert.equal(continueCallCount, 0, 'continueAfterApproval must not be called');

    cancelServer.close();
  });

  it('stream subscription using contract name lastAcknowledgedSeq through HTTP', async () => {
    // Create conversation and submit
    const createRes = await httpRequest(port, 'POST', '/conversations', {
      title: 'Contract param test',
    });
    const convId = createRes.data['id'] as string;
    const submitRes = await httpRequest(port, 'POST', `/conversations/${convId}/turns`, {
      instruction: 'Hello contract',
    });
    const turnId = (submitRes.data['turn'] as Record<string, unknown>)['id'] as string;

    // Get all events to find a midpoint seq
    const allRes = await httpRequest(
      port,
      'GET',
      `/conversations/${convId}/turns/${turnId}/stream?lastAcknowledgedSeq=0`,
    );
    assert.equal(allRes.status, 200);
    const allEvents = allRes.data['events'] as Array<Record<string, unknown>>;
    assert.ok(allEvents.length > 0);

    // Use lastAcknowledgedSeq to get only events after the first
    const firstSeq = allEvents[0]['seq'] as number;
    const resumeRes = await httpRequest(
      port,
      'GET',
      `/conversations/${convId}/turns/${turnId}/stream?lastAcknowledgedSeq=${String(firstSeq)}`,
    );
    assert.equal(resumeRes.status, 200);
    const resumeEvents = resumeRes.data['events'] as Array<Record<string, unknown>>;
    assert.ok(
      resumeEvents.every((e) => (e['seq'] as number) > firstSeq),
      'all events should be after firstSeq',
    );
    assert.ok(resumeEvents.length < allEvents.length, 'should have fewer events than total');
  });
});
