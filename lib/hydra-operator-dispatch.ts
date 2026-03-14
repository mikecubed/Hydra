/**
 * Hydra Operator Dispatch
 *
 * Dispatch, delegation, and routing helpers extracted from hydra-operator.ts.
 * These functions handle building agent message briefs and publishing tasks/handoffs
 * to the Hydra daemon via HTTP.
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- T7A: dispatch uses polymorphic any for dynamic agent routing */
/* eslint-disable @typescript-eslint/strict-boolean-expressions -- T7A: standard JS truthiness; type narrowing tracked as follow-up */
/* eslint-disable no-await-in-loop -- sequential task creation required by daemon ordering */

import { buildAgentContext } from './hydra-context.ts';
import { getAgent, getVerifier } from './hydra-agents.ts';
import { resolveProject, loadHydraConfig } from './hydra-config.ts';
import {
  short,
  request,
  normalizeTask,
  selectTandemPair,
  type NormalizedTask,
} from './hydra-utils.ts';
import { DefaultAgentExecutor, type IAgentExecutor } from './hydra-shared/agent-executor.ts';
import { isPersonaEnabled, getAgentFraming, getProcessLabel } from './hydra-persona.ts';
import { pushActivity, annotateDispatch } from './hydra-activity.ts';

const config = resolveProject();

// ── Shared Interfaces ────────────────────────────────────────────────────────

export interface MiniRoundReport {
  tasks?: unknown[];
  questions?: Array<{ to?: string; question?: string }>;
  /** LLM output — may be any scalar value; coerced to string at use site. */
  consensus?: string | number | boolean | null;
  /** LLM output — may be any scalar value; coerced to string at use site. */
  recommendedMode?: string | number | boolean | null;
  /** LLM output — may be any scalar value; coerced to string at use site. */
  recommendationRationale?: string | number | boolean | null;
}

export interface TandemPair {
  lead: string;
  follow: string;
}

export interface DispatchClassification {
  taskType: string;
  suggestedAgent: string;
  confidence?: number;
  reason?: string;
  tier?: string;
  tandemPair?: TandemPair | null;
}

// ── Brief Builders (pure string construction) ────────────────────────────────

export function buildAgentMessage(agent: string, userPrompt: string): string {
  const agentConfig = getAgent(agent);
  const rolePrompt = agentConfig
    ? agentConfig.rolePrompt
    : 'Contribute effectively to this objective.';
  const agentLabel = agentConfig ? agentConfig.label : agent.toUpperCase();

  const heading = isPersonaEnabled()
    ? `${getAgentFraming(agent)} ${getProcessLabel('dispatch')} directive:`
    : `Hydra dispatch for ${agentLabel}:`;

  return [
    heading,
    `Primary objective: ${userPrompt}`,
    '',
    rolePrompt,
    '',
    ...(getAgent(agent)?.taskRules ?? []),
    '',
    'If blocked or unclear, ask direct questions immediately.',
    'When done with current chunk, create a Hydra handoff with exact next step.',
    '',
    buildAgentContext(agent, {}, config, userPrompt),
  ]
    .filter(Boolean)
    .join('\n');
}

function formatAssignedTaskText(myTasks: NormalizedTask[]): string {
  if (myTasks.length === 0) {
    return '- No explicit task assigned. Start by proposing first concrete step.';
  }
  return myTasks
    .map(
      (task) =>
        `- ${task.title}${task.done ? ` (DoD: ${task.done})` : ''}${task.rationale ? ` [${task.rationale}]` : ''}`,
    )
    .join('\n');
}

function formatOpenQuestionText(myQuestions: Array<{ to?: string; question?: string }>): string {
  if (myQuestions.length === 0) return '- none';
  return myQuestions
    .map((q) => {
      const to = q.to ?? 'human';
      const question = (q.question ?? '').trim();
      return question ? `- to ${to}: ${question}` : null;
    })
    .filter(Boolean)
    .join('\n');
}

