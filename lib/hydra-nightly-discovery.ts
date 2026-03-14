/**
 * Hydra Nightly Discovery — AI-powered task suggestion via agent analysis.
 *
 * Dispatches an agent (default: gemini) to analyze the codebase and propose
 * improvement tasks. Returns discovered items as ScannedTask[] for merging
 * into the nightly pipeline.
 *
 * Non-blocking: agent failures return [] without stopping the pipeline.
 */

import { loadHydraConfig } from './hydra-config.ts';
import { classifyTask, bestAgentFor } from './hydra-agents.ts';
import { classifyPrompt } from './hydra-utils.ts';
import { taskToSlug, type ScannedTask } from './hydra-tasks-scanner.ts';
import { executeAgentWithRecovery } from './hydra-shared/agent-executor.ts';
import { getAgentInstructionFile } from './hydra-sync-md.ts';
import { recordCallStart, recordCallComplete, recordCallError } from './hydra-metrics.ts';
import pc from 'picocolors';

// ── Logging ─────────────────────────────────────────────────────────────────

const log = {
  info: (msg: string) => process.stderr.write(`  ${pc.blue('i')} ${msg}\n`),
  ok: (msg: string) => process.stderr.write(`  ${pc.green('+')} ${msg}\n`),
  warn: (msg: string) => process.stderr.write(`  ${pc.yellow('!')} ${msg}\n`),
  dim: (msg: string) => process.stderr.write(`  ${pc.dim(msg)}\n`),
};

// ── Prompt Builder ──────────────────────────────────────────────────────────

function buildDiscoveryPrompt(
  projectRoot: string,
  opts: {
    existingTasks?: string[];
    focus?: string[];
    instructionFile?: string;
    profile?: string;
    extraContext?: string;
  } = {},
) {
  const {
    existingTasks = [],
    focus = [],
    instructionFile = 'CLAUDE.md',
    profile = 'nightly',
    extraContext = '',
  } = opts;

  const existingList =
    existingTasks.length > 0 ? existingTasks.map((t) => `- ${t}`).join('\n') : '(none)';

  const focusSection =
    focus.length > 0 ? `\n## Focus Areas\nPrioritize tasks related to: ${focus.join(', ')}\n` : '';

  const header =
    profile === 'actualize'
      ? '# Hydra Self-Actualization — Suggest Improvement Tasks'
      : '# Codebase Analysis — Suggest Improvement Tasks';

  const guidelineBlock =
    profile === 'actualize'
      ? `## Guidelines
- Propose 3-6 suggestions, sorted by priority
- Prefer high-leverage improvements: self-awareness, robustness, diagnostics, guardrails, developer experience
- It is OK to propose new commands/endpoints/tools, but keep each task bounded and testable
- Avoid sweeping rewrites; prefer incremental changes with tests
- Do NOT suggest tasks already in the queue above`
      : `## Guidelines
- Focus on concrete, achievable tasks (30 min or less each)
- Prefer bug fixes, missing error handling, test gaps, and code quality
- Do NOT suggest major architectural changes or new features
- Do NOT suggest tasks already in the queue above
- Return 3-5 suggestions, sorted by priority`;

  const ctxBlock = extraContext === '' ? '' : `\n## Extra Context\n${extraContext}\n`;

  return `${header}

You are analyzing the codebase at \`${projectRoot}\` to suggest concrete, actionable improvement tasks.

## Instructions
1. Read the project's \`${instructionFile}\` to understand the codebase architecture and conventions
2. Explore key source files to identify areas for improvement
3. Return a JSON array of task suggestions

## Already Queued (skip these)
${existingList}
${focusSection}
${ctxBlock}
## Output Format
Return ONLY a JSON array (no markdown fences, no prose). Each item:
\`\`\`json
[
  {
    "title": "Short imperative task title",
    "description": "1-2 sentence explanation of what to do and why",
    "priority": "high|medium|low",
    "taskType": "implementation|refactor|testing|security|documentation|analysis"
  }
]
\`\`\`

${guidelineBlock}`;
}

// ── JSON Extraction ─────────────────────────────────────────────────────────

function extractJsonArray(text: string) {
  // Try direct parse first
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed as unknown[];
  } catch {
    /* continue */
  }

  // Try extracting from markdown code fences
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- JSON.parse result
      const parsed = JSON.parse(fenceMatch[1].trim());
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- JSON.parse result
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* continue */
    }
  }

  // Try regex for [...] blocks
  const bracketMatch = text.match(/\[[\s\S]*\]/);
  if (bracketMatch) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- JSON.parse result
      const parsed = JSON.parse(bracketMatch[0]);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- JSON.parse result
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* continue */
    }
  }

  return null;
}

// ── Main Export ─────────────────────────────────────────────────────────────

type RunDiscoveryOpts = {
  agent?: string;
  model?: string;
  maxSuggestions?: number;
  focus?: string[];
  timeoutMs?: number;
  existingTasks?: string[];
  profile?: string;
  extraContext?: string;
};

interface ResolvedDiscoveryConfig {
  agent: string;
  modelOverride: string | null;
  maxSuggestions: number;
  focus: string[];
  timeoutMs: number;
  existingTasks: string[];
  profile: string;
  extraContext: string;
}

