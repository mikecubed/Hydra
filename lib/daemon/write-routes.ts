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
import { exit } from '../hydra-process.ts';

// ── Mutation helpers ──────────────────────────────────────────────────────────

function validateClaimToken(existing: TaskEntry, body: Record<string, unknown>): void {
  if (body['claimToken'] == null || body['force'] === true) return;
  const stored = (existing as Record<string, unknown>)['claimToken'];
  if (stored != null && stored !== body['claimToken']) {
    throw new Error(
      `Claim token mismatch for ${existing.id}. Task is owned by another claim. Use force=true to override.`,
    );
  }
}

function buildResultEntry(
  agent: string,
  resultStatus: string,
  durationMs: number,
  output: string,
  body: Record<string, unknown>,
  nowIso: () => string,
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    agent,
    status: resultStatus,
    durationMs,
    output: output.slice(0, 8000),
    submittedAt: nowIso(),
  };
  if (body['errorInfo'] != null) {
    const errInfo = body['errorInfo'] as Record<string, unknown>;
    entry['errorInfo'] = {
      exitCode: errInfo['exitCode'] ?? null,
      signal: (errInfo['signal'] as string | null | undefined) ?? null,
      stderr: ((errInfo['stderr'] as string | null | undefined) ?? '').slice(0, 1000),
      error: ((errInfo['error'] as string | null | undefined) ?? '').slice(0, 500),
      errorCategory: (errInfo['errorCategory'] as string | null | undefined) ?? null,
      errorDetail: (errInfo['errorDetail'] as string | null | undefined) ?? null,
      errorContext: ((errInfo['errorContext'] as string | null | undefined) ?? '').slice(0, 500),
    };
  }
  return entry;
}

function applyResultStatus(
  task: TaskEntry,
  state: HydraStateShape,
  taskId: string,
  agent: string,
  resultStatus: string,
  output: string,
  autoUnblock: (s: HydraStateShape, id: string) => void,
  nowIso: () => string,
): void {
  if (task.status !== 'in_progress' || task.owner !== agent) return;
  if (resultStatus === 'completed' || resultStatus === 'done') {
    task.status = 'done';
    autoUnblock(state, taskId);
  } else if (resultStatus === 'error') {
    const currentFailCount = (task as Record<string, unknown>)['failCount'] as number | undefined;
    (task as Record<string, unknown>)['failCount'] = (currentFailCount ?? 0) + 1;
    const maxAttempts = 3;
    if (((task as Record<string, unknown>)['failCount'] as number) >= maxAttempts) {
      if (!Array.isArray((state as Record<string, unknown>)['deadLetter']))
        (state as Record<string, unknown>)['deadLetter'] = [];
      (task as Record<string, unknown>)['status'] = 'cancelled';
      (task as Record<string, unknown>)['deadLetteredAt'] = nowIso();
      ((state as Record<string, unknown>)['deadLetter'] as unknown[]).push({ ...task });
      state.tasks = state.tasks.filter((t: TaskEntry) => t.id !== taskId);
    } else {
      task.status = 'blocked';
      (task as Record<string, unknown>)['blockedReason'] =
        output.slice(0, 500) === '' ? 'Agent reported error' : output.slice(0, 500);
    }
  }
}

function resolveVerifyCommand(verifyPlan: Record<string, unknown>): string | null {
  const cmd = verifyPlan['command'] as string | null | undefined;
  return cmd == null || cmd === '' ? null : cmd;
}

function checkClaimWorktreeCondition(
  isNewTask: boolean,
  createFn: unknown,
  body: Record<string, unknown>,
  mode: string,
): boolean {
  if (!isNewTask || typeof createFn !== 'function') return false;
  return body['worktree'] === true || mode === 'tandem' || mode === 'council';
}

function scorePhysicalAgents(
  names: string[],
  getAgent: WriteRouteCtx['getAgent'],
  taskType: string,
): { scores: Record<string, number>; recommended: string; bestScore: number } {
  const scores: Record<string, number> = {};
  let recommended = names[0] ?? '';
  let bestScore = 0;
  for (const name of names) {
    const cfg = getAgent(name);
    const score = (cfg?.taskAffinity as Record<string, number> | undefined)?.[taskType] ?? 0.5;
    scores[name] = score;
    if (score > bestScore) {
      bestScore = score;
      recommended = name;
    }
  }
  return { scores, recommended, bestScore };
}

