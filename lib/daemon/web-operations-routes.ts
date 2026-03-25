/**
 * Operations read routes — REST endpoints for operations panel snapshot queries.
 *
 * These handlers project daemon state through web-operations-projection and
 * return browser-safe DTOs conforming to the operations read contracts.
 */

import type { ReadRouteCtx } from '../types.ts';
import { projectQueueSnapshot, type QueueSnapshotOptions } from './web-operations-projection.ts';
import type { WorkItemStatus } from '@hydra/web-contracts';

const VALID_STATUSES: ReadonlySet<string> = new Set([
  'waiting',
  'active',
  'paused',
  'blocked',
  'completed',
  'failed',
  'cancelled',
]);

function parseStatusFilter(raw: string | null): readonly WorkItemStatus[] | undefined {
  if (raw == null || raw === '') return undefined;
  const statuses = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => VALID_STATUSES.has(s)) as WorkItemStatus[];
  return statuses.length > 0 ? statuses : undefined;
}

function parseStatusFilters(searchParams: URLSearchParams): readonly WorkItemStatus[] | undefined {
  const rawValues = searchParams.getAll('statusFilter');
  if (rawValues.length === 0) {
    return undefined;
  }

  const parsed = rawValues.flatMap((raw) => parseStatusFilter(raw) ?? []);
  return parsed.length > 0 ? parsed : undefined;
}

function parseLimit(raw: string | null): number | undefined {
  if (raw == null || raw === '') return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function handleSnapshot(ctx: ReadRouteCtx): boolean {
  const { res, sendJson, readState, requestUrl } = ctx;
  const state = readState();

  const options: QueueSnapshotOptions = {
    statusFilter: parseStatusFilters(requestUrl.searchParams),
    limit: parseLimit(requestUrl.searchParams.get('limit')),
    cursor: requestUrl.searchParams.get('cursor') ?? undefined,
  };

  const snapshot = projectQueueSnapshot(state, options);

  sendJson(res, 200, {
    ok: true,
    queue: snapshot.queue,
    health: snapshot.health,
    budget: snapshot.budget,
    availability: snapshot.availability,
    lastSynchronizedAt: snapshot.lastSynchronizedAt,
    nextCursor: snapshot.nextCursor,
  });
  return true;
}

const OPERATIONS_ROUTES: ReadonlyMap<string, (ctx: ReadRouteCtx) => boolean> = new Map([
  ['/operations/snapshot', handleSnapshot],
]);

export function handleOperationsReadRoute(ctx: ReadRouteCtx): boolean {
  if (ctx.method !== 'GET') return false;

  const handler = OPERATIONS_ROUTES.get(ctx.route);
  if (handler != null) return handler(ctx);

  return false;
}
