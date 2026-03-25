/**
 * Unit tests for operations entity Zod schemas.
 *
 * Covers all shared operations DTOs defined in operations.ts:
 * WorkQueueItemView, CheckpointRecordView, DaemonHealthView, BudgetStatusView,
 * RoutingDecisionView, AgentAssignmentView, CouncilExecutionView,
 * OperationalControlView, PendingControlRequest, and supporting enums/value types.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  WorkItemStatus,
  RiskSignal,
  WorkQueueItemView,
  CheckpointStatus,
  CheckpointRecordView,
  DaemonHealthStatus,
  DaemonHealthView,
  BudgetSeverity,
  BudgetScope,
  BudgetStatusView,
  RoutingHistoryEntry,
  RoutingDecisionView,
  AgentAssignmentState,
  AgentAssignmentView,
  CouncilExecutionStatus,
  CouncilTransitionView,
  CouncilExecutionView,
  ControlKind,
  ControlAvailability,
  ControlAuthority,
  ControlOptionView,
  OperationalControlView,
  PendingControlRequest,
  SnapshotStatus,
  WorkspaceFreshness,
  WorkspaceAvailability,
} from '../operations.ts';
import {
  GetOperationsSnapshotRequest,
  GetOperationsSnapshotResponse,
} from '../contracts/operations-read.ts';
import {
  SubmitControlActionResponse,
  WorkItemControlEntry,
} from '../contracts/operations-control.ts';
import * as webContracts from '../index.ts';

const NOW = '2025-07-14T00:00:00.000Z';

// ── Enum coverage ────────────────────────────────────────────────────────────

describe('WorkItemStatus enum', () => {
  const all = ['waiting', 'active', 'paused', 'blocked', 'completed', 'failed', 'cancelled'];

  it(`has exactly ${all.length} members`, () => {
    assert.equal(WorkItemStatus.options.length, all.length);
  });

  for (const s of all) {
    it(`accepts: ${s}`, () => {
      assert.equal(WorkItemStatus.parse(s), s);
    });
  }

  it('rejects invalid value', () => {
    assert.throws(() => WorkItemStatus.parse('running'));
  });
});

describe('CheckpointStatus enum', () => {
  const all = ['reached', 'waiting', 'resumed', 'recovered', 'skipped'];

  it(`has exactly ${all.length} members`, () => {
    assert.equal(CheckpointStatus.options.length, all.length);
  });

  for (const s of all) {
    it(`accepts: ${s}`, () => {
      assert.equal(CheckpointStatus.parse(s), s);
    });
  }

  it('rejects invalid value', () => {
    assert.throws(() => CheckpointStatus.parse('done'));
  });
});

describe('DaemonHealthStatus enum', () => {
  const all = ['healthy', 'degraded', 'unavailable', 'recovering'];

  it(`has exactly ${all.length} members`, () => {
    assert.equal(DaemonHealthStatus.options.length, all.length);
  });

  for (const s of all) {
    it(`accepts: ${s}`, () => {
      assert.equal(DaemonHealthStatus.parse(s), s);
    });
  }

  it('rejects invalid value', () => {
    assert.throws(() => DaemonHealthStatus.parse('unknown'));
  });
});

describe('BudgetSeverity enum', () => {
  const all = ['normal', 'warning', 'exceeded', 'unavailable'];

  it(`has exactly ${all.length} members`, () => {
    assert.equal(BudgetSeverity.options.length, all.length);
  });

  for (const s of all) {
    it(`accepts: ${s}`, () => {
      assert.equal(BudgetSeverity.parse(s), s);
    });
  }
});

describe('BudgetScope enum', () => {
  const all = ['global', 'work-item', 'session'];

  it(`has exactly ${all.length} members`, () => {
    assert.equal(BudgetScope.options.length, all.length);
  });

  for (const s of all) {
    it(`accepts: ${s}`, () => {
      assert.equal(BudgetScope.parse(s), s);
    });
  }
});

describe('ControlAvailability enum', () => {
  const all = [
    'actionable',
    'pending',
    'read-only',
    'unavailable',
    'stale',
    'accepted',
    'rejected',
    'superseded',
  ];

  it(`has exactly ${all.length} members`, () => {
    assert.equal(ControlAvailability.options.length, all.length);
  });

  for (const s of all) {
    it(`accepts: ${s}`, () => {
      assert.equal(ControlAvailability.parse(s), s);
    });
  }
});

describe('ControlKind enum', () => {
  const all = ['routing', 'mode', 'agent', 'council'];

  it(`has exactly ${all.length} members`, () => {
    assert.equal(ControlKind.options.length, all.length);
  });

  for (const s of all) {
    it(`accepts: ${s}`, () => {
      assert.equal(ControlKind.parse(s), s);
    });
  }
});

describe('ControlAuthority enum', () => {
  const all = ['granted', 'forbidden', 'unavailable'];

  it(`has exactly ${all.length} members`, () => {
    assert.equal(ControlAuthority.options.length, all.length);
  });

  for (const s of all) {
    it(`accepts: ${s}`, () => {
      assert.equal(ControlAuthority.parse(s), s);
    });
  }
});

describe('SnapshotStatus enum', () => {
  const all = ['idle', 'loading', 'ready', 'error'];

  for (const s of all) {
    it(`accepts: ${s}`, () => {
      assert.equal(SnapshotStatus.parse(s), s);
    });
  }
});

describe('WorkspaceFreshness enum', () => {
  const all = ['live', 'refreshing', 'stale'];

  for (const s of all) {
    it(`accepts: ${s}`, () => {
      assert.equal(WorkspaceFreshness.parse(s), s);
    });
  }
});

describe('WorkspaceAvailability enum', () => {
  const all = ['ready', 'empty', 'partial', 'unavailable'];

  for (const s of all) {
    it(`accepts: ${s}`, () => {
      assert.equal(WorkspaceAvailability.parse(s), s);
    });
  }
});

// ── RiskSignal ───────────────────────────────────────────────────────────────

describe('RiskSignal', () => {
  const valid = { kind: 'budget', severity: 'warning', summary: 'Over 80%', scope: 'work-item' };

  it('accepts valid risk signal', () => {
    const result = RiskSignal.safeParse(valid);
    assert.ok(result.success);
  });

  it('rejects empty summary', () => {
    assert.ok(!RiskSignal.safeParse({ ...valid, summary: '' }).success);
  });

  it('rejects unknown fields (strict)', () => {
    assert.ok(!RiskSignal.safeParse({ ...valid, extra: true }).success);
  });
});

// ── WorkQueueItemView ────────────────────────────────────────────────────────

describe('WorkQueueItemView', () => {
  const valid = {
    id: 'wq-1',
    title: 'Implement auth module',
    status: 'active' as const,
    position: 0,
    relatedConversationId: 'conv-1',
    relatedSessionId: 'sess-1',
    ownerLabel: 'Claude',
    lastCheckpointSummary: 'Running tests',
    updatedAt: NOW,
    riskSignals: [],
    detailAvailability: 'ready' as const,
  };

  it('accepts fully populated item', () => {
    const result = WorkQueueItemView.safeParse(valid);
    assert.ok(result.success);
    assert.equal(result.data.id, 'wq-1');
  });

  it('accepts nullable fields as null', () => {
    const result = WorkQueueItemView.safeParse({
      ...valid,
      position: null,
      relatedConversationId: null,
      relatedSessionId: null,
      ownerLabel: null,
      lastCheckpointSummary: null,
    });
    assert.ok(result.success);
  });

  it('accepts item with risk signals', () => {
    const result = WorkQueueItemView.safeParse({
      ...valid,
      riskSignals: [
        { kind: 'budget', severity: 'warning', summary: 'Near limit', scope: 'work-item' },
      ],
    });
    assert.ok(result.success);
    assert.equal(result.data.riskSignals.length, 1);
  });

  it('rejects empty id', () => {
    assert.ok(!WorkQueueItemView.safeParse({ ...valid, id: '' }).success);
  });

  it('rejects empty title', () => {
    assert.ok(!WorkQueueItemView.safeParse({ ...valid, title: '' }).success);
  });

  it('rejects invalid status', () => {
    assert.ok(!WorkQueueItemView.safeParse({ ...valid, status: 'running' }).success);
  });

  it('rejects unknown fields (strict)', () => {
    assert.ok(!WorkQueueItemView.safeParse({ ...valid, extra: true }).success);
  });

  it('roundtrips through parse', () => {
    const result = WorkQueueItemView.parse(valid);
    const reparsed = WorkQueueItemView.parse(result);
    assert.deepStrictEqual(result, reparsed);
  });
});

// ── CheckpointRecordView ─────────────────────────────────────────────────────

describe('CheckpointRecordView', () => {
  const valid = {
    id: 'cp-1',
    sequence: 0,
    label: 'Tests passed',
    status: 'reached' as const,
    timestamp: NOW,
    detail: null,
  };

  it('accepts valid checkpoint', () => {
    const result = CheckpointRecordView.safeParse(valid);
    assert.ok(result.success);
  });

  it('accepts checkpoint with detail', () => {
    const result = CheckpointRecordView.safeParse({ ...valid, detail: 'All 42 tests green' });
    assert.ok(result.success);
    assert.equal(result.data.detail, 'All 42 tests green');
  });

  it('rejects empty label', () => {
    assert.ok(!CheckpointRecordView.safeParse({ ...valid, label: '' }).success);
  });

  it('rejects negative sequence', () => {
    assert.ok(!CheckpointRecordView.safeParse({ ...valid, sequence: -1 }).success);
  });

  it('rejects unknown fields (strict)', () => {
    assert.ok(!CheckpointRecordView.safeParse({ ...valid, extra: true }).success);
  });
});

// ── DaemonHealthView ─────────────────────────────────────────────────────────

describe('DaemonHealthView', () => {
  const valid = {
    status: 'healthy' as const,
    scope: 'global' as const,
    observedAt: NOW,
    message: null,
    detailsAvailability: 'ready' as const,
  };

  it('accepts valid healthy snapshot', () => {
    const result = DaemonHealthView.safeParse(valid);
    assert.ok(result.success);
  });

  it('accepts degraded with message', () => {
    const result = DaemonHealthView.safeParse({
      ...valid,
      status: 'degraded',
      message: 'Agent pool reduced',
    });
    assert.ok(result.success);
  });

  it('rejects non-global scope', () => {
    assert.ok(!DaemonHealthView.safeParse({ ...valid, scope: 'local' }).success);
  });

  it('rejects unknown fields (strict)', () => {
    assert.ok(!DaemonHealthView.safeParse({ ...valid, extra: true }).success);
  });
});

// ── BudgetStatusView ─────────────────────────────────────────────────────────

describe('BudgetStatusView', () => {
  const globalBudget = {
    status: 'normal' as const,
    scope: 'global' as const,
    scopeId: null,
    summary: 'Under budget',
    used: 1000,
    limit: 5000,
    unit: 'tokens',
    complete: true,
  };

  it('accepts valid global budget', () => {
    const result = BudgetStatusView.safeParse(globalBudget);
    assert.ok(result.success);
  });

  it('accepts work-item scoped budget with scopeId', () => {
    const result = BudgetStatusView.safeParse({
      ...globalBudget,
      scope: 'work-item',
      scopeId: 'wq-1',
    });
    assert.ok(result.success);
  });

  it('rejects work-item scope without scopeId', () => {
    const result = BudgetStatusView.safeParse({
      ...globalBudget,
      scope: 'work-item',
      scopeId: null,
    });
    assert.ok(!result.success, 'scopeId required for non-global scope');
  });

  it('rejects session scope without scopeId', () => {
    const result = BudgetStatusView.safeParse({
      ...globalBudget,
      scope: 'session',
      scopeId: null,
    });
    assert.ok(!result.success, 'scopeId required for non-global scope');
  });

  it('accepts nullable numeric fields', () => {
    const result = BudgetStatusView.safeParse({
      ...globalBudget,
      used: null,
      limit: null,
      unit: null,
    });
    assert.ok(result.success);
  });

  it('rejects empty summary', () => {
    assert.ok(!BudgetStatusView.safeParse({ ...globalBudget, summary: '' }).success);
  });

  it('rejects unknown fields (strict)', () => {
    assert.ok(!BudgetStatusView.safeParse({ ...globalBudget, extra: true }).success);
  });
});

// ── RoutingDecisionView ──────────────────────────────────────────────────────

describe('RoutingDecisionView', () => {
  const valid = {
    currentMode: 'auto',
    currentRoute: 'claude',
    changedAt: NOW,
    history: [],
  };

  it('accepts valid routing with empty history', () => {
    const result = RoutingDecisionView.safeParse(valid);
    assert.ok(result.success);
  });

  it('accepts all-null routing (no decision yet)', () => {
    const result = RoutingDecisionView.safeParse({
      currentMode: null,
      currentRoute: null,
      changedAt: null,
      history: [],
    });
    assert.ok(result.success);
  });

  it('accepts routing with history entries', () => {
    const result = RoutingDecisionView.safeParse({
      ...valid,
      history: [
        {
          id: 'rh-1',
          route: 'gemini',
          mode: 'smart',
          changedAt: NOW,
          reason: 'Economy mode',
        },
      ],
    });
    assert.ok(result.success);
    assert.equal(result.data.history.length, 1);
  });

  it('rejects unknown fields (strict)', () => {
    assert.ok(!RoutingDecisionView.safeParse({ ...valid, extra: true }).success);
  });
});

describe('RoutingHistoryEntry', () => {
  const valid = {
    id: 'rh-1',
    route: 'claude',
    mode: 'auto',
    changedAt: NOW,
    reason: null,
  };

  it('accepts valid entry', () => {
    const result = RoutingHistoryEntry.safeParse(valid);
    assert.ok(result.success);
  });

  it('rejects empty id', () => {
    assert.ok(!RoutingHistoryEntry.safeParse({ ...valid, id: '' }).success);
  });

  it('rejects unknown fields (strict)', () => {
    assert.ok(!RoutingHistoryEntry.safeParse({ ...valid, extra: true }).success);
  });
});

// ── AgentAssignmentView ──────────────────────────────────────────────────────

describe('AgentAssignmentView', () => {
  const valid = {
    participantId: 'claude',
    label: 'Claude',
    role: 'architect',
    state: 'active' as const,
    startedAt: NOW,
    endedAt: null,
  };

  it('accepts valid assignment', () => {
    const result = AgentAssignmentView.safeParse(valid);
    assert.ok(result.success);
  });

  it('accepts all nullable fields as null', () => {
    const result = AgentAssignmentView.safeParse({
      ...valid,
      role: null,
      startedAt: null,
      endedAt: null,
    });
    assert.ok(result.success);
  });

  it('validates all assignment states', () => {
    for (const s of ['active', 'waiting', 'completed', 'failed', 'cancelled']) {
      assert.ok(AgentAssignmentState.safeParse(s).success, `${s} should be valid`);
    }
  });

  it('rejects empty participantId', () => {
    assert.ok(!AgentAssignmentView.safeParse({ ...valid, participantId: '' }).success);
  });

  it('rejects unknown fields (strict)', () => {
    assert.ok(!AgentAssignmentView.safeParse({ ...valid, extra: true }).success);
  });
});

// ── CouncilExecutionView ─────────────────────────────────────────────────────

describe('CouncilExecutionView', () => {
  const validParticipant = {
    participantId: 'gemini',
    label: 'Gemini',
    role: 'analyst',
    state: 'completed' as const,
    startedAt: NOW,
    endedAt: NOW,
  };

  const validTransition = {
    id: 'ct-1',
    label: 'Round 1 complete',
    status: 'completed',
    timestamp: NOW,
    detail: null,
  };

  const valid = {
    status: 'active' as const,
    participants: [validParticipant],
    transitions: [validTransition],
    finalOutcome: null,
  };

  it('accepts valid council execution', () => {
    const result = CouncilExecutionView.safeParse(valid);
    assert.ok(result.success);
  });

  it('accepts empty participants and transitions', () => {
    const result = CouncilExecutionView.safeParse({
      ...valid,
      participants: [],
      transitions: [],
    });
    assert.ok(result.success);
  });

  it('accepts completed with finalOutcome', () => {
    const result = CouncilExecutionView.safeParse({
      ...valid,
      status: 'completed',
      finalOutcome: 'Consensus reached',
    });
    assert.ok(result.success);
    assert.equal(result.data.finalOutcome, 'Consensus reached');
  });

  it('validates all council execution statuses', () => {
    for (const s of ['active', 'waiting', 'completed', 'failed', 'cancelled']) {
      assert.ok(CouncilExecutionStatus.safeParse(s).success, `${s} should be valid`);
    }
  });

  it('rejects unknown fields (strict)', () => {
    assert.ok(!CouncilExecutionView.safeParse({ ...valid, extra: true }).success);
  });
});

describe('CouncilTransitionView', () => {
  const valid = {
    id: 'ct-1',
    label: 'Phase transition',
    status: 'reached',
    timestamp: NOW,
    detail: 'Moving to voting',
  };

  it('accepts valid transition', () => {
    const result = CouncilTransitionView.safeParse(valid);
    assert.ok(result.success);
  });

  it('accepts null detail', () => {
    const result = CouncilTransitionView.safeParse({ ...valid, detail: null });
    assert.ok(result.success);
  });

  it('rejects empty label', () => {
    assert.ok(!CouncilTransitionView.safeParse({ ...valid, label: '' }).success);
  });
});

// ── OperationalControlView ───────────────────────────────────────────────────

describe('OperationalControlView', () => {
  const validOption = {
    optionId: 'opt-1',
    label: 'Use Claude',
    selected: true,
    available: true,
  };

  const valid = {
    controlId: 'ctrl-1',
    kind: 'agent' as const,
    label: 'Agent selection',
    availability: 'actionable' as const,
    authority: 'granted' as const,
    reason: null,
    options: [validOption],
    expectedRevision: 'rev-1',
    lastResolvedAt: null,
  };

  it('accepts valid actionable control', () => {
    const result = OperationalControlView.safeParse(valid);
    assert.ok(result.success);
  });

  it('accepts read-only control with reason', () => {
    const result = OperationalControlView.safeParse({
      ...valid,
      availability: 'read-only',
      authority: 'forbidden',
      reason: 'Operator not authorized',
    });
    assert.ok(result.success);
  });

  it('accepts control with empty options', () => {
    const result = OperationalControlView.safeParse({
      ...valid,
      options: [],
    });
    assert.ok(result.success);
  });

  it('rejects empty controlId', () => {
    assert.ok(!OperationalControlView.safeParse({ ...valid, controlId: '' }).success);
  });

  it('rejects unknown fields (strict)', () => {
    assert.ok(!OperationalControlView.safeParse({ ...valid, extra: true }).success);
  });
});

describe('ControlOptionView', () => {
  const valid = { optionId: 'opt-1', label: 'Use Claude', selected: false, available: true };

  it('accepts valid option', () => {
    const result = ControlOptionView.safeParse(valid);
    assert.ok(result.success);
  });

  it('rejects empty optionId', () => {
    assert.ok(!ControlOptionView.safeParse({ ...valid, optionId: '' }).success);
  });

  it('rejects unknown fields (strict)', () => {
    assert.ok(!ControlOptionView.safeParse({ ...valid, extra: true }).success);
  });
});

// ── PendingControlRequest ────────────────────────────────────────────────────

describe('PendingControlRequest', () => {
  const valid = {
    requestId: 'req-1',
    workItemId: 'wq-1',
    controlId: 'ctrl-1',
    submittedAt: NOW,
    requestedOptionId: 'opt-1',
  };

  it('accepts valid pending request', () => {
    const result = PendingControlRequest.safeParse(valid);
    assert.ok(result.success);
  });

  it('rejects empty requestId', () => {
    assert.ok(!PendingControlRequest.safeParse({ ...valid, requestId: '' }).success);
  });

  it('rejects missing fields', () => {
    const { controlId: _, ...partial } = valid;
    assert.ok(!PendingControlRequest.safeParse(partial).success);
  });

  it('rejects unknown fields (strict)', () => {
    assert.ok(!PendingControlRequest.safeParse({ ...valid, extra: true }).success);
  });
});

describe('Operations read contracts', () => {
  it('accepts repeated work-item statuses in snapshot filters', () => {
    const result = GetOperationsSnapshotRequest.safeParse({
      statusFilter: ['active', 'paused'],
      limit: 10,
      cursor: 'cursor-1',
    });
    assert.ok(result.success);
    assert.deepStrictEqual(result.data.statusFilter, ['active', 'paused']);
  });

  it('accepts a valid operations snapshot response', () => {
    const result = GetOperationsSnapshotResponse.safeParse({
      queue: [],
      health: null,
      budget: null,
      availability: 'ready',
      lastSynchronizedAt: NOW,
      nextCursor: null,
    });
    assert.ok(result.success);
  });
});

describe('Operations control contracts', () => {
  it('accepts authoritative control responses without browser-local pending state', () => {
    const result = SubmitControlActionResponse.safeParse({
      outcome: 'accepted',
      control: {
        controlId: 'ctrl-1',
        kind: 'routing',
        label: 'Route work item',
        availability: 'accepted',
        authority: 'granted',
        reason: null,
        options: [],
        expectedRevision: 'rev-2',
        lastResolvedAt: NOW,
      },
      workItemId: 'wq-1',
      resolvedAt: NOW,
      message: 'Rerouted to Claude',
    });
    assert.ok(result.success);
  });

  it('rejects browser-local pending state on authoritative control responses', () => {
    const result = SubmitControlActionResponse.safeParse({
      outcome: 'accepted',
      control: {
        controlId: 'ctrl-1',
        kind: 'routing',
        label: 'Route work item',
        availability: 'accepted',
        authority: 'granted',
        reason: null,
        options: [],
        expectedRevision: 'rev-2',
        lastResolvedAt: NOW,
      },
      workItemId: 'wq-1',
      resolvedAt: NOW,
      pendingRequest: {
        requestId: 'req-1',
        workItemId: 'wq-1',
        controlId: 'ctrl-1',
        submittedAt: NOW,
        requestedOptionId: 'opt-1',
      },
    });
    assert.ok(!result.success);
  });

  it('accepts detail-scoped control discovery entries', () => {
    const result = WorkItemControlEntry.safeParse({
      workItemId: 'wq-1',
      controls: [],
      availability: 'partial',
    });
    assert.ok(result.success);
  });
});

describe('Operations contract barrel exports', () => {
  it('re-exports the read and control contracts from the package index', () => {
    assert.equal(webContracts.GetOperationsSnapshotRequest, GetOperationsSnapshotRequest);
    assert.equal(webContracts.SubmitControlActionResponse, SubmitControlActionResponse);
    assert.equal(webContracts.WorkItemControlEntry, WorkItemControlEntry);
  });
});
