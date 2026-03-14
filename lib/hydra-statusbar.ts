/**
 * Hydra Status Bar - Persistent agent status footer pinned to the terminal bottom.
 *
 * Uses ANSI scroll regions to confine normal output to the upper portion of the
 * terminal, keeping a 5-line status bar fixed at the bottom showing context/gauge,
 * each agent's current activity with rich metadata, and a rolling activity ticker.
 *
 * Supports two data sources:
 *   - SSE event stream from daemon (/events/stream) — preferred, real-time
 *   - Fallback polling (/next?agent=...) — used when SSE unavailable
 *
 * Gracefully degrades to no-op when !process.stdout.isTTY or terminal < 10 rows.
 */

/* eslint-disable @typescript-eslint/no-unsafe-member-access -- statusbar handles dynamic daemon response data */
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- statusbar handles dynamic daemon response data */
/* eslint-disable @typescript-eslint/no-explicit-any -- statusbar uses dynamic daemon response types */
/* eslint-disable @typescript-eslint/strict-boolean-expressions -- statusbar uses standard JS truthiness */
/* eslint-disable @typescript-eslint/no-unsafe-argument -- statusbar handles dynamic daemon response data */

import http from 'node:http';
import type { ClientRequest } from 'node:http';
import pc from 'picocolors';
import { metricsEmitter, getSessionUsage, checkSLOs } from './hydra-metrics.ts';
import { loadHydraConfig } from './hydra-config.ts';
import {
  formatAgentStatus,
  formatElapsed,
  stripAnsi,
  shortModelName,
  DIM,
  ACCENT,
} from './hydra-ui.ts';
import { checkUsage } from './hydra-usage.ts';

// ── Agent Activity State ────────────────────────────────────────────────────

interface AgentActivityState {
  status: string;
  action: string;
  model: string | null;
  taskTitle: string | null;
  phase: string | null;
  step: string | null;
  updatedAt: number;
}

const agentState = new Map<string, AgentActivityState>();
const agentExecMode = new Map<string, string | null>(); // agent -> 'worker' | 'terminal' | null

/**
 * Set an agent's activity state.
 * @param {string} agent - Agent name (gemini, codex, claude)
 * @param {'inactive'|'idle'|'working'|'error'} status
 * @param {string} [action] - Current action description
 * @param {object} [meta] - Optional metadata
 * @param {string} [meta.model] - Compact model name
 * @param {string} [meta.taskTitle] - What they're working on
 * @param {string} [meta.phase] - Council phase name
 * @param {string} [meta.step] - Progress like "2/4"
 */
export function setAgentActivity(
  agent: string,
  status: string,
  action: string,
  meta: {
    model?: string | null;
    taskTitle?: string | null;
    phase?: string | null;
    step?: string | null;
  } = {},
): void {
  agentState.set(agent.toLowerCase(), {
    status: status || 'inactive',
    action: action || '',
    model: meta.model ?? null,
    taskTitle: meta.taskTitle ?? null,
    phase: meta.phase ?? null,
    step: meta.step ?? null,
    updatedAt: Date.now(),
  });
}

/**
 * Set the execution mode indicator for an agent.
 * @param {string} agent
 * @param {'worker'|'terminal'|null} mode
 */
export function setAgentExecMode(agent: string, mode: string | null): void {
  agentExecMode.set(agent.toLowerCase(), mode ?? null);
}

/**
 * Get the execution mode for an agent.
 * @param {string} agent
 * @returns {'worker'|'terminal'|null}
 */
export function getAgentExecMode(agent: string): string | null {
  return agentExecMode.get(agent.toLowerCase()) ?? null;
}

/**
 * Get an agent's current activity state.
 */
export function getAgentActivity(agent: string): {
  status: string;
  action: string;
  model: string | null;
  taskTitle: string | null;
  phase: string | null;
  step: string | null;
  updatedAt: number;
} {
  return (
    agentState.get(agent.toLowerCase()) ?? {
      status: 'inactive',
      action: '',
      model: null,
      taskTitle: null,
      phase: null,
      step: null,
      updatedAt: 0,
    }
  );
}

// ── Activity Event Buffer ───────────────────────────────────────────────────

