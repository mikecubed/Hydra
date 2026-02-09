#!/usr/bin/env node
/**
 * Hydra Evolve — Autonomous self-improvement runner.
 *
 * Runs deliberative research-implement-analyze rounds where Hydra autonomously
 * researches external systems, deliberates on findings, writes tests, implements
 * improvements, analyzes results, and accumulates knowledge.
 *
 * Each round has 7 phases:
 *   1. RESEARCH    — Agents investigate external systems (web-first)
 *   2. DELIBERATE  — Council discusses findings
 *   3. PLAN        — Create improvement spec + test plan
 *   4. TEST        — Write comprehensive tests (TDD)
 *   5. IMPLEMENT   — Make changes on isolated branch
 *   6. ANALYZE     — Multi-agent review of results
 *   7. DECIDE      — Consensus: keep/reject + document
 *
 * Usage:
 *   node lib/hydra-evolve.mjs                              # defaults
 *   node lib/hydra-evolve.mjs project=E:/Dev/SideQuest     # explicit project
 *   node lib/hydra-evolve.mjs max-rounds=1 max-hours=1     # overrides
 *   node lib/hydra-evolve.mjs focus=testing-reliability     # specific area
 */

import './hydra-env.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import {
  EvolveBudgetTracker,
  buildEvolveSafetyPrompt,
  scanBranchViolations,
  verifyBranch,
  isCleanWorkingTree,
} from './hydra-evolve-guardrails.mjs';
import {
  initInvestigator,
  isInvestigatorAvailable,
  investigate,
  getInvestigatorStats,
  resetInvestigator,
} from './hydra-evolve-investigator.mjs';
import {
  loadKnowledgeBase,
  saveKnowledgeBase,
  addEntry,
  getPriorLearnings,
  formatStatsForPrompt,
} from './hydra-evolve-knowledge.mjs';
import { resolveProject, loadHydraConfig, HYDRA_ROOT } from './hydra-config.mjs';
import { getActiveModel } from './hydra-agents.mjs';
import { runProcess, ensureDir, parseArgs, parseJsonLoose } from './hydra-utils.mjs';
import { recordCallStart, recordCallComplete, recordCallError } from './hydra-metrics.mjs';
import pc from 'picocolors';

// ── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_HOURS = 4;
const DEFAULT_MAX_ROUNDS = 3;

const DEFAULT_FOCUS_AREAS = [
  'orchestration-patterns',
  'ai-coding-tools',
  'testing-reliability',
  'developer-experience',
  'model-routing',
  'daemon-architecture',
];

const DEFAULT_PHASE_TIMEOUTS = {
  researchTimeoutMs: 5 * 60 * 1000,
  deliberateTimeoutMs: 7 * 60 * 1000,
  planTimeoutMs: 5 * 60 * 1000,
  testTimeoutMs: 10 * 60 * 1000,
  implementTimeoutMs: 15 * 60 * 1000,
  analyzeTimeoutMs: 7 * 60 * 1000,
};

// ── Logging ─────────────────────────────────────────────────────────────────

const log = {
  info:  (msg) => process.stderr.write(`  ${pc.blue('i')} ${msg}\n`),
  ok:    (msg) => process.stderr.write(`  ${pc.green('+')} ${msg}\n`),
  warn:  (msg) => process.stderr.write(`  ${pc.yellow('!')} ${msg}\n`),
  error: (msg) => process.stderr.write(`  ${pc.red('x')} ${msg}\n`),
  phase: (msg) => process.stderr.write(`\n${pc.bold(pc.magenta('>>>'))} ${pc.bold(msg)}\n`),
  round: (msg) => process.stderr.write(`\n${pc.bold(pc.cyan('=== '))}${pc.bold(msg)}${pc.bold(pc.cyan(' ==='))}\n`),
  dim:   (msg) => process.stderr.write(`  ${pc.dim(msg)}\n`),
};

// ── Project Context (for Codex prompts) ─────────────────────────────────────

let _projectContextCache = null;

function getProjectContext() {
  if (_projectContextCache) return _projectContextCache;
  _projectContextCache = `## Hydra Project Context
Key modules:
  lib/hydra-operator.mjs — Interactive REPL + dispatch pipeline (main entry)
  lib/hydra-agents.mjs — Agent definitions, invoke commands, model config
  lib/hydra-utils.mjs — HTTP helpers, classifyPrompt, parseJsonLoose
  lib/hydra-ui.mjs — Terminal colors (picocolors), formatters, dashboard
  lib/hydra-metrics.mjs — In-memory + file metrics, EventEmitter
  lib/hydra-statusbar.mjs — ANSI scroll region status bar
  lib/hydra-worker.mjs — Headless background agent workers
  lib/hydra-council.mjs — Multi-agent deliberation
  lib/hydra-dispatch.mjs — Task dispatch to agents
  lib/hydra-worktree.mjs — Git worktree isolation
  lib/hydra-concierge.mjs — Conversational front-end
  lib/hydra-config.mjs — Config loading (hydra.config.json)
  lib/hydra-evolve.mjs — Self-improvement runner (this system)
  lib/hydra-evolve-guardrails.mjs — Safety guardrails for evolve
  lib/hydra-evolve-knowledge.mjs — Knowledge base persistence

Test files: test/hydra-*.test.mjs (node:test + assert/strict)
Config: hydra.config.json
Stack: Node.js ESM, picocolors for colors, no framework deps`;
  return _projectContextCache;
}

// ── Git Helpers ─────────────────────────────────────────────────────────────

function git(args, cwd) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 15_000,
    shell: process.platform === 'win32',
  });
}

function getCurrentBranch(cwd) {
  const r = git(['branch', '--show-current'], cwd);
  return (r.stdout || '').trim();
}

function checkoutBranch(cwd, branch) {
  return git(['checkout', branch], cwd);
}

function branchExists(cwd, branchName) {
  const r = git(['rev-parse', '--verify', branchName], cwd);
  return r.status === 0;
}

function createBranch(cwd, branchName, fromBranch) {
  // Delete stale branch from a prior run on the same date
  if (branchExists(cwd, branchName)) {
    git(['branch', '-D', branchName], cwd);
  }
  const r = git(['checkout', '-b', branchName, fromBranch], cwd);
  return r.status === 0;
}

function getBranchStats(cwd, branchName, baseBranch) {
  const logResult = git(['log', `${baseBranch}..${branchName}`, '--oneline'], cwd);
  const commits = (logResult.stdout || '').trim().split('\n').filter(Boolean).length;

  const diffResult = git(['diff', '--stat', `${baseBranch}...${branchName}`], cwd);
  const statLines = (diffResult.stdout || '').trim().split('\n').filter(Boolean);
  const filesChanged = Math.max(0, statLines.length - 1);

  return { commits, filesChanged };
}

function getBranchDiff(cwd, branchName, baseBranch) {
  const r = git(['diff', `${baseBranch}...${branchName}`], cwd);
  return (r.stdout || '').trim();
}

function stageAndCommit(cwd, message) {
  git(['add', '-A'], cwd);
  const r = git(['commit', '-m', message, '--allow-empty'], cwd);
  return r.status === 0;
}

// ── Checkpoint & Hot-Restart ─────────────────────────────────────────────────

const CHECKPOINT_FILE = '.session-checkpoint.json';

function getCheckpointPath(evolveDir) {
  return path.join(evolveDir, CHECKPOINT_FILE);
}

/**
 * Load a session checkpoint from disk. Returns null if none exists.
 */
