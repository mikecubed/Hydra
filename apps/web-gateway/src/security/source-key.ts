/**
 * Source-key derivation — determines the client identity for rate-limiting.
 *
 * When `trustedProxies` is configured, the last untrusted IP in the
 * X-Forwarded-For chain is used.  Without trusted-proxy configuration the
 * header is ignored entirely and the key falls back to the transport-level
 * remote address (or `'unknown'` in environments where no socket exists).
 */
import { createMiddleware } from 'hono/factory';
import type { MiddlewareHandler, Context } from 'hono';
import type { GatewayEnv } from '../shared/types.ts';

export interface SourceKeyConfig {
  /** CIDR-less IP allow-list of proxies whose forwarded headers we trust. */
  trustedProxies?: string[];
}

export function resolveSourceKeyFromParts(
  remoteAddress?: string,
  forwardedFor?: string,
  trustedProxies?: ReadonlySet<string>,
): string {
  if (
    trustedProxies != null &&
    trustedProxies.size > 0 &&
    remoteAddress != null &&
    remoteAddress !== '' &&
    trustedProxies.has(remoteAddress)
  ) {
    if (forwardedFor != null && forwardedFor !== '') {
      const ips = forwardedFor.split(',').map((ip) => ip.trim());
      for (let i = ips.length - 1; i >= 0; i--) {
        if (!trustedProxies.has(ips[i])) {
          return ips[i];
        }
      }
    }
  }

  return remoteAddress ?? 'unknown';
}

/**
 * Derive the rate-limit source key from the request.
 *
 * Priority:
 *  1. If trustedProxies is configured AND the direct connection IP is in that
 *     set, walk X-Forwarded-For right-to-left and return the first IP that is
 *     NOT in the trusted set.
 *  2. Otherwise return the transport-level remote address.
 *  3. Fall back to `'unknown'` if nothing is available.
 */
export function resolveSourceKey(c: Context, trustedProxies?: ReadonlySet<string>): string {
  // Transport-level remote address (Node raw socket).
  // Hono's Node adapter populates env.incoming with the IncomingMessage.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
  const remoteAddress: string | undefined = c.env?.incoming?.socket?.remoteAddress;

  return resolveSourceKeyFromParts(remoteAddress, c.req.header('x-forwarded-for'), trustedProxies);
}

/**
 * Middleware that resolves the source key once per request and stores it
 * in the Hono context for downstream rate limiters and auth routes.
 */
export function createSourceKeyMiddleware(
  config: SourceKeyConfig = {},
): MiddlewareHandler<GatewayEnv> {
  const trustedSet = config.trustedProxies ? new Set(config.trustedProxies) : undefined;

  return createMiddleware<GatewayEnv>(async (c, next) => {
    const key = resolveSourceKey(c, trustedSet);
    c.set('sourceKey', key);
    await next();
  });
}

/** Read the pre-resolved source key from context (set by middleware). */
export function getSourceKey(c: Context<GatewayEnv>): string {
  return c.get('sourceKey');
}
