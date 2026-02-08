/**
 * Hydra Status Bar - Persistent agent status footer pinned to the terminal bottom.
 *
 * Uses ANSI scroll regions to confine normal output to the upper portion of the
 * terminal, keeping a 3-line status bar fixed at the bottom showing each agent's
 * current activity, health icon, and a rolling activity ticker.
 *
 * Supports two data sources:
 *   - SSE event stream from daemon (/events/stream) — preferred, real-time
 *   - Fallback polling (/next?agent=...) — used when SSE unavailable
 *
 * Gracefully degrades to no-op when !process.stdout.isTTY or terminal < 10 rows.
 */

import http from 'http';
import { metricsEmitter } from './hydra-metrics.mjs';
import {
  AGENT_ICONS,
  AGENT_COLORS,
  HEALTH_ICONS,
  formatAgentStatus,
  formatElapsed,
  stripAnsi,
  DIM,
} from './hydra-ui.mjs';

// ── Agent Activity State ────────────────────────────────────────────────────

const agentState = new Map();

/**
 * Set an agent's activity state.
 * @param {string} agent - Agent name (claude, gemini, codex)
 * @param {'inactive'|'idle'|'working'|'error'} status
 * @param {string} [action] - Current action description
 */
export function setAgentActivity(agent, status, action) {
  agentState.set(agent.toLowerCase(), {
    status: status || 'inactive',
    action: action || '',
    updatedAt: Date.now(),
  });
}

/**
 * Get an agent's current activity state.
 */
export function getAgentActivity(agent) {
  return agentState.get(agent.toLowerCase()) || { status: 'inactive', action: '', updatedAt: 0 };
}

// ── Activity Event Buffer ───────────────────────────────────────────────────

const MAX_TICKER_EVENTS = 3;
const tickerEvents = [];
const activityCallbacks = [];

function pushTickerEvent(text) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  tickerEvents.push({ time, text });
  if (tickerEvents.length > MAX_TICKER_EVENTS) {
    tickerEvents.shift();
  }
}

/**
 * Register a callback for significant activity events.
 * Callback receives { time, event, agent, detail }.
 */
export function onActivityEvent(callback) {
  if (typeof callback === 'function') {
    activityCallbacks.push(callback);
  }
}

function emitActivityEvent(event) {
  for (const cb of activityCallbacks) {
    try { cb(event); } catch { /* ignore */ }
  }
}

// ── Scroll Region & Rendering ───────────────────────────────────────────────

const ESC = '\x1b[';
const STATUS_BAR_HEIGHT = 3; // divider line + agent status line + ticker line
let statusBarActive = false;
let registeredAgents = [];

function isTTYCapable() {
  return Boolean(process.stdout.isTTY) && (process.stdout.rows || 0) >= 10;
}

function getTermSize() {
  return {
    rows: process.stdout.rows || 24,
    cols: process.stdout.columns || 80,
  };
}

/**
 * Set the terminal scroll region to exclude the bottom status bar lines.
 */
function setScrollRegion() {
  if (!isTTYCapable()) return;
  const { rows } = getTermSize();
  const scrollBottom = rows - STATUS_BAR_HEIGHT;
  // Set scroll region: rows 1 through (rows - STATUS_BAR_HEIGHT)
  process.stdout.write(`${ESC}1;${scrollBottom}r`);
  // Move cursor back into the scroll region
  process.stdout.write(`${ESC}${scrollBottom};1H`);
}

/**
 * Reset scroll region to full terminal.
 */
function resetScrollRegion() {
  const { rows } = getTermSize();
  process.stdout.write(`${ESC}1;${rows}r`);
  process.stdout.write(`${ESC}${rows};1H`);
}

/**
 * Build the 3-line status bar content.
 */
