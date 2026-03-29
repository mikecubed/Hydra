/**
 * useSession — Session lifecycle hook with polling, WebSocket, and actions.
 *
 * Exports:
 *  - `createSessionManager(deps)` — testable core state machine (no React).
 *  - `useSession(pollIntervalMs?)` — thin React wrapper around the manager.
 */
import type {
  SessionInfo as SessionInfoType,
  ExtendResponse as ExtendResponseType,
} from '@hydra/web-contracts';
import { SessionEvent, TERMINAL_STATES } from '@hydra/web-contracts';
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getSessionInfo as defaultGetSessionInfo,
  reauth as defaultReauth,
  logout as defaultLogout,
} from '../api/auth-client.ts';

// ─── Public types ───────────────────────────────────────────────────────────

export interface UseSessionResult {
  session: SessionInfoType | null;
  isLoading: boolean;
  /** Number of consecutive poll errors since last successful poll. */
  pollErrorCount: number;
  extend: () => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<SessionInfoType | null>;
}

// ─── Session manager (testable core) ────────────────────────────────────────

export interface SessionManagerDeps {
  getSessionInfo: () => Promise<SessionInfoType | null>;
  reauth: () => Promise<ExtendResponseType>;
  logout: () => Promise<void>;
  pollIntervalMs: number;
  WebSocketCtor: new (url: string) => WebSocket;
}

interface SessionManagerState {
  session: SessionInfoType | null;
  isLoading: boolean;
  /** Number of consecutive poll errors since last successful poll. */
  pollErrorCount: number;
}

type Listener = () => void;

function shouldPoll(session: SessionInfoType | null): boolean {
  if (session === null) return false;
  if ((TERMINAL_STATES as readonly string[]).includes(session.state)) return false;
  if (session.state === 'daemon-unreachable') return false;
  return session.state === 'active' || session.state === 'expiring-soon';
}

function jitteredDelay(base: number): number {
  return Math.round(base * (0.95 + Math.random() * 0.1));
}

