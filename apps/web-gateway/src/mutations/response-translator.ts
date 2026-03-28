/**
 * Mutations response translator — maps ErrorCategory to HTTP status + message.
 *
 * Pure function, no side-effects.
 */
import type { ErrorCategory } from '../shared/gateway-error-response.ts';

export function translateMutationError(category: ErrorCategory): {
  status: number;
  message: string;
} {
  switch (category) {
    case 'stale-revision':
      return { status: 409, message: 'Config has changed — reload and retry' };
    case 'daemon-unavailable':
      return { status: 503, message: 'Daemon unreachable' };
    case 'validation':
      return { status: 400, message: 'Validation error' };
    case 'workflow-conflict':
      return { status: 409, message: 'Workflow already running' };
    case 'auth':
      return { status: 401, message: 'Unauthorized' };
    case 'session':
      return { status: 409, message: 'Session conflict' };
    case 'daemon':
      return { status: 503, message: 'Daemon error' };
    case 'rate-limit':
      return { status: 429, message: 'Too many requests' };
  }
}
