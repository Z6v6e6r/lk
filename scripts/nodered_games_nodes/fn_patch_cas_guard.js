const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const respond = (statusCode, code, error) => {
  msg.statusCode = statusCode;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  };
  msg.payload = { error, code };
  return [null, msg, msg];
};

const body = isObj(msg.payload) ? msg.payload : {};
const protectedFields = [
  "participants",
  "waitlist",
  "invitedPhones",
  "invites",
  "organizer",
  "metadata",
  "resultRosterSnapshot",
];
const requiresCas = protectedFields.some((field) => hasOwn(body, field));
if (!requiresCas) return [msg, null, null];

const hasExpectedUpdatedAt = hasOwn(body, "expectedUpdatedAt");
const hasExpectedRevision = hasOwn(body, "expectedRevision");
if (!hasExpectedUpdatedAt && !hasExpectedRevision) {
  return respond(
    428,
    "GAME_PATCH_PRECONDITION_REQUIRED",
    "Для изменения состава требуется актуальная версия игры",
  );
}

const expectedRaw = body.expectedUpdatedAt;
const expectedUpdatedAt = !hasExpectedUpdatedAt
  ? undefined
  : (expectedRaw === null ? null : toStr(expectedRaw));
if (hasExpectedUpdatedAt && expectedRaw !== null && !expectedUpdatedAt) {
  return respond(400, "GAME_PATCH_PRECONDITION_INVALID", "expectedUpdatedAt имеет неверный формат");
}
const expectedRevisionText = hasExpectedRevision ? String(body.expectedRevision ?? "").trim() : "";
const expectedRevision = hasExpectedRevision && /^\d+$/.test(expectedRevisionText)
  ? Number(expectedRevisionText)
  : undefined;
if (hasExpectedRevision && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
  return respond(400, "GAME_PATCH_PRECONDITION_INVALID", "expectedRevision имеет неверный формат");
}

const gameId = toStr(msg.req?.params?.gameId);
msg._gamePatchCas = {
  required: true,
  gameId,
  expectedUpdatedAt,
  expectedRevision,
};
return [msg, null, null];
