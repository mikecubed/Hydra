#!/usr/bin/env node
/**
 * Hydra shared utilities.
 *
 * Consolidates duplicated helpers from hydra-council, hydra-operator, hydra-dispatch,
 * orchestrator-daemon, and orchestrator-client into one importable module.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import spawn from 'cross-spawn';
import { KNOWN_OWNERS, getAgent, getModelFlags, getActiveModel, classifyTask, bestAgentFor, AGENT_NAMES } from './hydra-agents.mjs';
import { recordCallStart, recordCallComplete, recordCallError } from './hydra-metrics.mjs';

const ORCH_TOKEN = process.env.AI_ORCH_TOKEN || '';
const NETWORK_RETRY_COUNT = 4;
const NETWORK_RETRY_DELAY_MS = 300;
const DEFAULT_TIMEOUT_MS = 1000 * 60 * 7;

// --- Timestamp ---

export function nowIso() {
  return new Date().toISOString();
}

export function runId(prefix = 'HYDRA') {
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

export function parseArgs(argv) {
  const options = {};
  const positionals = [];
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

export function parseArgsWithCommand(argv) {
  const [command = 'help', ...rest] = argv.slice(2);
  const options = {};
  const positionals = [];
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

export function getOption(options, key, fallback = '') {
  if (options[key] !== undefined) {
    return String(options[key]);
  }
  return fallback;
}

export function requireOption(options, key, help = '') {
  const value = getOption(options, key, '');
  if (!value) {
    const suffix = help ? `\n${help}` : '';
    throw new Error(`Missing required option "${key}".${suffix}`);
  }
  return value;
}

export function getPrompt(options, positionals) {
  if (options.prompt) {
    return String(options.prompt);
  }
  if (positionals.length > 0) {
    return positionals.join(' ');
  }
  return '';
}

export function boolFlag(value, fallback = false) {
  if (value === undefined || value === '') {
    return fallback;
  }
  const normalized = String(value).toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(normalized);
}

/**
 * Split a value into a trimmed string array. Splits on commas only.
 * @param {string | string[] | null | undefined} value
 * @returns {string[]}
 */
export function parseList(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((x) => String(x).trim()).filter(Boolean);
  }
  return String(value)
    .split(/,\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
}

// --- Text Helpers ---

export function short(text, max = 300) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) {
    return cleaned;
  }
  return `${cleaned.slice(0, max - 3)}...`;
}

// --- JSON Parsing ---

