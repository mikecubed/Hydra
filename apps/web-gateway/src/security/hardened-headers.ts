/**
 * Hardened response headers — CSP, X-Content-Type-Options, X-Frame-Options,
 * Referrer-Policy, HSTS (conditional on TLS). (FR-023)
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface HardenedHeadersConfig {
  tlsActive: boolean;
}

export function createHardenedHeaders(config: HardenedHeadersConfig = { tlsActive: false }) {
  return function hardenedHeaders(
    _req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): void {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss:; frame-ancestors 'none'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    if (config.tlsActive) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    next();
  };
}
