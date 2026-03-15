/**
 * Hardened response headers — CSP, X-Content-Type-Options, X-Frame-Options,
 * Referrer-Policy, HSTS (conditional on TLS). (FR-023)
 */
import { createMiddleware } from 'hono/factory';
import type { MiddlewareHandler } from 'hono';

export interface HardenedHeadersConfig {
  tlsActive: boolean;
}

export function createHardenedHeaders(
  config: HardenedHeadersConfig = { tlsActive: false },
): MiddlewareHandler {
  return createMiddleware(async (c, next) => {
    await next();
    const connectSrc = config.tlsActive ? "'self' wss:" : "'self' ws: wss:";
    c.header(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src ${connectSrc}; frame-ancestors 'none'`,
    );
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');

    if (config.tlsActive) {
      c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
  });
}
