/**
 * Turn Submission contracts — submit instruction, subscribe to stream, load history.
 */
import { z } from 'zod';
import { Turn } from '../turn.ts';
import { StreamEvent } from '../stream.ts';

// ── SubmitInstruction ────────────────────────────────────────────────────────

export const SubmitInstructionRequest = z.object({
  conversationId: z.string().min(1),
  instruction: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type SubmitInstructionRequest = z.infer<typeof SubmitInstructionRequest>;

export const SubmitInstructionResponse = z.object({
  turn: Turn,
  streamId: z.string().min(1),
});
export type SubmitInstructionResponse = z.infer<typeof SubmitInstructionResponse>;

// ── SubmitInstructionBody (browser-facing: path-owned conversationId) ─────────

/** Browser-facing body for POST /conversations/:convId/turns — conversationId comes from the URL. */
export const SubmitInstructionBody = SubmitInstructionRequest.omit({ conversationId: true });
export type SubmitInstructionBody = z.infer<typeof SubmitInstructionBody>;

// ── SubscribeToStream ────────────────────────────────────────────────────────

export const SubscribeToStreamRequest = z.object({
  conversationId: z.string().min(1),
  turnId: z.string().min(1),
  lastAcknowledgedSeq: z.number().int().nonnegative().default(0),
});
export type SubscribeToStreamRequest = z.infer<typeof SubscribeToStreamRequest>;

// Response is an ordered sequence of StreamEvents (async iterable or SSE).
// The schema validates individual events; the stream itself is transport-level.
export const SubscribeToStreamResponse = z.object({
  events: z.array(StreamEvent),
});
export type SubscribeToStreamResponse = z.infer<typeof SubscribeToStreamResponse>;

// ── LoadTurnHistory ──────────────────────────────────────────────────────────

export const LoadTurnHistoryRequest = z.object({
  conversationId: z.string().min(1),
  fromPosition: z.number().int().positive().optional(),
  toPosition: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(100).default(50),
});
export type LoadTurnHistoryRequest = z.infer<typeof LoadTurnHistoryRequest>;

export const LoadTurnHistoryResponse = z.object({
  turns: z.array(Turn),
  totalCount: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
export type LoadTurnHistoryResponse = z.infer<typeof LoadTurnHistoryResponse>;
