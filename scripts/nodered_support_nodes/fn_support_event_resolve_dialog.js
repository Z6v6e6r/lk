const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toArray = (value) => (Array.isArray(value) ? value : []);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};
const uniq = (values) => Array.from(new Set(values.filter(Boolean)));
const normPhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
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

function pickDialog(rows, event) {
  const safeRows = toArray(rows).filter((item) => isObj(item));
  if (safeRows.length === 0) return null;

  const exact = safeRows.filter((item) => toStr(item.stationId) === event.stationId);
  if (exact.length > 0) {
    return exact.sort((left, right) => Number(right.updatedTs || 0) - Number(left.updatedTs || 0))[0];
  }

  const unassigned = safeRows.filter((item) => {
    const stationId = toStr(item.stationId);
    return !stationId || stationId === "UNASSIGNED";
  });
  if (unassigned.length > 0) {
    return unassigned.sort((left, right) => Number(right.updatedTs || 0) - Number(left.updatedTs || 0))[0];
  }

  return safeRows.sort((left, right) => Number(right.updatedTs || 0) - Number(left.updatedTs || 0))[0];
}

function mergeChannelTargets(existingTargets, clientTargets, event, nowIso, nowTs) {
  const targets = isObj(existingTargets) ? clone(existingTargets) : {};
  Object.entries(isObj(clientTargets) ? clientTargets : {}).forEach(([key, value]) => {
    targets[key] = Object.assign({}, isObj(targets[key]) ? targets[key] : {}, isObj(value) ? value : {});
  });
  const key = event.channel.toLowerCase();
  const current = isObj(targets[key]) ? targets[key] : {};
  targets[key] = Object.assign({}, current, {
    channel: event.channel,
    channelUserId: event.channelUserId || current.channelUserId || null,
    userId: event.userId || current.userId || null,
    chatId: event.chatId || current.chatId || null,
    externalThreadId: event.externalThreadId || current.externalThreadId || null,
    lastSeenAt: nowIso,
    lastSeenTs: nowTs,
  });
  return targets;
}

const rows = toArray(msg.payload).filter((item) => isObj(item));
const event = isObj(msg._supportEvent) ? msg._supportEvent : null;
const client = isObj(event?.client) ? event.client : null;

if (!event || !client) {
  return [null, null, msg];
}

const nowIso = event.createdAt || new Date().toISOString();
const nowTs = Number(event.createdTs || Date.now());
const existing = pickDialog(rows, event);
const dialogId = toStr(existing?.id) || `dlg_${nowTs}_${Math.random().toString(36).slice(2, 8)}`;
const stationId = event.stationId || toStr(existing?.stationId) || toStr(client.lastStationId) || "UNASSIGNED";
const stationName = event.stationName || toStr(existing?.stationName) || toStr(client.lastStationName) || "Без станции";

const authStatus = client.authStatus === "AUTHORIZED" || event.authStatus === "AUTHORIZED" ? "AUTHORIZED" : "PENDING_CONTACT";
const workflowState =
  authStatus !== "AUTHORIZED"
    ? "WAIT_CONTACT"
    : stationId === "UNASSIGNED"
      ? "WAIT_STATION"
      : "READY";

const isClientInbound =
  event.direction === "INBOUND"
  && ["CLIENT", "CALL", "EMAIL", "CRM"].includes(event.authorType);
const isAdminOutbound =
  event.direction === "OUTBOUND"
  && event.authorType === "ADMIN";
const countsAsSupportRequest =
  isClientInbound
  && ["MESSAGE", "CALL_LOG", "EMAIL", "BITRIX_NOTE"].includes(event.eventType);

const pendingResponseSinceTs = Number(existing?.pendingResponseSinceTs || 0) || null;
const responseMinutes = isAdminOutbound && pendingResponseSinceTs
  ? Math.max(0, Math.round(((nowTs - pendingResponseSinceTs) / 60000) * 10) / 10)
  : null;
const prevResponseCount = maybeNumber(existing?.responseCount) || 0;
const nextResponseCount = prevResponseCount + (responseMinutes !== null ? 1 : 0);
const prevAvgResponse = maybeNumber(existing?.avgResponseMinutes) || 0;
const nextAvgResponse = responseMinutes === null
  ? (Number.isFinite(prevAvgResponse) ? prevAvgResponse : 0)
  : Math.round((((prevAvgResponse * prevResponseCount) + responseMinutes) / nextResponseCount) * 10) / 10;
