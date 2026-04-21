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
const normalizeWorkflowState = (authStatus, stationId) => {
  if (authStatus !== "AUTHORIZED") return "WAIT_CONTACT";
  if (!stationId || stationId === "UNASSIGNED") return "WAIT_STATION";
  return "READY";
};
const clone = (value) => JSON.parse(JSON.stringify(value));

function scoreClient(client, event) {
  const phones = new Set(toArray(client?.phones).map(normPhone).filter(Boolean));
  const emails = new Set(toArray(client?.emails).map((value) => toStr(value)?.toLowerCase()).filter(Boolean));
  const identities = new Set(toArray(client?.identityKeys).map(toStr).filter(Boolean));

  let score = 0;
  event.phoneNumbers.forEach((phone) => {
    if (phones.has(phone)) score += 10;
  });
  event.emails.forEach((email) => {
    if (emails.has(email)) score += 7;
  });
  event.identityKeys.forEach((identity) => {
    if (identities.has(identity)) score += 5;
  });
  if (toStr(client?.primaryPhone) && event.primaryPhone && toStr(client.primaryPhone) === event.primaryPhone) {
    score += 3;
  }
  if (toStr(client?.lastChannel) === event.channel) {
    score += 1;
  }
  return score;
}

function mergeChannelTargets(existingTargets, event, nowIso, nowTs) {
  const targets = isObj(existingTargets) ? clone(existingTargets) : {};
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

if (!event) {
  return [null, null, msg];
}

const nowIso = event.createdAt || new Date().toISOString();
const nowTs = Number(event.createdTs || Date.now());
const ranked = rows
  .map((row) => ({ row, score: scoreClient(row, event) }))
  .sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return Number(right.row?.updatedTs || 0) - Number(left.row?.updatedTs || 0);
  });

const best = ranked[0]?.row || null;
const mergeCandidateIds = ranked
  .slice(1)
  .map((item) => toStr(item.row?.id))
  .filter(Boolean);

const clientId = toStr(best?.id) || `cli_${nowTs}_${Math.random().toString(36).slice(2, 8)}`;
const mergedPhones = uniq([
  ...toArray(best?.phones).map(normPhone),
  ...event.phoneNumbers,
]);
const mergedEmails = uniq([
  ...toArray(best?.emails).map((value) => toStr(value)?.toLowerCase()),
  ...event.emails,
]);
const mergedIdentities = uniq([
  ...toArray(best?.identityKeys).map(toStr),
  ...event.identityKeys,
]);
const authStatus =
  best?.authStatus === "AUTHORIZED" || event.authStatus === "AUTHORIZED" || mergedPhones.length > 0
    ? "AUTHORIZED"
    : "PENDING_CONTACT";
const workflowState = normalizeWorkflowState(
  authStatus,
  event.stationId || toStr(best?.lastStationId) || "UNASSIGNED",
);

const clientDoc = {
  id: clientId,
  displayName: event.displayName || toStr(best?.displayName) || "Клиент",
  primaryPhone: event.primaryPhone || toStr(best?.primaryPhone) || mergedPhones[0] || null,
  phones: mergedPhones,
  emails: mergedEmails,
  identityKeys: mergedIdentities,
  authStatus,
  workflowState,
  sourceChannels: uniq([
    ...toArray(best?.sourceChannels).map((value) => toStr(value)?.toUpperCase()),
    event.channel,
  ]),
  sourceConnectors: uniq([
    ...toArray(best?.sourceConnectors).map((value) => toStr(value)?.toUpperCase()),
    event.connector,
  ]),
  channelTargets: mergeChannelTargets(best?.channelTargets, event, nowIso, nowTs),
  lastConnector: event.connector,
  lastChannel: event.channel,
  lastSeenAt: nowIso,
  lastSeenTs: nowTs,
  lastStationId: event.stationId || toStr(best?.lastStationId) || "UNASSIGNED",
  lastStationName: event.stationName || toStr(best?.lastStationName) || "Без станции",
  mergedCandidateIds: uniq([
    ...toArray(best?.mergedCandidateIds).map(toStr),
    ...mergeCandidateIds,
  ]),
  updatedAt: nowIso,
  updatedTs: nowTs,
  archived: false,
};

msg._supportEvent.client = clientDoc;

const setClientDoc = Object.assign({}, clientDoc);
delete setClientDoc.id;

const clientWriteMsg = Object.assign({}, msg, {
  payload: [
    { id: clientId },
    {
      $set: setClientDoc,
      $setOnInsert: {
        createdAt: toStr(best?.createdAt) || nowIso,
        createdTs: Number(best?.createdTs || nowTs),
      },
    },
    { upsert: true },
  ],
});

const dialogQuery = {
  clientId,
  archived: { $ne: true },
  status: { $in: ["OPEN", "PENDING_AUTH"] },
};

if (event.stationId && event.stationId !== "UNASSIGNED") {
  dialogQuery.$or = [
    { stationId: event.stationId },
    { stationId: "UNASSIGNED" },
    { stationId: null },
    { stationId: "" },
  ];
}

const dialogFindMsg = Object.assign({}, msg, {
  payload: dialogQuery,
});

const debugMsg = Object.assign({}, msg, {
  payload: {
    clientId,
    matchedClientIds: ranked.map((item) => toStr(item.row?.id)).filter(Boolean),
    mergeCandidateIds,
    workflowState,
    authStatus,
  },
});

return [clientWriteMsg, dialogFindMsg, debugMsg];