export function buildMiniRoundBrief(
  agent: string,
  userPrompt: string,
  report: MiniRoundReport | null,
): string {
  const agentConfig = getAgent(agent);
  const tasks: NormalizedTask[] = Array.isArray(report?.tasks)
    ? report.tasks.map((item) => normalizeTask(item)).filter((t): t is NormalizedTask => t !== null)
    : [];
  const questions = Array.isArray(report?.questions) ? report.questions : [];
  const consensus = String(report?.consensus ?? '').trim();

  const myTasks = tasks.filter((task) => task.owner === agent || task.owner === 'unassigned');
  const myQuestions = questions.filter((q) => q.to === agent || q.to === 'human');

  const taskText = formatAssignedTaskText(myTasks);
  const questionText = formatOpenQuestionText(myQuestions);

  return [
    isPersonaEnabled()
      ? `${getAgentFraming(agent)} ${getProcessLabel('miniRound')} delegation.`
      : `Hydra mini-round delegation for ${agentConfig ? agentConfig.label : agent.toUpperCase()}.`,
    '',
    agentConfig ? agentConfig.rolePrompt : '',
    '',
    buildAgentContext(agent, {}, config, userPrompt),
    '',
    `Objective: ${userPrompt}`,
    `Recommendation: ${String(report?.recommendedMode ?? 'handoff')} (${String(report?.recommendationRationale ?? 'n/a')})`,
    `Consensus: ${consensus || 'No explicit consensus text.'}`,
    'Assigned tasks:',
    taskText,
    'Open questions:',
    questionText,
    'Next step: execute first task and publish milestone/blocker via Hydra handoff.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Build a role-aware tandem brief for an agent in a tandem pair.
 */
export function buildTandemBrief(
  agent: string,
  partner: string,
  promptText: string,
  _classification: unknown,
  role: string,
): string {
  const agentConfig = getAgent(agent);
  const agentLabel = agentConfig ? agentConfig.label : agent.toUpperCase();
  const partnerLabel = getAgent(partner)?.label ?? partner.toUpperCase();

  const heading = isPersonaEnabled()
    ? `${getAgentFraming(agent)} ${getProcessLabel('dispatch')} directive (tandem ${role}):`
    : `Hydra tandem dispatch for ${agentLabel} (${role}):`;

  const roleInstruction =
    role === 'lead'
      ? `You are the lead in a tandem pair. Analyze the objective and produce an actionable plan or analysis. Your output will be handed to ${partnerLabel} for execution.`
      : `You are the follow-up in a tandem pair. Build on ${partnerLabel}'s analysis and execute the work. Focus on implementation and verification.`;

  const rolePrompt = agentConfig
    ? agentConfig.rolePrompt
    : 'Contribute effectively to this objective.';

  return [
    heading,
    `Primary objective: ${promptText}`,
    '',
    roleInstruction,
    '',
    rolePrompt,
    '',
    'If blocked or unclear, ask direct questions immediately.',
    'When done, create a Hydra handoff with exact next step.',
    '',
    buildAgentContext(agent, {}, config, promptText),
  ]
    .filter(Boolean)
    .join('\n');
}

function parseVerificationJson(output: string): Record<string, unknown> | null {
  try {
    return JSON.parse(output) as Record<string, unknown>;
  } catch {
    const match = output.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as Record<string, unknown>;
      } catch {
        /* give up */
      }
    }
    return null;
  }
}

// ── Config-Based Gate ────────────────────────────────────────────────────────

/**
 * Check if cross-model verification should run for a given classification.
 */
export function shouldCrossVerify(classification: { tier?: string }): boolean {
  const cfg = loadHydraConfig();
  const cvConfig = cfg.crossModelVerification;
  if (!cvConfig?.enabled) return false;
  if (cvConfig['mode'] === 'always') return true;
  if (cvConfig['mode'] === 'on-complex') return classification.tier === 'complex';
  return false;
}

// ── Async Delegation Helpers (daemon HTTP calls) ─────────────────────────────

/**
 * Cross-model verification: route producer output to a paired verifier agent.
 * Returns { approved, issues, suggestions } or null if verification is skipped/fails.
 */
