/**
 * ConversationStore — event-sourced conversation persistence for the daemon.
 *
 * Manages conversations, turns, approvals, artifacts, activities, forks,
 * retries, and instruction queues. All mutations emit events to an in-memory
 * event log that can be replayed for reconnect synchronization.
 *
 * This is a daemon-side module that extends the existing state management
 * pattern. It operates in-memory with event sourcing for future persistence.
 */

import type {
  Conversation as ConversationType,
  Turn as TurnType,
  ApprovalRequest as ApprovalRequestType,
  Artifact as ArtifactType,
  ActivityEntry as ActivityEntryType,
  Attribution as AttributionType,
} from '../../packages/web-contracts/src/index.ts';

// ── Internal types ───────────────────────────────────────────────────────────

interface ConversationEventRecord {
  seq: number;
  at: string;
  type: string;
  category: 'conversation';
  payload: Record<string, unknown>;
}

interface StoredArtifact extends ArtifactType {
  content: string;
}

interface QueuedInstruction {
  id: string;
  instruction: string;
  queuedAt: string;
}

interface TurnInput {
  kind: 'operator' | 'system';
  instruction?: string;
  attribution: AttributionType;
}

interface ApprovalInput {
  prompt: string;
  context: Record<string, unknown>;
  contextHash: string;
  responseOptions: Array<{ key: string; label: string }>;
}

interface ArtifactInput {
  kind: string;
  label: string;
  size: number;
  content: string;
  summary?: string;
}

interface ActivityInput {
  attribution: AttributionType;
  kind: string;
  summary: string;
  detail?: string;
  parentActivityId?: string;
}

