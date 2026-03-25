/**
 * Conformance tests for operations entity schemas — run from repo root.
 *
 * Validates that operations DTOs in packages/web-contracts/src/operations.ts
 * conform to the data-model specification: correct enums, field validation,
 * strict schemas, nullable semantics, refinement rules, and roundtrip stability.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  WorkItemStatus,
  WorkQueueItemView,
  CheckpointStatus,
  CheckpointRecordView,
  DaemonHealthStatus,
  DaemonHealthView,
  BudgetSeverity,
  BudgetScope,
  BudgetStatusView,
  RoutingDecisionView,
  AgentAssignmentState,
  CouncilExecutionView,
  CouncilExecutionStatus,
  OperationalControlView,
  ControlKind,
  ControlAvailability,
  ControlAuthority,
  RiskSignal,
  SnapshotStatus,
  WorkspaceFreshness,
  WorkspaceAvailability,
} from '../../packages/web-contracts/src/operations.ts';

const NOW = '2025-07-14T00:00:00.000Z';

// ── Conformance: Enum membership ─────────────────────────────────────────────

describe('Operations enum conformance', () => {
  it('WorkItemStatus matches spec statuses', () => {
    const expected = ['waiting', 'active', 'paused', 'blocked', 'completed', 'failed', 'cancelled'];
    assert.deepStrictEqual([...WorkItemStatus.options].sort(), [...expected].sort());
  });

  it('CheckpointStatus matches spec statuses', () => {
    const expected = ['reached', 'waiting', 'resumed', 'recovered', 'skipped'];
    assert.deepStrictEqual([...CheckpointStatus.options].sort(), [...expected].sort());
  });

  it('DaemonHealthStatus matches spec statuses', () => {
    const expected = ['healthy', 'degraded', 'unavailable', 'recovering'];
    assert.deepStrictEqual([...DaemonHealthStatus.options].sort(), [...expected].sort());
  });

  it('BudgetSeverity matches spec tiers', () => {
    const expected = ['normal', 'warning', 'exceeded', 'unavailable'];
    assert.deepStrictEqual([...BudgetSeverity.options].sort(), [...expected].sort());
  });

  it('BudgetScope matches spec scopes', () => {
    const expected = ['global', 'work-item', 'session'];
    assert.deepStrictEqual([...BudgetScope.options].sort(), [...expected].sort());
  });

  it('ControlKind matches spec families', () => {
    const expected = ['routing', 'mode', 'agent', 'council'];
    assert.deepStrictEqual([...ControlKind.options].sort(), [...expected].sort());
  });

  it('ControlAvailability matches spec vocabulary', () => {
    const expected = [
      'actionable',
      'pending',
      'read-only',
      'unavailable',
      'stale',
      'accepted',
      'rejected',
      'superseded',
    ];
    assert.deepStrictEqual([...ControlAvailability.options].sort(), [...expected].sort());
  });

  it('ControlAuthority matches spec vocabulary', () => {
    const expected = ['granted', 'forbidden', 'unavailable'];
    assert.deepStrictEqual([...ControlAuthority.options].sort(), [...expected].sort());
  });

  it('AgentAssignmentState matches spec', () => {
    const expected = ['active', 'waiting', 'completed', 'failed', 'cancelled'];
    assert.deepStrictEqual([...AgentAssignmentState.options].sort(), [...expected].sort());
  });

  it('CouncilExecutionStatus matches spec', () => {
    const expected = ['active', 'waiting', 'completed', 'failed', 'cancelled'];
    assert.deepStrictEqual([...CouncilExecutionStatus.options].sort(), [...expected].sort());
  });

  it('SnapshotStatus matches spec', () => {
    const expected = ['idle', 'loading', 'ready', 'error'];
    assert.deepStrictEqual([...SnapshotStatus.options].sort(), [...expected].sort());
  });

  it('WorkspaceFreshness matches spec', () => {
    const expected = ['live', 'refreshing', 'stale'];
    assert.deepStrictEqual([...WorkspaceFreshness.options].sort(), [...expected].sort());
  });

  it('WorkspaceAvailability matches spec', () => {
    const expected = ['ready', 'empty', 'partial', 'unavailable'];
    assert.deepStrictEqual([...WorkspaceAvailability.options].sort(), [...expected].sort());
  });
});

// ── Conformance: WorkQueueItemView ───────────────────────────────────────────

describe('WorkQueueItemView conformance', () => {
  const minimal = {
    id: 'wq-1',
    title: 'Task',
    status: 'waiting' as const,
    position: null,
    relatedConversationId: null,
    relatedSessionId: null,
    ownerLabel: null,
    lastCheckpointSummary: null,
    updatedAt: NOW,
    riskSignals: [],
    detailAvailability: 'unavailable' as const,
  };

  it('accepts minimal work item with all nulls', () => {
    assert.ok(WorkQueueItemView.safeParse(minimal).success);
  });

  it('roundtrips through parse without data loss', () => {
    const full = {
      ...minimal,
      position: 3,
      relatedConversationId: 'conv-1',
      relatedSessionId: 'sess-1',
      ownerLabel: 'Operator',
      lastCheckpointSummary: 'Linting',
      riskSignals: [{ kind: 'health', severity: 'critical', summary: 'Degraded', scope: 'global' }],
      detailAvailability: 'ready' as const,
    };
    const first = WorkQueueItemView.parse(full);
    const second = WorkQueueItemView.parse(first);
    assert.deepStrictEqual(first, second);
  });

  it('every status value produces a parseable item', () => {
    for (const status of WorkItemStatus.options) {
      const result = WorkQueueItemView.safeParse({ ...minimal, status });
      assert.ok(result.success, `status ${status} should produce a valid item`);
    }
  });
});

// ── Conformance: CheckpointRecordView ────────────────────────────────────────

describe('CheckpointRecordView conformance', () => {
  it('every status produces a parseable checkpoint', () => {
    for (const status of CheckpointStatus.options) {
      const result = CheckpointRecordView.safeParse({
        id: `cp-${status}`,
        sequence: 0,
        label: `Checkpoint ${status}`,
        status,
        timestamp: NOW,
        detail: null,
      });
      assert.ok(result.success, `status ${status} should produce a valid checkpoint`);
    }
  });
});

// ── Conformance: BudgetStatusView refinement ─────────────────────────────────

describe('BudgetStatusView refinement conformance', () => {
  const base = {
    status: 'normal' as const,
    summary: 'OK',
    used: null,
    limit: null,
    unit: null,
    complete: true,
  };

  it('global scope allows null scopeId', () => {
    assert.ok(BudgetStatusView.safeParse({ ...base, scope: 'global', scopeId: null }).success);
  });

  it('work-item scope requires non-null scopeId', () => {
    assert.ok(!BudgetStatusView.safeParse({ ...base, scope: 'work-item', scopeId: null }).success);
    assert.ok(BudgetStatusView.safeParse({ ...base, scope: 'work-item', scopeId: 'wq-1' }).success);
  });

  it('session scope requires non-null scopeId', () => {
    assert.ok(!BudgetStatusView.safeParse({ ...base, scope: 'session', scopeId: null }).success);
    assert.ok(BudgetStatusView.safeParse({ ...base, scope: 'session', scopeId: 'sess-1' }).success);
  });
});

// ── Conformance: DaemonHealthView ────────────────────────────────────────────

describe('DaemonHealthView conformance', () => {
  it('scope is always global (literal)', () => {
    const result = DaemonHealthView.safeParse({
      status: 'healthy',
      scope: 'work-item',
      observedAt: NOW,
      message: null,
      detailsAvailability: 'ready',
    });
    assert.ok(!result.success, 'non-global scope must be rejected');
  });

  it('every health status produces a parseable snapshot', () => {
    for (const status of DaemonHealthStatus.options) {
      const result = DaemonHealthView.safeParse({
        status,
        scope: 'global',
        observedAt: NOW,
        message: null,
        detailsAvailability: 'ready',
      });
      assert.ok(result.success, `status ${status} should produce a valid health snapshot`);
    }
  });
});

// ── Conformance: RoutingDecisionView ─────────────────────────────────────────

describe('RoutingDecisionView conformance', () => {
  it('history entries preserve order via array position', () => {
    const entries = Array.from({ length: 3 }, (_, i) => ({
      id: `rh-${i}`,
      route: `agent-${i}`,
      mode: null,
      changedAt: NOW,
      reason: null,
    }));
    const result = RoutingDecisionView.safeParse({
      currentMode: null,
      currentRoute: null,
      changedAt: null,
      history: entries,
    });
    assert.ok(result.success);
    assert.equal(result.data.history.length, 3);
    assert.equal(result.data.history[0].id, 'rh-0');
    assert.equal(result.data.history[2].id, 'rh-2');
  });
});

// ── Conformance: CouncilExecutionView ────────────────────────────────────────

describe('CouncilExecutionView conformance', () => {
  it('accepts completed council with outcome and full participant list', () => {
    const result = CouncilExecutionView.safeParse({
      status: 'completed',
      participants: [
        {
          participantId: 'claude',
          label: 'Claude',
          role: 'architect',
          state: 'completed',
          startedAt: NOW,
          endedAt: NOW,
        },
        {
          participantId: 'gemini',
          label: 'Gemini',
          role: 'analyst',
          state: 'completed',
          startedAt: NOW,
          endedAt: NOW,
        },
      ],
      transitions: [
        { id: 'ct-1', label: 'Deliberation', status: 'completed', timestamp: NOW, detail: null },
      ],
      finalOutcome: 'Consensus: use approach B',
    });
    assert.ok(result.success);
    assert.equal(result.data.participants.length, 2);
  });
});

// ── Conformance: OperationalControlView ──────────────────────────────────────

describe('OperationalControlView conformance', () => {
  it('all availability values are accepted', () => {
    for (const availability of ControlAvailability.options) {
      const result = OperationalControlView.safeParse({
        controlId: 'ctrl-1',
        kind: 'routing',
        label: 'Route',
        availability,
        authority: 'granted',
        reason: null,
        options: [],
        expectedRevision: null,
        lastResolvedAt: null,
      });
      assert.ok(result.success, `availability ${availability} should be accepted`);
    }
  });

  it('all control kinds are accepted', () => {
    for (const kind of ControlKind.options) {
      const result = OperationalControlView.safeParse({
        controlId: 'ctrl-1',
        kind,
        label: 'Control',
        availability: 'actionable',
        authority: 'granted',
        reason: null,
        options: [],
        expectedRevision: 'rev-1',
        lastResolvedAt: null,
      });
      assert.ok(result.success, `kind ${kind} should be accepted`);
    }
  });
});

// ── Conformance: RiskSignal ──────────────────────────────────────────────────

describe('RiskSignal conformance', () => {
  it('all risk signal kinds are accepted', () => {
    for (const kind of ['budget', 'health', 'waiting', 'stale']) {
      for (const severity of ['info', 'warning', 'critical']) {
        const result = RiskSignal.safeParse({
          kind,
          severity,
          summary: `${kind} ${severity}`,
          scope: 'work-item',
        });
        assert.ok(result.success, `${kind}/${severity} should be valid`);
      }
    }
  });
});
