/**
 * Conversation executor — wires conversation turns into the Hydra agent
 * execution pipeline.  Contains the approval-gate logic that pauses turns
 * requiring operator confirmation and the continuator that resumes them
 * with full persisted context.
 *
 * Extracted from orchestrator-daemon.ts so the approval-producing path can
 * be tested independently of the full daemon startup.
 */

import { createHash } from 'node:crypto';
import { classifyTask } from '../hydra-agents.ts';
import type { ConversationStore } from './conversation-store.ts';
import type { StreamManager } from './stream-manager.ts';

// ── Types ────────────────────────────────────────────────────────────────────

/** Minimal result contract returned by `executeAgentWithRecovery`. */
export interface AgentResult {
  ok: boolean;
  output: string;
}

/** Function signature for the agent execution backend. */
export type AgentExecutor = (agent: string, prompt: string) => Promise<AgentResult>;

/** Dependencies injected from the daemon context. */
export interface ExecutorDeps {
  conversationStore: ConversationStore;
  streamManager: StreamManager;
  /** Agent execution backend — defaults to `executeAgentWithRecovery`. */
  executeAgent: AgentExecutor;
}

// ── Approval gate ────────────────────────────────────────────────────────────

/**
 * Pattern that identifies instructions requiring operator approval before
 * agent execution.  Matches destructive / high-impact operations that should
 * not proceed without human sign-off.
 */
const APPROVAL_PATTERN =
  /\b(deploy\s+(?:to\s+)?prod(?:uction)?|delete\s+prod|drop\s+(?:table|database)|rm\s+-rf\s+\/|shutdown\s+prod|destroy\s+(?:infra|cluster)|terminate\s+(?:instance|server)|rollback\s+prod)/i;

/**
 * Determine whether an instruction should require operator approval before
 * the agent is invoked.
 */
export function requiresApproval(instruction: string): boolean {
  return APPROVAL_PATTERN.test(instruction);
}

// ── Agent selection ──────────────────────────────────────────────────────────

const AGENT_MAP: Record<string, string> = {
  analysis: 'gemini',
  review: 'gemini',
  research: 'gemini',
  implementation: 'codex',
  refactor: 'codex',
  testing: 'codex',
};

function selectAgent(taskType: string): string {
  return AGENT_MAP[taskType] ?? 'claude';
}

// ── Executor ─────────────────────────────────────────────────────────────────

/**
 * Create the `executeTurn` callback used by the conversation routes.
 *
 * When the instruction matches the approval gate pattern the executor pauses
 * the turn by creating an `ApprovalRequest` in the store and emitting an
 * `approval-prompt` stream event without completing the stream.  The turn
 * remains in the `executing` state until the operator responds.
 *
 * Non-approval instructions are dispatched to the best-fit agent immediately
 * and the stream is driven to a terminal state (completed / failed).
 */
export function createConversationExecutor(
  deps: ExecutorDeps,
): (turnId: string, instruction: string) => Promise<void> {
  return async (turnId: string, instruction: string): Promise<void> => {
    const { streamManager, conversationStore, executeAgent } = deps;
    const taskType = classifyTask(instruction);
    const agent = selectAgent(taskType);

    // ── Approval gate ────────────────────────────────────────────────────
    if (requiresApproval(instruction)) {
      streamManager.emitEvent(turnId, 'text-delta', {
        text: `Task classified as "${taskType}" — requires operator approval before execution.`,
      });

      const contextHash = createHash('sha256').update(instruction).digest('hex').slice(0, 16);

      const approval = conversationStore.createApprovalRequest(turnId, {
        prompt: `Confirm execution: ${instruction}`,
        context: { instruction, taskType, agent },
        contextHash,
        responseOptions: [
          { key: 'approve', label: 'Approve' },
          { key: 'reject', label: 'Reject' },
        ],
      });

      streamManager.emitEvent(turnId, 'approval-prompt', { approvalId: approval.id });
      // Do NOT complete the stream — turn stays paused in `executing` state.
      return;
    }

    // ── Direct execution (no approval required) ──────────────────────────
    const result = await executeAgent(agent, instruction);
    if (result.ok) {
      const output = typeof result.output === 'string' ? result.output : '';
      if (output !== '') {
        streamManager.emitEvent(turnId, 'text-delta', { text: output });
      }
      streamManager.completeStream(turnId);
    } else {
      const reason = typeof result.output === 'string' ? result.output : 'Agent execution failed';
      streamManager.failStream(turnId, reason);
    }
  };
}

// ── Continuator ──────────────────────────────────────────────────────────────

/**
 * Create the `continueAfterApproval` callback used by the conversation routes.
 *
 * Unlike the previous implementation this loads the persisted `ApprovalRequest`
 * by ID and includes its prompt, context, and operator response in the
 * continuation instruction so the agent receives the full decision context
 * rather than a bare re-prompt.
 *
 * If the operator chose "reject" the turn is completed with a rejection notice
 * and no agent execution occurs.
 */
export function createApprovalContinuator(
  deps: ExecutorDeps,
): (
  turnId: string,
  approvalId: string,
  response: string,
  originalInstruction: string,
) => Promise<void> {
  return async (
    turnId: string,
    approvalId: string,
    response: string,
    originalInstruction: string,
  ): Promise<void> => {
    const { streamManager, conversationStore, executeAgent } = deps;

    // Load persisted approval record for full context.
    const approval = conversationStore.getApproval(approvalId);

    // ── Rejection path ───────────────────────────────────────────────────
    if (response === 'reject') {
      streamManager.emitEvent(turnId, 'text-delta', {
        text: 'Execution rejected by operator.',
      });
      streamManager.completeStream(turnId);
      return;
    }

    // ── Build continuation with persisted context ────────────────────────
    const approvalPrompt = approval?.prompt ?? 'Approval requested';
    const approvalContext = approval?.context ?? {};
    const taskType =
      typeof approvalContext['taskType'] === 'string'
        ? approvalContext['taskType']
        : classifyTask(originalInstruction);
    const agent =
      typeof approvalContext['agent'] === 'string'
        ? approvalContext['agent']
        : selectAgent(taskType);

    const contextSummary =
      Object.keys(approvalContext).length > 0
        ? `\nApproval context: ${JSON.stringify(approvalContext)}`
        : '';

    const continuationInstruction =
      `Continue the previous task. Original instruction: ${originalInstruction}\n` +
      `Approval prompt: ${approvalPrompt}${contextSummary}\n` +
      `Operator response: ${response}`;

    const result = await executeAgent(agent, continuationInstruction);
    if (result.ok) {
      const output = typeof result.output === 'string' ? result.output : '';
      if (output !== '') {
        streamManager.emitEvent(turnId, 'text-delta', { text: output });
      }
      streamManager.completeStream(turnId);
    } else {
      const reason = typeof result.output === 'string' ? result.output : 'Agent execution failed';
      streamManager.failStream(turnId, reason);
    }
  };
}
