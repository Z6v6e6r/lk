import { useEffect, useState } from "react";
import { getCommunityRatingMonthStartTs } from "../../../services/community-rating/contract.ts";

export function getCommunityRatingMonthLabel(monthStartTs: number): string {
  const month = new Intl.DateTimeFormat("ru-RU", { month: "long", timeZone: "Europe/Moscow" })
    .format(new Date(monthStartTs));
  return month.charAt(0).toUpperCase() + month.slice(1);
}

export function useCommunityRatingMonth(): number {
  const [monthStartTs, setMonthStartTs] = useState(() => getCommunityRatingMonthStartTs(Date.now()));
  useEffect(() => {
    const refresh = () => setMonthStartTs(getCommunityRatingMonthStartTs(Date.now()));
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    refresh();
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  return monthStartTs;
}
