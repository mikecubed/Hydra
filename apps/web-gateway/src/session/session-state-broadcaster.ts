/**
 * Session state broadcaster — sessionId → Set<callback> registry.
 * Notifies all connections on state change. Cleans failed callbacks. (FR-016)
 */
import type { SessionState } from '@hydra/web-contracts';
import type { SessionTrigger } from './session-state-machine.ts';

export interface SessionStateChangeEvent {
  type: 'state-change';
  previousState: SessionState;
  newState: SessionState;
  reason?: string;
  trigger?: SessionTrigger;
  expiresAt?: string;
}

export type StateChangeCallback = (event: SessionStateChangeEvent) => void;

export class SessionStateBroadcaster {
  private readonly listeners = new Map<string, Set<StateChangeCallback>>();

  register(sessionId: string, callback: StateChangeCallback): void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(callback);
  }

  unregister(sessionId: string, callback: StateChangeCallback): void {
    const set = this.listeners.get(sessionId);
    if (set) {
      set.delete(callback);
      if (set.size === 0) this.listeners.delete(sessionId);
    }
  }

  broadcast(sessionId: string, event: SessionStateChangeEvent): void {
    const set = this.listeners.get(sessionId);
    if (!set) return;

    const failed: StateChangeCallback[] = [];
    for (const cb of set) {
      try {
        cb(event);
      } catch {
        failed.push(cb);
      }
    }

    for (const cb of failed) {
      set.delete(cb);
    }
    if (set.size === 0) this.listeners.delete(sessionId);
  }

  getListenerCount(sessionId: string): number {
    return this.listeners.get(sessionId)?.size ?? 0;
  }
}
