/**
 * Read-only daemon routes (GET endpoints and SSE stream).
 */

import { buildSelfSnapshot } from '../hydra-self.ts';
import { handleOperationsReadRoute } from './web-operations-routes.ts';
import type {
  ReadRouteCtx,
  TaskEntry,
  HandoffEntry,
  BlockerEntry,
  DecisionEntry,
  ChildSessionEntry,
} from '../types.ts';

type EventEntry = { seq: number; at: string; type: string; category?: string; payload?: unknown };
type DaemonState = ReturnType<ReadRouteCtx['readState']>;
type SuggestNextFn = ReadRouteCtx['suggestNext'];
type RouteHandler = (ctx: ReadRouteCtx) => boolean | Promise<boolean>;

function handleHealth(ctx: ReadRouteCtx): boolean {
  const { res, sendJson, writeStatus, readStatus, checkUsage, getModelSummary } = ctx;
  writeStatus();
  const status = readStatus();
  let usageLevel = 'unknown';
  try {
    const usage = checkUsage();
    usageLevel = usage.level;
  } catch {
    // Best effort only.
  }
  let models: Record<string, string> = {};
  try {
    const summary = getModelSummary();
    models = Object.fromEntries(Object.entries(summary).map(([name, info]) => [name, info.active]));
  } catch {
    // Best effort only.
  }
  sendJson(res, 200, {
    ok: true,
    ...status,
    models,
    usage: { level: usageLevel },
  });
  return true;
}

function loadSelfStatus(
  writeStatus: ReadRouteCtx['writeStatus'],
  readStatus: ReadRouteCtx['readStatus'],
): Record<string, unknown> | null {
  try {
    writeStatus();
    return readStatus();
  } catch {
    return null;
  }
}

function loadSelfUsage(
  checkUsage: ReadRouteCtx['checkUsage'],
): ReturnType<ReadRouteCtx['checkUsage']> | null {
  try {
    return checkUsage();
  } catch {
    return null;
  }
}

function loadSelfModels(
  getModelSummary: ReadRouteCtx['getModelSummary'],
): ReturnType<ReadRouteCtx['getModelSummary']> | null {
  try {
    return getModelSummary();
  } catch {
    return null;
  }
}

function buildSelfDaemonField(status: Record<string, unknown> | null): Record<string, unknown> {
  return {
    ok: true,
    url: status?.['url'] ?? null,
    pid: status?.['pid'] ?? process.pid,
    startedAt: status?.['startedAt'] ?? null,
    status: status ?? null,
  };
}

function buildSelfRuntimeField(
  state: DaemonState,
  summary: Record<string, unknown> | null,
  usage: ReturnType<ReadRouteCtx['checkUsage']> | null,
  models: ReturnType<ReadRouteCtx['getModelSummary']> | null,
): Record<string, unknown> {
  return {
    updatedAt: state.updatedAt ?? null,
    activeSession: state.activeSession ?? null,
    summary: summary ?? null,
    counts: (summary as Record<string, unknown>)['counts'] ?? null,
    usage: usage ? { level: usage.level } : null,
    models: models
      ? Object.fromEntries(
          Object.entries(models)
            .filter(([k]) => k !== '_mode')
            .map(([k, v]) => [k, v.active === '' ? 'unknown' : v.active]),
        )
      : null,
  };
}

function handleSelf(ctx: ReadRouteCtx): boolean {
  const {
    res,
    sendJson,
    writeStatus,
    readStatus,
    checkUsage,
    getModelSummary,
    readState,
    getSummary,
    projectRoot,
    projectName,
  } = ctx;

  const status = loadSelfStatus(writeStatus, readStatus);
  const state = readState();
  const summary = getSummary(state);
  const usage = loadSelfUsage(checkUsage);
  const models = loadSelfModels(getModelSummary);

  const self = buildSelfSnapshot({
    projectRoot: projectRoot ?? '',
    projectName: projectName ?? (summary as Record<string, string | undefined>)['project'] ?? '',
    includeAgents: false,
    includeConfig: true,
    includeMetrics: true,
  });

  self['daemon'] = buildSelfDaemonField(status);
  self['runtime'] = buildSelfRuntimeField(state, summary, usage, models);

  sendJson(res, 200, { ok: true, self });
  return true;
}

