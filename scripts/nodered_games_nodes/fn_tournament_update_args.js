const filter = msg.query || msg.mongoQuery || (Array.isArray(msg.payload) ? (msg.payload[0] || {}) : {}) || {};
const rawUpdate = Array.isArray(msg.payload) ? msg.payload[1] : (msg.mongoUpdate ?? msg.payload);
const update = Array.isArray(rawUpdate)
  ? rawUpdate
  : ((rawUpdate && typeof rawUpdate === "object") ? rawUpdate : {});
const hasFilter = filter && typeof filter === "object" && Object.keys(filter).length > 0;
const hasAtomicOperators = Array.isArray(update)
  ? true
  : Object.keys(update).some((key) => String(key).startsWith("$"));
if (!hasFilter || !hasAtomicOperators) {
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
msg.payload = [filter, update, { upsert: false, maxTimeMS: 5000 }];
delete msg.query;
delete msg.mongoQuery;
delete msg.mongoUpdate;
return msg;
