const accessFieldId = 'e17a32f3-65f7-47c5-bda1-33d79932c884';
const hostingRole = 'проводит турниры';
const profile = msg.payload;
const actorId = profile?.id || profile?.clientId || profile?.uuid;
const claimedActorId = msg.ratingAudit?.changedBy?.id;
const fields = Array.isArray(profile?.customFields)
  ? profile.customFields.filter(field => field?.id === accessFieldId) : [];
const access = fields.length === 1 ? fields[0] : null;
const role = Array.isArray(access?.value) ? access.value[0] : null;
const options = Array.isArray(access?.attributes?.options) ? access.attributes.options : [];
const canHost = role === hostingRole || (typeof role === 'string'
  && options.some(option => option?.id === role && String(option.name || '').trim().toLowerCase() === hostingRole));
const authorized = msg._tournamentLevelPut && !msg.error && msg.statusCode === 200
  && typeof actorId === 'string' && actorId.trim() !== '' && canHost
  && (!claimedActorId || claimedActorId === actorId);
if (!authorized) return [msg, null];

msg._tournamentLevelReadbackAuthorized = true;
msg.url = `https://api.vivacrm.ru/api/v1/clients/${encodeURIComponent(msg.clientId)}`;
msg.headers = { Authorization: `Bearer ${msg.token}`, Accept: 'application/json' };
msg.requestTimeout = 5000;
delete msg.payload;
delete msg.token;
return [null, msg];