function handleState(ctx: ReadRouteCtx): boolean {
  const { res, sendJson, readState } = ctx;
  sendJson(res, 200, { ok: true, state: readState() });
  return true;
}

function handleSummary(ctx: ReadRouteCtx): boolean {
  const { res, sendJson, readState, getSummary } = ctx;
  sendJson(res, 200, { ok: true, summary: getSummary(readState()) });
  return true;
}

function handlePrompt(ctx: ReadRouteCtx): boolean {
  const { res, sendJson, requestUrl, readState, buildPrompt } = ctx;
  const agent = (requestUrl.searchParams.get('agent') ?? 'generic').toLowerCase();
  sendJson(res, 200, { ok: true, agent, prompt: buildPrompt(agent, readState()) });
  return true;
}

function handleNext(ctx: ReadRouteCtx): boolean {
  const { res, sendJson, sendError, requestUrl, readState, suggestNext } = ctx;
  const agent = (requestUrl.searchParams.get('agent') ?? '').toLowerCase();
  if (agent === '') {
    sendError(res, 400, 'Missing query param: agent');
    return true;
  }
  sendJson(res, 200, { ok: true, next: suggestNext(readState(), agent) });
  return true;
}

function handleTaskCheckpoints(ctx: ReadRouteCtx): boolean {
  const { res, sendJson, sendError, route, readState } = ctx;
  let taskId = route.slice('/task/'.length, -'/checkpoints'.length);
  try {
    taskId = decodeURIComponent(taskId);
  } catch {
    // malformed percent-encoding — use raw value
  }
  const state = readState();
  const task = state.tasks.find((t: TaskEntry) => t.id === taskId);
  if (!task) {
    sendError(res, 404, `Task ${taskId} not found.`);
    return true;
  }
  sendJson(res, 200, { ok: true, taskId, checkpoints: task.checkpoints ?? [] });
  return true;
}

function handleEvents(ctx: ReadRouteCtx): boolean {
  const { res, sendJson, requestUrl, readEvents } = ctx;
  const limit = Number.parseInt(requestUrl.searchParams.get('limit') ?? '50', 10);
  sendJson(res, 200, { ok: true, events: readEvents(limit) });
  return true;
}

function handleEventsReplay(ctx: ReadRouteCtx): boolean {
  const { res, sendJson, requestUrl, replayEvents } = ctx;
  const fromSeq = Number.parseInt(requestUrl.searchParams.get('from') ?? '0', 10);
  const category = requestUrl.searchParams.get('category') ?? '';
  let events = replayEvents(fromSeq);
  if (category !== '') {
    events = events.filter((e: EventEntry) => e.category === category);
  }
  sendJson(res, 200, { ok: true, count: events.length, events });
  return true;
}

function handleEventsStream(ctx: ReadRouteCtx): boolean {
  const { req, res, sseClients } = ctx;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(':ok\n\n');
  sseClients.add(res);
  const keepalive = setInterval(() => {
    try {
      res.write(':keepalive\n\n');
    } catch {
      // Ignore write errors on disconnected clients.
    }
  }, 15_000);
  req.on('close', () => {
    sseClients.delete(res);
    clearInterval(keepalive);
  });
  return true;
}

function buildActivityAgents(
  state: DaemonState,
  suggestNext: SuggestNextFn,
): Record<string, unknown> {
  const agents: Record<string, unknown> = {};
  for (const name of ['claude', 'gemini', 'codex']) {
    const nextAction = suggestNext(state, name);
    const currentTask =
      state.tasks.find((t: TaskEntry) => t.owner === name && t.status === 'in_progress') ?? null;
    const pendingHandoffs = state.handoffs
      .filter(
        (h: HandoffEntry) => h.to === name && (h.acknowledgedAt == null || h.acknowledgedAt === ''),
      )
      .map((h: HandoffEntry) => ({
        id: h.id,
        from: h.from,
        summary: h.summary.slice(0, 200),
        createdAt: h.createdAt,
      }));
    agents[name] = {
      currentTask: currentTask
        ? {
            id: currentTask.id,
            title: currentTask.title,
            status: currentTask.status,
            type: currentTask.type,
            updatedAt: currentTask.updatedAt,
          }
        : null,
      pendingHandoffs,
      suggestedAction: nextAction.action,
    };
  }
  return agents;
}

