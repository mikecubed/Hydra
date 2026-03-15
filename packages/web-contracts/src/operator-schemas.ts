/**
 * Operator schemas — public operator identity contracts.
 *
 * hashedSecret is server-only and NOT part of the shared contract.
 */
import { z } from 'zod';

export const Operator = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  createdAt: z.iso.datetime(),
  isActive: z.boolean().default(true),
});
export type Operator = z.infer<typeof Operator>;

/** Credential type (public enum — secret material never leaves server). */
export const CredentialType = z.enum(['password']);
export type CredentialType = z.infer<typeof CredentialType>;
