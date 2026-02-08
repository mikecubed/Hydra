#!/usr/bin/env node
/**
 * Read-only daemon routes (GET endpoints and SSE stream).
 */

export async function handleReadRoute(ctx) {
  const {
    method,
    route,
    requestUrl,
    req,
    res,
    sendJson,
    sendError,
    writeStatus,
    readStatus,
    checkUsage,
    getModelSummary,
    readState,
    getSummary,
    buildPrompt,
    suggestNext,
    readEvents,
    replayEvents,
    sseClients,
    readArchive,
    getMetricsSummary,
    getEventCount,
  } = ctx;

  if (method === 'GET' && route === '/health') {
    writeStatus();
    const status = readStatus();
    let usageLevel = 'unknown';
    try {
      const usage = checkUsage();
      usageLevel = usage.level;
    } catch {
      // Best effort only.
    }
    let models = {};
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

  if (method === 'GET' && route === '/state') {
    sendJson(res, 200, { ok: true, state: readState() });
    return true;
  }

  if (method === 'GET' && route === '/summary') {
    sendJson(res, 200, { ok: true, summary: getSummary(readState()) });
    return true;
  }

  if (method === 'GET' && route === '/prompt') {
    const agent = (requestUrl.searchParams.get('agent') || 'generic').toLowerCase();
    sendJson(res, 200, { ok: true, agent, prompt: buildPrompt(agent, readState()) });
    return true;
  }

  if (method === 'GET' && route === '/next') {
    const agent = (requestUrl.searchParams.get('agent') || '').toLowerCase();
    if (!agent) {
      sendError(res, 400, 'Missing query param: agent');
      return true;
    }
    sendJson(res, 200, { ok: true, next: suggestNext(readState(), agent) });
    return true;
  }

  if (method === 'GET' && route.startsWith('/task/') && route.endsWith('/checkpoints')) {
    const taskId = route.slice('/task/'.length, -'/checkpoints'.length);
    const state = readState();
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) {
      sendError(res, 404, `Task ${taskId} not found.`);
      return true;
    }
    sendJson(res, 200, { ok: true, taskId, checkpoints: task.checkpoints || [] });
    return true;
  }

  if (method === 'GET' && route === '/events') {
    const limit = Number.parseInt(requestUrl.searchParams.get('limit') || '50', 10);
    sendJson(res, 200, { ok: true, events: readEvents(limit) });
    return true;
  }

  if (method === 'GET' && route === '/events/replay') {
    const fromSeq = Number.parseInt(requestUrl.searchParams.get('from') || '0', 10);
    const category = requestUrl.searchParams.get('category') || '';
    let events = replayEvents(fromSeq);
    if (category) {
      events = events.filter((e) => e.category === category);
    }
    sendJson(res, 200, { ok: true, count: events.length, events });
    return true;
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
    return true;
  }

  if (method === 'GET' && route === '/sessions') {
    const state = readState();
    const active = state.activeSession || null;
    const children = state.childSessions || [];
    sendJson(res, 200, {
      ok: true,
      activeSession: active ? {
        id: active.id,
        type: active.type || 'root',
        focus: active.focus,
        status: active.status,
        children: active.children || [],
      } : null,
      childSessions: children.map((s) => ({
        id: s.id,
        type: s.type,
        parentId: s.parentId,
        focus: s.focus,
        status: s.status,
        children: s.children || [],
      })),
    });
    return true;
  }

  if (method === 'GET' && route === '/worktrees') {
    try {
      const { listWorktrees, isWorktreeEnabled } = await import('../hydra-worktree.mjs');
      const enabled = isWorktreeEnabled();
      const state = readState();
      const tasksWithWorktrees = state.tasks.filter((t) => t.worktreePath);
      sendJson(res, 200, {
        ok: true,
        enabled,
        worktrees: tasksWithWorktrees.map((t) => ({
          taskId: t.id,
          path: t.worktreePath,
          branch: t.worktreeBranch,
          status: t.status,
        })),
      });
    } catch (err) {
      sendJson(res, 200, { ok: true, enabled: false, worktrees: [], error: err.message });
    }
    return true;
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
      daemon: { uptimeSec: Math.floor(process.uptime()), eventsRecorded: getEventCount() },
    });
    return true;
  }

  return false;
}