interface ActivityTasks {
  inProgress: unknown[];
  todo: unknown[];
  blocked: unknown[];
  recentlyCompleted: unknown[];
}

function buildActivityTasks(state: DaemonState): ActivityTasks {
  const completedIds = new Set(
    state.tasks
      .filter((t: TaskEntry) => ['done', 'cancelled'].includes(t.status))
      .map((t: TaskEntry) => t.id),
  );
  const inProgress = state.tasks
    .filter((t: TaskEntry) => t.status === 'in_progress')
    .map((t: TaskEntry) => ({
      id: t.id,
      title: t.title,
      owner: t.owner,
      type: t.type,
      updatedAt: t.updatedAt,
    }));
  const todo = state.tasks
    .filter((t: TaskEntry) => t.status === 'todo')
    .map((t: TaskEntry) => ({ id: t.id, title: t.title, owner: t.owner, type: t.type }));
  const blocked = state.tasks
    .filter(
      (t: TaskEntry) =>
        t.status === 'blocked' ||
        (Array.isArray(t.blockedBy) && t.blockedBy.some((dep: string) => !completedIds.has(dep))),
    )
    .map((t: TaskEntry) => ({
      id: t.id,
      title: t.title,
      owner: t.owner,
      blockedBy: t.blockedBy,
    }));
  const recentlyCompleted = state.tasks
    .filter((t: TaskEntry) => t.status === 'done')
    .slice(-5)
    .map((t: TaskEntry) => ({
      id: t.id,
      title: t.title,
      owner: t.owner,
      updatedAt: t.updatedAt,
    }));
  return { inProgress, todo, blocked, recentlyCompleted };
}

interface ActivityHandoffsSummary {
  pendingHandoffs: unknown[];
  recentHandoffs: unknown[];
  recentDecisions: unknown[];
}

function buildActivityHandoffsSummary(state: DaemonState): ActivityHandoffsSummary {
  const pendingHandoffs = state.handoffs
    .filter((h: HandoffEntry) => h.acknowledgedAt == null || h.acknowledgedAt === '')
    .slice(-5)
    .map((h: HandoffEntry) => ({
      id: h.id,
      from: h.from,
      to: h.to,
      summary: h.summary.slice(0, 200),
      nextStep: (h.nextStep ?? '').slice(0, 200),
      tasks: h.tasks,
      createdAt: h.createdAt,
    }));
  const recentHandoffs = state.handoffs
    .filter((h: HandoffEntry) => h.acknowledgedAt != null && h.acknowledgedAt !== '')
    .slice(-5)
    .map((h: HandoffEntry) => ({
      id: h.id,
      from: h.from,
      to: h.to,
      summary: h.summary.slice(0, 200),
      acknowledgedBy: h.acknowledgedBy,
      createdAt: h.createdAt,
    }));
  const recentDecisions = state.decisions.slice(-3).map((d: DecisionEntry) => ({
    id: d.id,
    title: d.title,
    owner: d.owner,
    rationale: (d.rationale ?? '').slice(0, 200),
    createdAt: d.createdAt,
  }));
  return { pendingHandoffs, recentHandoffs, recentDecisions };
}

