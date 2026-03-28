/**
 * Config mutation routes — safe config view and mutation endpoints.
 *
 * Wired into the daemon request pipeline after authorization.
 * Uses configMutex for serialized read-modify-write on config changes.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import z from 'zod';
import {
  loadHydraConfig,
  saveHydraConfig,
  invalidateConfigCache,
  activeConfigPath,
  HYDRA_RUNTIME_ROOT,
} from '../hydra-config.ts';
import { configMutex } from './mutation-lock.ts';
// Type-only imports from @hydra/web-contracts — erased at compile time so the
// daemon tarball stays self-contained (no runtime dep on the private workspace pkg).
import type { SafeConfigView as SafeConfigViewType, MutationAuditRecord } from '@hydra/web-contracts';
import { sendJson, sendError, readJsonBody } from './http-utils.ts';

// ── Local schemas (mirror @hydra/web-contracts — single source of truth for types,
// local Zod for daemon runtime validation to avoid bundling the workspace package) ──

const FORBIDDEN_KEY = /(apiKey|secret|hash|password)/i;

function hasForbiddenKey(val: unknown, path_: string[] = []): string | null {
  if (typeof val !== 'object' || val === null) return null;
  for (const key of Object.keys(val)) {
    if (FORBIDDEN_KEY.test(key)) return [...path_, key].join('.');
    const nested = hasForbiddenKey((val as Record<string, unknown>)[key], [...path_, key]);
    if (nested !== null) return nested;
  }
  return null;
}

const safeConfigViewSchema = z
  .unknown()
  .superRefine((val, ctx) => {
    const found = hasForbiddenKey(val);
    if (found !== null) ctx.addIssue({ code: 'custom', message: `forbidden key: ${found}` });
  })
  .pipe(z.object({ routing: z.unknown(), models: z.unknown(), usage: z.unknown() }).strip());

const routingModeMutationSchema = z.object({
  mode: z.enum(['economy', 'balanced', 'performance']),
  expectedRevision: z.string(),
});

const modelTierMutationSchema = z.object({
  tier: z.enum(['default', 'fast', 'cheap']),
  expectedRevision: z.string(),
});

const budgetMutationSchema = z
  .object({
    modelId: z.string(),
    dailyLimit: z.number().int().positive().nullable(),
    weeklyLimit: z.number().int().positive().nullable(),
    expectedRevision: z.string(),
  })
  .refine((val) => !(val.dailyLimit === null && val.weeklyLimit === null), {
    message: 'At least one of dailyLimit or weeklyLimit must be non-null',
  });

const workflowLaunchSchema = z.object({
  workflow: z.enum(['evolve', 'tasks', 'nightly']),
  label: z.string().nullable().optional(),
  idempotencyKey: z.string().pipe(z.uuid()),
  expectedRevision: z.string(),
});

// ── Revision ─────────────────────────────────────────────────────────────────

export function computeConfigRevision(config: {
  routing?: unknown;
  models?: unknown;
  usage?: unknown;
}): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ routing: config.routing, models: config.models, usage: config.usage }))
    .digest('hex')
    .slice(0, 32);
}

// ── Audit store ───────────────────────────────────────────────────────────────

const AUDIT_FILE = path.join(HYDRA_RUNTIME_ROOT, 'mutation-audit.jsonl');

const auditRecords: MutationAuditRecord[] = [];

function appendAuditRecord(record: MutationAuditRecord): void {
  auditRecords.push(record);
  try {
    fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    /* audit failure must not suppress 200 — R-2 */
  }
}

// ── Workflow launch store ─────────────────────────────────────────────────────

export interface WorkflowEntry {
  taskId: string;
  workflow: string;
  idempotencyKey: string;
  launchedAt: string;
  status: 'pending' | 'running' | 'done' | 'failed';
}

const workflowLaunches: WorkflowEntry[] = [];

const DESTRUCTIVE_WORKFLOWS = new Set(['evolve', 'nightly']);

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildSafeView(config: {
  routing?: unknown;
  models?: unknown;
  usage?: unknown;
}): SafeConfigViewType {
  return safeConfigViewSchema.parse({
    routing: config.routing,
    models: config.models,
    usage: config.usage,
  }) as SafeConfigViewType;
}