const MAX_TICKER_EVENTS = 3;
const tickerEvents: Array<{ time: string; text: string }> = [];
const activityCallbacks: Array<(event: any) => void> = [];

// Event type icons for visual scanning
const TICKER_ICONS = {
  claim: '\u26A1', // ⚡
  handoff: '\u2192', // →
  done: '\u2713', // ✓
  error: '\u2717', // ✗
  verify_pass: '\u{1F50D}', // 🔍
  verify_fail: '\u2717', // ✗
  decision: '\u{1F4CB}', // 📋
  stale: '\u{1F552}', // 🕒
  add: '\u002B', // +
  blocked: '\u26D4', // ⛔
};

function pushTickerEvent(text: string, eventType: string | null = null) {
  const time = new Date().toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const icon =
    eventType && (TICKER_ICONS as Record<string, string>)[eventType]
      ? `${(TICKER_ICONS as Record<string, string>)[eventType]} `
      : '';
  tickerEvents.push({ time, text: icon + text });
  if (tickerEvents.length > MAX_TICKER_EVENTS) {
    tickerEvents.shift();
  }
}

/**
 * Register a callback for significant activity events.
 * Callback receives { time, event, agent, detail }.
 */
export function onActivityEvent(
  callback: (event: { event: string; agent: string; detail: string }) => void,
): void {
  if (typeof callback === 'function') {
    activityCallbacks.push(callback);
  }
}

function emitActivityEvent(event: any) {
  for (const cb of activityCallbacks) {
    try {
      cb(event);
    } catch {
      /* ignore */
    }
  }
}

// ── Scroll Region & Rendering ───────────────────────────────────────────────

const ESC = '\x1b[';
const STATUS_BAR_HEIGHT = 5; // divider + context/gauge + agents + ticker + spacer
let statusBarActive = false;
let registeredAgents: string[] = [];
let refreshInterval: ReturnType<typeof setInterval> | null = null;
let _prevStatusBarRows = 0; // track previous terminal height for resize cleanup
const REFRESH_INTERVAL_MS = 2000; // periodic redraw to keep status bar content fresh

// ── Context Line State ──────────────────────────────────────────────────────

let lastDispatch = { route: '', tier: '', agent: '', mode: '' };
let openTaskCount = 0;
let activeMode = 'auto';

// ── Dispatch Context State ───────────────────────────────────────────────

let dispatchContext: Record<string, any> | null = null;

/**
 * Set active dispatch context for status bar narrative display.
 * @param {{ promptSummary: string, topic: string, tier: string, startedAt: number }} ctx
 */
export function setDispatchContext(ctx: Record<string, unknown> | null): void {
  dispatchContext = ctx ? { ...ctx, startedAt: ctx['startedAt'] ?? Date.now() } : null;
}

/**
 * Clear active dispatch context (call after dispatch completes).
 */
export function clearDispatchContext(): void {
  dispatchContext = null;
}

// Token gauge (cached to avoid expensive disk reads)
let cachedUsage: any = null;
let cachedUsageAt = 0;
const USAGE_CACHE_TTL_MS = 30_000;

/**
 * Record the last dispatch routing decision for the context line.
 */
export function setLastDispatch(info: Record<string, unknown>): void {
  lastDispatch = { ...lastDispatch, ...info };
}

/**
 * Set the active operator mode for the context line.
 */
export function setActiveMode(mode: string): void {
  activeMode = mode || 'auto';
}

/**
 * Update the open task count displayed in the context line.
 */
export function updateTaskCount(count: number): void {
  openTaskCount = Math.max(0, count || 0);
}

function isTTYCapable() {
  return process.stdout.isTTY && (process.stdout.rows || 0) >= 10;
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
  process.stdout.write(`${ESC}1;${String(scrollBottom)}r`);
  // Move cursor back into the scroll region
  process.stdout.write(`${ESC}${String(scrollBottom)};1H`);
}

/**
 * Reset scroll region to full terminal.
 */
function resetScrollRegion() {
  const { rows } = getTermSize();
  process.stdout.write(`${ESC}1;${String(rows)}r`);
  process.stdout.write(`${ESC}${String(rows)};1H`);
}

