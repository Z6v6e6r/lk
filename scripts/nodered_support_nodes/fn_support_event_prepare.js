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
const normEmail = (value) => {
  const email = toStr(value)?.toLowerCase();
  return email && email.includes("@") ? email : null;
};
const clampTags = (values) => uniq(values).slice(0, 12);
const normalizeStationId = (value) => {
  const stationId = toStr(value);
  return stationId ? stationId : "UNASSIGNED";
};
const normalizeStationName = (value, fallbackId) => {
  const stationName = toStr(value);
  if (stationName) return stationName;
  return fallbackId && fallbackId !== "UNASSIGNED" ? fallbackId : "Без станции";
};
const normalizeDirection = (value) => {
  const normalized = toStr(value)?.toUpperCase();
  if (normalized === "OUTBOUND" || normalized === "SYSTEM") return normalized;
  return "INBOUND";
};
const normalizeAuthorType = (value, direction) => {
  const normalized = toStr(value)?.toUpperCase();
  if (normalized) return normalized;
  if (direction === "OUTBOUND") return "ADMIN";
  if (direction === "SYSTEM") return "SYSTEM";
  return "CLIENT";
};
const normalizeEventType = (value) => {
  const normalized = toStr(value)?.toUpperCase();
  if (!normalized) return "MESSAGE";
  return normalized;
};
const normalizeChannel = (value) => {
  const normalized = toStr(value)?.toUpperCase();
  return normalized || "WEB";
};
const normalizeConnector = (value, channel) => {
  const normalized = toStr(value)?.toUpperCase();
  if (normalized) return normalized;
  if (channel === "WEB") return "WEB_LK";
  return channel;
};
const normalizePriority = (value) => {
  const normalized = toStr(value)?.toUpperCase();
  if (["CRITICAL", "IMPORTANT", "MEDIUM", "SUGGESTION"].includes(normalized)) {
    return normalized;
  }
  return null;
};
const normalizeSentiment = (value) => {
  const normalized = toStr(value)?.toUpperCase();
  if (["NEGATIVE", "NEUTRAL", "POSITIVE"].includes(normalized)) {
    return normalized;
  }
  return null;
};
const normalizeAuthStatus = (value, hasPhones) => {
  const normalized = toStr(value)?.toUpperCase();
  if (normalized === "AUTHORIZED" || normalized === "PENDING_CONTACT") {
    return normalized;
  }
  return hasPhones ? "AUTHORIZED" : "PENDING_CONTACT";
};
const normalizeWorkflowState = (value, authStatus, stationId) => {
  const normalized = toStr(value)?.toUpperCase();
  if (["WAIT_CONTACT", "WAIT_STATION", "READY"].includes(normalized)) {
    return normalized;
  }
  if (authStatus !== "AUTHORIZED") return "WAIT_CONTACT";
  if (!stationId || stationId === "UNASSIGNED") return "WAIT_STATION";
  return "READY";
};
const previewText = (value, max = 240) => {
  const text = toStr(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}...` : text;
};
const escapeRegex = (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function collectPhones(body) {
  const fromContacts = toArray(body.contacts)
    .flatMap((item) => {
      if (typeof item === "string") return [item];
      if (!isObj(item)) return [];
      return [
        item.phone,
        item.phoneNumber,
        item.msisdn,
        item.mobile,
      ];
    });

  return uniq([
    normPhone(body.phone),
    normPhone(body.phoneNumber),
    normPhone(body.mobile),
    normPhone(body.clientPhone),
    normPhone(body.primaryPhone),
    ...toArray(body.phoneNumbers).map(normPhone),
    ...toArray(body.phones).map(normPhone),
    ...fromContacts.map(normPhone),
  ]);
}

function collectEmails(body) {
  return uniq([
    normEmail(body.email),
    normEmail(body.clientEmail),
    ...toArray(body.emails).map(normEmail),
  ]);
}

function buildIdentityKeys(channel, body, phones, emails) {
  const channelKey = channel.toLowerCase();
  return uniq([
    ...phones.map((phone) => `phone:${phone}`),
    ...emails.map((email) => `email:${email}`),
    toStr(body.identityKey),
    toStr(body.channelUserId) ? `${channelKey}:user:${toStr(body.channelUserId)}` : null,
    toStr(body.userId) ? `${channelKey}:user:${toStr(body.userId)}` : null,
    toStr(body.chatId) ? `${channelKey}:chat:${toStr(body.chatId)}` : null,
    toStr(body.externalThreadId) ? `${channelKey}:thread:${toStr(body.externalThreadId)}` : null,
    toStr(body.externalDialogId) ? `${channelKey}:dialog:${toStr(body.externalDialogId)}` : null,
    toStr(body.callId) ? `call:${toStr(body.callId)}` : null,
  ]);
}

function classifyText(text, eventType) {
  const safeText = toStr(text) || "";
  const lower = safeText.toLowerCase();

  const topicTags = [];
  let topic = "general_support";
  let priority = "MEDIUM";
  let sentiment = "NEUTRAL";

  const addTag = (tag) => {
    if (tag) topicTags.push(tag);
  };

  if (/брон|корт|запис|слот|расписан|игр|трениров/.test(lower)) {
    topic = "booking";
    addTag("booking");
  }
  if (/оплат|чек|возврат|деньг|списал|касс|invoice|платеж/.test(lower)) {
    topic = "payment";
    addTag("payment");
  }
  if (/жалоб|плох|ужас|не устраивает|хам|груб|сервис/.test(lower)) {
    topic = "complaint";
    addTag("complaint");
  }
  if (/турнир|соревнован|americano|лиги/.test(lower)) {
    topic = "tournament";
    addTag("tournament");
  }
  if (/ракетк|инвентар|мяч/.test(lower)) {
    topic = "equipment";
    addTag("equipment");
  }
  if (/тренер|занят|урок|индивидуальн|группов/.test(lower)) {
    topic = "training";
    addTag("training");
  }
  if (/станц|адрес|как добрат|маршрут|локац/.test(lower)) {
    topic = "station";
    addTag("station");
  }
  if (/звон|перезвон|связ|администратор|поддержк/.test(lower)) {
    addTag("operator");
  }
  if (/предлож|пожелан|идея|было бы круто|рекомен/.test(lower)) {
    topic = "suggestion";
    addTag("suggestion");
    priority = "SUGGESTION";
  }

  if (/сроч|немедлен|экстрен|опас|травм|мошенн|верните деньги|не работает оплата/.test(lower)) {
    priority = "CRITICAL";
  } else if (priority !== "SUGGESTION" && /не могу|ошибк|проблем|не работает|не приш|жалоб|плох|отмен|перенос/.test(lower)) {
    priority = "IMPORTANT";
  }

  if (/ужас|отврат|кошмар|жалоб|разочар|не доволен|не работает|ошибк|верните|плохо/.test(lower)) {
    sentiment = "NEGATIVE";
  } else if (/спасибо|супер|класс|отлично|люблю|огонь/.test(lower)) {
    sentiment = "POSITIVE";
  }

  if (eventType === "CALL_LOG") {
    addTag("call");
  }
  if (eventType === "CONTACT_SHARED") {
    addTag("contact_shared");
  }
  if (eventType === "STATION_SELECTED") {
    addTag("station_selected");
  }

  return {
    topic,
    topicTags: clampTags(topicTags.length > 0 ? topicTags : [topic]),
    priority,
    sentiment,
    confidence: safeText ? 0.62 : 0.4,
    source: "heuristic",
    needsAttention: priority === "CRITICAL" || priority === "IMPORTANT" || sentiment === "NEGATIVE",
  };
}

const body = isObj(msg.payload) ? msg.payload : {};
const now = new Date();
const nowIso = now.toISOString();
const nowTs = now.getTime();

const channel = normalizeChannel(body.channel || body.provider || body.sourceChannel);
const connector = normalizeConnector(body.connector || body.sourceConnector, channel);
const direction = normalizeDirection(body.direction);
const authorType = normalizeAuthorType(body.authorType, direction);
const eventType = normalizeEventType(body.eventType);

const phoneNumbers = collectPhones(body);
const emails = collectEmails(body);
const identityKeys = buildIdentityKeys(channel, body, phoneNumbers, emails);

if (identityKeys.length === 0) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "At least one phone, email or channel identity is required" };
  return [null, msg, msg];
}

const stationId = normalizeStationId(body.stationId || body.currentStationId || body.routeStationId);
const stationName = normalizeStationName(body.stationName || body.currentStationName, stationId);
const primaryPhone = phoneNumbers[0] || null;
const displayName =
  toStr(body.displayName)
  || toStr(body.senderName)
  || toStr(body.authorName)
  || toStr(body.clientName)
  || (primaryPhone ? `Клиент ${primaryPhone}` : "Клиент");
const authStatus = normalizeAuthStatus(body.authStatus, phoneNumbers.length > 0);
const workflowState = normalizeWorkflowState(body.workflowState, authStatus, stationId);

const rawAi = isObj(body.ai) ? body.ai : {};
const fallbackAi = classifyText(body.text || body.message || body.content, eventType);
const ai = {
  topic: toStr(rawAi.topic) || fallbackAi.topic,
  topicTags: clampTags([
    ...toArray(rawAi.topicTags).map((value) => toStr(value)),
    ...fallbackAi.topicTags,
  ]),
  sentiment: normalizeSentiment(rawAi.sentiment) || fallbackAi.sentiment,
  priority: normalizePriority(rawAi.priority) || fallbackAi.priority,
  confidence: Number.isFinite(Number(rawAi.confidence)) ? Number(rawAi.confidence) : fallbackAi.confidence,
  source: toStr(rawAi.source) || fallbackAi.source,
  needsAttention:
    typeof rawAi.needsAttention === "boolean"
      ? rawAi.needsAttention
      : fallbackAi.needsAttention,
};

const text =
  toStr(body.text)
  || toStr(body.message)
  || toStr(body.content)
  || (
    eventType === "CONTACT_SHARED"
      ? "Клиент поделился контактом"
      : eventType === "STATION_SELECTED"
        ? `Клиент выбрал станцию: ${stationName}`
        : eventType === "START"
          ? "Клиент запустил диалог"
          : null
  );

const supportEvent = {
  eventId: toStr(body.eventId) || `${channel}:${nowTs}:${Math.random().toString(36).slice(2, 10)}`,
  connector,
  channel,
  direction,
  authorType,
  eventType,
  text,
  textPreview: previewText(text),
  displayName,
  primaryPhone,
  phoneNumbers,
  emails,
  identityKeys,
  authStatus,
  workflowState,
  stationId,
  stationName,
  channelUserId: toStr(body.channelUserId || body.userId || body.senderId),
  userId: toStr(body.userId || body.clientId || body.senderId),
  chatId: toStr(body.chatId || body.threadId || body.conversationId),
  externalMessageId: toStr(body.externalMessageId || body.messageId),
  externalThreadId: toStr(body.externalThreadId || body.threadId || body.dialogId),
  callId: toStr(body.callId),
  senderName: toStr(body.senderName || body.authorName || displayName),
  senderId: toStr(body.senderId || body.userId || body.clientId),
  attachments: toArray(body.attachments).filter((item) => item !== null && item !== undefined),
  tags: clampTags([
    ...toArray(body.tags).map((value) => toStr(value)),
    ...ai.topicTags,
  ]),
  ai,
  metadata: Object.assign({}, isObj(body.metadata) ? body.metadata : {}, {
    sourcePayloadType: typeof msg.payload,
    sourceConnector: connector,
    requestPath: toStr(msg.req?.path || msg.req?.originalUrl || msg.req?.url),
  }),
  createdAt: nowIso,
  createdTs: nowTs,
};

const dedupeWindowMs = 2500;
const externalMessageId = toStr(supportEvent.externalMessageId);
const dedupeIdentity =
  toStr(supportEvent.channelUserId)
  || toStr(supportEvent.userId)
  || toStr(supportEvent.senderId)
  || toStr(supportEvent.primaryPhone)
  || "anonymous";
const dedupeText = toStr(supportEvent.text) || "";
const dedupeKey = externalMessageId
  ? `${supportEvent.connector}|${supportEvent.channel}|ext:${externalMessageId}`
  : `${supportEvent.connector}|${supportEvent.channel}|${dedupeIdentity}|${supportEvent.stationId}|${supportEvent.eventType}|${dedupeText.toLowerCase()}`;
const dedupeCache = isObj(context.get("supportEventDedupeCache"))
  ? context.get("supportEventDedupeCache")
  : {};

Object.keys(dedupeCache).forEach((key) => {
  const ts = Number(dedupeCache[key] || 0);
  if (!Number.isFinite(ts) || nowTs - ts > dedupeWindowMs) {
    delete dedupeCache[key];
  }
});

const prevTs = Number(dedupeCache[dedupeKey] || 0);
if (Number.isFinite(prevTs) && prevTs > 0 && nowTs - prevTs < dedupeWindowMs) {
  dedupeCache[dedupeKey] = nowTs;
  context.set("supportEventDedupeCache", dedupeCache);
  msg.statusCode = 202;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = {
    ok: true,
    ignored: true,
    reason: "duplicate_event_window",
    dedupeWindowMs,
  };
  return [null, msg, msg];
}

dedupeCache[dedupeKey] = nowTs;
context.set("supportEventDedupeCache", dedupeCache);

msg._supportEvent = supportEvent;
msg.payload = {
  $or: [
    supportEvent.phoneNumbers.length > 0 ? { phones: { $in: supportEvent.phoneNumbers } } : null,
    supportEvent.emails.length > 0 ? { emails: { $in: supportEvent.emails } } : null,
    supportEvent.identityKeys.length > 0 ? { identityKeys: { $in: supportEvent.identityKeys } } : null,
  ].filter(Boolean),
};

if (!Array.isArray(msg.payload.$or) || msg.payload.$or.length === 0) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Unable to build client lookup query" };
  return [null, msg, msg];
}

msg._supportSearch = {
  preview: supportEvent.textPreview,
  searchRegex: escapeRegex(supportEvent.textPreview),
};

return [msg, null, msg];