function scoreVirtualAgents(
  ctx: WriteRouteCtx,
  taskType: string,
): { virtualScores: Record<string, number>; virtualRecommended: string | null } {
  const virtualAgents = ctx.listAgents({ type: 'virtual', enabled: true });
  const virtualScores: Record<string, number> = {};
  let virtualRecommended: string | null = null;
  for (const va of virtualAgents) {
    const score = (va.taskAffinity as Record<string, number> | undefined)?.[taskType] ?? 0;
    virtualScores[va.name] = score;
    if (
      virtualRecommended == null ||
      virtualRecommended === '' ||
      score > (virtualScores[virtualRecommended] ?? 0)
    ) {
      virtualRecommended = va.name;
    }
  }
  return { virtualScores, virtualRecommended };
}

async function applyWorktreeMerge(
  taskId: string,
  completedTask: Record<string, unknown> | undefined,
  ctx: WriteRouteCtx,
): Promise<void> {
  const { mergeTaskWorktree, cleanupTaskWorktree, enqueueMutation, nowIso } = ctx;
  if (completedTask?.['worktreePath'] == null || typeof mergeTaskWorktree !== 'function') return;
  try {
    const mergeResult = mergeTaskWorktree(taskId);
    if (mergeResult['ok'] === true) {
      const { loadHydraConfig } = await import('../hydra-config.ts');
      const cfg = loadHydraConfig();
      if (cfg.routing.worktreeIsolation.cleanupOnSuccess !== false) cleanupTaskWorktree(taskId);
    } else if (mergeResult['conflict'] === true) {
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
  } catch {
    /* non-critical — merge failure must not fail the result POST */
  }
}

// ── Mutation factories ────────────────────────────────────────────────────────

function mutateTaskClaim(
  body: Record<string, unknown>,
  agent: string,
  ctx: WriteRouteCtx,
): (state: HydraStateShape) => Record<string, unknown> {
  const { parseList, nextId, nowIso } = ctx;
  return (state: HydraStateShape) => {
    const taskId = ((body['taskId'] as string | null | undefined) ?? '').trim();
    const title = ((body['title'] as string | null | undefined) ?? '').trim();
    const files = parseList(body['files']);
    const notes = ((body['notes'] as string | null | undefined) ?? '').trim();
    if (taskId !== '') {
      const existing = state.tasks.find((item: TaskEntry) => item.id === taskId);
      if (!existing) throw new Error(`Task ${taskId} not found.`);
      if (['done', 'cancelled'].includes(existing.status)) {
        throw new Error(`Task ${taskId} is already ${existing.status}.`);
      }
      if (existing.status === 'in_progress' && existing.owner !== agent) {
        throw new Error(`Task ${taskId} is already in progress by ${existing.owner}.`);
      }
      existing.owner = agent;
      existing.status = 'in_progress';
      (existing as Record<string, unknown>)['claimToken'] = crypto.randomUUID();
      if (files.length > 0) existing.files = files;
      if (notes !== '') {
        existing.notes = existing.notes === '' ? notes : `${existing.notes}\n${notes}`;
      }
      existing.updatedAt = nowIso();
      return existing as unknown as Record<string, unknown>;
    }
    if (title === '') throw new Error('Either taskId or title is required.');
    const claimBlockedBy = parseList(body['blockedBy'] ?? []);
    const newTask: Record<string, unknown> = {
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
  };
}

function mutateTaskUpdate(
  body: Record<string, unknown>,
  taskId: string,
  ctx: WriteRouteCtx,
): (state: HydraStateShape) => TaskEntry {
  const { parseList, ensureKnownAgent, ensureKnownStatus, detectCycle, autoUnblock, nowIso } = ctx;
  return (state: HydraStateShape) => {
    const existing = state.tasks.find((item: TaskEntry) => item.id === taskId);
    if (!existing) throw new Error(`Task ${taskId} not found.`);
    validateClaimToken(existing, body);
    if (body['title'] !== undefined) existing.title = body['title'] as string;
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
      ensureKnownStatus(body['status'] as string);
      (existing as Record<string, unknown>)['status'] = body['status'] as string;
    }
    if (body['files'] !== undefined) existing.files = parseList(body['files']);
    if (body['notes'] !== undefined) {
      const notes = (body['notes'] as string).trim();
      if (notes !== '') {
        existing.notes = existing.notes === '' ? notes : `${existing.notes}\n${notes}`;
      }
    }
    existing.updatedAt = nowIso();
    if ((existing as Record<string, unknown>)['stale'] === true) {
      (existing as Record<string, unknown>)['stale'] = false;
      delete (existing as Record<string, unknown>)['staleSince'];
    }
    if (['done', 'cancelled'].includes(existing.status)) autoUnblock(state, taskId);
    return existing;
  };
}

function mutateTaskResult(
  body: Record<string, unknown>,
  taskId: string,
  agent: string,
  resultStatus: string,
  durationMs: number,
  output: string,
  ctx: WriteRouteCtx,
): (state: HydraStateShape) => { task: TaskEntry; entry: Record<string, unknown> } {
  const { nowIso, autoUnblock } = ctx;
  return (state: HydraStateShape) => {
    const task = state.tasks.find((t: TaskEntry) => t.id === taskId);
    if (!task) throw new Error(`Task ${taskId} not found.`);
    if (!Array.isArray((task as Record<string, unknown>)['results'])) {
      (task as Record<string, unknown>)['results'] = [];
    }
    const entry = buildResultEntry(agent, resultStatus, durationMs, output, body, nowIso);
    ((task as Record<string, unknown>)['results'] as unknown[]).push(entry);
    task.updatedAt = nowIso();
    applyResultStatus(task, state, taskId, agent, resultStatus, output, autoUnblock, nowIso);
    if ((task as Record<string, unknown>)['stale'] === true) {
      (task as Record<string, unknown>)['stale'] = false;
      delete (task as Record<string, unknown>)['staleSince'];
    }
    return { task, entry };
  };
}

// ── Route handlers ────────────────────────────────────────────────────────────

async function handleEventsPush(ctx: WriteRouteCtx): Promise<boolean> {
  const { req, res, sendJson, sendError, appendEvent, broadcastEvent } = ctx;
  const body = await ctx.readJsonBody(req);
  const type = ((body['type'] as string | null | undefined) ?? '').trim();
  const payload = body['payload'] ?? {};
  const ALLOWED_TYPES = [
    'concierge:dispatch',
    'concierge:summary',
    'concierge:error',
    'concierge:model_switch',
  ];
  if (type === '' || !ALLOWED_TYPES.includes(type)) {
    sendError(res, 400, `Invalid event type. Allowed: ${ALLOWED_TYPES.join(', ')}`);
    return true;
  }
  appendEvent(type, payload);
  broadcastEvent({ type, payload, at: new Date().toISOString() });
  sendJson(res, 200, { ok: true, type });
  return true;
}

async function handleSessionStart(ctx: WriteRouteCtx): Promise<boolean> {
  const {
    req, res, sendJson, sendError, enqueueMutation, ensureKnownAgent,
    parseList, getCurrentBranch, toSessionId, nowIso,
  } = ctx;
  const body = await ctx.readJsonBody(req);
  const focus = ((body['focus'] as string | null | undefined) ?? '').trim();
  if (focus === '') {
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

async function handleSessionFork(ctx: WriteRouteCtx): Promise<boolean> {
  const { req, res, sendJson, enqueueMutation, nowIso } = ctx;
  const body = await ctx.readJsonBody(req);
  const reason = ((body['reason'] as string | null | undefined) ?? '').trim();
  const result = await enqueueMutation(
    'session:fork',
    (state: HydraStateShape) => {
      if (!state.activeSession) throw new Error('No active session to fork.');
      const parent = state.activeSession;
      const forkId = `${parent.id}_FORK_${Date.now().toString(36)}`;
      if (!Array.isArray(parent.children)) parent.children = [];
      parent.children.push(forkId);
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
        reason: reason === '' ? 'Forked from parent session' : reason,
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
      if (!Array.isArray(state.childSessions)) state.childSessions = [];
      state.childSessions.push(fork);
      return fork;
    },
    { event: 'session_fork', reason },
  );
  sendJson(res, 200, { ok: true, session: result });
  return true;
}

async function handleSessionSpawn(ctx: WriteRouteCtx): Promise<boolean> {
  const { req, res, sendJson, sendError, enqueueMutation, getCurrentBranch, nowIso } = ctx;
  const body = await ctx.readJsonBody(req);
  const focus = ((body['focus'] as string | null | undefined) ?? '').trim();
  if (focus === '') {
    sendError(res, 400, 'Field "focus" is required for spawn.');
    return true;
  }
  const owner = ((body['owner'] as string | null | undefined) ?? 'human').toLowerCase();
  const result = await enqueueMutation(
    `session:spawn focus="${focus}"`,
    (state: HydraStateShape) => {
      const parentId: string = state.activeSession?.id ?? '';
      const spawnId = `${parentId === '' ? 'ROOT' : parentId}_SPAWN_${Date.now().toString(36)}`;
      if (state.activeSession) {
        if (!Array.isArray(state.activeSession.children)) state.activeSession.children = [];
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
      if (!Array.isArray(state.childSessions)) state.childSessions = [];
      state.childSessions.push(child);
      return child;
    },
    { event: 'session_spawn', focus: focus.slice(0, 80) },
  );
  sendJson(res, 200, { ok: true, session: result });
  return true;
}

async function handleSessionPause(ctx: WriteRouteCtx): Promise<boolean> {
  const { req, res, sendJson, enqueueMutation, nowIso } = ctx;
  const body = await ctx.readJsonBody(req);
  const reason = ((body['reason'] as string | null | undefined) ?? '').trim();
  const session = await enqueueMutation(
    'session:pause',
    (state: HydraStateShape) => {
      if (!state.activeSession) throw new Error('No active session to pause.');
      if (state.activeSession.status === 'paused') throw new Error('Session is already paused.');
      state.activeSession.status = 'paused';
      state.activeSession.pauseReason = reason === '' ? undefined : reason;
      state.activeSession.pausedAt = nowIso();
      return state.activeSession;
    },
    { event: 'session_pause', reason: reason.slice(0, 80) },
  );
  sendJson(res, 200, { ok: true, session });
  return true;
}

async function handleSessionResume(ctx: WriteRouteCtx): Promise<boolean> {
  const { req, res, sendJson, enqueueMutation, nowIso } = ctx;
  await ctx.readJsonBody(req);
  const session = await enqueueMutation(
    'session:resume',
    (state: HydraStateShape) => {
      if (!state.activeSession) throw new Error('No active session to resume.');
      if (state.activeSession.status !== 'paused') throw new Error('Session is not paused.');
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

async function handleTaskAdd(ctx: WriteRouteCtx): Promise<boolean> {
  const {
    req, res, sendJson, sendError, enqueueMutation, ensureKnownAgent, ensureKnownStatus,
    parseList, classifyTask, nextId, nowIso, projectRoot,
  } = ctx;
  const body = await ctx.readJsonBody(req);
  const title = ((body['title'] as string | null | undefined) ?? '').trim();
  if (title === '') {
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
  const bodyType = ((body['type'] as string | null | undefined) ?? '').trim();
  const taskType = bodyType === '' ? classifyTask(title, notes) : bodyType;
  const wantWorktree = Boolean(body['worktree']) && isWorktreeEnabled();
  const task = await enqueueMutation(
    `task:add owner=${owner} status=${status} type=${taskType}`,
    (state: HydraStateShape) => {
      const item = {
        id: nextId('T', state.tasks),
        title, owner, status, type: taskType, files, notes, blockedBy, updatedAt: nowIso(),
      };
      state.tasks.push(item as unknown as TaskEntry);
      return item;
    },
    { event: 'task_add', owner, title: title.slice(0, 80) },
  );
  let worktreeInfo: Record<string, unknown> | null = null;
  if (wantWorktree && (task as Record<string, unknown>)['id'] != null) {
    try {
      worktreeInfo = createWorktree(
        (task as Record<string, unknown>)['id'] as string,
        projectRoot as string,
      ) as Record<string, unknown>;
      await enqueueMutation(
        `task:worktree id=${(task as Record<string, unknown>)['id'] as string}`,
        (state: HydraStateShape) => {
          const t = state.tasks.find((x: TaskEntry) => x.id === (task as Record<string, unknown>)['id'] as string);
          if (t && worktreeInfo != null) {
            t.worktreePath = worktreeInfo['worktreePath'] as string;
            t.worktreeBranch = worktreeInfo['branch'] as string;
          }
        },
        { event: 'worktree_create', taskId: (task as Record<string, unknown>)['id'] as string },
      );
    } catch {
      /* non-critical */
    }
  }
  sendJson(res, 200, { ok: true, task, worktree: worktreeInfo });
  return true;
}

async function handleTaskClaim(ctx: WriteRouteCtx): Promise<boolean> {
  const { req, res, sendJson, enqueueMutation, ensureKnownAgent, projectRoot, createTaskWorktree } = ctx;
  const body = await ctx.readJsonBody(req);
  const agent = ((body['agent'] as string | null | undefined) ?? '').toLowerCase();
  ensureKnownAgent(agent, false);
  const claimTitle = (
    (body['title'] as string | null | undefined) ??
    (body['taskId'] as string | null | undefined) ??
    ''
  ).trim();
  const task = await enqueueMutation(
    `task:claim agent=${agent}`,
    mutateTaskClaim(body, agent, ctx),
    { event: 'task_claim', agent, title: claimTitle.slice(0, 80) },
  );
  const taskId = task['id'] as string;
  const dispatchMode = ((body['mode'] as string | null | undefined) ?? '').toLowerCase();
  const isNewTask = body['taskId'] == null || body['taskId'] === '';
  if (checkClaimWorktreeCondition(isNewTask, createTaskWorktree, body, dispatchMode)) {
    try {
      const { loadHydraConfig } = await import('../hydra-config.ts');
      const cfg = loadHydraConfig();
      if (cfg.routing.worktreeIsolation.enabled) {
        const worktreePath = createTaskWorktree(taskId);
        if (worktreePath != null && worktreePath !== '') {
          const branch = `hydra/task/${taskId}`;
          await enqueueMutation(
            `task:worktree id=${taskId}`,
            (state: HydraStateShape) => {
              const t = state.tasks.find((x: TaskEntry) => x.id === taskId);
              if (t) {
                (t as Record<string, unknown>)['worktreePath'] = worktreePath;
                (t as Record<string, unknown>)['worktreeBranch'] = branch;
              }
            },
            { event: 'worktree_create', taskId },
          );
        }
      }
    } catch {
      /* worktree creation is non-critical */
    }
  }
  try {
    hubRegister({
      id: `daemon_${taskId}`,
      agent: task['owner'] as string,
      cwd: projectRoot as string,
      project: path.basename(projectRoot as string),
      focus: task['title'] as string,
      files: task['files'] as string[],
      taskId,
      status: 'working',
    });
  } catch {
    /* hub sync is non-critical */
  }
  sendJson(res, 200, { ok: true, task });
  return true;
}

async function handleTaskUpdate(ctx: WriteRouteCtx): Promise<boolean> {
  const {
    req, res, sendJson, sendError, enqueueMutation, resolveVerificationPlan,
    runVerification, projectRoot,
  } = ctx;
  const body = await ctx.readJsonBody(req);
  const taskId = ((body['taskId'] as string | null | undefined) ?? '').trim();
  if (taskId === '') {
    sendError(res, 400, 'Field "taskId" is required.');
    return true;
  }
  const updateStatus = body['status'] === undefined ? undefined : (body['status'] as string);
  const updateOwner =
    body['owner'] === undefined ? undefined : (body['owner'] as string).toLowerCase();
  const task = await enqueueMutation(
    `task:update id=${taskId}`,
    mutateTaskUpdate(body, taskId, ctx),
    { event: 'task_update', taskId, status: updateStatus, owner: updateOwner },
  );
  if (
    ['done', 'cancelled'].includes((task as Record<string, unknown>)['status'] as string) &&
    (task as Record<string, unknown>)['worktreePath'] != null &&
    isWorktreeEnabled()
  ) {
    try {
      removeWorktree(taskId, projectRoot as string, {
        deleteBranch: (task as Record<string, unknown>)['status'] === 'cancelled',
      });
    } catch {
      /* non-critical */
    }
  }
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
  const isVerifying = shouldVerify && verifyPlan['enabled'] === true;
  if (isVerifying) runVerification(taskId, verifyPlan);
  sendJson(res, 200, {
    ok: true,
    task,
    verifying: isVerifying,
    verification: {
      enabled: verifyPlan['enabled'],
      source: verifyPlan['source'],
      command: resolveVerifyCommand(verifyPlan),
      reason: verifyPlan['reason'],
    },
  });
  return true;
}

async function handleTaskRoute(ctx: WriteRouteCtx): Promise<boolean> {
  const { req, res, sendJson, sendError, readState, classifyTask, AGENT_NAMES, getAgent } = ctx;
  const body = await ctx.readJsonBody(req);
  const taskId = ((body['taskId'] as string | null | undefined) ?? '').trim();
  const includeVirtual = body['includeVirtual'] === true;
  if (taskId === '') {
    sendError(res, 400, 'Field "taskId" is required.');
    return true;
  }
  const state = readState();
  const target = state.tasks.find((t: TaskEntry) => t.id === taskId);
  if (!target) {
    sendError(res, 404, `Task ${taskId} not found.`);
    return true;
  }
  const taskType = target.type === '' ? classifyTask(target.title, target.notes) : target.type;
  const { scores, recommended, bestScore } = scorePhysicalAgents(AGENT_NAMES, getAgent, taskType);
  const response: Record<string, unknown> = {
    ok: true,
    taskId,
    taskType,
    recommended,
    scores,
    reason: `${taskType} task best suited for ${recommended} (affinity=${String(bestScore)})`,
  };
  if (includeVirtual) {
    const { virtualScores, virtualRecommended } = scoreVirtualAgents(ctx, taskType);
    if (Object.keys(virtualScores).length > 0) {
      response['virtualScores'] = virtualScores;
      response['virtualRecommended'] = virtualRecommended;
    }
  }
  sendJson(res, 200, response);
  return true;
}

async function handleVerify(ctx: WriteRouteCtx): Promise<boolean> {
  const {
    req, res, sendJson, sendError, readState, resolveVerificationPlan, runVerification, projectRoot,
  } = ctx;
  const body = await ctx.readJsonBody(req);
  const verifyTaskId = ((body['taskId'] as string | null | undefined) ?? '').trim();
  if (verifyTaskId === '') {
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
  if (verifyPlan['enabled'] !== true) {
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

async function handleDecision(ctx: WriteRouteCtx): Promise<boolean> {
  const { req, res, sendJson, sendError, enqueueMutation, ensureKnownAgent, nextId, nowIso } = ctx;
  const body = await ctx.readJsonBody(req);
  const title = ((body['title'] as string | null | undefined) ?? '').trim();
  if (title === '') {
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
        title, owner, rationale, impact, createdAt: nowIso(),
      };
      state.decisions.push(item);
      return item;
    },
    { event: 'decision', title: title.slice(0, 80) },
  );
  sendJson(res, 200, { ok: true, decision });
  return true;
}

async function handleBlocker(ctx: WriteRouteCtx): Promise<boolean> {
  const { req, res, sendJson, sendError, enqueueMutation, ensureKnownAgent, nextId, nowIso } = ctx;
  const body = await ctx.readJsonBody(req);
  const title = ((body['title'] as string | null | undefined) ?? '').trim();
  if (title === '') {
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
        title, owner, status: 'open', nextStep, createdAt: nowIso(),
      };
      state.blockers.push(item);
      return item;
    },
  );
  sendJson(res, 200, { ok: true, blocker });
  return true;
}

async function handleHandoff(ctx: WriteRouteCtx): Promise<boolean> {
  const {
    req, res, sendJson, sendError, enqueueMutation, ensureKnownAgent, parseList, nextId, nowIso,
  } = ctx;
  const body = await ctx.readJsonBody(req);
  const from = ((body['from'] as string | null | undefined) ?? '').toLowerCase();
  const to = ((body['to'] as string | null | undefined) ?? '').toLowerCase();
  const summary = ((body['summary'] as string | null | undefined) ?? '').trim();
  const nextStep = (body['nextStep'] as string | null | undefined) ?? '';
  const tasks = parseList(body['tasks']);
  if (from === '' || to === '' || summary === '') {
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
        from, to, summary, nextStep, tasks, createdAt: nowIso(),
      };
      state.handoffs.push(item);
      return item;
    },
    { event: 'handoff', from, to, summary: summary.slice(0, 60) },
  );
  sendJson(res, 200, { ok: true, handoff });
  return true;
}

async function handleHandoffAck(ctx: WriteRouteCtx): Promise<boolean> {
  const { req, res, sendJson, sendError, enqueueMutation, ensureKnownAgent, nowIso } = ctx;
  const body = await ctx.readJsonBody(req);
  const handoffId = ((body['handoffId'] as string | null | undefined) ?? '').trim();
  const agent = ((body['agent'] as string | null | undefined) ?? '').toLowerCase();
  if (handoffId === '' || agent === '') {
    sendError(res, 400, 'Fields "handoffId" and "agent" are required.');
    return true;
  }
  ensureKnownAgent(agent, false);
  const handoff = await enqueueMutation(
    `handoff:ack id=${handoffId} by=${agent}`,
    (state: HydraStateShape) => {
      const item = state.handoffs.find((entry: HandoffEntry) => entry.id === handoffId);
      if (!item) throw new Error(`Handoff ${handoffId} not found.`);
      item.acknowledgedAt = nowIso();
      item.acknowledgedBy = agent;
      return item;
    },
    { event: 'handoff_ack', agent, handoffId },
  );
  sendJson(res, 200, { ok: true, handoff });
  return true;
}

async function handleTaskResult(ctx: WriteRouteCtx): Promise<boolean> {
  const { req, res, sendJson, sendError, enqueueMutation, ensureKnownAgent } = ctx;
  const body = await ctx.readJsonBody(req);
  const taskId = ((body['taskId'] as string | null | undefined) ?? '').trim();
  const agent = ((body['agent'] as string | null | undefined) ?? '').toLowerCase();
  if (taskId === '' || agent === '') {
    sendError(res, 400, 'Fields "taskId" and "agent" are required.');
    return true;
  }
  ensureKnownAgent(agent, false);
  const output = ((body['output'] as string | null | undefined) ?? '').trim();
  const resultStatus = (body['status'] as string | null | undefined) ?? 'completed';
  const durationMsRaw = Number(body['durationMs']);
  const durationMs = Number.isNaN(durationMsRaw) ? 0 : durationMsRaw;
  const result = await enqueueMutation(
    `task:result id=${taskId} agent=${agent} status=${resultStatus}`,
    mutateTaskResult(body, taskId, agent, resultStatus, durationMs, output, ctx),
    { event: 'task_result', taskId, agent, status: resultStatus, category: 'agent' },
  );
  const completedTask = (result as Record<string, unknown>)['task'] as
    | Record<string, unknown>
    | undefined;
  const taskDone = completedTask != null && ['done'].includes(completedTask['status'] as string);
  await applyWorktreeMerge(taskId, taskDone ? completedTask : undefined, ctx);
  sendJson(res, 200, { ok: true, ...result });
  return true;
}

async function handleTaskCheckpoint(ctx: WriteRouteCtx): Promise<boolean> {
  const { req, res, sendJson, sendError, enqueueMutation, nowIso } = ctx;
  const body = await ctx.readJsonBody(req);
  const taskId = ((body['taskId'] as string | null | undefined) ?? '').trim();
  if (taskId === '') {
    sendError(res, 400, 'Field "taskId" is required.');
    return true;
  }
  const name = ((body['name'] as string | null | undefined) ?? '').trim();
  if (name === '') {
    sendError(res, 400, 'Field "name" is required.');
    return true;
  }
  const context = ((body['context'] as string | null | undefined) ?? '').trim();
  const agent = ((body['agent'] as string | null | undefined) ?? '').toLowerCase();
  const checkpoint = await enqueueMutation(
    `task:checkpoint id=${taskId} name=${name}`,
    (state: HydraStateShape) => {
      const task = state.tasks.find((t: TaskEntry) => t.id === taskId);
      if (!task) throw new Error(`Task ${taskId} not found.`);
      if (!Array.isArray(task.checkpoints)) task.checkpoints = [];
      const cp = {
        name,
        savedAt: nowIso(),
        context,
        agent: ([agent, task.owner] as string[]).find((s) => s !== '') ?? 'unknown',
      };
      (task.checkpoints as unknown[]).push(cp);
      task.updatedAt = nowIso();
      if ((task as Record<string, unknown>)['stale'] === true) {
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

async function handleTaskHeartbeat(ctx: WriteRouteCtx): Promise<boolean> {
  const { req, res, route, sendJson, sendError, enqueueMutation, nowIso } = ctx;
  const taskId = route.slice('/task/'.length, -'/heartbeat'.length);
  if (taskId === '') {
    sendError(res, 400, 'Task ID required in URL.');
    return true;
  }
  const body = await ctx.readJsonBody(req);
  const agent = ((body['agent'] as string | null | undefined) ?? '').toLowerCase();
  const result = await enqueueMutation(
    `task:heartbeat id=${taskId}`,
    (state: HydraStateShape) => {
      const task = state.tasks.find((t: TaskEntry) => t.id === taskId);
      if (!task) throw new Error(`Task ${taskId} not found.`);
      const now = nowIso();
      (task as Record<string, unknown>)['lastHeartbeat'] = now;
      task.updatedAt = now;
      (task as Record<string, unknown>)['lastHeartbeatDetail'] = {
        agent: ([agent, task.owner] as string[]).find((s) => s !== '') ?? 'unknown',
        progress: body['progress'] ?? null,
        outputBytes: body['outputBytes'] ?? 0,
        phase: body['phase'] ?? null,
      };
      if ((task as Record<string, unknown>)['stale'] === true) {
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

async function handleStateArchive(ctx: WriteRouteCtx): Promise<boolean> {
  const { res, sendJson, enqueueMutation, archiveState, truncateEventsFile } = ctx;
  const result = await enqueueMutation('state:archive', (state: HydraStateShape) => {
    const moved = archiveState(state);
    const trimmed = truncateEventsFile(500);
    return { moved, eventsTrimmed: trimmed };
  });
  sendJson(res, 200, { ok: true, ...result });
  return true;
}

function handleDeadLetterGet(ctx: WriteRouteCtx): Promise<boolean> {
  const { res, sendJson, readState } = ctx;
  const state = readState();
  sendJson(res, 200, { ok: true, items: (state as Record<string, unknown>)['deadLetter'] ?? [] });
  return Promise.resolve(true);
}

async function handleDeadLetterRetry(ctx: WriteRouteCtx): Promise<boolean> {
  const { req, res, sendJson, sendError, enqueueMutation, nowIso } = ctx;
  const body = await ctx.readJsonBody(req);
  const dlId = ((body['id'] as string | null | undefined) ?? '').trim();
  if (dlId === '') {
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

function handleAdminCompact(ctx: WriteRouteCtx): Promise<boolean> {
  const {
    res, sendJson,
    createSnapshot: _createSnapshot,
    cleanOldSnapshots: _cleanOldSnapshots,
    truncateEventsFile,
  } = ctx;
  const result: Record<string, unknown> = _createSnapshot();
  if (result['ok'] === true) {
    result['eventsTrimmed'] = truncateEventsFile(500);
  }
  _cleanOldSnapshots();
  sendJson(res, 200, { ok: true, ...result });
  return Promise.resolve(true);
}

function handleShutdown(ctx: WriteRouteCtx): Promise<boolean> {
  const { res, sendJson, setIsShuttingDown, server, nowIso, writeStatus } = ctx;
  sendJson(res, 200, { ok: true, message: 'Shutting down orchestrator daemon.' });
  setIsShuttingDown(true);
  writeStatus({ running: false, stoppingAt: nowIso() });
  setTimeout(() => {
    server.close(() => {
      writeStatus({ running: false, stoppedAt: nowIso() });
      exit(0);
    });
  }, 100);
  return Promise.resolve(true);
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

const POST_ROUTES: Partial<Record<string, (ctx: WriteRouteCtx) => Promise<boolean>>> = {
  '/events/push': handleEventsPush,
  '/session/start': handleSessionStart,
  '/session/fork': handleSessionFork,
  '/session/spawn': handleSessionSpawn,
  '/session/pause': handleSessionPause,
  '/session/resume': handleSessionResume,
  '/task/add': handleTaskAdd,
  '/task/claim': handleTaskClaim,
  '/task/update': handleTaskUpdate,
  '/task/route': handleTaskRoute,
  '/verify': handleVerify,
  '/decision': handleDecision,
  '/blocker': handleBlocker,
  '/handoff': handleHandoff,
  '/handoff/ack': handleHandoffAck,
  '/task/result': handleTaskResult,
  '/task/checkpoint': handleTaskCheckpoint,
  '/state/archive': handleStateArchive,
  '/dead-letter/retry': handleDeadLetterRetry,
  '/admin/compact': handleAdminCompact,
  '/shutdown': handleShutdown,
};

export async function handleWriteRoute(ctx: WriteRouteCtx): Promise<boolean> {
  const { method, route, req, res, sendJson, checkIdempotency } = ctx;

  if (method === 'POST' && checkIdempotency) {
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    if (idempotencyKey != null && idempotencyKey !== '' && checkIdempotency(idempotencyKey)) {
      sendJson(res, 409, { ok: false, error: 'Duplicate request (idempotency key already seen)' });
      return true;
    }
  }

  if (method === 'GET' && route === '/dead-letter') return handleDeadLetterGet(ctx);
  if (method === 'POST') {
    const handler = POST_ROUTES[route];
    if (handler != null) return handler(ctx);
    if (route.startsWith('/task/') && route.endsWith('/heartbeat')) return handleTaskHeartbeat(ctx);
  }

  return false;
}
