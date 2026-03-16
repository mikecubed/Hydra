/**
 * Authentication schemas — login, logout, auth error contracts.
 *
 * LoginResponse deliberately omits sessionId (FR-020 — cookie-only).
 */
import { z } from 'zod';
import { SessionState } from './session-schemas.ts';

// ─── LoginRequest ───────────────────────────────────────────────────────────

export const LoginRequest = z.object({
  identity: z.string().min(1),
  secret: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

// ─── LoginResponse (no sessionId — FR-020) ──────────────────────────────────

export const LoginResponse = z
  .object({
    operatorId: z.string().min(1),
    expiresAt: z.iso.datetime(),
    state: SessionState,
  })
  .strict();
export type LoginResponse = z.infer<typeof LoginResponse>;

// ─── LogoutResponse ─────────────────────────────────────────────────────────

export const LogoutResponse = z
  .object({
    success: z.boolean(),
  })
  .strict();
export type LogoutResponse = z.infer<typeof LogoutResponse>;

// ─── AuthError ──────────────────────────────────────────────────────────────

export const AuthError = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();
export type AuthError = z.infer<typeof AuthError>;
