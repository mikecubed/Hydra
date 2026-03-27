import React from 'react';
import type { UseSessionResult } from '../hooks/use-session.ts';

export const SessionContext = React.createContext<UseSessionResult | null>(null);

/** Consumer hook — throws when called outside `<SessionProvider>`. */
export function useSessionContext(): UseSessionResult {
  const value = React.useContext(SessionContext);
  if (value === null) {
    throw new Error('useSessionContext() must be called inside a <SessionProvider>.');
  }
  return value;
}
