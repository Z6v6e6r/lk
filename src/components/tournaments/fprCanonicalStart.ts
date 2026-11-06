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