function resolveDiscoveryConfig(
  opts: RunDiscoveryOpts,
  discoveryCfg: Record<string, unknown>,
): ResolvedDiscoveryConfig {
  return {
    agent: opts.agent ?? (discoveryCfg['agent'] as string | undefined) ?? 'gemini',
    modelOverride: opts.model ?? (discoveryCfg['model'] as string | undefined) ?? null,
    maxSuggestions:
      opts.maxSuggestions ?? (discoveryCfg['maxSuggestions'] as number | undefined) ?? 5,
    focus: opts.focus ?? (discoveryCfg['focus'] as string[] | undefined) ?? [],
    timeoutMs: opts.timeoutMs ?? (discoveryCfg['timeoutMs'] as number | undefined) ?? 5 * 60 * 1000,
    existingTasks: opts.existingTasks ?? [],
    profile: opts.profile ?? 'nightly',
    extraContext: opts.extraContext ?? '',
  };
}

async function executeDiscoveryAgent(
  agent: string,
  prompt: string,
  opts: { cwd: string; timeoutMs: number; modelOverride?: string },
): Promise<{ ok: boolean; stdout?: string; output?: string; error?: string } | null> {
  const handle = recordCallStart(agent, 'discovery');
  try {
    const result = await executeAgentWithRecovery(agent, prompt, opts);
    if (!result.ok) {
      recordCallError(handle, new Error(result.error ?? 'agent returned non-ok'));
      log.warn(`Discovery agent returned error: ${result.error ?? 'unknown'}`);
      return null;
    }
    recordCallComplete(handle, result as unknown as Parameters<typeof recordCallComplete>[1]);
    return result as { ok: boolean; stdout?: string; output?: string; error?: string };
  } catch (err: unknown) {
    recordCallError(handle, err instanceof Error ? err : new Error(String(err)));
    log.warn(`Discovery agent failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function buildDiscoveredTask(item: Record<string, unknown>, agent: string): ScannedTask | null {
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- untyped data
  if (!item['title'] || typeof item['title'] !== 'string') return null;
  const title = item['title'].trim();
  const slug = taskToSlug(title);
  const taskType = (item['taskType'] ?? classifyTask(title)) as string;
  const suggestedAgent = bestAgentFor(taskType);
  const { tier } = classifyPrompt(title);
  return {
    id: `ai-discovery:${slug}`,
    title,
    slug,
    source: 'ai-discovery' as ScannedTask['source'],
    sourceRef: `${agent}-discovery`,
    taskType,
    suggestedAgent,
    complexity: tier,
    priority: (item['priority'] ?? 'medium') as ScannedTask['priority'],
    body: (item['description'] ?? null) as string | null,
    issueNumber: null,
  };
}

/**
 * Run AI discovery to suggest improvement tasks for the nightly pipeline.
 *
 * @param {string} projectRoot - Absolute path to the project root
 * @param {object} [opts]
 * @param {string} [opts.agent='gemini'] - Agent to use for discovery
 * @param {number} [opts.maxSuggestions=5] - Max tasks to return
 * @param {string[]} [opts.focus=[]] - Optional focus areas
 * @param {number} [opts.timeoutMs=300000] - Agent timeout
 * @param {string[]} [opts.existingTasks=[]] - Already-queued task titles for dedup
 * @returns {Promise<import('./hydra-tasks-scanner.ts').ScannedTask[]>}
 */
export async function runDiscovery(
  projectRoot: string,
  opts: RunDiscoveryOpts = {},
): Promise<ScannedTask[]> {
  const cfg = loadHydraConfig();
  const discoveryCfg = (cfg.nightly?.aiDiscovery ?? {}) as Record<string, unknown>;
  const resolved = resolveDiscoveryConfig(opts, discoveryCfg);

  const instructionFile = getAgentInstructionFile(resolved.agent, projectRoot);
  const prompt = buildDiscoveryPrompt(projectRoot, {
    existingTasks: resolved.existingTasks,
    focus: resolved.focus,
    instructionFile,
    profile: resolved.profile,
    extraContext: resolved.extraContext,
  });

  log.info(`AI Discovery: dispatching ${resolved.agent} to analyze codebase...`);

  const agentOpts: { cwd: string; timeoutMs: number; modelOverride?: string } = {
    cwd: projectRoot,
    timeoutMs: resolved.timeoutMs,
    ...(resolved.modelOverride != null &&
      resolved.modelOverride !== '' && { modelOverride: resolved.modelOverride }),
  };
  const result = await executeDiscoveryAgent(resolved.agent, prompt, agentOpts);
  if (result == null) return [];

  const output = result.stdout ?? result.output;
  const items = extractJsonArray(output ?? '');

  if (!items || items.length === 0) {
    log.warn('Discovery: could not parse task suggestions from agent output');
    return [];
  }

  const tasks: ScannedTask[] = [];
  for (const item of items.slice(0, resolved.maxSuggestions)) {
    const task = buildDiscoveredTask(item as Record<string, unknown>, resolved.agent);
    if (task != null) tasks.push(task);
  }

  log.ok(`Discovery: ${String(tasks.length)} task(s) suggested`);
  for (const t of tasks) {
    log.dim(`  - [${t.priority}] ${t.title}`);
  }

  return tasks;
}
