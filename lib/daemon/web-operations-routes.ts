/**
 * Operations read routes — REST endpoints for operations panel snapshot queries.
 *
 * These handlers project daemon state through web-operations-projection and
 * return browser-safe DTOs conforming to the operations read contracts.
 */

import type { ReadRouteCtx } from '../types.ts';
import {
  projectQueueSnapshot,
  projectCheckpoints,
  projectWorkItemDetail,
  type QueueSnapshotOptions,
} from './web-operations-projection.ts';
import type { WorkItemStatus } from '@hydra/web-contracts';

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

function handleSnapshot(ctx: ReadRouteCtx): boolean {
  const { res, sendJson, sendError, readState, requestUrl } = ctx;

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

  const snapshot = projectQueueSnapshot(state, options);

  sendJson(res, 200, snapshot);
  return true;
}

function handleWorkItemDetail(ctx: ReadRouteCtx, workItemId: string): boolean {
  const { res, sendJson, sendError, readState } = ctx;
  const state = readState();
  const detail = projectWorkItemDetail(state, workItemId);

  if (detail == null) {
    sendError(res, 404, `Work item not found: ${workItemId}`);
    return true;
  }

  sendJson(res, 200, detail);
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
  }

  return false;
}