const prevMaxResponse = maybeNumber(existing?.maxResponseMinutes) || 0;
const nextMaxResponse = responseMinutes === null ? prevMaxResponse : Math.max(prevMaxResponse, responseMinutes);
const prevFirstResponse = maybeNumber(existing?.firstResponseMinutes);
const firstResponseMinutes = prevFirstResponse !== null
  ? prevFirstResponse
  : (responseMinutes !== null ? responseMinutes : null);

const mergedTopicTags = uniq([
  ...toArray(existing?.ai?.topicTags).map(toStr),
  ...toArray(event.ai?.topicTags).map(toStr),
]).slice(0, 20);

const dialogDoc = {
  id: dialogId,
  clientId: client.id,
  displayName: client.displayName,
  primaryPhone: client.primaryPhone || event.primaryPhone || null,
  phoneNumbers: uniq([
    ...toArray(existing?.phoneNumbers).map(normPhone),
    ...toArray(client.phones).map(normPhone),
    ...event.phoneNumbers,
  ]),
  emails: uniq([
    ...toArray(existing?.emails).map((value) => toStr(value)?.toLowerCase()),
    ...toArray(client.emails).map((value) => toStr(value)?.toLowerCase()),
    ...event.emails,
  ]),
  identityKeys: uniq([
    ...toArray(existing?.identityKeys).map(toStr),
    ...toArray(client.identityKeys).map(toStr),
    ...event.identityKeys,
  ]),
  channels: uniq([
    ...toArray(existing?.channels).map((value) => toStr(value)?.toUpperCase()),
    ...toArray(client.sourceChannels).map((value) => toStr(value)?.toUpperCase()),
    event.channel,
  ]),
  channelTargets: mergeChannelTargets(existing?.channelTargets, client.channelTargets, event, nowIso, nowTs),
  authStatus,
  workflowState,
  provisional: authStatus !== "AUTHORIZED",
  status: authStatus !== "AUTHORIZED" ? "PENDING_AUTH" : (toStr(existing?.status) === "CLOSED" ? "OPEN" : (toStr(existing?.status) || "OPEN")),
  stationId,
  stationName,
  unreadClientMessages: countsAsSupportRequest
    ? Number(existing?.unreadClientMessages || 0) + 1
    : (isAdminOutbound ? 0 : Number(existing?.unreadClientMessages || 0)),
  pendingResponseSinceTs: countsAsSupportRequest
    ? (pendingResponseSinceTs || nowTs)
    : (isAdminOutbound ? null : pendingResponseSinceTs),
  pendingResponseAt: countsAsSupportRequest
    ? (toStr(existing?.pendingResponseAt) || nowIso)
    : (isAdminOutbound ? null : toStr(existing?.pendingResponseAt) || null),
  firstResponseMinutes,
  lastResponseMinutes: responseMinutes !== null ? responseMinutes : (maybeNumber(existing?.lastResponseMinutes) ?? null),
  responseCount: nextResponseCount,
  avgResponseMinutes: nextResponseCount > 0 ? nextAvgResponse : null,
  maxResponseMinutes: nextResponseCount > 0 ? nextMaxResponse : null,
  firstClientMessageAt: toStr(existing?.firstClientMessageAt) || (countsAsSupportRequest ? nowIso : null),
  firstClientMessageTs: Number(existing?.firstClientMessageTs || 0) || (countsAsSupportRequest ? nowTs : null),
  lastClientMessageAt: countsAsSupportRequest ? nowIso : (toStr(existing?.lastClientMessageAt) || null),
  lastClientMessageTs: countsAsSupportRequest ? nowTs : (Number(existing?.lastClientMessageTs || 0) || null),
  lastAdminMessageAt: isAdminOutbound ? nowIso : (toStr(existing?.lastAdminMessageAt) || null),
  lastAdminMessageTs: isAdminOutbound ? nowTs : (Number(existing?.lastAdminMessageTs || 0) || null),
  lastMessagePreview: previewText(event.text),
  lastMessageAt: nowIso,
  lastMessageTs: nowTs,
  lastMessageDirection: event.direction,
  lastMessageAuthorType: event.authorType,
  lastChannel: event.channel,
  lastInboundChannel: isClientInbound ? event.channel : (toStr(existing?.lastInboundChannel) || null),
  lastOutboundChannel: isAdminOutbound ? event.channel : (toStr(existing?.lastOutboundChannel) || null),
  ai: {
    lastTopic: toStr(event.ai?.topic) || toStr(existing?.ai?.lastTopic) || "general_support",
    lastSentiment: toStr(event.ai?.sentiment) || toStr(existing?.ai?.lastSentiment) || "NEUTRAL",
    lastPriority: toStr(event.ai?.priority) || toStr(existing?.ai?.lastPriority) || "MEDIUM",
    topicTags: mergedTopicTags,
    needsAttention:
      typeof event.ai?.needsAttention === "boolean"
        ? event.ai.needsAttention
        : Boolean(existing?.ai?.needsAttention),
  },
  createdAt: toStr(existing?.createdAt) || nowIso,
  createdTs: Number(existing?.createdTs || 0) || nowTs,
  openedAt: toStr(existing?.openedAt) || nowIso,
  openedTs: Number(existing?.openedTs || 0) || nowTs,
  updatedAt: nowIso,
  updatedTs: nowTs,
  archived: false,
};