function buildContextLeftParts(): string[] {
  const MODE_ICONS: Record<string, string> = {
    smart: '\u26A1', // ⚡
    auto: '\u21BB', // ↻
    handoff: '\u2192', // →
    council: '\u2694', // ⚔
    dispatch: '\u2699', // ⚙
    chat: '\u2B22', // ⬢
  };
  const modeIcon = MODE_ICONS[activeMode] || '\u2022';
  const modePart = ACCENT(`${modeIcon} ${activeMode}`);
  const taskPart = `${String(openTaskCount)} task${openTaskCount === 1 ? '' : 's'}`;
  const lastPart = lastDispatch.route ? `last: ${lastDispatch.route}` : '';
  const parts = [modePart, DIM(taskPart)];
  if (dispatchContext?.['promptSummary']) {
    const tierBadge = dispatchContext['tier'] ? `[${String(dispatchContext['tier'])}]` : '';
    parts.push(ACCENT(`${tierBadge} ${String(dispatchContext['promptSummary'])}`));
  } else if (lastPart) {
    parts.push(DIM(lastPart));
  }
  const routingMode = loadHydraConfig().routing.mode;
  let modeChip: string;
  if (routingMode === 'economy') {
    modeChip = pc.yellow('\u25C6ECO');
  } else if (routingMode === 'performance') {
    modeChip = pc.cyan('\u25C6PERF');
  } else {
    modeChip = '';
  }
  if (modeChip) parts.push(modeChip);
  return parts;
}

function buildSloIndicator(): string {
  try {
    const cfg = loadHydraConfig();
    const cfgMetrics = cfg.metrics;
    if (
      cfgMetrics?.['slo'] &&
      (cfgMetrics['alerts'] as Record<string, unknown>)['enabled'] !== false
    ) {
      const violations = checkSLOs(cfgMetrics['slo'] as Record<string, never>);
      if (violations.length > 0) {
        const hasCritical = violations.some((v) => v.metric === 'error_rate');
        return hasCritical ? ` ${pc.red('\u26A0 SLO')}` : ` ${pc.yellow('\u26A0 SLO')}`;
      }
    }
  } catch {
    /* skip */
  }
  return '';
}

function buildContextRightText(): string {
  try {
    const now = Date.now();
    if (!cachedUsage || now - cachedUsageAt > USAGE_CACHE_TTL_MS) {
      cachedUsage = checkUsage();
      cachedUsageAt = now;
    }
    const usage = cachedUsage;
    let costStr = '';
    try {
      const session = getSessionUsage();
      if (session.costUsd > 0) {
        costStr = `$${session.costUsd < 1 ? session.costUsd.toFixed(3) : session.costUsd.toFixed(2)}`;
      }
    } catch {
      /* skip */
    }
    const todayTokens = usage?.todayTokens ?? 0;
    if (todayTokens > 0) {
      let tokenStr: string;
      if (todayTokens >= 1_000_000) {
        tokenStr = `${(todayTokens / 1_000_000).toFixed(1)}M`;
      } else if (todayTokens >= 1_000) {
        tokenStr = `${(todayTokens / 1_000).toFixed(0)}K`;
      } else {
        tokenStr = String(todayTokens);
      }
      const parts = [];
      if (costStr) parts.push(DIM(costStr));
      parts.push(DIM(`${tokenStr} today`));
      return parts.join('  ');
    } else if (costStr) {
      return DIM(costStr);
    }
    return '';
  } catch {
    return DIM('n/a');
  }
}

/**
 * Build the context + token gauge line (line 2 of status bar).
 */
function buildContextLine(cols: number) {
  const leftParts = buildContextLeftParts();
  const leftText = ` ${leftParts.join(DIM('  \u2502  '))}`;
  const sloIndicator = buildSloIndicator();
  const rightText = buildContextRightText();
  const leftStripped = stripAnsi(leftText);
  const fullRight = sloIndicator ? rightText + sloIndicator : rightText;
  const rightStripped = stripAnsi(fullRight);
  const gap = Math.max(1, cols - leftStripped.length - rightStripped.length);
  return leftText + ' '.repeat(gap) + fullRight;
}

function buildAgentActionText(state: AgentActivityState): string {
  if (state.status !== 'working') return state.action || state.status || 'Inactive';
  let label = '';
  if (state.taskTitle) {
    label = state.taskTitle;
  } else if (state.action && !state.action.startsWith('Calling ')) {
    label = state.action;
  } else if (state.action) {
    label = state.action;
  }
  const stepSuffix = state.step ? ` [${state.step}]` : '';
  return label ? `${label}${stepSuffix}` : `Working${stepSuffix}`;
}

