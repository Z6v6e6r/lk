import { useEffect } from "react";
import { beginLkTournamentSession, installLkIdleDataGuard } from "./lkIdleDataGuard";

export function useLkTournamentSession(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    installLkIdleDataGuard();
    return beginLkTournamentSession();
  }, [active]);
}
