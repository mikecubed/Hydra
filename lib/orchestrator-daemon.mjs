#!/usr/bin/env node
/**
 * Orchestrator daemon for Codex + Claude + Gemini coordination.
 * Runs a local HTTP server that reads/writes the shared sync state.
 */

import fs from 'fs';
import http from 'http';
import path from 'path';
import { exec, execSync } from 'child_process';
import { getAgent, AGENTS, KNOWN_OWNERS, AGENT_NAMES, classifyTask, TASK_TYPES } from './hydra-agents.mjs';
import { hydraSplash, label as uiLabel, divider, SUCCESS, DIM, ERROR, ACCENT } from './hydra-ui.mjs';
import { resolveProject } from './hydra-config.mjs';
import { getMetricsSummary, persistMetrics, loadPersistedMetrics } from './hydra-metrics.mjs';
import { checkUsage } from './hydra-usage.mjs';
import pc from 'picocolors';

const config = resolveProject();

const COORD_DIR = config.coordDir;
const STATE_PATH = config.statePath;
const LOG_PATH = config.logPath;
const STATUS_PATH = config.statusPath;
const EVENTS_PATH = config.eventsPath;
const ARCHIVE_PATH = config.archivePath;

const DEFAULT_HOST = process.env.AI_ORCH_HOST || '127.0.0.1';
const DEFAULT_PORT = Number.parseInt(process.env.AI_ORCH_PORT || '4173', 10);
const ORCH_TOKEN = process.env.AI_ORCH_TOKEN || '';

const STATUS_VALUES = new Set(['todo', 'in_progress', 'blocked', 'done', 'cancelled']);
const KNOWN_AGENTS = KNOWN_OWNERS;

function nowIso() {
  return new Date().toISOString();
}

function toSessionId(date = new Date()) {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `SYNC_${yyyy}${mm}${dd}_${hh}${min}${ss}`;
}

function createAgentRecord() {
  return {
    installed: null,
    path: '',
    version: '',
    lastCheckedAt: null,
  };
}

function createDefaultState() {
  return {
    schemaVersion: 1,
    project: config.projectName,
    updatedAt: nowIso(),
    activeSession: null,
    agents: {
      codex: createAgentRecord(),
      claude: createAgentRecord(),
      gemini: createAgentRecord(),
    },
    tasks: [],
    decisions: [],
    blockers: [],
    handoffs: [],
  };
}

function normalizeState(raw) {
  const defaults = createDefaultState();
  const safe = raw && typeof raw === 'object' ? raw : {};

  return {
    ...defaults,
    ...safe,
    agents: {
      ...defaults.agents,
      ...(safe.agents || {}),
      codex: { ...defaults.agents.codex, ...(safe.agents?.codex || {}) },
      claude: { ...defaults.agents.claude, ...(safe.agents?.claude || {}) },
      gemini: { ...defaults.agents.gemini, ...(safe.agents?.gemini || {}) },
    },
    tasks: Array.isArray(safe.tasks) ? safe.tasks : [],
    decisions: Array.isArray(safe.decisions) ? safe.decisions : [],
    blockers: Array.isArray(safe.blockers) ? safe.blockers : [],
    handoffs: Array.isArray(safe.handoffs) ? safe.handoffs : [],
  };
}