function handleActivity(ctx: ReadRouteCtx): boolean {
  const { res, sendJson, readState, suggestNext, readEvents } = ctx;
  const state = readState();
  const events = readEvents(50);
  const agents = buildActivityAgents(state, suggestNext);
  const { inProgress, todo, blocked, recentlyCompleted } = buildActivityTasks(state);
  const { pendingHandoffs, recentHandoffs, recentDecisions } = buildActivityHandoffsSummary(state);
  const recentEvents = events.slice(-20).map((e: EventEntry) => ({
    seq: e.seq,
    at: e.at,
    type: e.type,
    category: e.category,
    payload: e.payload,
  }));
  sendJson(res, 200, {
    ok: true,
    activity: {
      generatedAt: new Date().toISOString(),
      session: state.activeSession
        ? {
            id: state.activeSession.id,
            focus: state.activeSession.focus,
            status: state.activeSession.status,
            startedAt: state.activeSession.startedAt,
            updatedAt: state.activeSession.updatedAt,
          }
        : null,
      agents,
      tasks: { inProgress, todo, blocked, recentlyCompleted },
      handoffs: { pending: pendingHandoffs, recent: recentHandoffs },
      decisions: { recent: recentDecisions },
      recentEvents,
      counts: {
        tasksOpen: inProgress.length + todo.length,
        tasksInProgress: inProgress.length,
        tasksTodo: todo.length,
        tasksBlocked: blocked.length,
        tasksDone: state.tasks.filter((t: TaskEntry) => t.status === 'done').length,
        handoffsPending: pendingHandoffs.length,
        handoffsTotal: state.handoffs.length,
        blockersOpen: state.blockers.filter((b: BlockerEntry) => b.status !== 'resolved').length,
        decisions: state.decisions.length,
      },
    },
  });
  return true;
}

function handleStateArchive(ctx: ReadRouteCtx): boolean {
  const { res, sendJson, readArchive } = ctx;
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
  return true;
}

function handleSessions(ctx: ReadRouteCtx): boolean {
  const { res, sendJson, readState } = ctx;
  const state = readState();
  const active = state.activeSession ?? null;
  const children = state.childSessions ?? [];
  sendJson(res, 200, {
    ok: true,
    activeSession: active
      ? {
          id: active.id,
          type: active.type ?? 'root',
          focus: active.focus,
          status: active.status,
          children: active.children ?? [],
        }
      : null,
    childSessions: children.map((s: ChildSessionEntry) => ({
      id: s.id,
      type: s.type,
      parentId: s.parentId,
      focus: s.focus,
      status: s.status,
      children: s.children ?? [],
    })),
  });
  return true;
}

async function handleWorktrees(ctx: ReadRouteCtx): Promise<boolean> {
  const { res, sendJson, readState } = ctx;
  try {
    const { isWorktreeEnabled } = await import('../hydra-worktree.ts');
    const enabled = isWorktreeEnabled();
    const state = readState();
    const tasksWithWorktrees = state.tasks.filter(
      (t: TaskEntry) => t.worktreePath != null && t.worktreePath !== '',
    );
    sendJson(res, 200, {
      ok: true,
      enabled,
      worktrees: tasksWithWorktrees.map((t: TaskEntry) => ({
        taskId: t.id,
        path: t.worktreePath,
        branch: t.worktreeBranch,
        status: t.status,
      })),
    });
  } catch (err) {
    sendJson(res, 200, {
      ok: true,
      enabled: false,
      worktrees: [],
      error: (err as Error).message,
    });
  }
  return true;
}