function buildAuditRecord(
  partial: Omit<MutationAuditRecord, 'id' | 'timestamp' | 'operatorId' | 'sessionId' | 'sourceIp'>,
): MutationAuditRecord {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    operatorId: null,
    sessionId: null,
    sourceIp: '',
    ...partial,
  };
}

// ── Audit pagination ──────────────────────────────────────────────────────────

function getAuditPage(
  records: MutationAuditRecord[],
  limit: number,
  cursor: string | null,
): { records: MutationAuditRecord[]; nextCursor: string | null; totalCount: number } {
  // Reverse-chronological: newest records first
  const sorted = [...records].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
  const totalCount = sorted.length;

  let startIdx = 0;
  if (cursor !== null) {
    const cursorTs = Buffer.from(cursor, 'base64url').toString('utf8');
    const cursorTime = new Date(cursorTs).getTime();
    // Find first record strictly older than the cursor timestamp
    startIdx = sorted.findIndex((r) => new Date(r.timestamp).getTime() < cursorTime);
    if (startIdx === -1) return { records: [], nextCursor: null, totalCount };
  }

  const page = sorted.slice(startIdx, startIdx + limit);
  const hasMore = startIdx + limit < sorted.length;
  const lastRecord = page.at(-1);
  const nextCursor = hasMore && lastRecord !== undefined
    ? Buffer.from(lastRecord.timestamp).toString('base64url')
    : null;

  return { records: page, nextCursor, totalCount };
}

// ── Sub-handlers (one per route to keep complexity per-function manageable) ──

function handleGetConfigSafe(_req: IncomingMessage, res: ServerResponse): void {
  try {
    // Raw file read detects missing/corrupt config — loadHydraConfig returns defaults on error
    const raw = fs.readFileSync(activeConfigPath(), 'utf8');
    JSON.parse(raw); // throws if corrupt
    const config = loadHydraConfig();
    sendJson(res, 200, { config: buildSafeView(config), revision: computeConfigRevision(config) });
  } catch {
    sendError(res, 503, 'daemon-unavailable');
  }
}

async function handlePostRoutingMode(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const parsed = routingModeMutationSchema.safeParse(body);
  if (!parsed.success) { sendError(res, 400, 'Invalid request body'); return; }

  const release = await configMutex.acquire();
  try {
    invalidateConfigCache();
    const config = loadHydraConfig();
    const currentRevision = computeConfigRevision(config);
    if (parsed.data.expectedRevision !== currentRevision) {
      sendJson(res, 409, { error: 'stale-revision' });
      return;
    }
    const beforeValue = config.routing.mode;
    const updated = saveHydraConfig({ ...config, routing: { ...config.routing, mode: parsed.data.mode } });
    try {
      appendAuditRecord(buildAuditRecord({
        eventType: 'config.routing.mode.changed', targetField: 'config.routing.mode',
        beforeValue, afterValue: parsed.data.mode, outcome: 'success', rejectionReason: null,
      }));
    } catch { /* R-2 */ }
    sendJson(res, 200, { snapshot: buildSafeView(updated), appliedRevision: computeConfigRevision(updated), timestamp: new Date().toISOString() });
  } finally { release(); }
}

