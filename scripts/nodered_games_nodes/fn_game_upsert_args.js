const filter = msg.query || msg.mongoQuery || (Array.isArray(msg.payload) ? (msg.payload[0] || {}) : {}) || {};
const rawUpdate = Array.isArray(msg.payload) ? (msg.payload[1] || {}) : (msg.payload || {});
const update = Array.isArray(rawUpdate)
  ? rawUpdate
  : ((rawUpdate && typeof rawUpdate === "object") ? rawUpdate : {});
const hasAtomicOperators = Array.isArray(update)
  ? true
  : Object.keys(update).some((key) => String(key).startsWith("$"));
if (!hasAtomicOperators) {
  return null;
}
if (!Array.isArray(update)) {
  const setDoc = update.$set && typeof update.$set === "object" ? update.$set : null;
  const setOnInsertDoc = update.$setOnInsert && typeof update.$setOnInsert === "object" ? update.$setOnInsert : null;
  if (setDoc && setOnInsertDoc) {
    for (const key of Object.keys(setOnInsertDoc)) {
      if (Object.prototype.hasOwnProperty.call(setDoc, key)) {
        delete setDoc[key];
      }
    }
  }
}
const requestMode = String(msg._requestMode || "").trim().toLowerCase();
msg.payload = [filter, update, { upsert: requestMode !== "confirm" }];
delete msg.query;
delete msg.mongoQuery;
delete msg.mongoUpdate;
return msg;
