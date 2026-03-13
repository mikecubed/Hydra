/**
 * Hydra Operator Concierge — mode-execution functions
 *
 * Extracted from lib/hydra-operator.ts (rf-op-concierge).
 * Contains the five dispatch-mode runners and their exclusive helpers:
 *   runCouncilPrompt, runCouncilJson, runAutoPrompt, runAutoPromptLegacy, runSmartPrompt
 *
 * Also exports buildAgentMessage (used by dispatchPrompt in hydra-operator.ts).
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- T7A: operator uses polymorphic any for dynamic dispatch */
/* eslint-disable @typescript-eslint/strict-boolean-expressions, @typescript-eslint/no-non-null-assertion -- T7A: standard JS truthiness; type narrowing tracked as follow-up */
/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unnecessary-type-conversion -- T7A: operator uses || for truthiness-based defaults */
/* eslint-disable no-await-in-loop -- T7A: sequential delegation publishing */
/* eslint-disable @typescript-eslint/explicit-module-boundary-types, @typescript-eslint/no-redundant-type-constituents -- T7A: return types use polymorphic any; full typing is a follow-up task */

import path from 'node:path';
import { spawn } from 'node:child_process';

import { buildAgentContext } from './hydra-context.ts';
import { rewriteNodeInvocation } from './hydra-exec-spawn.ts';
import { getAgent, getVerifier, getMode, setMode } from './hydra-agents.ts';
import { resolveProject, HYDRA_ROOT, loadHydraConfig } from './hydra-config.ts';
import {
  request,
  normalizeTask,
  short,
  classifyPrompt,
  selectTandemPair,
  generateSpec,
} from './hydra-utils.ts';
import { executeAgent } from './hydra-shared/agent-executor.ts';
import { gateIntent } from './hydra-intent-gate.ts';
import { setLastDispatch } from './hydra-statusbar.ts';
import { pushActivity, annotateDispatch } from './hydra-activity.ts';
import { isPersonaEnabled, getAgentFraming, getProcessLabel } from './hydra-persona.ts';
import { SMART_TIER_MAP } from './hydra-operator-ui.ts';

const config = resolveProject();

// ── Agent message builders ────────────────────────────────────────────────────