export async function runCrossVerification(
  producerAgent: string,
  producerOutput: string,
  originalPrompt: string,
  specContent: string | null = null,
  executor: IAgentExecutor = new DefaultAgentExecutor(),
): Promise<{
  verifier: string;
  approved: boolean;
  issues: string[];
  suggestions: string[];
} | null> {
  const cfg = loadHydraConfig();
  const cvConfig = cfg.crossModelVerification;
  if (!cvConfig?.enabled) return null;

  const verifierAgent = getVerifier(producerAgent);
  if (verifierAgent === producerAgent) return null;

  const reviewPrompt = [
    "You are reviewing another AI agent's output. Be precise and adversarial — your job is to surface what the producer missed or got wrong.",
    '',
    `Original objective: ${originalPrompt}`,
    specContent ? `\nAnchoring specification:\n${specContent}\n` : '',
    `Producer agent: ${producerAgent}`,
    `Producer output:\n${producerOutput}`,
    '',
    'Review this output and return JSON only:',
    '{',
    '  "approved": true|false,',
    '  "strongestAssumption": "The single most load-bearing assumption in this output — if it is wrong, the whole approach fails",',
    '  "attackVector": "A concrete scenario or counterexample that would break the strongest assumption",',
    '  "issues": ["string — specific correctness or completeness failures"],',
    '  "suggestions": ["string — concrete improvements"],',
    '  "criteriaScores": {',
    '    "correctness": 0-10,',
    '    "complexity": 0-10,',
    '    "reversibility": 0-10,',
    '    "userImpact": 0-10',
    '  }',
    '}',
    '',
    'Scoring guide: correctness = factual/logical soundness; complexity = simplicity of approach (10 = minimal); reversibility = how easily this can be undone (10 = fully reversible); userImpact = positive effect on end users.',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const result = await executor.executeAgent(verifierAgent, reviewPrompt, {
      cwd: config.projectRoot,
      timeoutMs: 60_000,
      permissionMode: verifierAgent === 'codex' ? 'read-only' : 'plan',
    });
    if (!result.ok) return null;

    const output = (result.stdout ?? result.output) || '';
    const parsed = parseVerificationJson(output);
    if (!parsed) return null;

    return {
      verifier: verifierAgent,
      approved: Boolean(parsed['approved']),
      issues: Array.isArray(parsed['issues']) ? (parsed['issues'] as string[]) : [],
      suggestions: Array.isArray(parsed['suggestions']) ? (parsed['suggestions'] as string[]) : [],
    };
  } catch {
    return null;
  }
}

export async function dispatchPrompt({
  baseUrl,
  from,
  agents,
  promptText,
}: {
  baseUrl: string;
  from: string;
  agents: string[];
  promptText: string;
}): Promise<Array<{ agent: string; handoffId: string | null; summary: string }>> {
  const records = [];
  for (const agent of agents) {
    const summary = buildAgentMessage(agent, promptText);
    const payload = {
      from,
      to: agent,
      summary,
      nextStep: 'Start work and report first milestone via hydra:handoff.',
      tasks: [],
    };
    const result = (await request('POST', baseUrl, '/handoff', payload)) as any;
    records.push({
      agent,
      handoffId: result?.handoff?.id ?? null,
      summary,
    });
  }
  return records;
}

export async function publishFastPathDelegation({
  baseUrl,
  from,
  promptText,
  classification,
  agents = null,
}: {
  baseUrl: string;
  from: string;
  promptText: string;
  classification: DispatchClassification;
  agents?: string[] | null;
}): Promise<{ task: any; handoff: any; agent: string }> {
  const { taskType } = classification;
  let { suggestedAgent } = classification;

  if (agents && agents.length > 0 && !agents.includes(suggestedAgent)) {
    let best = agents[0];
    let bestScore = 0;
    for (const a of agents) {
      const cfg = getAgent(a);
      const score = (cfg?.taskAffinity as any)?.[taskType] ?? 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = a;
      }
    }
    suggestedAgent = best;
  }

  const task = (await request('POST', baseUrl, '/task/add', {
    title: short(promptText, 200) as any,
    owner: suggestedAgent,
    status: 'todo',
    type: taskType,
    notes: `Fast-path dispatch (confidence=${String(classification.confidence)}, reason: ${String(classification.reason)})`,
  })) as any;

  const summary = buildAgentMessage(suggestedAgent, promptText);
  const handoff = (await request('POST', baseUrl, '/handoff', {
    from,
    to: suggestedAgent,
    summary,
    nextStep: 'Start work and report first milestone via hydra:handoff.',
    tasks: task.task?.id ? [task.task.id] : [],
  })) as any;

  pushActivity(
    'dispatch',
    annotateDispatch({
      prompt: promptText,
      classification,
      mode: 'auto',
      route: 'fast-path',
      agent: suggestedAgent,
    }) as any,
    { agent: suggestedAgent, taskId: task.task?.id },
  );

  return {
    task: task.task,
    handoff: handoff.handoff,
    agent: suggestedAgent,
  };
}

