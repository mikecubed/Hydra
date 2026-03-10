/**
 * Hydra shared utilities.
 *
 * Consolidates duplicated helpers from hydra-council, hydra-operator, hydra-dispatch,
 * orchestrator-daemon, and orchestrator-client into one importable module.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KNOWN_OWNERS, classifyTask, bestAgentFor, AGENT_NAMES } from './hydra-agents.ts';
import { executeAgent } from './hydra-shared/agent-executor.ts';
import { spawnSyncCapture } from './hydra-proc.ts';

// Suppress unused import warning for `os` (kept for backwards-compat consumers)
void os;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ParsedArgs {
  options: Record<string, string | boolean>;
  positionals: string[];
}

export interface ParsedArgsWithCommand extends ParsedArgs {
  command: string;
}

interface RunProcessOpts {
  cwd?: string;
  input?: string;
}

export interface RunProcessResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: string;
  timedOut: boolean;
}

export interface TestFailure {
  name: string;
  error: string;
}

export interface ParseTestOutputResult {
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  failures: TestFailure[];
  summary: string;
}

export interface NormalizedTask {
  owner: string;
  title: string;
  done: string;
  rationale: string;
}

interface TandemPair {
  lead: string;
  follow: string;
}

export interface ClassifyPromptResult {
  tier: 'simple' | 'moderate' | 'complex';
  taskType: string;
  suggestedAgent: string;
  confidence: number;
  reason: string;
  routeStrategy?: 'single' | 'tandem' | 'council';
  tandemPair?: TandemPair | null;
}

export interface GenerateSpecResult {
  specId: string;
  specPath: string;
  specContent: string;
}

interface GenerateSpecOpts {
  specsDir?: string;
  fastModel?: string;
  cwd?: string;
}

const ORCH_TOKEN = process.env['AI_ORCH_TOKEN'] ?? '';
const NETWORK_RETRY_COUNT = 4;
const NETWORK_RETRY_DELAY_MS = 300;
const DEFAULT_TIMEOUT_MS = 1000 * 60 * 7;

// --- Timestamp ---

export function nowIso(): string {
  return new Date().toISOString();
}

export function runId(prefix = 'HYDRA'): string {
  const d = new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${prefix}_${yyyy}${mm}${dd}_${hh}${min}${ss}`;
}

// --- CLI Argument Parsing ---

export function parseArgs(argv: string[]): ParsedArgs {
  const options: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (const token of argv.slice(2)) {
    if (token.startsWith('--')) {
      options[token.slice(2)] = true;
    } else if (token.includes('=')) {
      const [rawKey, ...rawValue] = token.split('=');
      const key = rawKey.trim();
      if (key) {
        options[key] = rawValue.join('=').trim();
      }
    } else {
      positionals.push(token);
    }
  }
  return { options, positionals };
}

export function parseArgsWithCommand(argv: string[]): ParsedArgsWithCommand {
  const [command = 'help', ...rest] = argv.slice(2);
  const options: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (const token of rest) {
    if (token.startsWith('--')) {
      options[token.slice(2)] = true;
    } else if (token.includes('=')) {
      const [rawKey, ...rawValue] = token.split('=');
      const key = rawKey.trim();
      if (key) {
        options[key] = rawValue.join('=').trim();
      }
    } else {
      positionals.push(token);
    }
  }
  return { command, options, positionals };
}

export function getOption(options: Record<string, string | boolean>, key: string, fallback = ''): string {
  const val = (options as Record<string, string | boolean | undefined>)[key];
  if (val !== undefined) {
    return String(val);
  }
  return fallback;
}

export function requireOption(options: Record<string, string | boolean>, key: string, help = ''): string {
  const value = getOption(options, key, '');
  if (!value) {
    const suffix = help ? `\n${help}` : '';
    throw new Error(`Missing required option "${key}".${suffix}`);
  }
  return value;
}

export function getPrompt(options: Record<string, string | boolean>, positionals: string[]): string {
  if (options['prompt']) {
    return String(options['prompt']);
  }
  if (positionals.length > 0) {
    return positionals.join(' ');
  }
  return '';
}

export function boolFlag(value: unknown, fallback = false): boolean {
  if (value === undefined || value === '') {
    return fallback;
  }
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return fallback;
  }
  const normalized = String(value).toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(normalized);
}

/** Split a value into a trimmed string array. Splits on commas only. */
export function parseList(value: string | string[] | null | undefined): string[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((x) => x.trim()).filter(Boolean);
  }
  return value
    .split(/,\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
}

// --- Text Helpers ---