function buildAgentSegments(cols: number): string {
  const agentSep = '  \u2502  '; // "  │  " = 5 visible chars
  const separatorChars = Math.max(0, registeredAgents.length - 1) * 5;
  const maxPerAgent = Math.max(16, Math.floor((cols - separatorChars) / registeredAgents.length));
  const segments = [];
  for (const agent of registeredAgents) {
    const state = getAgentActivity(agent);
    const elapsed =
      state.updatedAt && state.status === 'working'
        ? ` ${formatElapsed(Date.now() - state.updatedAt)}`
        : '';
    const actionText = buildAgentActionText(state);
    const execMode = agentExecMode.get(agent);
    let modeSuffix: string;
    if (execMode === 'worker') {
      modeSuffix = DIM('[W]');
    } else if (execMode === 'terminal') {
      modeSuffix = DIM('[T]');
    } else {
      modeSuffix = '';
    }
    const actionWithElapsed = `${actionText}${elapsed}${modeSuffix ? ` ${modeSuffix}` : ''}`;
    segments.push(formatAgentStatus(agent, state.status, actionWithElapsed, maxPerAgent));
  }
  return segments.join(DIM(agentSep));
}

function buildTickerLine(cols: number): string {
  if (tickerEvents.length === 0) return DIM('  \u21B3 awaiting events...');
  const parts = tickerEvents.map((e) => `${DIM(e.time)} ${e.text}`);
  let line = `  \u21B3 ${parts.join(DIM('  \u00B7  '))}`;
  if (stripAnsi(line).length > cols) {
    line = `  \u21B3 ${parts.slice(-2).join(DIM('  \u00B7  '))}`;
  }
  return line;
}

/**
 * Build the 5-line status bar content.
 */
function buildStatusBar() {
  const { cols } = getTermSize();
  const dividerLine = DIM('\u2500'.repeat(cols));
  const contextLine = buildContextLine(cols);
  const agentLine = buildAgentSegments(cols);
  const tickerLine = buildTickerLine(cols);
  const spacerLine = '';
  return { dividerLine, contextLine, agentLine, tickerLine, spacerLine };
}

/**
 * Paint the status bar at the bottom of the terminal.
 */
export function drawStatusBar({ skipCursorSaveRestore = false } = {}): void {
  if (!statusBarActive || !isTTYCapable()) return;
  const { rows, cols } = getTermSize();
  const { dividerLine, contextLine, agentLine, tickerLine, spacerLine } = buildStatusBar();

  // Overwrite each line in one write (content + spaces to fill width).
  // Avoids the erase (\x1b[2K) + write pattern which causes a brief blank flash.
  const pad = (s: string) => s + ' '.repeat(Math.max(0, cols - stripAnsi(s).length));

  // Save cursor position (caller may handle this externally)
  if (!skipCursorSaveRestore) process.stdout.write(`${ESC}s`);

  process.stdout.write(`${ESC}${String(rows - 4)};1H${pad(dividerLine)}`); // divider
  process.stdout.write(`${ESC}${String(rows - 3)};1H${pad(contextLine)}`); // context + gauge
  process.stdout.write(`${ESC}${String(rows - 2)};1H${pad(agentLine)}`); // agent status
  process.stdout.write(`${ESC}${String(rows - 1)};1H${pad(tickerLine)}`); // activity ticker
  process.stdout.write(`${ESC}${String(rows)};1H${pad(spacerLine)}`); // spacer

  // Restore cursor position (caller may handle this externally)
  if (!skipCursorSaveRestore) process.stdout.write(`${ESC}u`);
}

/**
 * Initialize the status bar: set scroll region, register agents, paint initial state.
 * @param {string[]} agents - Agent names to display
 */