function ensureCoordFiles() {
  if (!fs.existsSync(COORD_DIR)) {
    fs.mkdirSync(COORD_DIR, { recursive: true });
  }

  if (!fs.existsSync(STATE_PATH)) {
    const state = createDefaultState();
    fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  if (!fs.existsSync(LOG_PATH)) {
    const lines = ['# AI Sync Log', '', `Created: ${nowIso()}`, '', 'Use `npm run hydra:summary` to see current state.', ''];
    fs.writeFileSync(LOG_PATH, `${lines.join('\n')}\n`, 'utf8');
  }

  if (!fs.existsSync(EVENTS_PATH)) {
    fs.writeFileSync(EVENTS_PATH, '', 'utf8');
  }
}

function readState() {
  ensureCoordFiles();
  const raw = fs.readFileSync(STATE_PATH, 'utf8');
  return normalizeState(JSON.parse(raw));
}

function writeState(state) {
  const next = normalizeState(state);
  next.updatedAt = nowIso();
  if (next.activeSession?.status === 'active') {
    next.activeSession.updatedAt = next.updatedAt;
  }
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

function appendSyncLog(entry) {
  ensureCoordFiles();
  fs.appendFileSync(LOG_PATH, `- ${nowIso()} | ${entry}\n`, 'utf8');
}

function appendEvent(type, payload) {
  const line = JSON.stringify({
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    at: nowIso(),
    type,
    payload,
  });
  fs.appendFileSync(EVENTS_PATH, `${line}\n`, 'utf8');
}

function nextId(prefix, items) {
  let max = 0;
  const pattern = new RegExp(`^${prefix}(\\d+)$`);

  for (const item of items) {
    const match = String(item?.id || '').match(pattern);
    if (!match) {
      continue;
    }
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isFinite(parsed) && parsed > max) {
      max = parsed;
    }
  }

  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

function parseList(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return String(value)
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function runCommand(command) {
  try {
    return execSync(command, {
      cwd: config.projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function getCurrentBranch() {
  return runCommand('git branch --show-current') || 'unknown';
}

function ensureKnownStatus(status) {
  if (!STATUS_VALUES.has(status)) {
    throw new Error(`Invalid status "${status}".`);
  }
}

function ensureKnownAgent(agent, allowUnassigned = true) {
  const allowed = allowUnassigned ? KNOWN_AGENTS : new Set(['human', 'codex', 'claude', 'gemini']);
  if (!allowed.has(agent)) {
    throw new Error(`Unknown agent "${agent}".`);
  }
}

function formatTask(task) {
  const deps = Array.isArray(task.blockedBy) && task.blockedBy.length > 0 ? ` blockedBy=${task.blockedBy.join(',')}` : '';
  return `${task.id} [${task.status}] owner=${task.owner}${deps} :: ${task.title}`;
}

function detectCycle(tasks, targetId, proposedBlockedBy) {
  const visited = new Set();
  const queue = [...proposedBlockedBy];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === targetId) {
      return true;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    const task = tasks.find((t) => t.id === current);
    if (task && Array.isArray(task.blockedBy)) {
      queue.push(...task.blockedBy);
    }
  }
  return false;
}

function autoUnblock(state, completedTaskId) {
  const completedIds = new Set(
    state.tasks.filter((t) => ['done', 'cancelled'].includes(t.status)).map((t) => t.id)
  );
  completedIds.add(completedTaskId);

  for (const task of state.tasks) {
    if (!Array.isArray(task.blockedBy) || task.blockedBy.length === 0) {
      continue;
    }
    if (task.status !== 'blocked') {
      continue;
    }
    const allDepsComplete = task.blockedBy.every((dep) => completedIds.has(dep));
    if (allDepsComplete) {
      task.status = 'todo';
      const note = `[AUTO] All dependencies completed (${task.blockedBy.join(',')}), moved to todo.`;
      task.notes = task.notes ? `${task.notes}\n${note}` : note;
      task.updatedAt = nowIso();
    }
  }
}

function buildPrompt(agent, state) {
  const agentConfig = getAgent(agent);
  const label = agentConfig ? agentConfig.label : (agent === 'human' ? 'Human Operator' : 'AI Assistant');
  const rolePrompt = agentConfig ? agentConfig.rolePrompt : '';

  const openTasks = state.tasks
    .filter((task) => !['done', 'cancelled'].includes(task.status))
    .slice(0, 10)
    .map((task) => `- ${formatTask(task)}`)
    .join('\n');

  // Agent-specific file read instructions
  const readInstructions = agent === 'codex'
    ? 'Read task-specific files listed in your assigned task.'
    : agent === 'gemini'
      ? 'Read broadly: CLAUDE.md, QUICK_REFERENCE.md, AI_SYNC_STATE.json, AI_SYNC_LOG.md, and all files in your task scope.'
      : 'Read these files first:\n1) CLAUDE.md\n2) docs/QUICK_REFERENCE.md\n3) docs/coordination/AI_SYNC_STATE.json\n4) docs/coordination/AI_SYNC_LOG.md';

  return [
    `You are ${label} collaborating in the ${config.projectName} repository with Codex, Claude Code, and Gemini Pro.`,
    '',
    rolePrompt ? rolePrompt : '',
    '',
    readInstructions,
    '',
    'Rules for this run:',
    '- Claim or update one task before editing.',
    '- Keep task status current: todo/in_progress/blocked/done.',
    '- Record decisions and blockers as they happen.',
    '- Add a handoff entry before switching agents.',
    agent === 'claude' ? '- Create detailed task specs for Codex (file paths, signatures, DoD) in your handoffs.' : '',
    agent === 'gemini' ? '- Cite specific file paths and line numbers in all findings.' : '',
    agent === 'codex' ? '- Do not redesign — follow the spec. Report exactly what you changed.' : '',
    '',
    `Current focus: ${state.activeSession?.focus || 'not set'}`,
    `Current branch: ${state.activeSession?.branch || getCurrentBranch()}`,
    '',
    'Open tasks:',
    openTasks || '- none',
  ].filter(Boolean).join('\n');
}

function getSummary(state) {
  const completedIds = new Set(
    state.tasks.filter((t) => ['done', 'cancelled'].includes(t.status)).map((t) => t.id)
  );
  const openTasks = state.tasks.filter((task) => !['done', 'cancelled'].includes(task.status)).map((task) => {
    const deps = Array.isArray(task.blockedBy) ? task.blockedBy : [];
    const pendingDependencies = deps.filter((dep) => !completedIds.has(dep));
    return { ...task, pendingDependencies };
  });
  const openBlockers = state.blockers.filter((item) => item.status !== 'resolved');
  const recentDecision = state.decisions.at(-1) || null;
  const latestHandoff = state.handoffs.at(-1) || null;

  return {
    updatedAt: state.updatedAt,
    activeSession: state.activeSession,
    counts: {
      tasksOpen: openTasks.length,
      blockersOpen: openBlockers.length,
      decisions: state.decisions.length,
      handoffs: state.handoffs.length,
    },
    openTasks,
    openBlockers,
    recentDecision,
    latestHandoff,
  };
}

function suggestNext(state, agent) {
  ensureKnownAgent(agent, false);

  const completedIds = new Set(
    state.tasks.filter((t) => ['done', 'cancelled'].includes(t.status)).map((t) => t.id)
  );
  const openTasks = state.tasks.filter((task) => {
    if (['done', 'cancelled'].includes(task.status)) {
      return false;
    }
    const deps = Array.isArray(task.blockedBy) ? task.blockedBy : [];
    return deps.every((dep) => completedIds.has(dep));
  });
  const inProgress = openTasks.find((task) => task.owner === agent && task.status === 'in_progress');
  if (inProgress) {
    return {
      action: 'continue_task',
      message: `${agent} should continue ${inProgress.id}.`,
      task: inProgress,
    };
  }

  const pendingHandoff = [...state.handoffs]
    .reverse()
    .find((handoff) => handoff.to === agent && !handoff.acknowledgedAt);
  if (pendingHandoff) {
    const relatedTask = pendingHandoff.tasks
      ? openTasks.find((task) => pendingHandoff.tasks.includes(task.id))
      : null;
    return {
      action: 'pickup_handoff',
      message: `${agent} has an unacknowledged handoff ${pendingHandoff.id}.`,
      handoff: pendingHandoff,
      relatedTask,
    };
  }

  const ownedTodo = openTasks.find((task) => task.owner === agent && task.status === 'todo');
  if (ownedTodo) {
    return {
      action: 'claim_owned_task',
      message: `${agent} should move ${ownedTodo.id} to in_progress.`,
      task: ownedTodo,
    };
  }

  // Sort unassigned tasks by affinity for the requesting agent
  const agentConfig = getAgent(agent);
  const unassignedTodos = openTasks
    .filter((task) => ['unassigned', 'human', ''].includes(task.owner) && task.status === 'todo')
    .map((task) => {
      const taskType = task.type || 'implementation';
      const affinity = agentConfig?.taskAffinity?.[taskType] || 0.5;
      return { task, affinity };
    })
    .sort((a, b) => b.affinity - a.affinity);

  const unassignedTodo = unassignedTodos[0]?.task;
  if (unassignedTodo) {
    return {
      action: 'claim_unassigned_task',
      message: `${agent} can claim ${unassignedTodo.id} (type=${unassignedTodo.type || 'implementation'}, affinity=${unassignedTodos[0].affinity}).`,
      task: unassignedTodo,
    };
  }

  const blockedMine = openTasks.find((task) => task.owner === agent && task.status === 'blocked');
  if (blockedMine) {
    return {
      action: 'resolve_blocker',
      message: `${agent} has blocked task ${blockedMine.id}.`,
      task: blockedMine,
    };
  }

  return {
    action: 'idle',
    message: `No actionable task for ${agent}.`,
  };
}

function parseArgs(argv) {
  const [command = 'start', ...rest] = argv.slice(2);
  const options = {};

  for (const token of rest) {
    if (token.includes('=')) {
      const [rawKey, ...rawValue] = token.split('=');
      const key = rawKey.trim();
      if (key) {
        options[key] = rawValue.join('=').trim();
      }
    }
  }

  return { command, options };
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, statusCode, message, details = null) {
  sendJson(res, statusCode, {
    ok: false,
    error: message,
    details,
  });
}

function isAuthorized(req) {
  if (!ORCH_TOKEN) {
    return true;
  }
  return req.headers['x-ai-orch-token'] === ORCH_TOKEN;
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  const maxSize = 1024 * 1024;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxSize) {
      throw new Error('Payload too large.');
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function readEvents(limit = 50) {
  if (!fs.existsSync(EVENTS_PATH)) {
    return [];
  }
  const raw = fs.readFileSync(EVENTS_PATH, 'utf8');
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const parsed = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // Skip malformed lines.
    }
  }
  return parsed.slice(-Math.max(1, Math.min(limit, 500)));
}

function readArchive() {
  if (!fs.existsSync(ARCHIVE_PATH)) {
    return { archivedAt: null, tasks: [], handoffs: [], blockers: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(ARCHIVE_PATH, 'utf8'));
  } catch {
    return { archivedAt: null, tasks: [], handoffs: [], blockers: [] };
  }
}

function writeArchive(archive) {
  archive.archivedAt = nowIso();
  fs.writeFileSync(ARCHIVE_PATH, `${JSON.stringify(archive, null, 2)}\n`, 'utf8');
}

function archiveState(state) {
  const archive = readArchive();
  let moved = 0;
  const oneHourAgo = Date.now() - 60 * 60 * 1000;

  const completedTasks = state.tasks.filter((t) => ['done', 'cancelled'].includes(t.status));
  const completedTaskIds = new Set(completedTasks.map((t) => t.id));
  if (completedTasks.length > 0) {
    archive.tasks.push(...completedTasks);
    state.tasks = state.tasks.filter((t) => !completedTaskIds.has(t.id));
    moved += completedTasks.length;

    for (const task of state.tasks) {
      if (Array.isArray(task.blockedBy)) {
        task.blockedBy = task.blockedBy.filter((dep) => !completedTaskIds.has(dep));
      }
    }
  }

  const oldHandoffs = state.handoffs.filter((h) => {
    if (!h.acknowledgedAt) {
      return false;
    }
    return new Date(h.acknowledgedAt).getTime() < oneHourAgo;
  });
  if (oldHandoffs.length > 0) {
    const oldHandoffIds = new Set(oldHandoffs.map((h) => h.id));
    archive.handoffs.push(...oldHandoffs);
    state.handoffs = state.handoffs.filter((h) => !oldHandoffIds.has(h.id));
    moved += oldHandoffs.length;
  }

  const resolvedBlockers = state.blockers.filter((b) => b.status === 'resolved');
  if (resolvedBlockers.length > 0) {
    const resolvedIds = new Set(resolvedBlockers.map((b) => b.id));
    archive.blockers.push(...resolvedBlockers);
    state.blockers = state.blockers.filter((b) => !resolvedIds.has(b.id));
    moved += resolvedBlockers.length;
  }

  if (moved > 0) {
    writeArchive(archive);
  }

  return moved;
}

function truncateEventsFile(maxLines = 500) {
  if (!fs.existsSync(EVENTS_PATH)) {
    return 0;
  }
  const raw = fs.readFileSync(EVENTS_PATH, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length <= maxLines) {
    return 0;
  }
  const trimmed = lines.slice(-maxLines);
  fs.writeFileSync(EVENTS_PATH, `${trimmed.join('\n')}\n`, 'utf8');
  return lines.length - maxLines;
}

async function requestJson(method, url, body = null) {
  const headers = {
    Accept: 'application/json',
  };
  if (ORCH_TOKEN) {
    headers['x-ai-orch-token'] = ORCH_TOKEN;
  }
  if (body !== null) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

function printHelp() {
  console.log(`
Hydra Orchestrator Daemon

Usage:
  node orchestrator-daemon.mjs start [host=127.0.0.1] [port=4173]
  node orchestrator-daemon.mjs status [url=http://127.0.0.1:4173]
  node orchestrator-daemon.mjs stop [url=http://127.0.0.1:4173]

Environment:
  AI_ORCH_HOST   Host bind (default: 127.0.0.1)
  AI_ORCH_PORT   Port bind (default: 4173)
  AI_ORCH_TOKEN  Optional API token for write endpoints
  HYDRA_PROJECT  Override target project directory
`);
}

async function commandStatus(options) {
  const url = options.url || `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
  try {
    const { response, payload } = await requestJson('GET', `${url}/health`);
    if (!response.ok) {
      console.error(`Daemon status check failed (${response.status}): ${payload.error || 'unknown error'}`);
      process.exit(1);
    }
    console.log(JSON.stringify(payload, null, 2));
  } catch (error) {
    console.error(`Daemon not reachable at ${url}: ${error.message}`);
    process.exit(1);
  }
}

async function commandStop(options) {
  const url = options.url || `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
  try {
    const { response, payload } = await requestJson('POST', `${url}/shutdown`, {});
    if (!response.ok) {
      console.error(`Failed to stop daemon (${response.status}): ${payload.error || 'unknown error'}`);
      process.exit(1);
    }
    console.log('Stop signal sent to orchestrator daemon.');
  } catch (error) {
    console.error(`Unable to reach daemon at ${url}: ${error.message}`);
    process.exit(1);
  }
}

function startDaemon(options) {
  ensureCoordFiles();

  const host = options.host || DEFAULT_HOST;
  const port = Number.parseInt(options.port || String(DEFAULT_PORT), 10);
  if (!Number.isFinite(port) || port <= 0) {
    console.error(`Invalid port: ${options.port}`);
    process.exit(1);
  }

  let isShuttingDown = false;
  const startedAt = nowIso();
  let lastEventAt = nowIso();
  let eventCount = 0;
  let writeQueue = Promise.resolve();
  const sseClients = new Set();

  function broadcastEvent(event) {
    if (sseClients.size === 0) return;
    const data = JSON.stringify(event);
    for (const client of sseClients) {
      try {
        client.write(`data: ${data}\n\n`);
      } catch {
        sseClients.delete(client);
      }
    }
  }

  function writeStatus(extra = {}) {
    const state = readState();
    const payload = {
      service: 'hydra-orchestrator',
      project: config.projectName,
      projectRoot: config.projectRoot,
      running: !isShuttingDown,
      pid: process.pid,
      host,
      port,
      startedAt,
      updatedAt: nowIso(),
      uptimeSec: Math.floor(process.uptime()),
      stateUpdatedAt: state.updatedAt,
      activeSessionId: state.activeSession?.id || null,
      eventsRecorded: eventCount,
      lastEventAt,
      ...extra,
    };
    fs.writeFileSync(STATUS_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  function enqueueMutation(label, mutator, detail = {}) {
    writeQueue = writeQueue.then(() => {
      const state = readState();
      const result = mutator(state);
      writeState(state);
      appendSyncLog(`[orch] ${label}`);
      const eventId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const at = nowIso();
      const event = { id: eventId, at, type: 'mutation', payload: { label, ...detail } };
      appendEvent('mutation', { label, ...detail });
      broadcastEvent(event);
      lastEventAt = at;
      eventCount += 1;
      writeStatus();
      return result;
    });
    return writeQueue;
  }

  function runVerification(taskId) {
    appendEvent('verification_start', { taskId });
    const VERIFY_TIMEOUT_MS = 60_000;
    exec('npx tsc --noEmit', { cwd: config.projectRoot, timeout: VERIFY_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        const snippet = String(stderr || stdout || error.message).slice(0, 500);
        enqueueMutation(`verify:fail id=${taskId}`, (state) => {
          const task = state.tasks.find((t) => t.id === taskId);
          if (task) {
            task.status = 'blocked';
            const note = `[AUTO-VERIFY FAILED] tsc --noEmit:\n${snippet}`;
            task.notes = task.notes ? `${task.notes}\n${note}` : note;
            task.updatedAt = nowIso();
          }
        }, { event: 'verify', taskId, passed: false });
        appendEvent('verification_complete', { taskId, passed: false, snippet });
      } else {
        enqueueMutation(`verify:pass id=${taskId}`, (state) => {
          const task = state.tasks.find((t) => t.id === taskId);
          if (task) {
            const note = '[AUTO-VERIFY PASSED] tsc --noEmit clean.';
            task.notes = task.notes ? `${task.notes}\n${note}` : note;
            task.updatedAt = nowIso();
          }
        }, { event: 'verify', taskId, passed: true });
        appendEvent('verification_complete', { taskId, passed: true });
      }
    });
  }

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
    const route = requestUrl.pathname;
    const method = req.method || 'GET';

    try {
      if (method === 'GET' && route === '/health') {
        writeStatus();
        const status = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'));
        // Enhanced health: include model info and usage level
        let usageLevel = 'unknown';
        try {
          const usage = checkUsage();
          usageLevel = usage.level;
        } catch { /* ignore */ }
        let models = {};
        try {
          const { getModelSummary } = await import('./hydra-agents.mjs');
          const ms = getModelSummary();
          models = Object.fromEntries(Object.entries(ms).map(([a, i]) => [a, i.active]));
        } catch { /* ignore */ }
        sendJson(res, 200, {
          ok: true,
          ...status,
          models,
          usage: { level: usageLevel },
        });
        return;
      }

      if (method === 'GET' && route === '/state') {
        sendJson(res, 200, { ok: true, state: readState() });
        return;
      }

      if (method === 'GET' && route === '/summary') {
        sendJson(res, 200, { ok: true, summary: getSummary(readState()) });
        return;
      }

      if (method === 'GET' && route === '/prompt') {
        const agent = (requestUrl.searchParams.get('agent') || 'generic').toLowerCase();
        sendJson(res, 200, { ok: true, agent, prompt: buildPrompt(agent, readState()) });
        return;
      }

      if (method === 'GET' && route === '/next') {
        const agent = (requestUrl.searchParams.get('agent') || '').toLowerCase();
        if (!agent) {
          sendError(res, 400, 'Missing query param: agent');
          return;
        }
        sendJson(res, 200, { ok: true, next: suggestNext(readState(), agent) });
        return;
      }

      if (method === 'GET' && route === '/events') {
        const limit = Number.parseInt(requestUrl.searchParams.get('limit') || '50', 10);
        sendJson(res, 200, { ok: true, events: readEvents(limit) });
        return;
      }

      if (method === 'GET' && route === '/events/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        res.write(':ok\n\n');
        sseClients.add(res);
        const keepalive = setInterval(() => {
          try { res.write(':keepalive\n\n'); } catch { /* ignore */ }
        }, 15_000);
        req.on('close', () => {
          sseClients.delete(res);
          clearInterval(keepalive);
        });
        return;
      }

      if (!isAuthorized(req)) {
        sendError(res, 401, 'Unauthorized');
        return;
      }

      if (method === 'POST' && route === '/session/start') {
        const body = await readJsonBody(req);
        const focus = String(body.focus || '').trim();
        if (!focus) {
          sendError(res, 400, 'Field "focus" is required.');
          return;
        }

        const owner = String(body.owner || 'human').toLowerCase();
        ensureKnownAgent(owner, false);
        const participants = parseList(body.participants || 'human,codex,claude,gemini');
        const branch = String(body.branch || getCurrentBranch());

        const session = await enqueueMutation(`session:start owner=${owner} focus="${focus}"`, (state) => {
          state.activeSession = {
            id: toSessionId(),
            focus,
            owner,
            branch,
            participants,
            status: 'active',
            startedAt: nowIso(),
            updatedAt: nowIso(),
          };
          return state.activeSession;
        });

        sendJson(res, 200, { ok: true, session });
        return;
      }

      if (method === 'POST' && route === '/task/add') {
        const body = await readJsonBody(req);
        const title = String(body.title || '').trim();
        if (!title) {
          sendError(res, 400, 'Field "title" is required.');
          return;
        }

        const owner = String(body.owner || 'unassigned').toLowerCase();
        ensureKnownAgent(owner);

        const status = String(body.status || 'todo');
        ensureKnownStatus(status);

        const files = parseList(body.files || []);
        const notes = String(body.notes || '').trim();
        const blockedBy = parseList(body.blockedBy || []);

        const taskType = String(body.type || '').trim() || classifyTask(title, notes);

        const task = await enqueueMutation(`task:add owner=${owner} status=${status} type=${taskType}`, (state) => {
          const item = {
            id: nextId('T', state.tasks),
            title,
            owner,
            status,
            type: taskType,
            files,
            notes,
            blockedBy,
            updatedAt: nowIso(),
          };
          state.tasks.push(item);
          return item;
        }, { event: 'task_add', owner, title: title.slice(0, 80) });

        sendJson(res, 200, { ok: true, task });
        return;
      }

      if (method === 'POST' && route === '/task/claim') {
        const body = await readJsonBody(req);
        const agent = String(body.agent || '').toLowerCase();
        ensureKnownAgent(agent, false);

        const claimTitle = String(body.title || body.taskId || '').trim();
        const task = await enqueueMutation(`task:claim agent=${agent}`, (state) => {
          const taskId = String(body.taskId || '').trim();
          const title = String(body.title || '').trim();
          const files = parseList(body.files);
          const notes = String(body.notes || '').trim();

          if (taskId) {
            const existing = state.tasks.find((item) => item.id === taskId);
            if (!existing) {
              throw new Error(`Task ${taskId} not found.`);
            }
            if (['done', 'cancelled'].includes(existing.status)) {
              throw new Error(`Task ${taskId} is already ${existing.status}.`);
            }
            if (existing.status === 'in_progress' && existing.owner !== agent) {
              throw new Error(`Task ${taskId} is already in progress by ${existing.owner}.`);
            }

            existing.owner = agent;
            existing.status = 'in_progress';
            if (files.length > 0) {
              existing.files = files;
            }
            if (notes) {
              existing.notes = existing.notes ? `${existing.notes}\n${notes}` : notes;
            }
            existing.updatedAt = nowIso();
            return existing;
          }

          if (!title) {
            throw new Error('Either taskId or title is required.');
          }

          const claimBlockedBy = parseList(body.blockedBy || []);
          const newTask = {
            id: nextId('T', state.tasks),
            title,
            owner: agent,
            status: 'in_progress',
            files,
            notes,
            blockedBy: claimBlockedBy,
            updatedAt: nowIso(),
          };
          state.tasks.push(newTask);
          return newTask;
        }, { event: 'task_claim', agent, title: claimTitle.slice(0, 80) });

        sendJson(res, 200, { ok: true, task });
        return;
      }

      if (method === 'POST' && route === '/task/update') {
        const body = await readJsonBody(req);
        const taskId = String(body.taskId || '').trim();
        if (!taskId) {
          sendError(res, 400, 'Field "taskId" is required.');
          return;
        }

        const updateStatus = body.status !== undefined ? String(body.status) : undefined;
        const updateOwner = body.owner !== undefined ? String(body.owner).toLowerCase() : undefined;
        const task = await enqueueMutation(`task:update id=${taskId}`, (state) => {
          const existing = state.tasks.find((item) => item.id === taskId);
          if (!existing) {
            throw new Error(`Task ${taskId} not found.`);
          }

          if (body.title !== undefined) {
            existing.title = String(body.title);
          }
          if (body.owner !== undefined) {
            const owner = String(body.owner).toLowerCase();
            ensureKnownAgent(owner);
            existing.owner = owner;
          }
          if (body.blockedBy !== undefined) {
            const proposed = parseList(body.blockedBy);
            if (proposed.length > 0 && detectCycle(state.tasks, taskId, proposed)) {
              throw new Error(`Setting blockedBy=[${proposed.join(',')}] on ${taskId} would create a circular dependency.`);
            }
            existing.blockedBy = proposed;
          }
          if (body.status !== undefined) {
            const status = String(body.status);
            ensureKnownStatus(status);
            existing.status = status;
          }
          if (body.files !== undefined) {
            existing.files = parseList(body.files);
          }
          if (body.notes !== undefined) {
            const notes = String(body.notes).trim();
            if (notes) {
              existing.notes = existing.notes ? `${existing.notes}\n${notes}` : notes;
            }
          }
          existing.updatedAt = nowIso();

          if (['done', 'cancelled'].includes(existing.status)) {
            autoUnblock(state, taskId);
          }

          return existing;
        }, { event: 'task_update', taskId, status: updateStatus, owner: updateOwner });

        const shouldVerify = task.status === 'done' && body.verify !== false;
        if (shouldVerify) {
          runVerification(taskId);
        }
        sendJson(res, 200, { ok: true, task, verifying: shouldVerify });
        return;
      }

      if (method === 'POST' && route === '/task/route') {
        const body = await readJsonBody(req);
        const taskId = String(body.taskId || '').trim();
        if (!taskId) {
          sendError(res, 400, 'Field "taskId" is required.');
          return;
        }
        const state = readState();
        const target = state.tasks.find((t) => t.id === taskId);
        if (!target) {
          sendError(res, 404, `Task ${taskId} not found.`);
          return;
        }
        const taskType = target.type || classifyTask(target.title, target.notes || '');
        const scores = {};
        let recommended = AGENT_NAMES[0];
        let bestScore = 0;
        for (const name of AGENT_NAMES) {
          const cfg = getAgent(name);
          const score = cfg?.taskAffinity?.[taskType] || 0.5;
          scores[name] = score;
          if (score > bestScore) {
            bestScore = score;
            recommended = name;
          }
        }
        sendJson(res, 200, {
          ok: true,
          taskId,
          taskType,
          recommended,
          scores,
          reason: `${taskType} task best suited for ${recommended} (affinity=${bestScore})`,
        });
        return;
      }

      if (method === 'POST' && route === '/verify') {
        const body = await readJsonBody(req);
        const verifyTaskId = String(body.taskId || '').trim();
        if (!verifyTaskId) {
          sendError(res, 400, 'Field "taskId" is required.');
          return;
        }
        const state = readState();
        const target = state.tasks.find((t) => t.id === verifyTaskId);
        if (!target) {
          sendError(res, 404, `Task ${verifyTaskId} not found.`);
          return;
        }
        runVerification(verifyTaskId);
        sendJson(res, 200, { ok: true, taskId: verifyTaskId, message: 'Verification started.' });
        return;
      }

      if (method === 'POST' && route === '/decision') {
        const body = await readJsonBody(req);
        const title = String(body.title || '').trim();
        if (!title) {
          sendError(res, 400, 'Field "title" is required.');
          return;
        }

        const owner = String(body.owner || 'human').toLowerCase();
        ensureKnownAgent(owner, false);
        const rationale = String(body.rationale || '');
        const impact = String(body.impact || '');

        const decision = await enqueueMutation(`decision:add owner=${owner}`, (state) => {
          const item = {
            id: nextId('D', state.decisions),
            title,
            owner,
            rationale,
            impact,
            createdAt: nowIso(),
          };
          state.decisions.push(item);
          return item;
        }, { event: 'decision', title: title.slice(0, 80) });

        sendJson(res, 200, { ok: true, decision });
        return;
      }

      if (method === 'POST' && route === '/blocker') {
        const body = await readJsonBody(req);
        const title = String(body.title || '').trim();
        if (!title) {
          sendError(res, 400, 'Field "title" is required.');
          return;
        }

        const owner = String(body.owner || 'human').toLowerCase();
        ensureKnownAgent(owner, false);
        const nextStep = String(body.nextStep || '');

        const blocker = await enqueueMutation(`blocker:add owner=${owner}`, (state) => {
          const item = {
            id: nextId('B', state.blockers),
            title,
            owner,
            status: 'open',
            nextStep,
            createdAt: nowIso(),
          };
          state.blockers.push(item);
          return item;
        });

        sendJson(res, 200, { ok: true, blocker });
        return;
      }

      if (method === 'POST' && route === '/handoff') {
        const body = await readJsonBody(req);
        const from = String(body.from || '').toLowerCase();
        const to = String(body.to || '').toLowerCase();
        const summary = String(body.summary || '').trim();
        const nextStep = String(body.nextStep || '');
        const tasks = parseList(body.tasks);

        if (!from || !to || !summary) {
          sendError(res, 400, 'Fields "from", "to", and "summary" are required.');
          return;
        }

        ensureKnownAgent(from, false);
        ensureKnownAgent(to, false);

        const handoff = await enqueueMutation(`handoff:add ${from}->${to}`, (state) => {
          const item = {
            id: nextId('H', state.handoffs),
            from,
            to,
            summary,
            nextStep,
            tasks,
            createdAt: nowIso(),
          };
          state.handoffs.push(item);
          return item;
        }, { event: 'handoff', from, to });

        sendJson(res, 200, { ok: true, handoff });
        return;
      }

      if (method === 'POST' && route === '/handoff/ack') {
        const body = await readJsonBody(req);
        const handoffId = String(body.handoffId || '').trim();
        const agent = String(body.agent || '').toLowerCase();
        if (!handoffId || !agent) {
          sendError(res, 400, 'Fields "handoffId" and "agent" are required.');
          return;
        }
        ensureKnownAgent(agent, false);

        const handoff = await enqueueMutation(`handoff:ack id=${handoffId} by=${agent}`, (state) => {
          const item = state.handoffs.find((entry) => entry.id === handoffId);
          if (!item) {
            throw new Error(`Handoff ${handoffId} not found.`);
          }
          item.acknowledgedAt = nowIso();
          item.acknowledgedBy = agent;
          return item;
        }, { event: 'handoff_ack', agent, handoffId });

        sendJson(res, 200, { ok: true, handoff });
        return;
      }

      if (method === 'POST' && route === '/state/archive') {
        const result = await enqueueMutation('state:archive', (state) => {
          const moved = archiveState(state);
          const trimmed = truncateEventsFile(500);
          return { moved, eventsTrimmed: trimmed };
        });
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (method === 'GET' && route === '/state/archive') {
        const archive = readArchive();
        sendJson(res, 200, {
          ok: true,
          counts: {
            tasks: archive.tasks.length,
            handoffs: archive.handoffs.length,
            blockers: archive.blockers.length,
          },
          archivedAt: archive.archivedAt,
        });
        return;
      }

      if (method === 'GET' && route === '/stats') {
        const metrics = getMetricsSummary();
        const usage = checkUsage();
        sendJson(res, 200, {
          ok: true,
          metrics,
          usage: {
            level: usage.level,
            percent: usage.percent,
            todayTokens: usage.todayTokens,
            message: usage.message,
            confidence: usage.confidence,
            model: usage.model,
            budget: usage.budget,
            used: usage.used,
            remaining: usage.remaining,
            resetAt: usage.resetAt,
            resetInMs: usage.resetInMs,
            agents: usage.agents,
          },
          daemon: { uptimeSec: Math.floor(process.uptime()), eventsRecorded: eventCount },
        });
        return;
      }

      if (method === 'POST' && route === '/shutdown') {
        sendJson(res, 200, { ok: true, message: 'Shutting down orchestrator daemon.' });
        isShuttingDown = true;
        writeStatus({ running: false, stoppingAt: nowIso() });
        setTimeout(() => {
          server.close(() => {
            writeStatus({ running: false, stoppedAt: nowIso() });
            process.exit(0);
          });
        }, 100);
        return;
      }

      sendError(res, 404, `Route not found: ${method} ${route}`);
    } catch (error) {
      sendError(res, 400, error.message || 'Bad request');
    }
  });

  server.on('error', (error) => {
    console.error(`Orchestrator server error: ${error.message}`);
    process.exit(1);
  });

  function autoArchiveIfNeeded() {
    try {
      const state = readState();
      const completedCount = state.tasks.filter((t) => ['done', 'cancelled'].includes(t.status)).length;
      if (completedCount > 20) {
        const moved = archiveState(state);
        truncateEventsFile(500);
        if (moved > 0) {
          writeState(state);
          appendSyncLog(`[orch] auto-archived ${moved} items`);
          appendEvent('auto_archive', { moved });
        }
      }
    } catch {
      // Non-critical — skip silently.
    }
  }

  // Load persisted metrics from previous session
  loadPersistedMetrics(COORD_DIR);

  server.listen(port, host, () => {
    appendSyncLog(`[orch] daemon started at http://${host}:${port}`);
    appendEvent('daemon_start', { host, port, pid: process.pid, project: config.projectName });
    writeStatus();

    autoArchiveIfNeeded();

    console.log(hydraSplash());
    console.log(uiLabel('Project', pc.white(config.projectName)));
    console.log(uiLabel('Root', DIM(config.projectRoot)));
    console.log(uiLabel('URL', pc.white(`http://${host}:${port}`)));
    console.log(uiLabel('PID', pc.white(String(process.pid))));
    console.log(uiLabel('State', DIM(path.relative(config.projectRoot, STATE_PATH))));
    console.log(uiLabel('Status', DIM(path.relative(config.projectRoot, STATUS_PATH))));
    console.log(divider());
    console.log(SUCCESS('  Daemon ready'));
    console.log('');
  });

  const statusInterval = setInterval(() => {
    writeStatus();
  }, 5000);

  const metricsInterval = setInterval(() => {
    persistMetrics(COORD_DIR);
  }, 30_000);

  const archiveInterval = setInterval(() => {
    autoArchiveIfNeeded();
  }, 30 * 60 * 1000);

  function gracefulExit(signal) {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;
    console.log('');
    console.log(DIM(`  Shutting down (${signal})...`));
    appendSyncLog(`[orch] daemon stopping (${signal})`);
    appendEvent('daemon_stop', { signal, pid: process.pid });
    // Close all SSE clients
    for (const client of sseClients) {
      try { client.end(); } catch { /* ignore */ }
    }
    sseClients.clear();
    persistMetrics(COORD_DIR);
    clearInterval(statusInterval);
    clearInterval(metricsInterval);
    clearInterval(archiveInterval);
    writeStatus({ running: false, stoppingAt: nowIso(), signal });
    server.close(() => {
      writeStatus({ running: false, stoppedAt: nowIso(), signal });
      console.log(SUCCESS('  Daemon stopped'));
      process.exit(0);
    });
  }

  process.on('SIGINT', () => gracefulExit('SIGINT'));
  process.on('SIGTERM', () => gracefulExit('SIGTERM'));
}

async function main() {
  const { command, options } = parseArgs(process.argv);

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;
    case 'start':
      startDaemon(options);
      return;
    case 'status':
      await commandStatus(options);
      return;
    case 'stop':
      await commandStop(options);
      return;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main();
