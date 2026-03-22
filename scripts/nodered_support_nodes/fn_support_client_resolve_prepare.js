const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
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

const q = isObj(msg.req?.query) ? msg.req.query : {};
const channel = toStr(q.channel || q.provider || "WEB")?.toUpperCase() || "WEB";
const phones = uniq([
  normPhone(q.phone),
  ...String(q.phoneNumbers || "")
    .split(",")
    .map((value) => normPhone(value)),
]);
const emails = uniq([
  normEmail(q.email),
  ...String(q.emails || "")
    .split(",")
    .map((value) => normEmail(value)),
]);
const identityKeys = uniq([
  toStr(q.identityKey),
  toStr(q.channelUserId) ? `${channel.toLowerCase()}:user:${toStr(q.channelUserId)}` : null,
  toStr(q.userId) ? `${channel.toLowerCase()}:user:${toStr(q.userId)}` : null,
  toStr(q.chatId) ? `${channel.toLowerCase()}:chat:${toStr(q.chatId)}` : null,
  toStr(q.externalThreadId) ? `${channel.toLowerCase()}:thread:${toStr(q.externalThreadId)}` : null,
  ...phones.map((phone) => `phone:${phone}`),
  ...emails.map((email) => `email:${email}`),
]);

if (phones.length === 0 && emails.length === 0 && identityKeys.length === 0) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Provide phone, email or channel identity" };
  return [null, msg, msg];
}

msg._supportClientResolve = {
  phones,
  emails,
  identityKeys,
  channel,
};
msg.payload = {
  $or: [
    phones.length > 0 ? { phones: { $in: phones } } : null,
    emails.length > 0 ? { emails: { $in: emails } } : null,
    identityKeys.length > 0 ? { identityKeys: { $in: identityKeys } } : null,
  ].filter(Boolean),
};

return [msg, null, msg];