function loadCheckpoint(evolveDir) {
  const cpPath = getCheckpointPath(evolveDir);
  try {
    if (!fs.existsSync(cpPath)) return null;
    const raw = fs.readFileSync(cpPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Save a session checkpoint to disk for hot-restart.
 */
function saveCheckpoint(evolveDir, data) {
  const cpPath = getCheckpointPath(evolveDir);
  fs.writeFileSync(cpPath, JSON.stringify(data, null, 2), 'utf8');
  log.ok(`Checkpoint saved: ${cpPath}`);
}

/**
 * Delete the checkpoint file (consumed after resume).
 */
function deleteCheckpoint(evolveDir) {
  const cpPath = getCheckpointPath(evolveDir);
  try { fs.unlinkSync(cpPath); } catch { /* ok if missing */ }
}

// ── Session State Tracking ───────────────────────────────────────────────────

const SESSION_STATE_FILE = 'EVOLVE_SESSION_STATE.json';

function getSessionStatePath(evolveDir) {
  return path.join(evolveDir, SESSION_STATE_FILE);
}

/**
 * Compute session status from round results.
 * @returns {'running'|'completed'|'partial'|'failed'|'interrupted'}
 */
function computeSessionStatus(roundResults, maxRounds, stopReason, isRunning) {
  if (isRunning) return 'running';
  if (roundResults.length === 0) return 'failed';

  const allErrored = roundResults.every(r => r.verdict === 'error' || r.verdict === 'reject');
  if (allErrored) return 'failed';

  if (stopReason) return 'partial'; // stopped early by time/budget
  if (roundResults.length < maxRounds) return 'partial';
  return 'completed';
}

/**
 * Compute human-readable action needed string.
 */
function computeActionNeeded(roundResults, maxRounds, status) {
  if (status === 'completed') return 'Session complete. Review branches with :evolve status';
  if (status === 'failed') return 'All rounds failed. Check agent configs and retry';
  if (status === 'partial') {
    const remaining = maxRounds - roundResults.length;
    return `${remaining} round(s) remaining. Resume with :evolve resume`;
  }
  if (status === 'interrupted') return 'Session was interrupted. Resume with :evolve resume';
  return 'Session in progress';
}

function saveSessionState(evolveDir, state) {
  const statePath = getSessionStatePath(evolveDir);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

function loadSessionState(evolveDir) {
  const statePath = getSessionStatePath(evolveDir);
  try {
    if (!fs.existsSync(statePath)) return null;
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Check if an evolve branch modified Hydra's own lib/ code (not the target project).
 * Only returns true when the diff touches files in Hydra's own directory.
 */
function didModifyHydraCode(projectRoot, branchName, baseBranch) {
  // Only relevant when evolve is running against Hydra itself
  const normalizedHydra = path.resolve(HYDRA_ROOT).toLowerCase();
  const normalizedProject = path.resolve(projectRoot).toLowerCase();
  if (normalizedHydra !== normalizedProject) return false;

  const r = git(['diff', '--name-only', `${baseBranch}...${branchName}`], projectRoot);
  if (r.status !== 0 || !r.stdout) return false;
  return r.stdout.split('\n').filter(Boolean).some(f => f.startsWith('lib/'));
}

/**
 * Spawn a new detached PowerShell process to resume the evolve session.
 */
function spawnNewProcess(projectRoot) {
  const ps1Path = path.join(HYDRA_ROOT, 'bin', 'hydra-evolve.ps1');
  const child = spawn('pwsh', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', ps1Path,
    '-Project', projectRoot,
    '-ResumeSession',
  ], {
    detached: true,
    stdio: 'ignore',
    shell: false,
    windowsHide: false,
  });
  child.unref();
  log.ok(`Spawned new evolve process (PID ${child.pid})`);
}

// ── Agent Execution ─────────────────────────────────────────────────────────

const AGENT_LABELS = { claude: '♦ Claude', gemini: '✦ Gemini', codex: '▶ Codex' };
const PROGRESS_INTERVAL_MS = 15_000; // tick every 15s

// Track agents that fail repeatedly — skip them for the rest of the session
const disabledAgents = new Set();

// ── Direct Gemini API (bypass broken CLI v0.27.x) ──────────────────────────
// Gemini CLI v0.27.x duplicates every piped message, crashing on undefined
// `candidates`. We call the Code Assist API directly using the CLI's own
// OAuth credentials and the same endpoint it uses internally.

import crypto from 'crypto';

const GEMINI_OAUTH = {
  clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
  clientSecret: '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',
};
const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com/v1internal';
const GEMINI_DEFAULT_MODEL = getActiveModel('gemini');

let _geminiToken = null;
let _geminiTokenExpiry = 0;
let _geminiProjectId = null;

async function getGeminiToken() {
  if (_geminiToken && Date.now() < _geminiTokenExpiry - 60_000) return _geminiToken;

  const credsPath = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
  if (!fs.existsSync(credsPath)) return null;

  const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));

  if (creds.access_token && creds.expiry_date && Date.now() < creds.expiry_date - 60_000) {
    _geminiToken = creds.access_token;
    _geminiTokenExpiry = creds.expiry_date;
    return _geminiToken;
  }

  if (!creds.refresh_token) return null;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GEMINI_OAUTH.clientId,
      client_secret: GEMINI_OAUTH.clientSecret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  if (!resp.ok) return null;

  const data = await resp.json();
  _geminiToken = data.access_token;
  _geminiTokenExpiry = Date.now() + (data.expires_in * 1000);

  // Persist so Gemini CLI also benefits
  creds.access_token = data.access_token;
  creds.expiry_date = _geminiTokenExpiry;
  try { fs.writeFileSync(credsPath, JSON.stringify(creds, null, 2), 'utf8'); } catch { /* best effort */ }

  return _geminiToken;
}

async function getGeminiProjectId(token) {
  if (_geminiProjectId) return _geminiProjectId;

  const resp = await fetch(`${CODE_ASSIST_ENDPOINT}:loadCodeAssist`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  });

  if (!resp.ok) return null;
  const data = await resp.json();
  _geminiProjectId = data.cloudaicompanionProject || null;
  return _geminiProjectId;
}

/**
 * Call Gemini via Code Assist API directly (bypasses broken CLI).
 */
async function executeGeminiDirect(prompt, { timeoutMs, modelOverride, phaseLabel } = {}) {
  const startTime = Date.now();
  const model = modelOverride || GEMINI_DEFAULT_MODEL;
  const label = AGENT_LABELS.gemini;
  const context = phaseLabel ? ` [${phaseLabel}]` : '';
  const metricsLabel = phaseLabel || 'evolve';
  log.dim(`${label}: started${context}`);
  recordCallStart('gemini', metricsLabel);

  try {
    const token = await getGeminiToken();
    if (!token) {
      const durationMs = Date.now() - startTime;
      recordCallError('gemini', metricsLabel, 'No Gemini OAuth credentials');
      return { ok: false, output: '', stderr: '', error: 'No Gemini OAuth credentials (~/.gemini/oauth_creds.json)', durationMs, timedOut: false };
    }

    const projectId = await getGeminiProjectId(token);
    if (!projectId) {
      const durationMs = Date.now() - startTime;
      recordCallError('gemini', metricsLabel, 'Could not resolve Gemini project ID');
      return { ok: false, output: '', stderr: '', error: 'Could not resolve Gemini project ID', durationMs, timedOut: false };
    }

    const resp = await fetch(`${CODE_ASSIST_ENDPOINT}:generateContent`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        project: projectId,
        user_prompt_id: crypto.randomUUID(),
        request: {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
        },
      }),
      signal: AbortSignal.timeout(timeoutMs || 300_000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      const durationMs = Date.now() - startTime;
      recordCallError('gemini', metricsLabel, `Gemini API ${resp.status}`);
      return { ok: false, output: '', stderr: errText, error: `Gemini API ${resp.status}`, durationMs, timedOut: false };
    }

    const data = await resp.json();
    const text = data?.response?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
    const durationMs = Date.now() - startTime;
    const estimatedTokens = Math.round(Buffer.byteLength(text) / 4);
    recordCallComplete('gemini', metricsLabel, durationMs, { estimatedTokens });
    log.dim(`${label}: ${estimatedTokens} est. tokens (${formatDuration(durationMs)})`);

    return { ok: true, output: text, stderr: '', durationMs, timedOut: false };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    recordCallError('gemini', metricsLabel, err.message);
    return {
      ok: false, output: '', stderr: '',
      error: err.name === 'TimeoutError' ? 'Gemini API timeout' : err.message,
      durationMs,
      timedOut: err.name === 'TimeoutError',
    };
  }
}

/**
 * Execute an agent CLI as a headless subprocess.
 * Returns { ok, output, durationMs, timedOut }.
 */
function executeAgent(agent, prompt, { cwd, timeoutMs, modelOverride, phaseLabel } = {}) {
  // Gemini: use direct API call (CLI v0.27.x is broken — duplicates messages)
  if (agent === 'gemini') {
    return executeGeminiDirect(prompt, { timeoutMs, modelOverride, phaseLabel });
  }

  const metricsLabel = phaseLabel || 'evolve';
  recordCallStart(agent, metricsLabel);

  return new Promise((resolve) => {
    let cmd, args;

    if (agent === 'codex') {
      args = ['exec', '-', '--full-auto', '-C', cwd];
      if (modelOverride) args.push('--model', modelOverride);
      cmd = 'codex';
    } else {
      // claude — use stdin (-p -) to avoid Windows cmd.exe length/escaping issues
      args = ['-p', '-', '--output-format', 'json', '--permission-mode', 'acceptEdits'];
      if (modelOverride) args.push('--model', modelOverride);
      cmd = 'claude';
    }

    const label = AGENT_LABELS[agent] || agent;
    const context = phaseLabel ? ` [${phaseLabel}]` : '';
    log.dim(`${label}: started${context}`);

    const chunks = [];
    let totalBytes = 0;
    const maxBytes = 128 * 1024;

    const stderrChunks = [];
    let stderrBytes = 0;
    const maxStderrBytes = 32 * 1024;

    const spawnOpts = {
      cwd,
      windowsHide: true,
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    };

    const child = spawn(cmd, args, spawnOpts);

    // Both Claude (-p -) and Codex (exec -) read prompts from stdin
    child.stdin.write(prompt);
    child.stdin.end();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (d) => {
      totalBytes += Buffer.byteLength(d);
      chunks.push(d);
      while (totalBytes > maxBytes && chunks.length > 1) {
        const dropped = chunks.shift();
        totalBytes -= Buffer.byteLength(dropped);
      }
    });

    child.stderr.on('data', (d) => {
      stderrBytes += Buffer.byteLength(d);
      stderrChunks.push(d);
      while (stderrBytes > maxStderrBytes && stderrChunks.length > 1) {
        const dropped = stderrChunks.shift();
        stderrBytes -= Buffer.byteLength(dropped);
      }
    });

    const startTime = Date.now();
    let timedOut = false;

    // Progress ticker — prints elapsed time periodically
    const progressTimer = setInterval(() => {
      const elapsed = formatDuration(Date.now() - startTime);
      const bytes = totalBytes > 0 ? ` | ${(totalBytes / 1024).toFixed(0)}KB received` : '';
      log.dim(`${label}: working... ${elapsed}${bytes}${context}`);
    }, PROGRESS_INTERVAL_MS);

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }, timeoutMs || DEFAULT_PHASE_TIMEOUTS.researchTimeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      clearInterval(progressTimer);
      const durationMs = Date.now() - startTime;
      recordCallError(agent, metricsLabel, err.message);
      resolve({
        ok: false,
        output: chunks.join(''),
        stderr: stderrChunks.join(''),
        error: err.message,
        durationMs,
        timedOut: false,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(progressTimer);
      const durationMs = Date.now() - startTime;
      if (code === 0) {
        const estimatedTokens = Math.round(totalBytes / 4);
        recordCallComplete(agent, metricsLabel, durationMs, { estimatedTokens });
        log.dim(`${label}: ${estimatedTokens} est. tokens (${formatDuration(durationMs)})`);
      } else {
        recordCallError(agent, metricsLabel, timedOut ? 'timeout' : `exit code ${code}`);
      }
      resolve({
        ok: code === 0,
        output: chunks.join(''),
        stderr: stderrChunks.join(''),
        error: code !== 0 ? `Exit code ${code}` : null,
        durationMs,
        timedOut,
      });
    });
  });
}

/**
 * Execute an agent with investigation-guided retry on failure.
 * Uses the investigator (if available) to diagnose failures and decide
 * whether to retry as-is, retry with a modified prompt, or give up.
 * If an agent fails twice, it's disabled for the rest of the session.
 */
async function executeAgentWithRetry(agent, prompt, opts = {}) {
  const label = AGENT_LABELS[agent] || agent;

  // Skip agents that are known-broken this session
  if (disabledAgents.has(agent)) {
    return { ok: false, output: '', stderr: '', error: `${agent} disabled for session`, durationMs: 0, timedOut: false, skipped: true };
  }

  const result = await executeAgent(agent, prompt, opts);
  if (result.ok) return result;

  // Don't retry timeouts (already took too long)
  if (result.timedOut) return result;

  // ── Investigation-guided retry ──────────────────────────────────────
  if (isInvestigatorAvailable()) {
    log.info(`${label} failed — investigating...`);
    const diagnosis = await investigate({
      phase: 'agent',
      agent,
      error: result.error,
      stderr: (result.stderr || '').slice(-2000),
      stdout: (result.output || '').slice(-2000),
      timedOut: result.timedOut,
      context: `Phase: ${opts.phaseLabel || 'unknown'}`,
      attemptNumber: 1,
    });

    log.dim(`Investigation: ${diagnosis.diagnosis} — ${diagnosis.explanation}`);

    if (diagnosis.diagnosis === 'fundamental') {
      log.warn(`${label}: fundamental failure — skipping retry`);
      disabledAgents.add(agent);
      result.investigation = diagnosis;
      return result;
    }

    // Build retry prompt (possibly modified by investigator)
    let retryPrompt = prompt;
    if (diagnosis.diagnosis === 'fixable' && diagnosis.retryRecommendation?.modifiedPrompt) {
      retryPrompt = diagnosis.retryRecommendation.modifiedPrompt + '\n\n' + prompt;
      log.dim(`Retrying with corrective preamble`);
    } else if (diagnosis.diagnosis === 'fixable' && diagnosis.retryRecommendation?.preamble) {
      retryPrompt = diagnosis.retryRecommendation.preamble + '\n\n' + prompt;
      log.dim(`Retrying with diagnostic preamble`);
    }

    // Try alternative agent if recommended
    let retryAgent = agent;
    if (diagnosis.retryRecommendation?.retryAgent && diagnosis.retryRecommendation.retryAgent !== agent) {
      retryAgent = diagnosis.retryRecommendation.retryAgent;
      log.dim(`Switching to alternative agent: ${retryAgent}`);
    }

    await new Promise(r => setTimeout(r, 2000));
    const retry = await executeAgent(retryAgent, retryPrompt, opts);
    log.dim(`${AGENT_LABELS[retryAgent] || retryAgent} retry: ${retry.ok ? 'OK' : 'FAIL'} (${formatDuration(retry.durationMs)})`);
    retry.investigation = diagnosis;

    if (!retry.ok) {
      disabledAgents.add(agent);
      log.warn(`${label} disabled for remainder of session (investigation + retry failed)`);
    }

    return retry;
  }

  // ── Fallback: blind retry (no investigator) ─────────────────────────
  log.warn(`${label} failed, retrying once after 3s...`);
  await new Promise(r => setTimeout(r, 3000));

  const retry = await executeAgent(agent, prompt, opts);
  log.dim(`${label} retry: ${retry.ok ? 'OK' : 'FAIL'} (${formatDuration(retry.durationMs)})`);

  if (!retry.ok) {
    disabledAgents.add(agent);
    log.warn(`${label} disabled for remainder of session (consecutive failures)`);
  }

  return retry;
}

/**
 * Extract text content from an agent's JSON output.
 * If the parsed object already contains evolve-specific keys, return it directly
 * (it's the final data, not a wrapper) to avoid double-unwrapping that strips payloads.
 */
function extractOutput(rawOutput) {
  if (!rawOutput) return '';
  try {
    const parsed = JSON.parse(rawOutput);
    // Detect evolve-specific payloads — return directly, don't unwrap
    if (typeof parsed === 'object' && parsed !== null) {
      const evolveKeys = ['selectedImprovement', 'suggestedImprovement', 'synthesis',
        'critique', 'quality', 'feasibility', 'topPatterns', 'applicableToHydra',
        'concerns', 'feasibilityScore', 'implementationNotes', 'recommendation'];
      if (evolveKeys.some(k => k in parsed)) return rawOutput;
    }
    if (parsed.result) return parsed.result;     // Claude --output-format json
    if (parsed.response) return parsed.response;  // Gemini -o json
    if (parsed.content) return parsed.content;
    if (typeof parsed === 'string') return parsed;
  } catch { /* use raw */ }
  return rawOutput;
}

