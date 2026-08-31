'use client';
import { createContext, useContext } from 'react';

const LoggedOutContext = createContext<(() => void) | null>(null);

export function LoggedOutProvider({
  onLoggedOut,
  children,
}: {
  onLoggedOut: () => void;
  children: React.ReactNode;
}) {
  return <LoggedOutContext.Provider value={onLoggedOut}>{children}</LoggedOutContext.Provider>;
}

/** Every screen's ScreenHeader (root variant) calls this on logout. Throws if used outside AuthGate — every route under /tryon-library-app is wrapped by it, so this should never happen. */
export function useLoggedOut(): () => void {
  const fn = useContext(LoggedOutContext);
  if (!fn) throw new Error('useLoggedOut must be used within the Try On Library AuthGate');
  return fn;
}
