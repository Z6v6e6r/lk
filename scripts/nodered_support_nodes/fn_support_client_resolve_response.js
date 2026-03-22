const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toArray = (value) => (Array.isArray(value) ? value : []);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};
const normPhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};

function scoreClient(client, request) {
  const phones = new Set(toArray(client?.phones).map(normPhone).filter(Boolean));
  const emails = new Set(toArray(client?.emails).map((value) => toStr(value)?.toLowerCase()).filter(Boolean));
  const identities = new Set(toArray(client?.identityKeys).map(toStr).filter(Boolean));

  let score = 0;
  request.phones.forEach((phone) => {
    if (phones.has(phone)) score += 10;
  });
  request.emails.forEach((email) => {
    if (emails.has(email)) score += 7;
  });
  request.identityKeys.forEach((identity) => {
    if (identities.has(identity)) score += 5;
  });
  if (toStr(client?.lastChannel) === request.channel) {
    score += 1;
  }
  return score;
}

const request = isObj(msg._supportClientResolve) ? msg._supportClientResolve : { phones: [], emails: [], identityKeys: [], channel: "WEB" };
const rows = toArray(msg.payload).filter((item) => isObj(item));
const ranked = rows
  .map((row) => ({ row, score: scoreClient(row, request) }))
  .sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return Number(right.row?.updatedTs || 0) - Number(left.row?.updatedTs || 0);
  });

const client = ranked[0]?.row || null;

msg.statusCode = 200;
msg.headers = { "Content-Type": "application/json; charset=utf-8" };
msg.payload = {
  ok: true,
  found: Boolean(client),
  client: client || null,
  matchedClientIds: ranked.map((item) => toStr(item.row?.id)).filter(Boolean),
};
return [msg, msg];
