export type TournamentSignupParticipant = {
  id: string;
  name: string;
  level: string | null;
  ratingNumeric: number | null;
  phone: string | null;
  avatarUrl: string | null;
  role: string | null;
};

export type TournamentSignupPublicRoster = {
  participants: TournamentSignupParticipant[];
  participantsCount: number;
  waitlistCount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pickString(value: unknown, keys: string[]): string | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  }
  return null;
}

function pickNumber(value: unknown, keys: string[]): number | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string" && raw.trim()) {
      const parsed = Number(raw.replace(",", "."));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function parseNumericValue(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.trim().replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function pickFirstArray(value: unknown, keys: string[]): unknown[] {
  if (!isRecord(value)) return [];
  for (const key of keys) {
    const raw = value[key];
    if (Array.isArray(raw)) return raw;
  }
  return [];
}

function normalizePhone(value: string | null | undefined) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

function collectPublicRosterRows(payload: unknown, seen = new Set<unknown>()): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload) || seen.has(payload)) return [];
  seen.add(payload);

  const rows: unknown[] = [];
  const keys = ["payload", "content", "data", "result", "items", "records", "participants", "bookings", "waitlist"];
  keys.forEach((key) => {
    const value = payload[key];
    if (Array.isArray(value)) {
      rows.push(...value);
      return;
    }
    if (isRecord(value)) {
      rows.push(...collectPublicRosterRows(value, seen));
    }
  });
  return rows;
}

function isCancelledTournamentParticipant(value: unknown) {
  if (!isRecord(value)) return true;
  const status = String(pickString(value, ["status", "state", "registrationStatus"]) || "").trim().toUpperCase();
  return (
    value.isCancelled === true
    || value.cancelled === true
    || value.canceled === true
    || status === "CANCELLED"
    || status === "CANCELED"
    || status === "CANCEL"
  );
}

function isWaitlistTournamentParticipant(value: unknown) {
  const status = String(pickString(value, ["status", "state", "registrationStatus"]) || "").trim().toUpperCase();
  return status.includes("WAITLIST") || status.includes("RESERVE");
}

function getTournamentParticipantKey(value: unknown, participant: TournamentSignupParticipant, index: number) {
  if (!isRecord(value)) return participant.id || `participant-${index}`;
  const client = isRecord(value.client) ? value.client : isRecord(value.user) ? value.user : isRecord(value.player) ? value.player : null;
  const clientId = pickString(client, ["id", "clientId", "userId", "uuid"]);
  if (clientId) return `client:${clientId}`;

  const phone =
    normalizePhone(pickString(client, ["phone", "phoneNumber", "phoneNorm"]))
    || normalizePhone(pickString(value, ["phone", "phoneNumber", "phoneNorm"]));
  if (phone) return `phone:${phone}`;

  const bookingId = pickString(value, ["id", "bookingId", "recordId", "uuid"]);
  if (bookingId) return `booking:${bookingId}`;

  return participant.id || `participant-${index}`;
}

export function normalizeTournamentSignupParticipant(item: unknown, index: number): TournamentSignupParticipant | null {
  if (!isRecord(item)) return null;
  const client = isRecord(item.client) ? item.client : isRecord(item.user) ? item.user : isRecord(item.player) ? item.player : null;
  const source = client || item;
  const firstName = pickString(source, ["firstName", "firstname", "givenName"]);
  const lastName = pickString(source, ["lastName", "lastname", "familyName"]);
  const name =
    pickString(source, ["name", "displayName", "fullName"])
    || [firstName, lastName].filter(Boolean).join(" ").trim()
    || pickString(item, ["clientName", "playerName", "participantName"])
    || "Игрок";
  const id =
    pickString(source, ["id", "clientId", "userId", "uuid"])
    || pickString(item, ["id", "clientId", "userId", "bookingId"])
    || `participant-${index}`;
  const status = String(pickString(item, ["status", "state", "registrationStatus"]) || "").toUpperCase();
  if (status === "CANCELLED" || status === "CANCELED") return null;
  const level =
    pickString(source, ["level", "rating", "grade", "ratingLabel", "levelLabel", "levelLetter"])
    || pickString(item, ["level", "rating", "grade", "ratingLabel", "levelLabel", "levelLetter"]);
  const ratingNumeric =
    pickNumber(source, ["ratingNumeric", "numericRating", "levelNumeric"])
    ?? pickNumber(item, ["ratingNumeric", "numericRating", "levelNumeric"])
    ?? parseNumericValue(level);

  return {
    id,
    name,
    level,
    ratingNumeric,
    phone:
      normalizePhone(pickString(source, ["phone", "phoneNumber", "phoneNorm"]))
      || normalizePhone(pickString(item, ["phone", "phoneNumber", "phoneNorm"])),
    avatarUrl:
      pickString(source, ["avatarUrl", "avatar", "photo", "imageUrl"])
      || pickString(item, ["avatarUrl", "avatar", "photo", "imageUrl"]),
    role: pickString(item, ["role", "participantRole"]),
  };
}

export function getTournamentSignupParticipantsFromPayload(payload: unknown): TournamentSignupParticipant[] {
  const directItems = pickFirstArray(payload, ["participants", "players", "clients", "registrations", "bookings"]);
  const nestedItems = isRecord(payload) && isRecord(payload.registration)
    ? pickFirstArray(payload.registration, ["participants", "players", "clients"])
    : [];

  return [...directItems, ...nestedItems]
    .map(normalizeTournamentSignupParticipant)
    .filter((item): item is TournamentSignupParticipant => item !== null);
}

export function normalizeTournamentSignupPublicRoster(payload: unknown): TournamentSignupPublicRoster {
  const participantMap = new Map<string, TournamentSignupParticipant>();
  const waitlistMap = new Map<string, TournamentSignupParticipant>();

  collectPublicRosterRows(payload).forEach((item, index) => {
    if (isCancelledTournamentParticipant(item)) return;

    const participant = normalizeTournamentSignupParticipant(item, index);
    if (!participant) return;

    const key = getTournamentParticipantKey(item, participant, index);
    if (isWaitlistTournamentParticipant(item)) {
      if (!waitlistMap.has(key)) waitlistMap.set(key, participant);
      return;
    }

    if (!participantMap.has(key)) participantMap.set(key, participant);
  });

  return {
    participants: Array.from(participantMap.values()),
    participantsCount: participantMap.size,
    waitlistCount: waitlistMap.size,
  };
}
