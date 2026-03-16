/**
 * Unit tests for all conversation protocol contract Zod schemas.
 *
 * Covers all 6 owned contract families:
 * 1. Conversation Lifecycle
 * 2. Turn Submission
 * 3. Approval Flow
 * 4. Work Control
 * 5. Artifact Access
 * 6. Multi-Agent Activity
 * + Shared Error Response
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CreateConversationRequest,
  OpenConversationRequest,
  OpenConversationResponse,
  ResumeConversationRequest,
  ResumeConversationBody,
  ArchiveConversationRequest,
  ListConversationsRequest,
  ListConversationsResponse,
} from '../../packages/web-contracts/src/contracts/conversation-lifecycle.ts';

import {
  SubmitInstructionRequest,
  SubmitInstructionBody,
  SubmitInstructionResponse,
  SubscribeToStreamRequest,
  LoadTurnHistoryRequest,
  LoadTurnHistoryResponse,
} from '../../packages/web-contracts/src/contracts/turn-submission.ts';

import {
  GetPendingApprovalsRequest,
  GetPendingApprovalsResponse,
  RespondToApprovalRequest,
  RespondToApprovalResponse,
} from '../../packages/web-contracts/src/contracts/approval-flow.ts';

import {
  CancelWorkRequest,
  RetryTurnRequest,
  ForkConversationRequest,
  ManageQueueRequest,
  ManageQueueResponse,
  QueuedInstruction,
} from '../../packages/web-contracts/src/contracts/work-control.ts';

import {
  ListArtifactsForTurnRequest,
  GetArtifactContentRequest,
  ListArtifactsForConversationRequest,
  ListArtifactsForConversationResponse,
} from '../../packages/web-contracts/src/contracts/artifact-access.ts';

import {
  GetActivityEntriesRequest,
  FilterActivityByAgentRequest,
} from '../../packages/web-contracts/src/contracts/multi-agent-activity.ts';

import { ErrorCode, ErrorResponse } from '../../packages/web-contracts/src/contracts/error.ts';

const NOW = '2025-07-14T00:00:00.000Z';

// ── Helpers for building valid nested objects ────────────────────────────────

const validConversation = {
  id: 'conv-1',
  status: 'active' as const,
  createdAt: NOW,
  updatedAt: NOW,
  turnCount: 0,
  pendingInstructionCount: 0,
};

const validTurn = {
  id: 'turn-1',
  conversationId: 'conv-1',
  position: 1,
  kind: 'operator' as const,
  attribution: { type: 'operator' as const, label: 'Admin' },
  instruction: 'Hello',
  status: 'submitted' as const,
  createdAt: NOW,
};

const validApproval = {
  id: 'approval-1',
  turnId: 'turn-1',
  status: 'pending' as const,
  prompt: 'Apply patch?',
  context: { file: 'main.ts' },
  contextHash: 'sha256-abc',
  responseOptions: [{ key: 'approve', label: 'Approve' }],
  createdAt: NOW,
};

const validArtifact = {
  id: 'artifact-1',
  turnId: 'turn-1',
  kind: 'file' as const,
  label: 'main.ts',
  size: 512,
  createdAt: NOW,
};

// ── Contract Family 1: Conversation Lifecycle ────────────────────────────────

describe('Conversation Lifecycle contracts', () => {
  it('CreateConversationRequest accepts minimal input', () => {
    assert.ok(CreateConversationRequest.safeParse({}).success);
  });

  it('CreateConversationRequest accepts title', () => {
    assert.ok(CreateConversationRequest.safeParse({ title: 'Chat' }).success);
  });

  it('OpenConversationRequest requires conversationId', () => {
    assert.ok(!OpenConversationRequest.safeParse({}).success);
    assert.ok(OpenConversationRequest.safeParse({ conversationId: 'conv-1' }).success);
  });

  it('OpenConversationResponse validates nested types', () => {
    const result = OpenConversationResponse.safeParse({
      conversation: validConversation,
      recentTurns: [validTurn],
      totalTurnCount: 1,
      pendingApprovals: [],
    });
    assert.ok(result.success);
  });

  it('ResumeConversationRequest requires lastAcknowledgedSeq', () => {
    assert.ok(!ResumeConversationRequest.safeParse({ conversationId: 'c-1' }).success);
    assert.ok(
      ResumeConversationRequest.safeParse({ conversationId: 'c-1', lastAcknowledgedSeq: 42 })
        .success,
    );
  });

  it('ResumeConversationBody omits conversationId (browser-facing)', () => {
    // Must accept body without conversationId — path is authoritative
    assert.ok(ResumeConversationBody.safeParse({ lastAcknowledgedSeq: 10 }).success);
    // Must reject missing lastAcknowledgedSeq
    assert.ok(!ResumeConversationBody.safeParse({}).success);
    // Must strip conversationId if accidentally sent — Zod default strips unknown keys
    const parsed = ResumeConversationBody.safeParse({
      conversationId: 'should-be-stripped',
      lastAcknowledgedSeq: 5,
    });
    assert.ok(parsed.success, 'extra keys should not fail parse');
    assert.equal(
      (parsed.data as Record<string, unknown>)['conversationId'],
      undefined,
      'conversationId must be stripped — it comes from the URL path',
    );
  });

  it('ArchiveConversationRequest requires conversationId', () => {
    assert.ok(!ArchiveConversationRequest.safeParse({}).success);
    assert.ok(ArchiveConversationRequest.safeParse({ conversationId: 'c-1' }).success);
  });

  it('ListConversationsRequest accepts defaults', () => {
    const result = ListConversationsRequest.safeParse({});
    assert.ok(result.success);
    assert.equal(result.data.limit, 20);
  });

  it('ListConversationsRequest rejects limit > 100', () => {
    assert.ok(!ListConversationsRequest.safeParse({ limit: 101 }).success);
  });

  it('ListConversationsResponse validates structure', () => {
    assert.ok(
      ListConversationsResponse.safeParse({
        conversations: [validConversation],
        totalCount: 1,
      }).success,
    );
  });
});

// ── Contract Family 2: Turn Submission ───────────────────────────────────────

describe('Turn Submission contracts', () => {
  it('SubmitInstructionRequest requires instruction', () => {
    assert.ok(!SubmitInstructionRequest.safeParse({ conversationId: 'c-1' }).success);
    assert.ok(
      SubmitInstructionRequest.safeParse({
        conversationId: 'c-1',
        instruction: 'Do something',
      }).success,
    );
  });

  it('SubmitInstructionResponse validates turn and streamId', () => {
    assert.ok(
      SubmitInstructionResponse.safeParse({
        turn: validTurn,
        streamId: 'stream-1',
      }).success,
    );
  });

  it('SubmitInstructionBody omits conversationId (browser-facing)', () => {
    // Must accept body without conversationId — path is authoritative
    assert.ok(SubmitInstructionBody.safeParse({ instruction: 'Do something' }).success);
    // Must reject empty instruction
    assert.ok(!SubmitInstructionBody.safeParse({ instruction: '' }).success);
    // Must reject missing instruction
    assert.ok(!SubmitInstructionBody.safeParse({}).success);
    // Must strip conversationId if accidentally sent
    const parsed = SubmitInstructionBody.safeParse({
      conversationId: 'should-be-stripped',
      instruction: 'test',
    });
    assert.ok(parsed.success);
    assert.equal(
      (parsed.data as Record<string, unknown>)['conversationId'],
      undefined,
      'conversationId must be stripped — it comes from the URL path',
    );
    // Must accept optional metadata
    assert.ok(
      SubmitInstructionBody.safeParse({ instruction: 'test', metadata: { key: 'val' } }).success,
    );
  });

  it('SubscribeToStreamRequest defaults lastAcknowledgedSeq to 0', () => {
    const result = SubscribeToStreamRequest.safeParse({
      conversationId: 'c-1',
      turnId: 'turn-1',
    });
    assert.ok(result.success);
    assert.equal(result.data.lastAcknowledgedSeq, 0);
  });

  it('LoadTurnHistoryRequest accepts range parameters', () => {
    assert.ok(
      LoadTurnHistoryRequest.safeParse({
        conversationId: 'c-1',
        fromPosition: 1,
        toPosition: 50,
      }).success,
    );
  });

  it('LoadTurnHistoryResponse validates structure', () => {
    assert.ok(
      LoadTurnHistoryResponse.safeParse({
        turns: [validTurn],
        totalCount: 1,
        hasMore: false,
      }).success,
    );
  });
});

// ── Contract Family 3: Approval Flow ─────────────────────────────────────────

describe('Approval Flow contracts', () => {
  it('GetPendingApprovalsRequest requires conversationId', () => {
    assert.ok(!GetPendingApprovalsRequest.safeParse({}).success);
    assert.ok(GetPendingApprovalsRequest.safeParse({ conversationId: 'c-1' }).success);
  });

  it('GetPendingApprovalsResponse validates approval array', () => {
    assert.ok(GetPendingApprovalsResponse.safeParse({ approvals: [validApproval] }).success);
  });

  it('RespondToApprovalRequest body contains only response fields (no approvalId or sessionId)', () => {
    // Body without response must fail
    assert.ok(!RespondToApprovalRequest.safeParse({}).success);

    // Minimal valid body — only `response` is required
    assert.ok(RespondToApprovalRequest.safeParse({ response: 'approve' }).success);

    // approvalId comes from the URL path, sessionId from X-Session-Id header —
    // neither belongs in the body schema and both must be stripped.
    const parsed = RespondToApprovalRequest.safeParse({
      response: 'approve',
      approvalId: 'a-1',
      sessionId: 'sess-1',
    });
    assert.ok(parsed.success, 'extra fields should not fail parse');
    assert.equal(
      (parsed.data as Record<string, unknown>)['approvalId'],
      undefined,
      'approvalId must be stripped — it comes from the URL path',
    );
    assert.equal(
      (parsed.data as Record<string, unknown>)['sessionId'],
      undefined,
      'sessionId must be stripped — it comes from the X-Session-Id header',
    );
  });

  it('RespondToApprovalResponse includes optional conflict notification', () => {
    const result = RespondToApprovalResponse.safeParse({
      success: false,
      approval: { ...validApproval, status: 'responded', response: 'approve' },
      conflictNotification: {
        message: 'Already responded by another session',
      },
    });
    assert.ok(result.success);
  });

  it('RespondToApprovalResponse rejects conflictingSessionId in notification', () => {
    const result = RespondToApprovalResponse.safeParse({
      success: false,
      approval: { ...validApproval, status: 'responded', response: 'approve' },
      conflictNotification: {
        conflictingSessionId: 'sess-2',
        message: 'Already responded by another session',
      },
    });
    // conflictingSessionId is not in the schema — it should be stripped by default
    // (non-strict object), confirming it never reaches the browser
    assert.ok(result.success);
    const parsed = result.data as { conflictNotification?: Record<string, unknown> };
    assert.equal(
      parsed.conflictNotification?.['conflictingSessionId'],
      undefined,
      'conflictingSessionId must not appear in parsed response',
    );
  });
});

// ── Contract Family 4: Work Control ──────────────────────────────────────────

describe('Work Control contracts', () => {
  it('CancelWorkRequest requires both ids', () => {
    assert.ok(!CancelWorkRequest.safeParse({ conversationId: 'c-1' }).success);
    assert.ok(CancelWorkRequest.safeParse({ conversationId: 'c-1', turnId: 'turn-1' }).success);
  });

  it('RetryTurnRequest requires both ids', () => {
    assert.ok(RetryTurnRequest.safeParse({ conversationId: 'c-1', turnId: 'turn-1' }).success);
  });

  it('ForkConversationRequest requires conversationId and forkPointTurnId', () => {
    assert.ok(
      ForkConversationRequest.safeParse({
        conversationId: 'c-1',
        forkPointTurnId: 'turn-3',
      }).success,
    );
  });

  it('ManageQueueRequest validates action enum', () => {
    for (const action of ['list', 'reorder', 'remove']) {
      assert.ok(
        ManageQueueRequest.safeParse({ conversationId: 'c-1', action }).success,
        `${action} should be valid`,
      );
    }
    assert.ok(!ManageQueueRequest.safeParse({ conversationId: 'c-1', action: 'clear' }).success);
  });

  it('QueuedInstruction validates structure', () => {
    assert.ok(
      QueuedInstruction.safeParse({
        id: 'qi-1',
        instruction: 'Do something',
        queuedAt: NOW,
      }).success,
    );
  });

  it('ManageQueueResponse returns queue array', () => {
    assert.ok(
      ManageQueueResponse.safeParse({
        queue: [{ id: 'qi-1', instruction: 'Do', queuedAt: NOW }],
      }).success,
    );
  });
});

// ── Contract Family 5: Artifact Access ───────────────────────────────────────

describe('Artifact Access contracts', () => {
  it('ListArtifactsForTurnRequest requires turnId', () => {
    assert.ok(!ListArtifactsForTurnRequest.safeParse({}).success);
    assert.ok(ListArtifactsForTurnRequest.safeParse({ turnId: 'turn-1' }).success);
  });

  it('GetArtifactContentRequest requires artifactId', () => {
    assert.ok(GetArtifactContentRequest.safeParse({ artifactId: 'art-1' }).success);
  });

  it('ListArtifactsForConversationRequest accepts filters and pagination', () => {
    assert.ok(
      ListArtifactsForConversationRequest.safeParse({
        conversationId: 'c-1',
        kind: 'file',
        limit: 10,
      }).success,
    );
  });

  it('ListArtifactsForConversationResponse validates structure', () => {
    assert.ok(
      ListArtifactsForConversationResponse.safeParse({
        artifacts: [validArtifact],
        totalCount: 1,
      }).success,
    );
  });
});

// ── Contract Family 6: Multi-Agent Activity ──────────────────────────────────

describe('Multi-Agent Activity contracts', () => {
  it('GetActivityEntriesRequest requires turnId', () => {
    assert.ok(!GetActivityEntriesRequest.safeParse({}).success);
    assert.ok(GetActivityEntriesRequest.safeParse({ turnId: 'turn-1' }).success);
  });

  it('FilterActivityByAgentRequest requires turnId and agentId', () => {
    assert.ok(!FilterActivityByAgentRequest.safeParse({ turnId: 'turn-1' }).success);
    assert.ok(
      FilterActivityByAgentRequest.safeParse({ turnId: 'turn-1', agentId: 'claude' }).success,
    );
  });
});

// ── Shared Error Response ────────────────────────────────────────────────────

describe('Error Response', () => {
  it('validates all error codes', () => {
    const codes = [
      'NOT_FOUND',
      'INVALID_INPUT',
      'CONFLICT',
      'ARCHIVED',
      'STALE_APPROVAL',
      'APPROVAL_ALREADY_RESPONDED',
      'TURN_NOT_TERMINAL',
      'TURN_NOT_ACTIVE',
      'QUEUE_FULL',
      'INTERNAL_ERROR',
    ];
    for (const code of codes) {
      assert.ok(ErrorCode.safeParse(code).success, `${code} should be valid`);
    }
  });

  it('ErrorResponse requires ok: false', () => {
    assert.ok(
      !ErrorResponse.safeParse({
        ok: true,
        error: 'NOT_FOUND',
        message: 'Not found',
      }).success,
    );
    assert.ok(
      ErrorResponse.safeParse({
        ok: false,
        error: 'NOT_FOUND',
        message: 'Not found',
        conversationId: 'c-1',
      }).success,
    );
  });

  it('ErrorResponse includes optional context ids', () => {
    const result = ErrorResponse.safeParse({
      ok: false,
      error: 'TURN_NOT_ACTIVE',
      message: 'Turn is not active',
      conversationId: 'c-1',
      turnId: 'turn-1',
    });
    assert.ok(result.success);
  });
});
