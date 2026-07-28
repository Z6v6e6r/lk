import type { AmericanoTournamentPayload } from "./apiClient";

type TournamentJsonEnvelope = {
  version?: number;
  kind?: string;
  exportedAt?: string;
  payload?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toStringSafe(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const items = value
    .map((item) => toStringSafe(item))
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
}

function normalizeParticipants(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const record = isRecord(item) ? item : {};
    return {
      id: toStringSafe(record.id) || null,
      phone: toStringSafe(record.phone) || null,
      rating: toStringSafe(record.rating) || null,
      photo: toStringSafe(record.photo) || null,
      name: toStringSafe(record.name) || `Участник ${index + 1}`,
    };
  });
}

function normalizeRounds(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return value.map((round, roundIndex) => {
    const record = isRecord(round) ? round : {};
    const byes = normalizeStringArray(record.byes, []);
    const matches = Array.isArray(record.matches)
      ? record.matches.map((match, matchIndex) => {
          const matchRecord = isRecord(match) ? match : {};
          const courtIndex =
            typeof matchRecord.courtIndex === "number" && Number.isFinite(matchRecord.courtIndex)
              ? matchRecord.courtIndex
              : null;
          return {
            id: toStringSafe(matchRecord.id) || `match-${roundIndex + 1}-${matchIndex + 1}`,
            court: toStringSafe(matchRecord.court) || "Корт",
            ...(courtIndex != null ? { courtIndex } : {}),
            pair1: Array.isArray(matchRecord.pair1) ? matchRecord.pair1.map((item) => toStringSafe(item)).filter(Boolean) : [],
            pair2: Array.isArray(matchRecord.pair2) ? matchRecord.pair2.map((item) => toStringSafe(item)).filter(Boolean) : [],
            score1: typeof matchRecord.score1 === "number" ? matchRecord.score1 : null,
            score2: typeof matchRecord.score2 === "number" ? matchRecord.score2 : null,
          };
        })
      : [];

    return {
      id: toStringSafe(record.id) || `round-${roundIndex + 1}`,
      index: typeof record.index === "number" && Number.isFinite(record.index)
        ? record.index
        : roundIndex + 1,
      matches,
      ...(byes.length > 0 ? { byes } : {}),
    };
  });
}

function normalizeOrganizer(value: unknown, tenantKey: string) {
  const record = isRecord(value) ? value : {};
  return {
    id: toStringSafe(record.id) || null,
    phone: toStringSafe(record.phone) || null,
    tenantKey,
  };
}

export function serializeTournamentJson(payload: AmericanoTournamentPayload): string {
  const envelope: TournamentJsonEnvelope = {
    version: 1,
    kind: "tournament",
    exportedAt: new Date().toISOString(),
    payload,
  };
  return JSON.stringify(envelope, null, 2);
}

export function parseTournamentJson(value: string): AmericanoTournamentPayload | null {
  const rawText = String(value || "").trim();
  if (!rawText) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return null;
  }

  const source = isRecord(parsed) && Object.prototype.hasOwnProperty.call(parsed, "payload")
    ? parsed.payload
    : parsed;
  if (!isRecord(source)) return null;

  const tournamentId = toStringSafe(source.tournamentId || source.id);
  const tenantKey = toStringSafe(source.tenantKey);
  const createdAt = toStringSafe(source.createdAt) || new Date().toISOString();
  const tournamentType = toStringSafe(source.tournamentType);
  const targetScore = typeof source.targetScore === "number" && Number.isFinite(source.targetScore)
    ? source.targetScore
    : Number.parseInt(toStringSafe(source.targetScore) || "21", 10) || 21;
  const rounds = normalizeRounds(source.rounds);

  if (!tournamentId || !tenantKey || !tournamentType) return null;

  const payload: AmericanoTournamentPayload = {
    tournamentId,
    tenantKey,
    createdAt,
    organizer: normalizeOrganizer(source.organizer, tenantKey),
    tournamentType: tournamentType as AmericanoTournamentPayload["tournamentType"],
    targetScore,
    courts: normalizeStringArray(source.courts, ["Корт №1"]),
    participants: normalizeParticipants(source.participants),
    ...(isRecord(source.params) ? { params: source.params } : {}),
    ...(rounds ? { rounds } : {}),
  };

  return payload;
}

export function getTournamentJsonFileName(payload: AmericanoTournamentPayload): string {
  const parsedDate = payload.createdAt ? new Date(payload.createdAt) : null;
  const dateKey =
    parsedDate && !Number.isNaN(parsedDate.getTime())
      ? parsedDate.toISOString().slice(0, 10)
      : "tournament";
  return `tournament-${payload.tournamentId}-${dateKey}.json`;
}