// ── Session-level investigation tracking ─────────────────────────────────────

const sessionInvestigations = { count: 0, healed: 0, diagnoses: [] };

function recordInvestigation(phaseName, diagnosis) {
  sessionInvestigations.count++;
  sessionInvestigations.diagnoses.push({
    phase: phaseName,
    diagnosis: diagnosis.diagnosis,
    explanation: diagnosis.explanation,
  });
  if ((diagnosis.diagnosis === 'fixable' || diagnosis.diagnosis === 'transient') && diagnosis.retryRecommendation?.retryPhase) {
    sessionInvestigations.healed++;
  }
}

/**
 * Wrap a phase function call with investigation-guided retry on failure.
 *
 * @param {string} phaseName - Phase identifier (test, implement, analyze)
 * @param {Function} phaseFn - The async phase function to call
 * @param {Array} phaseArgs - Arguments to pass to phaseFn
 * @param {object} context - Additional context for the investigator
 * @returns {Promise<object>} Phase result (possibly from retry)
 */
async function executePhaseWithInvestigation(phaseName, phaseFn, phaseArgs, context = {}) {
  const result = await phaseFn(...phaseArgs);

  // Phase succeeded — return as-is
  if (result.ok) return result;

  // Investigator not available — return original failure
  if (!isInvestigatorAvailable()) return result;

  const cfg = loadHydraConfig();
  const maxAttempts = cfg.evolve?.investigator?.maxAttemptsPerPhase || 2;
  if (maxAttempts <= 1) return result;

  log.info(`Phase ${phaseName} failed — investigating...`);
  const diagnosis = await investigate({
    phase: phaseName,
    agent: context.agent || 'codex',
    error: result.error || `Phase ${phaseName} returned ok=false`,
    stderr: (result.stderr || '').slice(-2000),
    stdout: (result.output || '').slice(-2000),
    timedOut: result.timedOut || false,
    context: context.planSummary || '',
    attemptNumber: 1,
  });

  recordInvestigation(phaseName, diagnosis);
  log.dim(`Investigation: ${diagnosis.diagnosis} — ${diagnosis.explanation}`);

  if (diagnosis.diagnosis === 'fundamental') {
    log.warn(`Phase ${phaseName}: fundamental failure — no retry`);
    result.investigation = diagnosis;
    return result;
  }

  if (!diagnosis.retryRecommendation?.retryPhase) {
    result.investigation = diagnosis;
    return result;
  }

  // Retry the phase — if investigator provided a modified prompt, we need to
  // rebuild the phase args. For simplicity, we pass the corrective context
  // through the context object and let the caller handle prompt modification.
  log.info(`Phase ${phaseName}: retrying with investigator guidance...`);
  result.investigation = diagnosis;
  result._shouldRetry = true;
  result._corrective = diagnosis.corrective;
  result._preamble = diagnosis.retryRecommendation?.preamble || diagnosis.retryRecommendation?.modifiedPrompt;
  return result;
}

// ── Phase Implementations ───────────────────────────────────────────────────

/**
 * Phase 1: RESEARCH — Agents investigate external systems (web-first).
 */
async function phaseResearch(area, kb, { cwd, timeouts, evolveDir }) {
  log.phase(`RESEARCH — ${area}`);

  const kbContext = formatStatsForPrompt(kb);
  const priorLearnings = getPriorLearnings(kb, area);
  const priorContext = priorLearnings.length > 0
    ? `\n\nPrior learnings for "${area}":\n${priorLearnings.slice(0, 5).map(e => `- [${e.outcome || 'researched'}] ${e.finding.slice(0, 200)}`).join('\n')}`
    : '';

  const claudePrompt = `# Evolve Research: ${area}

You are researching "${area}" for the Hydra multi-agent orchestration system.

Search the web for current implementations, changelogs, documentation, GitHub repos, and blog posts related to this area. Focus on:
- Current state of relevant tools and frameworks
- Novel patterns and approaches
- Recent changes or breakthroughs
- Benchmarks and comparisons

Specific search queries to try:
${getSearchQueries(area).map(q => `- "${q}"`).join('\n')}

${kbContext}${priorContext}

Respond with a JSON object:
{
  "area": "${area}",
  "sources": [{"url": "...", "title": "...", "relevance": "high|medium|low"}],
  "findings": ["finding 1", "finding 2", ...],
  "applicableIdeas": ["idea 1", "idea 2", ...],
  "confidence": 0.0-1.0
}`;

  const geminiPrompt = `# Evolve Research: ${area}

You are researching "${area}" for the Hydra multi-agent orchestration system. Use Google Search grounding to find live results.

Search for implementations, GitHub repos, documentation, and recent discussions about:
${getSearchQueries(area).map(q => `- ${q}`).join('\n')}

Focus on practical patterns that could be applied to a Node.js multi-agent CLI system.

${kbContext}${priorContext}

Respond with a JSON object:
{
  "area": "${area}",
  "sources": [{"url": "...", "title": "...", "relevance": "high|medium|low"}],
  "findings": ["finding 1", "finding 2", ...],
  "applicableIdeas": ["idea 1", "idea 2", ...],
  "confidence": 0.0-1.0
}`;

  const codexPrompt = `# Evolve Research: ${area} (Codebase Analysis)

${getProjectContext()}

You are analyzing the Hydra codebase to research "${area}" from an implementation perspective.

Read the existing code in the lib/ directory (see module list above) and evaluate:
1. How does Hydra currently handle aspects related to "${area}"?
2. What existing patterns, utilities, or modules could be leveraged or extended?
3. What gaps, technical debt, or bottlenecks exist in this area?
4. What concrete implementation approaches would fit the existing architecture?
5. Are there any dependencies or constraints that would affect changes in this area?

Focus on practical, code-level insights — not theory. Reference specific files, functions, and patterns you find.

${kbContext}${priorContext}

Respond with a JSON object:
{
  "area": "${area}",
  "existingPatterns": ["pattern1", "pattern2", ...],
  "gaps": ["gap1", "gap2", ...],
  "implementationIdeas": ["idea 1", "idea 2", ...],
  "relevantFiles": [{"path": "lib/file.mjs", "relevance": "..."}],
  "feasibilityNotes": "...",
  "confidence": 0.0-1.0
}`;

  // Dispatch all three agents in parallel (with retry on failure)
  log.dim('Dispatching research to Claude + Gemini + Codex in parallel...');
  const [claudeResult, geminiResult, codexResult] = await Promise.all([
    executeAgentWithRetry('claude', claudePrompt, {
      cwd,
      timeoutMs: timeouts.researchTimeoutMs,
      phaseLabel: `research: ${area}`,
    }),
    executeAgentWithRetry('gemini', geminiPrompt, {
      cwd,
      timeoutMs: timeouts.researchTimeoutMs,
      phaseLabel: `research: ${area}`,
    }),
    executeAgentWithRetry('codex', codexPrompt, {
      cwd,
      timeoutMs: timeouts.researchTimeoutMs,
      phaseLabel: `research: ${area} (codebase)`,
    }),
  ]);

  log.dim(`Claude: ${claudeResult.ok ? 'OK' : 'FAIL'} (${formatDuration(claudeResult.durationMs)})`);
  log.dim(`Gemini: ${geminiResult.ok ? 'OK' : 'FAIL'} (${formatDuration(geminiResult.durationMs)})`);
  log.dim(`Codex:  ${codexResult.ok ? 'OK' : 'FAIL'} (${formatDuration(codexResult.durationMs)})`);

  // Log warnings for agent failures with stderr context
  for (const [name, result] of [['Claude', claudeResult], ['Gemini', geminiResult], ['Codex', codexResult]]) {
    if (!result.ok) {
      const stderrSnippet = result.stderr ? result.stderr.slice(-500).trim() : '';
      log.warn(`${name} research failed: ${result.error || 'unknown'}${result.timedOut ? ' (TIMEOUT)' : ''}`);
      if (stderrSnippet) log.dim(`  stderr: ${stderrSnippet.slice(0, 200)}`);
    }
  }

  const claudeData = parseJsonLoose(extractOutput(claudeResult.output));
  const geminiData = parseJsonLoose(extractOutput(geminiResult.output));
  const codexData = parseJsonLoose(extractOutput(codexResult.output));

  // Log warnings for successful agents that returned unparseable output
  for (const [name, result, data] of [['Claude', claudeResult, claudeData], ['Gemini', geminiResult, geminiData], ['Codex', codexResult, codexData]]) {
    if (result.ok && !data) {
      const rawSnippet = extractOutput(result.output).slice(0, 200);
      log.warn(`${name} returned OK but output could not be parsed as JSON`);
      if (rawSnippet) log.dim(`  raw: ${rawSnippet}`);
    }
  }

  const combined = {
    area,
    claudeFindings: claudeData || { findings: [], applicableIdeas: [], sources: [] },
    geminiFindings: geminiData || { findings: [], applicableIdeas: [], sources: [] },
    codexFindings: codexData || { existingPatterns: [], gaps: [], implementationIdeas: [], relevantFiles: [] },
  };

  // Save research artifact
  const researchDir = path.join(evolveDir, 'research');
  ensureDir(researchDir);

  return combined;
}

/**
 * Extract an improvement description from raw agent text when JSON parsing fails.
 * Looks for labeled lines ("Improvement:", "Selected:", etc.) or first substantial sentence.
 */
function extractImprovementFromText(rawOutput) {
  if (!rawOutput || typeof rawOutput !== 'string') return null;
  const lines = rawOutput.split('\n').map(l => l.trim()).filter(Boolean);

  // Look for labeled lines
  for (const line of lines) {
    const match = line.match(/^(?:improvement|suggested|selected|recommendation|proposal)\s*:\s*(.+)/i);
    if (match && match[1].length > 20) return match[1].trim();
  }

  // Look for the first substantial sentence that isn't a JSON fragment
  for (const line of lines) {
    if (line.startsWith('{') || line.startsWith('[') || line.startsWith('```')) continue;
    if (line.length > 20 && /[a-zA-Z]/.test(line)) return line;
  }

  return null;
}

/**
 * Make a deliberation step resilient: parse JSON, fall back to text extraction.
 * Returns parsed data or a minimal fallback object, plus a warning if fallback was used.
 */
function resilientParse(rawOutput, resultOk, stepName, fallbackKey) {
  const extracted = extractOutput(rawOutput);
  const parsed = parseJsonLoose(extracted);
  if (parsed) return { data: parsed, fallback: false };

  if (!resultOk) return { data: null, fallback: false };

  // Agent succeeded but JSON parsing failed — try text extraction
  const snippet = (typeof extracted === 'string' ? extracted : rawOutput || '').slice(0, 300);
  log.warn(`${stepName}: JSON parse failed, trying text extraction`);
  log.dim(`  raw: ${snippet}`);

  const text = extractImprovementFromText(typeof extracted === 'string' ? extracted : rawOutput);
  if (text) {
    log.dim(`  extracted: ${text.slice(0, 100)}`);
    return { data: { [fallbackKey]: text }, fallback: true };
  }

  return { data: null, fallback: false };
}

/**
 * Phase 2: DELIBERATE — Council discusses findings.
 */
