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
    if (nested) return nested;
  }
  return null;
}

const safeConfigViewSchema = z
  .unknown()
  .superRefine((val, ctx) => {
    const found = hasForbiddenKey(val);
    if (found) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `forbidden key: ${found}` });
  })
  .pipe(z.object({ routing: z.unknown(), models: z.unknown(), usage: z.unknown() }).strip());

const routingModeMutationSchema = z.object({
  mode: z.enum(['economy', 'balanced', 'performance']),
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

// ── Audit ────────────────────────────────────────────────────────────────────

const AUDIT_FILE = path.join(HYDRA_RUNTIME_ROOT, 'mutation-audit.jsonl');

function appendAuditRecord(record: MutationAuditRecord): void {
  fs.appendFileSync(AUDIT_FILE, JSON.stringify(record) + '\n', 'utf8');
}

// ── Route handler ────────────────────────────────────────────────────────────

export async function handleMutationRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const pathname = url.pathname;

  // GET /config/safe
  if (method === 'GET' && pathname === '/config/safe') {
    try {
      // Read raw file to detect missing/corrupt config (loadHydraConfig returns defaults on error)
      const raw = fs.readFileSync(activeConfigPath(), 'utf8');
      JSON.parse(raw); // throws if corrupt
      const config = loadHydraConfig();
      const safeInput = { routing: config.routing, models: config.models, usage: config.usage };
      const safeView = safeConfigViewSchema.parse(safeInput) as SafeConfigViewType;
      const revision = computeConfigRevision(config);
      // Return { config: SafeConfigView, revision } matching GetSafeConfigResponse contract
      sendJson(res, 200, { config: safeView, revision });
    } catch {
      sendError(res, 503, 'daemon-unavailable');
    }
    return true;
  }

  // POST /config/routing/mode
  if (method === 'POST' && pathname === '/config/routing/mode') {
    const body = await readJsonBody(req);
    const parsed = routingModeMutationSchema.safeParse(body);
    if (!parsed.success) {
      sendError(res, 400, 'Invalid request body');
      return true;
    }

    const release = await configMutex.acquire();
    try {
      // Invalidate cache so we always read fresh on-disk state inside the lock
      invalidateConfigCache();
      const config = loadHydraConfig();
      const currentRevision = computeConfigRevision(config);
      if (parsed.data.expectedRevision !== currentRevision) {
        sendJson(res, 409, { error: 'stale-revision' });
        return true;
      }

      const beforeValue = config.routing?.mode;
      const updated = saveHydraConfig({
        ...config,
        routing: { ...config.routing, mode: parsed.data.mode },
      });
      const appliedRevision = computeConfigRevision(updated);

      const auditRecord: MutationAuditRecord = {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        eventType: 'config.routing.mode.changed',
        operatorId: null,
        sessionId: null,
        targetField: 'config.routing.mode',
        beforeValue,
        afterValue: parsed.data.mode,
        outcome: 'success',
        rejectionReason: null,
        sourceIp: '',
      };
      try {
        appendAuditRecord(auditRecord);
      } catch {
        /* audit failure must not suppress 200 — R-2 */
      }

      const safeInput = { routing: updated.routing, models: updated.models, usage: updated.usage };
      const safeView = safeConfigViewSchema.parse(safeInput) as SafeConfigViewType;
      sendJson(res, 200, {
        snapshot: safeView,
        appliedRevision,
        timestamp: new Date().toISOString(),
      });
    } finally {
      release();
    }
    return true;
  }

  return false;
}