function handleSessionStatus(ctx: ReadRouteCtx): boolean {
  const { res, sendJson, readState, suggestNext, readEvents } = ctx;
  const state = readState();
  const now = Date.now();
  const STALE_THRESHOLD_MS = 30 * 60 * 1000;

  const inProgressTasks = state.tasks.filter((t: TaskEntry) => t.status === 'in_progress');
  const staleTasks = inProgressTasks
    .filter((t: TaskEntry) => {
      const lastUpdate = t.updatedAt === '' ? 0 : new Date(t.updatedAt).getTime();
      return now - lastUpdate > STALE_THRESHOLD_MS;
    })
    .map((t: TaskEntry) => ({
      id: t.id,
      title: t.title,
      owner: t.owner,
      status: t.status,
      updatedAt: t.updatedAt,
      staleSince: new Date(new Date(t.updatedAt).getTime() + STALE_THRESHOLD_MS).toISOString(),
    }));

  const pendingHandoffs = state.handoffs
    .filter((h: HandoffEntry) => h.acknowledgedAt == null || h.acknowledgedAt === '')
    .map((h: HandoffEntry) => ({
      id: h.id,
      from: h.from,
      to: h.to,
      summary: h.summary,
      createdAt: h.createdAt,
    }));

  const agentSuggestions: Record<string, unknown> = {};
  for (const agent of ['gemini', 'codex', 'claude']) {
    try {
      agentSuggestions[agent] = suggestNext(state, agent);
    } catch {
      agentSuggestions[agent] = { action: 'unknown' };
    }
  }

  const lastActiveAt = state.activeSession?.updatedAt ?? state.updatedAt;
  const lastActiveMs =
    lastActiveAt != null && lastActiveAt !== '' ? new Date(lastActiveAt).getTime() : 0;
  let eventsSinceLastActive = 0;
  try {
    const events = readEvents(500);
    eventsSinceLastActive = events.filter(
      (e: EventEntry) => new Date(e.at).getTime() > lastActiveMs,
    ).length;
  } catch {
    /* skip */
  }

  sendJson(res, 200, {
    ok: true,
    activeSession: state.activeSession
      ? {
          id: state.activeSession.id,
          focus: state.activeSession.focus,
          status: state.activeSession.status,
          startedAt: state.activeSession.startedAt,
          updatedAt: state.activeSession.updatedAt,
          pauseReason: state.activeSession.pauseReason ?? undefined,
          pausedAt: state.activeSession.pausedAt ?? undefined,
        }
      : null,
    staleTasks,
    inProgressTasks: inProgressTasks.map((t: TaskEntry) => ({
      id: t.id,
      title: t.title,
      owner: t.owner,
      updatedAt: t.updatedAt,
      lastCheckpoint: (t.checkpoints ?? []).at(-1) ?? null,
    })),
    pendingHandoffs,
    agentSuggestions,
    lastEventAt: lastActiveAt,
    eventsSinceLastActive,
  });
  return true;
}

function handleTasksStale(ctx: ReadRouteCtx): boolean {
  const { res, sendJson, readState } = ctx;
  const state = readState();
  const staleTasks = state.tasks
    .filter((t: TaskEntry) => t.stale === true)
    .map((t: TaskEntry) => ({
      id: t.id,
      title: t.title,
      owner: t.owner,
      updatedAt: t.updatedAt,
      staleSince: t.staleSince ?? t.updatedAt,
    }));
  sendJson(res, 200, { ok: true, tasks: staleTasks });
  return true;
}

function handleStats(ctx: ReadRouteCtx): boolean {
  const { res, sendJson, getMetricsSummary, checkUsage, getEventCount } = ctx;
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
    daemon: { uptimeSec: Math.floor(process.uptime()), eventsRecorded: getEventCount() },
  });
  return true;
}

const ROUTE_HANDLERS: ReadonlyMap<string, RouteHandler> = new Map<string, RouteHandler>([
  ['/health', handleHealth],
  ['/self', handleSelf],
  ['/state', handleState],
  ['/summary', handleSummary],
  ['/prompt', handlePrompt],
  ['/next', handleNext],
  ['/events', handleEvents],
  ['/events/replay', handleEventsReplay],
  ['/events/stream', handleEventsStream],
  ['/activity', handleActivity],
  ['/state/archive', handleStateArchive],
  ['/sessions', handleSessions],
  ['/worktrees', handleWorktrees],
  ['/session/status', handleSessionStatus],
  ['/tasks/stale', handleTasksStale],
  ['/stats', handleStats],
]);

export async function handleReadRoute(ctx: ReadRouteCtx): Promise<boolean> {
  const { method, route } = ctx;
  if (method !== 'GET') return false;

  const handler = ROUTE_HANDLERS.get(route);
  if (handler != null) return handler(ctx);

  if (route.startsWith('/task/') && route.endsWith('/checkpoints')) {
    return handleTaskCheckpoints(ctx);
  }

  if (route.startsWith('/operations/')) {
    return handleOperationsReadRoute(ctx);
  }

  return false;
}
