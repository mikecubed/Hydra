/**
 * Session state machine — pure function: (current + trigger) → new state | error.
 *
 * 15 defined transitions. Terminal states reject all transitions.
 */
import type { SessionState } from '@hydra/web-contracts';
import { TERMINAL_STATES } from '@hydra/web-contracts';

export type SessionTrigger =
  | 'warn-expiry'
  | 'expire'
  | 'invalidate'
  | 'logout'
  | 'daemon-down'
  | 'daemon-up'
  | 'extend';

interface Transition {
  from: SessionState;
  trigger: SessionTrigger;
  to: SessionState;
}

const TRANSITIONS: readonly Transition[] = [
  { from: 'active', trigger: 'warn-expiry', to: 'expiring-soon' },
  { from: 'active', trigger: 'expire', to: 'expired' },
  { from: 'active', trigger: 'invalidate', to: 'invalidated' },
  { from: 'active', trigger: 'logout', to: 'logged-out' },
  { from: 'active', trigger: 'daemon-down', to: 'daemon-unreachable' },
  { from: 'expiring-soon', trigger: 'extend', to: 'active' },
  { from: 'expiring-soon', trigger: 'daemon-down', to: 'daemon-unreachable' },
  { from: 'expiring-soon', trigger: 'expire', to: 'expired' },
  { from: 'expiring-soon', trigger: 'invalidate', to: 'invalidated' },
  { from: 'expiring-soon', trigger: 'logout', to: 'logged-out' },
  { from: 'daemon-unreachable', trigger: 'daemon-up', to: 'active' },
  { from: 'daemon-unreachable', trigger: 'expire', to: 'expired' },
  { from: 'daemon-unreachable', trigger: 'logout', to: 'logged-out' },
  { from: 'daemon-unreachable', trigger: 'invalidate', to: 'invalidated' },
];

const TRANSITION_MAP = new Map<string, SessionState>();
for (const t of TRANSITIONS) {
  TRANSITION_MAP.set(`${t.from}:${t.trigger}`, t.to);
}

export interface TransitionResult {
  ok: true;
  newState: SessionState;
}

export interface TransitionError {
  ok: false;
  error: string;
}

export function transition(
  current: SessionState,
  trigger: SessionTrigger,
): TransitionResult | TransitionError {
  if ((TERMINAL_STATES as readonly string[]).includes(current)) {
    return { ok: false, error: `Cannot transition from terminal state '${current}'` };
  }

  const key = `${current}:${trigger}`;
  const newState = TRANSITION_MAP.get(key);
  if (newState === undefined) {
    return { ok: false, error: `Invalid transition: '${current}' + '${trigger}'` };
  }

  return { ok: true, newState };
}

export function getValidTriggers(state: SessionState): SessionTrigger[] {
  return TRANSITIONS.filter((t) => t.from === state).map((t) => t.trigger);
}

export function isTerminal(state: SessionState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}