async function handlePostModelActive(req: IncomingMessage, res: ServerResponse, agent: string): Promise<void> {
  const body = await readJsonBody(req);
  const parsed = modelTierMutationSchema.safeParse(body);
  if (!parsed.success) { sendError(res, 400, 'Invalid request body'); return; }

  const release = await configMutex.acquire();
  try {
    invalidateConfigCache();
    const config = loadHydraConfig();
    const modelsConfig = config.models as Record<string, Record<string, unknown>> | undefined;
    if (!modelsConfig || !Object.prototype.hasOwnProperty.call(modelsConfig, agent)) {
      sendError(res, 400, `Unknown or ineligible agent: ${agent}`); return;
    }
    if (parsed.data.expectedRevision !== computeConfigRevision(config)) {
      sendJson(res, 409, { error: 'stale-revision' }); return;
    }
    const beforeValue = modelsConfig[agent]['active'];
    const updatedModels = { ...modelsConfig, [agent]: { ...modelsConfig[agent], active: parsed.data.tier } };
    const updated = saveHydraConfig({ ...config, models: updatedModels });
    try {
      appendAuditRecord(buildAuditRecord({
        eventType: 'config.models.active.changed', targetField: `config.models.${agent}.active`,
        beforeValue, afterValue: parsed.data.tier, outcome: 'success', rejectionReason: null,
      }));
    } catch { /* R-2 */ }
    sendJson(res, 200, { snapshot: buildSafeView(updated), appliedRevision: computeConfigRevision(updated), timestamp: new Date().toISOString() });
  } finally { release(); }
}

type UsageBudgetShape = { dailyTokenBudget?: Record<string, number>; weeklyTokenBudget?: Record<string, number>; [key: string]: unknown };

function warnIfDailyExceedsWeekly(modelId: string, daily: number | undefined, weekly: number | undefined): void {
  if (daily !== undefined && weekly !== undefined && daily > weekly) {
    process.stderr.write(`${JSON.stringify({ level: 'warn', msg: 'budget dailyLimit exceeds weeklyLimit', modelId, dailyLimit: daily, weeklyLimit: weekly })}\n`);
  }
}

function applyBudgetLimits(usage: UsageBudgetShape, modelId: string, dailyLimit: number | null, weeklyLimit: number | null): UsageBudgetShape {
  const updated: UsageBudgetShape = { ...usage };
  if (dailyLimit !== null) updated.dailyTokenBudget = { ...(usage.dailyTokenBudget ?? {}), [modelId]: dailyLimit };
  if (weeklyLimit !== null) updated.weeklyTokenBudget = { ...(usage.weeklyTokenBudget ?? {}), [modelId]: weeklyLimit };
  return updated;
}

async function handlePostUsageBudget(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const parsed = budgetMutationSchema.safeParse(body);
  if (!parsed.success) { sendError(res, 400, 'Invalid request body'); return; }

  const release = await configMutex.acquire();
  try {
    invalidateConfigCache();
    const config = loadHydraConfig();
    const usage = config.usage as UsageBudgetShape;
    const { modelId, dailyLimit, weeklyLimit } = parsed.data;

    const hasDaily = Object.prototype.hasOwnProperty.call(usage.dailyTokenBudget ?? {}, modelId);
    const hasWeekly = Object.prototype.hasOwnProperty.call(usage.weeklyTokenBudget ?? {}, modelId);
    if (!hasDaily && !hasWeekly) { sendError(res, 400, `Unknown modelId: ${modelId}`); return; }

    if (parsed.data.expectedRevision !== computeConfigRevision(config)) {
      sendJson(res, 409, { error: 'stale-revision' }); return;
    }
    const beforeDaily = usage.dailyTokenBudget?.[modelId];
    const beforeWeekly = usage.weeklyTokenBudget?.[modelId];
    const updatedUsage = applyBudgetLimits(usage, modelId, dailyLimit, weeklyLimit);

    const effectiveDaily = dailyLimit ?? beforeDaily;
    const effectiveWeekly = weeklyLimit ?? beforeWeekly;
    warnIfDailyExceedsWeekly(modelId, effectiveDaily, effectiveWeekly);

    const updated = saveHydraConfig({ ...config, usage: updatedUsage });
    try {
      appendAuditRecord(buildAuditRecord({
        eventType: 'config.usage.budget.changed', targetField: `config.usage.budget.${modelId}`,
        beforeValue: { daily: beforeDaily, weekly: beforeWeekly },
        afterValue: { daily: effectiveDaily, weekly: effectiveWeekly },
        outcome: 'success', rejectionReason: null,
      }));
    } catch { /* R-2 */ }
    sendJson(res, 200, { snapshot: buildSafeView(updated), appliedRevision: computeConfigRevision(updated), timestamp: new Date().toISOString() });
  } finally { release(); }
}

