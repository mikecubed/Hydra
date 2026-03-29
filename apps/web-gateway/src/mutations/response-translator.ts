/**
 * Mutations response translator — maps ErrorCategory to HTTP status + message.
 *
 * Pure function, no side-effects.
 */
import type { ErrorCategory } from '../shared/gateway-error-response.ts';

export function translateMutationError(category: ErrorCategory): {
  status: number;
  message: string;
  code: string;
} {
  switch (category) {
    case 'stale-revision':
      return {
        status: 409,
        message: 'Config has changed — reload and retry',
        code: 'STALE_REVISION',
      };
    case 'daemon-unavailable':
      return { status: 503, message: 'Daemon unreachable', code: 'DAEMON_UNAVAILABLE' };
    case 'validation':
      return { status: 400, message: 'Validation error', code: 'VALIDATION_FAILED' };
    case 'workflow-conflict':
      return { status: 409, message: 'Workflow already running', code: 'WORKFLOW_CONFLICT' };
    case 'auth':
      return { status: 401, message: 'Unauthorized', code: 'UNAUTHORIZED' };
    case 'session':
      return { status: 409, message: 'Session conflict', code: 'SESSION_CONFLICT' };
    case 'daemon':
      return { status: 503, message: 'Daemon error', code: 'DAEMON_ERROR' };
    case 'rate-limit':
      return { status: 429, message: 'Too many requests', code: 'RATE_LIMITED' };
  }
}
