#!/usr/bin/env node
/**
 * Hydra Operator Console (hydra:go)
 *
 * One-terminal command center for dispatching prompts to Gemini/Codex/Claude.
 * Dispatch is recorded as Hydra handoffs so each agent can pull with hydra:next.
 * Supports modes: auto (mini-round triage), handoff (direct), council (full deliberation).
 *
 * Usage:
 *   node hydra-operator.mjs prompt="Investigate auth deadlock"
 *   node hydra-operator.mjs              # interactive mode
 *   node hydra-operator.mjs mode=dispatch prompt="..."  # dispatch pipeline
 */

import readline from 'readline';
import path from 'path';
import { exec, spawn, spawnSync } from 'child_process';
import { getProjectContext } from './hydra-context.mjs';
import { getAgent, AGENT_NAMES, getActiveModel, getModelSummary, setActiveModel, getMode, setMode, resetAgentModel, getVerifier } from './hydra-agents.mjs';
import { checkUsage, renderUsageDashboard, renderUsageBar, formatTokens, getContingencyOptions, executeContingency } from './hydra-usage.mjs';
import { getSessionUsage, estimateFlowDuration } from './hydra-metrics.mjs';
import { resolveProject, HYDRA_ROOT, loadHydraConfig } from './hydra-config.mjs';
import {
  parseArgs,
  getPrompt,
  parseList,
  boolFlag,
  short,
  request,
  normalizeTask,
  classifyPrompt,
  generateSpec,
  modelCall,
} from './hydra-utils.mjs';
import {
  hydraSplash,
  hydraLogoCompact,
  renderDashboard,
  renderStatsDashboard,
  progressBar,
  agentBadge,
  label,
  sectionHeader,
  divider,
  colorAgent,
  createSpinner,
  extractTopic,
  phaseNarrative,
  SUCCESS,
  ERROR,
  WARNING,
  DIM,
  ACCENT,
  AGENT_COLORS,
  stripAnsi,
} from './hydra-ui.mjs';
import {
  initStatusBar,
  destroyStatusBar,
  drawStatusBar,
  startEventStream,
  stopEventStream,
  onActivityEvent,
  setAgentActivity,
  setLastDispatch,
  setActiveMode,
  setDispatchContext,
  clearDispatchContext,
  setAgentExecMode,
} from './hydra-statusbar.mjs';
import { AgentWorker } from './hydra-worker.mjs';
import {
  promptChoice,
  isChoiceActive,
  isAutoAccepting,
  setAutoAccept,
  resetAutoAccept,
} from './hydra-prompt-choice.mjs';
import {
  conciergeTurn,
  resetConversation,
  isConciergeAvailable,
  getConciergeStats,
  getConciergeConfig,
} from './hydra-concierge.mjs';
import pc from 'picocolors';

const config = resolveProject();
const DEFAULT_URL = process.env.AI_ORCH_URL || 'http://127.0.0.1:4173';

// ── Agent Workers (headless background execution) ────────────────────────────

const workers = new Map(); // agent -> AgentWorker

function startAgentWorker(agent, baseUrl, { rl } = {}) {
  const name = agent.toLowerCase();
  if (workers.has(name) && workers.get(name).status !== 'stopped') {
    return workers.get(name);
  }

  const worker = new AgentWorker(name, {
    baseUrl,
    projectRoot: config.projectRoot,
  });

  // Wire worker events to status bar
  worker.on('task:start', ({ agent: a, taskId, title }) => {
    setAgentActivity(a, 'working', title || 'Working', { taskTitle: title });
    drawStatusBar();
  });

  worker.on('task:complete', ({ agent: a, taskId, status, durationMs, outputSummary }) => {
    // Skip success notification for failed tasks — task:error handler covers those
    if (status === 'error') return;

    const elapsed = durationMs ? `${Math.round(durationMs / 1000)}s` : '';
    setAgentActivity(a, 'idle', `Done ${taskId}${elapsed ? ` (${elapsed})` : ''}`);
    drawStatusBar();

    // Show inline notification
    const icon = SUCCESS('\u2714');
    const msg = `  ${icon} ${colorAgent(a)} completed ${pc.white(taskId)}${elapsed ? ` ${DIM(`in ${elapsed}`)}` : ''}`;
    process.stdout.write(`\r\x1b[2K${msg}\n`);
    if (rl && !isChoiceActive()) {
      rl.prompt(true);
    }
  });

  worker.on('task:error', ({ agent: a, taskId, error }) => {
    setAgentActivity(a, 'error', `Error: ${(error || '').slice(0, 30)}`);
    drawStatusBar();

    const msg = `  ${ERROR('\u2717')} ${colorAgent(a)} error on ${pc.white(taskId || '?')}: ${DIM((error || '').slice(0, 60))}`;
    process.stdout.write(`\r\x1b[2K${msg}\n`);
    if (rl && !isChoiceActive()) {
      rl.prompt(true);
    }
  });

  worker.on('worker:idle', ({ agent: a }) => {
    setAgentActivity(a, 'idle', 'Awaiting next task');
    drawStatusBar();
  });

  worker.on('worker:stop', ({ agent: a, reason }) => {
    setAgentExecMode(a, null);
    setAgentActivity(a, 'inactive', 'Stopped');
    drawStatusBar();
  });

  setAgentExecMode(name, 'worker');
  worker.start();
  workers.set(name, worker);

  console.log(`  ${SUCCESS('\u2713')} ${colorAgent(name)} worker started ${DIM(`(${worker.permissionMode})`)}`);
  return worker;
}

function stopAgentWorker(agent) {
  const name = agent.toLowerCase();
  const worker = workers.get(name);
  if (!worker) return;
  worker.stop();
  setAgentExecMode(name, null);
}

function stopAllWorkers() {
  for (const [name, worker] of workers) {
    worker.kill();
    setAgentExecMode(name, null);
  }
  workers.clear();
}

function getWorkerStatus(agent) {
  const worker = workers.get(agent.toLowerCase());
  if (!worker) return null;
  return {
    agent: worker.agent,
    status: worker.status,
    currentTask: worker.currentTask,
    uptime: worker.uptime,
    permissionMode: worker.permissionMode,
  };
}

function startAgentWorkers(agentNames, baseUrl, opts = {}) {
  for (const agent of agentNames) {
    startAgentWorker(agent, baseUrl, opts);
  }
}

