const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toNum = (value, fallback = NaN) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const resolveRc = (msgValue, payloadValue) => {
  const direct = toNum(msgValue?.rc?.code);
  if (Number.isFinite(direct)) return direct;
  const payloadCode = toNum(payloadValue?.code);
  if (Number.isFinite(payloadCode)) return payloadCode;
  const payloadDirect = toNum(payloadValue);
  if (Number.isFinite(payloadDirect)) return payloadDirect;
  return -1;
};

const ctx = isObj(msg._pushAdminCommand) ? msg._pushAdminCommand : {};
const payload = msg.payload;

const rc = resolveRc(msg, payload);

if (rc === 0) {
  msg.statusCode = 200;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = {
    ok: true,
    requestId: ctx.requestId || null,
    sent: ctx.tokensCount || 0,
    tokens: Array.isArray(ctx.tokens) ? ctx.tokens : [],
    dryRun: Boolean(ctx.dryRun),
    channelId: ctx.channelId || null,
    title: ctx.title || null,
    body: ctx.body || null,
  };
  return [msg, msg];
}

msg.statusCode = 502;
msg.headers = { "Content-Type": "application/json; charset=utf-8" };
msg.payload = {
  error: "FCM dispatch command failed",
  requestId: ctx.requestId || null,
  rc,
};
return [msg, msg];
