export type FprLeagueValue = { level: string; points: string; place: string; newcomer: boolean };
export type FprLeaguePlayer = { id: string; rating?: string | null };
export type FprLeagueRanking = {
  communityId: string; period: "month" | "all"; updatedAt: string | null;
  items: Array<{ playerId: string | null; rank: number; overallScore: number; currentLevel: number }>;
};
export type FprLoadedLeague = {
  communityId: string; communityName: string; period: "month" | "all"; snapshotUpdatedAt: string | null;
  values: Record<string, FprLeagueValue>; missingFromMonth: string[];
};

function rowsById(data: FprLeagueRanking) {
  const rows = new Map<string, FprLeagueRanking["items"][number]>();
  for (const row of data.items) {
    const id = row.playerId?.trim();
    if (!id) continue;
    if (rows.has(id)) throw new Error("В рейтинге сообщества несколько строк одного игрока. Обновите рейтинг.");
    if (!Number.isInteger(row.rank) || row.rank < 1 || !Number.isFinite(row.overallScore)) {
      throw new Error("В рейтинге сообщества некорректное место или количество очков.");
    }
    rows.set(id, row);
  }
  return rows;
}

// One common period is frozen for the whole roster. A valid zero is data;
// neither a matching name nor a phone is evidence of a matching player ID.
export async function loadFprCommunityLeague(input: {
  communityId: string; communityName: string; players: FprLeaguePlayer[];
  fetch: (period: "month" | "all") => Promise<FprLeagueRanking>;
}): Promise<FprLoadedLeague> {
  const month = await input.fetch("month");
  if (month.communityId !== input.communityId || month.period !== "month") throw new Error("Получен рейтинг другого сообщества или периода");
  const monthlyRows = rowsById(month);
  const missingFromMonth = input.players.filter(p => !monthlyRows.has(p.id)).map(p => p.id);
  const source = missingFromMonth.length ? await input.fetch("all") : month;
  if (source.communityId !== input.communityId || source.period !== (missingFromMonth.length ? "all" : "month")) {
    throw new Error("Получен рейтинг другого сообщества или периода");
  }
  const rows = missingFromMonth.length ? rowsById(source) : monthlyRows;
  const values = Object.fromEntries(input.players.map(player => {
    const row = rows.get(player.id);
    return [player.id, {
      level: player.rating?.trim() || (row && row.currentLevel > 0 ? String(row.currentLevel) : ""),
      points: row ? String(row.overallScore) : "0",
      place: row ? String(row.rank) : "",
      newcomer: !row,
    }];
  }));
  return { communityId: input.communityId, communityName: input.communityName, period: source.period,
    snapshotUpdatedAt: source.updatedAt, values, missingFromMonth };
}

export function fprLeagueLabel(league: Pick<FprLoadedLeague, "communityName" | "period">, now = new Date()) {
  const period = league.period === "all" ? "за всё время"
    : new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "Europe/Moscow" }).format(now).replace(/\s*г\.$/u, "");
  return `${league.communityName} · ${period}`;
}
