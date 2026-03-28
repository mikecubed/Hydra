/**
 * Thin wrapper around crypto.randomUUID() so workflow launch panel
 * can be tested without a real browser crypto global.
 */
export function randomUUID(): string {
  return crypto.randomUUID();
}