export function short(text: unknown, max = 300): string {
  let raw: string;
  if (text == null) {
    raw = '';
  } else if (typeof text === 'string') {
    raw = text;
  } else if (typeof text === 'number' || typeof text === 'boolean') {
    raw = String(text);
  } else {
    raw = JSON.stringify(text);
  }
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) {
    return cleaned;
  }
  return `${cleaned.slice(0, max - 3)}...`;
}

// --- JSON Parsing ---

export function parseJsonLoose(text: unknown): unknown {
  if (text == null) return null;
  if (typeof text !== 'string') return null;
  const raw = text.trim();
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    // continue
  }

  const blockMatch = raw.match(/```json\s*([\s\S]*?)\s*```/i);
  if (blockMatch) {
    try {
      return JSON.parse(blockMatch[1]);
    } catch {
      // continue
    }
  }

  const objMatch = raw.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]);
    } catch {
      // continue
    }
  }

  return null;
}

// --- Process Execution ---

/**
 * Run a command synchronously and return structured results.
 * @param command - The command to execute
 * @param args - Arguments for the command
 * @param timeoutMs - Timeout in ms
 * @param extraOpts - Additional options
 */
export function runProcess(command: string, args: string[], timeoutMs = DEFAULT_TIMEOUT_MS, extraOpts: RunProcessOpts = {}): RunProcessResult {
  const spawnOpts = {
    cwd: extraOpts.cwd ?? process.cwd(),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxOutputBytes: 1024 * 1024 * 8,
    windowsHide: true,
    shell: false,
    input: extraOpts.input,
  };

  const result = spawnSyncCapture(command, args, spawnOpts);
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';

  if (result.error) {
    return {
      ok: false,
      exitCode: result.status,
      stdout,
      stderr,
      error: result.error.message,
      timedOut: result.signal === 'SIGTERM',
    };
  }

  return {
    ok: result.status === 0,
    exitCode: result.status,
    stdout,
    stderr,
    error: '',
    timedOut: result.signal === 'SIGTERM',
  };
}

// --- Test Output Parsing ---

/**
 * Parse Node.js test runner output (TAP / spec reporter) into structured results.
 * Gracefully returns zeros when output can't be parsed.
 */