async function phaseDeliberate(research, kb, { cwd, timeouts }) {
  log.phase('DELIBERATE');

  const kbContext = formatStatsForPrompt(kb);
  const findingsBlock = JSON.stringify(research, null, 2);

  // Step 1: Claude synthesizes
  const synthesizePrompt = `# Evolve Deliberation: Synthesize Research

You are synthesizing research findings about "${research.area}" for the Hydra multi-agent orchestration system.

## Research Findings
${findingsBlock}

## Knowledge Base Context
${kbContext}

Analyze all findings and produce a synthesis:
1. What are the most important patterns/ideas found externally (Claude + Gemini research)?
2. Which are actually applicable to Hydra (a Node.js multi-agent CLI orchestrator)?
3. What codebase gaps and existing patterns did Codex identify that inform the approach?
4. What's the highest-impact single improvement we could make?

Respond with JSON:
{
  "synthesis": "...",
  "topPatterns": ["pattern1", "pattern2", ...],
  "applicableToHydra": ["idea1", "idea2", ...],
  "suggestedImprovement": "...",
  "rationale": "..."
}`;

  log.dim('Step 1/4: Claude synthesizing research findings...');
  const synthResult = await executeAgent('claude', synthesizePrompt, {
    cwd,
    timeoutMs: timeouts.deliberateTimeoutMs,
    phaseLabel: 'deliberate: synthesize',
  });
  const synthParsed = resilientParse(synthResult.output, synthResult.ok, 'Synthesize', 'suggestedImprovement');
  const synthData = synthParsed.data;
  log.dim(`Synthesis: ${synthResult.ok ? 'OK' : 'FAIL'}${synthParsed.fallback ? ' (fallback)' : ''} (${formatDuration(synthResult.durationMs)})`);

  // Step 2: Gemini critiques
  const critiquePrompt = `# Evolve Deliberation: Critique

Review this synthesis of research findings about "${research.area}" for the Hydra project:

${JSON.stringify(synthData || { synthesis: 'No synthesis available' }, null, 2)}

Critically evaluate:
1. Are the conclusions well-supported by the research?
2. Is the suggested improvement actually feasible for a Node.js CLI tool?
3. What risks or downsides are being overlooked?
4. Is there a better alternative improvement?

Respond with JSON:
{
  "critique": "...",
  "concerns": ["concern1", "concern2", ...],
  "risks": ["risk1", "risk2", ...],
  "alternativeIdea": "..." or null,
  "feasibilityScore": 1-10
}`;

  log.dim('Step 2/4: Gemini critiquing synthesis...');
  const critiqueResult = await executeAgentWithRetry('gemini', critiquePrompt, {
    cwd,
    timeoutMs: timeouts.deliberateTimeoutMs,
    phaseLabel: 'deliberate: critique',
  });
  const critiqueParsed = resilientParse(critiqueResult.output, critiqueResult.ok, 'Critique', 'critique');
  const critiqueData = critiqueParsed.data;
  log.dim(`Critique: ${critiqueResult.ok ? 'OK' : 'FAIL'}${critiqueParsed.fallback ? ' (fallback)' : ''} (${formatDuration(critiqueResult.durationMs)})`);

  // Step 3: Codex feasibility assessment
  const feasibilityPrompt = `# Evolve Deliberation: Feasibility Assessment

${getProjectContext()}

You are evaluating the implementation feasibility of a proposed improvement to the Hydra project.

## Proposed Improvement
${JSON.stringify(synthData?.suggestedImprovement || 'See synthesis', null, 2)}

## Synthesis
${JSON.stringify(synthData || {}, null, 2)}

## Critique & Concerns
${JSON.stringify(critiqueData || {}, null, 2)}

Read the relevant source files in lib/ and evaluate from an implementation perspective:
1. How complex is this change? (estimate lines of code, files touched)
2. Does it conflict with existing patterns or architecture?
3. What's the test strategy? Can it be tested with node:test?
4. Are there hidden dependencies or side effects?
5. Can it be implemented incrementally or is it all-or-nothing?

Respond with JSON:
{
  "feasibility": "high|medium|low",
  "complexity": "trivial|moderate|complex|major",
  "estimatedFiles": 1-10,
  "conflicts": ["conflict1", ...] or [],
  "testStrategy": "...",
  "implementationNotes": "...",
  "recommendation": "proceed|simplify|reconsider"
}`;

  log.dim('Step 3/4: Codex assessing implementation feasibility...');
  const feasibilityResult = await executeAgentWithRetry('codex', feasibilityPrompt, {
    cwd,
    timeoutMs: timeouts.deliberateTimeoutMs,
    phaseLabel: 'deliberate: feasibility',
  });
  const feasibilityParsed = resilientParse(feasibilityResult.output, feasibilityResult.ok, 'Feasibility', 'implementationNotes');
  const feasibilityData = feasibilityParsed.data;
  log.dim(`Feasibility: ${feasibilityResult.ok ? 'OK' : 'FAIL'}${feasibilityParsed.fallback ? ' (fallback)' : ''} (${formatDuration(feasibilityResult.durationMs)})`);

  // Step 4: Claude prioritizes and selects
  const prioritizePrompt = `# Evolve Deliberation: Final Selection

Based on the synthesis, critique, and feasibility assessment, select the single best improvement to attempt.

## Synthesis
${JSON.stringify(synthData || {}, null, 2)}

## Critique
${JSON.stringify(critiqueData || {}, null, 2)}

## Feasibility Assessment
${JSON.stringify(feasibilityData || {}, null, 2)}

Consider the critique's concerns, risks, and the feasibility assessment. Select the improvement that:
- Has the highest positive impact
- Is most feasible to implement (per Codex's assessment)
- Has acceptable risk level
- Can be tested with the existing test infrastructure

Respond with JSON:
{
  "selectedImprovement": "...",
  "rationale": "...",
  "expectedImpact": "high|medium|low",
  "risks": ["risk1", ...],
  "constraints": ["constraint1", ...]
}`;

  log.dim('Step 4/4: Claude selecting best improvement...');
  const priorityResult = await executeAgent('claude', prioritizePrompt, {
    cwd,
    timeoutMs: timeouts.deliberateTimeoutMs,
    phaseLabel: 'deliberate: prioritize',
  });
  const priorityParsed = resilientParse(priorityResult.output, priorityResult.ok, 'Prioritize', 'selectedImprovement');
  const priorityData = priorityParsed.data;
  log.dim(`Priority: ${priorityResult.ok ? 'OK' : 'FAIL'}${priorityParsed.fallback ? ' (fallback)' : ''} (${formatDuration(priorityResult.durationMs)})`);

  // Determine selected improvement with cascading fallbacks
  let selectedImprovement = priorityData?.selectedImprovement
    || synthData?.suggestedImprovement;

  // Research-based fallback: extract top idea directly from research findings
  if (!selectedImprovement) {
    const researchFallback =
      research.claudeFindings?.applicableIdeas?.[0]
      || research.geminiFindings?.applicableIdeas?.[0]
      || research.codexFindings?.implementationIdeas?.[0];
    if (researchFallback) {
      log.warn('Using top research finding as improvement (deliberation parsing failed)');
      selectedImprovement = researchFallback;
    }
  }

  if (!selectedImprovement) selectedImprovement = 'No improvement selected';

  return {
    synthesis: synthData,
    critique: critiqueData,
    feasibility: feasibilityData,
    priority: priorityData,
    selectedImprovement,
  };
}

/**
 * Phase 3: PLAN — Create improvement spec + test plan.
 */
async function phasePlan(deliberation, area, kb, { cwd, timeouts, evolveDir, roundNum }) {
  log.phase('PLAN');

  const priorLearnings = getPriorLearnings(kb, area);
  const learningsBlock = priorLearnings.length > 0
    ? `\n## Prior Learnings for "${area}" (avoid repeating these mistakes)\n${priorLearnings.slice(0, 5).map(e => `- [${e.outcome}] ${e.learnings || e.finding}`).join('\n')}`
    : '';

  const planPrompt = `# Evolve Plan: Improvement Specification

Create a detailed implementation plan for the following improvement to the Hydra project:

## Selected Improvement
${deliberation.selectedImprovement}

## Rationale
${deliberation.priority?.rationale || deliberation.synthesis?.rationale || 'N/A'}

## Key Patterns Found
${JSON.stringify(deliberation.synthesis?.topPatterns || [], null, 2)}

## Concerns to Watch For
${JSON.stringify(deliberation.critique?.concerns || [], null, 2)}

## Implementation Notes (from feasibility assessment)
${deliberation.feasibility?.implementationNotes || 'N/A'}

## Risks & Constraints
${JSON.stringify(deliberation.priority?.risks || [], null, 2)}
${JSON.stringify(deliberation.priority?.constraints || [], null, 2)}
${learningsBlock}

## Hydra Project Context
- Node.js multi-agent orchestration system (Claude/Gemini/Codex)
- Main modules: hydra-operator.mjs, hydra-utils.mjs, hydra-agents.mjs, hydra-ui.mjs, hydra-metrics.mjs, hydra-statusbar.mjs
- Uses picocolors for terminal colors, no external deps besides that
- Tests use Node.js built-in test runner (node --test)

## Required Output
Respond with JSON:
{
  "objectives": ["obj1", "obj2", ...],
  "constraints": ["constraint1", ...],
  "acceptanceCriteria": ["criterion1", ...],
  "filesToModify": [{"path": "lib/file.mjs", "changes": "description"}],
  "testPlan": {
    "scenarios": ["scenario1", ...],
    "edgeCases": ["edge1", ...],
    "variables": ["var1", ...],
    "expectedBehaviors": ["behavior1", ...]
  },
  "rollbackCriteria": ["criterion1", ...]
}`;

  const planResult = await executeAgent('claude', planPrompt, {
    cwd,
    timeoutMs: timeouts.planTimeoutMs,
    phaseLabel: 'plan: spec',
  });
  const planData = parseJsonLoose(extractOutput(planResult.output));
  log.dim(`Plan: ${planResult.ok ? 'OK' : 'FAIL'} (${formatDuration(planResult.durationMs)})`);

  // Save spec artifact
  const specsDir = path.join(evolveDir, 'specs');
  ensureDir(specsDir);
  const specPath = path.join(specsDir, `ROUND_${roundNum}_SPEC.md`);

  const specContent = `# Evolve Round ${roundNum} Spec — ${area}
## Improvement
${deliberation.selectedImprovement}

## Objectives
${(planData?.objectives || []).map(o => `- ${o}`).join('\n')}

## Constraints
${(planData?.constraints || []).map(c => `- ${c}`).join('\n')}

## Acceptance Criteria
${(planData?.acceptanceCriteria || []).map(a => `- ${a}`).join('\n')}

## Files to Modify
${(planData?.filesToModify || []).map(f => `- \`${f.path}\`: ${f.changes}`).join('\n')}

## Test Plan
### Scenarios
${(planData?.testPlan?.scenarios || []).map(s => `- ${s}`).join('\n')}

### Edge Cases
${(planData?.testPlan?.edgeCases || []).map(e => `- ${e}`).join('\n')}

## Rollback Criteria
${(planData?.rollbackCriteria || []).map(r => `- ${r}`).join('\n')}
`;

  fs.writeFileSync(specPath, specContent, 'utf8');
  log.ok(`Spec saved: ${specPath}`);

  return { plan: planData, specPath };
}

/**
 * Phase 4: TEST — Write comprehensive tests (TDD).
 */
async function phaseTest(plan, branchName, safetyPrompt, { cwd, timeouts, investigatorPreamble }) {
  log.phase('TEST');

  const preambleBlock = investigatorPreamble
    ? `## Investigator Guidance (from prior failure analysis)\n${investigatorPreamble}\n\n`
    : '';

  const testPrompt = `# Evolve: Write Tests (TDD)

${preambleBlock}Write comprehensive tests for the following improvement plan. Tests MUST be written BEFORE the implementation.

## Plan
${JSON.stringify(plan.plan || {}, null, 2)}

## Requirements
- Use Node.js built-in test runner: \`import { test, describe } from 'node:test'\`
- Use \`import assert from 'node:assert/strict'\`
- Cover: happy path, edge cases, error states, boundary conditions
- Tests should be in a new file under \`test/\` directory
- Make tests specific and descriptive
- Tests should verify behavior, not implementation details

## Important
- Write tests that CAN fail (they test functionality that doesn't exist yet)
- Include at least one test per scenario and edge case from the plan
- Commit the test file(s) when done

${safetyPrompt}`;

  const testResult = await executeAgent('codex', testPrompt, {
    cwd,
    timeoutMs: timeouts.testTimeoutMs,
    phaseLabel: 'test: write TDD tests',
  });

  log.dim(`Tests: ${testResult.ok ? 'OK' : 'FAIL'} (${formatDuration(testResult.durationMs)})`);
  return { ok: testResult.ok, output: testResult.output, stderr: testResult.stderr, error: testResult.error, durationMs: testResult.durationMs, timedOut: testResult.timedOut };
}

