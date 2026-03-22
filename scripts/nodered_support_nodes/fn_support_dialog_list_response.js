const toArray = (value) => (Array.isArray(value) ? value : []);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};

const rows = toArray(msg.payload)
  .filter((item) => item && typeof item === "object")
  .sort((left, right) => Number(right.lastMessageTs || 0) - Number(left.lastMessageTs || 0));
const ctx = msg._supportDialogList || { limit: 100 };
const sliced = rows.slice(0, ctx.limit);

const dialogs = sliced.map((row) => ({
  id: toStr(row.id),
  clientId: toStr(row.clientId),
  displayName: toStr(row.displayName) || "Клиент",
  primaryPhone: toStr(row.primaryPhone),
  phoneNumbers: toArray(row.phoneNumbers).map((value) => toStr(value)).filter(Boolean),
  stationId: toStr(row.stationId) || "UNASSIGNED",
  stationName: toStr(row.stationName) || "Без станции",
  status: toStr(row.status) || "OPEN",
  authStatus: toStr(row.authStatus) || "PENDING_CONTACT",
  workflowState: toStr(row.workflowState) || "WAIT_CONTACT",
  channels: toArray(row.channels).map((value) => toStr(value)).filter(Boolean),
  unreadClientMessages: Number(row.unreadClientMessages || 0),
  pendingResponseSinceTs: Number(row.pendingResponseSinceTs || 0) || null,
  firstResponseMinutes: Number(row.firstResponseMinutes || 0) || null,
  lastResponseMinutes: Number(row.lastResponseMinutes || 0) || null,
  avgResponseMinutes: Number(row.avgResponseMinutes || 0) || null,
  maxResponseMinutes: Number(row.maxResponseMinutes || 0) || null,
  ai: row.ai || null,
  lastMessage: {
    preview: toStr(row.lastMessagePreview) || "",
    direction: toStr(row.lastMessageDirection) || "INBOUND",
    authorType: toStr(row.lastMessageAuthorType) || "CLIENT",
    channel: toStr(row.lastChannel),
    createdAt: toStr(row.lastMessageAt),
    createdTs: Number(row.lastMessageTs || 0) || null,
  },
  createdAt: toStr(row.createdAt),
  updatedAt: toStr(row.updatedAt),
  updatedTs: Number(row.updatedTs || 0) || null,
}));

msg.statusCode = 200;
msg.headers = { "Content-Type": "application/json; charset=utf-8" };
msg.payload = {
  total: dialogs.length,
  dialogs,
  summary: {
    unanswered: dialogs.filter((dialog) => dialog.unreadClientMessages > 0).length,
    pendingAuth: dialogs.filter((dialog) => dialog.authStatus !== "AUTHORIZED").length,
  },
};
return [msg, msg];
