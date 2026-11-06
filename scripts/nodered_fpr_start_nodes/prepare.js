// Shared by the staff-only read and the FPR branch of tournament creation.
const fail = (statusCode, code, message) => {
  msg.statusCode = statusCode;
  msg.headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
  msg.payload = { error: code, message };
  delete msg._fprStart;
  return [null, null, msg];
};
const body = msg.payload;
const create = msg._fprStartCreate === true;
delete msg._fprStartCreate;
delete msg._fprStart;
if (create && body?.tournamentType !== 'fpr_6x25') return [null, msg, null];
const auth = msg.req?.headers?.authorization || msg.req?.headers?.Authorization;
if (typeof auth !== 'string' || !/^Bearer\s+\S+$/i.test(auth)) return fail(401, 'AUTH_TOKEN_REQUIRED', 'Войдите в личный кабинет');
const roster = body?.params?.fpr6x25?.players;
const ids = create ? (Array.isArray(roster) ? roster.map(p => p?.id) : null) : body?.clientIds;
if (!Array.isArray(ids) || ids.length < 1 || ids.length > 28
  || ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(id))
  || new Set(ids).size !== ids.length) return fail(400, 'FPR_CLIENT_IDS_INVALID', 'Нужны уникальные ID участников, не более 28');
msg._fprStart = { create, ids, body: create ? body : null };
msg.method = 'GET';
msg.url = 'https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile';
msg.headers = { Authorization: auth, Accept: 'application/json' };
msg.payload = undefined;
return [msg, null, null];
