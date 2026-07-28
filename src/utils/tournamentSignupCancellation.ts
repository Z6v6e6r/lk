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

function pickNestedRecord(value: unknown, keys: string[]): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const raw = value[key];
    if (isRecord(raw)) return raw;
  }
  return null;
}

export function isTournamentSignupCancelledStatusValue(value: unknown) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) return false;
  return normalized === "CANCELLED"
    || normalized === "CANCELED"
    || normalized === "CANCEL"
    || normalized === "ОТМЕНЕН"
    || normalized === "ОТМЕНЁН"
    || normalized === "ОТМЕНЕННЫЙ"
    || normalized === "ОТМЕНЁННЫЙ"
    || normalized.includes("ОТМЕН");
}

function collectTournamentStateRecords(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) return [];
  const records: Record<string, unknown>[] = [value];
  for (const key of [
    "skin",
    "tournamentSkin",
    "customTournament",
    "publicTournament",
    "sourceTournamentSnapshot",
    "sourceTournament",
    "tournament",
    "details",
    "settings",
    "params",
  ]) {
    const nested = value[key];
    if (isRecord(nested)) records.push(...collectTournamentStateRecords(nested));
  }
  return records;
}

function resolveCurrentTournamentStatusSignal(record: Record<string, unknown>): string | null {
  const statusAudit = pickNestedRecord(record, ["statusAudit"]);
  const lastChange = pickNestedRecord(statusAudit, ["lastChange"]);
  return pickString(lastChange, ["toStatus", "status", "state"])
    || pickString(statusAudit, ["toStatus", "status", "state"])
    || pickString(record, [
      "status",
      "state",
      "rawStatus",
      "statusRaw",
      "sourceStatus",
      "externalStatus",
      "skinStatus",
      "tournamentStatus",
      "customStatus",
      "publicationStatus",
      "registrationStatus",
    ]);
}

function hasExplicitCancellationFlag(record: Record<string, unknown>) {
  return record.isCancelled === true
    || record.cancelled === true
    || record.canceled === true
    || record.isCanceled === true;
}

function hasCancellationTimestamp(record: Record<string, unknown>) {
  const statusAudit = pickNestedRecord(record, ["statusAudit"]);
  return Boolean(
    pickString(record, ["canceledAt", "cancelledAt", "autoCanceledAt", "autoCancelledAt"])
    || pickString(statusAudit, ["canceledAt", "cancelledAt", "autoCanceledAt", "autoCancelledAt"]),
  );
}

function hasStateIdentity(record: Record<string, unknown>) {
  return Boolean(pickString(record, [
    "id",
    "tournamentId",
    "uuid",
    "exerciseId",
    "sourceTournamentId",
    "publicUrl",
    "joinUrl",
    "name",
    "title",
  ]));
}

function isTournamentStateRecordCancelled(record: Record<string, unknown>) {
  const currentStatus = resolveCurrentTournamentStatusSignal(record);
  if (currentStatus) {
    return isTournamentSignupCancelledStatusValue(currentStatus);
  }

  if (hasExplicitCancellationFlag(record)) return true;

  // Historical cancel timestamps alone should not hide a reopened tournament,
  // but they are still a useful fallback for top-level records with no status.
  return hasStateIdentity(record) && hasCancellationTimestamp(record);
}

export function isTournamentSignupPayloadCancelled(value: unknown) {
  return collectTournamentStateRecords(value).some((record) => isTournamentStateRecordCancelled(record));
}