function buildStatusBar() {
  const { cols } = getTermSize();

  // Line 1: divider
  const dividerLine = DIM('\u2500'.repeat(cols));

  // Line 2: agent segments joined by |
  const segments = [];
  for (const agent of registeredAgents) {
    const state = getAgentActivity(agent);
    const elapsed = state.updatedAt && state.status === 'working'
      ? ` (${formatElapsed(Date.now() - state.updatedAt)})`
      : '';
    const actionWithElapsed = state.action ? `${state.action}${elapsed}` : (state.status || 'Inactive');
    // Calculate max width per agent segment (leave room for separators)
    const separatorChars = Math.max(0, registeredAgents.length - 1) * 3; // ' | '
    const maxPerAgent = Math.max(12, Math.floor((cols - separatorChars) / registeredAgents.length));
    segments.push(formatAgentStatus(agent, state.status, actionWithElapsed, maxPerAgent));
  }
  const agentLine = segments.join(DIM('  \u2502  '));

  // Line 3: activity ticker
  let tickerLine = '';
  if (tickerEvents.length > 0) {
    const parts = tickerEvents.map((e) => `${DIM(e.time)} ${e.text}`);
    tickerLine = `  \u21B3 ${parts.join(DIM('  \u00B7  '))}`;
    // Truncate to terminal width
    const stripped = stripAnsi(tickerLine);
    if (stripped.length > cols) {
      // Rough truncation — just take enough events to fit
      tickerLine = `  \u21B3 ${parts.slice(-2).join(DIM('  \u00B7  '))}`;
    }
  } else {
    tickerLine = DIM('  \u21B3 awaiting events...');
  }

  return { dividerLine, agentLine, tickerLine };
}

/**
 * Paint the status bar at the bottom of the terminal.
 */
export function drawStatusBar() {
  if (!statusBarActive || !isTTYCapable()) return;
  const { rows } = getTermSize();
  const { dividerLine, agentLine, tickerLine } = buildStatusBar();

  // Save cursor position
  process.stdout.write(`${ESC}s`);

  // Move to divider line (row = rows - 2) and clear it
  process.stdout.write(`${ESC}${rows - 2};1H`);
  process.stdout.write(`${ESC}2K`);
  process.stdout.write(dividerLine);

  // Move to agent line (row = rows - 1) and clear it
  process.stdout.write(`${ESC}${rows - 1};1H`);
  process.stdout.write(`${ESC}2K`);
  process.stdout.write(agentLine);

  // Move to ticker line (row = rows) and clear it
  process.stdout.write(`${ESC}${rows};1H`);
  process.stdout.write(`${ESC}2K`);
  process.stdout.write(tickerLine);

  // Restore cursor position
  process.stdout.write(`${ESC}u`);
}

/**
 * Initialize the status bar: set scroll region, register agents, paint initial state.
 * @param {string[]} agents - Agent names to display
 */
export function initStatusBar(agents) {
  if (!isTTYCapable()) return;

  registeredAgents = (agents || []).map((a) => a.toLowerCase());

  // Initialize all agents as inactive
  for (const agent of registeredAgents) {
    if (!agentState.has(agent)) {
      setAgentActivity(agent, 'inactive', 'Inactive');
    }
  }

  statusBarActive = true;
  setScrollRegion();
  drawStatusBar();

  // Handle terminal resize
  process.stdout.on('resize', onResize);
}

/**
 * Destroy the status bar: reset scroll region, clear footer lines.
 */
export function destroyStatusBar() {
  if (!statusBarActive) return;
  statusBarActive = false;

  process.stdout.removeListener('resize', onResize);

  if (isTTYCapable()) {
    const { rows } = getTermSize();

    // Clear the status bar lines
    for (let i = STATUS_BAR_HEIGHT - 1; i >= 0; i--) {
      process.stdout.write(`${ESC}${rows - i};1H`);
      process.stdout.write(`${ESC}2K`);
    }

    // Reset scroll region to full terminal
    resetScrollRegion();
  }
}

function onResize() {
  if (!statusBarActive) return;
  setScrollRegion();
  drawStatusBar();
}

// ── Metrics Event Listener ──────────────────────────────────────────────────

function setupMetricsListener() {
  metricsEmitter.on('call:start', ({ agent, model }) => {
    const modelShort = String(model || '').replace(/^claude-/, '').replace(/^gemini-/, '');
    setAgentActivity(agent, 'working', `Calling ${modelShort}...`);
    drawStatusBar();
  });

  metricsEmitter.on('call:complete', ({ agent }) => {
    setAgentActivity(agent, 'idle', 'Idle');
    drawStatusBar();
  });

  metricsEmitter.on('call:error', ({ agent, error }) => {
    const errorShort = String(error || 'Error').slice(0, 30);
    setAgentActivity(agent, 'error', errorShort);
    drawStatusBar();
  });
}

