/**
 * Operations read routes — REST endpoints for operations panel snapshot queries
 * and daemon-authoritative control discovery.
 *
 * These handlers project daemon state through web-operations-projection and
 * web-operations-controls, returning browser-safe DTOs conforming to the
 * operations read and control contracts.
 */

import type { ReadRouteCtx } from '../types.ts';
import {
  projectQueueSnapshot,
  projectCheckpoints,
  projectWorkItemDetail,
  type QueueSnapshotOptions,
  type HealthBudgetContext,
} from './web-operations-projection.ts';
import { discoverControls, type ControlContext } from './web-operations-controls.ts';
import type { WorkItemStatus, ControlKind } from '@hydra/web-contracts';
import { loadHydraConfig } from '../hydra-config.ts';

const VALID_STATUSES = [
  'waiting',
  'active',
  'paused',
  'blocked',
  'completed',
  'failed',
  'cancelled',
] as const satisfies readonly WorkItemStatus[];

function isValidStatus(value: string): value is WorkItemStatus {
  for (const status of VALID_STATUSES) {
    if (status === value) {
      return true;
    }
  }

  return false;
}

function parseStatusFilters(
  searchParams: URLSearchParams,
): { statuses: readonly WorkItemStatus[] | undefined } | { invalid: string } {
  const rawValues = searchParams.getAll('statusFilter');
  if (rawValues.length === 0) {
    return { statuses: undefined };
  }

  const tokens: WorkItemStatus[] = [];
  for (const raw of rawValues) {
    for (const token of raw.split(',')) {
      const trimmed = token.trim();
      if (trimmed === '') {
        return { invalid: raw };
      }
      if (!isValidStatus(trimmed)) {
        return { invalid: trimmed };
      }
      tokens.push(trimmed);
    }
  }

  return { statuses: tokens };
}

function parseLimit(raw: string | null): number | undefined {
  if (raw == null || raw === '') return undefined;
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function warnProbeFailure(
  probeName: 'readStatus' | 'checkUsage' | 'writeStatus',
  error: unknown,
): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.warn(`[operations] ${probeName} probe failed: ${detail}`);
}

function tryReadStatus(readStatus: ReadRouteCtx['readStatus']): Record<string, unknown> | null {
  try {
    return readStatus();
  } catch (err) {
    warnProbeFailure('readStatus', err);
    return null;
  }
}

function tryCheckUsage(
  checkUsage: ReadRouteCtx['checkUsage'],
): ReturnType<ReadRouteCtx['checkUsage']> | null {
  try {
    return checkUsage();
  } catch (err) {
    warnProbeFailure('checkUsage', err);
    return null;
  }
}

function tryWriteStatus(writeStatus: ReadRouteCtx['writeStatus']): void {
  try {
    writeStatus();
  } catch (err) {
    warnProbeFailure('writeStatus', err);
  }
}

function handleSnapshot(ctx: ReadRouteCtx): boolean {
  const { res, sendJson, sendError, readState, requestUrl, readStatus, checkUsage, writeStatus } =
    ctx;

  const statusResult = parseStatusFilters(requestUrl.searchParams);
  if ('invalid' in statusResult) {
    sendError(res, 400, `Invalid statusFilter value: ${statusResult.invalid}`);
    return true;
  }

  const state = readState();

  const options: QueueSnapshotOptions = {
    statusFilter: statusResult.statuses,
    limit: parseLimit(requestUrl.searchParams.get('limit')),
    cursor: requestUrl.searchParams.get('cursor') ?? undefined,
  };

  // Best-effort refresh before reading — soft-fail preserves existing behavior
  tryWriteStatus(writeStatus);
  const statusData = tryReadStatus(readStatus);
  const usage = tryCheckUsage(checkUsage);
  const healthBudgetCtx: HealthBudgetContext | null = { statusData, usage };

  const snapshot = projectQueueSnapshot(state, options, healthBudgetCtx);

  sendJson(res, 200, snapshot);
  return true;
}

// ── Control Context ───────────────────────────────────────────────────────────

const VALID_CONTROL_KINDS = new Set(['routing', 'mode', 'agent', 'council']);

function isValidControlKind(value: string): value is ControlKind {
  return VALID_CONTROL_KINDS.has(value);
}