export function buildAgentMessage(agent: string, userPrompt: string) {
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

export function buildMiniRoundBrief(agent: string, userPrompt: string, report: any) {
  const agentConfig = getAgent(agent);
  const tasks = Array.isArray(report?.tasks)
    ? report.tasks.map((item: any) => normalizeTask(item)).filter(Boolean)
    : [];
  const questions = Array.isArray(report?.questions) ? report.questions : [];
  const consensus = String(report?.consensus ?? '').trim();

  const myTasks = tasks.filter((task: any) => task.owner === agent || task.owner === 'unassigned');
  const myQuestions = questions.filter((q: any) => q && (q.to === agent || q.to === 'human'));

  const taskText =
    myTasks.length === 0
      ? '- No explicit task assigned. Start by proposing first concrete step.'
      : myTasks
          .map(
            (task: any) =>
              `- ${String(task.title)}${task.done ? ` (DoD: ${String(task.done)})` : ''}${task.rationale ? ` [${String(task.rationale)}]` : ''}`,
          )
          .join('\n');

  const questionText =
    myQuestions.length === 0
      ? '- none'
      : myQuestions
          .map((q: any) => {
            const to = String(q.to ?? 'human');
            const question = String(q.question ?? '').trim();
            return question ? `- to ${to}: ${question}` : null;
          })
          .filter(Boolean)
          .join('\n');

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

function buildTandemBrief(
  agent: any,
  partner: any,
  promptText: any,
  _classification: any,
  role: any,
) {
  const agentConfig = getAgent(agent);
  const agentLabel = agentConfig ? agentConfig.label : agent.toUpperCase();
  const partnerLabel = getAgent(partner)?.label ?? partner.toUpperCase();

  const heading = isPersonaEnabled()
    ? `${getAgentFraming(agent)} ${getProcessLabel('dispatch')} directive (tandem ${String(role)}):`
    : `Hydra tandem dispatch for ${String(agentLabel)} (${String(role)}):`;

  const roleInstruction =
    role === 'lead'
      ? `You are the lead in a tandem pair. Analyze the objective and produce an actionable plan or analysis. Your output will be handed to ${String(partnerLabel)} for execution.`
      : `You are the follow-up in a tandem pair. Build on ${String(partnerLabel)}'s analysis and execute the work. Focus on implementation and verification.`;

  const rolePrompt = agentConfig
    ? agentConfig.rolePrompt
    : 'Contribute effectively to this objective.';

  return [
    heading,
    `Primary objective: ${String(promptText)}`,
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

// ── Cross-model verification ──────────────────────────────────────────────────

/**
 * Cross-model verification: route producer output to a paired verifier agent.
 * Returns { approved, issues, suggestions } or null if verification is skipped/fails.
 */
async function runCrossVerification(
  producerAgent: string,
  producerOutput: string,
  originalPrompt: string,
  specContent: string | null = null,
) {
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
    const result = await executeAgent(verifierAgent, reviewPrompt, {
      cwd: config.projectRoot,
      timeoutMs: 60_000,
      permissionMode: verifierAgent === 'codex' ? 'read-only' : 'plan',
    });
    if (!result.ok) return null;

    const output = (result.stdout ?? result.output) || '';
    let parsed = null;
    try {
      parsed = JSON.parse(output);
    } catch {
      const match = output.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          /* give up */
        }
      }
    }
    if (!parsed) return null;

    return {
      verifier: verifierAgent,
      approved: Boolean(parsed.approved),
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    };
  } catch {
    return null;
  }
}

/**
 * Check if cross-model verification should run for a given classification.
 */
export function shouldCrossVerify(classification: any) {
  const cfg = loadHydraConfig();
  const cvConfig = cfg.crossModelVerification;
  if (!cvConfig?.enabled) return false;
  if (cvConfig['mode'] === 'always') return true;
  if (cvConfig['mode'] === 'on-complex') return classification.tier === 'complex';
  return false;
}

// ── Delegation publishers ─────────────────────────────────────────────────────

async function publishMiniRoundDelegation({
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
  report: any;
}) {
  const normalizedTasks = (Array.isArray(report?.tasks) ? report.tasks : [])
    .map(normalizeTask)
    .filter(Boolean);
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
      notes: task.rationale ? `Mini-round rationale: ${String(task.rationale)}` : '',
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
  classification: any;
  agents?: string[] | null;
}) {
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

/**
 * Tandem dispatch: create 2 tasks + 2 handoffs for a lead→follow pair.
 * Zero agent CLI calls — daemon HTTP posts only.
 */
async function publishTandemDelegation({
  baseUrl,
  from,
  promptText,
  classification,
  agents = null,
}: {
  baseUrl: string;
  from: string;
  promptText: string;
  classification: any;
  agents?: string[] | null;
}) {
  const { taskType } = classification;
  let { tandemPair } = classification;

  if (agents && agents.length > 0) {
    tandemPair = selectTandemPair(taskType, classification.suggestedAgent, agents);
  }

  if (!tandemPair) {
    return publishFastPathDelegation({ baseUrl, from, promptText, classification, agents });
  }

  const { lead, follow } = tandemPair;

  const leadTask = (await request('POST', baseUrl, '/task/add', {
    title: `[Lead] ${short(promptText, 180)}`,
    owner: lead,
    status: 'todo',
    type: taskType,
    notes: `Tandem lead (${String(lead)} → ${String(follow)}). Analyze/plan then hand off.`,
  })) as any;

  const followTask = (await request('POST', baseUrl, '/task/add', {
    title: `[Follow] ${short(promptText, 180)}`,
    owner: follow,
    status: 'todo',
    type: taskType,
    notes: `Tandem follow (from ${String(lead)}). Execute based on lead's analysis. Ref: task ${String(leadTask.task?.id ?? '?')}`,
  })) as any;

  const leadBrief = buildTandemBrief(lead, follow, promptText, classification, 'lead');
  const leadHandoff = (await request('POST', baseUrl, '/handoff', {
    from,
    to: lead,
    summary: leadBrief,
    nextStep: `Analyze the objective and produce actionable plan. Your output will be forwarded to ${String(follow)}.`,
    tasks: leadTask.task?.id ? [leadTask.task.id] : [],
  })) as any;

  const followBrief = buildTandemBrief(follow, lead, promptText, classification, 'follow');
  const followHandoff = (await request('POST', baseUrl, '/handoff', {
    from,
    to: follow,
    summary: followBrief,
    nextStep: `Build on ${String(lead)}'s analysis and execute. Reference task ${String(leadTask.task?.id ?? '?')}.`,
    tasks: followTask.task?.id ? [followTask.task.id] : [],
  })) as any;

  pushActivity(
    'dispatch',
    annotateDispatch({
      prompt: promptText,
      classification,
      mode: 'auto',
      route: `tandem: ${String(lead)} → ${String(follow)}`,
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

// ── Subprocess runner ─────────────────────────────────────────────────────────

/**
 * Spawn a child process asynchronously, collecting stdout/stderr.
 * Unlike spawnSync, this does NOT block the event loop, so status bar
 * polling and redraws continue while the subprocess runs.
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts]
 * @param {Function} [onProgress] - Called with parsed JSON progress markers from stderr
 */
function spawnAsync(
  cmd: string,
  args: string[],
  opts: any = {},
  onProgress: ((data: any) => void) | null = null,
) {
  return new Promise((resolve) => {
    const chunks: { stdout: string[]; stderr: string[] } = { stdout: [], stderr: [] };
    let stderrBuf = '';
    const invocation = rewriteNodeInvocation(cmd, args, HYDRA_ROOT);
    const child = spawn(invocation.command, invocation.args, {
      cwd: opts.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => chunks.stdout.push(d));
    child.stderr.on('data', (d) => {
      chunks.stderr.push(d);
      if (onProgress) {
        stderrBuf += String(d);
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed[0] !== '{') continue;
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.type === 'council_phase') onProgress(parsed);
          } catch {
            /* not a progress marker */
          }
        }
      }
    });
    child.on('error', (err) => {
      resolve({ status: 1, stdout: '', stderr: err.message });
    });
    child.on('close', (code) => {
      resolve({
        status: code ?? 1,
        stdout: chunks.stdout.join(''),
        stderr: chunks.stderr.join(''),
      });
    });
  });
}

// ── Council runners ───────────────────────────────────────────────────────────

export async function runCouncilPrompt({
  baseUrl,
  promptText,
  rounds = 2,
  preview = false,
  onProgress = null,
  agents = null,
}: {
  baseUrl: string;
  promptText: string;
  rounds?: number;
  preview?: boolean;
  onProgress?: ((data: Record<string, unknown>) => void) | null;
  agents?: string[] | null;
}) {
  const councilScript = path.join(HYDRA_ROOT, 'lib', 'hydra-council.ts');
  const councilTimeoutMs = (config as any).routing?.councilTimeoutMs ?? 420_000;
  const args = [
    councilScript,
    `prompt=${promptText}`,
    `url=${baseUrl}`,
    `rounds=${String(rounds)}`,
    `timeoutMs=${String(councilTimeoutMs)}`,
  ];
  if (preview) {
    args.push('mode=preview', 'publish=false');
  } else {
    args.push('publish=true');
  }
  if (agents && agents.length > 0) {
    args.push(`agents=${agents.join(',')}`);
  }

  const result = (await spawnAsync('node', args, { cwd: config.projectRoot }, onProgress)) as any;

  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export async function runCouncilJson({
  baseUrl,
  promptText,
  rounds = 1,
  preview = false,
  publish = false,
  onProgress = null,
  agents = null,
}: {
  baseUrl: string;
  promptText: string;
  rounds?: number;
  preview?: boolean;
  publish?: boolean;
  onProgress?: ((data: Record<string, unknown>) => void) | null;
  agents?: string[] | null;
}) {
  const councilScript = path.join(HYDRA_ROOT, 'lib', 'hydra-council.ts');
  const councilTimeoutMs = (config as any).routing?.councilTimeoutMs ?? 420_000;
  const args = [
    councilScript,
    `prompt=${promptText}`,
    `url=${baseUrl}`,
    `rounds=${String(rounds)}`,
    `timeoutMs=${String(councilTimeoutMs)}`,
    'emit=json',
    'save=false',
    `publish=${publish ? 'true' : 'false'}`,
  ];
  if (preview) {
    args.push('mode=preview', 'publish=false');
  }
  if (agents && agents.length > 0) {
    args.push(`agents=${agents.join(',')}`);
  }

  const result = (await spawnAsync('node', args, { cwd: config.projectRoot }, onProgress)) as any;

  if (result.status !== 0) {
    return {
      ok: false,
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      report: null,
    };
  }

  try {
    const parsed = JSON.parse(result.stdout ?? '{}');
    return {
      ok: true,
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      report: parsed.report ?? null,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: `Failed to parse council JSON: ${(err as Error).message}`,
      report: null,
    };
  }
}

// ── Auto prompt runners ───────────────────────────────────────────────────────

export async function runAutoPrompt({
  baseUrl,
  from,
  agents,
  promptText,
  miniRounds,
  councilRounds,
  preview,
  onProgress = null,
}: {
  baseUrl: string;
  from: string;
  agents: string[];
  promptText: string;
  miniRounds: number;
  councilRounds: number;
  preview: boolean;
  onProgress?: ((data: Record<string, unknown>) => void) | null;
}) {
  // Intent gate: normalize filler/abbreviations, optionally LLM-rewrite low-confidence prompts
  const _intentCfg = (() => {
    try {
      const c = loadHydraConfig();
      return c.routing.intentGate;
    } catch {
      return {};
    }
  })();
  let _gatedText, classification;
  try {
    ({ text: _gatedText, classification } = await gateIntent(promptText, {
      enabled: (_intentCfg as any).enabled !== false,
      confidenceThreshold: (_intentCfg as any).confidenceThreshold ?? 0.55,
    }));
  } catch {
    _gatedText = promptText;
    classification = classifyPrompt(promptText);
  }
  const effectivePrompt = _gatedText;

  const routingConfig = (config as any).routing ?? {};

  // Re-resolve route strategy with agent filter
  let { routeStrategy } = classification;
  let tandemPair = classification.tandemPair;
  if (routeStrategy === 'tandem' && agents.length > 0) {
    tandemPair = selectTandemPair(classification.taskType, classification.suggestedAgent, agents);
    if (!tandemPair) routeStrategy = 'single';
  }
  if (routeStrategy === 'tandem' && routingConfig.tandemEnabled === false) {
    routeStrategy = 'single';
  }

  if (routingConfig.useLegacyTriage && routeStrategy !== 'single') {
    return runAutoPromptLegacy({
      baseUrl,
      from,
      agents,
      promptText: effectivePrompt,
      miniRounds,
      councilRounds,
      preview,
      onProgress,
      classification,
    });
  }

  // ── Single route (fast-path) ──
  if (routeStrategy === 'single') {
    if (preview) {
      return {
        mode: 'fast-path',
        recommended: 'handoff',
        route: `fast-path → ${classification.suggestedAgent}`,
        classification,
        triage: null,
        published: null,
        escalatedToCouncil: false,
      };
    }
    const published = await publishFastPathDelegation({
      baseUrl,
      from,
      promptText: effectivePrompt,
      classification,
      agents,
    });
    return {
      mode: 'fast-path',
      recommended: 'handoff',
      route: `fast-path → ${String(published.agent)} (${classification.taskType}, ${String(classification.confidence)} confidence)`,
      classification,
      triage: null,
      published: { tasks: [published.task], handoffs: [published.handoff] },
      escalatedToCouncil: false,
    };
  }

  // ── Tandem route (2 agents, 0 CLI calls) ──
  if (routeStrategy === 'tandem') {
    if (preview) {
      const pair = tandemPair ?? { lead: 'claude', follow: 'codex' };
      return {
        mode: 'tandem',
        recommended: 'tandem',
        route: `tandem: ${pair.lead} → ${pair.follow}`,
        classification,
        triage: null,
        published: null,
        escalatedToCouncil: false,
      };
    }
    const published = await publishTandemDelegation({
      baseUrl,
      from,
      promptText: effectivePrompt,
      classification,
      agents,
    });
    const pair = (published as any).lead
      ? { lead: (published as any).lead, follow: (published as any).follow }
      : (tandemPair ?? { lead: '?', follow: '?' });
    return {
      mode: 'tandem',
      recommended: 'tandem',
      route: `tandem: ${String(pair.lead)} → ${String(pair.follow)} (${classification.taskType})`,
      classification,
      triage: null,
      published: { tasks: (published as any).tasks, handoffs: (published as any).handoffs },
      escalatedToCouncil: false,
    };
  }

  // ── Council route (skip mini-round triage, go directly) ──
  let spec = null;
  try {
    spec = await generateSpec(effectivePrompt, null, { cwd: config.projectRoot });
  } catch {
    /* non-critical */
  }

  if (preview) {
    return {
      mode: 'council',
      recommended: 'council',
      route: 'council (complex prompt)',
      classification,
      triage: null,
      published: null,
      escalatedToCouncil: true,
      spec: spec ? { specId: spec.specId, specPath: spec.specPath } : null,
    };
  }

  const council = await runCouncilPrompt({
    baseUrl,
    promptText: effectivePrompt,
    rounds: councilRounds,
    preview: false,
    onProgress,
    agents,
  });
  if (!council.ok) {
    throw new Error(
      council.stderr ?? council.stdout ?? `Council exited with status ${String(council.status)}`,
    );
  }

  let verification = null;
  if (shouldCrossVerify(classification) && council.stdout) {
    verification = await runCrossVerification(
      'claude',
      council.stdout.trim(),
      effectivePrompt,
      spec?.specContent,
    );
  }

  return {
    mode: 'council',
    recommended: 'council',
    route: 'council (complex prompt)',
    classification,
    triage: null,
    published: null,
    escalatedToCouncil: true,
    councilOutput: council.stdout.trim(),
    spec: spec ? { specId: spec.specId, specPath: spec.specPath } : null,
    verification,
  };
}

/**
 * Legacy auto prompt path: uses mini-round triage (4 agent calls).
 * Retained behind `routing.useLegacyTriage` config toggle.
 */
export async function runAutoPromptLegacy({
  baseUrl,
  from,
  agents,
  promptText,
  miniRounds,
  councilRounds,
  preview,
  onProgress,
  classification,
}: {
  baseUrl: string;
  from: string;
  agents: string[];
  promptText: string;
  miniRounds: number;
  councilRounds: number;
  preview: boolean;
  onProgress: ((data: any) => void) | null;
  classification: any | null;
}) {
  let effectivePrompt = promptText;
  let localClassification = classification;
  if (!localClassification) {
    const _intentCfg = (() => {
      try {
        const c = loadHydraConfig();
        return c.routing.intentGate;
      } catch {
        return {};
      }
    })();
    try {
      const { text: _gatedText, classification: _gatedClassification } = await gateIntent(
        promptText,
        {
          enabled: (_intentCfg as any).enabled !== false,
          confidenceThreshold: (_intentCfg as any).confidenceThreshold ?? 0.55,
        },
      );
      localClassification = _gatedClassification;
      effectivePrompt = _gatedText;
    } catch {
      localClassification = classifyPrompt(promptText);
    }
  }

  const triage = await runCouncilJson({
    baseUrl,
    promptText: effectivePrompt,
    rounds: miniRounds,
    preview,
    publish: false,
    onProgress,
    agents,
  });

  if (!triage.ok || !triage.report) {
    throw new Error(
      triage.stderr ?? triage.stdout ?? `Mini-round exited with status ${String(triage.status)}`,
    );
  }

  const recommended = String(triage.report.recommendedMode ?? 'handoff').toLowerCase();
  if (preview) {
    return {
      mode: 'preview',
      recommended,
      route:
        localClassification.tier === 'complex'
          ? 'council (complex prompt)'
          : 'mini-round triage → preview',
      classification: localClassification,
      triage: triage.report,
      published: null,
      escalatedToCouncil: recommended === 'council',
    };
  }

  let spec = null;
  if (localClassification.tier === 'complex') {
    try {
      spec = await generateSpec(effectivePrompt, null, { cwd: config.projectRoot });
    } catch {
      /* non-critical */
    }
  }

  if (recommended === 'council' || localClassification.tier === 'complex') {
    const council = await runCouncilPrompt({
      baseUrl,
      promptText: effectivePrompt,
      rounds: councilRounds,
      preview: false,
      onProgress,
      agents,
    });
    if (!council.ok)
      throw new Error(
        council.stderr ?? council.stdout ?? `Council exited with status ${String(council.status)}`,
      );
    let verification = null;
    if (shouldCrossVerify(localClassification) && council.stdout) {
      verification = await runCrossVerification(
        'claude',
        council.stdout.trim(),
        effectivePrompt,
        spec?.specContent,
      );
    }
    return {
      mode: 'council',
      recommended,
      route: 'council (escalated)',
      classification: localClassification,
      triage: triage.report,
      published: null,
      escalatedToCouncil: true,
      councilOutput: council.stdout.trim(),
      spec: spec ? { specId: spec.specId, specPath: spec.specPath } : null,
      verification,
    };
  }

  const published = await publishMiniRoundDelegation({
    baseUrl,
    from,
    agents,
    promptText: effectivePrompt,
    report: triage.report,
  });
  return {
    mode: 'handoff',
    recommended,
    route: 'mini-round triage → delegated',
    classification: localClassification,
    triage: triage.report,
    published,
    escalatedToCouncil: false,
  };
}

// ── Smart Mode ────────────────────────────────────────────────────────────────

export async function runSmartPrompt({
  baseUrl,
  from,
  agents,
  promptText,
  miniRounds,
  councilRounds,
  preview,
  onProgress = null,
}: {
  baseUrl: string;
  from: string;
  agents: string[];
  promptText: string;
  miniRounds: number;
  councilRounds: number;
  preview: boolean;
  onProgress?: ((data: Record<string, unknown>) => void) | null;
}) {
  const classification = classifyPrompt(promptText);
  const targetMode = (SMART_TIER_MAP as Record<string, string>)[classification.tier] || 'balanced';

  const previousMode = getMode();

  try {
    setMode(targetMode);
  } catch {
    // If targetMode doesn't exist in modeTiers, fall through to auto
  }

  try {
    const result = await runAutoPrompt({
      baseUrl,
      from,
      agents,
      promptText,
      miniRounds,
      councilRounds,
      preview,
      onProgress,
    });

    (result as any).smartTier = classification.tier;
    (result as any).smartMode = targetMode;
    result.route = `${classification.tier}\u2192${result.route}`;

    setLastDispatch({
      route: `${classification.tier}\u2192${String(result.mode === 'fast-path' ? (result.published?.handoffs?.[0]?.to ?? classification.suggestedAgent ?? 'agent') : result.mode)}`,
      tier: classification.tier,
      agent: result.mode === 'fast-path' ? classification.suggestedAgent || '' : '',
      mode: 'smart',
    });

    return result;
  } finally {
    try {
      setMode(previousMode);
    } catch {
      /* ignore */
    }
  }
}
