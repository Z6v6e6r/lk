import { useEffect, useState } from "react";
import { residencyLifecycleClient } from "./residencyLifecycleTransport";

type PilotAccess = { state: "checking" | "closed" | "unavailable" } | { state: "open"; canCreate: boolean };
const CHECKING: PilotAccess = { state: "checking" };
const CHECK_INTERVAL_MS = 5_000;

export function useResidencyPilotAccess(check: boolean): PilotAccess {
  const [access, setAccess] = useState<PilotAccess>(CHECKING);

  useEffect(() => {
    if (!check) return;
    let stopped = false;
    let pending: AbortController | null = null;
    let lastCheck = -Infinity;

    const refresh = async () => {
      if (pending || stopped || document.visibilityState === "hidden"
        || performance.now() - lastCheck < 1_000) return;
      const controller = new AbortController();
      pending = controller;
      const timeout = window.setTimeout(() => controller.abort(), CHECK_INTERVAL_MS);
      lastCheck = performance.now();
      let result: PilotAccess;
      try {
        const response = await residencyLifecycleClient.readPilotAccess(controller.signal);
        if (response.ok) result = { state: "open", canCreate: response.value.canCreate };
        else {
          const { code, status } = response.failure;
          result = { state: status === 403 || status === 404 || code === "RESIDENCY_PILOT_CLOSED"
            || code === "RESIDENCY_CREATE_POLICY_INVALID" ? "closed" : "unavailable" };
        }
      } catch {
        result = { state: "unavailable" };
      } finally {
        window.clearTimeout(timeout);
        pending = null;
      }
      if (!stopped) setAccess(result);
    };

    void refresh();
    const interval = window.setInterval(refresh, CHECK_INTERVAL_MS);
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      stopped = true;
      pending?.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [check]);

  return check ? access : CHECKING;
}
