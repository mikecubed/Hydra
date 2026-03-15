/**
 * Integration tests for the conversation executor — exercises the real
 * `createConversationExecutor` and `createApprovalContinuator` from
 * `lib/daemon/conversation-executor.ts` wired through the HTTP layer.
 *
 * The agent execution backend is stubbed (no real CLI calls), but every
 * other component — ConversationStore, StreamManager, conversation routes,
 * and the executor/continuator logic — is the production code path.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import { ConversationStore } from '../lib/daemon/conversation-store.ts';
import { StreamManager } from '../lib/daemon/stream-manager.ts';
import { handleConversationRoute } from '../lib/daemon/conversation-routes.ts';
import {
  createConversationExecutor,
  createApprovalContinuator,
  requiresApproval,
  type ExecutorDeps,
  type AgentResult,
} from '../lib/daemon/conversation-executor.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// ── requiresApproval unit tests ──────────────────────────────────────────────

describe('requiresApproval', () => {
  it('returns true for destructive / high-impact instructions', () => {
    assert.ok(requiresApproval('deploy to production'));
    assert.ok(requiresApproval('Deploy to prod'));
    assert.ok(requiresApproval('Please deploy to production now'));
    assert.ok(requiresApproval('rollback production'));
    assert.ok(requiresApproval('rollback prod'));
    assert.ok(requiresApproval('destroy cluster'));
    assert.ok(requiresApproval('destroy infra'));
    assert.ok(requiresApproval('terminate server'));
    assert.ok(requiresApproval('terminate instance'));
    assert.ok(requiresApproval('shutdown prod'));
    assert.ok(requiresApproval('delete prod data'));
    assert.ok(requiresApproval('drop table users'));
    assert.ok(requiresApproval('drop database main'));
    assert.ok(requiresApproval('rm -rf /'));
  });

  it('returns false for safe instructions', () => {
    assert.ok(!requiresApproval('fix the login bug'));
    assert.ok(!requiresApproval('refactor the auth module'));
    assert.ok(!requiresApproval('add tests for the API'));
    assert.ok(!requiresApproval('review the PR'));
    assert.ok(!requiresApproval('deploy to staging'));
    assert.ok(!requiresApproval('delete local temp files'));
    assert.ok(!requiresApproval('analyze the codebase'));
  });
});

// ── Executor approval-gate unit tests ────────────────────────────────────────

describe('createConversationExecutor — approval gate', () => {
  let store: ConversationStore;
  let streamManager: StreamManager;
  let agentCalls: Array<{ agent: string; prompt: string }>;
  let agentResponse: AgentResult;

  function buildDeps(): ExecutorDeps {
    return {
      conversationStore: store,
      streamManager,
      executeAgent: async (agent: string, prompt: string) => {
        agentCalls.push({ agent, prompt });
        return agentResponse;
      },
    };
  }

  beforeEach(() => {
    store = new ConversationStore();
    streamManager = new StreamManager(store);
    agentCalls = [];
    agentResponse = { ok: true, output: 'done' };
  });

  it('pauses turn and creates approval for destructive instructions', async () => {
    const conv = store.createConversation({ title: 'test' });
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'deploy to production',
      attribution: { type: 'operator', label: 'op' },
    });
    store.updateTurnStatus(turn.id, 'executing');
    streamManager.createStream(turn.id);

    const executor = createConversationExecutor(buildDeps());
    await executor(turn.id, 'deploy to production');

    // Agent should NOT have been called
    assert.equal(agentCalls.length, 0, 'agent must not be called before approval');

    // Approval should exist
    const pending = store.getPendingApprovals(conv.id);
    assert.equal(pending.length, 1);
    assert.ok(pending[0].prompt.includes('deploy to production'));
    assert.deepEqual(pending[0].responseOptions, [
      { key: 'approve', label: 'Approve' },
      { key: 'reject', label: 'Reject' },
    ]);

    // Context should include instruction and task metadata
    assert.equal(pending[0].context['instruction'], 'deploy to production');
    assert.ok(typeof pending[0].context['taskType'] === 'string');
    assert.ok(typeof pending[0].context['agent'] === 'string');

    // Stream should have text-delta + approval-prompt but NOT be completed
    const events = streamManager.getStreamEvents(turn.id);
    assert.ok(events.some((e) => e.kind === 'text-delta'));
    assert.ok(events.some((e) => e.kind === 'approval-prompt'));
    assert.ok(!events.some((e) => e.kind === 'stream-completed'));
    assert.ok(!events.some((e) => e.kind === 'stream-failed'));

    // Turn should still be executing (not completed)
    assert.equal(store.getTurn(turn.id)?.status, 'executing');
  });

  it('executes agent directly for non-destructive instructions', async () => {
    const conv = store.createConversation({ title: 'test' });
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'fix the login bug',
      attribution: { type: 'operator', label: 'op' },
    });
    store.updateTurnStatus(turn.id, 'executing');
    streamManager.createStream(turn.id);

    const executor = createConversationExecutor(buildDeps());
    await executor(turn.id, 'fix the login bug');

    // Agent should have been called
    assert.equal(agentCalls.length, 1);
    assert.ok(agentCalls[0].prompt.includes('fix the login bug'));

    // Stream should be completed
    const events = streamManager.getStreamEvents(turn.id);
    assert.ok(events.some((e) => e.kind === 'stream-completed'));
    assert.ok(!events.some((e) => e.kind === 'approval-prompt'));
  });
});

// ── Continuator unit tests ───────────────────────────────────────────────────

describe('createApprovalContinuator — persisted context', () => {
  let store: ConversationStore;
  let streamManager: StreamManager;
  let agentCalls: Array<{ agent: string; prompt: string }>;
  let agentResponse: AgentResult;

  function buildDeps(): ExecutorDeps {
    return {
      conversationStore: store,
      streamManager,
      executeAgent: async (agent: string, prompt: string) => {
        agentCalls.push({ agent, prompt });
        return agentResponse;
      },
    };
  }

  beforeEach(() => {
    store = new ConversationStore();
    streamManager = new StreamManager(store);
    agentCalls = [];
    agentResponse = { ok: true, output: 'deployed successfully' };
  });

  it('loads approval record and includes context in continuation prompt', async () => {
    const conv = store.createConversation({ title: 'test' });
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'deploy to production',
      attribution: { type: 'operator', label: 'op' },
    });
    store.updateTurnStatus(turn.id, 'executing');
    streamManager.createStream(turn.id);

    // Create approval (as executor would)
    const approval = store.createApprovalRequest(turn.id, {
      prompt: 'Confirm execution: deploy to production',
      context: { instruction: 'deploy to production', taskType: 'implementation', agent: 'codex' },
      contextHash: 'abc123',
      responseOptions: [
        { key: 'approve', label: 'Approve' },
        { key: 'reject', label: 'Reject' },
      ],
    });

    // Respond to the approval
    store.respondToApproval(approval.id, 'approve', 'session-1');

    // Now continue
    const continuator = createApprovalContinuator(buildDeps());
    await continuator(turn.id, approval.id, 'approve', 'deploy to production');

    // Agent should have been called with persisted context
    assert.equal(agentCalls.length, 1);
    const prompt = agentCalls[0].prompt;
    assert.ok(prompt.includes('deploy to production'), 'should include original instruction');
    assert.ok(prompt.includes('Confirm execution'), 'should include approval prompt');
    assert.ok(prompt.includes('implementation'), 'should include persisted taskType');
    assert.ok(prompt.includes('approve'), 'should include operator response');

    // Should use the agent from persisted context
    assert.equal(agentCalls[0].agent, 'codex');

    // Stream should be completed
    const events = streamManager.getStreamEvents(turn.id);
    assert.ok(events.some((e) => e.kind === 'stream-completed'));
  });

  it('completes with rejection notice when operator rejects', async () => {
    const conv = store.createConversation({ title: 'test' });
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'deploy to production',
      attribution: { type: 'operator', label: 'op' },
    });
    store.updateTurnStatus(turn.id, 'executing');
    streamManager.createStream(turn.id);

    const approval = store.createApprovalRequest(turn.id, {
      prompt: 'Confirm execution: deploy to production',
      context: { instruction: 'deploy to production', taskType: 'implementation', agent: 'codex' },
      contextHash: 'abc123',
      responseOptions: [
        { key: 'approve', label: 'Approve' },
        { key: 'reject', label: 'Reject' },
      ],
    });
    store.respondToApproval(approval.id, 'reject', 'session-1');

    const continuator = createApprovalContinuator(buildDeps());
    await continuator(turn.id, approval.id, 'reject', 'deploy to production');

    // Agent must NOT be called on rejection
    assert.equal(agentCalls.length, 0, 'agent must not execute after rejection');

    // Turn should complete with rejection text
    const events = streamManager.getStreamEvents(turn.id);
    const textEvents = events.filter((e) => e.kind === 'text-delta');
    assert.ok(textEvents.some((e) => (e.payload as { text: string }).text.includes('rejected')));
    assert.ok(events.some((e) => e.kind === 'stream-completed'));
  });

  it('handles missing approval record gracefully', async () => {
    const conv = store.createConversation({ title: 'test' });
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'deploy to production',
      attribution: { type: 'operator', label: 'op' },
    });
    store.updateTurnStatus(turn.id, 'executing');
    streamManager.createStream(turn.id);

    const continuator = createApprovalContinuator(buildDeps());
    await continuator(turn.id, 'nonexistent-id', 'approve', 'deploy to production');

    // Should still work — falls back to classifying from original instruction
    assert.equal(agentCalls.length, 1);
    assert.ok(agentCalls[0].prompt.includes('deploy to production'));
    assert.ok(agentCalls[0].prompt.includes('Approval requested')); // fallback prompt
  });
});

// ── End-to-end HTTP integration: real executor + real continuator ─────────────

describe('End-to-end HTTP: real executor approval flow', () => {
  let server: http.Server;
  let port: number;
  let testStore: ConversationStore;
  let testStreamManager: StreamManager;
  let agentCalls: Array<{ agent: string; prompt: string }>;
  let agentResponse: AgentResult;

  beforeEach(async () => {
    testStore = new ConversationStore();
    testStreamManager = new StreamManager(testStore);
    agentCalls = [];
    agentResponse = { ok: true, output: 'Changes deployed successfully to production.' };

    const deps: ExecutorDeps = {
      conversationStore: testStore,
      streamManager: testStreamManager,
      executeAgent: async (agent: string, prompt: string) => {
        agentCalls.push({ agent, prompt });
        return agentResponse;
      },
    };

    server = http.createServer((req, res) => {
      if (
        !handleConversationRoute(req, res, {
          store: testStore,
          streamManager: testStreamManager,
          executeTurn: createConversationExecutor(deps),
          continueAfterApproval: createApprovalContinuator(deps),
        })
      ) {
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

  it('submit → approval-prompt → respond approve → agent executes → completed', async () => {
    // 1. Create conversation
    const createRes = await httpRequest(port, 'POST', '/conversations', {
      title: 'E2E approval test',
    });
    assert.equal(createRes.status, 201);
    const convId = createRes.data['id'] as string;

    // 2. Submit instruction that triggers approval gate
    const submitRes = await httpRequest(port, 'POST', `/conversations/${convId}/turns`, {
      instruction: 'deploy to production',
    });
    assert.equal(submitRes.status, 201);
    const turnObj = submitRes.data['turn'] as Record<string, unknown>;
    const turnId = turnObj['id'] as string;

    // 3. Agent must NOT have been called yet
    assert.equal(agentCalls.length, 0, 'no agent call before approval');

    // 4. Turn should still be executing (not completed/failed)
    const turn = testStore.getTurn(turnId);
    assert.equal(turn?.status, 'executing');

    // 5. Stream should have approval-prompt event
    const preApprovalEvents = testStreamManager.getStreamEvents(turnId);
    assert.ok(preApprovalEvents.some((e) => e.kind === 'approval-prompt'));
    assert.ok(!preApprovalEvents.some((e) => e.kind === 'stream-completed'));

    // 6. Check pending approvals via HTTP
    const pendingRes = await httpRequest(port, 'GET', `/conversations/${convId}/approvals`);
    assert.equal(pendingRes.status, 200);
    const approvals = pendingRes.data['approvals'] as Array<Record<string, unknown>>;
    assert.equal(approvals.length, 1);
    const approvalId = approvals[0]['id'] as string;
    assert.equal(approvals[0]['status'], 'pending');
    assert.ok((approvals[0]['prompt'] as string).includes('deploy to production'));

    // 7. Respond to approval — this should trigger the real continuator
    const respondRes = await httpRequest(port, 'POST', `/approvals/${approvalId}/respond`, {
      response: 'approve',
      sessionId: 'operator-1',
    });
    assert.equal(respondRes.status, 200);
    assert.equal(respondRes.data['success'], true);

    // Wait for async executor to complete
    await delay(50);

    // 8. Agent should now have been called with full context
    assert.equal(agentCalls.length, 1, 'agent should be called after approval');
    assert.ok(agentCalls[0].prompt.includes('deploy to production'));
    assert.ok(agentCalls[0].prompt.includes('Confirm execution'));
    assert.ok(agentCalls[0].prompt.includes('approve'));

    // 9. Turn should be completed
    const finalTurn = testStore.getTurn(turnId);
    assert.equal(finalTurn?.status, 'completed');

    // 10. Verify full event sequence
    const events = testStreamManager.getStreamEvents(turnId);
    const kinds = events.map((e) => e.kind);
    assert.ok(kinds.includes('stream-started'));
    assert.ok(kinds.includes('text-delta'));
    assert.ok(kinds.includes('approval-prompt'));
    assert.ok(kinds.includes('approval-response'));
    assert.ok(kinds.includes('stream-completed'));

    // 11. Verify monotonic seq ordering
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i].seq > events[i - 1].seq, 'events must have monotonic seq');
    }
  });

  it('submit → approval-prompt → respond reject → turn completed without agent', async () => {
    const createRes = await httpRequest(port, 'POST', '/conversations', {
      title: 'E2E reject test',
    });
    const convId = createRes.data['id'] as string;

    const submitRes = await httpRequest(port, 'POST', `/conversations/${convId}/turns`, {
      instruction: 'deploy to production',
    });
    const turnId = (submitRes.data['turn'] as Record<string, unknown>)['id'] as string;

    // Get approval
    const pendingRes = await httpRequest(port, 'GET', `/conversations/${convId}/approvals`);
    const approvalId = (pendingRes.data['approvals'] as Array<Record<string, unknown>>)[0][
      'id'
    ] as string;

    // Reject
    const respondRes = await httpRequest(port, 'POST', `/approvals/${approvalId}/respond`, {
      response: 'reject',
      sessionId: 'operator-2',
    });
    assert.equal(respondRes.status, 200);

    await delay(50);

    // Agent must NOT have been called
    assert.equal(agentCalls.length, 0, 'agent must not execute after rejection');

    // Turn should be completed (with rejection text)
    const finalTurn = testStore.getTurn(turnId);
    assert.equal(finalTurn?.status, 'completed');

    // Response should contain rejection notice
    assert.ok(finalTurn?.response?.includes('rejected'));
  });

  it('non-destructive instruction bypasses approval and completes directly', async () => {
    const createRes = await httpRequest(port, 'POST', '/conversations', {
      title: 'E2E direct test',
    });
    const convId = createRes.data['id'] as string;

    await httpRequest(port, 'POST', `/conversations/${convId}/turns`, {
      instruction: 'fix the login bug',
    });

    // Wait for async executor
    await delay(50);

    // Agent should have been called directly
    assert.equal(agentCalls.length, 1);
    assert.ok(agentCalls[0].prompt.includes('fix the login bug'));

    // No pending approvals
    const pendingRes = await httpRequest(port, 'GET', `/conversations/${convId}/approvals`);
    const approvals = pendingRes.data['approvals'] as Array<Record<string, unknown>>;
    assert.equal(approvals.length, 0);
  });

  it('continuator uses persisted agent from approval context', async () => {
    const createRes = await httpRequest(port, 'POST', '/conversations', {
      title: 'Agent context test',
    });
    const convId = createRes.data['id'] as string;

    // "deploy to production" classifies as "implementation" → codex
    await httpRequest(port, 'POST', `/conversations/${convId}/turns`, {
      instruction: 'deploy to production',
    });

    const pendingRes = await httpRequest(port, 'GET', `/conversations/${convId}/approvals`);
    const approvalId = (pendingRes.data['approvals'] as Array<Record<string, unknown>>)[0][
      'id'
    ] as string;

    // Verify approval context has the agent info
    const approval = testStore.getApproval(approvalId);
    assert.ok(approval);
    assert.equal(approval.context['agent'], 'codex');

    // Respond
    await httpRequest(port, 'POST', `/approvals/${approvalId}/respond`, {
      response: 'approve',
      sessionId: 'operator-1',
    });
    await delay(50);

    // The continuator should use the agent from the persisted approval context
    assert.equal(agentCalls[0].agent, 'codex');
  });
});