function buildControlContext(ctx: ReadRouteCtx): ControlContext {
  return {
    loadConfig: () => {
      try {
        const config = loadHydraConfig();
        const raw = config as Record<string, unknown>;
        const mode = typeof raw['mode'] === 'string' ? raw['mode'] : 'auto';
        const routing = raw['routing'] as Record<string, unknown> | undefined;
        const routingMode = typeof routing?.['mode'] === 'string' ? routing['mode'] : 'balanced';
        return { mode, routing: { mode: routingMode } };
      } catch {
        return { mode: 'auto', routing: { mode: 'balanced' } };
      }
    },
    agentNames: Object.keys(ctx.getModelSummary()).filter(
      (agentName) => agentName !== '' && !agentName.startsWith('_'),
    ),
    nowIso: () => new Date().toISOString(),
  };
}

function handleWorkItemDetail(ctx: ReadRouteCtx, workItemId: string): boolean {
  const { res, sendJson, sendError, readState } = ctx;
  const state = readState();
  const controlConfig = buildControlContext(ctx);
  const detail = projectWorkItemDetail(state, workItemId, controlConfig);

  if (detail == null) {
    sendError(res, 404, `Work item not found: ${workItemId}`);
    return true;
  }

  sendJson(res, 200, detail);
  return true;
}

// ── Control Discovery Routes ──────────────────────────────────────────────────

function handleWorkItemControls(ctx: ReadRouteCtx, workItemId: string): boolean {
  const { res, sendJson, sendError, readState, requestUrl } = ctx;
  const state = readState();
  const task = state.tasks.find((t) => t.id === workItemId);

  if (task == null) {
    sendError(res, 404, `Work item not found: ${workItemId}`);
    return true;
  }

  const controlConfig = buildControlContext(ctx);
  let controls = discoverControls(task, controlConfig);

  const kindParam = requestUrl.searchParams.get('kind');
  if (kindParam != null && kindParam !== '') {
    if (!isValidControlKind(kindParam)) {
      sendError(res, 400, `Invalid control kind: ${kindParam}`);
      return true;
    }
    controls = controls.filter((c) => c.kind === kindParam);
  }

  sendJson(res, 200, {
    workItemId,
    controls,
    availability: 'ready',
  });
  return true;
}

function handleWorkItemCheckpoints(ctx: ReadRouteCtx, workItemId: string): boolean {
  const { res, sendJson, sendError, readState } = ctx;
  const state = readState();
  const task = state.tasks.find((t) => t.id === workItemId);

  if (task == null) {
    sendError(res, 404, `Work item not found: ${workItemId}`);
    return true;
  }

  const checkpoints = projectCheckpoints(task);
  const availability = checkpoints.length > 0 ? 'ready' : 'partial';

  sendJson(res, 200, {
    workItemId,
    checkpoints,
    availability,
  });
  return true;
}

const OPERATIONS_ROUTES: ReadonlyMap<string, (ctx: ReadRouteCtx) => boolean> = new Map([
  ['/operations/snapshot', handleSnapshot],
]);

const WORK_ITEMS_PREFIX = '/operations/work-items/';
const WORK_ITEM_PREFIX_COMPAT = '/operations/work-item/';

function matchWorkItemRoute(route: string): { workItemId: string; sub: string } | null {
  let rest: string;
  if (route.startsWith(WORK_ITEMS_PREFIX)) {
    rest = route.slice(WORK_ITEMS_PREFIX.length);
  } else if (route.startsWith(WORK_ITEM_PREFIX_COMPAT)) {
    rest = route.slice(WORK_ITEM_PREFIX_COMPAT.length);
  } else {
    return null;
  }
  if (rest === '') return null;
  const slashIndex = rest.indexOf('/');
  const raw = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
  const sub = slashIndex === -1 ? '' : rest.slice(slashIndex);
  try {
    return { workItemId: decodeURIComponent(raw), sub };
  } catch {
    // Malformed percent-encoding — treat as literal
    return { workItemId: raw, sub };
  }
}

export function handleOperationsReadRoute(ctx: ReadRouteCtx): boolean {
  if (ctx.method !== 'GET') return false;

  const handler = OPERATIONS_ROUTES.get(ctx.route);
  if (handler != null) return handler(ctx);

  const match = matchWorkItemRoute(ctx.route);
  if (match != null) {
    if (match.sub === '') return handleWorkItemDetail(ctx, match.workItemId);
    if (match.sub === '/checkpoints') return handleWorkItemCheckpoints(ctx, match.workItemId);
    if (match.sub === '/controls') return handleWorkItemControls(ctx, match.workItemId);
  }

  return false;
}
