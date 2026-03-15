/**
 * Session schemas — shared session state, info, event types.
 *
 * The session ID is never exposed to browser JS (FR-020). These schemas
 * describe the public shapes the gateway exposes over HTTP / WebSocket.
 */
import { z } from 'zod';

// ─── SessionState enum ──────────────────────────────────────────────────────

export const SessionState = z.enum([
  'active',
  'expiring-soon',
  'expired',
  'invalidated',
  'logged-out',
  'daemon-unreachable',
]);
export type SessionState = z.infer<typeof SessionState>;

/** Terminal states that cannot transition to any other state. */
export const TERMINAL_STATES: readonly SessionState[] = ['expired', 'invalidated', 'logged-out'];

// ─── SessionInfo (public — no id) ───────────────────────────────────────────

export const SessionInfo = z.object({
  operatorId: z.string().min(1),
  state: SessionState,
  expiresAt: z.iso.datetime(),
  lastActivityAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

// ─── SessionEvent (broadcast payload — no session id) ───────────────────────

export const SessionEvent = z.object({
  type: z.enum(['state-change', 'expiry-warning', 'forced-logout']),
  newState: SessionState,
  reason: z.string().optional(),
});
export type SessionEvent = z.infer<typeof SessionEvent>;

// ─── ExtendResponse ─────────────────────────────────────────────────────────

export const ExtendResponse = z.object({
  newExpiresAt: z.iso.datetime(),
});
export type ExtendResponse = z.infer<typeof ExtendResponse>;
