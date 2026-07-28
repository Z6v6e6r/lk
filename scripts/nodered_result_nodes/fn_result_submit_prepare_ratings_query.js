const asArray = (value) => (Array.isArray(value) ? value : []);
const uniq = (value) => Array.from(new Set(asArray(value).filter(Boolean)));

const ctx = msg._resultSubmit || {};
const clientIds = uniq([
  ...asArray(ctx.activeIds),
  ...asArray(ctx.activeMembers).map((member) => member?.id || member?.clientId),
]);
const phones = uniq([
  ...asArray(ctx.activePhones),
  ...asArray(ctx.activeMembers).map((member) => member?.phoneNorm),
]);

msg._resultExistingRows = asArray(msg.payload);
const identityClauses = [];
if (clientIds.length > 0) identityClauses.push({ clientId: { $in: clientIds } });
if (clientIds.length > 0) identityClauses.push({ playerKey: { $in: clientIds.map((id) => `client:${id}`) } });
if (phones.length > 0) identityClauses.push({ phoneNorm: { $in: phones } });
msg.payload = identityClauses.length > 0 ? { $or: identityClauses } : { phoneNorm: { $in: [] } };
return [msg, null, msg];
