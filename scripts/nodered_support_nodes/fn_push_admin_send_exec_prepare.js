const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};
const toArray = (value) => (Array.isArray(value) ? value : []);
const shellQuote = (value) => `'${String(value || "").replace(/'/g, `'\"'\"'`)}'`;

const ctx = isObj(msg._pushAdminSend) ? msg._pushAdminSend : null;
if (!ctx) {
  msg.statusCode = 500;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Push admin context is missing before exec" };
  return [null, msg];
}

const tokens = toArray(ctx.resolvedTokens).map((token) => toStr(token)).filter(Boolean);
if (tokens.length === 0) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Resolved tokens are empty", requestId: ctx.requestId || null };
  return [null, msg];
}

const scriptPath = toStr(env.get("PUSH_FCM_SEND_SCRIPT")) || "scripts/fcm/send-fcm.mjs";
const serviceAccountPath = toStr(env.get("PUSH_FCM_SERVICE_ACCOUNT_PATH"));
const projectId = toStr(env.get("PUSH_FCM_PROJECT_ID"));
if (!serviceAccountPath) {
  msg.statusCode = 500;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = {
    error: "PUSH_FCM_SERVICE_ACCOUNT_PATH is not configured in Node-RED env",
    requestId: ctx.requestId || null,
  };
  return [null, msg];
}

const baseArgs = [
  `node ${shellQuote(scriptPath)}`,
  `--service-account ${shellQuote(serviceAccountPath)}`,
  projectId ? `--project-id ${shellQuote(projectId)}` : null,
  ctx.title ? `--title ${shellQuote(ctx.title)}` : null,
  ctx.body ? `--body ${shellQuote(ctx.body)}` : null,
  ctx.channelId ? `--android-channel-id ${shellQuote(ctx.channelId)}` : null,
  ctx.dryRun ? "--dry-run" : null,
]
  .filter(Boolean)
  .join(" ");

const dataArgs = isObj(ctx.data)
  ? Object.entries(ctx.data)
      .map(([key, value]) => {
        const safeKey = toStr(key);
        if (!safeKey || value === null || value === undefined) return null;
        return `--data ${shellQuote(`${safeKey}=${String(value)}`)}`;
      })
      .filter(Boolean)
      .join(" ")
  : "";

const command = tokens
  .map((token) => `${baseArgs} --token ${shellQuote(token)}${dataArgs ? ` ${dataArgs}` : ""}`)
  .join(" && ");

msg._pushAdminCommand = {
  requestId: ctx.requestId || null,
  tokens,
  tokensCount: tokens.length,
  dryRun: Boolean(ctx.dryRun),
  channelId: ctx.channelId || null,
  title: ctx.title || null,
  body: ctx.body || null,
};
msg.payload = command;

return [msg, null];