export function parseTestOutput(stdout = '', stderr = ''): ParseTestOutputResult {
  const combined = `${stdout}\n${stderr}`;
  let total = 0,
    passed = 0,
    failed = 0,
    durationMs = 0;
  const failures = [];

  // TAP summary counters: # tests N, # pass N, # fail N, # duration_ms N
  const totalMatch = combined.match(/^# tests\s+(\d+)/m);
  const passMatch = combined.match(/^# pass\s+(\d+)/m);
  const failMatch = combined.match(/^# fail\s+(\d+)/m);
  const durationMatch = combined.match(/^# duration_ms\s+([\d.]+)/m);

  if (totalMatch) total = Number.parseInt(totalMatch[1], 10);
  if (passMatch) passed = Number.parseInt(passMatch[1], 10);
  if (failMatch) failed = Number.parseInt(failMatch[1], 10);
  if (durationMatch) durationMs = Number.parseFloat(durationMatch[1]);

  // If we got fail count but not total, derive total from pass+fail
  if (!totalMatch && (passMatch || failMatch)) {
    total = passed + failed;
  }

  // Extract failed test names from TAP: "not ok N - description"
  const tapFailures = combined.matchAll(/^not ok \d+[\s-]+(.+)/gm);
  for (const m of tapFailures) {
    const name = m[1].trim();
    // Look for indented error line after the failure marker
    const idx = combined.indexOf(m[0]);
    const afterFailure = combined.slice(idx + m[0].length, idx + m[0].length + 500);
    const errorMatch = afterFailure.match(/\n\s{2,}(.+)/);
    failures.push({ name, error: errorMatch ? errorMatch[1].trim() : '' });
  }

  // Spec reporter: "✗ description" or "✖ description" (× also)
  const specFailures = combined.matchAll(/^[ \t]*(?:✗|✖|×)\s+(.+)/gm);
  for (const m of specFailures) {
    const name = m[1].trim();
    // Avoid duplicates if TAP already captured it
    if (failures.some((f) => f.name === name)) continue;
    const idx = combined.indexOf(m[0]);
    const afterFailure = combined.slice(idx + m[0].length, idx + m[0].length + 500);
    const errorMatch = afterFailure.match(/\n\s{2,}(.+)/);
    failures.push({ name, error: errorMatch ? errorMatch[1].trim() : '' });
  }

  // If we found failures but no fail count from counters, use failures length
  if (failed === 0 && failures.length > 0) {
    failed = failures.length;
    if (total === 0) total = passed + failed;
  }

  // Build summary string
  let summary = '';
  if (total > 0 || failed > 0) {
    if (failed > 0) {
      const names = failures
        .slice(0, 5)
        .map((f) => (f.name.length > 40 ? `${f.name.slice(0, 37)}...` : f.name));
      summary = `${String(failed)}/${String(total)} failed${names.length > 0 ? `: ${names.join(', ')}` : ''}`;
    } else {
      summary = `${String(passed)}/${String(total)} passed`;
    }
  }

  return { total, passed, failed, durationMs, failures, summary };
}

// --- HTTP Client (with retry) ---

export async function request<T = unknown>(
  method: string,
  baseUrl: string,
  route: string,
  body: unknown = null,
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (ORCH_TOKEN) {
    headers['x-ai-orch-token'] = ORCH_TOKEN;
  }
  if (body !== null) {
    headers['Content-Type'] = 'application/json';
  }

  let response: Awaited<ReturnType<typeof fetch>> | undefined;
  let lastNetworkError: unknown = null;

  for (let attempt = 1; attempt <= NETWORK_RETRY_COUNT; attempt += 1) {
    try {
      response = await fetch(`${baseUrl}${route}`, {
        method,
        headers,
        body: body === null ? undefined : JSON.stringify(body),
      });
      lastNetworkError = null;
      break;
    } catch (err) {
      lastNetworkError = err;
      if (attempt >= NETWORK_RETRY_COUNT) {
        break;
      }
      await new Promise<void>((resolve) => { setTimeout(resolve, NETWORK_RETRY_DELAY_MS * attempt); });
    }
  }

  if (lastNetworkError) {
    throw new Error(
      `Unable to reach Hydra daemon at ${baseUrl}. Start it with "npm run hydra:start" or set url=http://127.0.0.1:4173.`,
    );
  }

  const payload = await response!.json().catch(() => ({})) as { error?: string };
  if (!response!.ok) {
    throw new Error(payload.error ?? `HTTP ${String(response!.status)}`);
  }

  return payload as T;
}

// --- Filesystem ---

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// --- Task Normalization ---

export function sanitizeOwner(owner: unknown): string {
  const candidate = (typeof owner === 'string' ? owner : '').toLowerCase();
  if (KNOWN_OWNERS.has(candidate)) {
    return candidate;
  }
  return 'unassigned';
}

export function normalizeTask(item: unknown, fallbackOwner = 'unassigned'): NormalizedTask | null {
  if (!item || typeof item !== 'object') {
    return null;
  }
  const record = item as Record<string, unknown>;
  const str = (key: string): string => {
    const v = record[key];
    return typeof v === 'string' ? v : '';
  };
  const title = (str('title') || str('task')).trim();
  if (!title) {
    return null;
  }
  const owner = sanitizeOwner(str('owner') || fallbackOwner);
  const done = (str('definition_of_done') || str('done') || str('acceptance')).trim();
  const rationale = (str('rationale') || str('why')).trim();
  return { owner, title, done, rationale };
}

export function dedupeTasks(tasks: Array<NormalizedTask | null | undefined>): NormalizedTask[] {
  const out: NormalizedTask[] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    if (!task) {
      continue;
    }
    const key = `${task.owner}::${task.title.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(task);
  }
  return out;
}

// --- Prompt Classification (Fast-Path Dispatch) ---

const COMPLEX_MARKERS =
  /\b(should we|trade.?off|design|decide|compare|investigate|explore|evaluate|pros?\s+(?:and|&)\s+cons?|which approach|what strategy)\b/i;
const STRATEGIC_MARKERS =
  /\b(deep dive|make sure|ensure|effectively|efficient|productive|professional|maximize|optimize|improve|best (?:practice|approach|way)|let'?s (?:make|take|think|figure))\b/i;
const MULTI_OBJECTIVE = /\b(?:and|also|plus|additionally)\b/i;
const TANDEM_INDICATORS =
  /\b(?:first\s+\w+(?:\s+\w+){0,5}\s+then\b|review\s+and\s+fix|analyze\s+and\s+implement|plan\s+(?:and\s+|then\s+)?build|assess\s+(?:and|then)\s+(?:fix|implement|refactor)|research\s+(?:and|then)\s+(?:implement|build|write)|check\s+(?:and|then)\s+(?:fix|update|refactor))/i;

// Task-type → tandem pair mapping
const TANDEM_PAIRS: Record<string, TandemPair> = {
  planning: { lead: 'claude', follow: 'codex' },
  architecture: { lead: 'claude', follow: 'gemini' },
  review: { lead: 'gemini', follow: 'claude' },
  refactor: { lead: 'claude', follow: 'codex' },
  implementation: { lead: 'claude', follow: 'codex' },
  analysis: { lead: 'gemini', follow: 'claude' },
  testing: { lead: 'codex', follow: 'gemini' },
  security: { lead: 'gemini', follow: 'claude' },
  research: { lead: 'gemini', follow: 'claude' },
  documentation: { lead: 'claude', follow: 'codex' },
};

/**
 * Select optimal tandem pair (lead + follow agent) for a task type.
 * Respects agent filter — if one is excluded, swaps with best available.
 * If only 1 agent available, returns null (degrade to single).
 */
export function selectTandemPair(taskType: string, _suggestedAgent: string, agents: string[] | null = null): TandemPair | null {
  const pair = TANDEM_PAIRS[taskType] ?? TANDEM_PAIRS['implementation'];
  let { lead, follow } = pair;

  if (!agents || agents.length === 0) return { lead, follow };

  // Only 1 agent available → can't do tandem
  if (agents.length < 2) return null;

  const leadOk = agents.includes(lead);
  const followOk = agents.includes(follow);

  if (leadOk && followOk) return { lead, follow };

  // Swap out missing member with best available alternative
  if (!leadOk) {
    lead = agents.find((a) => a !== follow) ?? agents[0];
  }
  if (!followOk) {
    follow = agents.find((a) => a !== lead) ?? agents[0];
  }

  // Still same agent after substitution → can't tandem
  if (lead === follow) return null;

  return { lead, follow };
}

/**
 * Local heuristic classifier for prompt complexity.
 * Returns { tier, taskType, suggestedAgent, confidence, reason }.
 *
 * Tiers:
 *   - simple:   skip triage, dispatch directly (confidence >= 0.7)
 *   - moderate: run mini-round triage (default)
 *   - complex:  full council deliberation
 */
export function classifyPrompt(promptText: unknown): ClassifyPromptResult {
  const text = (typeof promptText === 'string' ? promptText : '').trim();
  if (!text) {
    return {
      tier: 'moderate',
      taskType: 'implementation',
      suggestedAgent: 'claude',
      confidence: 0.3,
      reason: 'Empty prompt',
    };
  }

  const words = text.split(/\s+/);
  const wordCount = words.length;
  const lowerText = text.toLowerCase();

  let simpleScore = 0;
  let complexScore = 0;
  const signals = [];

  // Word count signals
  if (wordCount <= 12) {
    simpleScore += 0.3;
    signals.push('short prompt');
  } else if (wordCount <= 20) {
    simpleScore += 0.1;
    signals.push('medium prompt');
  } else if (wordCount >= 40) {
    complexScore += 0.15;
    signals.push('long prompt');
  }

  // Single clear action verb (imperative) → strong simple signal
  const actionVerbs =
    /^(fix|add|create|implement|update|refactor|remove|delete|write|build|change|move|rename|test|run|check|set|get|make|clean|bump|install|deploy|format|lint)\b/i;
  if (actionVerbs.test(lowerText)) {
    simpleScore += 0.1;
    signals.push('imperative action');
  }

  // File path detection (.mjs, .ts, .js, .json, path separators in context)
  if (
    /(?:\/[\w.-]+\.[\w]+|\\[\w.-]+\.[\w]+|\.\w{1,5}\b)/.test(text) &&
    /\.(mjs|js|ts|tsx|jsx|json|css|html|py|md|yml|yaml)/.test(lowerText)
  ) {
    simpleScore += 0.2;
    signals.push('contains file paths');
  }

  // Task type classification via existing classifyTask
  const taskType = classifyTask(text, '');

  // Strong single-task-type match
  if (taskType !== 'implementation') {
    simpleScore += 0.1;
    signals.push(`clear task type: ${taskType}`);
  }

  // Agent name mention → user targeting specific agent
  const mentionedAgent = (AGENT_NAMES as string[]).find((a) => lowerText.includes(a));
  if (mentionedAgent) {
    simpleScore += 0.2;
    signals.push(`mentions agent: ${mentionedAgent}`);
  }

  // Complexity markers
  if (COMPLEX_MARKERS.test(lowerText)) {
    complexScore += 0.35;
    signals.push('ambiguity/decision markers');
  }

  // Strategic/design-level intent
  if (STRATEGIC_MARKERS.test(lowerText)) {
    complexScore += 0.25;
    signals.push('strategic/design intent');
  }

  // Multi-sentence prompts (3+ sentences) suggest complex thinking
  const sentenceCount = text.split(/[.!?]+/).filter((s) => s.trim().length > 5).length;
  if (sentenceCount >= 3) {
    complexScore += 0.2;
    signals.push(`${String(sentenceCount)} sentences`);
  }

  // Question marks suggest uncertainty
  if (text.includes('?')) {
    complexScore += 0.15;
    signals.push('contains question');
  }

  // Multiple verb phrases joined by "and" → multi-objective
  const verbPhrasePattern =
    /\b(fix|add|create|implement|update|refactor|remove|delete|write|build|change|move|rename)\b/gi;
  const verbMatches = lowerText.match(verbPhrasePattern) ?? [];
  if (verbMatches.length >= 2 && MULTI_OBJECTIVE.test(lowerText)) {
    complexScore += 0.2;
    signals.push('multiple objectives');
  }

  // Determine tier
  const netScore = simpleScore - complexScore;
  let tier: 'simple' | 'moderate' | 'complex';
  let confidence: number;

  if (netScore >= 0.3) {
    tier = 'simple';
    confidence = Math.min(0.95, 0.7 + netScore * 0.4);
  } else if (complexScore >= 0.4) {
    tier = 'complex';
    confidence = Math.min(0.95, 0.5 + complexScore * 0.5);
  } else {
    tier = 'moderate';
    confidence = 0.5 + Math.abs(netScore) * 0.2;
  }

  // Tandem-indicator detection: two-phase language upgrades simple→tandem route
  const hasTandemIndicator = TANDEM_INDICATORS.test(lowerText);
  if (hasTandemIndicator) {
    signals.push('two-phase language');
  }

  // Suggested agent
  const suggestedAgent: string = mentionedAgent ?? (bestAgentFor(taskType) as string);

  // Route strategy: single / tandem / council
  let routeStrategy: 'single' | 'tandem' | 'council';
  if (tier === 'simple' && !hasTandemIndicator) {
    routeStrategy = 'single';
  } else if (tier === 'complex' && complexScore >= 0.6) {
    routeStrategy = 'council';
  } else {
    routeStrategy = 'tandem';
  }

  // Resolve tandem pair (null for single/council)
  const tandemPair = routeStrategy === 'tandem' ? selectTandemPair(taskType, suggestedAgent) : null;

  return {
    tier,
    taskType,
    suggestedAgent,
    confidence: Math.round(confidence * 100) / 100,
    reason: signals.join(', ') || 'default classification',
    routeStrategy,
    tandemPair,
  };
}

// --- Spec Generation (Task Anchoring) ---

const SPEC_PROMPT_TEMPLATE = `You are generating a concise specification document to anchor multi-agent work.

Given this objective, produce a focused spec in Markdown with these sections:
1. **Objectives** — What must be achieved (bullet points)
2. **Constraints** — What must NOT change, technical limits, compatibility requirements
3. **Acceptance Criteria** — How to verify the work is done correctly
4. **Files Involved** — List of files likely to be modified or read
5. **Risks** — What could go wrong

Keep it to 1 page. Be specific and actionable. Do NOT include implementation details — just the "what", not the "how".

Objective: `;

/**
 * Generate a spec document for a complex prompt using a fast model call.
 * Returns { specId, specPath, specContent } or null if generation fails.
 */
export async function generateSpec(
  promptText: string,
  taskId: string | null | undefined,
  opts: GenerateSpecOpts = {},
): Promise<GenerateSpecResult | null> {
  const specsDir = opts.specsDir ?? path.join(process.cwd(), 'docs', 'coordination', 'specs');
  ensureDir(specsDir);

  const specId = `SPEC_${taskId ?? runId('TASK')}`;
  const specPath = path.join(specsDir, `${specId}.md`);

  try {
    const result = await executeAgent('claude', `${SPEC_PROMPT_TEMPLATE}${promptText}`, {
      timeoutMs: 30_000,
      modelOverride: opts.fastModel,
      cwd: opts.cwd ?? process.cwd(),
      permissionMode: 'plan',
    });

    if (!result.ok || !result.output) {
      return null;
    }

    // Extract text content from JSON response if needed
    let content = result.output;
    try {
      const parsed: unknown = JSON.parse(content);
      if (parsed !== null && typeof parsed === 'object') {
        const rec = parsed as Record<string, unknown>;
        if (typeof rec['result'] === 'string') content = rec['result'];
        else if (typeof rec['content'] === 'string') content = rec['content'];
      } else if (typeof parsed === 'string') {
        content = parsed;
      }
    } catch {
      /* use raw output */
    }

    const specContent = `# ${specId}\n\n**Objective:** ${short(promptText, 200)}\n\n${content}`;
    fs.writeFileSync(specPath, specContent, 'utf8');

    return { specId, specPath, specContent };
  } catch {
    return null;
  }
}
