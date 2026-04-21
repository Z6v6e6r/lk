const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

const extractDbResult = (payload) => {
  if (Array.isArray(payload) && payload.length > 0) {
    const first = payload[0];
    if (isObj(first)) return first;
  }
  if (isObj(payload)) return payload;
  return null;
};

const dbResult = extractDbResult(msg.payload);
const acknowledged =
  dbResult && Object.prototype.hasOwnProperty.call(dbResult, "acknowledged")
    ? dbResult.acknowledged === true
    : null;

const hasMongoError =
  Boolean(msg.error)
  || (dbResult && (dbResult.error || dbResult.errmsg || dbResult.codeName || dbResult.writeErrors));

if (hasMongoError || acknowledged === false) {
  const rawMessage =
    (typeof msg.error === "string" ? msg.error : null)
    || (isObj(msg.error) ? msg.error.message : null)
    || (dbResult && typeof dbResult.errmsg === "string" ? dbResult.errmsg : null)
    || "Database write failed";

  msg.statusCode = 500;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = {
    error: rawMessage,
    requestMode: msg._requestMode || null,
    requestUrl: msg._requestUrl || null,
    db: dbResult || null,
  };
  return [msg, msg];
}

const responseRecord = isObj(msg._recordForResponse)
  ? Object.assign({}, msg._recordForResponse)
  : null;

if (!responseRecord) {
  msg.statusCode = 500;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = {
    error: "No prepared response record",
    requestMode: msg._requestMode || null,
    requestUrl: msg._requestUrl || null,
  };
  return [msg, msg];
}

responseRecord.db = {
  acknowledged: acknowledged !== null ? acknowledged : true,
  matchedCount: Number(dbResult?.matchedCount || 0),
  modifiedCount: Number(dbResult?.modifiedCount || 0),
  upsertedCount: Number(dbResult?.upsertedCount || 0),
  upsertedId: dbResult?.upsertedId || null,
};

msg.statusCode = Number(msg._httpStatus || 200);
msg.headers = { "Content-Type": "application/json; charset=utf-8" };
msg.payload = responseRecord;
return [msg, msg];
