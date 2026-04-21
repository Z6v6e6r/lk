const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toArray = (value) => (Array.isArray(value) ? value : []);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};
const previewText = (value, max = 240) => {
  const text = toStr(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}...` : text;
};
const clone = (value) => JSON.parse(JSON.stringify(value));
const maybeNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const rows = toArray(msg.payload).filter((item) => isObj(item));
const reply = isObj(msg._supportReply) ? msg._supportReply : null;

if (!reply) {
  return [null, null, null, msg];
}

if (rows.length === 0) {
  msg.statusCode = 404;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Dialog not found" };
  return [null, null, null, msg];
}

const dialog = rows[0];
const now = new Date();
const nowIso = now.toISOString();
const nowTs = now.getTime();
const channel = reply.channel || toStr(dialog.lastInboundChannel) || toStr(dialog.lastChannel) || "MAX";
const connector = toStr(reply.connector) || toStr(dialog.lastConnector) || (channel === "WEB" ? "WEB_LK" : channel);
const target = isObj(dialog.channelTargets?.[channel.toLowerCase()]) ? clone(dialog.channelTargets[channel.toLowerCase()]) : null;
const pendingResponseSinceTs = Number(dialog.pendingResponseSinceTs || 0) || null;
const responseMinutes = pendingResponseSinceTs
  ? Math.max(0, Math.round(((nowTs - pendingResponseSinceTs) / 60000) * 10) / 10)
  : null;
const prevResponseCount = maybeNumber(dialog.responseCount) || 0;
const nextResponseCount = prevResponseCount + (responseMinutes !== null ? 1 : 0);
const prevAvgResponse = maybeNumber(dialog.avgResponseMinutes) || 0;
const nextAvgResponse = responseMinutes === null
  ? (Number.isFinite(prevAvgResponse) ? prevAvgResponse : 0)
  : Math.round((((prevAvgResponse * prevResponseCount) + responseMinutes) / nextResponseCount) * 10) / 10;
const prevFirstResponse = maybeNumber(dialog.firstResponseMinutes);
const firstResponseMinutes = prevFirstResponse !== null
  ? prevFirstResponse
  : (responseMinutes !== null ? responseMinutes : null);
const prevMaxResponse = maybeNumber(dialog.maxResponseMinutes) || 0;
const nextMaxResponse = responseMinutes === null ? prevMaxResponse : Math.max(prevMaxResponse, responseMinutes);

const delivery = {
  status: target ? "READY" : "NO_TARGET",
  channel,
  target,
  payload: target
    ? {
        chatId: target.chatId || null,
        content: reply.text,
        type: "message",
        options: {},
      }
    : null,
};

const messageDoc = {
  id: `${reply.dialogId}:${nowTs}:${Math.random().toString(36).slice(2, 8)}`,
  dialogId: reply.dialogId,
  clientId: toStr(dialog.clientId),
  stationId: toStr(dialog.stationId) || "UNASSIGNED",
  stationName: toStr(dialog.stationName) || "Без станции",
  direction: "OUTBOUND",
  authorType: "ADMIN",
  eventType: "ADMIN_REPLY",
  connector,
  channel,
  sender: {
    id: reply.adminUserId || null,
    name: reply.adminName || "Администратор",
    role: "ADMIN",
  },
  text: reply.text,
  textPreview: previewText(reply.text),
  attachments: [],
  tags: [],
  ai: null,
  responseMetrics: responseMinutes === null
    ? null
    : {
        pendingRequestTs: pendingResponseSinceTs,
        responseMinutes,
        isFirstResponse: !Number.isFinite(prevFirstResponse),
      },
  authStatus: toStr(dialog.authStatus) || "AUTHORIZED",
  workflowState: toStr(dialog.workflowState) || "READY",
  createdAt: nowIso,
  createdTs: nowTs,
  deleted: false,
  metadata: Object.assign({}, reply.metadata || {}, {
    replyChannel: channel,
  }),
  delivery,
};

msg._supportReplyResolved = {
  dialog: Object.assign({}, dialog, {
    unreadClientMessages: 0,
    pendingResponseSinceTs: null,
    pendingResponseAt: null,
    firstResponseMinutes,
    lastResponseMinutes: responseMinutes === null ? (maybeNumber(dialog.lastResponseMinutes) ?? null) : responseMinutes,
    responseCount: nextResponseCount,
    avgResponseMinutes: nextResponseCount > 0 ? nextAvgResponse : null,
    maxResponseMinutes: nextResponseCount > 0 ? nextMaxResponse : null,
    lastAdminMessageAt: nowIso,
    lastAdminMessageTs: nowTs,
    lastMessagePreview: previewText(reply.text),
    lastMessageAt: nowIso,
    lastMessageTs: nowTs,
    lastMessageDirection: "OUTBOUND",
    lastMessageAuthorType: "ADMIN",
    lastConnector: connector,
    lastChannel: channel,
    lastOutboundChannel: channel,
    updatedAt: nowIso,
    updatedTs: nowTs,
  }),
  message: messageDoc,
  dispatch: delivery,
};

const setDialogDoc = Object.assign({}, msg._supportReplyResolved.dialog);
delete setDialogDoc.id;
delete setDialogDoc.createdAt;
delete setDialogDoc.createdTs;
delete setDialogDoc.openedAt;
delete setDialogDoc.openedTs;

const dialogWriteMsg = Object.assign({}, msg, {
  payload: [
    { id: reply.dialogId },
    { $set: setDialogDoc },
    { upsert: false },
  ],
});

const messageInsertMsg = Object.assign({}, msg, {
  payload: messageDoc,
});

const dispatchMsg = target
  ? Object.assign({}, msg, {
      payload: delivery,
    })
  : null;

return [dialogWriteMsg, messageInsertMsg, dispatchMsg, null];