// Set up listeners immediately on import
setupMetricsListener();

// ── SSE Event Stream ────────────────────────────────────────────────────────

let sseRequest = null;
let sseReconnectTimer = null;
const SSE_RECONNECT_DELAY_MS = 3000;

function handleSSEEvent(data, agents) {
  let event;
  try {
    event = JSON.parse(data);
  } catch {
    return;
  }

  const payload = event?.payload;
  if (!payload?.event) return;

  const agentList = new Set(agents.map((a) => a.toLowerCase()));

  switch (payload.event) {
    case 'handoff_ack': {
      const agent = String(payload.agent || '').toLowerCase();
      if (agentList.has(agent)) {
        setAgentActivity(agent, 'working', `Ack'd ${payload.handoffId || '?'}`);
        pushTickerEvent(`${agent} ack'd ${payload.handoffId || '?'}`);
        emitActivityEvent({ event: 'handoff_ack', agent, detail: payload.handoffId });
      }
      break;
    }
    case 'handoff': {
      const to = String(payload.to || '').toLowerCase();
      const from = String(payload.from || '').toLowerCase();
      if (agentList.has(to)) {
        setAgentActivity(to, 'idle', `Handoff from ${from}`);
        pushTickerEvent(`${from}\u2192${to} handoff`);
        emitActivityEvent({ event: 'handoff', agent: to, detail: `from ${from}` });
      }
      break;
    }
    case 'task_claim': {
      const agent = String(payload.agent || '').toLowerCase();
      if (agentList.has(agent)) {
        const title = String(payload.title || '').slice(0, 40);
        setAgentActivity(agent, 'working', title || 'Working');
        pushTickerEvent(`${agent} claimed ${title || 'task'}`);
        emitActivityEvent({ event: 'task_claim', agent, detail: title });
      }
      break;
    }
    case 'task_add': {
      const owner = String(payload.owner || '').toLowerCase();
      const title = String(payload.title || '').slice(0, 40);
      pushTickerEvent(`task added: ${title}`);
      if (agentList.has(owner)) {
        emitActivityEvent({ event: 'task_add', agent: owner, detail: title });
      }
      break;
    }
    case 'task_update': {
      const status = String(payload.status || '').toLowerCase();
      const owner = String(payload.owner || '').toLowerCase();
      if (status === 'done') {
        if (agentList.has(owner)) {
          setAgentActivity(owner, 'idle', 'Done');
        }
        pushTickerEvent(`${payload.taskId || '?'} done`);
        emitActivityEvent({ event: 'task_done', agent: owner, detail: payload.taskId });
      } else if (status === 'blocked') {
        if (agentList.has(owner)) {
          setAgentActivity(owner, 'error', 'Blocked');
        }
        pushTickerEvent(`${payload.taskId || '?'} blocked`);
      }
      break;
    }
    case 'verify': {
      const passed = payload.passed;
      const taskId = payload.taskId || '?';
      pushTickerEvent(`verify ${taskId}: ${passed ? 'PASS' : 'FAIL'}`);
      emitActivityEvent({ event: 'verify', agent: '', detail: `${taskId} ${passed ? 'passed' : 'failed'}` });
      break;
    }
    case 'decision': {
      const title = String(payload.title || '').slice(0, 40);
      pushTickerEvent(`decision: ${title}`);
      break;
    }
    default:
      break;
  }

  drawStatusBar();
}

/**
 * Connect to the daemon's SSE event stream.
 * Falls back to polling if SSE connection fails.
 * @param {string} baseUrl - Daemon base URL (e.g. http://127.0.0.1:4173)
 * @param {string[]} agents - Agent names to track
 */
