/**
 * Origin guard — validates Origin header on mutating routes and WS upgrade. (FR-021)
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createError } from '../shared/errors.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createOriginGuard(allowedOrigin: string) {
  return function originGuard(req: IncomingMessage, res: ServerResponse, next: () => void): void {
    const method = req.method?.toUpperCase() ?? 'GET';
    const isUpgrade = req.headers.upgrade?.toLowerCase() === 'websocket';

    // Only check mutating methods and WebSocket upgrades
    if (!isUpgrade && SAFE_METHODS.has(method)) {
      next();
      return;
    }

    const origin = req.headers.origin;
    if (origin == null || origin !== allowedOrigin) {
      const err = createError('ORIGIN_REJECTED');
      res.writeHead(err.statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: err.code, message: err.message }));
      return;
    }

    next();
  };
}
