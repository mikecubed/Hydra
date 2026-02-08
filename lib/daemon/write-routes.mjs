#!/usr/bin/env node
/**
 * Mutating daemon routes (POST endpoints).
 */

import crypto from 'crypto';
import { createWorktree, removeWorktree, isWorktreeEnabled } from '../hydra-worktree.mjs';

export async function handleWriteRoute(ctx) {
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
    writeStatus,
    setIsShuttingDown,
    server,
  } = ctx;

  if (method === 'POST' && route === '/session/start') {
    const body = await readJsonBody(req);
    const focus = String(body.focus || '').trim();
    if (!focus) {
      sendError(res, 400, 'Field "focus" is required.');
      return true;
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
    return true;
  }

  if (method === 'POST' && route === '/session/fork') {
    const body = await readJsonBody(req);
    const reason = String(body.reason || '').trim();

    const result = await enqueueMutation('session:fork', (state) => {
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
        participants: [...parent.participants],
        status: 'active',
        reason: reason || 'Forked from parent session',
        contextSnapshot: JSON.stringify({
          tasks: state.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, owner: t.owner })),
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
    }, { event: 'session_fork', reason });

    sendJson(res, 200, { ok: true, session: result });
    return true;
  }

  if (method === 'POST' && route === '/session/spawn') {
    const body = await readJsonBody(req);
    const focus = String(body.focus || '').trim();
    if (!focus) {
      sendError(res, 400, 'Field "focus" is required for spawn.');
      return true;
    }
    const owner = String(body.owner || 'human').toLowerCase();

    const result = await enqueueMutation(`session:spawn focus="${focus}"`, (state) => {
      const parentId = state.activeSession?.id || null;
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
        participants: ['human', 'codex', 'claude', 'gemini'],
        status: 'active',
        startedAt: nowIso(),
        updatedAt: nowIso(),
      };

      if (!Array.isArray(state.childSessions)) {
        state.childSessions = [];
      }
      state.childSessions.push(child);

      return child;
    }, { event: 'session_spawn', focus: focus.slice(0, 80) });

    sendJson(res, 200, { ok: true, session: result });
    return true;
  }

  if (method === 'POST' && route === '/task/add') {
    const body = await readJsonBody(req);
    const title = String(body.title || '').trim();
    if (!title) {
      sendError(res, 400, 'Field "title" is required.');
      return true;
    }

    const owner = String(body.owner || 'unassigned').toLowerCase();
    ensureKnownAgent(owner);

    const status = String(body.status || 'todo');
    ensureKnownStatus(status);

    const files = parseList(body.files || []);
    const notes = String(body.notes || '').trim();
    const blockedBy = parseList(body.blockedBy || []);
    const taskType = String(body.type || '').trim() || classifyTask(title, notes);

    const wantWorktree = Boolean(body.worktree) && isWorktreeEnabled();

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

    // Create worktree after mutation succeeds (uses task.id)
    let worktreeInfo = null;
    if (wantWorktree && task.id) {
      try {
        worktreeInfo = createWorktree(task.id, projectRoot);
        // Update task record with worktree path via another mutation
        await enqueueMutation(`task:worktree id=${task.id}`, (state) => {
          const t = state.tasks.find((x) => x.id === task.id);
          if (t) {
            t.worktreePath = worktreeInfo.worktreePath;
            t.worktreeBranch = worktreeInfo.branch;
          }
        }, { event: 'worktree_create', taskId: task.id });
      } catch { /* non-critical */ }
    }

    sendJson(res, 200, { ok: true, task, worktree: worktreeInfo });
    return true;
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
        existing.claimToken = crypto.randomUUID();
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
        claimToken: crypto.randomUUID(),
        files,
        notes,
        blockedBy: claimBlockedBy,
        updatedAt: nowIso(),
      };
      state.tasks.push(newTask);
      return newTask;
    }, { event: 'task_claim', agent, title: claimTitle.slice(0, 80) });

    sendJson(res, 200, { ok: true, task });
    return true;
  }

  if (method === 'POST' && route === '/task/update') {
    const body = await readJsonBody(req);
    const taskId = String(body.taskId || '').trim();
    if (!taskId) {
      sendError(res, 400, 'Field "taskId" is required.');
      return true;
    }

    const updateStatus = body.status !== undefined ? String(body.status) : undefined;
    const updateOwner = body.owner !== undefined ? String(body.owner).toLowerCase() : undefined;
    const task = await enqueueMutation(`task:update id=${taskId}`, (state) => {
      const existing = state.tasks.find((item) => item.id === taskId);
      if (!existing) {
        throw new Error(`Task ${taskId} not found.`);
      }

      // Atomic claim token validation: if caller provides claimToken, it must match
      if (body.claimToken && !body.force) {
        if (existing.claimToken && existing.claimToken !== body.claimToken) {
          throw new Error(`Claim token mismatch for ${taskId}. Task is owned by another claim. Use force=true to override.`);
        }
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

    // Auto-cleanup worktree when task completes
    if (['done', 'cancelled'].includes(task.status) && task.worktreePath && isWorktreeEnabled()) {
      try {
        removeWorktree(taskId, projectRoot, { deleteBranch: task.status === 'cancelled' });
      } catch { /* non-critical */ }
    }

    const shouldVerify = task.status === 'done' && body.verify !== false;
    const verifyPlan = resolveVerificationPlan(projectRoot);
    const isVerifying = shouldVerify && verifyPlan.enabled;
    if (isVerifying) {
      runVerification(taskId, verifyPlan);
    }
    sendJson(res, 200, {
      ok: true,
      task,
      verifying: isVerifying,
      verification: {
        enabled: verifyPlan.enabled,
        source: verifyPlan.source,
        command: verifyPlan.command || null,
        reason: verifyPlan.reason,
      },
    });
    return true;
  }

  if (method === 'POST' && route === '/task/route') {
    const body = await readJsonBody(req);
    const taskId = String(body.taskId || '').trim();
    if (!taskId) {
      sendError(res, 400, 'Field "taskId" is required.');
      return true;
    }
    const state = readState();
    const target = state.tasks.find((t) => t.id === taskId);
    if (!target) {
      sendError(res, 404, `Task ${taskId} not found.`);
      return true;
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
    return true;
  }

  if (method === 'POST' && route === '/verify') {
    const body = await readJsonBody(req);
    const verifyTaskId = String(body.taskId || '').trim();
    if (!verifyTaskId) {
      sendError(res, 400, 'Field "taskId" is required.');
      return true;
    }
    const state = readState();
    const target = state.tasks.find((t) => t.id === verifyTaskId);
    if (!target) {
      sendError(res, 404, `Task ${verifyTaskId} not found.`);
      return true;
    }

    const verifyPlan = resolveVerificationPlan(projectRoot);
    if (!verifyPlan.enabled) {
      sendJson(res, 200, {
        ok: true,
        taskId: verifyTaskId,
        message: 'Verification skipped (no command configured).',
        verification: {
          enabled: false,
          source: verifyPlan.source,
          command: null,
          reason: verifyPlan.reason,
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
        source: verifyPlan.source,
        command: verifyPlan.command,
        reason: verifyPlan.reason,
      },
    });
    return true;
  }

  if (method === 'POST' && route === '/decision') {
    const body = await readJsonBody(req);
    const title = String(body.title || '').trim();
    if (!title) {
      sendError(res, 400, 'Field "title" is required.');
      return true;
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
    return true;
  }

  if (method === 'POST' && route === '/blocker') {
    const body = await readJsonBody(req);
    const title = String(body.title || '').trim();
    if (!title) {
      sendError(res, 400, 'Field "title" is required.');
      return true;
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
    return true;
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
      return true;
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
    return true;
  }

  if (method === 'POST' && route === '/handoff/ack') {
    const body = await readJsonBody(req);
    const handoffId = String(body.handoffId || '').trim();
    const agent = String(body.agent || '').toLowerCase();
    if (!handoffId || !agent) {
      sendError(res, 400, 'Fields "handoffId" and "agent" are required.');
      return true;
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
    return true;
  }

  if (method === 'POST' && route === '/task/checkpoint') {
    const body = await readJsonBody(req);
    const taskId = String(body.taskId || '').trim();
    if (!taskId) {
      sendError(res, 400, 'Field "taskId" is required.');
      return true;
    }
    const name = String(body.name || '').trim();
    if (!name) {
      sendError(res, 400, 'Field "name" is required.');
      return true;
    }
    const context = String(body.context || '').trim();
    const agent = String(body.agent || '').toLowerCase();

    const checkpoint = await enqueueMutation(`task:checkpoint id=${taskId} name=${name}`, (state) => {
      const task = state.tasks.find((t) => t.id === taskId);
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
      task.checkpoints.push(cp);
      task.updatedAt = nowIso();
      return cp;
    }, { event: 'checkpoint', taskId, name });

    sendJson(res, 200, { ok: true, checkpoint });
    return true;
  }

  if (method === 'POST' && route === '/state/archive') {
    const result = await enqueueMutation('state:archive', (state) => {
      const moved = archiveState(state);
      const trimmed = truncateEventsFile(500);
      return { moved, eventsTrimmed: trimmed };
    });
    sendJson(res, 200, { ok: true, ...result });
    return true;
  }

  if (method === 'POST' && route === '/shutdown') {
    sendJson(res, 200, { ok: true, message: 'Shutting down orchestrator daemon.' });
    setIsShuttingDown(true);
    writeStatus({ running: false, stoppingAt: nowIso() });
    setTimeout(() => {
      server.close(() => {
        writeStatus({ running: false, stoppedAt: nowIso() });
        process.exit(0);
      });
    }, 100);
    return true;
  }

  return false;
}

