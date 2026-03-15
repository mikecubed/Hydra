/**
 * Unit tests for all conversation protocol entity Zod schemas.
 *
 * Tests written FIRST per TDD cadence — expect red until entities are implemented.
 * Covers: Attribution, Conversation, Turn, StreamEvent, ApprovalRequest, Artifact, ActivityEntry.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Attribution, AttributionType } from '../../packages/web-contracts/src/attribution.ts';
import { Conversation, ConversationStatus } from '../../packages/web-contracts/src/conversation.ts';
import { Turn, TurnKind, TurnStatus } from '../../packages/web-contracts/src/turn.ts';
import { StreamEvent, StreamEventKind } from '../../packages/web-contracts/src/stream.ts';
import { ApprovalRequest, ApprovalStatus } from '../../packages/web-contracts/src/approval.ts';
import { Artifact, ArtifactKind } from '../../packages/web-contracts/src/artifact.ts';
import { ActivityEntry, ActivityKind } from '../../packages/web-contracts/src/activity.ts';

const NOW = '2025-07-14T00:00:00.000Z';

// ── Attribution ──────────────────────────────────────────────────────────────

describe('Attribution schema', () => {
  it('accepts operator attribution', () => {
    const result = Attribution.safeParse({ type: 'operator', label: 'Admin' });
    assert.ok(result.success, 'operator attribution should be valid');
  });

  it('accepts system attribution', () => {
    const result = Attribution.safeParse({ type: 'system', label: 'System' });
    assert.ok(result.success, 'system attribution should be valid');
  });

  it('accepts agent attribution with agentId', () => {
    const result = Attribution.safeParse({
      type: 'agent',
      agentId: 'claude',
      label: 'Claude',
    });
    assert.ok(result.success, 'agent attribution with agentId should be valid');
  });

  it('rejects agent attribution without agentId', () => {
    const result = Attribution.safeParse({ type: 'agent', label: 'Claude' });
    assert.ok(!result.success, 'agent attribution without agentId should fail');
  });

  it('rejects empty label', () => {
    const result = Attribution.safeParse({ type: 'operator', label: '' });
    assert.ok(!result.success, 'empty label should fail');
  });

  it('rejects missing type', () => {
    const result = Attribution.safeParse({ label: 'Admin' });
    assert.ok(!result.success, 'missing type should fail');
  });

  it('validates all attribution types', () => {
    for (const t of ['operator', 'system', 'agent']) {
      const result = AttributionType.safeParse(t);
      assert.ok(result.success, `${t} should be a valid attribution type`);
    }
  });

  it('rejects invalid attribution type', () => {
    const result = AttributionType.safeParse('unknown');
    assert.ok(!result.success, 'unknown type should fail');
  });
});

// ── Conversation ─────────────────────────────────────────────────────────────

describe('Conversation schema', () => {
  const validConversation = {
    id: 'conv-1',
    status: 'active' as const,
    createdAt: NOW,
    updatedAt: NOW,
    turnCount: 0,
    pendingInstructionCount: 0,
  };

  it('accepts minimal valid conversation', () => {
    const result = Conversation.safeParse(validConversation);
    assert.ok(result.success, 'minimal conversation should be valid');
  });

  it('accepts conversation with title', () => {
    const result = Conversation.safeParse({ ...validConversation, title: 'My Chat' });
    assert.ok(result.success, 'conversation with title should be valid');
  });

  it('accepts forked conversation with both references', () => {
    const result = Conversation.safeParse({
      ...validConversation,
      parentConversationId: 'parent-1',
      forkPointTurnId: 'turn-5',
    });
    assert.ok(result.success, 'forked conversation should be valid');
  });

  it('rejects fork with only parentConversationId', () => {
    const result = Conversation.safeParse({
      ...validConversation,
      parentConversationId: 'parent-1',
    });
    assert.ok(!result.success, 'partial fork reference should fail');
  });

  it('rejects fork with only forkPointTurnId', () => {
    const result = Conversation.safeParse({
      ...validConversation,
      forkPointTurnId: 'turn-5',
    });
    assert.ok(!result.success, 'partial fork reference should fail');
  });

  it('rejects negative turnCount', () => {
    const result = Conversation.safeParse({ ...validConversation, turnCount: -1 });
    assert.ok(!result.success, 'negative turnCount should fail');
  });

  it('rejects missing id', () => {
    const { id: _, ...noId } = validConversation;
    const result = Conversation.safeParse(noId);
    assert.ok(!result.success, 'missing id should fail');
  });

  it('validates conversation statuses', () => {
    for (const s of ['active', 'archived']) {
      const result = ConversationStatus.safeParse(s);
      assert.ok(result.success, `${s} should be valid`);
    }
    const invalid = ConversationStatus.safeParse('deleted');
    assert.ok(!invalid.success, 'deleted should not be a valid status');
  });
});

// ── Turn ─────────────────────────────────────────────────────────────────────

describe('Turn schema', () => {
  const validOperatorTurn = {
    id: 'turn-1',
    conversationId: 'conv-1',
    position: 1,
    kind: 'operator' as const,
    attribution: { type: 'operator' as const, label: 'Admin' },
    instruction: 'Explain the architecture',
    status: 'submitted' as const,
    createdAt: NOW,
  };

  const validSystemTurn = {
    id: 'turn-2',
    conversationId: 'conv-1',
    position: 2,
    kind: 'system' as const,
    attribution: { type: 'system' as const, label: 'System' },
    status: 'completed' as const,
    createdAt: NOW,
    completedAt: NOW,
  };

  it('accepts valid operator turn', () => {
    const result = Turn.safeParse(validOperatorTurn);
    assert.ok(result.success, 'operator turn should be valid');
  });

  it('accepts valid system turn', () => {
    const result = Turn.safeParse(validSystemTurn);
    assert.ok(result.success, 'system turn should be valid');
  });

  it('rejects operator turn without instruction', () => {
    const { instruction: _, ...noInstruction } = validOperatorTurn;
    const result = Turn.safeParse(noInstruction);
    assert.ok(!result.success, 'operator turn without instruction should fail');
  });

  it('accepts system turn without instruction', () => {
    const result = Turn.safeParse(validSystemTurn);
    assert.ok(result.success, 'system turn without instruction should be valid');
  });

  it('accepts turn with response and completedAt', () => {
    const result = Turn.safeParse({
      ...validOperatorTurn,
      status: 'completed',
      response: 'Architecture is modular...',
      completedAt: NOW,
    });
    assert.ok(result.success, 'completed turn should be valid');
  });

  it('accepts turn with parentTurnId (retry)', () => {
    const result = Turn.safeParse({
      ...validOperatorTurn,
      id: 'turn-retry-1',
      parentTurnId: 'turn-1',
    });
    assert.ok(result.success, 'retry turn should be valid');
  });

  it('rejects zero position', () => {
    const result = Turn.safeParse({ ...validOperatorTurn, position: 0 });
    assert.ok(!result.success, 'zero position should fail');
  });

  it('rejects negative position', () => {
    const result = Turn.safeParse({ ...validOperatorTurn, position: -1 });
    assert.ok(!result.success, 'negative position should fail');
  });

  it('validates turn kinds', () => {
    for (const k of ['operator', 'system']) {
      assert.ok(TurnKind.safeParse(k).success, `${k} should be valid`);
    }
  });

  it('validates turn statuses', () => {
    for (const s of ['submitted', 'executing', 'completed', 'failed', 'cancelled']) {
      assert.ok(TurnStatus.safeParse(s).success, `${s} should be valid`);
    }
  });
});

// ── StreamEvent ──────────────────────────────────────────────────────────────

describe('StreamEvent schema', () => {
  const validEvent = {
    seq: 42,
    turnId: 'turn-1',
    kind: 'text-delta' as const,
    payload: { text: 'Hello' },
    timestamp: NOW,
  };

  it('accepts valid stream event', () => {
    const result = StreamEvent.safeParse(validEvent);
    assert.ok(result.success, 'valid stream event should pass');
  });

  it('rejects negative seq', () => {
    const result = StreamEvent.safeParse({ ...validEvent, seq: -1 });
    assert.ok(!result.success, 'negative seq should fail');
  });

  it('rejects missing turnId', () => {
    const { turnId: _, ...noTurnId } = validEvent;
    const result = StreamEvent.safeParse(noTurnId);
    assert.ok(!result.success, 'missing turnId should fail');
  });

  it('validates all stream event kinds', () => {
    const kinds = [
      'stream-started',
      'stream-completed',
      'stream-failed',
      'text-delta',
      'status-change',
      'activity-marker',
      'approval-prompt',
      'approval-response',
      'artifact-notice',
      'checkpoint',
      'warning',
      'error',
      'cancellation',
    ];
    for (const k of kinds) {
      assert.ok(StreamEventKind.safeParse(k).success, `${k} should be valid`);
    }
  });

  it('rejects invalid kind', () => {
    const result = StreamEvent.safeParse({ ...validEvent, kind: 'unknown-event' });
    assert.ok(!result.success, 'unknown kind should fail');
  });

  it('accepts empty payload object', () => {
    const result = StreamEvent.safeParse({ ...validEvent, payload: {} });
    assert.ok(result.success, 'empty payload should be valid');
  });
});

// ── ApprovalRequest ──────────────────────────────────────────────────────────

describe('ApprovalRequest schema', () => {
  const validApproval = {
    id: 'approval-1',
    turnId: 'turn-1',
    status: 'pending' as const,
    prompt: 'Apply this patch?',
    context: { file: 'main.ts', diff: '+const x = 1;' },
    contextHash: 'sha256-abc123',
    responseOptions: [
      { key: 'approve', label: 'Approve' },
      { key: 'reject', label: 'Reject' },
    ],
    createdAt: NOW,
  };

  it('accepts valid pending approval', () => {
    const result = ApprovalRequest.safeParse(validApproval);
    assert.ok(result.success, 'valid pending approval should pass');
  });

  it('accepts responded approval with response data', () => {
    const result = ApprovalRequest.safeParse({
      ...validApproval,
      status: 'responded',
      response: 'approve',
      respondedBy: { type: 'operator', label: 'Admin' },
      respondedAt: NOW,
    });
    assert.ok(result.success, 'responded approval should be valid');
  });

  it('rejects empty responseOptions', () => {
    const result = ApprovalRequest.safeParse({
      ...validApproval,
      responseOptions: [],
    });
    assert.ok(!result.success, 'empty responseOptions should fail');
  });

  it('rejects missing prompt', () => {
    const { prompt: _, ...noPrompt } = validApproval;
    const result = ApprovalRequest.safeParse(noPrompt);
    assert.ok(!result.success, 'missing prompt should fail');
  });

  it('rejects missing contextHash', () => {
    const { contextHash: _, ...noHash } = validApproval;
    const result = ApprovalRequest.safeParse(noHash);
    assert.ok(!result.success, 'missing contextHash should fail');
  });

  it('validates approval statuses', () => {
    for (const s of ['pending', 'responded', 'expired', 'stale']) {
      assert.ok(ApprovalStatus.safeParse(s).success, `${s} should be valid`);
    }
  });
});

// ── Artifact ─────────────────────────────────────────────────────────────────

describe('Artifact schema', () => {
  const validArtifact = {
    id: 'artifact-1',
    turnId: 'turn-1',
    kind: 'file' as const,
    label: 'main.ts',
    size: 1024,
    createdAt: NOW,
  };

  it('accepts valid artifact', () => {
    const result = Artifact.safeParse(validArtifact);
    assert.ok(result.success, 'valid artifact should pass');
  });

  it('accepts artifact with summary', () => {
    const result = Artifact.safeParse({
      ...validArtifact,
      summary: 'Main entry point',
    });
    assert.ok(result.success, 'artifact with summary should be valid');
  });

  it('rejects negative size', () => {
    const result = Artifact.safeParse({ ...validArtifact, size: -1 });
    assert.ok(!result.success, 'negative size should fail');
  });

  it('rejects missing label', () => {
    const { label: _, ...noLabel } = validArtifact;
    const result = Artifact.safeParse(noLabel);
    assert.ok(!result.success, 'missing label should fail');
  });

  it('validates all artifact kinds', () => {
    const kinds = ['file', 'diff', 'patch', 'test-result', 'log', 'plan', 'structured-data'];
    for (const k of kinds) {
      assert.ok(ArtifactKind.safeParse(k).success, `${k} should be valid`);
    }
  });

  it('rejects invalid kind', () => {
    const result = Artifact.safeParse({ ...validArtifact, kind: 'binary' });
    assert.ok(!result.success, 'binary should not be a valid kind');
  });
});

// ── ActivityEntry ────────────────────────────────────────────────────────────

describe('ActivityEntry schema', () => {
  const validActivity = {
    id: 'activity-1',
    attribution: { type: 'agent' as const, agentId: 'gemini', label: 'Gemini' },
    kind: 'task-started' as const,
    summary: 'Analyzing codebase',
    timestamp: NOW,
  };

  it('accepts valid activity entry', () => {
    const result = ActivityEntry.safeParse(validActivity);
    assert.ok(result.success, 'valid activity entry should pass');
  });

  it('accepts activity with detail', () => {
    const result = ActivityEntry.safeParse({
      ...validActivity,
      detail: 'Scanning 150 files in lib/',
    });
    assert.ok(result.success, 'activity with detail should be valid');
  });

  it('accepts nested activity', () => {
    const result = ActivityEntry.safeParse({
      ...validActivity,
      id: 'activity-2',
      parentActivityId: 'activity-1',
    });
    assert.ok(result.success, 'nested activity should be valid');
  });

  it('rejects missing attribution', () => {
    const { attribution: _, ...noAttribution } = validActivity;
    const result = ActivityEntry.safeParse(noAttribution);
    assert.ok(!result.success, 'missing attribution should fail');
  });

  it('rejects empty summary', () => {
    const result = ActivityEntry.safeParse({ ...validActivity, summary: '' });
    assert.ok(!result.success, 'empty summary should fail');
  });

  it('validates all activity kinds', () => {
    const kinds = [
      'task-started',
      'task-completed',
      'task-failed',
      'proposal',
      'vote',
      'consensus',
      'delegation',
      'checkpoint',
    ];
    for (const k of kinds) {
      assert.ok(ActivityKind.safeParse(k).success, `${k} should be valid`);
    }
  });
});
