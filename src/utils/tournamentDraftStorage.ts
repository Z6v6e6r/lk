import type { AmericanoResultsResponse, AmericanoTournamentPayload } from "./apiClient";

const TOURNAMENT_DRAFT_STORAGE_PREFIX = "tournaments:draft";
const TOURNAMENT_DRAFT_STORAGE_VERSION = 1;
const TOURNAMENT_DRAFT_STORAGE_KIND = "tournament-draft";

export type TournamentDraftSnapshot = {
  payload: AmericanoTournamentPayload;
  totals: AmericanoResultsResponse["totals"] | null;
  playerLogs: AmericanoResultsResponse["playerLogs"] | null;
  updatedAt: string;
};

export type TournamentDraftStorageLike = Pick<Storage, "key" | "getItem" | "length">;

type TournamentDraftEnvelope = {
  version: number;
  kind: string;
  tournamentId: string;
  updatedAt: string;
  payload: AmericanoTournamentPayload;
  totals: AmericanoResultsResponse["totals"] | null;
  playerLogs: AmericanoResultsResponse["playerLogs"] | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toStringSafe(value: unknown) {
  return String(value ?? "").trim();
}

function safeJsonClone<T>(value: T): T {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function normalizeTournamentPayload(value: unknown): AmericanoTournamentPayload | null {
  if (!isRecord(value)) return null;

  const tournamentId = toStringSafe(value.tournamentId);
  const tenantKey = toStringSafe(value.tenantKey);
  const tournamentType = toStringSafe(value.tournamentType);

  if (!tournamentId || !tenantKey || !tournamentType) return null;

  const organizer = isRecord(value.organizer)
    ? {
        id: toStringSafe(value.organizer.id) || null,
        phone: toStringSafe(value.organizer.phone) || null,
        tenantKey: toStringSafe(value.organizer.tenantKey) || tenantKey,
      }
    : {
        id: null,
        phone: null,
        tenantKey,
      };

  return {
    tournamentId,
    tenantKey,
    createdAt: toStringSafe(value.createdAt) || new Date().toISOString(),
    organizer,
    tournamentType: tournamentType as AmericanoTournamentPayload["tournamentType"],
    targetScore:
      typeof value.targetScore === "number" && Number.isFinite(value.targetScore)
        ? value.targetScore
        : Number.parseInt(toStringSafe(value.targetScore) || "21", 10) || 21,
    courts: Array.isArray(value.courts)
      ? value.courts.map((item) => toStringSafe(item)).filter(Boolean)
      : ["Корт №1"],
    participants: Array.isArray(value.participants)
      ? value.participants.map((participant, index) => {
          const record = isRecord(participant) ? participant : {};
          return {
            id: toStringSafe(record.id) || null,
            phone: toStringSafe(record.phone) || null,
            rating: toStringSafe(record.rating) || null,
            photo: toStringSafe(record.photo) || null,
            name: toStringSafe(record.name) || `Участник ${index + 1}`,
          };
        })
      : [],
    ...(isRecord(value.params) ? { params: safeJsonClone(value.params) } : {}),
    rounds: Array.isArray(value.rounds) ? safeJsonClone(value.rounds) : [],
  };
}

function getTournamentDraftStorageKey(tournamentId: string) {
  return `${TOURNAMENT_DRAFT_STORAGE_PREFIX}:${tournamentId}`;
}

function isTournamentDraftStorageKey(value: string | null | undefined) {
  return String(value ?? "").startsWith(`${TOURNAMENT_DRAFT_STORAGE_PREFIX}:`);
}

function getTournamentDraftEnvelope(snapshot: TournamentDraftSnapshot): TournamentDraftEnvelope | null {
  const payload = normalizeTournamentPayload(snapshot.payload);
  if (!payload) return null;

  return {
    version: TOURNAMENT_DRAFT_STORAGE_VERSION,
    kind: TOURNAMENT_DRAFT_STORAGE_KIND,
    tournamentId: payload.tournamentId,
    updatedAt: snapshot.updatedAt || new Date().toISOString(),
    payload,
    totals: safeJsonClone(snapshot.totals ?? null),
    playerLogs: safeJsonClone(snapshot.playerLogs ?? null),
  };
}

function normalizeTournamentDraftEnvelope(value: unknown): TournamentDraftSnapshot | null {
  if (!isRecord(value)) return null;

  const hasEnvelopePayload = isRecord(value.payload);
  const source = hasEnvelopePayload ? value.payload : value;
  const payload = normalizeTournamentPayload(source);
  if (!payload) return null;
  const totals = hasEnvelopePayload && Object.prototype.hasOwnProperty.call(value, "totals")
    ? safeJsonClone(value.totals as AmericanoResultsResponse["totals"] | null)
    : null;
  const playerLogs = hasEnvelopePayload && Object.prototype.hasOwnProperty.call(value, "playerLogs")
    ? safeJsonClone(value.playerLogs as AmericanoResultsResponse["playerLogs"] | null)
    : null;

  return {
    payload,
    totals,
    playerLogs,
    updatedAt: toStringSafe(value.updatedAt) || new Date().toISOString(),
  };
}

export function serializeTournamentDraft(snapshot: TournamentDraftSnapshot): string {
  const envelope = getTournamentDraftEnvelope(snapshot);
  if (!envelope) {
    return "";
  }
  return JSON.stringify(envelope, null, 2);
}

export function parseTournamentDraft(value: string): TournamentDraftSnapshot | null {
  const rawText = String(value || "").trim();
  if (!rawText) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return null;
  }

  return normalizeTournamentDraftEnvelope(parsed);
}

export function saveCachedTournamentDraft(snapshot: TournamentDraftSnapshot): void {
  if (typeof window === "undefined") return;
  const payload = getTournamentDraftEnvelope(snapshot);
  if (!payload) return;

  try {
    window.localStorage.setItem(
      getTournamentDraftStorageKey(payload.tournamentId),
      JSON.stringify(payload),
    );
  } catch {
    // ignore storage write errors
  }
}

export function loadCachedTournamentDraft(tournamentId: string): TournamentDraftSnapshot | null {
  if (typeof window === "undefined") return null;
  const normalizedTournamentId = toStringSafe(tournamentId);
  if (!normalizedTournamentId) return null;

  try {
    const raw = window.localStorage.getItem(getTournamentDraftStorageKey(normalizedTournamentId));
    if (!raw) return null;
    return parseTournamentDraft(raw);
  } catch {
    return null;
  }
}

export function readCachedTournamentDraftsFromStorage(
  storage: TournamentDraftStorageLike,
): TournamentDraftSnapshot[] {
  const snapshots: TournamentDraftSnapshot[] = [];

  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!isTournamentDraftStorageKey(key)) continue;
      const raw = storage.getItem(key ?? "");
      if (!raw) continue;
      const snapshot = parseTournamentDraft(raw);
      if (snapshot) snapshots.push(snapshot);
    }
  } catch {
    return [];
  }

  return snapshots.sort((left, right) => {
    const leftTs = Date.parse(left.updatedAt || left.payload.createdAt || "");
    const rightTs = Date.parse(right.updatedAt || right.payload.createdAt || "");
    const safeLeftTs = Number.isFinite(leftTs) ? leftTs : 0;
    const safeRightTs = Number.isFinite(rightTs) ? rightTs : 0;
    return safeRightTs - safeLeftTs;
  });
}

export function listCachedTournamentDrafts(): TournamentDraftSnapshot[] {
  if (typeof window === "undefined") return [];
  return readCachedTournamentDraftsFromStorage(window.localStorage);
}