const messageDoc = {
  id: `${dialogId}:${nowTs}:${Math.random().toString(36).slice(2, 8)}`,
  dialogId,
  clientId: client.id,
  stationId,
  stationName,
  direction: event.direction,
  authorType: event.authorType,
  eventType: event.eventType,
  channel: event.channel,
  externalMessageId: event.externalMessageId || null,
  externalThreadId: event.externalThreadId || null,
  callId: event.callId || null,
  chatId: event.chatId || null,
  channelUserId: event.channelUserId || null,
  sender: {
    id: event.senderId || null,
    name: event.senderName || client.displayName || "Клиент",
    role: event.authorType,
  },
  clientSnapshot: {
    displayName: client.displayName,
    primaryPhone: client.primaryPhone || null,
    phones: toArray(client.phones).map(normPhone).filter(Boolean),
    emails: toArray(client.emails).map((value) => toStr(value)?.toLowerCase()).filter(Boolean),
    authStatus,
    workflowState,
  },
  text: event.text || "",
  textPreview: previewText(event.text),
  attachments: toArray(event.attachments),
  tags: uniq([
    ...toArray(event.tags).map(toStr),
    ...toArray(event.ai?.topicTags).map(toStr),
  ]).slice(0, 20),
  ai: isObj(event.ai) ? clone(event.ai) : null,
  responseMetrics: responseMinutes === null
    ? null
    : {
        pendingRequestTs: pendingResponseSinceTs,
        responseMinutes,
        isFirstResponse: !Number.isFinite(prevFirstResponse),
      },
  authStatus,
  workflowState,
  createdAt: nowIso,
  createdTs: nowTs,
  deleted: false,
  metadata: isObj(event.metadata) ? clone(event.metadata) : {},
};

msg._supportEvent.dialog = dialogDoc;
msg._supportEvent.message = messageDoc;

const setDialogDoc = Object.assign({}, dialogDoc);
delete setDialogDoc.createdAt;
delete setDialogDoc.createdTs;
delete setDialogDoc.openedAt;
delete setDialogDoc.openedTs;

const dialogWriteMsg = Object.assign({}, msg, {
  payload: [
    { id: dialogId },
    {
      $set: setDialogDoc,
      $setOnInsert: {
        id: dialogId,
        createdAt: dialogDoc.createdAt,
        createdTs: dialogDoc.createdTs,
        openedAt: dialogDoc.openedAt,
        openedTs: dialogDoc.openedTs,
      },
    },
    { upsert: true },
  ],
});

const messageInsertMsg = Object.assign({}, msg, {
  payload: messageDoc,
});

const debugMsg = Object.assign({}, msg, {
  payload: {
    dialogId,
    stationId,
    authStatus,
    workflowState,
    unreadClientMessages: dialogDoc.unreadClientMessages,
    responseMinutes,
  },
});

return [dialogWriteMsg, messageInsertMsg, debugMsg];
