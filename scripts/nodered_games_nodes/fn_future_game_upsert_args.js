const filter = msg.query || msg.mongoQuery || (Array.isArray(msg.payload) ? (msg.payload[0] || {}) : {}) || {};
const rawUpdate = Array.isArray(msg.payload) ? (msg.payload[1] || {}) : (msg.payload || {});
const update = Array.isArray(rawUpdate)
  ? rawUpdate
  : ((rawUpdate && typeof rawUpdate === "object") ? rawUpdate : {});
const hasAtomicOperators = Array.isArray(update)
  ? true
  : Object.keys(update).some((key) => String(key).startsWith("$"));
const ctx = msg._futureGameWrite && typeof msg._futureGameWrite === "object"
  ? msg._futureGameWrite
  : null;
if (!hasAtomicOperators || !ctx || typeof ctx.upsert !== "boolean" || ctx.step !== "write_ack") {
  return null;
}
if (!Array.isArray(update)) {
  const setDoc = update.$set && typeof update.$set === "object" ? update.$set : null;
  const setOnInsertDoc = update.$setOnInsert && typeof update.$setOnInsert === "object" ? update.$setOnInsert : null;
  if (setDoc && setOnInsertDoc) {
    for (const key of Object.keys(setOnInsertDoc)) {
      if (Object.prototype.hasOwnProperty.call(setDoc, key)) delete setOnInsertDoc[key];
    }
  }
}
msg.payload = [filter, update, {
  upsert: ctx.upsert,
  writeConcern: { w: "majority", j: true },
  maxTimeMS: 5000,
}];
delete msg.query;
delete msg.mongoQuery;
delete msg.mongoUpdate;
return msg;