function formatUptime(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3600_000).toFixed(1)}h`;
}

// ── Daemon Auto-Start ────────────────────────────────────────────────────────

async function ensureDaemon(baseUrl, { quiet = false } = {}) {
  // Check if daemon is already running
  try {
    await request('GET', baseUrl, '/health');
    return true;
  } catch {
    // Not running — try to start it
  }

  if (!quiet) {
    process.stderr.write(`  ${DIM('\u2026')} Starting daemon...\n`);
  }

  const daemonScript = path.join(HYDRA_ROOT, 'lib', 'orchestrator-daemon.mjs');
  const child = spawn('node', [daemonScript, 'start'], {
    cwd: config.projectRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  // Wait for health (up to 8 seconds)
  for (let i = 0; i < 32; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      await request('GET', baseUrl, '/health');
      if (!quiet) {
        process.stderr.write(`  ${SUCCESS('\u2713')} Daemon started\n`);
      }
      return true;
    } catch {
      // keep waiting
    }
  }

  return false;
}

// ── Agent Terminal Auto-Launch ───────────────────────────────────────────────

/**
 * Detect pwsh or powershell on Windows. Returns exe path or null.
 */
function findPowerShell() {
  if (process.platform !== 'win32') return null;
  for (const cmd of ['pwsh', 'powershell']) {
    try {
      const result = spawnSync('where', [cmd], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
      const exe = (result.stdout || '').split('\n')[0].trim();
      if (exe) return exe;
    } catch { /* not found */ }
  }
  return null;
}

/**
 * Detect Windows Terminal (wt.exe). Returns exe path or null.
 */
function findWindowsTerminal() {
  if (process.platform !== 'win32') return null;
  try {
    const result = spawnSync('where', ['wt'], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
    const exe = (result.stdout || '').split('\n')[0].trim();
    if (exe) return exe;
  } catch { /* not found */ }
  return null;
}

/**
 * Spawn visible terminal windows running hydra-head.ps1 for each agent.
 * Uses -EncodedCommand to avoid escaping issues, and exec(start ...) for
 * reliable window visibility on Windows.
 */
function launchAgentTerminals(agentNames, baseUrl) {
  if (process.platform !== 'win32' || agentNames.length === 0) return;

  const shell = findPowerShell();
  if (!shell) {
    console.log(`  ${DIM('(skipping terminal launch — no PowerShell found)')}`);
    return;
  }

  const wt = findWindowsTerminal();
  const headScript = path.join(HYDRA_ROOT, 'bin', 'hydra-head.ps1');
  const cwd = config.projectRoot;
  const cwdEscaped = cwd.replace(/'/g, "''");

  for (const agent of agentNames) {
    const title = `Hydra Head - ${agent.toUpperCase()}`;
    const psCommand = [
      `Set-Location -LiteralPath '${cwdEscaped}'`,
      `& '${headScript}' -Agent ${agent} -Url '${baseUrl}'`,
    ].join('; ');

    // Encode as UTF-16LE base64 for -EncodedCommand (avoids all escaping issues)
    const encoded = Buffer.from(psCommand, 'utf16le').toString('base64');

    let cmd;
    if (wt) {
      // Windows Terminal: open a new tab in the current window
      cmd = `wt -w 0 new-tab --title "${title}" "${shell}" -NoExit -EncodedCommand ${encoded}`;
    } else {
      // Fallback: start command reliably opens a visible console window
      cmd = `start "${title}" "${shell}" -NoExit -EncodedCommand ${encoded}`;
    }
    exec(cmd, { cwd });

    const icon = { gemini: '\u2726', codex: '\u25B6', claude: '\u2666' }[agent] || '\u25CF';
    console.log(`  ${SUCCESS('\u2713')} ${colorAgent(agent, `${icon} ${agent}`)}  terminal launched`);
  }
}

/**
 * Extract unique agent names from auto/smart dispatch result.
 */
function extractHandoffAgents(result) {
  const handoffs = result?.published?.handoffs;
  if (!Array.isArray(handoffs) || handoffs.length === 0) return [];
  const seen = new Set();
  for (const h of handoffs) {
    const name = String(h.to || '').toLowerCase();
    if (name) seen.add(name);
  }
  return [...seen];
}

// ── Welcome Screen ───────────────────────────────────────────────────────────

async function printWelcome(baseUrl) {
  console.log(hydraSplash());
  console.log(label('Project', pc.white(config.projectName)));
  console.log(label('Root', DIM(config.projectRoot)));
  console.log(label('Daemon', DIM(baseUrl)));

  // Startup alert: check for in-progress tasks and pending handoffs
  try {
    const sessionStatus = await request('GET', baseUrl, '/session/status');
    if (sessionStatus.activeSession?.status === 'paused') {
      const reason = sessionStatus.activeSession.pauseReason;
      console.log(`  ${WARNING('\u23F8')} Session paused${reason ? `: "${reason}"` : ''} \u2014 type ${ACCENT(':unpause')} to resume`);
    }
    const inProgressCount = (sessionStatus.inProgressTasks || []).length;
    const handoffCount = (sessionStatus.pendingHandoffs || []).length;
    const staleCount = (sessionStatus.staleTasks || []).length;
    const parts = [];
    if (inProgressCount > 0) parts.push(`${inProgressCount} task${inProgressCount !== 1 ? 's' : ''} in progress`);
    if (handoffCount > 0) parts.push(`${handoffCount} handoff${handoffCount !== 1 ? 's' : ''} pending`);
    if (staleCount > 0) parts.push(`${staleCount} stale`);
    if (parts.length > 0) {
      console.log(`  ${WARNING('\u26A0')} ${parts.join(', ')} \u2014 type ${ACCENT(':resume')} for details`);
    }
  } catch { /* daemon may not have session data yet */ }

  // Mode & Models
  try {
    const models = getModelSummary();
    const currentMode = models._mode || getMode();
    console.log(label('Mode', ACCENT(currentMode)));
    const parts = [];
    for (const [agent, info] of Object.entries(models)) {
      if (agent === '_mode') continue;
      const colorFn = AGENT_COLORS[agent] || pc.white;
      const shortModel = (info.active || '').replace(/^claude-/, '').replace(/^gemini-/, '');
      const tag = info.isOverride ? pc.yellow(' *') : '';
      const eff = info.reasoningEffort ? pc.yellow(` ${info.reasoningEffort}`) : '';
      parts.push(`${colorFn(agent)}${DIM(':')}${pc.white(shortModel)}${eff}${tag}`);
    }
    console.log(label('Models', parts.join(DIM('  '))));
  } catch { /* skip */ }

  // Usage — show today's actual tokens from stats-cache
  try {
    const usage = checkUsage();
    if (usage.todayTokens > 0) {
      const modelShort = (usage.model || '').replace(/^claude-/, '').replace(/^gemini-/, '');
      console.log(label('Today', `${pc.white(formatTokens(usage.todayTokens))} tokens ${modelShort ? DIM(`(${modelShort})`) : ''}`));
    }
  } catch { /* skip */ }

  // Session token usage (from real Claude JSON output)
  try {
    const session = getSessionUsage();
    if (session.callCount > 0) {
      console.log(label('Session', `${pc.white(formatTokens(session.totalTokens))} tokens  ${pc.white('$' + session.costUsd.toFixed(4))}  ${DIM(`(${session.callCount} calls)`)}`));
    }
  } catch { /* skip */ }

  // Concierge availability
  if (isConciergeAvailable()) {
    const cCfg = getConciergeConfig();
    const cStatus = cCfg.autoActivate ? ACCENT('active') : DIM('available');
    console.log(label('Concierge', `${cStatus} ${DIM(`(${cCfg.model})`)}`));
  }

  console.log(divider());
  console.log('');
  console.log(pc.bold('  Quick commands:'));
  console.log(`    ${ACCENT(':help')}     ${DIM('all commands')}        ${ACCENT(':status')}   ${DIM('dashboard')}`);
  console.log(`    ${ACCENT(':model')}    ${DIM('active models')}       ${ACCENT(':usage')}    ${DIM('token budget')}`);
  console.log(`    ${ACCENT(':stats')}    ${DIM('agent metrics')}       ${ACCENT(':quit')}     ${DIM('exit')}`);
  console.log('');
  // Context-aware next steps on startup
  try {
    const sessionStatus = await request('GET', baseUrl, '/session/status');
    printNextSteps({
      agentSuggestions: sessionStatus.agentSuggestions,
      pendingHandoffs: sessionStatus.pendingHandoffs,
      staleTasks: sessionStatus.staleTasks,
      inProgressTasks: sessionStatus.inProgressTasks,
    });
  } catch {
    console.log(`  ${DIM('Type a prompt to dispatch, or :help for commands')}`);
  }
  console.log('');
}

function buildAgentMessage(agent, userPrompt) {
  const agentConfig = getAgent(agent);
  const rolePrompt = agentConfig ? agentConfig.rolePrompt : 'Contribute effectively to this objective.';
  const agentLabel = agentConfig ? agentConfig.label : agent.toUpperCase();

  return [
    `Hydra dispatch for ${agentLabel}:`,
    `Primary objective: ${userPrompt}`,
    '',
    rolePrompt,
    '',
    agent === 'codex' ? 'You will receive precise task specs. Execute efficiently and report what you changed.' : '',
    agent === 'gemini' ? 'Cite specific file paths and line numbers in all findings.' : '',
    agent === 'claude' ? 'Create detailed task specs for Codex (file paths, signatures, DoD) in your handoffs.' : '',
    '',
    'If blocked or unclear, ask direct questions immediately.',
    'When done with current chunk, create a Hydra handoff with exact next step.',
    '',
    getProjectContext(agent, {}, config),
  ].filter(Boolean).join('\n');
}

function buildMiniRoundBrief(agent, userPrompt, report) {
  const agentConfig = getAgent(agent);
  const tasks = Array.isArray(report?.tasks) ? report.tasks.map(normalizeTask).filter(Boolean) : [];
  const questions = Array.isArray(report?.questions) ? report.questions : [];
  const consensus = String(report?.consensus || '').trim();

  const myTasks = tasks.filter((task) => task.owner === agent || task.owner === 'unassigned');
  const myQuestions = questions.filter((q) => q && (q.to === agent || q.to === 'human'));

  const taskText =
    myTasks.length === 0
      ? '- No explicit task assigned. Start by proposing first concrete step.'
      : myTasks
          .map((task) => `- ${task.title}${task.done ? ` (DoD: ${task.done})` : ''}${task.rationale ? ` [${task.rationale}]` : ''}`)
          .join('\n');

  const questionText =
    myQuestions.length === 0
      ? '- none'
      : myQuestions
          .map((q) => {
            const to = String(q.to || 'human');
            const question = String(q.question || '').trim();
            return question ? `- to ${to}: ${question}` : null;
          })
          .filter(Boolean)
          .join('\n');

  return [
    `Hydra mini-round delegation for ${agentConfig ? agentConfig.label : agent.toUpperCase()}.`,
    '',
    agentConfig ? agentConfig.rolePrompt : '',
    '',
    getProjectContext(agent, {}, config),
    '',
    `Objective: ${userPrompt}`,
    `Recommendation: ${report?.recommendedMode || 'handoff'} (${report?.recommendationRationale || 'n/a'})`,
    `Consensus: ${consensus || 'No explicit consensus text.'}`,
    'Assigned tasks:',
    taskText,
    'Open questions:',
    questionText,
    'Next step: execute first task and publish milestone/blocker via Hydra handoff.',
  ].filter(Boolean).join('\n');
}

/**
 * Cross-model verification: route producer output to a paired verifier agent.
 * Returns { approved, issues, suggestions } or null if verification is skipped/fails.
 */
function runCrossVerification(producerAgent, producerOutput, originalPrompt, specContent = null) {
  const cfg = loadHydraConfig();
  const cvConfig = cfg.crossModelVerification;
  if (!cvConfig?.enabled) return null;

  const verifierAgent = getVerifier(producerAgent);
  if (verifierAgent === producerAgent) return null;

  const reviewPrompt = [
    'You are reviewing another AI agent\'s output for correctness and completeness.',
    '',
    `Original objective: ${originalPrompt}`,
    specContent ? `\nAnchoring specification:\n${specContent}\n` : '',
    `Producer agent: ${producerAgent}`,
    `Producer output:\n${producerOutput}`,
    '',
    'Review this output and return JSON only:',
    '{',
    '  "approved": true|false,',
    '  "issues": ["string"],',
    '  "suggestions": ["string"]',
    '}',
    '',
    'Focus on: correctness, completeness, missed edge cases, and adherence to the original objective.',
  ].filter(Boolean).join('\n');

  try {
    const result = modelCall(verifierAgent, reviewPrompt, 60_000, { cwd: config.projectRoot });
    if (!result.ok) return null;

    let parsed = null;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      // Try extracting JSON from response
      const match = result.stdout.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch { /* give up */ }
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
function shouldCrossVerify(classification) {
  const cfg = loadHydraConfig();
  const cvConfig = cfg.crossModelVerification;
  if (!cvConfig?.enabled) return false;
  if (cvConfig.mode === 'always') return true;
  if (cvConfig.mode === 'on-complex') return classification.tier === 'complex';
  return false;
}

async function publishMiniRoundDelegation({ baseUrl, from, agents, promptText, report }) {
  const normalizedTasks = (Array.isArray(report?.tasks) ? report.tasks : []).map(normalizeTask).filter(Boolean);
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
    const created = await request('POST', baseUrl, '/task/add', {
      title: task.title,
      owner: task.owner,
      status: 'todo',
      notes: task.rationale ? `Mini-round rationale: ${task.rationale}` : '',
    });
    createdTasks.push(created.task);
  }

  const decision = await request('POST', baseUrl, '/decision', {
    title: `Hydra Mini Round: ${short(promptText, 90)}`,
    owner: from,
    rationale: short(report?.consensus || 'Mini-round completed without explicit consensus.', 600),
    impact: `recommended=${report?.recommendedMode || 'handoff'}; tasks=${createdTasks.length}`,
  });

  const handoffs = [];
  for (const agent of agents) {
    const agentTaskIds = createdTasks.filter((task) => task.owner === agent || task.owner === 'unassigned').map((task) => task.id);
    const summary = buildMiniRoundBrief(agent, promptText, report);
    const handoff = await request('POST', baseUrl, '/handoff', {
      from,
      to: agent,
      summary,
      nextStep: 'Acknowledge and execute top-priority delegated task.',
      tasks: agentTaskIds,
    });
    handoffs.push(handoff.handoff);
  }

  return {
    decision: decision.decision,
    tasks: createdTasks,
    handoffs,
  };
}

async function dispatchPrompt({ baseUrl, from, agents, promptText }) {
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
    const result = await request('POST', baseUrl, '/handoff', payload);
    records.push({
      agent,
      handoffId: result?.handoff?.id || null,
      summary,
    });
  }
  return records;
}

async function publishFastPathDelegation({ baseUrl, from, promptText, classification, agents = null }) {
  const { taskType } = classification;
  let { suggestedAgent } = classification;

  // If agents filter provided and suggestedAgent is excluded, pick best from allowed list
  if (agents && agents.length > 0 && !agents.includes(suggestedAgent)) {
    let best = agents[0];
    let bestScore = 0;
    for (const a of agents) {
      const cfg = getAgent(a);
      const score = cfg?.taskAffinity?.[taskType] || 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = a;
      }
    }
    suggestedAgent = best;
  }

  const task = await request('POST', baseUrl, '/task/add', {
    title: short(promptText, 200),
    owner: suggestedAgent,
    status: 'todo',
    type: taskType,
    notes: `Fast-path dispatch (confidence=${classification.confidence}, reason: ${classification.reason})`,
  });

  const summary = buildAgentMessage(suggestedAgent, promptText);
  const handoff = await request('POST', baseUrl, '/handoff', {
    from,
    to: suggestedAgent,
    summary,
    nextStep: 'Start work and report first milestone via hydra:handoff.',
    tasks: task.task?.id ? [task.task.id] : [],
  });

  return {
    task: task.task,
    handoff: handoff.handoff,
    agent: suggestedAgent,
  };
}

/**
 * Spawn a child process asynchronously, collecting stdout/stderr.
 * Unlike spawnSync, this does NOT block the event loop, so status bar
 * polling and redraws continue while the subprocess runs.
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts]
 * @param {Function} [onProgress] - Called with parsed JSON progress markers from stderr
 */
function spawnAsync(cmd, args, opts = {}, onProgress = null) {
  return new Promise((resolve) => {
    const chunks = { stdout: [], stderr: [] };
    let stderrBuf = '';
    const child = spawn(cmd, args, {
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
        stderrBuf += d;
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop(); // keep incomplete last line
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed[0] !== '{') continue;
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.type === 'council_phase') onProgress(parsed);
          } catch { /* not a progress marker */ }
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

async function runCouncilPrompt({ baseUrl, promptText, rounds = 2, preview = false, onProgress = null, agents = null }) {
  const councilScript = path.join(HYDRA_ROOT, 'lib', 'hydra-council.mjs');
  const args = [councilScript, `prompt=${promptText}`, `url=${baseUrl}`, `rounds=${rounds}`];
  if (preview) {
    args.push('mode=preview', 'publish=false');
  } else {
    args.push('publish=true');
  }
  if (agents && agents.length > 0) {
    args.push(`agents=${agents.join(',')}`);
  }

  const result = await spawnAsync('node', args, { cwd: config.projectRoot }, onProgress);

  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

async function runCouncilJson({ baseUrl, promptText, rounds = 1, preview = false, publish = false, onProgress = null, agents = null }) {
  const councilScript = path.join(HYDRA_ROOT, 'lib', 'hydra-council.mjs');
  const args = [
    councilScript,
    `prompt=${promptText}`,
    `url=${baseUrl}`,
    `rounds=${rounds}`,
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

  const result = await spawnAsync('node', args, { cwd: config.projectRoot }, onProgress);

  if (result.status !== 0) {
    return {
      ok: false,
      status: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      report: null,
    };
  }

  try {
    const parsed = JSON.parse(result.stdout || '{}');
    return {
      ok: true,
      status: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      report: parsed.report || null,
    };
  } catch (error) {
    return {
      ok: false,
      status: result.status,
      stdout: result.stdout || '',
      stderr: `Failed to parse council JSON: ${error.message}`,
      report: null,
    };
  }
}

async function runAutoPrompt({ baseUrl, from, agents, promptText, miniRounds, councilRounds, preview, onProgress = null }) {
  // Fast-path: classify locally before running expensive council mini-round
  const classification = classifyPrompt(promptText);

  if (classification.tier === 'simple' && !preview) {
    const published = await publishFastPathDelegation({
      baseUrl,
      from,
      promptText,
      classification,
      agents,
    });

    return {
      mode: 'fast-path',
      recommended: 'handoff',
      route: `fast-path \u2192 ${published.agent} (${classification.taskType}, ${classification.confidence} confidence)`,
      classification,
      triage: null,
      published: {
        tasks: [published.task],
        handoffs: [published.handoff],
      },
      escalatedToCouncil: false,
    };
  }

  const triage = await runCouncilJson({
    baseUrl,
    promptText,
    rounds: miniRounds,
    preview,
    publish: false,
    onProgress,
    agents,
  });

  if (!triage.ok || !triage.report) {
    throw new Error(triage.stderr || triage.stdout || `Mini-round exited with status ${triage.status}`);
  }

  const recommended = String(triage.report.recommendedMode || 'handoff').toLowerCase();
  if (preview) {
    return {
      mode: 'preview',
      recommended,
      route: classification.tier === 'complex' ? 'council (complex prompt)' : 'mini-round triage \u2192 preview',
      classification,
      triage: triage.report,
      published: null,
      escalatedToCouncil: recommended === 'council',
    };
  }

  // Generate spec for complex prompts to anchor downstream work
  let spec = null;
  if (classification.tier === 'complex') {
    try {
      spec = generateSpec(promptText, null, { cwd: config.projectRoot });
    } catch { /* non-critical */ }
  }

  if (recommended === 'council' || classification.tier === 'complex') {
    const council = await runCouncilPrompt({
      baseUrl,
      promptText,
      rounds: councilRounds,
      preview: false,
      onProgress,
      agents,
    });
    if (!council.ok) {
      throw new Error(council.stderr || council.stdout || `Council exited with status ${council.status}`);
    }
    // Cross-model verification on council output
    let verification = null;
    if (shouldCrossVerify(classification) && council.stdout) {
      verification = runCrossVerification('claude', council.stdout.trim(), promptText, spec?.specContent);
    }

    return {
      mode: 'council',
      recommended,
      route: 'council (escalated)',
      classification,
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
    promptText,
    report: triage.report,
  });

  return {
    mode: 'handoff',
    recommended,
    route: 'mini-round triage \u2192 delegated',
    classification,
    triage: triage.report,
    published,
    escalatedToCouncil: false,
  };
}

// ── Smart Mode: auto-select model tier per prompt ───────────────────────────

const SMART_TIER_MAP = {
  simple: 'economy',
  medium: 'balanced',
  complex: 'performance',
};

async function runSmartPrompt({ baseUrl, from, agents, promptText, miniRounds, councilRounds, preview, onProgress = null }) {
  const classification = classifyPrompt(promptText);
  const targetMode = SMART_TIER_MAP[classification.tier] || 'balanced';

  // Save current mode to restore after dispatch
  const previousMode = getMode();

  try {
    // Temporarily switch to the tier-appropriate model preset
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

    // Annotate result with smart routing info
    result.smartTier = classification.tier;
    result.smartMode = targetMode;
    result.route = `${classification.tier}\u2192${result.route}`;

    // Update status bar dispatch info
    setLastDispatch({
      route: `${classification.tier}\u2192${result.mode === 'fast-path' ? (result.published?.handoffs?.[0]?.to || classification.suggestedAgent || 'agent') : result.mode}`,
      tier: classification.tier,
      agent: result.mode === 'fast-path' ? (classification.suggestedAgent || '') : '',
      mode: 'smart',
    });

    return result;
  } finally {
    // Restore previous mode
    try {
      setMode(previousMode);
    } catch { /* ignore */ }
  }
}

async function printStatus(baseUrl, agents) {
  const summary = await request('GET', baseUrl, '/summary');
  const agentNextMap = {};
  for (const agent of agents) {
    try {
      const next = await request('GET', baseUrl, `/next?agent=${encodeURIComponent(agent)}`);
      agentNextMap[agent] = next.next;
    } catch { agentNextMap[agent] = { action: 'unknown' }; }
  }
  console.log('');
  console.log(renderDashboard(summary.summary, agentNextMap));
  printNextSteps({ agentSuggestions: agentNextMap, summary: summary.summary });
}

/**
 * Print actionable suggested next steps based on current daemon state.
 * Shows concrete commands the user can type at the hydra> prompt.
 */
function printNextSteps({ agentSuggestions, pendingHandoffs, staleTasks, inProgressTasks, summary } = {}) {
  const steps = [];

  // Derive counts from summary if available
  const openTasks = summary?.openTasks ?? 0;
  const handoffCount = pendingHandoffs?.length ?? summary?.pendingHandoffs ?? 0;
  const staleCount = staleTasks?.length ?? 0;
  const inProgressCount = inProgressTasks?.length ?? 0;
  const hasPendingWork = handoffCount > 0 || staleCount > 0 || inProgressCount > 0;

  // If there's pending work that needs resuming
  if (hasPendingWork) {
    const parts = [];
    if (handoffCount > 0) parts.push(`${handoffCount} handoff${handoffCount > 1 ? 's' : ''}`);
    if (staleCount > 0) parts.push(`${staleCount} stale`);
    if (inProgressCount > 0) parts.push(`${inProgressCount} in progress`);
    steps.push(`${ACCENT(':resume')}    ${DIM(`Ack handoffs & launch agents (${parts.join(', ')})`)}`);
  }

  // If there are open tasks but agents are idle, suggest status check
  if (openTasks > 0 && !hasPendingWork) {
    steps.push(`${ACCENT(':status')}    ${DIM(`Review ${openTasks} open task${openTasks > 1 ? 's' : ''}`)}`);
  }

  // Always offer dispatching new work
  if (openTasks === 0 && !hasPendingWork) {
    steps.push(`${ACCENT('<your objective>')}  ${DIM('Type a prompt to dispatch work to agents')}`);
    steps.push(`${ACCENT(':mode council')}     ${DIM('Switch to council mode for complex objectives')}`);
  } else {
    steps.push(`${ACCENT('<your objective>')}  ${DIM('Dispatch additional work to agents')}`);
  }

  if (steps.length > 0) {
    console.log('');
    console.log(sectionHeader('Try next'));
    for (const step of steps.slice(0, 4)) {
      console.log(`  ${DIM('>')} ${step}`);
    }
    console.log('');
  }
}

function printHelp() {
  console.log('');
  console.log(hydraLogoCompact());
  console.log(DIM('  Operator Console'));
  console.log('');
  console.log(pc.bold('Interactive commands:'));
  console.log(`  ${ACCENT(':help')}                 Show help`);
  console.log(`  ${ACCENT(':status')}               Dashboard with agents & tasks`);
  console.log(`  ${ACCENT(':mode auto')}            Mini-round triage then delegate/escalate`);
  console.log(`  ${ACCENT(':mode smart')}           Auto-select model tier per prompt complexity`);
  console.log(`  ${ACCENT(':mode handoff')}         Direct handoffs (fast, no triage)`);
  console.log(`  ${ACCENT(':mode council')}         Full council deliberation`);
  console.log(`  ${ACCENT(':mode dispatch')}        Headless pipeline (Claude\u2192Gemini\u2192Codex)`);
  console.log(`  ${ACCENT(':model')}                Show mode & active models`);
  console.log(`  ${ACCENT(':model mode=economy')} Switch global mode`);
  console.log(`  ${ACCENT(':model claude=sonnet')} Override agent model`);
  console.log(`  ${ACCENT(':model reset')}         Clear all overrides`);
  console.log(`  ${ACCENT(':model:select')}         Interactive model picker`);
  console.log(`  ${ACCENT(':usage')}                Token usage & contingencies`);
  console.log(`  ${ACCENT(':stats')}                Agent metrics & performance`);
  console.log(`  ${ACCENT(':resume')}               Ack handoffs, reset stale tasks, launch agents`);
  console.log(`  ${ACCENT(':pause [reason]')}       Pause the active session`);
  console.log(`  ${ACCENT(':unpause')}              Resume a paused session`);
  console.log(`  ${ACCENT(':fork')}                 Fork current session (explore alternatives)`);
  console.log(`  ${ACCENT(':spawn <focus>')}       Spawn child session (fresh context)`);
  console.log('');
  console.log(pc.bold('Task & handoff management:'));
  console.log(`  ${ACCENT(':tasks')}                List active tasks`);
  console.log(`  ${ACCENT(':handoffs')}             List pending & recent handoffs`);
  console.log(`  ${ACCENT(':cancel <id>')}          Cancel a task (e.g. :cancel T003)`);
  console.log(`  ${ACCENT(':clear')}                Cancel all tasks & ack all handoffs`);
  console.log(`  ${ACCENT(':clear tasks')}          Cancel all open tasks`);
  console.log(`  ${ACCENT(':clear handoffs')}       Ack all pending handoffs`);
  console.log(`  ${ACCENT(':archive')}              Archive completed work & trim events`);
  console.log(`  ${ACCENT(':events')}               Show recent event log`);
  console.log('');
  console.log(pc.bold('Workers:'));
  console.log(`  ${ACCENT(':workers')}              Show worker status (running/idle/stopped)`);
  console.log(`  ${ACCENT(':workers start [agent]')} Start worker(s)`);
  console.log(`  ${ACCENT(':workers stop [agent]')}  Stop worker(s)`);
  console.log(`  ${ACCENT(':workers restart')}      Restart all workers`);
  console.log(`  ${ACCENT(':workers mode <mode>')}  Change permission mode (auto-edit/full-auto)`);
  console.log(`  ${ACCENT(':watch <agent>')}        Open visible terminal for agent observation`);
  console.log('');
  console.log(pc.bold('Concierge (conversational AI):'));
  console.log(`  ${ACCENT(':chat')}                 Toggle concierge on/off`);
  console.log(`  ${ACCENT(':chat off')}             Disable concierge`);
  console.log(`  ${ACCENT(':chat reset')}           Clear conversation history`);
  console.log(`  ${ACCENT(':chat stats')}           Show token usage`);
  console.log(`  ${ACCENT('!<prompt>')}             Force dispatch (bypass concierge)`);
  console.log('');
  console.log(pc.bold('Evolve (autonomous self-improvement):'));
  console.log(`  ${ACCENT(':evolve')}               Launch evolve session (research\u2192plan\u2192test\u2192implement)`);
  console.log(`  ${ACCENT(':evolve focus=<area>')}  Focus on specific area (e.g. testing-reliability)`);
  console.log(`  ${ACCENT(':evolve max-rounds=N')} Limit rounds (default: 3)`);
  console.log(`  ${ACCENT(':evolve status')}        Show latest evolve session report`);
  console.log(`  ${ACCENT(':evolve resume')}        Resume an incomplete/interrupted session`);
  console.log(`  ${ACCENT(':evolve knowledge')}     Browse accumulated knowledge base`);
  console.log('');
  console.log(pc.bold('System:'));
  console.log(`  ${ACCENT(':confirm')}              Show/toggle dispatch confirmations`);
  console.log(`  ${ACCENT(':shutdown')}             Stop the daemon`);
  console.log(`  ${ACCENT(':quit')}                 Exit operator console  ${DIM('(alias: :exit)')}`);
  console.log(`  ${DIM('<any text>')}             Dispatch as shared prompt`);
  console.log('');
  console.log(pc.bold('One-shot mode:'));
  console.log(DIM('  npm run hydra:go -- prompt="Your objective"'));
  console.log(DIM('  npm run hydra:go -- mode=council prompt="Your objective"'));
  console.log('');
}

async function interactiveLoop({
  baseUrl,
  from,
  agents,
  initialMode,
  councilRounds,
  councilPreview,
  autoMiniRounds,
  autoCouncilRounds,
  autoPreview,
  showWelcome,
}) {
  let mode = initialMode;
  let conciergeActive = false;
  const cCfg = getConciergeConfig();
  if (cCfg.autoActivate && isConciergeAvailable()) conciergeActive = true;

  if (showWelcome) {
    await printWelcome(baseUrl);
  } else {
    printHelp();
    console.log(label('Mode', ACCENT(mode)));
    console.log('');
  }
  const conciergePrompt = `${ACCENT('hydra')}${pc.blue('\u2B22')}${DIM('>')} `;
  const normalPrompt = `${ACCENT('hydra')}${DIM('>')} `;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: conciergeActive ? conciergePrompt : normalPrompt,
  });

  // ── Ghost Text (greyed-out placeholder, Claude Code CLI style) ────────────
  // Shows dim hint text after the prompt cursor. Disappears on first keystroke.
  // Re-appears on blank line submissions or after command completion.
  let _ghostCleanup = null;

  const GHOST_HINTS_CONCIERGE = [
    () => `Chat with ${getConciergeConfig().model} — prefix ! to dispatch`,
    () => 'Ask a question or describe what you need',
    () => `Talking to ${getConciergeConfig().model} — :chat off to disable`,
    () => 'What would you like to work on?',
  ];
  const GHOST_HINTS_NORMAL = [
    () => 'Describe a task to dispatch to agents',
    () => ':help for commands, or type a prompt',
    () => 'What would you like to work on?',
  ];
  let _ghostIdx = 0;

  function getGhostText() {
    const pool = conciergeActive ? GHOST_HINTS_CONCIERGE : GHOST_HINTS_NORMAL;
    const text = pool[_ghostIdx % pool.length]();
    _ghostIdx++;
    return text;
  }

  function showGhostAfterPrompt() {
    if (!process.stdout.isTTY) return;
    const text = getGhostText();
    if (!text) return;
    const plain = stripAnsi(text);
    // Write dim ghost text, then move cursor back to prompt end
    process.stdout.write(DIM(text));
    if (plain.length > 0) {
      process.stdout.write(`\x1b[${plain.length}D`);
    }
    // One-shot: clear ghost text on first keystroke
    if (_ghostCleanup) {
      process.stdin.removeListener('data', _ghostCleanup);
      _ghostCleanup = null;
    }
    _ghostCleanup = () => {
      process.stdout.write('\x1b[K'); // Erase from cursor to end of line
      process.stdin.removeListener('data', _ghostCleanup);
      _ghostCleanup = null;
    };
    process.stdin.on('data', _ghostCleanup);
  }

  // Wrap rl.prompt to auto-show ghost text on fresh prompts (not refreshes)
  const _origPrompt = rl.prompt.bind(rl);
  rl.prompt = function (preserveCursor) {
    _origPrompt(preserveCursor);
    if (!preserveCursor) {
      showGhostAfterPrompt();
    }
  };

  initStatusBar(agents);
  setActiveMode(conciergeActive ? 'chat' : mode);
  startEventStream(baseUrl, agents);

  // Subscribe to significant activity events and show them inline
  onActivityEvent(({ event, agent, detail }) => {
    const significant = ['handoff_ack', 'task_done', 'verify'];
    if (!significant.includes(event)) return;
    const prefix = event === 'verify' ? WARNING('\u2691') : SUCCESS('\u2714');
    const msg = `  ${prefix} ${DIM(event.replace(/_/g, ' '))}${agent ? ` ${colorAgent(agent)}` : ''} ${DIM(detail || '')}`;
    // Clear current prompt line, print event, re-show prompt
    process.stdout.write(`\r\x1b[2K${msg}\n`);
    // Don't flash normal prompt while a choice selection is active
    if (!isChoiceActive()) {
      rl.prompt(true);
    }
  });

  rl.prompt();

  rl.on('line', async (lineRaw) => {
    const line = String(lineRaw || '').trim();

    try {
      if (!line) {
        rl.prompt();
        return;
      }
      if (line === ':quit' || line === ':exit') {
        rl.close();
        return;
      }
      if (line === ':help') {
        printHelp();
        rl.prompt();
        return;
      }
      if (line === ':status') {
        await printStatus(baseUrl, agents);
        rl.prompt();
        return;
      }
      if (line === ':usage') {
        const usage = checkUsage();
        console.log(renderUsageDashboard(usage));
        // Append real session Claude usage when available
        try {
          const session = getSessionUsage();
          if (session.callCount > 0) {
            const d = DIM;
            const lines = [];
            lines.push(sectionHeader('Session Claude Usage'));
            lines.push(label('Input tokens', pc.white(formatTokens(session.inputTokens))));
            lines.push(label('Output tokens', pc.white(formatTokens(session.outputTokens))));
            lines.push(label('Total tokens', pc.white(formatTokens(session.totalTokens))));
            if (session.cacheCreationTokens > 0 || session.cacheReadTokens > 0) {
              lines.push(label('Cache create', pc.white(formatTokens(session.cacheCreationTokens))));
              lines.push(label('Cache read', pc.white(formatTokens(session.cacheReadTokens))));
            }
            lines.push(label('Cost', pc.white('$' + session.costUsd.toFixed(4))));
            lines.push(label('Calls', pc.white(String(session.callCount))));
            lines.push('');
            console.log(lines.join('\n'));
          }
        } catch { /* skip */ }
        rl.prompt();
        return;
      }
      if (line === ':stats') {
        try {
          const statsData = await request('GET', baseUrl, '/stats');
          console.log(renderStatsDashboard(statsData.metrics, statsData.usage));
        } catch {
          // Fallback to just usage if daemon is down
          const usage = checkUsage();
          console.log(renderStatsDashboard(null, usage));
        }
        rl.prompt();
        return;
      }
      if (line === ':resume') {
        try {
          const sessionStatus = await request('GET', baseUrl, '/session/status');
          console.log('');
          console.log(sectionHeader('Resuming'));

          // Session info
          const sess = sessionStatus.activeSession;
          if (sess?.status === 'paused') {
            try {
              await request('POST', baseUrl, '/session/unpause');
              console.log(`  ${SUCCESS('\u2713')} Session unpaused`);
            } catch (e) {
              console.log(`  ${WARNING('\u26A0')} Could not unpause: ${e.message}`);
            }
          }

          // Stale tasks — reset to todo so they can be re-claimed
          const stale = sessionStatus.staleTasks || [];
          if (stale.length > 0) {
            console.log('');
            for (const t of stale) {
              try {
                await request('POST', baseUrl, '/task/update', { taskId: t.id, status: 'todo' });
                const mins = Math.round((Date.now() - new Date(t.updatedAt).getTime()) / 60_000);
                console.log(`  ${WARNING('\u21BB')} ${pc.white(t.id)} ${colorAgent(t.owner)} reset to todo ${DIM(`(was stale ${mins}m)`)}`);
              } catch { /* skip */ }
            }
          }

          // Pending handoffs — ack them and collect agents to launch
          const handoffs = sessionStatus.pendingHandoffs || [];
          const agentsToLaunch = new Set();
          if (handoffs.length > 0) {
            console.log('');
            for (const h of handoffs) {
              const targetAgent = String(h.to || '').toLowerCase();
              try {
                await request('POST', baseUrl, '/handoff/ack', { handoffId: h.id, agent: targetAgent });
                console.log(`  ${SUCCESS('\u2713')} ${pc.white(h.id)} ${colorAgent(h.from)}\u2192${colorAgent(h.to)} acknowledged`);
                if (targetAgent) agentsToLaunch.add(targetAgent);
              } catch (e) {
                console.log(`  ${ERROR('\u2717')} ${pc.white(h.id)} ${e.message}`);
              }
            }
          }

          // In-progress tasks — collect those agents too
          const inProgress = sessionStatus.inProgressTasks || [];
          for (const t of inProgress) {
            const owner = String(t.owner || '').toLowerCase();
            if (owner) agentsToLaunch.add(owner);
          }

          // Also check agent suggestions for claimable work
          for (const [agent, suggestion] of Object.entries(sessionStatus.agentSuggestions || {})) {
            const action = suggestion?.action || '';
            if (action !== 'idle' && action !== 'unknown') {
              agentsToLaunch.add(agent);
            }
          }

          // Start workers for all agents with work
          const launchList = [...agentsToLaunch].filter((a) => agents.includes(a));
          if (launchList.length > 0) {
            console.log('');
            startAgentWorkers(launchList, baseUrl, { rl });
          }

          // Summary
          const actions = [];
          if (stale.length > 0) actions.push(`${stale.length} stale task${stale.length > 1 ? 's' : ''} reset`);
          if (handoffs.length > 0) actions.push(`${handoffs.length} handoff${handoffs.length > 1 ? 's' : ''} acked`);
          if (launchList.length > 0) actions.push(`${launchList.length} agent${launchList.length > 1 ? 's' : ''} launched`);

          if (actions.length > 0) {
            console.log('');
            console.log(`  ${SUCCESS('\u2713')} ${actions.join(', ')}`);
          } else {
            console.log(`  ${DIM('Nothing to resume — dispatch a new objective to get started')}`);
          }

          console.log('');
        } catch (e) {
          console.log(`  ${ERROR(e.message)}`);
        }
        rl.prompt();
        return;
      }
      if (line === ':pause' || line.startsWith(':pause ')) {
        const reason = line.slice(':pause'.length).trim();
        try {
          await request('POST', baseUrl, '/session/pause', { reason });
          console.log(`  ${SUCCESS('\u2713')} Session paused${reason ? `: "${reason}"` : ''}`);
        } catch (e) {
          console.log(`  ${ERROR(e.message)}`);
        }
        rl.prompt();
        return;
      }
      if (line === ':unpause') {
        try {
          await request('POST', baseUrl, '/session/resume', {});
          console.log(`  ${SUCCESS('\u2713')} Session resumed`);
        } catch (e) {
          console.log(`  ${ERROR(e.message)}`);
        }
        rl.prompt();
        return;
      }
      if (line === ':model' || line.startsWith(':model ')) {
        const modelArgs = line.slice(':model'.length).trim();
        if (modelArgs) {
          // Handle "reset" — clear all overrides
          if (modelArgs === 'reset') {
            setMode(getMode());
            console.log(`  ${SUCCESS('\u2713')} All agent overrides cleared, following mode ${ACCENT(getMode())}`);
            rl.prompt();
            return;
          }
          // Parse "mode=economy" or "claude=sonnet gemini=flash" style
          const pairs = modelArgs.split(/\s+/);
          for (const pair of pairs) {
            const eqIdx = pair.indexOf('=');
            if (eqIdx > 0) {
              const key = pair.slice(0, eqIdx).toLowerCase();
              const value = pair.slice(eqIdx + 1);
              if (key === 'mode') {
                try {
                  setMode(value);
                  console.log(`  ${SUCCESS('\u2713')} Mode ${DIM('\u2192')} ${ACCENT(value)}`);
                } catch (e) {
                  console.log(`  ${ERROR(e.message)}`);
                }
              } else if (AGENT_NAMES.includes(key)) {
                if (value === 'default') {
                  const resolved = resetAgentModel(key);
                  console.log(`  ${SUCCESS('\u2713')} ${pc.bold(key)} ${DIM('\u2192')} ${pc.white(resolved)} ${DIM('(following mode)')}`);
                } else {
                  const resolved = setActiveModel(key, value);
                  console.log(`  ${SUCCESS('\u2713')} ${pc.bold(key)} ${DIM('\u2192')} ${pc.white(resolved)}`);
                }
              } else {
                console.log(`  ${ERROR('Unknown key:')} ${key}`);
              }
            }
          }
        } else {
          const summary = getModelSummary();
          const currentMode = summary._mode || getMode();
          console.log('');
          console.log(`  ${pc.bold('Mode:')} ${ACCENT(currentMode)}`);
          for (const [agent, info] of Object.entries(summary)) {
            if (agent === '_mode') continue;
            const model = info.isOverride ? pc.white(info.active) : DIM(info.active);
            const tag = info.isOverride ? WARNING('(override)') : DIM(`(${info.tierSource})`);
            const effort = info.reasoningEffort ? pc.yellow(` [${info.reasoningEffort}]`) : '';
            console.log(`  ${colorAgent(agent)}  ${model}${effort} ${tag}`);
          }
          console.log('');
          console.log(DIM(`  Set mode:  :model mode=economy`));
          console.log(DIM(`  Override:  :model codex=gpt-5.3`));
          console.log(DIM(`  Reset all: :model reset`));
          console.log(DIM(`  Reset one: :model codex=default`));
          console.log(DIM(`  Browse:    :model:select [agent]`));
        }
        rl.prompt();
        return;
      }
      if (line === ':model:select' || line.startsWith(':model:select ')) {
        const selectArg = line.slice(':model:select'.length).trim();
        const pickerArgs = [path.join(HYDRA_ROOT, 'lib', 'hydra-models-select.mjs')];
        if (selectArg && AGENT_NAMES.includes(selectArg.toLowerCase())) {
          pickerArgs.push(selectArg.toLowerCase());
        }
        // Hand terminal control to the interactive picker subprocess
        rl.pause();
        destroyStatusBar();
        spawnSync('node', pickerArgs, { stdio: 'inherit', windowsHide: true });
        initStatusBar(agents);
        rl.resume();
        rl.prompt();
        return;
      }
      if (line === ':fork' || line.startsWith(':fork ')) {
        const reason = line.slice(':fork'.length).trim();
        try {
          const result = await request('POST', baseUrl, '/session/fork', { reason });
          console.log(`  ${SUCCESS('\u2713')} Session forked: ${pc.white(result.session.id)}`);
          if (reason) console.log(`  ${DIM('Reason:')} ${reason}`);
        } catch (e) {
          console.log(`  ${ERROR(e.message)}`);
        }
        rl.prompt();
        return;
      }
      if (line.startsWith(':spawn ')) {
        const focus = line.slice(':spawn '.length).trim();
        if (!focus) {
          console.log(`  ${ERROR('Usage: :spawn <focus description>')}`);
          rl.prompt();
          return;
        }
        try {
          const result = await request('POST', baseUrl, '/session/spawn', { focus });
          console.log(`  ${SUCCESS('\u2713')} Child session spawned: ${pc.white(result.session.id)}`);
          console.log(`  ${DIM('Focus:')} ${focus}`);
        } catch (e) {
          console.log(`  ${ERROR(e.message)}`);
        }
        rl.prompt();
        return;
      }
      if (line === ':mode') {
        console.log(label('Mode', ACCENT(mode)));
        console.log(DIM(`  Switch: :mode auto | smart | handoff | council | dispatch`));
        rl.prompt();
        return;
      }
      if (line.startsWith(':mode ')) {
        const nextMode = line.slice(':mode '.length).trim().toLowerCase();
        if (!['auto', 'handoff', 'council', 'dispatch', 'smart'].includes(nextMode)) {
          console.log('Invalid mode. Use :mode auto, :mode handoff, :mode council, :mode dispatch, or :mode smart');
          rl.prompt();
          return;
        }
        mode = nextMode;
        setActiveMode(mode);
        console.log(label('Mode', ACCENT(mode)));
        drawStatusBar();
        rl.prompt();
        return;
      }

      // ── Confirmation Toggle ──────────────────────────────────────────────
      if (line === ':confirm' || line.startsWith(':confirm ')) {
        const arg = line.slice(':confirm'.length).trim().toLowerCase();
        if (arg === 'off') {
          setAutoAccept(true);
          console.log(`  ${SUCCESS('\u2713')} Confirmations ${DIM('disabled')} (auto-accepting all prompts)`);
        } else if (arg === 'on') {
          setAutoAccept(false);
          console.log(`  ${SUCCESS('\u2713')} Confirmations ${ACCENT('enabled')}`);
        } else {
          const state = isAutoAccepting() ? DIM('off (auto-accepting)') : ACCENT('on');
          console.log(label('Confirmations', state));
          console.log(DIM(`  Toggle: :confirm on | :confirm off`));
        }
        rl.prompt();
        return;
      }

      // ── Task & Handoff Management ─────────────────────────────────────────
      if (line === ':clear' || line.startsWith(':clear ')) {
        const what = line.slice(':clear'.length).trim().toLowerCase() || 'all';
        // Destructive confirmation gate
        const clearConfirm = await promptChoice(rl, {
          title: 'Confirm Clear',
          context: { Scope: what === 'all' ? 'all tasks & handoffs' : what, Warning: 'This cannot be undone' },
          choices: [
            { label: 'Yes, proceed', value: 'yes', hint: `clear ${what}` },
            { label: 'No, cancel', value: 'no', hint: 'abort' },
          ],
          defaultValue: 'yes',
        });
        if (clearConfirm.value === 'no') {
          console.log(`  ${DIM('Cancelled.')}`);
          rl.prompt();
          return;
        }
        try {
          const { state } = await request('GET', baseUrl, '/state');
          let ackedCount = 0;
          let cancelledCount = 0;

          if (what === 'all' || what === 'handoffs') {
            const pending = state.handoffs.filter((h) => !h.acknowledgedAt);
            for (const h of pending) {
              const agent = String(h.to || 'human').toLowerCase();
              await request('POST', baseUrl, '/handoff/ack', { handoffId: h.id, agent });
              ackedCount++;
            }
          }

          if (what === 'all' || what === 'tasks') {
            const open = state.tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress');
            for (const t of open) {
              await request('POST', baseUrl, '/task/update', { taskId: t.id, status: 'cancelled' });
              cancelledCount++;
            }
          }

          const parts = [];
          if (ackedCount > 0) parts.push(`${ackedCount} handoff${ackedCount > 1 ? 's' : ''} acked`);
          if (cancelledCount > 0) parts.push(`${cancelledCount} task${cancelledCount > 1 ? 's' : ''} cancelled`);
          console.log(parts.length > 0
            ? `  ${SUCCESS('\u2713')} ${parts.join(', ')}`
            : `  ${DIM('Nothing to clear')}`);
        } catch (e) {
          console.log(`  ${ERROR(e.message)}`);
        }
        rl.prompt();
        return;
      }

      if (line.startsWith(':cancel ')) {
        const id = line.slice(':cancel '.length).trim().toUpperCase();
        try {
          const result = await request('POST', baseUrl, '/task/update', { taskId: id, status: 'cancelled' });
          console.log(`  ${SUCCESS('\u2713')} ${pc.white(result.task.id)} cancelled ${DIM(result.task.title)}`);
        } catch (e) {
          console.log(`  ${ERROR(e.message)}`);
        }
        rl.prompt();
        return;
      }

      if (line === ':tasks') {
        try {
          const { state } = await request('GET', baseUrl, '/state');
          const active = state.tasks.filter((t) => t.status !== 'cancelled' && t.status !== 'done');
          if (active.length === 0) {
            console.log(`  ${DIM('No active tasks')}`);
          } else {
            console.log('');
            console.log(sectionHeader(`Tasks (${active.length})`));
            for (const t of active) {
              const statusIcon = t.status === 'in_progress' ? WARNING('\u25CF') : DIM('\u25CB');
              console.log(`  ${statusIcon} ${pc.white(t.id)} ${colorAgent(t.owner)} ${t.title} ${DIM(t.status)}`);
            }
            console.log('');
          }
        } catch (e) {
          console.log(`  ${ERROR(e.message)}`);
        }
        rl.prompt();
        return;
      }

      if (line === ':handoffs') {
        try {
          const { state } = await request('GET', baseUrl, '/state');
          const pending = state.handoffs.filter((h) => !h.acknowledgedAt);
          const recent = state.handoffs.filter((h) => h.acknowledgedAt).slice(-5);
          if (pending.length === 0 && recent.length === 0) {
            console.log(`  ${DIM('No handoffs')}`);
          } else {
            if (pending.length > 0) {
              console.log('');
              console.log(sectionHeader(`Pending handoffs (${pending.length})`));
              for (const h of pending) {
                console.log(`  ${WARNING('\u25CF')} ${pc.white(h.id)} ${colorAgent(h.from)}\u2192${colorAgent(h.to)} ${DIM(short(h.summary, 50))}`);
              }
            }
            if (recent.length > 0) {
              console.log('');
              console.log(sectionHeader('Recent handoffs'));
              for (const h of recent) {
                console.log(`  ${SUCCESS('\u2713')} ${pc.white(h.id)} ${colorAgent(h.from)}\u2192${colorAgent(h.to)} ${DIM(short(h.summary, 50))}`);
              }
            }
            console.log('');
          }
        } catch (e) {
          console.log(`  ${ERROR(e.message)}`);
        }
        rl.prompt();
        return;
      }

      if (line === ':archive') {
        try {
          const result = await request('POST', baseUrl, '/state/archive');
          console.log(`  ${SUCCESS('\u2713')} Archived: ${result.moved.tasks} tasks, ${result.moved.handoffs} handoffs, ${result.moved.blockers} blockers${result.eventsTrimmed ? `, ${result.eventsTrimmed} events trimmed` : ''}`);
        } catch (e) {
          console.log(`  ${ERROR(e.message)}`);
        }
        rl.prompt();
        return;
      }

      if (line === ':events') {
        try {
          const result = await request('GET', baseUrl, '/events');
          const events = result.events || [];
          if (events.length === 0) {
            console.log(`  ${DIM('No events')}`);
          } else {
            console.log('');
            console.log(sectionHeader(`Recent events (${events.length})`));
            for (const e of events.slice(-15)) {
              const time = e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : '';
              const agent = e.agent ? ` ${colorAgent(e.agent)}` : '';
              console.log(`  ${DIM(time)}${agent} ${e.event || e.type || 'unknown'} ${DIM(e.detail || e.taskId || '')}`);
            }
            console.log('');
          }
        } catch (e) {
          console.log(`  ${ERROR(e.message)}`);
        }
        rl.prompt();
        return;
      }

      if (line === ':shutdown') {
        const shutdownConfirm = await promptChoice(rl, {
          title: 'Confirm Shutdown',
          context: { Warning: 'This will stop the daemon and all agent activity' },
          choices: [
            { label: 'Yes, proceed', value: 'yes', hint: 'stop the daemon' },
            { label: 'No, cancel', value: 'no', hint: 'abort' },
          ],
          defaultValue: 'yes',
        });
        if (shutdownConfirm.value === 'no') {
          console.log(`  ${DIM('Cancelled.')}`);
          rl.prompt();
          return;
        }
        stopAllWorkers();
        try {
          await request('POST', baseUrl, '/shutdown');
          console.log(`  ${SUCCESS('\u2713')} Daemon shutting down`);
        } catch (e) {
          console.log(`  ${ERROR(e.message)}`);
        }
        rl.close();
        return;
      }

      // ── Worker Commands ──────────────────────────────────────────────────
      if (line === ':workers' || line.startsWith(':workers ')) {
        const workerArgs = line.slice(':workers'.length).trim().toLowerCase();

        if (!workerArgs) {
          // Show status of all workers
          console.log('');
          console.log(sectionHeader('Agent Workers'));
          if (workers.size === 0) {
            console.log(`  ${DIM('No workers running. Dispatch a prompt to start workers.')}`);
          } else {
            for (const [name, w] of workers) {
              const statusIcon = w.status === 'working' ? WARNING('\u25CF')
                : w.status === 'idle' ? SUCCESS('\u25CB')
                : w.status === 'error' ? ERROR('\u25CF')
                : DIM('\u25CB');
              const task = w.currentTask ? `${pc.white(w.currentTask.taskId)} ${DIM(short(w.currentTask.title, 40))}` : DIM('no task');
              const up = w.uptime > 0 ? DIM(`  up ${formatUptime(w.uptime)}`) : '';
              const perm = DIM(`  (${w.permissionMode})`);
              console.log(`  ${statusIcon} ${colorAgent(name)} ${pc.white(w.status)}  ${task}${up}${perm}`);
            }
          }
          console.log('');
          console.log(DIM('  :workers start [agent]   Start worker(s)'));
          console.log(DIM('  :workers stop [agent]    Stop worker(s)'));
          console.log(DIM('  :workers restart [agent] Restart worker(s)'));
          console.log(DIM('  :workers mode <mode>     Change permission mode'));
          console.log('');
          rl.prompt();
          return;
        }

        const parts = workerArgs.split(/\s+/);
        const subCmd = parts[0];
        const targetAgent = parts[1] || null;

        if (subCmd === 'start') {
          const toStart = targetAgent ? [targetAgent] : agents;
          for (const a of toStart) {
            if (!agents.includes(a)) {
              console.log(`  ${ERROR('Unknown agent:')} ${a}`);
              continue;
            }
            startAgentWorker(a, baseUrl, { rl });
          }
        } else if (subCmd === 'stop') {
          const toStop = targetAgent ? [targetAgent] : [...workers.keys()];
          for (const a of toStop) {
            stopAgentWorker(a);
            console.log(`  ${SUCCESS('\u2713')} ${colorAgent(a)} worker stopped`);
          }
        } else if (subCmd === 'restart') {
          const toRestart = targetAgent ? [targetAgent] : [...workers.keys()];
          for (const a of toRestart) {
            stopAgentWorker(a);
            startAgentWorker(a, baseUrl, { rl });
          }
        } else if (subCmd === 'mode') {
          const newMode = parts[1];
          if (!newMode || !['auto-edit', 'full-auto'].includes(newMode)) {
            console.log(`  ${ERROR('Usage:')} :workers mode auto-edit | full-auto`);
          } else {
            for (const [, w] of workers) {
              w.setPermissionMode(newMode);
            }
            console.log(`  ${SUCCESS('\u2713')} Worker permission mode ${DIM('\u2192')} ${ACCENT(newMode)}`);
          }
        } else {
          console.log(`  ${ERROR('Unknown subcommand:')} ${subCmd}`);
          console.log(`  ${DIM('Usage: :workers [start|stop|restart|mode] [agent]')}`);
        }

        rl.prompt();
        return;
      }

      if (line.startsWith(':watch ')) {
        const watchAgent = line.slice(':watch '.length).trim().toLowerCase();
        if (!watchAgent || !agents.includes(watchAgent)) {
          console.log(`  ${ERROR('Usage:')} :watch <agent>  (${agents.join(', ')})`);
          rl.prompt();
          return;
        }
        setAgentExecMode(watchAgent, 'terminal');
        launchAgentTerminals([watchAgent], baseUrl);
        console.log(`  ${DIM('Terminal opened for observation. Worker continues running in background.')}`);
        rl.prompt();
        return;
      }

      // ── Concierge (Chat) Commands ─────────────────────────────────────────
      if (line === ':chat' || line.startsWith(':chat ')) {
        const chatArg = line.slice(':chat'.length).trim().toLowerCase();

        if (chatArg === 'off') {
          conciergeActive = false;
          setActiveMode(mode);
          rl.setPrompt(normalPrompt);
          console.log(`  ${SUCCESS('\u2713')} Concierge ${DIM('disabled')}`);
          drawStatusBar();
        } else if (chatArg === 'reset') {
          resetConversation();
          console.log(`  ${SUCCESS('\u2713')} Conversation history cleared`);
        } else if (chatArg === 'stats') {
          const cStats = getConciergeStats();
          const cCfg = getConciergeConfig();
          console.log('');
          console.log(sectionHeader('Concierge Stats'));
          console.log(label('Model', pc.white(cCfg.model)));
          console.log(label('Reasoning', pc.white(cCfg.reasoningEffort)));
          console.log(label('Turns', pc.white(String(cStats.turns))));
          console.log(label('Prompt tokens', pc.white(String(cStats.promptTokens))));
          console.log(label('Completion tokens', pc.white(String(cStats.completionTokens))));
          console.log(label('Total tokens', pc.white(String(cStats.promptTokens + cStats.completionTokens))));
          console.log('');
        } else {
          // Toggle
          if (!isConciergeAvailable()) {
            console.log(`  ${ERROR('Concierge unavailable')} — set ${ACCENT('OPENAI_API_KEY')} environment variable`);
            rl.prompt();
            return;
          }
          conciergeActive = !conciergeActive;
          if (conciergeActive) {
            setActiveMode('chat');
            rl.setPrompt(conciergePrompt);
            console.log(`  ${SUCCESS('\u2713')} Concierge ${ACCENT('enabled')} ${DIM(`(${getConciergeConfig().model})`)}`);
          } else {
            setActiveMode(mode);
            rl.setPrompt(normalPrompt);
            console.log(`  ${SUCCESS('\u2713')} Concierge ${DIM('disabled')}`);
          }
          drawStatusBar();
        }

        rl.prompt();
        return;
      }

      // ── Evolve Commands ──────────────────────────────────────────────────
      if (line === ':evolve' || line.startsWith(':evolve ')) {
        const evolveArg = line.slice(':evolve'.length).trim().toLowerCase();

        if (evolveArg === 'status') {
          // Show latest evolve report
          const reviewScript = path.join(HYDRA_ROOT, 'lib', 'hydra-evolve-review.mjs');
          const child = spawn('node', [reviewScript, 'status'], {
            cwd: config.projectRoot,
            stdio: 'inherit',
            shell: process.platform === 'win32',
          });
          child.on('close', () => { rl.prompt(); });
        } else if (evolveArg === 'knowledge') {
          const reviewScript = path.join(HYDRA_ROOT, 'lib', 'hydra-evolve-review.mjs');
          const child = spawn('node', [reviewScript, 'knowledge'], {
            cwd: config.projectRoot,
            stdio: 'inherit',
            shell: process.platform === 'win32',
          });
          child.on('close', () => { rl.prompt(); });
        } else if (evolveArg === 'resume' || evolveArg.startsWith('resume ')) {
          // Resume incomplete/interrupted evolve session
          const extraArgs = evolveArg.slice('resume'.length).trim();
          const cfg = loadHydraConfig();
          const baseBranch = cfg.evolve?.baseBranch || 'dev';
          const cwd = config.projectRoot;

          // Same pre-flight as regular :evolve
          const curBranch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
          if (curBranch !== baseBranch) {
            const branchExists = spawnSync('git', ['rev-parse', '--verify', baseBranch], { cwd, encoding: 'utf8' }).status === 0;
            if (!branchExists) {
              console.log(`  ${ACCENT(`Creating '${baseBranch}' branch from '${curBranch}'...`)}`);
              spawnSync('git', ['branch', baseBranch], { cwd });
            }
            console.log(`  ${ACCENT(`Switching from '${curBranch}' to '${baseBranch}'...`)}`);
            const sw = spawnSync('git', ['checkout', baseBranch], { cwd, encoding: 'utf8' });
            if (sw.status !== 0) {
              console.log(`  ${ERROR(`Failed to switch branch: ${(sw.stderr || '').trim()}`)}`);
              rl.prompt();
              return;
            }
          }

          const status = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).stdout.trim();
          if (status) {
            const confirm = await promptChoice(rl, {
              message: 'Working tree is not clean. Auto-commit before evolve resume?',
              choices: [
                { label: 'Yes \u2014 commit all changes', value: 'yes' },
                { label: 'No \u2014 abort', value: 'no' },
              ],
              defaultIndex: 0,
              timeout: 30_000,
            });
            if (confirm.value !== 'yes') {
              console.log(`  ${WARNING('Aborted \u2014 commit or stash changes first.')}`);
              rl.prompt();
              return;
            }
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            spawnSync('git', ['add', '-A'], { cwd });
            spawnSync('git', ['commit', '-m', `chore: auto-commit before evolve session ${ts}`], { cwd });
            console.log(`  ${SUCCESS('\u2713')} Changes committed.`);
          }

          console.log(`  ${ACCENT('Resuming evolve session...')}`);
          const evolveScript = path.join(HYDRA_ROOT, 'lib', 'hydra-evolve.mjs');
          const evolveArgs = [evolveScript, `project=${cwd}`, 'resume=1'];
          if (extraArgs) {
            evolveArgs.push(...extraArgs.split(/\s+/).filter(Boolean));
          }
          const child = spawn('node', evolveArgs, {
            cwd,
            stdio: 'inherit',
            shell: process.platform === 'win32',
          });
          child.on('close', (code) => {
            if (code === 0) {
              console.log(`  ${SUCCESS('\u2713')} Evolve session complete`);
            } else {
              console.log(`  ${ERROR(`Evolve exited with code ${code}`)}`);
            }
            rl.prompt();
          });
        } else {
          // Launch evolve session — pre-flight: branch switch + auto-commit
          const cfg = loadHydraConfig();
          const baseBranch = cfg.evolve?.baseBranch || 'dev';
          const cwd = config.projectRoot;

          // Switch to base branch if needed (create it if it doesn't exist)
          const curBranch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
          if (curBranch !== baseBranch) {
            // Check if base branch exists
            const branchExists = spawnSync('git', ['rev-parse', '--verify', baseBranch], { cwd, encoding: 'utf8' }).status === 0;
            if (!branchExists) {
              console.log(`  ${ACCENT(`Creating '${baseBranch}' branch from '${curBranch}'...`)}`);
              spawnSync('git', ['branch', baseBranch], { cwd });
            }
            console.log(`  ${ACCENT(`Switching from '${curBranch}' to '${baseBranch}'...`)}`);
            const sw = spawnSync('git', ['checkout', baseBranch], { cwd, encoding: 'utf8' });
            if (sw.status !== 0) {
              console.log(`  ${ERROR(`Failed to switch branch: ${(sw.stderr || '').trim()}`)}`);
              rl.prompt();
              return;
            }
          }

          // Auto-commit dirty working tree
          const status = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).stdout.trim();
          if (status) {
            const confirm = await promptChoice(rl, {
              message: 'Working tree is not clean. Auto-commit before evolve?',
              choices: [
                { label: 'Yes \u2014 commit all changes', value: 'yes' },
                { label: 'No \u2014 abort', value: 'no' },
              ],
              defaultIndex: 0,
              timeout: 30_000,
            });
            if (confirm.value !== 'yes') {
              console.log(`  ${WARNING('Aborted \u2014 commit or stash changes first.')}`);
              rl.prompt();
              return;
            }
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            spawnSync('git', ['add', '-A'], { cwd });
            spawnSync('git', ['commit', '-m', `chore: auto-commit before evolve session ${ts}`], { cwd });
            console.log(`  ${SUCCESS('\u2713')} Changes committed.`);
          }

          console.log(`  ${ACCENT('Launching evolve session...')}`);
          const evolveScript = path.join(HYDRA_ROOT, 'lib', 'hydra-evolve.mjs');
          const evolveArgs = [evolveScript, `project=${cwd}`];
          if (evolveArg) {
            evolveArgs.push(...evolveArg.split(/\s+/).filter(Boolean));
          }
          const child = spawn('node', evolveArgs, {
            cwd,
            stdio: 'inherit',
            shell: process.platform === 'win32',
          });
          child.on('close', (code) => {
            if (code === 0) {
              console.log(`  ${SUCCESS('\u2713')} Evolve session complete`);
            } else {
              console.log(`  ${ERROR(`Evolve exited with code ${code}`)}`);
            }
            rl.prompt();
          });
        }
        return;
      }

      // Catch unrecognized : commands — route to concierge for suggestion if active
      if (line.startsWith(':')) {
        if (conciergeActive) {
          // Let the concierge suggest the correct command
          const cCfg = getConciergeConfig();
          process.stdout.write(`\n  ${pc.blue('\u2B22')} ${DIM(cCfg.model)}\n  `);
          try {
            const hint = `The user typed "${line}" which is not a recognized command. Suggest the correct command.`;
            await conciergeTurn(hint, {
              context: { projectName: config.projectName, mode },
              onChunk: (chunk) => { process.stdout.write(pc.blue(chunk)); },
            });
            process.stdout.write('\n\n');
          } catch {
            console.log(`  ${ERROR('Unknown command:')} ${line}`);
            console.log(`  ${DIM('Type :help for available commands')}`);
          }
        } else {
          console.log(`  ${ERROR('Unknown command:')} ${line}`);
          console.log(`  ${DIM('Type :help for available commands')}`);
        }
        rl.prompt();
        return;
      }

      // ── Force-dispatch escape hatch (bypass concierge with ! prefix) ────
      let dispatchLine = line;
      if (conciergeActive && line.startsWith('!')) {
        dispatchLine = line.slice(1).trim();
        if (!dispatchLine) {
          rl.prompt();
          return;
        }
        // Fall through to normal dispatch with the cleaned prompt
      }
      // ── Concierge Intercept ────────────────────────────────────────────
      else if (conciergeActive && !line.startsWith(':')) {
        const cCfg = getConciergeConfig();
        // Gather live system state for the system prompt
        let context = { projectName: config.projectName, mode };
        try {
          const models = getModelSummary();
          const agentModels = {};
          for (const [agent, info] of Object.entries(models)) {
            if (agent === '_mode') continue;
            agentModels[agent] = info.active || 'unknown';
          }
          context.agentModels = agentModels;
        } catch { /* skip */ }
        try {
          const sessionStatus = await request('GET', baseUrl, '/session/status');
          context.openTasks = (sessionStatus.inProgressTasks || []).length + ((sessionStatus.pendingHandoffs || []).length);
        } catch {
          context.openTasks = 0;
        }

        // Print concierge header
        process.stdout.write(`\n  ${pc.blue('\u2B22')} ${DIM(cCfg.model)}\n  `);

        try {
          const result = await conciergeTurn(line, {
            context,
            onChunk: (chunk) => {
              process.stdout.write(pc.blue(chunk));
            },
          });
          process.stdout.write('\n\n');

          if (result.intent === 'dispatch') {
            console.log(`  ${ACCENT('\u2192')} Routing to dispatch: ${DIM(result.dispatchPrompt.slice(0, 80))}${result.dispatchPrompt.length > 80 ? '...' : ''}`);
            console.log('');
            // Temporarily disable concierge visual, dispatch the cleaned prompt
            dispatchLine = result.dispatchPrompt;
            // Fall through to normal dispatch below
          } else {
            // Chat response already streamed
            rl.prompt();
            return;
          }
        } catch (err) {
          process.stdout.write('\n');
          console.log(`  ${ERROR('Concierge error:')} ${err.message}`);
          // Auto-disable on auth failures
          if (err.status === 401 || err.status === 403) {
            conciergeActive = false;
            setActiveMode(mode);
            rl.setPrompt(normalPrompt);
            console.log(`  ${DIM('Concierge auto-disabled due to auth error')}`);
          }
          rl.prompt();
          return;
        }
      }

      if (mode === 'auto' || mode === 'smart') {
        const classification = classifyPrompt(dispatchLine);
        const topic = extractTopic(dispatchLine);

        // Pre-dispatch gate: show classification and let user confirm/modify
        const routeDesc = classification.tier === 'simple'
          ? `fast-path \u2192 ${classification.suggestedAgent}`
          : classification.tier === 'complex'
            ? 'council deliberation'
            : 'mini-round triage \u2192 delegated';
        const preDispatch = await promptChoice(rl, {
          title: 'Pre-dispatch Review',
          context: {
            Classification: `${classification.tier} (${classification.confidence} confidence)`,
            Route: routeDesc,
            Prompt: `"${short(dispatchLine, 60)}"`,
          },
          choices: [
            { label: 'Proceed', value: 'proceed', hint: `dispatch as ${classification.tier}` },
            { label: 'Proceed (auto-accept)', value: '__auto_accept__', hint: 'skip future confirmations' },
            { label: 'Cancel', value: 'cancel', hint: 'abort this dispatch' },
            { label: 'Respond', value: 'respond', hint: 'type custom instructions', freeform: true },
          ],
          defaultValue: 'proceed',
        });

        if (preDispatch.value === 'cancel') {
          console.log(`  ${DIM('Dispatch cancelled.')}`);
          rl.prompt();
          return;
        }

        // If freeform text was provided, use it as the prompt instead
        if (preDispatch.value !== 'proceed' && preDispatch.value !== 'cancel' && !preDispatch.autoAcceptAll && !preDispatch.timedOut) {
          dispatchLine = preDispatch.value;
          console.log(`  ${DIM('Dispatching with modified prompt:')}`);
          console.log(`  ${ACCENT(short(dispatchLine, 70))}`);
        }

        const COUNCIL_AGENTS = [{ agent: 'claude' }, { agent: 'gemini' }, { agent: 'claude' }, { agent: 'codex' }];
        const estMs = classification.tier === 'simple'
          ? estimateFlowDuration([{ agent: classification.suggestedAgent || 'claude' }])
          : estimateFlowDuration(COUNCIL_AGENTS, classification.tier === 'complex' ? autoCouncilRounds : autoMiniRounds);
        const smartLabel = mode === 'smart' ? `Smart (${classification.tier}\u2192${SMART_TIER_MAP[classification.tier] || 'balanced'}) ` : '';
        const spinner = classification.tier === 'simple'
          ? createSpinner(`${smartLabel}Fast-path \u2192 ${classification.suggestedAgent}`, { estimatedMs: estMs }).start()
          : createSpinner(`${smartLabel}Running ${classification.tier === 'complex' ? 'council deliberation' : 'mini-round triage'}`, { estimatedMs: estMs }).start();

        // Set dispatch context for status bar
        setDispatchContext({
          promptSummary: topic || short(dispatchLine, 30),
          topic,
          tier: classification.tier,
        });

        const onProgress = (evt) => {
          if (evt.action === 'start') {
            const narrative = phaseNarrative(evt.phase, evt.agent, topic);
            const prefix = classification.tier === 'complex' ? 'Council' : 'Mini-round';
            spinner.update(`${smartLabel}${prefix}: ${narrative} [${evt.step}/${evt.totalSteps}]`);
            setAgentActivity(evt.agent, 'working', narrative, { phase: evt.phase, step: `${evt.step}/${evt.totalSteps}` });
            drawStatusBar();
          }
        };
        let auto;
        try {
          const dispatchFn = mode === 'smart' ? runSmartPrompt : runAutoPrompt;
          auto = await dispatchFn({
            baseUrl,
            from,
            agents,
            promptText: dispatchLine,
            miniRounds: autoMiniRounds,
            councilRounds: autoCouncilRounds,
            preview: autoPreview,
            onProgress,
          });
          spinner.succeed(auto.mode === 'fast-path' ? `Fast-path dispatched to ${classification.suggestedAgent}` : `${auto.mode} complete`);
        } catch (e) {
          spinner.fail(e.message);
          clearDispatchContext();
          throw e;
        }

        // Post-dispatch: inject task titles into agent status lines
        if (auto.published?.tasks) {
          for (const task of auto.published.tasks) {
            const owner = String(task?.owner || '').toLowerCase();
            if (owner && agents.includes(owner)) {
              const title = String(task.title || '').slice(0, 40);
              if (title) {
                setAgentActivity(owner, 'idle', title, { taskTitle: title });
              }
            }
          }
        }

        clearDispatchContext();

        // Update status bar with dispatch info
        if (mode !== 'smart') {
          setLastDispatch({
            route: `${classification.tier}\u2192${auto.mode === 'fast-path' ? (classification.suggestedAgent || 'agent') : auto.mode}`,
            tier: classification.tier,
            agent: auto.mode === 'fast-path' ? (classification.suggestedAgent || '') : '',
            mode,
          });
        }
        console.log(sectionHeader(mode === 'smart' ? 'Smart Dispatch' : 'Auto Dispatch'));
        console.log(label('Route', auto.mode === 'fast-path' ? SUCCESS(auto.route) : ACCENT(auto.route || auto.recommended)));
        if (auto.smartTier) {
          console.log(label('Tier', `${ACCENT(auto.smartTier)} \u2192 ${DIM(auto.smartMode)} models`));
        }
        if (auto.triage) {
          console.log(label('Rationale', DIM(auto.triage.recommendationRationale || 'n/a')));
        }
        if (auto.escalatedToCouncil) {
          if (auto.councilOutput) {
            console.log(auto.councilOutput);
          }
        } else if (auto.published) {
          console.log(label('Tasks created', pc.white(String(auto.published.tasks.length))));
          console.log(label('Handoffs queued', pc.white(String(auto.published.handoffs.length))));
          const handoffAgents = extractHandoffAgents(auto);
          if (handoffAgents.length > 0) {
            const postDispatch = await promptChoice(rl, {
              title: 'Post-dispatch',
              context: {
                Tasks: `${auto.published.tasks.length} created`,
                Agents: handoffAgents.join(', '),
              },
              choices: [
                { label: 'Start workers', value: 'workers', hint: 'headless background execution (default)' },
                { label: 'Launch terminals', value: 'launch', hint: 'open visible terminal windows' },
                { label: 'Skip', value: 'skip', hint: 'tasks dispatched, no execution' },
              ],
              defaultValue: 'workers',
            });
            if (postDispatch.value === 'workers') {
              startAgentWorkers(handoffAgents, baseUrl, { rl });
            } else if (postDispatch.value === 'launch') {
              for (const a of handoffAgents) setAgentExecMode(a, 'terminal');
              launchAgentTerminals(handoffAgents, baseUrl);
            }
          }
        } else {
          console.log(label('Route', DIM('preview only')));
        }
      } else if (mode === 'council') {
        const councilTopic = extractTopic(dispatchLine);
        const COUNCIL_AGENTS_C = [{ agent: 'claude' }, { agent: 'gemini' }, { agent: 'claude' }, { agent: 'codex' }];
        const councilSpinner = createSpinner('Running council deliberation', { estimatedMs: estimateFlowDuration(COUNCIL_AGENTS_C, councilRounds) }).start();

        setDispatchContext({
          promptSummary: councilTopic || short(dispatchLine, 30),
          topic: councilTopic,
          tier: 'complex',
        });

        const council = await runCouncilPrompt({
          baseUrl,
          promptText: dispatchLine,
          rounds: councilRounds,
          preview: councilPreview,
          onProgress: (evt) => {
            if (evt.action === 'start') {
              const narrative = phaseNarrative(evt.phase, evt.agent, councilTopic);
              councilSpinner.update(`Council: ${narrative} [${evt.step}/${evt.totalSteps}]`);
              setAgentActivity(evt.agent, 'working', narrative, { phase: evt.phase, step: `${evt.step}/${evt.totalSteps}` });
              drawStatusBar();
            }
          },
        });

        clearDispatchContext();

        if (!council.ok) {
          councilSpinner.fail('Council failed');
          throw new Error(council.stderr || council.stdout || `Council exited with status ${council.status}`);
        }
        councilSpinner.succeed('Council completed');
        console.log(council.stdout.trim());
      } else if (mode === 'dispatch') {
        console.log('Dispatch mode: run `npm run hydra:go -- mode=dispatch prompt="..."` for headless pipeline.');
      } else {
        const handoffTopic = extractTopic(dispatchLine);
        const handoffSpinner = createSpinner('Dispatching to agents', { estimatedMs: 5_000 }).start();
        const records = await dispatchPrompt({
          baseUrl,
          from,
          agents,
          promptText: dispatchLine,
        });
        handoffSpinner.succeed('Dispatched');

        // Set agent status to prompt topic instead of bare "Handoff from human"
        for (const item of records) {
          const agentName = String(item.agent || '').toLowerCase();
          const title = handoffTopic || short(dispatchLine, 40);
          if (agentName && title) {
            setAgentActivity(agentName, 'idle', title, { taskTitle: title });
          }
        }

        console.log(sectionHeader('Dispatched'));
        for (const item of records) {
          console.log(`  ${agentBadge(item.agent)}  ${DIM('handoff=')}${pc.bold(item.handoffId || '?')}`);
        }
        const handoffAgents = records.map(r => String(r.agent).toLowerCase()).filter(Boolean);
        if (handoffAgents.length > 0) {
          startAgentWorkers(handoffAgents, baseUrl, { rl });
        }
      }
    } catch (error) {
      console.error(`Error: ${error.message}`);
    }

    drawStatusBar();
    rl.prompt();
  });

  rl.on('close', () => {
    if (_ghostCleanup) {
      process.stdin.removeListener('data', _ghostCleanup);
      _ghostCleanup = null;
    }
    resetAutoAccept();
    resetConversation();
    stopAllWorkers();
    stopEventStream();
    destroyStatusBar();
    console.log('Hydra operator console closed.');
    process.exit(0);
  });
}

async function main() {
  const { options, positionals } = parseArgs(process.argv);
  const baseUrl = String(options.url || DEFAULT_URL);
  const from = String(options.from || 'human').toLowerCase();
  const agents = parseList(options.agents || 'gemini,codex,claude');
  const mode = String(options.mode || 'auto').toLowerCase();
  const councilRounds = Math.max(1, Math.min(4, Number.parseInt(String(options.councilRounds || '2'), 10) || 2));
  const councilPreview = boolFlag(options.councilPreview, false);
  const autoMiniRounds = Math.max(1, Math.min(2, Number.parseInt(String(options.autoMiniRounds || '1'), 10) || 1));
  const autoCouncilRounds = Math.max(1, Math.min(4, Number.parseInt(String(options.autoCouncilRounds || String(councilRounds)), 10) || councilRounds));
  const autoPreview = boolFlag(options.autoPreview, false);
  const promptText = getPrompt(options, positionals);
  const interactive = !promptText;
  const showWelcome = boolFlag(options.welcome, interactive);

  // Auto-start daemon if not running
  const daemonOk = await ensureDaemon(baseUrl, { quiet: !interactive });
  if (!daemonOk) {
    console.error(`Hydra daemon unreachable at ${baseUrl}.`);
    console.error('Start manually: npm run hydra:start');
    process.exit(1);
  }

  if (interactive) {
    await interactiveLoop({
      baseUrl,
      from,
      agents,
      initialMode: mode,
      councilRounds,
      councilPreview,
      autoMiniRounds,
      autoCouncilRounds,
      autoPreview,
      showWelcome,
    });
    return;
  }

  if (mode === 'auto' || mode === 'smart') {
    const dispatchFn = mode === 'smart' ? runSmartPrompt : runAutoPrompt;
    const auto = await dispatchFn({
      baseUrl,
      from,
      agents,
      promptText,
      miniRounds: autoMiniRounds,
      councilRounds: autoCouncilRounds,
      preview: autoPreview,
    });
    console.log(sectionHeader(mode === 'smart' ? 'Smart Dispatch Complete' : 'Auto Dispatch Complete'));
    console.log(label('Route', auto.mode === 'fast-path' ? SUCCESS(auto.route) : ACCENT(auto.route || auto.recommended)));
    if (auto.smartTier) {
      console.log(label('Tier', `${ACCENT(auto.smartTier)} \u2192 ${DIM(auto.smartMode)} models`));
    }
    if (auto.triage) {
      console.log(label('Rationale', DIM(auto.triage.recommendationRationale || 'n/a')));
    }
    if (auto.escalatedToCouncil) {
      if (auto.councilOutput) {
        console.log(auto.councilOutput);
      }
    } else if (auto.published) {
      console.log(label('Tasks created', pc.white(String(auto.published.tasks.length))));
      console.log(label('Handoffs queued', pc.white(String(auto.published.handoffs.length))));
      const handoffAgents = extractHandoffAgents(auto);
      if (handoffAgents.length > 0) startAgentWorkers(handoffAgents, baseUrl);
    } else {
      console.log(label('Route', DIM('preview')));
    }
  } else if (mode === 'council') {
    const council = await runCouncilPrompt({
      baseUrl,
      promptText,
      rounds: councilRounds,
      preview: councilPreview,
    });
    if (!council.ok) {
      throw new Error(council.stderr || council.stdout || `Council exited with status ${council.status}`);
    }
    console.log(council.stdout.trim());
  } else if (mode === 'dispatch') {
    // Headless dispatch pipeline: spawn hydra-dispatch.mjs
    const dispatchScript = path.join(HYDRA_ROOT, 'lib', 'hydra-dispatch.mjs');
    const args = [dispatchScript, `prompt=${promptText}`, `url=${baseUrl}`];
    if (boolFlag(options.preview, false)) {
      args.push('mode=preview');
    }
    const result = spawnSync('node', args, {
      cwd: config.projectRoot,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 8,
      windowsHide: true,
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      process.exit(result.status || 1);
    }
  } else {
    const records = await dispatchPrompt({
      baseUrl,
      from,
      agents,
      promptText,
    });

    console.log(sectionHeader('Dispatch Complete'));
    for (const item of records) {
      console.log(`  ${agentBadge(item.agent)}  ${DIM('handoff=')}${pc.bold(item.handoffId || '?')}`);
    }
    const handoffAgents = records.map(r => String(r.agent).toLowerCase()).filter(Boolean);
    if (handoffAgents.length > 0) startAgentWorkers(handoffAgents, baseUrl);
  }
}

main().catch((error) => {
  console.error(`Hydra operator failed: ${error.message}`);
  process.exit(1);
});