export function initStatusBar(agents: string[]): void {
  if (!isTTYCapable()) return;

  registeredAgents = agents.map((a: string) => a.toLowerCase());

  // Initialize all agents as inactive
  for (const agent of registeredAgents) {
    if (!agentState.has(agent)) {
      setAgentActivity(agent, 'inactive', 'Inactive');
    }
  }

  statusBarActive = true;
  _prevStatusBarRows = getTermSize().rows;
  setScrollRegion();
  drawStatusBar();

  // Handle terminal resize
  process.stdout.on('resize', onResize);

  // Periodic refresh to keep status bar content (elapsed timers, ticker, etc.) fresh.
  // NOTE: setScrollRegion() is intentionally NOT called here. DECSTBM (\x1b[r) resets
  // the terminal cursor to (1,1), and in Windows Terminal this overwrites the position
  // saved by \x1b[s, causing \x1b[u to restore to the wrong row and placing readline's
  // prompt inside the status bar area (input gobbling). The scroll region is established
  // once at startup and on terminal resize — that is sufficient.
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(() => {
    if (statusBarActive) {
      process.stdout.write(`${ESC}s`);
      drawStatusBar({ skipCursorSaveRestore: true });
      process.stdout.write(`${ESC}u`);
    }
  }, REFRESH_INTERVAL_MS);
  refreshInterval.unref();
}

/**
 * Destroy the status bar: reset scroll region, clear footer lines.
 */
export function destroyStatusBar(): void {
  if (!statusBarActive) return;
  statusBarActive = false;

  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
  process.stdout.removeListener('resize', onResize);

  if (isTTYCapable()) {
    const { rows } = getTermSize();

    // Clear the status bar lines
    for (let i = STATUS_BAR_HEIGHT - 1; i >= 0; i--) {
      process.stdout.write(`${ESC}${String(rows - i)};1H`);
      process.stdout.write(`${ESC}2K`);
    }

    // Reset scroll region to full terminal
    resetScrollRegion();
  }
}

function onResize() {
  if (!statusBarActive) return;
  const { rows: newRows } = getTermSize();

  process.stdout.write(`${ESC}s`);

  // Clear old status bar lines before redrawing at new positions.
  // Without this, stale lines at the old terminal height remain on screen.
  if (_prevStatusBarRows > 0 && _prevStatusBarRows !== newRows) {
    for (let i = STATUS_BAR_HEIGHT - 1; i >= 0; i--) {
      process.stdout.write(`${ESC}${String(_prevStatusBarRows - i)};1H${ESC}2K`);
    }
  }
  _prevStatusBarRows = newRows;

  setScrollRegion();
  drawStatusBar({ skipCursorSaveRestore: true });
  process.stdout.write(`${ESC}u`);
}

// ── Metrics Event Listener ──────────────────────────────────────────────────

function setupMetricsListener() {
  metricsEmitter.on('call:start', ({ agent, model }) => {
    const modelShort = shortModelName(model);
    setAgentActivity(agent, 'working', `Calling ${modelShort}...`, { model: modelShort });
    drawStatusBar();
  });

  metricsEmitter.on('call:complete', ({ agent }) => {
    setAgentActivity(agent, 'idle', 'Idle');
    drawStatusBar();
  });

  metricsEmitter.on('call:error', ({ agent, error }) => {
    const errorShort = String(error ?? 'Error').slice(0, 30);
    setAgentActivity(agent, 'error', errorShort);
    drawStatusBar();
  });
}

// Set up listeners immediately on import
setupMetricsListener();

// ── SSE Event Stream ────────────────────────────────────────────────────────

let sseRequest: ClientRequest | null = null;
let sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
const SSE_RECONNECT_DELAY_MS = 3000;

function handleHandoffAckEvent(payload: Record<string, any>, agentList: Set<string>): void {
  const agent = String(payload['agent'] ?? '').toLowerCase();
  if (agentList.has(agent)) {
    const hSummary = payload['summary'] ? ` (${String(payload['summary']).slice(0, 30)})` : '';
    setAgentActivity(agent, 'working', `Ack'd ${String(payload['handoffId'] ?? '?')}`);
    pushTickerEvent(`${agent} ack'd ${String(payload['handoffId'] ?? '?')}${hSummary}`, 'handoff');
    emitActivityEvent({
      event: 'handoff_ack',
      agent,
      detail: `${String(payload['handoffId'] ?? '')}${hSummary}`,
    });
  }
}

