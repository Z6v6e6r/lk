import { createContext, useContext, type ReactNode } from "react";

const OverlayScopeContext = createContext(false);

export function OverlayScopeProvider({
  value,
  children,
}: {
  value: boolean;
  children: ReactNode;
}) {
  return (
    <OverlayScopeContext.Provider value={value}>
      {children}
    </OverlayScopeContext.Provider>
  );
}

export function useIsOverlayScope() {
  return useContext(OverlayScopeContext);
}
