import { useEffect, useState } from "react";

export function useDeadlineCountdown(targetIso: string | null | undefined): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!targetIso) return undefined;

    const targetTs = Date.parse(targetIso);
    if (!Number.isFinite(targetTs)) return undefined;

    setNowMs(Date.now());
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [targetIso]);

  const targetTs = targetIso ? Date.parse(targetIso) : NaN;
  if (!Number.isFinite(targetTs)) return 0;
  return Math.max(targetTs - nowMs, 0);
}
