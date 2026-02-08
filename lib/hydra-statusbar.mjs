/**
 * Hydra Status Bar - Persistent agent status footer pinned to the terminal bottom.
 *
 * Uses ANSI scroll regions to confine normal output to the upper portion of the
 * terminal, keeping a 2-line status bar fixed at the bottom showing each agent's
 * current activity and health icon.
 *
 * Gracefully degrades to no-op when !process.stdout.isTTY or terminal < 10 rows.
 */

import { metricsEmitter } from './hydra-metrics.mjs';
import {
  AGENT_ICONS,
  AGENT_COLORS,
  HEALTH_ICONS,
  formatAgentStatus,
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

// ── Scroll Region & Rendering ───────────────────────────────────────────────

const ESC = '\x1b[';
const STATUS_BAR_HEIGHT = 2; // divider line + agent status line
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
  // Set scroll region: rows 1 through (rows - 2)
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
 * Build the 2-line status bar content.
 */
function buildStatusBar() {
  const { cols } = getTermSize();

  // Line 1: divider
  const dividerLine = DIM('\u2500'.repeat(cols));

  // Line 2: agent segments joined by │
  const segments = [];
  for (const agent of registeredAgents) {
    const state = getAgentActivity(agent);
    // Calculate max width per agent segment (leave room for separators)
    const separatorChars = Math.max(0, registeredAgents.length - 1) * 3; // ' │ '
    const maxPerAgent = Math.max(12, Math.floor((cols - separatorChars) / registeredAgents.length));
    segments.push(formatAgentStatus(agent, state.status, state.action, maxPerAgent));
  }

  const agentLine = segments.join(DIM('  \u2502  '));

  return { dividerLine, agentLine };
}

/**
 * Paint the status bar at the bottom of the terminal.
 */
export function drawStatusBar() {
  if (!statusBarActive || !isTTYCapable()) return;
  const { rows, cols } = getTermSize();
  const { dividerLine, agentLine } = buildStatusBar();

  // Save cursor position
  process.stdout.write(`${ESC}s`);

  // Move to divider line (row = rows - 1) and clear it
  process.stdout.write(`${ESC}${rows - 1};1H`);
  process.stdout.write(`${ESC}2K`); // clear entire line
  process.stdout.write(dividerLine);

  // Move to agent line (row = rows) and clear it
  process.stdout.write(`${ESC}${rows};1H`);
  process.stdout.write(`${ESC}2K`);
  process.stdout.write(agentLine);

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
    const { rows, cols } = getTermSize();

    // Clear the status bar lines
    process.stdout.write(`${ESC}${rows - 1};1H`);
    process.stdout.write(`${ESC}2K`);
    process.stdout.write(`${ESC}${rows};1H`);
    process.stdout.write(`${ESC}2K`);

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

// ── Daemon Polling ──────────────────────────────────────────────────────────

let pollInterval = null;
const POLL_INTERVAL_MS = 2000;

/**
 * Start polling the daemon for agent activity updates.
 * Only updates agents not currently in 'working' state.
 * @param {string} baseUrl - Daemon base URL
 * @param {string[]} agents - Agent names to poll
 */
export function startPolling(baseUrl, agents) {
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
        // Network error — don't change state, just skip
      }
    }
    drawStatusBar();
  }, POLL_INTERVAL_MS);

  // Don't let the poll interval keep the process alive
  if (pollInterval.unref) {
    pollInterval.unref();
  }
}

/**
 * Stop daemon polling.
 */
export function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}
