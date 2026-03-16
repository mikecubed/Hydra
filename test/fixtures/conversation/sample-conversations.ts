/**
 * Test fixtures for conversation protocol scenarios.
 *
 * Provides pre-built valid entities for use across unit and integration tests.
 * IDs use a deterministic monotonic counter so snapshots are stable across runs.
 */
const NOW = '2025-07-14T00:00:00.000Z';
const LATER = '2025-07-14T01:00:00.000Z';

let _nextId = 1;

/** Reset the monotonic ID counter (call in beforeEach when needed). */
export function resetFixtureIds(): void {
  _nextId = 1;
}

export const operatorAttribution = { type: 'operator' as const, label: 'Admin' };
export const systemAttribution = { type: 'system' as const, label: 'System' };
export const agentAttribution = (agentId: string, label: string) => ({
  type: 'agent' as const,
  agentId,
  label,
});

export function makeConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: `conv-${String(_nextId++)}`,
    status: 'active' as const,
    createdAt: NOW,
    updatedAt: NOW,
    turnCount: 0,
    pendingInstructionCount: 0,
    ...overrides,
  };
}

export function makeTurn(
  conversationId: string,
  position: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `turn-${conversationId}-${String(position)}`,
    conversationId,
    position,
    kind: 'operator' as const,
    attribution: operatorAttribution,
    instruction: `Instruction ${String(position)}`,
    status: 'submitted' as const,
    createdAt: NOW,
    ...overrides,
  };
}

export function makeStreamEvent(
  turnId: string,
  seq: number,
  kind: string = 'text-delta',
  overrides: Record<string, unknown> = {},
) {
  return {
    seq,
    turnId,
    kind,
    payload: kind === 'text-delta' ? { text: `chunk-${String(seq)}` } : {},
    timestamp: NOW,
    ...overrides,
  };
}

export function makeApproval(turnId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `approval-${turnId}-${String(_nextId++)}`,
    turnId,
    status: 'pending' as const,
    prompt: 'Approve this action?',
    context: { detail: 'test context' },
    contextHash: 'sha256-test',
    responseOptions: [
      { key: 'approve', label: 'Approve' },
      { key: 'reject', label: 'Reject' },
    ],
    createdAt: NOW,
    ...overrides,
  };
}

export function makeArtifact(turnId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `artifact-${turnId}-${String(_nextId++)}`,
    turnId,
    kind: 'file' as const,
    label: 'output.ts',
    size: 1024,
    createdAt: NOW,
    ...overrides,
  };
}

export function makeActivity(agentId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `activity-${agentId}-${String(_nextId++)}`,
    attribution: agentAttribution(agentId, agentId),
    kind: 'task-started' as const,
    summary: `${agentId} started work`,
    timestamp: NOW,
    ...overrides,
  };
}

export { NOW, LATER };