function handleHandoffEvent(payload: Record<string, any>, agentList: Set<string>): void {
  const to = String(payload['to'] ?? '').toLowerCase();
  const from = String(payload['from'] ?? '').toLowerCase();
  const hSummary = payload['summary'] ? ` (${String(payload['summary']).slice(0, 30)})` : '';
  if (agentList.has(to)) {
    const current = getAgentActivity(to);
    const recentlySet = current.updatedAt && Date.now() - current.updatedAt < 5000;
    const hasTaskTitle = current.taskTitle && current.taskTitle.length > 0;
    if (!(recentlySet && hasTaskTitle)) {
      setAgentActivity(to, 'idle', `Handoff from ${from}`);
    }
    pushTickerEvent(`${from}\u2192${to}${hSummary}`, 'handoff');
    emitActivityEvent({ event: 'handoff', agent: to, detail: `from ${from}${hSummary}` });
  }
}

function handleTaskClaimEvent(payload: Record<string, any>, agentList: Set<string>): void {
  const agent = String(payload['agent'] ?? '').toLowerCase();
  if (agentList.has(agent)) {
    const title = String(payload['title'] ?? '').slice(0, 40);
    setAgentActivity(agent, 'working', title.length > 0 ? title : 'Working', {
      taskTitle: title.length > 0 ? title : null,
    });
    pushTickerEvent(`${agent} claimed ${title.length > 0 ? title : 'task'}`, 'claim');
    emitActivityEvent({ event: 'task_claim', agent, detail: title });
  }
}

function handleTaskAddEvent(payload: Record<string, any>, agentList: Set<string>): void {
  const owner = String(payload['owner'] ?? '').toLowerCase();
  const title = String(payload['title'] ?? '').slice(0, 40);
  openTaskCount++;
  pushTickerEvent(title, 'add');
  if (agentList.has(owner)) {
    emitActivityEvent({ event: 'task_add', agent: owner, detail: title });
  }
}

function handleTaskUpdateEvent(payload: Record<string, any>, agentList: Set<string>): void {
  const status = String(payload['status'] ?? '').toLowerCase();
  const owner = String(payload['owner'] ?? '').toLowerCase();
  const tTitle = payload['title'] ? ` (${String(payload['title']).slice(0, 30)})` : '';
  if (status === 'done') {
    openTaskCount = Math.max(0, openTaskCount - 1);
    if (agentList.has(owner)) {
      setAgentActivity(owner, 'idle', 'Done');
    }
    pushTickerEvent(`${String(payload['taskId'] ?? '?')}${tTitle} done`, 'done');
    emitActivityEvent({
      event: 'task_done',
      agent: owner,
      detail: `${String(payload['taskId'] ?? '')}${tTitle}`,
    });
  } else if (status === 'blocked') {
    if (agentList.has(owner)) {
      setAgentActivity(owner, 'error', `Blocked \u2014 ${String(payload['taskId'] ?? '?')}`);
    }
    pushTickerEvent(`${String(payload['taskId'] ?? '?')}${tTitle} blocked`, 'blocked');
  }
}

function handleVerifyEvent(payload: Record<string, any>): void {
  const passed = payload['passed'];
  const taskId = String(payload['taskId'] ?? '?');
  pushTickerEvent(
    `verify ${taskId}: ${passed ? 'PASS' : 'FAIL'}`,
    passed ? 'verify_pass' : 'verify_fail',
  );
  emitActivityEvent({
    event: 'verify',
    agent: '',
    detail: `${taskId} ${passed ? 'passed' : 'failed'}`,
  });
}

function handleDecisionEvent(payload: Record<string, any>): void {
  const title = String(payload['title'] ?? '').slice(0, 40);
  pushTickerEvent(title, 'decision');
}

function handleTaskStaleEvent(payload: Record<string, any>, agentList: Set<string>): void {
  const owner = String(payload['owner'] ?? '').toLowerCase();
  const sTitle = payload['title'] ? ` (${String(payload['title']).slice(0, 30)})` : '';
  if (agentList.has(owner)) {
    setAgentActivity(owner, 'error', `${String(payload['taskId'] ?? '')} stale`);
  }
  pushTickerEvent(`${String(payload['taskId'] ?? '?')}${sTitle} stale (${owner})`, 'stale');
}

