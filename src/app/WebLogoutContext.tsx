import React, { createContext, useContext } from 'react';

/** App-owned navigation slot; absent for native or unauthenticated access. */
export const WebLogoutContext = createContext<React.ReactNode>(null);
export function useWebLogoutControl(): React.ReactNode {
  return useContext(WebLogoutContext);
}
