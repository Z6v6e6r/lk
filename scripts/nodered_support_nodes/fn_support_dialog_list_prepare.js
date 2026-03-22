const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};
const toBool = (value) => {
  if (typeof value === "boolean") return value;
  const normalized = toStr(value)?.toLowerCase();
  if (!normalized) return false;
  return ["1", "true", "yes", "y", "on"].includes(normalized);
};
const uniq = (values) => Array.from(new Set(values.filter(Boolean)));
const normPhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};
const splitCsv = (value) =>
  uniq(
    String(value || "")
      .split(",")
      .map((item) => toStr(item))
      .filter(Boolean),
  );
const escapeRegex = (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const q = isObj(msg.req?.query) ? msg.req.query : {};
const stationIds = splitCsv(q.stationIds || q.stationId);
const statuses = splitCsv(q.status || q.statuses).map((value) => value.toUpperCase());
const phone = normPhone(q.phone || q.phoneNumber || q.clientPhone);
const channel = toStr(q.channel)?.toUpperCase() || null;
const limitRaw = Number(q.limit);
const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(300, Math.floor(limitRaw))) : 100;
const onlyUnanswered = toBool(q.onlyUnanswered || q.unansweredOnly || q.unanswered);
const includeClosed = toBool(q.includeClosed);
const search = toStr(q.q || q.search);

const query = {
  archived: { $ne: true },
};

if (stationIds.length > 0) {
  query.stationId = { $in: stationIds };
}
if (statuses.length > 0) {
  query.status = { $in: statuses };
} else if (!includeClosed) {
  query.status = { $in: ["OPEN", "PENDING_AUTH"] };
}
if (phone) {
  query.phoneNumbers = { $in: [phone] };
}
if (channel) {
  query.channels = { $in: [channel] };
}
if (onlyUnanswered) {
  query.unreadClientMessages = { $gt: 0 };
}
if (search) {
  const pattern = escapeRegex(search);
  query.$or = [
    { displayName: { $regex: pattern, $options: "i" } },
    { primaryPhone: { $regex: pattern, $options: "i" } },
    { lastMessagePreview: { $regex: pattern, $options: "i" } },
  ];
}

msg._supportDialogList = {
  limit,
  stationIds,
  statuses,
  phone,
  channel,
  onlyUnanswered,
  includeClosed,
  search,
};
msg.payload = query;
return [msg, null, msg];
