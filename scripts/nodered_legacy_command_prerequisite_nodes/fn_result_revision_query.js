const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
const sourceGame = isObject(msg._resultConfirm?.game) ? msg._resultConfirm.game : null;
const tenantKey = String(sourceGame?.tenantKey || "").trim();
const gameId = String(sourceGame?.id || "").trim();
const recoveryRevision = msg._resultConfirmRecovery?.sourceGameRevision;
const sourceRevision = recoveryRevision === undefined ? sourceGame?.revision : recoveryRevision;
if (!tenantKey || !gameId || !Number.isSafeInteger(sourceRevision) || sourceRevision < 1) {
  throw new Error("Result projection requires tenantKey and a positive source game revision");
}
if (recoveryRevision !== undefined && sourceGame?.revision !== recoveryRevision) {
  throw new Error("Result projection recovery requires the exact durable source game revision");
}

const filter = msg.query || msg.mongoQuery || (Array.isArray(msg.payload) ? (msg.payload[0] || {}) : {}) || {};
const update = Array.isArray(msg.payload) ? (msg.payload[1] || {}) : (msg.payload || {});
if (!isObject(filter) || !isObject(update)) throw new Error("Result projection Mongo arguments are invalid");
const setDoc = isObject(update.$set) ? update.$set : null;
const setOnInsertDoc = isObject(update.$setOnInsert) ? update.$setOnInsert : null;
if (setDoc && setOnInsertDoc) {
  for (const key of Object.keys(setOnInsertDoc)) {
    if (Object.prototype.hasOwnProperty.call(setDoc, key)) delete setDoc[key];
  }
}
update.$inc = { ...(isObject(update.$inc) ? update.$inc : {}), revision: 1 };
msg.payload = [
  { ...filter, tenantKey, id: gameId, revision: sourceRevision },
  update,
  { upsert: false, writeConcern: { w: "majority" } },
];
msg._legacyGameRevisionCas = { tenantKey, gameId, sourceRevision, nextRevision: sourceRevision + 1 };
delete msg.query;
delete msg.mongoQuery;
delete msg.mongoUpdate;
return msg;