/**
 * Phase 5: IMPLEMENT — Make changes on isolated branch.
 */
async function phaseImplement(plan, branchName, safetyPrompt, { cwd, timeouts, investigatorPreamble }) {
  log.phase('IMPLEMENT');

  const preambleBlock = investigatorPreamble
    ? `## Investigator Guidance (from prior failure analysis)\n${investigatorPreamble}\n\n`
    : '';

  const implPrompt = `# Evolve: Implement Improvement

${preambleBlock}Implement the improvement described in the spec below. Tests already exist on this branch — make them pass.

## Improvement Goal
${improvementDesc}

## Plan
${JSON.stringify(plan.plan || {}, null, 2)}

${acceptanceCriteria ? `## Acceptance Criteria\n${acceptanceCriteria}\n` : ''}
## Requirements
- Read existing code before making changes
- Make focused, minimal changes
- Run \`node --test\` to verify tests pass
- Commit your changes with a descriptive message
- Do NOT modify test files — only implementation files

${safetyPrompt}`;

  const implResult = await executeAgent('codex', implPrompt, {
    cwd,
    timeoutMs: timeouts.implementTimeoutMs,
    phaseLabel: 'implement: make tests pass',
  });

  log.dim(`Implement: ${implResult.ok ? 'OK' : 'FAIL'} (${formatDuration(implResult.durationMs)})`);
  return { ok: implResult.ok, output: implResult.output, stderr: implResult.stderr, error: implResult.error, durationMs: implResult.durationMs, timedOut: implResult.timedOut };
}

/**
 * Phase 6: ANALYZE — Multi-agent review of results.
 */
async function phaseAnalyze(diff, branchName, plan, { cwd, timeouts, deliberation } = {}) {
  log.phase('ANALYZE');

  const diffBlock = diff.length > 8000 ? diff.slice(0, 8000) + '\n...(truncated)' : diff;
  const improvementGoal = deliberation?.selectedImprovement || plan.plan?.objectives?.[0] || 'See plan for details';
  const acceptanceCriteria = (plan.plan?.acceptanceCriteria || []).map(c => `- ${c}`).join('\n');

  const reviewPrompt = (agent, focus) => `# Evolve Analysis: ${focus}

Review the implementation diff below for a Hydra improvement.

## Improvement Goal
${improvementGoal}

${acceptanceCriteria ? `## Acceptance Criteria\n${acceptanceCriteria}\n` : ''}
## Diff
\`\`\`
${diffBlock}
\`\`\`

## Your Focus: ${focus}
Score the implementation on:
- quality (1-10): Code quality, style consistency, correctness
- confidence (1-10): How confident are you in this assessment

Respond with JSON:
{
  "quality": 1-10,
  "confidence": 1-10,
  "concerns": ["concern1", ...],
  "suggestions": ["suggestion1", ...],
  "verdict": "approve" | "reject" | "revise"
}`;

  log.dim('Dispatching analysis to Claude + Gemini + Codex in parallel...');
  const [claudeResult, geminiResult, codexResult] = await Promise.all([
    executeAgentWithRetry('claude', reviewPrompt('claude', 'Architectural quality, code style, spec alignment'), {
      cwd,
      timeoutMs: timeouts.analyzeTimeoutMs,
      phaseLabel: 'analyze: architecture review',
    }),
    executeAgentWithRetry('gemini', reviewPrompt('gemini', 'Regression risk, pattern consistency, codebase fit'), {
      cwd,
      timeoutMs: timeouts.analyzeTimeoutMs,
      phaseLabel: 'analyze: regression review',
    }),
    executeAgentWithRetry('codex', reviewPrompt('codex', 'Test coverage, implementation correctness, runtime safety'), {
      cwd,
      timeoutMs: timeouts.analyzeTimeoutMs,
      phaseLabel: 'analyze: correctness review',
    }),
  ]);

  const claudeAnalysis = parseJsonLoose(extractOutput(claudeResult.output));
  const geminiAnalysis = parseJsonLoose(extractOutput(geminiResult.output));
  const codexAnalysis = parseJsonLoose(extractOutput(codexResult.output));

  log.dim(`Claude analysis: ${claudeResult.ok ? 'OK' : 'FAIL'}`);
  log.dim(`Gemini analysis: ${geminiResult.ok ? 'OK' : 'FAIL'}`);
  log.dim(`Codex analysis:  ${codexResult.ok ? 'OK' : 'FAIL'}`);

  // Also run tests
  log.dim('Running test suite...');
  const testRun = runProcess('node', ['--test'], timeouts.testTimeoutMs || 600_000, { cwd });
  const testsPassed = testRun.ok;
  log.dim(`Tests: ${testsPassed ? 'PASS' : 'FAIL'}`);

  // Aggregate scores
  const scores = [claudeAnalysis, geminiAnalysis, codexAnalysis].filter(Boolean);
  const avgQuality = scores.length > 0
    ? scores.reduce((s, a) => s + (a.quality || 0), 0) / scores.length
    : 0;
  const avgConfidence = scores.length > 0
    ? scores.reduce((s, a) => s + (a.confidence || 0), 0) / scores.length
    : 0;
  const allConcerns = scores.flatMap(s => s.concerns || []);

  // Collect per-agent verdicts
  const agentVerdicts = {
    claude: claudeAnalysis?.verdict || null,
    gemini: geminiAnalysis?.verdict || null,
    codex: codexAnalysis?.verdict || null,
  };

  return {
    agentScores: { claude: claudeAnalysis, gemini: geminiAnalysis, codex: codexAnalysis },
    agentVerdicts,
    aggregateScore: Math.round(avgQuality * 10) / 10,
    aggregateConfidence: Math.round(avgConfidence * 10) / 10,
    concerns: allConcerns,
    testsPassed,
    testOutput: (testRun.stdout || '').slice(-2000),
  };
}

/**
 * Phase 7: DECIDE — Consensus verdict.
 */
function phaseDecide(analysis, config) {
  log.phase('DECIDE');

  const { aggregateScore, testsPassed, concerns, agentVerdicts } = analysis;
  const minScore = config.approval?.minScore || 7;
  const requireAllTests = config.approval?.requireAllTestsPass !== false;

  // Count per-agent verdicts
  const verdictEntries = Object.entries(agentVerdicts || {}).filter(([, v]) => v != null);
  const approvals = verdictEntries.filter(([, v]) => v === 'approve').length;
  const rejections = verdictEntries.filter(([, v]) => v === 'reject').length;
  const totalVoters = verdictEntries.length;

  // Log per-agent breakdown
  const agentScores = analysis.agentScores || {};
  const verdictParts = [];
  for (const agent of ['claude', 'gemini', 'codex']) {
    const v = agentVerdicts?.[agent];
    const s = agentScores[agent]?.quality;
    if (v || s != null) {
      verdictParts.push(`${agent[0].toUpperCase() + agent.slice(1)}: ${v || '?'}(${s ?? '?'})`);
    }
  }

  let verdict;
  let reason;

  const hasCriticalConcerns = concerns.some(c =>
    /critical|breaking|security|data.?loss/i.test(c)
  );

  if (hasCriticalConcerns) {
    verdict = 'reject';
    reason = `Critical concerns identified: ${concerns.filter(c => /critical|breaking|security|data.?loss/i.test(c)).join('; ')}`;
  } else if (requireAllTests && !testsPassed) {
    verdict = 'reject';
    reason = 'Tests did not pass';
  } else if (rejections >= 2 && totalVoters >= 2) {
    // Majority reject overrides score
    verdict = 'reject';
    reason = `Majority reject (${rejections}/${totalVoters} agents) — score ${aggregateScore}/10`;
  } else if (approvals >= 2 && totalVoters >= 2 && aggregateScore >= minScore - 1) {
    // Majority approve with score close enough → approve
    verdict = 'approve';
    reason = `Majority approve (${approvals}/${totalVoters} agents) — score ${aggregateScore}/10, tests ${testsPassed ? 'passed' : 'N/A'}`;
  } else if (aggregateScore >= minScore) {
    verdict = 'approve';
    reason = `Score ${aggregateScore}/10 meets minimum ${minScore}/10, tests ${testsPassed ? 'passed' : 'N/A'}`;
  } else if (aggregateScore >= minScore - 2) {
    verdict = 'revise';
    reason = `Score ${aggregateScore}/10 is close but below minimum ${minScore}/10`;
  } else {
    verdict = 'reject';
    reason = `Score ${aggregateScore}/10 is below minimum ${minScore}/10`;
  }

  const verdictSummary = verdictParts.length > 0
    ? ` | ${verdictParts.join(' | ')} → ${verdict.toUpperCase()}${totalVoters >= 2 ? ` (${approvals}/${totalVoters} approve)` : ''}`
    : '';
  log.info(`Verdict: ${verdict.toUpperCase()} — ${reason}${verdictSummary}`);
  return { verdict, reason, score: aggregateScore };
}

// ── Search Query Generation ─────────────────────────────────────────────────

function getSearchQueries(area) {
  const queries = {
    'orchestration-patterns': [
      'CrewAI task delegation approach 2026',
      'AutoGen multi-agent conversation patterns',
      'LangGraph agent orchestration',
      'MetaGPT multi-agent programming',
      'multi-agent orchestration framework comparison',
    ],
    'ai-coding-tools': [
      'Cursor AI coding assistant architecture',
      'Aider AI pair programming patterns',
      'Cline VS Code AI assistant',
      'AI coding tool CLI design patterns',
      'Windsurf AI coding features',
    ],
    'testing-reliability': [
      'testing AI agent systems reliability',
      'property-based testing AI outputs',
      'flaky test mitigation strategies',
      'AI system testing best practices 2026',
      'deterministic testing for LLM applications',
    ],
    'developer-experience': [
      'CLI developer experience best practices',
      'terminal UI patterns Node.js',
      'REPL design patterns developer tools',
      'progressive disclosure CLI design',
      'AI tool developer onboarding UX',
    ],
    'model-routing': [
      'mixture of agents model routing',
      'LLM routing strategies cost optimization',
      'multi-model selection algorithms',
      'AI model cascade patterns',
      'prompt routing classifier design',
    ],
    'daemon-architecture': [
      'task queue daemon architecture Node.js',
      'Temporal workflow engine patterns',
      'BullMQ job processing patterns',
      'event-driven daemon design patterns',
      'long-running process management Node.js',
    ],
  };
  return queries[area] || [
    `${area} best practices 2026`,
    `${area} implementation patterns`,
    `${area} tools and frameworks`,
  ];
}

// ── Report Generation ───────────────────────────────────────────────────────

