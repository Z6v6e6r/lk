const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
const candidates = [];
const addCandidate = (value) => {
  if (Array.isArray(value)) {
    for (const item of value) addCandidate(item);
    return;
  }
  if (!isObject(value) || candidates.includes(value)) return;
  candidates.push(value);
  addCandidate(value.result);
  addCandidate(value.payload);
};

addCandidate(msg.payload);
addCandidate(msg.result);

const hasRawError = candidates.some((value) => (
  Boolean(value.error)
  || Boolean(value.errmsg)
  || Boolean(value.codeName)
  || (Array.isArray(value.writeErrors) && value.writeErrors.length > 0)
));
const count = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const acknowledgementValues = candidates
  .filter((value) => Object.prototype.hasOwnProperty.call(value, "acknowledged"))
  .map((value) => value.acknowledged);
const acknowledged = acknowledgementValues.includes(true)
  && acknowledgementValues.every((value) => value === true);
const hasPositiveCount = (...fields) => candidates.some((value) => (
  fields.some((field) => count(value?.[field]) > 0)
));
const hasUpsertedEvidence = candidates.some((value) => {
  const upsertedId = value?.upsertedId;
  if (upsertedId !== null && upsertedId !== undefined && upsertedId !== "") return true;
  const upserted = value?.upserted;
  if (Array.isArray(upserted)) return upserted.length > 0;
  if (isObject(upserted)) return Object.keys(upserted).length > 0;
  if (typeof upserted === "boolean") return upserted;
  if (typeof upserted === "number") return Number.isFinite(upserted) && upserted > 0;
  if (typeof upserted === "string") return upserted.trim() !== "";
  return false;
});
const persisted = acknowledged
  && !msg.error
  && !hasRawError
  && (
    hasPositiveCount("matchedCount", "n")
    || hasPositiveCount("modifiedCount", "nModified")
    || hasPositiveCount("upsertedCount")
    || hasUpsertedEvidence
  );
const legacyPayload = isObject(msg._tournamentLegacySuccessPayload)
  ? msg._tournamentLegacySuccessPayload
  : null;

delete msg.error;
delete msg._tournamentLegacySuccessPayload;

msg.headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

if (!persisted || !legacyPayload) {
  msg.statusCode = 503;
  msg.payload = {
    error: "TOURNAMENT_PERSISTENCE_FAILED",
    message: "Не удалось сохранить турнир. Повторите попытку",
    retryable: true,
  };
  return msg;
}

msg.statusCode = 200;
msg.payload = legacyPayload;
return msg;