export function startEventStream(baseUrl, agents) {
  if (!isTTYCapable()) return;

  const agentList = (agents || []).map((a) => a.toLowerCase());
  const url = new URL('/events/stream', baseUrl);

  function connect() {
    if (sseReconnectTimer) {
      clearTimeout(sseReconnectTimer);
      sseReconnectTimer = null;
    }

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: { Accept: 'text/event-stream' },
    };

    sseRequest = http.get(options, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        fallbackToPolling(baseUrl, agentList);
        return;
      }

      res.setEncoding('utf8');
      let buffer = '';

      res.on('data', (chunk) => {
        buffer += chunk;
        // Process complete SSE messages (terminated by \n\n)
        const messages = buffer.split('\n\n');
        // Keep the last incomplete chunk
        buffer = messages.pop() || '';

        for (const msg of messages) {
          const lines = msg.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              handleSSEEvent(line.slice(6), agentList);
            }
            // Ignore comment lines (:ok, :keepalive)
          }
        }
      });

      res.on('end', () => {
        // Connection closed — reconnect after delay
        sseReconnectTimer = setTimeout(() => connect(), SSE_RECONNECT_DELAY_MS);
        if (sseReconnectTimer.unref) sseReconnectTimer.unref();
      });

      res.on('error', () => {
        sseReconnectTimer = setTimeout(() => connect(), SSE_RECONNECT_DELAY_MS);
        if (sseReconnectTimer.unref) sseReconnectTimer.unref();
      });
    });

    sseRequest.on('error', () => {
      // Initial connection failed — fall back to polling
      fallbackToPolling(baseUrl, agentList);
    });

    // Don't keep process alive
    if (sseRequest.socket) {
      sseRequest.socket.unref();
    }
    sseRequest.on('socket', (socket) => {
      if (socket.unref) socket.unref();
    });
  }

  connect();
}

/**
 * Stop the SSE event stream and any reconnect timers.
 */
export function stopEventStream() {
  if (sseRequest) {
    try { sseRequest.destroy(); } catch { /* ignore */ }
    sseRequest = null;
  }
  if (sseReconnectTimer) {
    clearTimeout(sseReconnectTimer);
    sseReconnectTimer = null;
  }
  stopFallbackPolling();
}

// ── Fallback Polling ────────────────────────────────────────────────────────

let pollInterval = null;
const POLL_INTERVAL_MS = 2000;

function fallbackToPolling(baseUrl, agents) {
  if (pollInterval) return; // already polling
  startFallbackPolling(baseUrl, agents);
}

/**
 * Start polling the daemon for agent activity updates (fallback when SSE unavailable).
 * @param {string} baseUrl - Daemon base URL
 * @param {string[]} agents - Agent names to poll
 */
function startFallbackPolling(baseUrl, agents) {
  if (pollInterval) return;
  if (!isTTYCapable()) return;

  const agentList = (agents || []).map((a) => a.toLowerCase());

  pollInterval = setInterval(async () => {
    for (const agent of agentList) {
      const current = getAgentActivity(agent);
      // Don't overwrite real-time working state from metrics events
      if (current.status === 'working') continue;

      try {
        const url = new URL(`/next?agent=${encodeURIComponent(agent)}`, baseUrl);
        const res = await fetch(url.href, { signal: AbortSignal.timeout(1500) });
        if (!res.ok) continue;
        const data = await res.json();
        const action = data?.next?.action;

        if (action === 'continue_task' || action === 'pickup_handoff') {
          setAgentActivity(agent, 'idle', `Pending: ${action.replace(/_/g, ' ')}`);
        } else if (action === 'idle') {
          setAgentActivity(agent, 'idle', 'Idle');
        } else if (action === 'resolve_blocker') {
          setAgentActivity(agent, 'error', 'Blocked');
        } else if (action && action !== 'unknown') {
          setAgentActivity(agent, 'idle', action.replace(/_/g, ' '));
        } else if (current.status === 'inactive') {
          setAgentActivity(agent, 'idle', 'Idle');
        }
      } catch {
        // Network error - don't change state, just skip
      }
    }
    drawStatusBar();
  }, POLL_INTERVAL_MS);

  // Don't let the poll interval keep the process alive
  if (pollInterval.unref) {
    pollInterval.unref();
  }
}

function stopFallbackPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

// ── Legacy Exports (backward compat) ────────────────────────────────────────

/**
 * @deprecated Use startEventStream() instead. Kept for backward compatibility.
 */
export function startPolling(baseUrl, agents) {
  // Try SSE first, fall back to polling automatically
  startEventStream(baseUrl, agents);
}

/**
 * @deprecated Use stopEventStream() instead. Kept for backward compatibility.
 */
export function stopPolling() {
  stopEventStream();
}
