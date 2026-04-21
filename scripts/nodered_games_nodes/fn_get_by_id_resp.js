const rows = Array.isArray(msg.payload) ? msg.payload : [];
if (rows.length === 0) {
  msg.statusCode = 404;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Game not found" };
  return [msg, msg];
}

const toTs = (item) => {
  const updatedTs = Date.parse(item?.updatedAt || "");
  if (Number.isFinite(updatedTs)) return updatedTs;
  const createdTs = Date.parse(item?.createdAt || "");
  if (Number.isFinite(createdTs)) return createdTs;
  return 0;
};

const selected = [...rows].sort((a, b) => toTs(b) - toTs(a))[0];

msg.statusCode = 200;
msg.headers = { "Content-Type": "application/json; charset=utf-8" };
msg.payload = selected;
return [msg, msg];
