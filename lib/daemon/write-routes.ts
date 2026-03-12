/**
 * Mutating daemon routes (POST endpoints).
 */

import crypto from 'node:crypto';
import type { WriteRouteCtx, HydraStateShape, TaskEntry, HandoffEntry } from '../types.ts';
import path from 'node:path';
import { createWorktree, removeWorktree, isWorktreeEnabled } from '../hydra-worktree.ts';
import {
  registerSession as hubRegister,
  deregisterSession as hubDeregister,
  updateSession as hubUpdate,
} from '../hydra-hub.ts';

export async function handleWriteRoute(ctx: WriteRouteCtx): Promise<boolean> {
  const {
    method,
    route,
    req,
    res,
    readJsonBody,
    sendJson,
    sendError,
    enqueueMutation,
    ensureKnownAgent,
    ensureKnownStatus,
    parseList,
    getCurrentBranch,
    toSessionId,
    nowIso,
    classifyTask,
    nextId,
    detectCycle,
    autoUnblock,
    readState,
    AGENT_NAMES,
    getAgent,
    resolveVerificationPlan,
    projectRoot,
    runVerification,
    archiveState,
    truncateEventsFile,
    writeStatus: _writeStatus,
    appendEvent,
    broadcastEvent,
    setIsShuttingDown,
    server,
    createSnapshot: _createSnapshot,
    cleanOldSnapshots: _cleanOldSnapshots,
    checkIdempotency,
    createTaskWorktree,
    mergeTaskWorktree,
    cleanupTaskWorktree,
  } = ctx;

  // ── Idempotency Check ──────────────────────────────────────────────────
  if (method === 'POST' && checkIdempotency) {
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    if (idempotencyKey && checkIdempotency(idempotencyKey)) {
      sendJson(res, 409, { ok: false, error: 'Duplicate request (idempotency key already seen)' });
      return true;
    }
  }

  // ── Concierge Event Push ──────────────────────────────────────────────────
  if (method === 'POST' && route === '/events/push') {
    const body = await readJsonBody(req);
    const type = ((body['type'] as string | null | undefined) ?? '').trim();
    const payload = body['payload'] ?? {};

    const ALLOWED_TYPES = [
      'concierge:dispatch',
      'concierge:summary',
      'concierge:error',
      'concierge:model_switch',
    ];
    if (!type || !ALLOWED_TYPES.includes(type)) {
      sendError(res, 400, `Invalid event type. Allowed: ${ALLOWED_TYPES.join(', ')}`);
      return true;
    }

    appendEvent(type, payload);
    broadcastEvent({ type, payload, at: new Date().toISOString() });
    sendJson(res, 200, { ok: true, type });
    return true;
  }

  if (method === 'POST' && route === '/session/start') {
    const body = await readJsonBody(req);
    const focus = ((body['focus'] as string | null | undefined) ?? '').trim();
    if (!focus) {
      sendError(res, 400, 'Field "focus" is required.');
      return true;
    }

    const owner = ((body['owner'] as string | null | undefined) ?? 'human').toLowerCase();
    ensureKnownAgent(owner, false);
    const participants = parseList(body['participants'] ?? 'human,gemini,codex,claude');
    const branch = (body['branch'] as string | null | undefined) ?? getCurrentBranch();

    const session = await enqueueMutation(
      `session:start owner=${owner} focus="${focus}"`,
      (state: HydraStateShape) => {
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
      },
    );

    sendJson(res, 200, { ok: true, session });
    return true;
  }

  if (method === 'POST' && route === '/session/fork') {
    const body = await readJsonBody(req);
    const reason = ((body['reason'] as string | null | undefined) ?? '').trim();

    const result = await enqueueMutation(
      'session:fork',
      (state: HydraStateShape) => {
        if (!state.activeSession) {
          throw new Error('No active session to fork.');
        }
        const parent = state.activeSession;
        const forkId = `${parent.id}_FORK_${Date.now().toString(36)}`;

        // Initialize children array on parent if needed
        if (!Array.isArray(parent.children)) {
          parent.children = [];
        }
        parent.children.push(forkId);

        // Create fork session record
        const fork = {
          id: forkId,
          type: 'fork',
          parentId: parent.id,
          children: [],
          focus: parent.focus,
          owner: parent.owner,
          branch: parent.branch,
          participants: [...(parent.participants ?? [])],
          status: 'active',
          reason: reason || 'Forked from parent session',
          contextSnapshot: JSON.stringify({
            tasks: state.tasks.map((t: TaskEntry) => ({
              id: t.id,
              title: t.title,
              status: t.status,
              owner: t.owner,
            })),
            decisions: state.decisions.length,
            handoffs: state.handoffs.length,
          }),
          startedAt: nowIso(),
          updatedAt: nowIso(),
        };

        // Store fork sessions in an array on state
        if (!Array.isArray(state.childSessions)) {
          state.childSessions = [];
        }
        state.childSessions.push(fork);

        return fork;
      },
      { event: 'session_fork', reason },
    );

    sendJson(res, 200, { ok: true, session: result });
    return true;
  }

  if (method === 'POST' && route === '/session/spawn') {
    const body = await readJsonBody(req);
    const focus = ((body['focus'] as string | null | undefined) ?? '').trim();
    if (!focus) {
      sendError(res, 400, 'Field "focus" is required for spawn.');
      return true;
    }
    const owner = ((body['owner'] as string | null | undefined) ?? 'human').toLowerCase();

    const result = await enqueueMutation(
      `session:spawn focus="${focus}"`,
      (state: HydraStateShape) => {
        const parentId: string = state.activeSession?.id ?? '';
        const spawnId = `${parentId || 'ROOT'}_SPAWN_${Date.now().toString(36)}`;

        // Track on parent if exists
        if (state.activeSession) {
          if (!Array.isArray(state.activeSession.children)) {
            state.activeSession.children = [];
          }
          state.activeSession.children.push(spawnId);
        }

        const child = {
          id: spawnId,
          type: 'spawn',
          parentId,
          children: [],
          focus,
          owner,
          branch: getCurrentBranch(),
          participants: ['human', 'gemini', 'codex', 'claude'],
          status: 'active',
          startedAt: nowIso(),
          updatedAt: nowIso(),
        };

        if (!Array.isArray(state.childSessions)) {
          state.childSessions = [];
        }
        state.childSessions.push(child);

        return child;
      },
      { event: 'session_spawn', focus: focus.slice(0, 80) },
    );

    sendJson(res, 200, { ok: true, session: result });
    return true;
  }

  if (method === 'POST' && route === '/session/pause') {
    const body = await readJsonBody(req);
    const reason = ((body['reason'] as string | null | undefined) ?? '').trim();

    const session = await enqueueMutation(
      'session:pause',
      (state: HydraStateShape) => {
        if (!state.activeSession) {
          throw new Error('No active session to pause.');
        }
        if (state.activeSession.status === 'paused') {
          throw new Error('Session is already paused.');
        }
        state.activeSession.status = 'paused';
        state.activeSession.pauseReason = reason || undefined;
        state.activeSession.pausedAt = nowIso();
        return state.activeSession;
      },
      { event: 'session_pause', reason: reason.slice(0, 80) },
    );

    sendJson(res, 200, { ok: true, session });
    return true;
  }

  if (method === 'POST' && route === '/session/resume') {
    await readJsonBody(req);

    const session = await enqueueMutation(
      'session:resume',
      (state: HydraStateShape) => {
        if (!state.activeSession) {
          throw new Error('No active session to resume.');
        }
        if (state.activeSession.status !== 'paused') {
          throw new Error('Session is not paused.');
        }
        state.activeSession.status = 'active';
        (state.activeSession as Record<string, unknown>)['resumedAt'] = nowIso();
        delete state.activeSession.pauseReason;
        delete state.activeSession.pausedAt;
        return state.activeSession;
      },
      { event: 'session_resume' },
    );

    sendJson(res, 200, { ok: true, session });
    return true;
  }

  if (method === 'POST' && route === '/task/add') {
    const body = await readJsonBody(req);
    const title = ((body['title'] as string | null | undefined) ?? '').trim();
    if (!title) {
      sendError(res, 400, 'Field "title" is required.');
      return true;
    }

    const owner = ((body['owner'] as string | null | undefined) ?? 'unassigned').toLowerCase();
    ensureKnownAgent(owner);

    const status = (body['status'] as string | null | undefined) ?? 'todo';
    ensureKnownStatus(status);

    const files = parseList(body['files'] ?? []);
    const notes = ((body['notes'] as string | null | undefined) ?? '').trim();
    const blockedBy = parseList(body['blockedBy'] ?? []);
    const taskType =
      ((body['type'] as string | null | undefined) ?? '').trim() || classifyTask(title, notes);

    const wantWorktree = Boolean(body['worktree']) && isWorktreeEnabled();

    const task = await enqueueMutation(
      `task:add owner=${owner} status=${status} type=${taskType}`,
      (state: HydraStateShape) => {
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
        state.tasks.push(item as unknown as TaskEntry);
        return item;
      },
      { event: 'task_add', owner, title: title.slice(0, 80) },
    );

    // Create worktree after mutation succeeds (uses task.id)
    let worktreeInfo: Record<string, unknown> | null = null;
    if (wantWorktree && (task as Record<string, unknown>)['id']) {
      try {
        worktreeInfo = (await createWorktree(
          (task as Record<string, unknown>)['id'] as string,
          projectRoot as string,
        )) as Record<string, unknown>;
        // Update task record with worktree path via another mutation
        await enqueueMutation(
          `task:worktree id=${(task as Record<string, unknown>)['id'] as string}`,
          (state: HydraStateShape) => {
            const t = state.tasks.find((x: TaskEntry) => x.id === task.id);
            if (t) {
              t.worktreePath = worktreeInfo!['worktreePath'] as string;
              t.worktreeBranch = worktreeInfo!['branch'] as string;
            }
          },
          { event: 'worktree_create', taskId: task.id },
        );
      } catch {
        /* non-critical */
      }
    }

    sendJson(res, 200, { ok: true, task, worktree: worktreeInfo });
    return true;
  }

  if (method === 'POST' && route === '/task/claim') {
    const body = await readJsonBody(req);
    const agent = ((body['agent'] as string | null | undefined) ?? '').toLowerCase();
    ensureKnownAgent(agent, false);

    const claimTitle = (
      (body['title'] as string | null | undefined) ??
      (body['taskId'] as string | null | undefined) ??
      ''
    ).trim();
    const task = await enqueueMutation(
      `task:claim agent=${agent}`,
      (state: HydraStateShape) => {
        const taskId = ((body['taskId'] as string | null | undefined) ?? '').trim();
        const title = ((body['title'] as string | null | undefined) ?? '').trim();
        const files = parseList(body['files']);
        const notes = ((body['notes'] as string | null | undefined) ?? '').trim();

        if (taskId) {
          const existing = state.tasks.find((item: TaskEntry) => item.id === taskId);
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
          (existing as Record<string, unknown>)['claimToken'] = crypto.randomUUID();
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

        const claimBlockedBy = parseList(body['blockedBy'] ?? []);
        const newTask = {
          id: nextId('T', state.tasks),
          title,
          owner: agent,
          status: 'in_progress',
          claimToken: crypto.randomUUID(),
          files,
          notes,
          blockedBy: claimBlockedBy,
          updatedAt: nowIso(),
        };
        state.tasks.push(newTask as unknown as TaskEntry);
        return newTask;
      },
      { event: 'task_claim', agent, title: claimTitle.slice(0, 80) },
    );

    // Create worktree for newly-created tasks when worktreeIsolation is enabled
    // and the dispatch mode is tandem or council (or worktree is explicitly requested).
    // Only applies when a NEW task was created (not when claiming an existing one).
    const isNewTask = !body['taskId'];
    const dispatchMode = ((body['mode'] as string | null | undefined) ?? '').toLowerCase();
    const wantsWorktree =
      isNewTask &&
      typeof createTaskWorktree === 'function' &&
      (body['worktree'] === true || dispatchMode === 'tandem' || dispatchMode === 'council');
    if (wantsWorktree) {
      try {
        const { loadHydraConfig } = await import('../hydra-config.ts');
        const cfg = loadHydraConfig();
        if (cfg.routing.worktreeIsolation.enabled) {
          const worktreePath = createTaskWorktree(task.id);
          if (worktreePath) {
            const branch = `hydra/task/${task.id}`;
            await enqueueMutation(
              `task:worktree id=${(task as Record<string, unknown>)['id'] as string}`,
              (state: HydraStateShape) => {
                const t = state.tasks.find((x: TaskEntry) => x.id === task.id);
                if (t) {
                  (t as Record<string, unknown>)['worktreePath'] = worktreePath;
                  (t as Record<string, unknown>)['worktreeBranch'] = branch;
                }
              },
              { event: 'worktree_create', taskId: task.id },
            );
          }
        }
      } catch {
        /* worktree creation is non-critical */
      }
    }

    // Sync to coordination hub (non-critical — must never fail the request)
    try {
      hubRegister({
        id: `daemon_${(task as Record<string, unknown>)['id'] as string}`,
        agent: (task as Record<string, unknown>)['owner'] as string,
        cwd: projectRoot as string,
        project: path.basename(projectRoot as string),
        focus: (task as Record<string, unknown>)['title'] as string,
        files: (task as Record<string, unknown>)['files'] as string[],
        taskId: (task as Record<string, unknown>)['id'] as string,
        status: 'working',
      });
    } catch {
      /* hub sync is non-critical */
    }

    sendJson(res, 200, { ok: true, task });
    return true;
  }

  if (method === 'POST' && route === '/task/update') {
    const body = await readJsonBody(req);
    const taskId = ((body['taskId'] as string | null | undefined) ?? '').trim();
    if (!taskId) {
      sendError(res, 400, 'Field "taskId" is required.');
      return true;
    }

    const updateStatus = body['status'] === undefined ? undefined : (body['status'] as string);
    const updateOwner =
      body['owner'] === undefined ? undefined : (body['owner'] as string).toLowerCase();
    const task = await enqueueMutation(
      `task:update id=${taskId}`,
      (state: HydraStateShape) => {
        const existing = state.tasks.find((item: TaskEntry) => item.id === taskId);
        if (!existing) {
          throw new Error(`Task ${taskId} not found.`);
        }

        // Atomic claim token validation: if caller provides claimToken, it must match
        if (body['claimToken'] && !body['force']) {
          if (
            (existing as Record<string, unknown>)['claimToken'] &&
            (existing as Record<string, unknown>)['claimToken'] !== body['claimToken']
          ) {
            throw new Error(
              `Claim token mismatch for ${taskId}. Task is owned by another claim. Use force=true to override.`,
            );
          }
        }

        if (body['title'] !== undefined) {
          existing.title = body['title'] as string;
        }
        if (body['owner'] !== undefined) {
          const owner = (body['owner'] as string).toLowerCase();
          ensureKnownAgent(owner);
          existing.owner = owner;
        }
        if (body['blockedBy'] !== undefined) {
          const proposed = parseList(body['blockedBy']);
          if (proposed.length > 0 && detectCycle(state.tasks, taskId, proposed)) {
            throw new Error(
              `Setting blockedBy=[${proposed.join(',')}] on ${taskId} would create a circular dependency.`,
            );
          }
          existing.blockedBy = proposed;
        }
        if (body['status'] !== undefined) {
          const status = body['status'] as string;
          ensureKnownStatus(status);
          (existing as Record<string, unknown>)['status'] = status;
        }
        if (body['files'] !== undefined) {
          existing.files = parseList(body['files']);
        }
        if (body['notes'] !== undefined) {
          const notes = (body['notes'] as string).trim();
          if (notes) {
            existing.notes = existing.notes ? `${existing.notes}\n${notes}` : notes;
          }
        }
        existing.updatedAt = nowIso();
        if ((existing as Record<string, unknown>)['stale']) {
          (existing as Record<string, unknown>)['stale'] = false;
          delete (existing as Record<string, unknown>)['staleSince'];
        }

        if (['done', 'cancelled'].includes(existing.status)) {
          autoUnblock(state, taskId);
        }

        return existing;
      },
      { event: 'task_update', taskId, status: updateStatus, owner: updateOwner },
    );

    // Auto-cleanup worktree when task completes
    if (
      ['done', 'cancelled'].includes((task as Record<string, unknown>)['status'] as string) &&
      (task as Record<string, unknown>)['worktreePath'] &&
      isWorktreeEnabled()
    ) {
      try {
        await removeWorktree(taskId, projectRoot as string, {
          deleteBranch: (task as Record<string, unknown>)['status'] === 'cancelled',
        });
      } catch {
        /* non-critical */
      }
    }

    // Sync status change to coordination hub
    try {
      const hubSessId = `daemon_${(task as Record<string, unknown>)['id'] as string}`;
      if (['done', 'cancelled'].includes((task as Record<string, unknown>)['status'] as string)) {
        hubDeregister(hubSessId);
      } else {
        hubUpdate(hubSessId, {
          status: (task as Record<string, unknown>)['status'] === 'blocked' ? 'blocked' : 'working',
          files: (task as Record<string, unknown>)['files'] as string[],
          focus: (task as Record<string, unknown>)['title'] as string,
        });
      }
    } catch {
      /* hub sync is non-critical */
    }

    const shouldVerify =
      (task as Record<string, unknown>)['status'] === 'done' && body['verify'] !== false;
    const verifyPlan = resolveVerificationPlan(projectRoot);
    const isVerifying = shouldVerify && verifyPlan['enabled'];
    if (isVerifying) {
      runVerification(taskId, verifyPlan);
    }
    sendJson(res, 200, {
      ok: true,
      task,
      verifying: isVerifying,
      verification: {
        enabled: verifyPlan['enabled'],
        source: verifyPlan['source'],
        command: (verifyPlan['command'] as string | null | undefined)
          ? (verifyPlan['command'] as string)
          : null,
        reason: verifyPlan['reason'],
      },
    });
    return true;
  }

  if (method === 'POST' && route === '/task/route') {
    const body = await readJsonBody(req);
    const taskId = ((body['taskId'] as string | null | undefined) ?? '').trim();
    const includeVirtual = body['includeVirtual'] === true;
    if (!taskId) {
      sendError(res, 400, 'Field "taskId" is required.');
      return true;
    }
    const state = readState();
    const target = state.tasks.find((t: TaskEntry) => t.id === taskId);
    if (!target) {
      sendError(res, 404, `Task ${taskId} not found.`);
      return true;
    }
    const taskType = target.type || classifyTask(target.title, target.notes || '');
    const scores: Record<string, number> = {};
    let recommended = AGENT_NAMES[0];
    let bestScore = 0;
    // Score physical agents
    for (const name of AGENT_NAMES) {
      const cfg = getAgent(name);
      const score = (cfg?.taskAffinity as Record<string, number> | undefined)?.[taskType] ?? 0.5;
      scores[name] = score;
      if (score > bestScore) {
        bestScore = score;
        recommended = name;
      }
    }
    // Optionally score virtual agents
    const virtualScores: Record<string, number> = {};
    let virtualRecommended = null;
    if (includeVirtual) {
      const virtualAgents = ctx.listAgents({ type: 'virtual', enabled: true });
      for (const va of virtualAgents) {
        const score = (va.taskAffinity as Record<string, number> | undefined)?.[taskType] ?? 0;
        virtualScores[va.name] = score;
        if (!virtualRecommended || score > (virtualScores[virtualRecommended] ?? 0)) {
          virtualRecommended = va.name;
        }
      }
    }
    const response: Record<string, unknown> = {
      ok: true,
      taskId,
      taskType,
      recommended,
      scores,
      reason: `${taskType} task best suited for ${recommended} (affinity=${String(bestScore)})`,
    };
    if (includeVirtual && Object.keys(virtualScores).length > 0) {
      response['virtualScores'] = virtualScores;
      response['virtualRecommended'] = virtualRecommended;
    }
    sendJson(res, 200, response);
    return true;
  }

  if (method === 'POST' && route === '/verify') {
    const body = await readJsonBody(req);
    const verifyTaskId = ((body['taskId'] as string | null | undefined) ?? '').trim();
    if (!verifyTaskId) {
      sendError(res, 400, 'Field "taskId" is required.');
      return true;
    }
    const state = readState();
    const target = state.tasks.find((t: TaskEntry) => t.id === verifyTaskId);
    if (!target) {
      sendError(res, 404, `Task ${verifyTaskId} not found.`);
      return true;
    }

    const verifyPlan = resolveVerificationPlan(projectRoot);
    if (!verifyPlan['enabled']) {
      sendJson(res, 200, {
        ok: true,
        taskId: verifyTaskId,
        message: 'Verification skipped (no command configured).',
        verification: {
          enabled: false,
          source: verifyPlan['source'],
          command: null,
          reason: verifyPlan['reason'],
        },
      });
      return true;
    }

    runVerification(verifyTaskId, verifyPlan);
    sendJson(res, 200, {
      ok: true,
      taskId: verifyTaskId,
      message: 'Verification started.',
      verification: {
        enabled: true,
        source: verifyPlan['source'],
        command: verifyPlan['command'],
        reason: verifyPlan['reason'],
      },
    });
    return true;
  }

  if (method === 'POST' && route === '/decision') {
    const body = await readJsonBody(req);
    const title = ((body['title'] as string | null | undefined) ?? '').trim();
    if (!title) {
      sendError(res, 400, 'Field "title" is required.');
      return true;
    }

    const owner = ((body['owner'] as string | null | undefined) ?? 'human').toLowerCase();
    ensureKnownAgent(owner, false);
    const rationale = (body['rationale'] as string | null | undefined) ?? '';
    const impact = (body['impact'] as string | null | undefined) ?? '';

    const decision = await enqueueMutation(
      `decision:add owner=${owner}`,
      (state: HydraStateShape) => {
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
      },
      { event: 'decision', title: title.slice(0, 80) },
    );

    sendJson(res, 200, { ok: true, decision });
    return true;
  }

  if (method === 'POST' && route === '/blocker') {
    const body = await readJsonBody(req);
    const title = ((body['title'] as string | null | undefined) ?? '').trim();
    if (!title) {
      sendError(res, 400, 'Field "title" is required.');
      return true;
    }

    const owner = ((body['owner'] as string | null | undefined) ?? 'human').toLowerCase();
    ensureKnownAgent(owner, false);
    const nextStep = (body['nextStep'] as string | null | undefined) ?? '';

    const blocker = await enqueueMutation(
      `blocker:add owner=${owner}`,
      (state: HydraStateShape) => {
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
      },
    );

    sendJson(res, 200, { ok: true, blocker });
    return true;
  }

  if (method === 'POST' && route === '/handoff') {
    const body = await readJsonBody(req);
    const from = ((body['from'] as string | null | undefined) ?? '').toLowerCase();
    const to = ((body['to'] as string | null | undefined) ?? '').toLowerCase();
    const summary = ((body['summary'] as string | null | undefined) ?? '').trim();
    const nextStep = (body['nextStep'] as string | null | undefined) ?? '';
    const tasks = parseList(body['tasks']);

    if (!from || !to || !summary) {
      sendError(res, 400, 'Fields "from", "to", and "summary" are required.');
      return true;
    }

    ensureKnownAgent(from, false);
    ensureKnownAgent(to, false);

    const handoff = await enqueueMutation(
      `handoff:add ${from}->${to}`,
      (state: HydraStateShape) => {
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
      },
      { event: 'handoff', from, to, summary: summary.slice(0, 60) },
    );

    sendJson(res, 200, { ok: true, handoff });
    return true;
  }

  if (method === 'POST' && route === '/handoff/ack') {
    const body = await readJsonBody(req);
    const handoffId = ((body['handoffId'] as string | null | undefined) ?? '').trim();
    const agent = ((body['agent'] as string | null | undefined) ?? '').toLowerCase();
    if (!handoffId || !agent) {
      sendError(res, 400, 'Fields "handoffId" and "agent" are required.');
      return true;
    }
    ensureKnownAgent(agent, false);

    const handoff = await enqueueMutation(
      `handoff:ack id=${handoffId} by=${agent}`,
      (state: HydraStateShape) => {
        const item = state.handoffs.find((entry: HandoffEntry) => entry.id === handoffId);
        if (!item) {
          throw new Error(`Handoff ${handoffId} not found.`);
        }
        item.acknowledgedAt = nowIso();
        item.acknowledgedBy = agent;
        return item;
      },
      { event: 'handoff_ack', agent, handoffId },
    );

    sendJson(res, 200, { ok: true, handoff });
    return true;
  }

  if (method === 'POST' && route === '/task/result') {
    const body = await readJsonBody(req);
    const taskId = ((body['taskId'] as string | null | undefined) ?? '').trim();
    const agent = ((body['agent'] as string | null | undefined) ?? '').toLowerCase();
    if (!taskId || !agent) {
      sendError(res, 400, 'Fields "taskId" and "agent" are required.');
      return true;
    }
    ensureKnownAgent(agent, false);

    const output = ((body['output'] as string | null | undefined) ?? '').trim();
    const resultStatus = (body['status'] as string | null | undefined) ?? 'completed'; // completed | needs_followup | aborted
    const durationMs = Number(body['durationMs']) || 0;

    const result = await enqueueMutation(
      `task:result id=${taskId} agent=${agent} status=${resultStatus}`,
      (state: HydraStateShape) => {
        const task = state.tasks.find((t: TaskEntry) => t.id === taskId);
        if (!task) {
          throw new Error(`Task ${taskId} not found.`);
        }

        // Store the result on the task
        if (!Array.isArray((task as Record<string, unknown>)['results'])) {
          (task as Record<string, unknown>)['results'] = [];
        }
        const entry: Record<string, unknown> = {
          agent,
          status: resultStatus,
          durationMs,
          output: output.slice(0, 8000), // cap stored output
          submittedAt: nowIso(),
        };
        // Attach structured error info from worker (if present)
        if (body['errorInfo']) {
          const errInfo = body['errorInfo'] as Record<string, unknown>;
          entry['errorInfo'] = {
            exitCode: errInfo['exitCode'] ?? null,
            signal: (errInfo['signal'] as string | null | undefined) ?? null,
            stderr: ((errInfo['stderr'] as string | null | undefined) ?? '').slice(0, 1000),
            error: ((errInfo['error'] as string | null | undefined) ?? '').slice(0, 500),
            errorCategory: (errInfo['errorCategory'] as string | null | undefined) ?? null,
            errorDetail: (errInfo['errorDetail'] as string | null | undefined) ?? null,
            errorContext: ((errInfo['errorContext'] as string | null | undefined) ?? '').slice(
              0,
              500,
            ),
          };
        }
        ((task as Record<string, unknown>)['results'] as unknown[]).push(entry);
        task.updatedAt = nowIso();

        // Auto-complete / block based on result status
        if (task.status === 'in_progress' && task.owner === agent) {
          if (resultStatus === 'completed' || resultStatus === 'done') {
            task.status = 'done';
            autoUnblock(state, taskId);
          } else if (resultStatus === 'error') {
            // Increment fail count; move to DLQ if exceeded threshold
            (task as Record<string, unknown>)['failCount'] =
              (((task as Record<string, unknown>)['failCount'] as number) || 0) + 1;
            const maxAttempts = 3; // config-driven in future
            if (((task as Record<string, unknown>)['failCount'] as number) >= maxAttempts) {
              // Move to dead-letter queue
              if (!Array.isArray((state as Record<string, unknown>)['deadLetter']))
                (state as Record<string, unknown>)['deadLetter'] = [];
              (task as Record<string, unknown>)['status'] = 'cancelled';
              (task as Record<string, unknown>)['deadLetteredAt'] = nowIso();
              ((state as Record<string, unknown>)['deadLetter'] as unknown[]).push({ ...task });
              state.tasks = state.tasks.filter((t: TaskEntry) => t.id !== taskId);
            } else {
              task.status = 'blocked';
              (task as Record<string, unknown>)['blockedReason'] =
                output.slice(0, 500) || 'Agent reported error';
            }
          }
        }

        // Mark stale reset
        if ((task as Record<string, unknown>)['stale']) {
          (task as Record<string, unknown>)['stale'] = false;
          delete (task as Record<string, unknown>)['staleSince'];
        }

        return { task, entry };
      },
      { event: 'task_result', taskId, agent, status: resultStatus, category: 'agent' },
    );

    // Worktree merge on task completion (worktreeIsolation.enabled guard inside)
    const completedTask = (result as Record<string, unknown>)['task'] as
      | Record<string, unknown>
      | undefined;
    const taskDone = completedTask ? ['done'].includes(completedTask['status'] as string) : false;
    if (taskDone && completedTask?.['worktreePath'] && typeof mergeTaskWorktree === 'function') {
      try {
        const mergeResult = mergeTaskWorktree(taskId);
        if (mergeResult['ok']) {
          // Clean merge: clean up worktree if cleanupOnSuccess (default true)
          const { loadHydraConfig } = await import('../hydra-config.ts');
          const cfg = loadHydraConfig();
          if (cfg.routing.worktreeIsolation.cleanupOnSuccess !== false) {
            cleanupTaskWorktree(taskId);
          }
        } else if (mergeResult['conflict']) {
          // Conflict: preserve worktree, flag task for :tasks review
          await enqueueMutation(
            `task:worktree_conflict id=${taskId}`,
            (state: HydraStateShape) => {
              const t = state.tasks.find((x: TaskEntry) => x.id === taskId);
              if (t) {
                (t as Record<string, unknown>)['worktreeConflict'] = true;
                t.updatedAt = nowIso();
              }
            },
            { event: 'worktree_conflict', taskId },
          );
        }
        // On other errors: logged by mergeTaskWorktree, proceed without cleanup
      } catch {
        /* non-critical — merge failure must not fail the result POST */
      }
    }

    sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  if (method === 'POST' && route === '/task/checkpoint') {
    const body = await readJsonBody(req);
    const taskId = ((body['taskId'] as string | null | undefined) ?? '').trim();
    if (!taskId) {
      sendError(res, 400, 'Field "taskId" is required.');
      return true;
    }
    const name = ((body['name'] as string | null | undefined) ?? '').trim();
    if (!name) {
      sendError(res, 400, 'Field "name" is required.');
      return true;
    }
    const context = ((body['context'] as string | null | undefined) ?? '').trim();
    const agent = ((body['agent'] as string | null | undefined) ?? '').toLowerCase();

    const checkpoint = await enqueueMutation(
      `task:checkpoint id=${taskId} name=${name}`,
      (state: HydraStateShape) => {
        const task = state.tasks.find((t: TaskEntry) => t.id === taskId);
        if (!task) {
          throw new Error(`Task ${taskId} not found.`);
        }
        if (!Array.isArray(task.checkpoints)) {
          task.checkpoints = [];
        }
        const cp = {
          name,
          savedAt: nowIso(),
          context,
          agent: agent || task.owner || 'unknown',
        };
        (task.checkpoints as unknown[]).push(cp);
        task.updatedAt = nowIso();
        if ((task as Record<string, unknown>)['stale']) {
          (task as Record<string, unknown>)['stale'] = false;
          delete (task as Record<string, unknown>)['staleSince'];
        }
        return cp;
      },
      { event: 'checkpoint', taskId, name },
    );

    sendJson(res, 200, { ok: true, checkpoint });
    return true;
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────
  if (method === 'POST' && route.startsWith('/task/') && route.endsWith('/heartbeat')) {
    const taskId = route.slice('/task/'.length, -'/heartbeat'.length);
    if (!taskId) {
      sendError(res, 400, 'Task ID required in URL.');
      return true;
    }
    const body = await readJsonBody(req);
    const agent = ((body['agent'] as string | null | undefined) ?? '').toLowerCase();

    const result = await enqueueMutation(
      `task:heartbeat id=${taskId}`,
      (state: HydraStateShape) => {
        const task = state.tasks.find((t: TaskEntry) => t.id === taskId);
        if (!task) {
          throw new Error(`Task ${taskId} not found.`);
        }

        const now = nowIso();
        (task as Record<string, unknown>)['lastHeartbeat'] = now;
        task.updatedAt = now;
        (task as Record<string, unknown>)['lastHeartbeatDetail'] = {
          agent: agent || task.owner || 'unknown',
          progress: body['progress'] ?? null,
          outputBytes: body['outputBytes'] ?? 0,
          phase: body['phase'] ?? null,
        };

        // Reset stale flag
        if ((task as Record<string, unknown>)['stale']) {
          (task as Record<string, unknown>)['stale'] = false;
          delete (task as Record<string, unknown>)['staleSince'];
        }

        return { taskId, heartbeat: now };
      },
      { event: 'task:heartbeat', taskId, agent, category: 'heartbeat' },
    );

    sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  if (method === 'POST' && route === '/state/archive') {
    const result = await enqueueMutation('state:archive', (state: HydraStateShape) => {
      const moved = archiveState(state);
      const trimmed = truncateEventsFile(500);
      return { moved, eventsTrimmed: trimmed };
    });
    sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  // ── Dead-Letter Queue ──────────────────────────────────────────────────

  if (method === 'GET' && route === '/dead-letter') {
    const state = readState();
    sendJson(res, 200, { ok: true, items: (state as Record<string, unknown>)['deadLetter'] ?? [] });
    return true;
  }

  if (method === 'POST' && route === '/dead-letter/retry') {
    const body = await readJsonBody(req);
    const dlId = ((body['id'] as string | null | undefined) ?? '').trim();
    if (!dlId) {
      sendError(res, 400, 'Field "id" is required.');
      return true;
    }

    const task = await enqueueMutation(
      `dlq:retry id=${dlId}`,
      (state: HydraStateShape) => {
        if (!Array.isArray(state['deadLetter'])) state['deadLetter'] = [];
        const idx = (state['deadLetter'] as Array<Record<string, unknown>>).findIndex(
          (t: Record<string, unknown>) => t['id'] === dlId,
        );
        if (idx === -1) throw new Error(`DLQ entry ${dlId} not found.`);
        const item = (state['deadLetter'] as Array<Record<string, unknown>>).splice(idx, 1)[0];
        item['status'] = 'todo';
        item['failCount'] = 0;
        item['retriedAt'] = nowIso();
        delete item['deadLetteredAt'];
        state.tasks.push(item as unknown as TaskEntry);
        return item;
      },
      { event: 'dlq_retry', taskId: dlId },
    );

    sendJson(res, 200, { ok: true, task });
    return true;
  }

  // ── Admin: Snapshot & Compaction ──────────────────────────────────────

  if (method === 'POST' && route === '/admin/compact') {
    const result: Record<string, unknown> = _createSnapshot();
    if (result['ok']) {
      const trimmed = truncateEventsFile(500);
      result['eventsTrimmed'] = trimmed;
    }
    _cleanOldSnapshots();
    sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  if (method === 'POST' && route === '/shutdown') {
    sendJson(res, 200, { ok: true, message: 'Shutting down orchestrator daemon.' });
    setIsShuttingDown(true);
    ctx.writeStatus({ running: false, stoppingAt: nowIso() });
    setTimeout(() => {
      server.close(() => {
        ctx.writeStatus({ running: false, stoppedAt: nowIso() });
        // eslint-disable-next-line n/no-process-exit -- server.close callback requires forced exit after cleanup
        process.exit(0);
      });
    }, 100);
    return true;
  }

  return false;
}