export function parseJsonLoose(text) {
  if (!text || !String(text).trim()) {
    return null;
  }
  const raw = String(text).trim();

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
 * @param {string} command - The command to execute
 * @param {string[]} args - Arguments for the command
 * @param {number} [timeoutMs=420000] - Timeout in ms
 * @param {object} [extraOpts] - Additional options
 * @param {string} [extraOpts.cwd] - Working directory
 * @param {string} [extraOpts.input] - Data to pipe to stdin
 * @returns {{ ok: boolean, exitCode: number|null, stdout: string, stderr: string, error: string, timedOut: boolean }}
 */
export function runProcess(command, args, timeoutMs = DEFAULT_TIMEOUT_MS, extraOpts = {}) {
  const spawnOpts = {
    cwd: extraOpts.cwd || process.cwd(),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 8,
    windowsHide: true,
    shell: false,
  };
  // Allow callers to pipe data to stdin (used for long prompts on Windows)
  if (extraOpts.input !== undefined) {
    spawnOpts.input = extraOpts.input;
  }

  const result = spawn.sync(command, args, spawnOpts);

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';

  if (result.error) {
    return {
      ok: false,
      exitCode: result.status,
      stdout,
      stderr,
      error: result.error.message,
      timedOut: Boolean(result.signal === 'SIGTERM'),
    };
  }

  return {
    ok: result.status === 0,
    exitCode: result.status,
    stdout,
    stderr,
    error: '',
    timedOut: Boolean(result.signal === 'SIGTERM'),
  };
}

// --- Test Output Parsing ---

/**
 * Parse Node.js test runner output (TAP / spec reporter) into structured results.
 * Gracefully returns zeros when output can't be parsed.
 *
 * @param {string} stdout - stdout from `node --test`
 * @param {string} stderr - stderr from `node --test`
 * @returns {{ total: number, passed: number, failed: number, durationMs: number, failures: Array<{name: string, error: string}>, summary: string }}
 */
export function parseTestOutput(stdout = '', stderr = '') {
  const combined = `${stdout}\n${stderr}`;
  let total = 0, passed = 0, failed = 0, durationMs = 0;
  const failures = [];

  // TAP summary counters: # tests N, # pass N, # fail N, # duration_ms N
  const totalMatch = combined.match(/^# tests\s+(\d+)/m);
  const passMatch = combined.match(/^# pass\s+(\d+)/m);
  const failMatch = combined.match(/^# fail\s+(\d+)/m);
  const durationMatch = combined.match(/^# duration_ms\s+([\d.]+)/m);

  if (totalMatch) total = parseInt(totalMatch[1], 10);
  if (passMatch) passed = parseInt(passMatch[1], 10);
  if (failMatch) failed = parseInt(failMatch[1], 10);
  if (durationMatch) durationMs = parseFloat(durationMatch[1]);

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
    if (failures.some(f => f.name === name)) continue;
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
      const names = failures.slice(0, 5).map(f => f.name.length > 40 ? f.name.slice(0, 37) + '...' : f.name);
      summary = `${failed}/${total} failed${names.length > 0 ? ': ' + names.join(', ') : ''}`;
    } else {
      summary = `${passed}/${total} passed`;
    }
  }

  return { total, passed, failed, durationMs, failures, summary };
}

// --- HTTP Client (with retry) ---

export async function request(method, baseUrl, route, body = null) {
  const headers = {
    Accept: 'application/json',
  };
  if (ORCH_TOKEN) {
    headers['x-ai-orch-token'] = ORCH_TOKEN;
  }
  if (body !== null) {
    headers['Content-Type'] = 'application/json';
  }

  let response;
  let lastNetworkError = null;

  for (let attempt = 1; attempt <= NETWORK_RETRY_COUNT; attempt += 1) {
    try {
      response = await fetch(`${baseUrl}${route}`, {
        method,
        headers,
        body: body === null ? undefined : JSON.stringify(body),
      });
      lastNetworkError = null;
      break;
    } catch (error) {
      lastNetworkError = error;
      if (attempt >= NETWORK_RETRY_COUNT) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, NETWORK_RETRY_DELAY_MS * attempt));
    }
  }

  if (lastNetworkError) {
    throw new Error(
      `Unable to reach Hydra daemon at ${baseUrl}. Start it with "npm run hydra:start" or set url=http://127.0.0.1:4173.`
    );
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  return payload;
}

// --- Filesystem ---

export function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// --- Task Normalization ---

export function sanitizeOwner(owner) {
  const candidate = String(owner || '').toLowerCase();
  if (KNOWN_OWNERS.has(candidate)) {
    return candidate;
  }
  return 'unassigned';
}

export function normalizeTask(item, fallbackOwner = 'unassigned') {
  if (!item || typeof item !== 'object') {
    return null;
  }
  const title = String(item.title || item.task || '').trim();
  if (!title) {
    return null;
  }
  const owner = sanitizeOwner(item.owner || fallbackOwner);
  const done = String(item.definition_of_done || item.done || item.acceptance || '').trim();
  const rationale = String(item.rationale || item.why || '').trim();
  return { owner, title, done, rationale };
}

export function dedupeTasks(tasks) {
  const out = [];
  const seen = new Set();
  for (const task of tasks) {
    if (!task) {
      continue;
    }
    const key = `${task.owner}::${String(task.title || '').toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(task);
  }
  return out;
}

// --- Shared Model Call ---

/**
 * Internal implementation — call an agent CLI with a prompt.
 */
function modelCallInternal(agent, prompt, timeoutMs, opts = {}) {
  const agentConfig = getAgent(agent);
  if (!agentConfig) {
    throw new Error(`Unknown agent for model call: ${agent}`);
  }

  const cwd = opts.cwd || process.cwd();
  const isWindows = process.platform === 'win32';
  const needsStdin = isWindows;

  // Resolve model flags
  const extraModelFlags = opts.modelOverride
    ? ['--model', opts.modelOverride]
    : getModelFlags(agent);

  if (agent === 'codex') {
    const outputPath = path.join(os.tmpdir(), `${runId('hydra_codex')}.md`);
    if (needsStdin) {
      const baseArgs = ['exec', '-s', 'read-only', '-o', outputPath, '-C', cwd, ...extraModelFlags];
      const result = runProcess('codex', baseArgs, timeoutMs, { input: prompt, cwd });
      const message = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : result.stdout;
      return { ...result, stdout: message || result.stdout, lastMessagePath: outputPath };
    }
    const [cmd, args] = agentConfig.invoke.nonInteractive(prompt, { outputPath, cwd });
    const finalArgs = [...args, ...extraModelFlags];
    const result = runProcess(cmd, finalArgs, timeoutMs, { cwd });
    const message = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : result.stdout;
    return { ...result, stdout: message || result.stdout, lastMessagePath: outputPath };
  }

  if (needsStdin) {
    let stdinArgs = [];
    if (agent === 'claude') {
      stdinArgs = ['--output-format', 'json', '--permission-mode', 'plan', ...extraModelFlags];
    } else if (agent === 'gemini') {
      // Gemini CLI often requires -p for prompt, but for stdin we might need specific flags
      // Assuming it reads from stdin if no prompt arg is provided.
      // If prompt-interactive is needed, we might need to change this.
      // For now, we follow the pattern: flags only.
      stdinArgs = ['-o', 'json', ...extraModelFlags];
    } else {
      stdinArgs = ['-o', 'json', ...extraModelFlags];
    }
    return runProcess(agentConfig.cli, stdinArgs, timeoutMs, { input: prompt, cwd });
  }

  const [cmd, args] = agentConfig.invoke.nonInteractive(prompt);
  const finalArgs = [...args, ...extraModelFlags];
  return runProcess(cmd, finalArgs, timeoutMs, { cwd });
}

/**
 * Call an agent CLI with a prompt. Handles Windows stdin piping, Codex output file,
 * model flag injection, and metrics recording.
 *
 * @param {string} agent - Agent name (gemini, codex, claude)
 * @param {string} prompt - The prompt text
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {object} [opts] - Options
 * @param {string} [opts.modelOverride] - Override model flags (full model ID)
 * @param {string} [opts.cwd] - Working directory (project root)
 * @returns {object} Process result with { ok, exitCode, stdout, stderr, ... }
 */
export function modelCall(agent, prompt, timeoutMs, opts = {}) {
  const model = opts.modelOverride || getActiveModel(agent) || 'default';
  const handle = recordCallStart(agent, model);
  try {
    const result = modelCallInternal(agent, prompt, timeoutMs, opts);
    recordCallComplete(handle, result);
    return result;
  } catch (e) {
    recordCallError(handle, e);
    throw e;
  }
}

/**
 * Async model call that tries MCP first for codex, then falls back to CLI.
 * For non-codex agents, delegates to synchronous modelCall().
 */
export async function modelCallAsync(agent, prompt, timeoutMs, opts = {}) {
  if (agent === 'codex') {
    try {
      const { codexMCP } = await import('./hydra-mcp.mjs');
      const mcpResult = await codexMCP(prompt, {
        cwd: opts.cwd,
        threadId: opts.threadId,
      });
      if (mcpResult.ok && mcpResult.viaMCP) {
        return {
          ok: true,
          exitCode: 0,
          stdout: mcpResult.result,
          stderr: '',
          error: '',
          timedOut: false,
          viaMCP: true,
          threadId: mcpResult.threadId,
        };
      }
      // Fall through to CLI if MCP failed or not enabled
    } catch { /* fall through */ }
  }
  return modelCall(agent, prompt, timeoutMs, opts);
}

// --- Prompt Classification (Fast-Path Dispatch) ---

const COMPLEX_MARKERS = /\b(should we|trade.?off|design|decide|compare|investigate|explore|evaluate|pros?\s+(?:and|&)\s+cons?|which approach|what strategy)\b/i;
const STRATEGIC_MARKERS = /\b(deep dive|make sure|ensure|effectively|efficient|productive|professional|maximize|optimize|improve|best (?:practice|approach|way)|let'?s (?:make|take|think|figure))\b/i;
const MULTI_OBJECTIVE = /\b(?:and|also|plus|additionally)\b/i;

/**
 * Local heuristic classifier for prompt complexity.
 * Returns { tier, taskType, suggestedAgent, confidence, reason }.
 *
 * Tiers:
 *   - simple:   skip triage, dispatch directly (confidence >= 0.7)
 *   - moderate: run mini-round triage (default)
 *   - complex:  full council deliberation
 */
export function classifyPrompt(promptText) {
  const text = String(promptText || '').trim();
  if (!text) {
    return { tier: 'moderate', taskType: 'implementation', suggestedAgent: 'claude', confidence: 0.3, reason: 'Empty prompt' };
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
  const actionVerbs = /^(fix|add|create|implement|update|refactor|remove|delete|write|build|change|move|rename|test|run|check|set|get|make|clean|bump|install|deploy|format|lint)\b/i;
  if (actionVerbs.test(lowerText)) {
    simpleScore += 0.1;
    signals.push('imperative action');
  }

  // File path detection (.mjs, .ts, .js, .json, path separators in context)
  if (/(?:\/[\w.-]+\.[\w]+|\\[\w.-]+\.[\w]+|\.\w{1,5}\b)/.test(text) && /\.(mjs|js|ts|tsx|jsx|json|css|html|py|md|yml|yaml)/.test(lowerText)) {
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
  const mentionedAgent = AGENT_NAMES.find((a) => lowerText.includes(a));
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
    signals.push(`${sentenceCount} sentences`);
  }

  // Question marks suggest uncertainty
  if (text.includes('?')) {
    complexScore += 0.15;
    signals.push('contains question');
  }

  // Multiple verb phrases joined by "and" → multi-objective
  const verbPhrasePattern = /\b(fix|add|create|implement|update|refactor|remove|delete|write|build|change|move|rename)\b/gi;
  const verbMatches = lowerText.match(verbPhrasePattern) || [];
  if (verbMatches.length >= 2 && MULTI_OBJECTIVE.test(lowerText)) {
    complexScore += 0.2;
    signals.push('multiple objectives');
  }

  // Determine tier
  const netScore = simpleScore - complexScore;
  let tier;
  let confidence;

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

  // Suggested agent
  const suggestedAgent = mentionedAgent || bestAgentFor(taskType);

  return {
    tier,
    taskType,
    suggestedAgent,
    confidence: Math.round(confidence * 100) / 100,
    reason: signals.join(', ') || 'default classification',
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
export function generateSpec(promptText, taskId, opts = {}) {
  const specsDir = opts.specsDir || path.join(process.cwd(), 'docs', 'coordination', 'specs');
  ensureDir(specsDir);

  const specId = `SPEC_${taskId || runId('TASK')}`;
  const specPath = path.join(specsDir, `${specId}.md`);

  try {
    const result = modelCall('claude', `${SPEC_PROMPT_TEMPLATE}${promptText}`, 30_000, {
      modelOverride: opts.fastModel || undefined,
      cwd: opts.cwd || process.cwd(),
    });

    if (!result.ok || !result.stdout) {
      return null;
    }

    // Extract text content from JSON response if needed
    let content = result.stdout;
    try {
      const parsed = JSON.parse(content);
      if (parsed.result) content = parsed.result;
      else if (parsed.content) content = parsed.content;
      else if (typeof parsed === 'string') content = parsed;
    } catch { /* use raw output */ }

    const specContent = `# ${specId}\n\n**Objective:** ${short(promptText, 200)}\n\n${content}`;
    fs.writeFileSync(specPath, specContent, 'utf8');

    return { specId, specPath, specContent };
  } catch {
    return null;
  }
}