function compactTokenBar(tokens, budget, width = 16) {
  const ratio = Math.min(tokens / (budget || 1), 1);
  const filled = Math.round(ratio * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const pct = (ratio * 100).toFixed(0);
  return pc.dim(`[${bar}] ${pct.padStart(3)}%`);
}

function formatDuration(ms) {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m`;
}

function generateSessionReport(roundResults, budgetSummary, runMeta, kbDelta, investigatorSummary) {
  const { startedAt, finishedAt, dateStr, maxRounds } = runMeta;
  const durationStr = formatDuration(finishedAt - startedAt);
  const tokensStr = `~${budgetSummary.consumed.toLocaleString()}`;

  const lines = [
    `# Evolve Session — ${dateStr}`,
    `Rounds: ${roundResults.length}/${maxRounds} | Duration: ${durationStr} | Tokens: ${tokensStr}`,
    '',
  ];

  for (const r of roundResults) {
    const resultTag = r.verdict ? r.verdict.toUpperCase() : 'INCOMPLETE';
    lines.push(`## Round ${r.round}: ${r.area}`);
    lines.push(`- Research: ${r.researchSummary || 'N/A'}`);
    lines.push(`- Selected: ${r.selectedImprovement || 'N/A'}`);
    if (r.testsWritten !== undefined) {
      lines.push(`- Tests: ${r.testsWritten}`);
    }
    lines.push(`- Result: ${resultTag}${r.score ? ` (score: ${r.score}/10)` : ''}`);
    if (r.branchName) {
      lines.push(`- Branch: ${r.branchName}`);
    }
    if (r.learnings) {
      lines.push(`- Learnings: ${r.learnings}`);
    }
    if (r.investigations && r.investigations.count > 0) {
      lines.push(`- Investigations: ${r.investigations.count} (healed: ${r.investigations.healed})`);
    }
    lines.push('');
  }

  lines.push('## Knowledge Base Growth');
  lines.push(`- New entries: ${kbDelta.added}`);
  lines.push(`- Cumulative: ${kbDelta.total} entries`);
  lines.push('');

  // Investigation summary
  if (investigatorSummary && investigatorSummary.investigations > 0) {
    lines.push('## Self-Healing Investigator');
    lines.push(`- Investigations triggered: ${investigatorSummary.investigations}`);
    lines.push(`- Healed (retry succeeded): ${investigatorSummary.healed}`);
    lines.push(`- Investigator tokens: ~${(investigatorSummary.promptTokens + investigatorSummary.completionTokens).toLocaleString()}`);
    lines.push('');
  }

  lines.push('## Budget Summary');
  lines.push(`- Start tokens: ${budgetSummary.startTokens.toLocaleString()}`);
  lines.push(`- End tokens: ${budgetSummary.endTokens.toLocaleString()}`);
  lines.push(`- Consumed: ${budgetSummary.consumed.toLocaleString()}`);
  lines.push(`- Budget limit: ${budgetSummary.hardLimit.toLocaleString()}`);
  lines.push(`- Avg per round: ${budgetSummary.avgPerRound.toLocaleString()}`);
  if (budgetSummary.roundDeltas.length > 0) {
    lines.push('');
    lines.push('| Round | Area | Tokens | Duration |');
    lines.push('|-------|------|--------|----------|');
    for (const d of budgetSummary.roundDeltas) {
      lines.push(`| ${d.round} | ${d.area} | ${d.tokens.toLocaleString()} | ${formatDuration(d.durationMs)} |`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

function generateSessionJSON(roundResults, budgetSummary, runMeta, kbDelta, investigatorSummary) {
  return {
    ...runMeta,
    budget: budgetSummary,
    knowledgeBaseDelta: kbDelta,
    investigator: investigatorSummary || null,
    rounds: roundResults.map(r => ({
      round: r.round,
      area: r.area,
      selectedImprovement: r.selectedImprovement,
      verdict: r.verdict,
      score: r.score,
      branchName: r.branchName,
      learnings: r.learnings,
      durationMs: r.durationMs,
      investigations: r.investigations || null,
    })),
  };
}

// ── Main Runner ─────────────────────────────────────────────────────────────

async function main() {
  const { options } = parseArgs(process.argv);
  const isResume = options.resume === '1' || options.resume === 'true';

  // ── Resolve project ───────────────────────────────────────────────────
  let projectConfig;
  try {
    projectConfig = resolveProject({ project: options.project });
  } catch (err) {
    log.error(`Project resolution failed: ${err.message}`);
    process.exit(1);
  }

  const { projectRoot, coordDir } = projectConfig;
  log.info(`Project: ${projectRoot}`);

  // ── Load evolve config ────────────────────────────────────────────────
  const hydraConfig = loadHydraConfig();
  const evolveConfig = hydraConfig.evolve || {};
  const baseBranch = evolveConfig.baseBranch || 'dev';

  // ── Validate preconditions ────────────────────────────────────────────
  const currentBranch = getCurrentBranch(projectRoot);
  if (currentBranch !== baseBranch) {
    log.error(`Must be on '${baseBranch}' branch (currently on '${currentBranch}')`);
    process.exit(1);
  }

  if (!isCleanWorkingTree(projectRoot)) {
    log.error('Working tree is not clean. Commit or stash changes first.');
    process.exit(1);
  }

  log.ok(`Preconditions met: on ${baseBranch}, clean working tree`);

  // ── Initialize evolve directory ───────────────────────────────────────
  const evolveDir = path.join(coordDir, 'evolve');
  ensureDir(evolveDir);
  ensureDir(path.join(evolveDir, 'research'));
  ensureDir(path.join(evolveDir, 'specs'));
  ensureDir(path.join(evolveDir, 'decisions'));

  // ── Initialize investigator ─────────────────────────────────────────
  if (isInvestigatorAvailable()) {
    initInvestigator();
    log.ok('Self-healing investigator initialized');
  } else {
    log.dim('Investigator not available (no OPENAI_API_KEY or disabled in config)');
  }

  // ── Check for session checkpoint (resume) ─────────────────────────────
  const checkpoint = loadCheckpoint(evolveDir);
  const existingState = loadSessionState(evolveDir);
  let startedAt, dateStr, maxRounds, maxHoursMs, focusAreas, timeouts;
  let roundResults, kbStartCount, budget, startRound, sessionId;

  const kb = loadKnowledgeBase(evolveDir);

  if (checkpoint && isResume) {
    // ── Resume from checkpoint ──────────────────────────────────────────
    log.info(pc.yellow('Resuming evolve session from checkpoint...'));
    log.dim(`Reason: ${checkpoint.reason || 'hot-restart'}`);

    sessionId = checkpoint.sessionId || `evolve_${checkpoint.dateStr}_${Math.random().toString(36).slice(2, 7)}`;
    startedAt = checkpoint.startedAt;
    dateStr = checkpoint.dateStr;
    maxRounds = checkpoint.maxRounds;
    maxHoursMs = checkpoint.maxHoursMs;
    focusAreas = checkpoint.focusAreas;
    timeouts = checkpoint.timeouts;
    roundResults = checkpoint.completedRounds || [];
    kbStartCount = checkpoint.kbStartCount;
    startRound = (checkpoint.lastRoundNum || 0) + 1;

    // Restore budget tracker
    if (checkpoint.budgetState) {
      budget = EvolveBudgetTracker.deserialize(checkpoint.budgetState);
      log.dim(`Budget restored: ${budget.consumed.toLocaleString()} tokens consumed across ${budget.roundDeltas.length} rounds`);
    } else {
      budget = new EvolveBudgetTracker(checkpoint.budgetOverrides || {});
      budget.recordStart();
    }

    // Consume (delete) the checkpoint
    deleteCheckpoint(evolveDir);
    log.ok(`Checkpoint consumed, resuming from round ${startRound}`);
  } else if (!checkpoint && isResume && existingState?.resumable) {
    // ── Resume from session state ───────────────────────────────────────
    log.info(pc.yellow('Resuming evolve session from session state...'));
    log.dim(`Session: ${existingState.sessionId} (${existingState.status})`);

    sessionId = existingState.sessionId;
    dateStr = existingState.dateStr;
    roundResults = existingState.completedRounds || [];
    kbStartCount = existingState.kbStartCount || kb.entries.length - (existingState.summary?.totalKBAdded || 0);
    startRound = existingState.nextRound || (roundResults.length + 1);
    focusAreas = existingState.focusAreas || evolveConfig.focusAreas || DEFAULT_FOCUS_AREAS;
    timeouts = existingState.timeouts || { ...DEFAULT_PHASE_TIMEOUTS, ...(evolveConfig.phases || {}) };

    // Parse options for overrides on resume
    maxRounds = options['max-rounds']
      ? parseInt(options['max-rounds'], 10)
      : existingState.maxRounds || evolveConfig.maxRounds || DEFAULT_MAX_ROUNDS;
    maxHoursMs = (options['max-hours']
      ? parseFloat(options['max-hours'])
      : existingState.maxHours || evolveConfig.maxHours || DEFAULT_MAX_HOURS) * 60 * 60 * 1000;

    // Fresh time limit for resumed sessions
    startedAt = Date.now();

    // Restore budget tracker
    if (existingState.budgetState) {
      budget = EvolveBudgetTracker.deserialize(existingState.budgetState);
      log.dim(`Budget restored: ${budget.consumed.toLocaleString()} tokens consumed across ${budget.roundDeltas.length} rounds`);
    } else {
      const budgetOverrides = {};
      if (options['hard-limit']) budgetOverrides.hardLimit = parseInt(options['hard-limit'], 10);
      if (options['soft-limit']) budgetOverrides.softLimit = parseInt(options['soft-limit'], 10);
      budget = new EvolveBudgetTracker(budgetOverrides);
      budget.recordStart();
    }

    log.ok(`Session state restored, resuming from round ${startRound}`);
  } else {
    // ── Fresh session ───────────────────────────────────────────────────
    if (checkpoint && !isResume) {
      log.warn('Stale checkpoint found but --resume not set. Starting fresh session.');
      deleteCheckpoint(evolveDir);
    }

    startedAt = Date.now();
    dateStr = new Date().toISOString().split('T')[0];
    sessionId = `evolve_${dateStr}_${Math.random().toString(36).slice(2, 7)}`;
    startRound = 1;
    roundResults = [];
    kbStartCount = kb.entries.length;

    // Parse options
    maxRounds = options['max-rounds']
      ? parseInt(options['max-rounds'], 10)
      : evolveConfig.maxRounds || DEFAULT_MAX_ROUNDS;
    maxHoursMs = (options['max-hours']
      ? parseFloat(options['max-hours'])
      : evolveConfig.maxHours || DEFAULT_MAX_HOURS) * 60 * 60 * 1000;
    focusAreas = options.focus
      ? [options.focus]
      : evolveConfig.focusAreas || DEFAULT_FOCUS_AREAS;
    timeouts = { ...DEFAULT_PHASE_TIMEOUTS, ...(evolveConfig.phases || {}) };

    const budgetOverrides = {};
    if (options['hard-limit']) budgetOverrides.hardLimit = parseInt(options['hard-limit'], 10);
    if (options['soft-limit']) budgetOverrides.softLimit = parseInt(options['soft-limit'], 10);

    budget = new EvolveBudgetTracker(budgetOverrides);
    budget.recordStart();
  }

  log.info(`Session: ${sessionId}`);
  log.info(`Budget: ${budget.hardLimit.toLocaleString()} token hard limit`);
  log.info(`Rounds: max ${maxRounds} | Time: max ${formatDuration(maxHoursMs)}`);

  // ── Save initial session state ──────────────────────────────────────
  saveSessionState(evolveDir, {
    sessionId,
    status: 'running',
    startedAt,
    dateStr,
    maxRounds,
    maxHours: maxHoursMs / (60 * 60 * 1000),
    focusAreas,
    timeouts,
    kbStartCount,
    completedRounds: roundResults,
    nextRound: startRound,
    resumable: false,
    summary: {
      approved: 0, rejected: 0, skipped: 0, errors: 0,
      totalKBAdded: 0,
    },
    budgetState: budget.serialize(),
  });

  // ── Round loop ────────────────────────────────────────────────────────
  let stopReason = null;
  let reducedScope = false;

  for (let round = startRound; round <= maxRounds; round++) {
    const roundStart = Date.now();

    // Time limit check
    if (Date.now() - startedAt > maxHoursMs) {
      stopReason = 'time limit';
      log.warn(`Time limit reached (${formatDuration(maxHoursMs)}). Stopping.`);
      break;
    }

    // Budget gate check
    const budgetCheck = budget.check();

    if (budgetCheck.action === 'hard_stop') {
      stopReason = 'hard budget limit';
      log.error(`HARD STOP: ${budgetCheck.reason}`);
      break;
    }

    if (budgetCheck.action === 'soft_stop') {
      stopReason = 'soft budget limit';
      log.warn(`SOFT STOP: ${budgetCheck.reason}`);
      break;
    }

    if (budgetCheck.action === 'reduce_scope') {
      reducedScope = true;
      log.warn(budgetCheck.reason);
    }

    if (budgetCheck.action === 'warn') {
      log.warn(budgetCheck.reason);
    }

    if (!budgetCheck.canFitNextRound && round > 1) {
      stopReason = 'predicted budget exceeded';
      log.warn(`Predicted next round (~${budgetCheck.avgPerRound.toLocaleString()} tokens) would exceed remaining budget. Stopping.`);
      break;
    }

    // Select focus area (rotate, skip recently covered)
    const recentAreas = roundResults.map(r => r.area);
    const areaIndex = (round - 1) % focusAreas.length;
    let area = focusAreas[areaIndex];
    // If we only have one focus area specified, use it; otherwise try to avoid repeats
    if (focusAreas.length > 1 && recentAreas.includes(area)) {
      area = focusAreas.find(a => !recentAreas.includes(a)) || area;
    }

    log.round(`ROUND ${round}/${maxRounds}: ${area}`);

    const roundResult = {
      round,
      area,
      selectedImprovement: null,
      verdict: null,
      score: null,
      branchName: null,
      learnings: null,
      durationMs: 0,
      researchSummary: null,
      investigations: null,
    };

    try {
      // ── Phase 1: RESEARCH ──────────────────────────────────────────────
      const research = await phaseResearch(area, kb, { cwd: projectRoot, timeouts, evolveDir });

      // Save research artifact
      const researchPath = path.join(evolveDir, 'research', `ROUND_${round}_RESEARCH.json`);
      fs.writeFileSync(researchPath, JSON.stringify(research, null, 2), 'utf8');
      log.ok(`Research saved: ${path.basename(researchPath)}`);

      // Summarize research for report
      const allFindings = [
        ...(research.claudeFindings?.findings || []),
        ...(research.geminiFindings?.findings || []),
      ];
      roundResult.researchSummary = allFindings.slice(0, 3).join('; ').slice(0, 200) || 'No findings';

      // Add research findings to KB
      for (const finding of allFindings.slice(0, 5)) {
        addEntry(kb, {
          round,
          date: dateStr,
          area,
          finding,
          applicability: 'medium',
          attempted: false,
          tags: [area],
        });
      }

      // ── Phase 2: DELIBERATE ────────────────────────────────────────────
      const deliberation = await phaseDeliberate(research, kb, { cwd: projectRoot, timeouts });
      roundResult.selectedImprovement = deliberation.selectedImprovement;
      log.ok(`Selected: ${deliberation.selectedImprovement.slice(0, 100)}`);

      // If deliberation produced no actionable improvement, skip this round
      if (deliberation.selectedImprovement === 'No improvement selected' || deliberation.selectedImprovement.length < 5) {
        log.warn('No actionable improvement from deliberation — skipping round');
        roundResult.verdict = 'skipped';
        roundResult.learnings = 'No actionable improvement from deliberation';

        addEntry(kb, {
          round,
          date: dateStr,
          area,
          finding: deliberation.selectedImprovement || 'empty',
          applicability: 'low',
          attempted: false,
          outcome: null,
          learnings: 'Deliberation did not produce actionable improvement',
          tags: [area, 'skipped'],
        });

        roundResults.push(roundResult);
        budget.recordRoundEnd(round, area, Date.now() - roundStart);
        continue;
      }

      // If reduced scope, skip implementation phases
      if (reducedScope) {
        log.warn('Reduced scope mode — skipping TEST, IMPLEMENT, ANALYZE phases');
        roundResult.verdict = 'skipped';
        roundResult.learnings = 'Budget-reduced: research and deliberation only';

        addEntry(kb, {
          round,
          date: dateStr,
          area,
          finding: deliberation.selectedImprovement,
          applicability: deliberation.priority?.expectedImpact || 'medium',
          attempted: false,
          outcome: null,
          learnings: 'Deferred due to budget constraints',
          tags: [area, 'deferred'],
        });

        roundResults.push(roundResult);
        budget.recordRoundEnd(round, area, Date.now() - roundStart);
        continue;
      }

      // ── Phase 3: PLAN ──────────────────────────────────────────────────
      const plan = await phasePlan(deliberation, area, kb, {
        cwd: projectRoot,
        timeouts,
        evolveDir,
        roundNum: round,
      });

      // ── Create branch ──────────────────────────────────────────────────
      const branchName = `evolve/${dateStr}/${round}`;
      roundResult.branchName = branchName;

      if (!createBranch(projectRoot, branchName, baseBranch)) {
        log.error(`Failed to create branch: ${branchName}`);
        roundResult.verdict = 'error';
        roundResult.learnings = 'Branch creation failed';
        roundResults.push(roundResult);
        checkoutBranch(projectRoot, baseBranch);
        budget.recordRoundEnd(round, area, Date.now() - roundStart);
        continue;
      }
      log.ok(`Branch: ${branchName}`);

      const safetyPrompt = buildEvolveSafetyPrompt(branchName);

      // ── Phase 4: TEST (with investigation) ────────────────────────────
      let testResult = await phaseTest(plan, branchName, safetyPrompt, {
        cwd: projectRoot,
        timeouts,
      });

      if (!testResult.ok && isInvestigatorAvailable()) {
        log.info('Test phase failed — investigating...');
        const testDiag = await investigate({
          phase: 'test',
          agent: 'codex',
          error: testResult.error || 'phaseTest returned ok=false',
          stderr: (testResult.stderr || '').slice(-2000),
          stdout: (testResult.output || '').slice(-2000),
          timedOut: testResult.timedOut || false,
          context: JSON.stringify(plan.plan || {}).slice(0, 3000),
          attemptNumber: 1,
        });
        recordInvestigation('test', testDiag);
        log.dim(`Test investigation: ${testDiag.diagnosis} — ${testDiag.explanation}`);

        if (testDiag.retryRecommendation?.retryPhase && testDiag.diagnosis !== 'fundamental') {
          log.info('Retrying test phase with investigator guidance...');
          testResult = await phaseTest(plan, branchName, safetyPrompt, {
            cwd: projectRoot,
            timeouts,
            investigatorPreamble: testDiag.retryRecommendation?.preamble || testDiag.corrective,
          });
        }
      }

      // ── Phase 5: IMPLEMENT (with investigation) ────────────────────────
      let implResult = await phaseImplement(plan, branchName, safetyPrompt, {
        cwd: projectRoot,
        timeouts,
        deliberation,
      });

      if (!implResult.ok && isInvestigatorAvailable()) {
        log.info('Implement phase failed — investigating...');
        const implDiag = await investigate({
          phase: 'implement',
          agent: 'codex',
          error: implResult.error || 'phaseImplement returned ok=false',
          stderr: (implResult.stderr || '').slice(-2000),
          stdout: (implResult.output || '').slice(-2000),
          timedOut: implResult.timedOut || false,
          context: JSON.stringify(plan.plan || {}).slice(0, 3000),
          attemptNumber: 1,
        });
        recordInvestigation('implement', implDiag);
        log.dim(`Implement investigation: ${implDiag.diagnosis} — ${implDiag.explanation}`);

        if (implDiag.retryRecommendation?.retryPhase && implDiag.diagnosis !== 'fundamental') {
          log.info('Retrying implement phase with investigator guidance...');
          implResult = await phaseImplement(plan, branchName, safetyPrompt, {
            cwd: projectRoot,
            timeouts,
            investigatorPreamble: implDiag.retryRecommendation?.preamble || implDiag.corrective,
          });
        }
      }

      // Verify we're still on the right branch
      const branchCheck = verifyBranch(projectRoot, branchName);
      if (!branchCheck.ok) {
        log.error(`Branch escape! Expected '${branchName}', on '${branchCheck.currentBranch}'`);
        git(['checkout', branchName], projectRoot);
      }

      // ── Phase 6: ANALYZE ───────────────────────────────────────────────
      const diff = getBranchDiff(projectRoot, branchName, baseBranch);
      let analysis = await phaseAnalyze(diff, branchName, plan, {
        cwd: projectRoot,
        timeouts,
        deliberation,
      });

      // If tests failed during analysis, investigate and attempt a fix pass
      if (!analysis.testsPassed && isInvestigatorAvailable()) {
        log.info('Tests failed in analysis — investigating...');
        const analyzeDiag = await investigate({
          phase: 'analyze',
          agent: 'codex',
          error: 'Tests failed during analysis phase',
          stderr: '',
          stdout: (analysis.testOutput || '').slice(-2000),
          timedOut: false,
          context: `Test output: ${(analysis.testOutput || '').slice(-1500)}`,
          attemptNumber: 1,
        });
        recordInvestigation('analyze', analyzeDiag);
        log.dim(`Analyze investigation: ${analyzeDiag.diagnosis} — ${analyzeDiag.explanation}`);

        if (analyzeDiag.diagnosis === 'fixable' && analyzeDiag.corrective) {
          log.info('Running corrective implementation pass...');
          const fixPrompt = `# Corrective Fix — Tests Failing

The tests on this branch are failing. The investigator diagnosed the issue:

**Root cause:** ${analyzeDiag.rootCause}
**Corrective action:** ${analyzeDiag.corrective}

Fix the implementation to make the tests pass. Run \`node --test\` to verify.

${safetyPrompt}`;

          await executeAgent('codex', fixPrompt, {
            cwd: projectRoot,
            timeoutMs: timeouts.implementTimeoutMs,
            phaseLabel: 'analyze: corrective fix',
          });

          // Re-run analysis after fix attempt
          const newDiff = getBranchDiff(projectRoot, branchName, baseBranch);
          analysis = await phaseAnalyze(newDiff, branchName, plan, {
            cwd: projectRoot,
            timeouts,
          });
        }
      }

      roundResult.score = analysis.aggregateScore;

      // Snapshot investigation stats for this round
      if (sessionInvestigations.count > 0) {
        roundResult.investigations = { ...sessionInvestigations };
      }

      // ── Phase 7: DECIDE ────────────────────────────────────────────────
      // Check for violations
      const violations = scanBranchViolations(projectRoot, branchName, baseBranch);
      if (violations.length > 0) {
        log.warn(`${violations.length} violation(s) detected`);
        for (const v of violations) {
          log.dim(`  [${v.severity}] ${v.detail}`);
        }
        // Critical violations force reject
        if (violations.some(v => v.severity === 'critical')) {
          analysis.concerns.push('Critical guardrail violations detected');
        }
      }

      const decision = phaseDecide(analysis, evolveConfig);
      roundResult.verdict = decision.verdict;
      roundResult.learnings = decision.reason;

      // Save decision artifact
      const decisionPath = path.join(evolveDir, 'decisions', `ROUND_${round}_DECISION.json`);
      fs.writeFileSync(decisionPath, JSON.stringify({
        round,
        area,
        improvement: deliberation.selectedImprovement,
        verdict: decision.verdict,
        reason: decision.reason,
        score: analysis.aggregateScore,
        confidence: analysis.aggregateConfidence,
        testsPassed: analysis.testsPassed,
        violations: violations.length,
        concerns: analysis.concerns,
        branchName,
      }, null, 2), 'utf8');

      // Update knowledge base with decision (include investigation tags if any)
      const kbTags = [area, decision.verdict];
      if (sessionInvestigations.count > 0) {
        kbTags.push('investigation');
        for (const d of sessionInvestigations.diagnoses) {
          if (!kbTags.includes(d.diagnosis)) kbTags.push(d.diagnosis);
          if (!kbTags.includes(d.phase)) kbTags.push(d.phase);
        }
      }
      addEntry(kb, {
        round,
        date: dateStr,
        area,
        finding: deliberation.selectedImprovement,
        applicability: deliberation.priority?.expectedImpact || 'medium',
        attempted: true,
        outcome: decision.verdict,
        score: analysis.aggregateScore,
        learnings: decision.reason,
        tags: kbTags,
      });

      const stats = getBranchStats(projectRoot, branchName, baseBranch);
      log.ok(`Round ${round} complete: ${decision.verdict.toUpperCase()} | ${stats.commits} commits | ${stats.filesChanged} files`);

      // ── Hot-restart: self-modification detected ───────────────────────
      if (decision.verdict === 'approve' && didModifyHydraCode(projectRoot, branchName, baseBranch)) {
        log.info(pc.yellow('Self-modification detected — initiating hot-restart'));

        // 1. Merge approved branch to base
        checkoutBranch(projectRoot, baseBranch);
        const mergeResult = git(['merge', branchName, '--no-edit'], projectRoot);
        if (mergeResult.status !== 0) {
          log.error(`Merge failed: ${(mergeResult.stderr || '').trim()}`);
          // Continue without hot-restart — branch stays for manual merge
        } else {
          log.ok(`Merged ${branchName} → ${baseBranch}`);

          // Record this round before saving checkpoint
          roundResult.durationMs = Date.now() - roundStart;
          roundResults.push(roundResult);
          budget.recordRoundEnd(round, area, roundResult.durationMs);

          // 2. Save knowledge base (so new process has latest data)
          saveKnowledgeBase(evolveDir, kb);

          // 3. Save session checkpoint
          saveCheckpoint(evolveDir, {
            sessionId,
            startedAt,
            dateStr,
            projectRoot,
            baseBranch,
            maxRounds,
            maxHoursMs,
            focusAreas,
            timeouts,
            budgetOverrides: {},
            budgetState: budget.serialize(),
            completedRounds: roundResults,
            lastRoundNum: round,
            kbStartCount,
            reason: 'hot-restart after approved self-modification',
          });

          // 4. Spawn new process and exit
          spawnNewProcess(projectRoot);
          log.info('Exiting for hot-restart...');
          process.exit(0);
        }
      }

    } catch (err) {
      log.error(`Round ${round} error: ${err.message}`);
      roundResult.verdict = 'error';
      roundResult.learnings = err.message;
    }

    // Return to base branch
    const currentAfterRound = getCurrentBranch(projectRoot);
    if (currentAfterRound !== baseBranch) {
      checkoutBranch(projectRoot, baseBranch);
    }

    roundResult.durationMs = Date.now() - roundStart;
    roundResults.push(roundResult);
    budget.recordRoundEnd(round, area, roundResult.durationMs);

    // ── Incremental session state save ─────────────────────────────────
    const approved = roundResults.filter(r => r.verdict === 'approve').length;
    const rejected = roundResults.filter(r => r.verdict === 'reject').length;
    const skippedSoFar = roundResults.filter(r => r.verdict === 'skipped').length;
    const errorsSoFar = roundResults.filter(r => r.verdict === 'error').length;
    saveSessionState(evolveDir, {
      sessionId,
      status: 'running',
      startedAt,
      dateStr,
      maxRounds,
      maxHours: maxHoursMs / (60 * 60 * 1000),
      focusAreas,
      timeouts,
      kbStartCount,
      completedRounds: roundResults,
      nextRound: round + 1,
      resumable: false,
      summary: {
        approved, rejected, skipped: skippedSoFar, errors: errorsSoFar,
        totalKBAdded: kb.entries.length - kbStartCount,
      },
      budgetState: budget.serialize(),
    });
  }

  // ── Always return to base branch ──────────────────────────────────────
  const finalBranch = getCurrentBranch(projectRoot);
  if (finalBranch !== baseBranch) {
    checkoutBranch(projectRoot, baseBranch);
  }

  // ── Save knowledge base ───────────────────────────────────────────────
  saveKnowledgeBase(evolveDir, kb);
  log.ok('Knowledge base saved');

  // ── Generate reports ──────────────────────────────────────────────────
  const finishedAt = Date.now();
  const budgetSummary = budget.getSummary();
  const kbDelta = { added: kb.entries.length - kbStartCount, total: kb.entries.length };
  const runMeta = {
    startedAt,
    finishedAt,
    dateStr,
    maxRounds,
    processedRounds: roundResults.length,
    stopReason,
  };

  const investigatorSummary = isInvestigatorAvailable() ? getInvestigatorStats() : null;
  const mdReport = generateSessionReport(roundResults, budgetSummary, runMeta, kbDelta, investigatorSummary);
  const jsonReport = generateSessionJSON(roundResults, budgetSummary, runMeta, kbDelta, investigatorSummary);

  const mdPath = path.join(evolveDir, `EVOLVE_${dateStr}.md`);
  const jsonPath = path.join(evolveDir, `EVOLVE_${dateStr}.json`);

  fs.writeFileSync(mdPath, mdReport, 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2), 'utf8');

  log.ok(`Report saved: ${mdPath}`);
  log.ok(`JSON saved:   ${jsonPath}`);

  // ── Finalize session state ──────────────────────────────────────────
  const finalStatus = computeSessionStatus(roundResults, maxRounds, stopReason, false);
  const actionNeeded = computeActionNeeded(roundResults, maxRounds, finalStatus);
  const finalApproved = roundResults.filter(r => r.verdict === 'approve').length;
  const finalRejected = roundResults.filter(r => r.verdict === 'reject').length;
  const finalSkipped = roundResults.filter(r => r.verdict === 'skipped').length;
  const finalErrors = roundResults.filter(r => r.verdict === 'error').length;

  saveSessionState(evolveDir, {
    sessionId,
    status: finalStatus,
    startedAt,
    finishedAt,
    dateStr,
    maxRounds,
    maxHours: maxHoursMs / (60 * 60 * 1000),
    focusAreas,
    timeouts,
    kbStartCount,
    completedRounds: roundResults,
    nextRound: roundResults.length + startRound > maxRounds ? null : roundResults.length + startRound,
    resumable: finalStatus === 'partial' || finalStatus === 'failed',
    stopReason,
    actionNeeded,
    summary: {
      approved: finalApproved,
      rejected: finalRejected,
      skipped: finalSkipped,
      errors: finalErrors,
      totalKBAdded: kbDelta.added,
    },
    budgetState: budget.serialize(),
  });

  log.info(`Session status: ${finalStatus}${actionNeeded ? ` — ${actionNeeded}` : ''}`);

  // ── Summary ───────────────────────────────────────────────────────────
  const approved = finalApproved;
  const rejected = finalRejected;
  const revised = roundResults.filter(r => r.verdict === 'revise').length;
  const errors = finalErrors;
  const skipped = finalSkipped;
  const totalTokens = budgetSummary.consumed;

  const W = 64; // box width
  const hr = pc.dim('─'.repeat(W));
  const dhr = pc.cyan('═'.repeat(W));

  console.log('');
  console.log(dhr);
  console.log(pc.bold(pc.cyan('  EVOLVE SESSION COMPLETE')));
  console.log(dhr);
  console.log('');

  // ── Per-round detail ──────────────────────────────────────────────
  for (const r of roundResults) {
    const verdictColor = r.verdict === 'approve' ? pc.green
      : r.verdict === 'reject' ? pc.red
      : r.verdict === 'revise' ? pc.yellow
      : r.verdict === 'error' ? pc.red
      : pc.dim;
    const tag = verdictColor(pc.bold((r.verdict || 'incomplete').toUpperCase()));
    const scoreStr = r.score != null ? pc.dim(` score:${r.score}/10`) : '';
    const dur = r.durationMs ? pc.dim(` ${formatDuration(r.durationMs)}`) : '';

    console.log(`  ${pc.bold(pc.cyan(`Round ${r.round}`))} ${pc.dim('·')} ${r.area}`);
    console.log(`    ${tag}${scoreStr}${dur}`);
    if (r.selectedImprovement && r.selectedImprovement !== 'No improvement selected') {
      console.log(`    ${pc.dim('Goal:')} ${r.selectedImprovement.slice(0, 80)}`);
    }
    if (r.branchName) {
      console.log(`    ${pc.dim('Branch:')} ${r.branchName}`);
    }
    if (r.learnings) {
      console.log(`    ${pc.dim('Note:')} ${r.learnings.slice(0, 80)}`);
    }
    console.log('');
  }

  console.log(hr);

  // ── Aggregate stats ───────────────────────────────────────────────
  const verdictLine = [
    approved > 0 ? pc.green(`${approved} approved`) : null,
    revised > 0 ? pc.yellow(`${revised} revised`) : null,
    rejected > 0 ? pc.red(`${rejected} rejected`) : null,
    errors > 0 ? pc.red(`${errors} error`) : null,
    skipped > 0 ? pc.dim(`${skipped} skipped`) : null,
  ].filter(Boolean).join(pc.dim(' / '));

  console.log(`  ${pc.bold('Rounds')}      ${roundResults.length}/${maxRounds}  ${verdictLine}`);
  console.log(`  ${pc.bold('Duration')}    ${formatDuration(finishedAt - startedAt)}`);
  console.log(`  ${pc.bold('Tokens')}      ~${totalTokens.toLocaleString()} consumed`);
  console.log(`  ${pc.bold('Knowledge')}   +${kbDelta.added} entries (${kbDelta.total} total)`);

  if (investigatorSummary && investigatorSummary.investigations > 0) {
    const invTokens = investigatorSummary.promptTokens + investigatorSummary.completionTokens;
    console.log(`  ${pc.bold('Investigator')} ${investigatorSummary.investigations} triggered, ${investigatorSummary.healed} healed (~${invTokens.toLocaleString()} tokens)`);
  }

  if (budgetSummary.roundDeltas.length > 0) {
    console.log('');
    console.log(`  ${pc.dim('Per-round tokens:')}`);
    for (const d of budgetSummary.roundDeltas) {
      const bar = compactTokenBar(d.tokens, budgetSummary.hardLimit);
      console.log(`    R${d.round} ${d.area.padEnd(24).slice(0, 24)} ${bar} ${d.tokens.toLocaleString().padStart(8)}`);
    }
  }

  if (stopReason) {
    console.log('');
    console.log(`  ${pc.yellow('Stopped:')} ${stopReason}`);
  }

  // ── Branches to review ────────────────────────────────────────────
  const branchesToReview = roundResults.filter(r => r.branchName && r.verdict === 'approve');
  if (branchesToReview.length > 0) {
    console.log('');
    console.log(`  ${pc.bold(pc.green('Branches ready to merge:'))}`);
    for (const r of branchesToReview) {
      console.log(`    ${pc.green('>')} git merge ${r.branchName}`);
    }
  }

  const branchesForReview = roundResults.filter(r => r.branchName && r.verdict === 'revise');
  if (branchesForReview.length > 0) {
    console.log('');
    console.log(`  ${pc.bold(pc.yellow('Branches needing revision:'))}`);
    for (const r of branchesForReview) {
      console.log(`    ${pc.yellow('~')} git diff ${baseBranch}...${r.branchName}`);
    }
  }

  console.log('');
  console.log(hr);
  console.log(`  ${pc.dim('Report:')} ${mdPath}`);
  console.log(`  ${pc.dim('Data:')}   ${jsonPath}`);
  console.log(dhr);
  console.log('');
}

// ── Entry ───────────────────────────────────────────────────────────────────

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  // Save interrupted session state so it can be resumed
  try {
    const cfg = loadHydraConfig();
    const baseBranch = cfg.evolve?.baseBranch || 'dev';
    const projectRoot = process.cwd();
    const pCfg = resolveProject({ project: projectRoot });
    const evolveDir = path.join(pCfg.coordDir, 'evolve');
    const existingState = loadSessionState(evolveDir);
    if (existingState && existingState.status === 'running') {
      existingState.status = 'interrupted';
      existingState.resumable = true;
      existingState.actionNeeded = `Interrupted: ${err.message}. Resume with :evolve resume`;
      existingState.interruptedAt = Date.now();
      saveSessionState(evolveDir, existingState);
      log.warn('Session state saved as interrupted — resume with :evolve resume');
    }
  } catch { /* best effort */ }
  // Always try to get back to base branch
  try {
    const cfg = loadHydraConfig();
    const baseBranch = cfg.evolve?.baseBranch || 'dev';
    const projectRoot = process.cwd();
    const branch = getCurrentBranch(projectRoot);
    if (branch !== baseBranch && branch.startsWith('evolve/')) {
      checkoutBranch(projectRoot, baseBranch);
    }
  } catch { /* last resort */ }
  process.exit(1);
});
