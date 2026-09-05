import crypto from "node:crypto";

const TENANT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ACTIVE_PROVIDER_STATES = new Set(["ACTIVE", "OPEN", "SCHEDULED", "BOOKED"]);
const ACTIVE_GAME_STATES = new Set(["ACTIVE", "CONFIRMED", "DRAFT", "OPEN", "PAID", "PAYED", "PAYMENT_PENDING", "SCHEDULED", "UNPAID", "WAITING"]);

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};
const normalizeTime = (value) => {
  const text = toStr(value);
  const match = text?.match(/(?:T|^)(\d{2}:\d{2})(?::\d{2})?/);
  return match ? match[1] : null;
};
const allIds = (value) => (
  value && typeof value === "object"
    ? [toStr(value.id), toStr(value.uuid)].filter(Boolean)
    : [toStr(value)].filter(Boolean)
);
const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const isCancelled = (value) => /CANCEL|DELETE|ARCHIVE|VOID/i.test(toStr(value) || "");
const normalizeMongoId = (value) => {
  const raw = typeof value === "string" ? value : toStr(value?.$oid);
  return /^[0-9a-f]{24}$/i.test(raw || "") ? raw.toLowerCase() : null;
};

export function validateTenantMigrationScope({ tenantKey, dateFrom, dateTo, operationId }) {
  if (!TENANT_RE.test(toStr(tenantKey) || "")) throw new Error("tenantKey is invalid");
  if (!DATE_RE.test(toStr(dateFrom) || "") || !DATE_RE.test(toStr(dateTo) || "") || dateFrom > dateTo) {
    throw new Error("date range is invalid");
  }
  const from = Date.parse(`${dateFrom}T00:00:00.000Z`);
  const to = Date.parse(`${dateTo}T00:00:00.000Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || (to - from) / 86_400_000 > 14) {
    throw new Error("date range exceeds 14 days");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,95}$/.test(toStr(operationId) || "")) {
    throw new Error("operationId is invalid");
  }
}

export function buildLegacyTenantMigrationMongoQuery({ dateFrom, dateTo }) {
  return {
    archived: { $ne: true },
    status: { $nin: ["CANCELLED", "CANCELED"] },
    tenantKey: null,
    revision: null,
    "booking.date": { $gte: dateFrom, $lte: dateTo },
    "booking.timeFrom": { $type: "string", $ne: "" },
    "booking.timeTo": { $type: "string", $ne: "" },
    "booking.studioId": { $type: "string", $ne: "" },
  };
}

export function buildGlobalActiveLegacyTenantQuery({ dateFrom }) {
  if (!DATE_RE.test(toStr(dateFrom) || "")) throw new Error("global legacy boundary date is invalid");
  return {
    archived: { $ne: true },
    status: { $nin: ["CANCELLED", "CANCELED"] },
    tenantKey: null,
    revision: null,
    "booking.date": { $gte: dateFrom },
    "booking.timeFrom": { $type: "string", $ne: "" },
    "booking.timeTo": { $type: "string", $ne: "" },
    "booking.studioId": { $type: "string", $ne: "" },
  };
}

function gameIdentity(game) {
  const dedupe = toStr(game?.dedupeKey);
  const rootId = toStr(game?.id);
  const signals = [
    toStr(game?.booking?.vivaExerciseId),
    toStr(game?.booking?.exerciseId),
    toStr(game?.metadata?.vivaExerciseId),
    toStr(game?.metadata?.exerciseId),
    dedupe?.startsWith("viva:") ? toStr(dedupe.slice(5)) : null,
    rootId?.startsWith("viva_") ? toStr(rootId.slice(5)) : null,
  ].filter(Boolean);
  const unique = [...new Set(signals)];
  return {
    exerciseId: unique.length === 1 ? unique[0] : null,
    identitySignalCount: signals.length,
    identityAmbiguous: unique.length !== 1,
    studioId: toStr(game?.booking?.studioId),
    date: toStr(game?.booking?.date),
    timeFrom: normalizeTime(game?.booking?.timeFrom),
    timeTo: normalizeTime(game?.booking?.timeTo),
  };
}

function providerIdentity(row) {
  const lifecycleSignals = [toStr(row?.status), toStr(row?.state), toStr(row?.lifecycleStatus)]
    .filter(Boolean)
    .map((value) => value.toUpperCase());
  const uniqueLifecycleSignals = [...new Set(lifecycleSignals)];
  const exerciseSignals = [toStr(row?.id), toStr(row?.uuid), toStr(row?.exerciseId)].filter(Boolean);
  const studioSignals = [...allIds(row?.studio), ...allIds(row?.station), toStr(row?.studioId)].filter(Boolean);
  const dateSignals = [
    toStr(row?.date),
    toStr(row?.timeFrom)?.slice(0, 10),
    toStr(row?.startTime)?.slice(0, 10),
    toStr(row?.timeTo)?.slice(0, 10),
    toStr(row?.endTime)?.slice(0, 10),
  ].filter((value) => DATE_RE.test(value || ""));
  const timeFromSignals = [normalizeTime(row?.timeFrom), normalizeTime(row?.startTime)].filter(Boolean);
  const timeToSignals = [normalizeTime(row?.timeTo), normalizeTime(row?.endTime)].filter(Boolean);
  const uniqueExercises = [...new Set(exerciseSignals)];
  const uniqueStudios = [...new Set(studioSignals)];
  const uniqueDates = [...new Set(dateSignals)];
  const uniqueTimesFrom = [...new Set(timeFromSignals)];
  const uniqueTimesTo = [...new Set(timeToSignals)];
  const explicitlyCancelled = row?.isCancelled === true || row?.cancelled === true || row?.canceled === true;
  const lifecycleCancelled = lifecycleSignals.some((value) => isCancelled(value));
  const lifecycleUnknown = lifecycleSignals.some((value) => !ACTIVE_PROVIDER_STATES.has(value) && !isCancelled(value));
  const lifecycleActive = row?.active === true
    && !explicitlyCancelled
    && !lifecycleCancelled
    && !lifecycleUnknown
    && uniqueLifecycleSignals.length <= 1;
  return {
    exerciseId: uniqueExercises.length === 1 ? uniqueExercises[0] : null,
    exerciseSignals,
    identityAmbiguous: uniqueExercises.length !== 1
      || uniqueStudios.length !== 1
      || uniqueDates.length !== 1
      || uniqueTimesFrom.length !== 1
      || uniqueTimesTo.length !== 1,
    studioId: uniqueStudios.length === 1 ? uniqueStudios[0] : null,
    date: uniqueDates.length === 1 ? uniqueDates[0] : null,
    timeFrom: uniqueTimesFrom.length === 1 ? uniqueTimesFrom[0] : null,
    timeTo: uniqueTimesTo.length === 1 ? uniqueTimesTo[0] : null,
    cancelled: explicitlyCancelled || row?.active === false || lifecycleCancelled,
    lifecycleAmbiguous: uniqueLifecycleSignals.length > 1,
    lifecycleActive,
  };
}

export function classifyLegacyTenantMigrationGame(game, providerRows, scope) {
  validateTenantMigrationScope(scope);
  const mongoId = normalizeMongoId(game?._id);
  if (!game || typeof game !== "object" || !mongoId) return { eligible: false, reason: "MONGO_ID_INVALID" };
  if (!(game.tenantKey === null || game.tenantKey === undefined)) return { eligible: false, reason: "TENANT_ALREADY_ASSIGNED" };
  if (!(game.revision === null || game.revision === undefined)) return { eligible: false, reason: "REVISION_ALREADY_ASSIGNED" };
  if (game.archived === true || isCancelled(game.status)) return { eligible: false, reason: "GAME_INACTIVE" };
  if (!ACTIVE_GAME_STATES.has(toStr(game.status)?.toUpperCase())) return { eligible: false, reason: "GAME_STATUS_UNKNOWN" };
  const identity = gameIdentity(game);
  if (identity.identityAmbiguous || !UUID_RE.test(identity.exerciseId || "")) return { eligible: false, reason: "EXERCISE_IDENTITY_INVALID" };
  if (!identity.studioId || !DATE_RE.test(identity.date || "") || !identity.timeFrom || !identity.timeTo
    || identity.date < scope.dateFrom || identity.date > scope.dateTo) {
    return { eligible: false, reason: "GAME_SLOT_INVALID" };
  }
  const normalizedProviderRows = (Array.isArray(providerRows) ? providerRows : []).map(providerIdentity);
  const relatedRows = normalizedProviderRows.filter((row) => row.exerciseSignals.includes(identity.exerciseId));
  if (relatedRows.some((row) => row.identityAmbiguous)) return { eligible: false, reason: "PROVIDER_IDENTITY_AMBIGUOUS" };
  const sameExercise = relatedRows.filter((row) => row.exerciseId === identity.exerciseId);
  if (sameExercise.length !== 1) {
    return { eligible: false, reason: sameExercise.length === 0 ? "PROVIDER_EXERCISE_MISSING" : "PROVIDER_EXERCISE_DUPLICATE" };
  }
  const provider = sameExercise[0];
  if (provider.lifecycleAmbiguous) return { eligible: false, reason: "PROVIDER_LIFECYCLE_AMBIGUOUS" };
  if (provider.cancelled) return { eligible: false, reason: "PROVIDER_EXERCISE_INACTIVE" };
  if (!provider.lifecycleActive) return { eligible: false, reason: "PROVIDER_EXERCISE_STATUS_UNKNOWN" };
  if (provider.studioId !== identity.studioId || provider.date !== identity.date
    || provider.timeFrom !== identity.timeFrom || provider.timeTo !== identity.timeTo) {
    return { eligible: false, reason: "PROVIDER_SLOT_MISMATCH" };
  }
  return { eligible: true, reason: "PROVIDER_IDENTITY_CONFIRMED", mongoId, identity, provider };
}

export function buildLegacyTenantMigrationOperation(game, classification, scope, nowIso) {
  validateTenantMigrationScope(scope);
  if (!classification?.eligible) throw new Error("classification is not eligible");
  if (!Number.isFinite(Date.parse(nowIso))) throw new Error("nowIso is invalid");
  const { identity, mongoId } = classification;
  const fingerprint = sha256(`${mongoId}|${identity.exerciseId}|${identity.studioId}|${identity.date}|${identity.timeFrom}|${identity.timeTo}`);
  const eventId = `game_tenant_revision_${sha256(`${scope.operationId}|${fingerprint}`).slice(0, 24)}`;
  const event = {
    id: eventId,
    at: nowIso,
    type: "GAME_TENANT_REVISION_MIGRATED",
    source: "viva_game_projection_tenant_migration",
    payload: { operationId: scope.operationId, tenantKey: scope.tenantKey, exerciseId: identity.exerciseId, reason: classification.reason },
  };
  const filter = {
    _id: { $oid: mongoId },
    tenantKey: null,
    revision: null,
    archived: { $ne: true },
    "booking.studioId": identity.studioId,
    "booking.date": identity.date,
    "booking.timeFrom": game.booking.timeFrom,
    "booking.timeTo": game.booking.timeTo,
  };
  const bindSnapshotField = (field, owner, key) => {
    filter[field] = Object.hasOwn(owner || {}, key) ? owner[key] : { $exists: false };
  };
  bindSnapshotField("status", game, "status");
  bindSnapshotField("updatedAt", game, "updatedAt");
  bindSnapshotField("id", game, "id");
  bindSnapshotField("dedupeKey", game, "dedupeKey");
  bindSnapshotField("booking.vivaExerciseId", game.booking, "vivaExerciseId");
  bindSnapshotField("booking.exerciseId", game.booking, "exerciseId");
  bindSnapshotField("metadata.vivaExerciseId", game.metadata, "vivaExerciseId");
  bindSnapshotField("metadata.exerciseId", game.metadata, "exerciseId");
  return {
    fingerprint,
    filter,
    update: {
      $set: {
        tenantKey: scope.tenantKey,
        revision: 1,
        updatedAt: nowIso,
        "audit.updatedAt": nowIso,
        "audit.lastEvent": event,
        "metadata.tenantRevisionMigration": {
          operationId: scope.operationId,
          eventId,
          tenantKey: scope.tenantKey,
          migratedAt: nowIso,
          previousUpdatedAt: toStr(game.updatedAt),
        },
      },
      $push: { "audit.events": { $each: [event], $slice: -100 } },
    },
    options: { upsert: false },
    report: { fingerprint, exerciseIdHash: sha256(identity.exerciseId), date: identity.date, reason: classification.reason },
  };
}

export function buildLegacyTenantMigrationPlan(games, providerRowsByDate, scope, nowIso) {
  validateTenantMigrationScope(scope);
  const operations = [];
  const skipped = {};
  for (const game of Array.isArray(games) ? games : []) {
    const date = toStr(game?.booking?.date);
    const rows = providerRowsByDate instanceof Map ? providerRowsByDate.get(date) : providerRowsByDate?.[date];
    const classification = classifyLegacyTenantMigrationGame(game, rows || [], scope);
    if (!classification.eligible) {
      skipped[classification.reason] = (skipped[classification.reason] || 0) + 1;
      continue;
    }
    operations.push(buildLegacyTenantMigrationOperation(game, classification, scope, nowIso));
  }
  return { scope: { ...scope }, scannedCount: Array.isArray(games) ? games.length : 0, eligibleCount: operations.length, skipped, operations };
}
