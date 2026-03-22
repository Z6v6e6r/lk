const toArray = (value) => (Array.isArray(value) ? value : []);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};
const maybeNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const ctx = msg._supportAnalytics || { date: new Date().toISOString().slice(0, 10) };
const rows = toArray(msg.payload).filter((item) => item && typeof item === "object");
const inboundRows = rows.filter((row) => row.direction === "INBOUND" && ["CLIENT", "CALL", "EMAIL", "CRM"].includes(row.authorType));
const outboundRows = rows.filter((row) => row.direction === "OUTBOUND" && row.authorType === "ADMIN");

const byStation = new Map();
const byTopic = new Map();
const byPriority = new Map();
const bySentiment = new Map();
const dialogIds = new Set();
const slowReplies = [];

const ensureStation = (row) => {
  const stationId = toStr(row.stationId) || "UNASSIGNED";
  const key = stationId;
  if (!byStation.has(key)) {
    byStation.set(key, {
      stationId,
      stationName: toStr(row.stationName) || "Без станции",
      incomingCount: 0,
      dialogIds: new Set(),
      firstResponseSum: 0,
      firstResponseCount: 0,
      responseSum: 0,
      responseCount: 0,
      maxResponseMinutes: 0,
    });
  }
  return byStation.get(key);
};

const bump = (map, key) => {
  if (!key) return;
  map.set(key, Number(map.get(key) || 0) + 1);
};

inboundRows.forEach((row) => {
  const station = ensureStation(row);
  station.incomingCount += 1;
  if (row.dialogId) {
    station.dialogIds.add(row.dialogId);
    dialogIds.add(row.dialogId);
  }
  bump(byTopic, toStr(row.ai?.topic) || "general_support");
  bump(byPriority, toStr(row.ai?.priority) || "MEDIUM");
  bump(bySentiment, toStr(row.ai?.sentiment) || "NEUTRAL");
});

outboundRows.forEach((row) => {
  const minutes = maybeNumber(row.responseMetrics?.responseMinutes);
  if (minutes === null || minutes <= 0) return;

  const station = ensureStation(row);
  station.responseSum += minutes;
  station.responseCount += 1;
  station.maxResponseMinutes = Math.max(station.maxResponseMinutes, minutes);
  if (row.responseMetrics?.isFirstResponse) {
    station.firstResponseSum += minutes;
    station.firstResponseCount += 1;
  }
  slowReplies.push({
    dialogId: toStr(row.dialogId),
    stationId: station.stationId,
    stationName: station.stationName,
    responseMinutes: minutes,
    createdAt: toStr(row.createdAt),
    textPreview: toStr(row.textPreview) || "",
  });
});

const stationStats = Array.from(byStation.values())
  .map((station) => ({
    stationId: station.stationId,
    stationName: station.stationName,
    incomingCount: station.incomingCount,
    dialogsCount: station.dialogIds.size,
    avgFirstResponseMinutes: station.firstResponseCount > 0
      ? Math.round((station.firstResponseSum / station.firstResponseCount) * 10) / 10
      : null,
    avgResponseMinutes: station.responseCount > 0
      ? Math.round((station.responseSum / station.responseCount) * 10) / 10
      : null,
    maxResponseMinutes: station.responseCount > 0 ? station.maxResponseMinutes : null,
  }))
  .sort((left, right) => right.incomingCount - left.incomingCount);

const topicStats = Array.from(byTopic.entries())
  .map(([topic, count]) => ({ topic, count }))
  .sort((left, right) => right.count - left.count);
const priorityStats = Array.from(byPriority.entries())
  .map(([priority, count]) => ({ priority, count }))
  .sort((left, right) => right.count - left.count);
const sentimentStats = Array.from(bySentiment.entries())
  .map(([sentiment, count]) => ({ sentiment, count }))
  .sort((left, right) => right.count - left.count);

const overallResponseCount = outboundRows.filter((row) => maybeNumber(row.responseMetrics?.responseMinutes) !== null).length;
const overallResponseSum = outboundRows.reduce((sum, row) => {
  const minutes = maybeNumber(row.responseMetrics?.responseMinutes);
  return minutes !== null ? sum + minutes : sum;
}, 0);
const overallFirstRows = outboundRows.filter((row) => row.responseMetrics?.isFirstResponse);
const overallFirstSum = overallFirstRows.reduce((sum, row) => {
  const minutes = maybeNumber(row.responseMetrics?.responseMinutes);
  return minutes !== null ? sum + minutes : sum;
}, 0);

msg.statusCode = 200;
msg.headers = { "Content-Type": "application/json; charset=utf-8" };
msg.payload = {
  date: ctx.date,
  totals: {
    inboundMessages: inboundRows.length,
    outboundReplies: outboundRows.length,
    dialogs: dialogIds.size,
    avgFirstResponseMinutes: overallFirstRows.length > 0
      ? Math.round((overallFirstSum / overallFirstRows.length) * 10) / 10
      : null,
    avgResponseMinutes: overallResponseCount > 0
      ? Math.round((overallResponseSum / overallResponseCount) * 10) / 10
      : null,
  },
  byStation: stationStats,
  byTopic: topicStats,
  byPriority: priorityStats,
  bySentiment: sentimentStats,
  slowReplies: slowReplies
    .sort((left, right) => right.responseMinutes - left.responseMinutes)
    .slice(0, 20),
};
return [msg, msg];
