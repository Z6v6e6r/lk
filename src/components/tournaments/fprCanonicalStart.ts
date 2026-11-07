export interface FprCanonicalStart {
  source: "CUP_CANONICAL";
  rows: Array<{ clientId: string; ratingNumeric: number; version: string }>;
}

export function readFprCanonicalStart(ids: string[], value: unknown): FprCanonicalStart {
  const data = value as Partial<FprCanonicalStart> | null;
  if (!ids.length || ids.length > 28 || new Set(ids).size !== ids.length
    || data?.source !== "CUP_CANONICAL" || !Array.isArray(data.rows) || data.rows.length !== ids.length) {
    throw new Error("Не удалось получить стартовые уровни ЦУП для всего состава");
  }
  const rows = ids.map(clientId => {
    const matches = data.rows!.filter(row => row?.clientId === clientId);
    const row = matches[0];
    if (matches.length !== 1 || typeof row.ratingNumeric !== "number" || !Number.isFinite(row.ratingNumeric)
      || row.ratingNumeric < 1 || row.ratingNumeric > 7 || typeof row.version !== "string" || !row.version) {
      throw new Error("Стартовый уровень ЦУП недоступен. Обновите данные состава");
    }
    return { clientId, ratingNumeric: row.ratingNumeric, version: row.version };
  });
  return { source: "CUP_CANONICAL", rows };
}


export function formatFprStartError(error: { message?: string; raw?: unknown } | null | undefined, players: Array<{id:string;name:string}>) {
  let raw = error?.raw;
  if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { raw = null; } }
  const data = raw && typeof raw === "object" ? raw as {playerId?:unknown;error?:unknown} : null;
  const player = players.find(p => p.id === data?.playerId);
  if (!player) return error?.message || "Не удалось загрузить стартовые уровни ЦУП";
  const reasons: Record<string,string> = {
    FPR_START_IDENTITY_CONFLICT: "В ЦУП неоднозначная привязка игрока.",
    FPR_START_HISTORY_INVALID: "История рейтинга требует проверки; стартовый уровень не заменён.",
    FPR_START_INVALID_LEVEL: "В ЦУП некорректный числовой уровень.",
    FPR_START_INVALID_CANONICAL: "Каноническая запись рейтинга требует проверки.",
    FPR_START_PROJECTION_BUSY: "Рейтинг сейчас синхронизируется. Повторите загрузку.",
  };
  return `Не удалось загрузить рейтинг «${player.name.trim() || `Участник ${players.indexOf(player) + 1}`}»: ${reasons[String(data?.error)] || error?.message || "Повторите загрузку состава."}`;
}
