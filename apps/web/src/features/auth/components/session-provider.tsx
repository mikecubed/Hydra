import React from 'react';
import { useSession } from '../hooks/use-session.ts';
import { SessionContext } from '../context/session-context.ts';

interface SessionProviderProps {
  pollInterval?: number;
  children: React.ReactNode;
}

export function SessionProvider({
  pollInterval,
  children,
}: SessionProviderProps): React.JSX.Element {
  const session = useSession(pollInterval);
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}