export async function publishMiniRoundDelegation({
  baseUrl,
  from,
  agents,
  promptText,
  report,
}: {
  baseUrl: string;
  from: string;
  agents: string[];
  promptText: string;
  report: MiniRoundReport | null;
}): Promise<{ decision: any; tasks: any[]; handoffs: any[] }> {
  const normalizedTasks = (Array.isArray(report?.tasks) ? report.tasks : [])
    .map((item) => normalizeTask(item))
    .filter((t): t is NonNullable<ReturnType<typeof normalizeTask>> => t !== null);
  const tasksToCreate =
    normalizedTasks.length > 0
      ? normalizedTasks
      : agents.map((agent) => ({
          owner: agent,
          title: `Execute ${agent} contribution for: ${short(promptText, 120)}`,
          done: '',
          rationale: 'Generated fallback task because mini-round had no explicit allocations.',
        }));

  const createdTasks = [];
  for (const task of tasksToCreate) {
    const created = (await request('POST', baseUrl, '/task/add', {
      title: task.title,
      owner: task.owner,
      status: 'todo',
      notes: task.rationale ? `Mini-round rationale: ${task.rationale}` : '',
    })) as any;
    createdTasks.push(created.task);
  }

  const decision = (await request('POST', baseUrl, '/decision', {
    title: `Hydra Mini Round: ${short(promptText, 90)}`,
    owner: from,
    rationale: short(report?.consensus ?? 'Mini-round completed without explicit consensus.', 600),
    impact: `recommended=${String(report?.recommendedMode ?? 'handoff')}; tasks=${String(createdTasks.length)}`,
  })) as any;

  const handoffs = [];
  for (const agent of agents) {
    const agentTaskIds = createdTasks
      .filter((task: any) => task.owner === agent || task.owner === 'unassigned')
      .map((task) => task.id);
    const summary = buildMiniRoundBrief(agent, promptText, report);
    const handoff = (await request('POST', baseUrl, '/handoff', {
      from,
      to: agent,
      summary,
      nextStep: 'Acknowledge and execute top-priority delegated task.',
      tasks: agentTaskIds,
    })) as any;
    handoffs.push(handoff.handoff);
  }

  pushActivity(
    'dispatch',
    annotateDispatch({
      prompt: promptText,
      classification: { tier: 'medium', taskType: 'mixed' },
      mode: 'auto',
      route: 'mini-round',
      agent: agents[0],
    }) as any,
    { agents, taskCount: createdTasks.length },
  );

  return {
    decision: decision.decision,
    tasks: createdTasks,
    handoffs,
  };
}

/**
 * Tandem dispatch: create 2 tasks + 2 handoffs for a lead→follow pair.
 * Zero agent CLI calls — daemon HTTP posts only.
 */
export async function publishTandemDelegation({
  baseUrl,
  from,
  promptText,
  classification,
  agents = null,
}: {
  baseUrl: string;
  from: string;
  promptText: string;
  classification: DispatchClassification;
  agents?: string[] | null;
}): Promise<any> {
  const { taskType } = classification;
  let { tandemPair } = classification;

  if (agents && agents.length > 0) {
    tandemPair = selectTandemPair(taskType, classification.suggestedAgent, agents);
  }

  // Degrade to single-agent fast-path if tandem not viable
  if (!tandemPair) {
    return publishFastPathDelegation({ baseUrl, from, promptText, classification, agents });
  }

  const { lead, follow } = tandemPair;

  const leadTask = (await request('POST', baseUrl, '/task/add', {
    title: `[Lead] ${short(promptText, 180)}`,
    owner: lead,
    status: 'todo',
    type: taskType,
    notes: `Tandem lead (${lead} → ${follow}). Analyze/plan then hand off.`,
  })) as any;

  const followTask = (await request('POST', baseUrl, '/task/add', {
    title: `[Follow] ${short(promptText, 180)}`,
    owner: follow,
    status: 'todo',
    type: taskType,
    notes: `Tandem follow (from ${lead}). Execute based on lead's analysis. Ref: task ${String(leadTask.task?.id ?? '?')}`,
  })) as any;

  const leadBrief = buildTandemBrief(lead, follow, promptText, classification, 'lead');
  const leadHandoff = (await request('POST', baseUrl, '/handoff', {
    from,
    to: lead,
    summary: leadBrief,
    nextStep: `Analyze the objective and produce actionable plan. Your output will be forwarded to ${follow}.`,
    tasks: leadTask.task?.id ? [leadTask.task.id] : [],
  })) as any;

  const followBrief = buildTandemBrief(follow, lead, promptText, classification, 'follow');
  const followHandoff = (await request('POST', baseUrl, '/handoff', {
    from,
    to: follow,
    summary: followBrief,
    nextStep: `Build on ${lead}'s analysis and execute. Reference task ${String(leadTask.task?.id ?? '?')}.`,
    tasks: followTask.task?.id ? [followTask.task.id] : [],
  })) as any;

  pushActivity(
    'dispatch',
    annotateDispatch({
      prompt: promptText,
      classification,
      mode: 'auto',
      route: `tandem: ${lead} → ${follow}`,
      agent: lead,
    }) as any,
    { agent: lead, taskId: leadTask.task?.id },
  );

  return {
    tasks: [leadTask.task, followTask.task].filter(Boolean),
    handoffs: [leadHandoff.handoff, followHandoff.handoff].filter(Boolean),
    lead,
    follow,
  };
}
