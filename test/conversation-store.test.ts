/**
 * Unit tests for ConversationStore — event-sourced conversation persistence.
 *
 * Covers: create, append turns, retrieve, windowed retrieval, approvals,
 * artifacts, activities, fork, retry, instruction queue, conflict resolution.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationStore } from '../lib/daemon/conversation-store.ts';
import {
  operatorAttribution,
  systemAttribution,
  agentAttribution,
} from './fixtures/conversation/sample-conversations.ts';

let store: ConversationStore;

beforeEach(() => {
  store = new ConversationStore();
});

// ── Conversation CRUD ────────────────────────────────────────────────────────

describe('ConversationStore — conversations', () => {
  it('creates a conversation with generated id', () => {
    const conv = store.createConversation();
    assert.ok(conv.id, 'should have an id');
    assert.equal(conv.status, 'active');
    assert.equal(conv.turnCount, 0);
    assert.equal(conv.pendingInstructionCount, 0);
  });

  it('creates a conversation with a title', () => {
    const conv = store.createConversation({ title: 'My Chat' });
    assert.equal(conv.title, 'My Chat');
  });

  it('retrieves a conversation by id', () => {
    const conv = store.createConversation({ title: 'Test' });
    const retrieved = store.getConversation(conv.id);
    assert.deepEqual(retrieved, conv);
  });

  it('returns undefined for unknown conversation id', () => {
    assert.equal(store.getConversation('unknown'), undefined);
  });

  it('lists conversations', () => {
    store.createConversation({ title: 'A' });
    store.createConversation({ title: 'B' });
    const list = store.listConversations();
    assert.equal(list.length, 2);
  });

  it('lists conversations filtered by status', () => {
    const conv1 = store.createConversation({ title: 'Active' });
    store.createConversation({ title: 'Will Archive' });
    store.archiveConversation(conv1.id);
    const active = store.listConversations({ status: 'active' });
    assert.equal(active.length, 1);
    const archived = store.listConversations({ status: 'archived' });
    assert.equal(archived.length, 1);
  });

  it('archives a conversation (read-only)', () => {
    const conv = store.createConversation();
    store.archiveConversation(conv.id);
    const retrieved = store.getConversation(conv.id);
    assert.equal(retrieved?.status, 'archived');
  });

  it('rejects appending turns to archived conversation', () => {
    const conv = store.createConversation();
    store.archiveConversation(conv.id);
    assert.throws(
      () =>
        store.appendTurn(conv.id, {
          kind: 'operator',
          instruction: 'Test',
          attribution: operatorAttribution,
        }),
      /archived/i,
    );
  });
});

// ── Turn CRUD ────────────────────────────────────────────────────────────────

describe('ConversationStore — turns', () => {
  it('appends an operator turn', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'Hello',
      attribution: operatorAttribution,
    });
    assert.equal(turn.position, 1);
    assert.equal(turn.kind, 'operator');
    assert.equal(turn.instruction, 'Hello');
    assert.equal(turn.status, 'submitted');
  });

  it('appends a system turn', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'system',
      attribution: systemAttribution,
    });
    assert.equal(turn.kind, 'system');
    assert.equal(turn.status, 'completed');
  });

  it('increments position for each turn', () => {
    const conv = store.createConversation();
    const t1 = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    const t2 = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'B',
      attribution: operatorAttribution,
    });
    const t3 = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'C',
      attribution: operatorAttribution,
    });
    assert.equal(t1.position, 1);
    assert.equal(t2.position, 2);
    assert.equal(t3.position, 3);
  });

  it('updates turnCount on conversation', () => {
    const conv = store.createConversation();
    store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'B',
      attribution: operatorAttribution,
    });
    const updated = store.getConversation(conv.id);
    assert.equal(updated?.turnCount, 2);
  });

  it('retrieves all turns in order', () => {
    const conv = store.createConversation();
    store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'B',
      attribution: operatorAttribution,
    });
    store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'C',
      attribution: operatorAttribution,
    });
    const turns = store.getTurns(conv.id);
    assert.equal(turns.length, 3);
    assert.equal(turns[0].position, 1);
    assert.equal(turns[2].position, 3);
  });

  it('retrieves turns by range (windowed)', () => {
    const conv = store.createConversation();
    for (let i = 0; i < 10; i++) {
      store.appendTurn(conv.id, {
        kind: 'operator',
        instruction: `Turn ${String(i + 1)}`,
        attribution: operatorAttribution,
      });
    }
    const range = store.getTurnsByRange(conv.id, 3, 7);
    assert.equal(range.length, 5);
    assert.equal(range[0].position, 3);
    assert.equal(range[4].position, 7);
  });

  it('updates turn status', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    store.updateTurnStatus(turn.id, 'executing');
    const updated = store.getTurn(turn.id);
    assert.equal(updated?.status, 'executing');
  });

  it('finalizes turn with response', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    store.updateTurnStatus(turn.id, 'executing');
    store.finalizeTurn(turn.id, 'completed', 'Here is the response');
    const final = store.getTurn(turn.id);
    assert.equal(final?.status, 'completed');
    assert.equal(final?.response, 'Here is the response');
    assert.ok(final?.completedAt);
  });

  it('throws for unknown conversationId when appending turn', () => {
    assert.throws(
      () =>
        store.appendTurn('unknown', {
          kind: 'operator',
          instruction: 'A',
          attribution: operatorAttribution,
        }),
      /not found/i,
    );
  });
});

// ── Approval lifecycle ───────────────────────────────────────────────────────

describe('ConversationStore — approvals', () => {
  it('creates an approval request', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    const approval = store.createApprovalRequest(turn.id, {
      prompt: 'Apply patch?',
      context: { file: 'main.ts' },
      contextHash: 'sha256-abc',
      responseOptions: [
        { key: 'approve', label: 'Approve' },
        { key: 'reject', label: 'Reject' },
      ],
    });
    assert.ok(approval.id);
    assert.equal(approval.status, 'pending');
    assert.equal(approval.turnId, turn.id);
  });

  it('retrieves pending approvals for a conversation', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    store.createApprovalRequest(turn.id, {
      prompt: 'Approve?',
      context: {},
      contextHash: 'hash-1',
      responseOptions: [{ key: 'ok', label: 'OK' }],
    });
    const pending = store.getPendingApprovals(conv.id);
    assert.equal(pending.length, 1);
  });

  it('responds to an approval', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    const approval = store.createApprovalRequest(turn.id, {
      prompt: 'Approve?',
      context: {},
      contextHash: 'hash-1',
      responseOptions: [{ key: 'ok', label: 'OK' }],
    });
    const result = store.respondToApproval(approval.id, 'ok', 'session-1');
    assert.ok(result.success);
    assert.equal(result.approval.status, 'responded');
    assert.equal(result.approval.response, 'ok');
  });

  it('detects staleness via context hash mismatch', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    const approval = store.createApprovalRequest(turn.id, {
      prompt: 'Approve?',
      context: { version: 1 },
      contextHash: 'hash-v1',
      responseOptions: [{ key: 'ok', label: 'OK' }],
    });
    store.markApprovalStale(approval.id, 'hash-v2');
    const fetched = store.getApproval(approval.id);
    assert.equal(fetched?.status, 'stale');
  });

  it('allows responding to stale approval with acknowledgement', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    const approval = store.createApprovalRequest(turn.id, {
      prompt: 'Approve?',
      context: {},
      contextHash: 'hash-1',
      responseOptions: [{ key: 'ok', label: 'OK' }],
    });
    store.markApprovalStale(approval.id, 'hash-2');
    const result = store.respondToApproval(approval.id, 'ok', 'session-1', true);
    assert.ok(result.success);
    assert.equal(result.approval.status, 'responded');
  });

  it('rejects responding to stale approval without acknowledgement', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    const approval = store.createApprovalRequest(turn.id, {
      prompt: 'Approve?',
      context: {},
      contextHash: 'hash-1',
      responseOptions: [{ key: 'ok', label: 'OK' }],
    });
    store.markApprovalStale(approval.id, 'hash-2');
    const result = store.respondToApproval(approval.id, 'ok', 'session-1', false);
    assert.ok(!result.success);
  });

  it('first-write-wins for multi-session conflict', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    const approval = store.createApprovalRequest(turn.id, {
      prompt: 'Approve?',
      context: {},
      contextHash: 'hash-1',
      responseOptions: [{ key: 'ok', label: 'OK' }],
    });
    const first = store.respondToApproval(approval.id, 'ok', 'session-1');
    assert.ok(first.success);
    const second = store.respondToApproval(approval.id, 'ok', 'session-2');
    assert.ok(!second.success);
    assert.ok(second.conflictNotification);
    assert.equal(second.conflictNotification?.conflictingSessionId, 'session-1');
  });
});

// ── Fork ─────────────────────────────────────────────────────────────────────

describe('ConversationStore — fork', () => {
  it('creates a forked conversation', () => {
    const parent = store.createConversation({ title: 'Parent' });
    store.appendTurn(parent.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    store.appendTurn(parent.id, {
      kind: 'operator',
      instruction: 'B',
      attribution: operatorAttribution,
    });
    const turn3 = store.appendTurn(parent.id, {
      kind: 'operator',
      instruction: 'C',
      attribution: operatorAttribution,
    });

    const fork = store.forkConversation(parent.id, turn3.id);
    assert.ok(fork.id !== parent.id);
    assert.equal(fork.parentConversationId, parent.id);
    assert.equal(fork.forkPointTurnId, turn3.id);
    assert.equal(fork.status, 'active');
  });

  it('forked conversation has turns from parent up to fork point', () => {
    const parent = store.createConversation();
    store.appendTurn(parent.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    const t2 = store.appendTurn(parent.id, {
      kind: 'operator',
      instruction: 'B',
      attribution: operatorAttribution,
    });
    store.appendTurn(parent.id, {
      kind: 'operator',
      instruction: 'C',
      attribution: operatorAttribution,
    });

    const fork = store.forkConversation(parent.id, t2.id);
    const turns = store.getTurns(fork.id);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].instruction, 'A');
    assert.equal(turns[1].instruction, 'B');
  });

  it('can append new turns to forked conversation', () => {
    const parent = store.createConversation();
    const t1 = store.appendTurn(parent.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    const fork = store.forkConversation(parent.id, t1.id);

    const newTurn = store.appendTurn(fork.id, {
      kind: 'operator',
      instruction: 'Forked instruction',
      attribution: operatorAttribution,
    });
    assert.equal(newTurn.position, 2);
    const turns = store.getTurns(fork.id);
    assert.equal(turns.length, 2);
  });
});

// ── Retry ────────────────────────────────────────────────────────────────────

describe('ConversationStore — retry', () => {
  it('creates a retry turn linked to original', () => {
    const conv = store.createConversation();
    const original = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    store.finalizeTurn(original.id, 'failed', 'Something went wrong');

    const retry = store.retryTurn(conv.id, original.id);
    assert.equal(retry.parentTurnId, original.id);
    assert.equal(retry.instruction, original.instruction);
    assert.equal(retry.status, 'submitted');
    assert.equal(retry.position, 2);
  });

  it('rejects retry of non-terminal turn', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    assert.throws(() => store.retryTurn(conv.id, turn.id), /terminal/i);
  });
});

// ── Instruction Queue ────────────────────────────────────────────────────────

describe('ConversationStore — instruction queue', () => {
  it('queues an instruction', () => {
    const conv = store.createConversation();
    store.queueInstruction(conv.id, 'Do something');
    const queue = store.getInstructionQueue(conv.id);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].instruction, 'Do something');
  });

  it('dequeues next instruction', () => {
    const conv = store.createConversation();
    store.queueInstruction(conv.id, 'First');
    store.queueInstruction(conv.id, 'Second');
    const next = store.dequeueInstruction(conv.id);
    assert.equal(next?.instruction, 'First');
    assert.equal(store.getInstructionQueue(conv.id).length, 1);
  });

  it('removes an instruction from queue', () => {
    const conv = store.createConversation();
    store.queueInstruction(conv.id, 'First');
    const qi = store.queueInstruction(conv.id, 'Second');
    store.removeFromQueue(conv.id, qi.id);
    const queue = store.getInstructionQueue(conv.id);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].instruction, 'First');
  });

  it('updates pendingInstructionCount', () => {
    const conv = store.createConversation();
    store.queueInstruction(conv.id, 'A');
    store.queueInstruction(conv.id, 'B');
    const updated = store.getConversation(conv.id);
    assert.equal(updated?.pendingInstructionCount, 2);
  });
});

// ── Artifacts ────────────────────────────────────────────────────────────────

describe('ConversationStore — artifacts', () => {
  it('creates and retrieves artifacts for a turn', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    const artifact = store.createArtifact(turn.id, {
      kind: 'file',
      label: 'output.ts',
      size: 1024,
      content: 'const x = 1;',
    });
    assert.ok(artifact.id);
    const artifacts = store.getArtifactsForTurn(turn.id);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].label, 'output.ts');
  });

  it('retrieves artifact content by id', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    const artifact = store.createArtifact(turn.id, {
      kind: 'diff',
      label: 'change.diff',
      size: 256,
      content: '+ added line',
    });
    const content = store.getArtifactContent(artifact.id);
    assert.equal(content, '+ added line');
  });

  it('lists artifacts for conversation', () => {
    const conv = store.createConversation();
    const t1 = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    const t2 = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'B',
      attribution: operatorAttribution,
    });
    store.createArtifact(t1.id, { kind: 'file', label: 'a.ts', size: 100, content: '' });
    store.createArtifact(t2.id, { kind: 'log', label: 'b.log', size: 200, content: '' });
    const artifacts = store.listArtifactsForConversation(conv.id);
    assert.equal(artifacts.length, 2);
  });
});

// ── Activities ───────────────────────────────────────────────────────────────

describe('ConversationStore — activities', () => {
  it('appends and retrieves activity entries', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    store.appendActivity(turn.id, {
      attribution: agentAttribution('gemini', 'Gemini'),
      kind: 'task-started',
      summary: 'Analyzing',
    });
    const activities = store.getActivitiesForTurn(turn.id);
    assert.equal(activities.length, 1);
    assert.equal(activities[0].summary, 'Analyzing');
  });

  it('filters activities by agent', () => {
    const conv = store.createConversation();
    const turn = store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    store.appendActivity(turn.id, {
      attribution: agentAttribution('gemini', 'Gemini'),
      kind: 'task-started',
      summary: 'Gemini analyzing',
    });
    store.appendActivity(turn.id, {
      attribution: agentAttribution('claude', 'Claude'),
      kind: 'task-started',
      summary: 'Claude designing',
    });
    const geminiOnly = store.filterActivitiesByAgent(turn.id, 'gemini');
    assert.equal(geminiOnly.length, 1);
    assert.equal(geminiOnly[0].summary, 'Gemini analyzing');
  });
});

// ── Event log integration ────────────────────────────────────────────────────

describe('ConversationStore — event log', () => {
  it('records events for all mutations', () => {
    const conv = store.createConversation();
    store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    const events = store.getEvents();
    assert.ok(events.length >= 2, 'should have at least creation and turn events');
    assert.ok(events.some((e) => e.type === 'conversation:created'));
    assert.ok(events.some((e) => e.type === 'conversation:turn-appended'));
  });

  it('replays events from a given seq', () => {
    const conv = store.createConversation();
    store.appendTurn(conv.id, {
      kind: 'operator',
      instruction: 'A',
      attribution: operatorAttribution,
    });
    const allEvents = store.getEvents();
    const firstSeq = allEvents[0].seq;
    const fromSecond = store.getEventsSince(firstSeq + 1);
    assert.ok(fromSecond.length < allEvents.length);
  });
});