async function handlePostWorkflowLaunch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const parsed = workflowLaunchSchema.safeParse(body);
  if (!parsed.success) { sendError(res, 400, 'Invalid request body'); return; }

  const { workflow, idempotencyKey, label } = parsed.data;
  const sixtySecondsAgo = new Date(Date.now() - 60_000).toISOString();
  const existing = workflowLaunches.find((e) => e.idempotencyKey === idempotencyKey && e.launchedAt >= sixtySecondsAgo);
  if (existing) {
    sendJson(res, 202, { taskId: existing.taskId, workflow: existing.workflow, launchedAt: existing.launchedAt, destructive: DESTRUCTIVE_WORKFLOWS.has(existing.workflow), label: label ?? null });
    return;
  }

  const release = await configMutex.acquire();
  try {
    invalidateConfigCache();
    const config = loadHydraConfig();
    const conflict = workflowLaunches.find((e) => e.workflow === workflow && (e.status === 'running' || e.status === 'pending'));
    if (conflict) { sendJson(res, 409, { error: 'workflow-conflict', taskId: conflict.taskId }); return; }
    if (parsed.data.expectedRevision !== computeConfigRevision(config)) { sendJson(res, 409, { error: 'stale-revision' }); return; }

    const taskId = crypto.randomUUID();
    const launchedAt = new Date().toISOString();
    workflowLaunches.push({ taskId, workflow, idempotencyKey, launchedAt, status: 'pending' });
    try {
      appendAuditRecord(buildAuditRecord({ eventType: 'workflow.launched', targetField: `workflow.${workflow}`, beforeValue: null, afterValue: taskId, outcome: 'success', rejectionReason: null }));
    } catch { /* R-2 */ }
    sendJson(res, 202, { taskId, workflow, launchedAt, destructive: DESTRUCTIVE_WORKFLOWS.has(workflow), label: label ?? null });
  } finally { release(); }
}

function handleGetAudit(res: ServerResponse, url: URL): void {
  const limitParam = url.searchParams.get('limit');
  const cursor = url.searchParams.get('cursor');
  const parsed = limitParam === null || Number.isNaN(Number(limitParam)) ? 20 : Math.max(1, Number(limitParam));
  const limit = Math.min(parsed, 100);
  const { records, nextCursor, totalCount } = getAuditPage(auditRecords, limit, cursor);
  sendJson(res, 200, { records, nextCursor, totalCount });
}

// ── Route dispatcher ──────────────────────────────────────────────────────────

export async function handleMutationRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const { pathname } = url;

  if (method === 'GET' && pathname === '/config/safe') { handleGetConfigSafe(req, res); return true; }
  if (method === 'POST' && pathname === '/config/routing/mode') { await handlePostRoutingMode(req, res); return true; }
  if (method === 'POST' && pathname === '/config/usage/budget') { await handlePostUsageBudget(req, res); return true; }
  if (method === 'POST' && pathname === '/workflows/launch') { await handlePostWorkflowLaunch(req, res); return true; }
  if (method === 'GET' && pathname === '/audit') { handleGetAudit(res, url); return true; }

  const modelActiveMatch = /^\/config\/models\/([^/]+)\/active$/.exec(pathname);
  if (method === 'POST' && modelActiveMatch !== null) {
    await handlePostModelActive(req, res, modelActiveMatch[1]);
    return true;
  }

  return false;
}

// ── Test helpers (erased in production — export only consumed by test files) ──

/** Clear the in-memory audit store. Test use only. */
export function _clearAuditStoreForTest(): void {
  auditRecords.length = 0;
}

/** Inject records into the in-memory audit store. Test use only. */
export function _injectAuditRecordsForTest(records: MutationAuditRecord[]): void {
  auditRecords.push(...records);
}

/** Clear the in-memory workflow launch store. Test use only. */
export function _clearWorkflowLaunchesForTest(): void {
  workflowLaunches.length = 0;
}

/** Inject a workflow launch entry (e.g. to simulate a running workflow). Test use only. */
export function _injectWorkflowLaunchForTest(entry: WorkflowEntry): void {
  workflowLaunches.push(entry);
}
