import React, { useEffect, useRef } from 'react';
import { useSession } from '../hooks/use-session.ts';
import { SessionContext } from '../context/session-context.ts';

/**
 * Terminal session states that should trigger a redirect to the login page
 * so the operator does not remain on a stale workspace with no valid session.
 */
const REDIRECT_STATES: ReadonlySet<string> = new Set(['expired', 'invalidated']);

/** Default redirect delay (ms) — brief enough to satisfy the 2 s target. */
const REDIRECT_DELAY_MS = 500;

interface SessionProviderProps {
  pollInterval?: number;
  /** Override the redirect target for testing; defaults to `/login`. */
  loginPath?: string;
  /** Override the redirect function for testing. Defaults to `location.assign`. */
  onRedirect?: (path: string) => void;
  children: React.ReactNode;
}

export function SessionProvider({
  pollInterval,
  loginPath = '/login',
  onRedirect,
  children,
}: SessionProviderProps): React.JSX.Element {
  const session = useSession(pollInterval);
  const redirectScheduled = useRef(false);
  const hadAuthenticatedSession = useRef(false);

  useEffect(() => {
    const state = session.session?.state;
    if (session.session != null) {
      hadAuthenticatedSession.current = true;
    }

    const lostSessionAfterAuth =
      session.session == null && !session.isLoading && hadAuthenticatedSession.current;

    if ((state != null && REDIRECT_STATES.has(state)) || lostSessionAfterAuth) {
      if (redirectScheduled.current) {
        return;
      }
      redirectScheduled.current = true;
      const redirect =
        onRedirect ??
        ((path: string) => {
          globalThis.location.assign(path);
        });
      const timer = setTimeout(() => {
        redirect(loginPath);
      }, REDIRECT_DELAY_MS);
      return () => {
        clearTimeout(timer);
      };
    }
    if (session.session != null && !REDIRECT_STATES.has(state)) {
      redirectScheduled.current = false;
    }
  }, [session.isLoading, session.session, session.session?.state, loginPath, onRedirect]);

  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}