type VisibilityDoc = {
  visibilityState: string;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

function getDocument(): VisibilityDoc | null {
  // globalThis.document may not exist in Node (test/SSR) — guard with Reflect.has
  if (!Reflect.has(globalThis, 'document')) return null;
  return Reflect.get(globalThis, 'document') as VisibilityDoc;
}

export interface SessionManager {
  getState(): SessionManagerState;
  subscribe(listener: Listener): () => void;
  extend(): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<SessionInfoType | null>;
  destroy(): void;
}

// ── Internal controller (keeps createSessionManager under size limit) ─────

interface ManagerInternals {
  state: SessionManagerState;
  destroyed: boolean;
  listeners: Set<Listener>;
  pollTimerId: ReturnType<typeof setTimeout> | null;
  ws: WebSocket | null;
  wsReconnectAttempt: number;
  wsReconnectTimerId: ReturnType<typeof setTimeout> | null;
}

function setState(ctx: ManagerInternals, next: Partial<SessionManagerState>) {
  if (ctx.destroyed) return;
  ctx.state = { ...ctx.state, ...next };
  for (const l of ctx.listeners) l();
}

function stopPoll(ctx: ManagerInternals) {
  if (ctx.pollTimerId !== null) {
    clearTimeout(ctx.pollTimerId);
    ctx.pollTimerId = null;
  }
}

function closeWs(ctx: ManagerInternals) {
  if (ctx.wsReconnectTimerId !== null) {
    clearTimeout(ctx.wsReconnectTimerId);
    ctx.wsReconnectTimerId = null;
  }
  if (ctx.ws) {
    ctx.ws.close();
    ctx.ws = null;
  }
}

function schedulePoll(ctx: ManagerInternals, deps: SessionManagerDeps) {
  stopPoll(ctx);
  if (ctx.destroyed || !shouldPoll(ctx.state.session)) return;
  const doc = getDocument();
  if (doc?.visibilityState === 'hidden') return;
  ctx.pollTimerId = setTimeout(() => {
    ctx.pollTimerId = null;
    void doPoll(ctx, deps);
  }, jitteredDelay(deps.pollIntervalMs));
}

async function doPoll(ctx: ManagerInternals, deps: SessionManagerDeps) {
  if (ctx.destroyed) return;
  try {
    const info = await deps.getSessionInfo();
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- state may change across await
    if (ctx.destroyed) return;
    setState(ctx, { session: info, pollErrorCount: 0 });
  } catch {
    // Track consecutive poll errors so the UI can surface degraded feedback.
    setState(ctx, { pollErrorCount: ctx.state.pollErrorCount + 1 });
  }
  schedulePoll(ctx, deps);
}

function handleWsMessage(ctx: ManagerInternals, ev: MessageEvent) {
  if (ctx.destroyed) return;
  try {
    const event = SessionEvent.parse(JSON.parse(ev.data as string));
    if (!ctx.state.session) return;
    if (event.type === 'forced-logout') {
      stopPoll(ctx);
    }
    setState(ctx, { session: { ...ctx.state.session, state: event.newState } });
  } catch {
    // Ignore parse errors.
  }
}

function scheduleWsReconnect(ctx: ManagerInternals, deps: SessionManagerDeps) {
  if (ctx.destroyed || !shouldPoll(ctx.state.session)) return;
  const base = Math.min(1000 * 2 ** ctx.wsReconnectAttempt, 30_000);
  const jitter = Math.round((Math.random() - 0.5) * 1000);
  const delay = Math.max(0, base + jitter);
  ctx.wsReconnectAttempt++;
  ctx.wsReconnectTimerId = setTimeout(() => {
    ctx.wsReconnectTimerId = null;
    connectWs(ctx, deps);
  }, delay);
}

function connectWs(ctx: ManagerInternals, deps: SessionManagerDeps) {
  if (ctx.destroyed || !shouldPoll(ctx.state.session)) return;
  try {
    const socket = new deps.WebSocketCtor('/ws');
    ctx.ws = socket;
    socket.onmessage = (ev: MessageEvent) => {
      handleWsMessage(ctx, ev);
    };
    socket.onclose = () => {
      if (ctx.destroyed) return;
      ctx.ws = null;
      if (shouldPoll(ctx.state.session)) {
        scheduleWsReconnect(ctx, deps);
      }
    };
    ctx.wsReconnectAttempt = 0;
  } catch {
    scheduleWsReconnect(ctx, deps);
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const ctx: ManagerInternals = {
    state: { session: null, isLoading: true, pollErrorCount: 0 },
    destroyed: false,
    listeners: new Set(),
    pollTimerId: null,
    ws: null,
    wsReconnectAttempt: 0,
    wsReconnectTimerId: null,
  };

  const doc = getDocument();

  function onVisibilityChange() {
    const d = getDocument();
    if (!d) return;
    if (d.visibilityState === 'hidden') {
      stopPoll(ctx);
    } else if (shouldPoll(ctx.state.session)) {
      void doPoll(ctx, deps);
    }
  }

  if (doc) doc.addEventListener('visibilitychange', onVisibilityChange);

  // Initial fetch
  void (async () => {
    try {
      const info = await deps.getSessionInfo();
      if (ctx.destroyed) return;
      setState(ctx, { session: info, isLoading: false, pollErrorCount: 0 });
    } catch {
      if (ctx.destroyed) return;
      setState(ctx, { session: null, isLoading: false, pollErrorCount: 1 });
    }
    schedulePoll(ctx, deps);
    if (shouldPoll(ctx.state.session)) connectWs(ctx, deps);
  })();

  return {
    getState: () => ctx.state,
    subscribe(listener: Listener) {
      ctx.listeners.add(listener);
      return () => {
        ctx.listeners.delete(listener);
      };
    },
    async extend() {
      const result = await deps.reauth();
      if (ctx.destroyed || !ctx.state.session) return;
      const newState =
        ctx.state.session.state === 'expiring-soon' ? 'active' : ctx.state.session.state;
      setState(ctx, {
        session: {
          ...ctx.state.session,
          expiresAt: result.newExpiresAt,
          state: newState as SessionInfoType['state'],
        },
      });
    },
    async logout() {
      await deps.logout();
      if (ctx.destroyed) return;
      stopPoll(ctx);
      closeWs(ctx);
      setState(ctx, { session: null });
    },
    async refresh() {
      const info = await deps.getSessionInfo();
      if (ctx.destroyed) return null;
      setState(ctx, { session: info });
      return info;
    },
    destroy() {
      ctx.destroyed = true;
      stopPoll(ctx);
      closeWs(ctx);
      if (doc) doc.removeEventListener('visibilitychange', onVisibilityChange);
      ctx.listeners.clear();
    },
  };
}

// ─── React hook wrapper ─────────────────────────────────────────────────────

const DEFAULT_POLL_MS = 60_000;

export function useSession(pollIntervalMs?: number): UseSessionResult {
  const intervalMs = pollIntervalMs ?? DEFAULT_POLL_MS;
  const mgrRef = useRef<SessionManager | null>(null);

  mgrRef.current ??= createSessionManager({
    getSessionInfo: defaultGetSessionInfo,
    reauth: defaultReauth,
    logout: defaultLogout,
    pollIntervalMs: intervalMs,
    WebSocketCtor: WebSocket,
  });

  const mgr = mgrRef.current;
  const [state, setLocalState] = useState(() => mgr.getState());

  useEffect(() => {
    const unsubscribe = mgr.subscribe(() => {
      setLocalState(mgr.getState());
    });
    return () => {
      unsubscribe();
      mgr.destroy();
      mgrRef.current = null;
    };
  }, [mgr]);

  const extend = useCallback(async () => {
    await mgrRef.current?.extend();
  }, []);

  const logoutAction = useCallback(async () => {
    await mgrRef.current?.logout();
  }, []);

  const refresh = useCallback(async () => {
    const manager = mgrRef.current;
    if (manager == null) {
      return null;
    }
    return manager.refresh();
  }, []);

  return {
    session: state.session,
    isLoading: state.isLoading,
    pollErrorCount: state.pollErrorCount,
    extend,
    logout: logoutAction,
    refresh,
  };
}