interface ApprovalResult {
  success: boolean;
  approval: ApprovalRequestType;
  conflictNotification?: {
    conflictingSessionId: string;
    message: string;
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ── ConversationStore ────────────────────────────────────────────────────────

export class ConversationStore {
  private readonly conversations = new Map<string, ConversationType>();
  private readonly turns = new Map<string, TurnType>();
  private readonly turnsByConversation = new Map<string, string[]>();
  private readonly approvals = new Map<string, ApprovalRequestType>();
  private readonly approvalsByTurn = new Map<string, string[]>();
  private readonly artifacts = new Map<string, StoredArtifact>();
  private readonly artifactsByTurn = new Map<string, string[]>();
  private readonly activities = new Map<string, ActivityEntryType>();
  private readonly activitiesByTurn = new Map<string, string[]>();
  private readonly instructionQueues = new Map<string, QueuedInstruction[]>();
  private readonly forkTurnIndex = new Map<string, { parentId: string; forkTurnId: string }>();
  private readonly events: ConversationEventRecord[] = [];
  private eventSeq = 0;

  // ── Event emission ───────────────────────────────────────────────────────

  private emit(type: string, payload: Record<string, unknown>): ConversationEventRecord {
    this.eventSeq += 1;
    const event: ConversationEventRecord = {
      seq: this.eventSeq,
      at: nowIso(),
      type,
      category: 'conversation',
      payload,
    };
    this.events.push(event);
    return event;
  }

  getEvents(): ConversationEventRecord[] {
    return [...this.events];
  }

  getEventsSince(fromSeq: number): ConversationEventRecord[] {
    return this.events.filter((e) => e.seq >= fromSeq);
  }

  getEventSeq(): number {
    return this.eventSeq;
  }

  // ── Conversation lifecycle ─────────────────────────────────────────────

  createConversation(opts?: { title?: string }): ConversationType {
    const id = generateId('conv');
    const now = nowIso();
    const conversation: ConversationType = {
      id,
      title: opts?.title,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      turnCount: 0,
      pendingInstructionCount: 0,
    };
    this.conversations.set(id, conversation);
    this.turnsByConversation.set(id, []);
    this.instructionQueues.set(id, []);
    this.emit('conversation:created', { conversationId: id, title: opts?.title });
    return conversation;
  }

  getConversation(id: string): ConversationType | undefined {
    return this.conversations.get(id);
  }

  listConversations(filter?: { status?: string }): ConversationType[] {
    const all = [...this.conversations.values()];
    if (filter?.status !== undefined && filter.status !== '') {
      return all.filter((c) => c.status === filter.status);
    }
    return all;
  }

  archiveConversation(id: string): void {
    const conv = this.conversations.get(id);
    if (!conv) throw new Error(`Conversation not found: ${id}`);
    conv.status = 'archived';
    conv.updatedAt = nowIso();
    this.emit('conversation:archived', { conversationId: id });
  }

  // ── Turns ──────────────────────────────────────────────────────────────

  appendTurn(conversationId: string, input: TurnInput): TurnType {
    const conv = this.conversations.get(conversationId);
    if (!conv) throw new Error(`Conversation not found: ${conversationId}`);
    if (conv.status === 'archived') throw new Error(`Conversation is archived: ${conversationId}`);

    const turnIds = this.turnsByConversation.get(conversationId) ?? [];
    // For forked conversations, position continues from the fork point
    const forkInfo = this.forkTurnIndex.get(conversationId);
    const forkOffset = forkInfo ? (this.turns.get(forkInfo.forkTurnId)?.position ?? 0) : 0;
    const position = forkOffset + turnIds.length + 1;
    const id = generateId('turn');
    const now = nowIso();

    const turn: TurnType = {
      id,
      conversationId,
      position,
      kind: input.kind,
      attribution: input.attribution,
      instruction: input.instruction,
      status: input.kind === 'system' ? 'completed' : 'submitted',
      createdAt: now,
      completedAt: input.kind === 'system' ? now : undefined,
    };

    this.turns.set(id, turn);
    turnIds.push(id);
    this.turnsByConversation.set(conversationId, turnIds);

    conv.turnCount = forkOffset + turnIds.length;
    conv.updatedAt = now;

    this.emit('conversation:turn-appended', {
      conversationId,
      turnId: id,
      position,
      kind: input.kind,
    });

    return turn;
  }

  getTurn(turnId: string): TurnType | undefined {
    return this.turns.get(turnId);
  }

  getTurns(conversationId: string): TurnType[] {
    // Handle forked conversations: include parent turns up to fork point
    const forkInfo = this.forkTurnIndex.get(conversationId);
    const result: TurnType[] = [];

    if (forkInfo) {
      const parentTurns = this.getTurns(forkInfo.parentId);
      const forkTurn = this.turns.get(forkInfo.forkTurnId);
      if (forkTurn) {
        for (const t of parentTurns) {
          if (t.position <= forkTurn.position) {
            result.push(t);
          }
        }
      }
    }

    const ownTurnIds = this.turnsByConversation.get(conversationId) ?? [];
    for (const tid of ownTurnIds) {
      const t = this.turns.get(tid);
      if (t) result.push(t);
    }

    return result.sort((a, b) => a.position - b.position);
  }

  getTurnsByRange(conversationId: string, from: number, to: number): TurnType[] {
    const all = this.getTurns(conversationId);
    return all.filter((t) => t.position >= from && t.position <= to);
  }

  updateTurnStatus(turnId: string, status: TurnType['status']): void {
    const turn = this.turns.get(turnId);
    if (!turn) throw new Error(`Turn not found: ${turnId}`);
    turn.status = status;
    this.emit('conversation:turn-status-changed', { turnId, status });
  }

  finalizeTurn(
    turnId: string,
    status: 'completed' | 'failed' | 'cancelled',
    response?: string,
  ): void {
    const turn = this.turns.get(turnId);
    if (!turn) throw new Error(`Turn not found: ${turnId}`);
    turn.status = status;
    turn.response = response;
    turn.completedAt = nowIso();
    this.emit('conversation:turn-finalized', {
      turnId,
      status,
      hasResponse: response !== undefined && response !== '',
    });
  }

  // ── Approvals ──────────────────────────────────────────────────────────

  createApprovalRequest(turnId: string, input: ApprovalInput): ApprovalRequestType {
    const id = generateId('approval');
    const now = nowIso();
    const approval: ApprovalRequestType = {
      id,
      turnId,
      status: 'pending',
      prompt: input.prompt,
      context: input.context,
      contextHash: input.contextHash,
      responseOptions: input.responseOptions,
      createdAt: now,
    };
    this.approvals.set(id, approval);
    const turnApprovals = this.approvalsByTurn.get(turnId) ?? [];
    turnApprovals.push(id);
    this.approvalsByTurn.set(turnId, turnApprovals);
    this.emit('conversation:approval-created', { approvalId: id, turnId });
    return approval;
  }

  getApproval(id: string): ApprovalRequestType | undefined {
    return this.approvals.get(id);
  }

  getPendingApprovals(conversationId: string): ApprovalRequestType[] {
    const turnIds = this.turnsByConversation.get(conversationId) ?? [];
    const result: ApprovalRequestType[] = [];
    for (const tid of turnIds) {
      const approvalIds = this.approvalsByTurn.get(tid) ?? [];
      for (const aid of approvalIds) {
        const a = this.approvals.get(aid);
        if (a && (a.status === 'pending' || a.status === 'stale')) {
          result.push(a);
        }
      }
    }
    return result;
  }

  respondToApproval(
    approvalId: string,
    response: string,
    sessionId: string,
    acknowledgeStaleness = false,
  ): ApprovalResult {
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new Error(`Approval not found: ${approvalId}`);

    // Already responded — first-write-wins conflict
    if (approval.status === 'responded') {
      return {
        success: false,
        approval,
        conflictNotification: {
          conflictingSessionId:
            (approval.respondedBy as { label?: string } | undefined)?.label ?? 'unknown',
          message: 'Approval already responded by another session',
        },
      };
    }

    // Stale without acknowledgement
    if (approval.status === 'stale' && !acknowledgeStaleness) {
      return { success: false, approval };
    }

    // Expired
    if (approval.status === 'expired') {
      return { success: false, approval };
    }

    approval.status = 'responded';
    approval.response = response;
    approval.respondedBy = { type: 'operator', label: sessionId };
    approval.respondedAt = nowIso();

    this.emit('conversation:approval-responded', {
      approvalId,
      response,
      sessionId,
    });

    return { success: true, approval };
  }

  markApprovalStale(approvalId: string, _newContextHash: string): void {
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new Error(`Approval not found: ${approvalId}`);
    if (approval.status === 'pending') {
      approval.status = 'stale';
      this.emit('conversation:approval-stale', { approvalId });
    }
  }

  // ── Fork ───────────────────────────────────────────────────────────────

  forkConversation(parentId: string, forkPointTurnId: string, title?: string): ConversationType {
    const parent = this.conversations.get(parentId);
    if (!parent) throw new Error(`Conversation not found: ${parentId}`);
    const forkTurn = this.turns.get(forkPointTurnId);
    if (!forkTurn) throw new Error(`Turn not found: ${forkPointTurnId}`);

    const id = generateId('conv');
    const now = nowIso();

    const forked: ConversationType = {
      id,
      title: title ?? `Fork of ${parent.title ?? parent.id}`,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      turnCount: forkTurn.position,
      parentConversationId: parentId,
      forkPointTurnId,
      pendingInstructionCount: 0,
    };

    this.conversations.set(id, forked);
    this.turnsByConversation.set(id, []);
    this.instructionQueues.set(id, []);
    this.forkTurnIndex.set(id, { parentId, forkTurnId: forkPointTurnId });

    this.emit('conversation:forked', {
      conversationId: id,
      parentConversationId: parentId,
      forkPointTurnId,
    });

    return forked;
  }

  // ── Retry ──────────────────────────────────────────────────────────────

  retryTurn(conversationId: string, turnId: string): TurnType {
    const original = this.turns.get(turnId);
    if (!original) throw new Error(`Turn not found: ${turnId}`);

    const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
    if (!terminalStatuses.has(original.status)) {
      throw new Error(`Cannot retry non-terminal turn (status: ${original.status})`);
    }

    const newTurn = this.appendTurn(conversationId, {
      kind: original.kind,
      instruction: original.instruction,
      attribution: original.attribution,
    });
    // Set parentTurnId for retry linkage
    newTurn.parentTurnId = turnId;
    return newTurn;
  }

  // ── Instruction Queue ──────────────────────────────────────────────────

  queueInstruction(conversationId: string, instruction: string): QueuedInstruction {
    const conv = this.conversations.get(conversationId);
    if (!conv) throw new Error(`Conversation not found: ${conversationId}`);

    const qi: QueuedInstruction = {
      id: generateId('qi'),
      instruction,
      queuedAt: nowIso(),
    };

    const queue = this.instructionQueues.get(conversationId) ?? [];
    queue.push(qi);
    this.instructionQueues.set(conversationId, queue);
    conv.pendingInstructionCount = queue.length;

    this.emit('conversation:instruction-queued', {
      conversationId,
      instructionId: qi.id,
    });

    return qi;
  }

  getInstructionQueue(conversationId: string): QueuedInstruction[] {
    return [...(this.instructionQueues.get(conversationId) ?? [])];
  }

  dequeueInstruction(conversationId: string): QueuedInstruction | undefined {
    const queue = this.instructionQueues.get(conversationId);
    if (!queue || queue.length === 0) return undefined;
    const qi = queue.shift();
    const conv = this.conversations.get(conversationId);
    if (conv) conv.pendingInstructionCount = queue.length;
    return qi;
  }

  removeFromQueue(conversationId: string, instructionId: string): void {
    const queue = this.instructionQueues.get(conversationId);
    if (!queue) return;
    const idx = queue.findIndex((qi) => qi.id === instructionId);
    if (idx >= 0) {
      queue.splice(idx, 1);
      const conv = this.conversations.get(conversationId);
      if (conv) conv.pendingInstructionCount = queue.length;
    }
  }

  // ── Artifacts ──────────────────────────────────────────────────────────

  createArtifact(turnId: string, input: ArtifactInput): ArtifactType {
    const id = generateId('artifact');
    const now = nowIso();
    const artifact: StoredArtifact = {
      id,
      turnId,
      kind: input.kind as ArtifactType['kind'],
      label: input.label,
      summary: input.summary,
      size: input.size,
      createdAt: now,
      content: input.content,
    };
    this.artifacts.set(id, artifact);
    const turnArtifacts = this.artifactsByTurn.get(turnId) ?? [];
    turnArtifacts.push(id);
    this.artifactsByTurn.set(turnId, turnArtifacts);
    this.emit('conversation:artifact-created', { artifactId: id, turnId });
    return {
      id,
      turnId,
      kind: artifact.kind,
      label: artifact.label,
      summary: artifact.summary,
      size: artifact.size,
      createdAt: now,
    };
  }

  getArtifactsForTurn(turnId: string): ArtifactType[] {
    const ids = this.artifactsByTurn.get(turnId) ?? [];
    return ids
      .map((aid) => this.artifacts.get(aid))
      .filter((a): a is StoredArtifact => a !== undefined)
      .map(({ content: _, ...rest }) => rest);
  }

  getArtifactContent(artifactId: string): string | undefined {
    return this.artifacts.get(artifactId)?.content;
  }

  getArtifactMetadata(artifactId: string): ArtifactType | undefined {
    const stored = this.artifacts.get(artifactId);
    if (!stored) return undefined;
    const { content: _, ...meta } = stored;
    return meta;
  }

  listArtifactsForConversation(conversationId: string): ArtifactType[] {
    const turnIds = this.turnsByConversation.get(conversationId) ?? [];
    const result: ArtifactType[] = [];
    for (const tid of turnIds) {
      result.push(...this.getArtifactsForTurn(tid));
    }
    return result;
  }

  // ── Activities ─────────────────────────────────────────────────────────

  appendActivity(turnId: string, input: ActivityInput): ActivityEntryType {
    const id = generateId('activity');
    const now = nowIso();
    const activity: ActivityEntryType = {
      id,
      attribution: input.attribution,
      kind: input.kind as ActivityEntryType['kind'],
      summary: input.summary,
      detail: input.detail,
      parentActivityId: input.parentActivityId,
      timestamp: now,
    };
    this.activities.set(id, activity);
    const turnActivities = this.activitiesByTurn.get(turnId) ?? [];
    turnActivities.push(id);
    this.activitiesByTurn.set(turnId, turnActivities);
    this.emit('conversation:activity-appended', { activityId: id, turnId });
    return activity;
  }

  getActivitiesForTurn(turnId: string): ActivityEntryType[] {
    const ids = this.activitiesByTurn.get(turnId) ?? [];
    return ids
      .map((aid) => this.activities.get(aid))
      .filter((a): a is ActivityEntryType => a !== undefined);
  }

  filterActivitiesByAgent(turnId: string, agentId: string): ActivityEntryType[] {
    return this.getActivitiesForTurn(turnId).filter(
      (a) => a.attribution.type === 'agent' && a.attribution.agentId === agentId,
    );
  }
}
