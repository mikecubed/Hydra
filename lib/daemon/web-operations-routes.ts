/**
 * Operations read routes — REST endpoints for operations panel snapshot queries.
 *
 * These handlers project daemon state through web-operations-projection and
 * return browser-safe DTOs conforming to the operations read contracts.
 */

import type { ReadRouteCtx } from '../types.ts';
import { projectQueueSnapshot, type QueueSnapshotOptions } from './web-operations-projection.ts';
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

  const tokens: string[] = [];
  for (const raw of rawValues) {
    for (const token of raw.split(',')) {
      const trimmed = token.trim();
      if (trimmed === '') {
        return { invalid: raw };
      }
      tokens.push(trimmed);
    }
  }

  for (const token of tokens) {
    if (!isValidStatus(token)) {
      return { invalid: token };
    }
  }

  return { statuses: tokens as unknown as readonly WorkItemStatus[] };
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

const OPERATIONS_ROUTES: ReadonlyMap<string, (ctx: ReadRouteCtx) => boolean> = new Map([
  ['/operations/snapshot', handleSnapshot],
]);

export function handleOperationsReadRoute(ctx: ReadRouteCtx): boolean {
  if (ctx.method !== 'GET') return false;

  const handler = OPERATIONS_ROUTES.get(ctx.route);
  if (handler != null) return handler(ctx);

  return false;
}
