/**
 * WebSocket protocol message schemas for gateway ↔ browser transport.
 *
 * Client→Server: subscribe, unsubscribe, ack
 * Server→Client: stream-event, subscribed, unsubscribed, session-terminated,
 *                session-expiring-soon, daemon-unavailable, daemon-restored, error
 */
import { StreamEvent } from '@hydra/web-contracts';
import { z } from 'zod';
import { ERROR_CATEGORIES } from '../shared/gateway-error-response.ts';

// ─── Client → Server messages ────────────────────────────────────────────────

const SubscribeMessage = z
  .object({
    type: z.literal('subscribe'),
    conversationId: z.string().min(1),
    lastAcknowledgedSeq: z.number().int().nonnegative().optional(),
  })
  .strict();

const UnsubscribeMessage = z
  .object({
    type: z.literal('unsubscribe'),
    conversationId: z.string().min(1),
  })
  .strict();

const AckMessage = z
  .object({
    type: z.literal('ack'),
    conversationId: z.string().min(1),
    seq: z.number().int().nonnegative(),
  })
  .strict();

export const ClientMessageSchema = z.discriminatedUnion('type', [
  SubscribeMessage,
  UnsubscribeMessage,
  AckMessage,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ─── Server → Client messages ────────────────────────────────────────────────

const StreamEventMessage = z
  .object({
    type: z.literal('stream-event'),
    conversationId: z.string().min(1),
    event: StreamEvent,
  })
  .strict();

const SubscribedMessage = z
  .object({
    type: z.literal('subscribed'),
    conversationId: z.string().min(1),
    currentSeq: z.number().int().nonnegative(),
  })
  .strict();

const UnsubscribedMessage = z
  .object({
    type: z.literal('unsubscribed'),
    conversationId: z.string().min(1),
  })
  .strict();

const SessionTerminatedMessage = z
  .object({
    type: z.literal('session-terminated'),
    state: z.enum(['expired', 'invalidated', 'logged-out']),
    reason: z.string().min(1).optional(),
  })
  .strict();

const SessionExpiringSoonMessage = z
  .object({
    type: z.literal('session-expiring-soon'),
    expiresAt: z.iso.datetime(),
  })
  .strict();

const DaemonUnavailableMessage = z
  .object({
    type: z.literal('daemon-unavailable'),
  })
  .strict();

const DaemonRestoredMessage = z
  .object({
    type: z.literal('daemon-restored'),
  })
  .strict();

const ErrorMessage = z
  .object({
    type: z.literal('error'),
    ok: z.literal(false),
    code: z.string().min(1),
    category: z.enum(ERROR_CATEGORIES),
    message: z.string().min(1),
    conversationId: z.string().min(1).optional(),
    turnId: z.string().min(1).optional(),
    retryAfterMs: z.number().int().nonnegative().optional(),
  })
  .strict();

export const ServerMessageSchema = z.discriminatedUnion('type', [
  StreamEventMessage,
  SubscribedMessage,
  UnsubscribedMessage,
  SessionTerminatedMessage,
  SessionExpiringSoonMessage,
  DaemonUnavailableMessage,
  DaemonRestoredMessage,
  ErrorMessage,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

// ─── Parse / serialize helpers ───────────────────────────────────────────────

export type ParseResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; code: 'PARSE_ERROR' | 'VALIDATION_ERROR'; detail: string };

export function parseClientMessage(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'PARSE_ERROR', detail: 'Invalid JSON' };
  }

  const result = ClientMessageSchema.safeParse(parsed);
  if (result.success) {
    return { ok: true, message: result.data };
  }
  return {
    ok: false,
    code: 'VALIDATION_ERROR',
    detail: result.error.issues.map((i) => i.message).join('; '),
  };
}

export function serializeServerMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}