function handleSSEEvent(data: string, agents: string[]) {
  let event;
  try {
    event = JSON.parse(data);
  } catch {
    return;
  }

  const payload = event?.payload;
  if (!payload?.event) return;

  const agentList = new Set(agents.map((a) => a.toLowerCase()));

  switch (payload['event']) {
    case 'handoff_ack':
      handleHandoffAckEvent(payload, agentList);
      break;
    case 'handoff':
      handleHandoffEvent(payload, agentList);
      break;
    case 'task_claim':
      handleTaskClaimEvent(payload, agentList);
      break;
    case 'task_add':
      handleTaskAddEvent(payload, agentList);
      break;
    case 'task_update':
      handleTaskUpdateEvent(payload, agentList);
      break;
    case 'verify':
      handleVerifyEvent(payload);
      break;
    case 'decision':
      handleDecisionEvent(payload);
      break;
    case 'task_stale':
      handleTaskStaleEvent(payload, agentList);
      break;
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
export function startEventStream(baseUrl: string, agents: string[]): void {
  if (!isTTYCapable()) return;

  const agentList = agents.map((a) => a.toLowerCase());
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
        buffer += String(chunk);
        // Process complete SSE messages (terminated by \n\n)
        const messages = buffer.split('\n\n');
        // Keep the last incomplete chunk
        buffer = messages.pop() ?? '';

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
        sseReconnectTimer = setTimeout(() => {
          connect();
        }, SSE_RECONNECT_DELAY_MS);
        sseReconnectTimer.unref();
      });

      res.on('error', () => {
        sseReconnectTimer = setTimeout(() => {
          connect();
        }, SSE_RECONNECT_DELAY_MS);
        sseReconnectTimer.unref();
      });
    });

    sseRequest.on('error', () => {
      // Initial connection failed — fall back to polling
      fallbackToPolling(baseUrl, agentList);
    });

    // Don't keep process alive
    sseRequest.socket?.unref();
    sseRequest.on('socket', (socket) => {
      socket.unref();
    });
  }

  connect();
}

/**
 * Stop the SSE event stream and any reconnect timers.
 */
export function stopEventStream(): void {
  if (sseRequest) {
    try {
      sseRequest.destroy();
    } catch {
      /* ignore */
    }
    sseRequest = null;
  }
  if (sseReconnectTimer) {
    clearTimeout(sseReconnectTimer);
    sseReconnectTimer = null;
  }
  stopFallbackPolling();
}

// ── Fallback Polling ────────────────────────────────────────────────────────

let pollInterval: ReturnType<typeof setInterval> | null = null;
const POLL_INTERVAL_MS = 2000;

function fallbackToPolling(baseUrl: string, agents: string[]) {
  if (pollInterval) return; // already polling
  startFallbackPolling(baseUrl, agents);
}

/**
 * Start polling the daemon for agent activity updates (fallback when SSE unavailable).
 * @param {string} baseUrl - Daemon base URL
 * @param {string[]} agents - Agent names to poll
 */
function startFallbackPolling(baseUrl: string, agents: string[]) {
  if (pollInterval) return;
  if (!isTTYCapable()) return;

  const agentList = agents.map((a) => a.toLowerCase());

  pollInterval = setInterval(() => {
    void (async () => {
      for (const agent of agentList) {
        const current = getAgentActivity(agent);
        // Don't overwrite real-time working state from metrics events
        if (current.status === 'working') continue;

        try {
          const url = new URL(`/next?agent=${encodeURIComponent(agent)}`, baseUrl);
          // eslint-disable-next-line no-await-in-loop -- sequential processing required
          const res = await fetch(url.href, { signal: AbortSignal.timeout(1500) });
          if (!res.ok) continue;
          // eslint-disable-next-line no-await-in-loop -- sequential processing required
          const data = (await res.json()) as { next?: { action?: string } };
          const action = data.next?.action;

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
    })();
  }, POLL_INTERVAL_MS);

  // Don't let the poll interval keep the process alive
  pollInterval.unref();
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
export function startPolling(baseUrl: string, agents: string[]): void {
  // Try SSE first, fall back to polling automatically
  startEventStream(baseUrl, agents);
}

/**
 * @deprecated Use stopEventStream() instead. Kept for backward compatibility.
 */
export function stopPolling(): void {
  stopEventStream();
}
