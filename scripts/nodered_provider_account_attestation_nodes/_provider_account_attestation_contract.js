// Read-only provider-account attestation (lk2 ADR 0028, LK1 contract v1).
// The delegation prelude is prepended. No Mongo, provider write, journal or reservation.
const PA_PATH = "/lk/integrations/v1/provider-account-attestations";
const PA_TYPE = "phub-provider-account-attestation+jwt";
const PA_SCOPE = "lk1:provider-account:attest";
const PA_TENANT_KEY = "iSkq6G";
const PA_REQUEST_PREFIX = "provider-account-attestation:v1\0";
const PA_MAX_LIFETIME_SECONDS = 60;
const PA_MAX_SUBSCRIPTIONS = 50;
const PA_MAX_BODY_BYTES = 32 * 1024;
const PA_MAX_TITLE = 120;
const PA_FLAG = "LK1_PROVIDER_ACCOUNT_ATTESTATION_ENABLED";
const PA_REPLAY_KEY = "providerAccountAttestationSeen";
const PA_REPLAY_CAPACITY = 10000;
const PA_VIVA_BASE = "https://api.vivacrm.ru";
const PA_VIVA_USER = "/end-user/api/v1/" + PA_TENANT_KEY;
const PA_CLAIMS = [
  "iss", "aud", "sub", "sid", "iat", "nbf", "exp", "jti", "contract_version", "caller", "scope",
  "method", "path", "tenant_id", "tenant_key", "provider", "operation_id", "correlation_id",
  "request_sha256", "actor_token_sha256", "actor_token_expires_at",
].sort().join(",");
const PA_STATES = ["ACTIVE", "NOT_ACTIVATED", "PAUSED", "FINISHED"];

const PA_GAME_COLLECTION_LIMIT = 2;
const paLegacyGameId = (v) => typeof v === "string"
  && /^pay_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const paObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const paKeys = (v, keys) => paObject(v) && Object.keys(v).sort().join(",") === keys;
const paId = (v) => typeof v === "string" && BOOKED_OP_ID.test(v);
const paUuid = (v) => bookedOperationIsLowerUuid(v);
const paEnabled = (env) => BOOKED_OP_EXECUTION_ENABLED_VALUES.includes(
  String(bookedOperationEnv(env, PA_FLAG) || "").toLowerCase());
const paReject = (msg, status, code) => {
  msg.statusCode = status;
  msg.payload = { code };
  return msg;
};

// Exact request: {contractVersion:1, operationId, target?:{exerciseId}}. `request_sha256` signs the
// canonical form {contractVersion, operationId, target: {exerciseId} | null} in exactly that key order.
const paRequest = (v) => {
  if (!paObject(v) || !["contractVersion,operationId", "contractVersion,operationId,target"]
    .includes(Object.keys(v).sort().join(","))) return null;
  if (v.contractVersion !== 1 || !paUuid(v.operationId)) return null;
  if (v.target === undefined) return { contractVersion: 1, operationId: v.operationId };
  // Transition: `exerciseId` (a raw Viva id) or `legacyGameId` (the LK1 game id, `pay_<uuid>`).
  if (paKeys(v.target, "legacyGameId") && paLegacyGameId(v.target.legacyGameId)) {
    return { contractVersion: 1, operationId: v.operationId, target: { legacyGameId: v.target.legacyGameId } };
  }
  if (!paKeys(v.target, "exerciseId") || !paId(v.target.exerciseId)) return null;
  return { contractVersion: 1, operationId: v.operationId, target: { exerciseId: v.target.exerciseId } };
};
const paRequestSha256 = (request) => bookedOperationSha256(PA_REQUEST_PREFIX + JSON.stringify({
  contractVersion: request.contractVersion, operationId: request.operationId,
  target: !request.target ? null : request.target.legacyGameId !== undefined
    ? { legacyGameId: request.target.legacyGameId } : { exerciseId: request.target.exerciseId } }));

// Bounded in-memory replay registry (function-node context; contextStorage is off on LK1).
// Entries live until the delegation expires; a full registry fails closed.
const paRemember = (store, keys, untilMs, nowMs) => {
  const seen = paObject(store.get(PA_REPLAY_KEY)) ? store.get(PA_REPLAY_KEY) : {};
  for (const key of Object.keys(seen)) if (!(seen[key] > nowMs)) delete seen[key];
  if (keys.some((key) => Object.hasOwn(seen, key))) return "REPLAY";
  if (Object.keys(seen).length + keys.length > PA_REPLAY_CAPACITY) return "FULL";
  for (const key of keys) seen[key] = untilMs;
  store.set(PA_REPLAY_KEY, seen);
  return "OK";
};

// Viva End User list: a bare array or one complete Spring page (as the LK1 booking owner reads it).
const paCompleteList = (p) => {
  if (Array.isArray(p)) return p.length <= 1000 && p.every(paObject) ? p : null;
  if (!paObject(p) || !Array.isArray(p.content) || p.content.length > 1000 || !p.content.every(paObject)
    || (p.number !== undefined && p.number !== 0) || (p.last !== undefined && p.last !== true)
    || (p.totalElements !== undefined && p.totalElements !== p.content.length)
    || (p.totalPages !== undefined && ![0, 1].includes(p.totalPages)) || p.hasNext === true) return null;
  return p.content;
};
const paTitle = (v) => {
  if (typeof v !== "string") return null;
  const text = v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  return text ? Array.from(text).slice(0, PA_MAX_TITLE).join("") : null;
};

// Viva exercise id of one LK1 game record: the union of the aliases the LK1 game nodes read
// (confirm write-ack, projection sync, leave router). Every present value must agree; any
// disagreement, an unreadable value or no value refuses.
const paGameExerciseId = (record) => {
  if (!paObject(record)) return null;
  const nested = (v, k) => (paObject(v) ? v[k] : undefined);
  const dedupe = typeof record.dedupeKey === "string" ? /^viva:(.+)$/i.exec(record.dedupeKey.trim())?.[1] : undefined;
  const values = [record.exerciseId, record.vivaExerciseId,
    nested(record.booking, "exerciseId"), nested(record.booking, "vivaExerciseId"),
    nested(record.metadata, "exerciseId"), nested(record.metadata, "vivaExerciseId"),
    nested(nested(record.metadata, "splitPayment"), "exerciseId"),
    nested(nested(record.metadata, "splitPayment"), "vivaExerciseId"), dedupe]
    .filter((v) => v !== undefined && v !== null && v !== "");
  if (!values.length || !values.every((v) => typeof v === "string" && paId(v.trim()))) return null;
  const ids = [...new Set(values.map((v) => v.trim().toLowerCase()))];
  return ids.length === 1 ? values[0].trim() : null;
};
