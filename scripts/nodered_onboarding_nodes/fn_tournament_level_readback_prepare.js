const numericFieldId = 'eabfe27b-3f72-4496-9185-1a2ec6e6465e';
const result = msg.payload;
const requested = result?.requestedValue;
const bearer = msg.req?.headers?.authorization || msg.req?.headers?.Authorization;
const canReadBack = msg.source === 'tournament_start' && !msg.error
  && result?.ok === false && result.httpStatus === 200 && result.response === ''
  && result.fieldId === numericFieldId
  && Array.isArray(requested) && requested.length === 1
  && typeof requested[0] === 'string' && /^\d+\.\d{5}$/.test(requested[0])
  && Number(requested[0]) >= 1 && Number(requested[0]) <= 7
  && typeof msg.clientId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(msg.clientId)
  && typeof msg.token === 'string' && msg.token.length > 0
  && typeof bearer === 'string' && /^Bearer\s+\S+$/i.test(bearer);
if (!canReadBack) return [msg, null];

msg._tournamentLevelPut = result;
msg.method = 'GET';
msg.url = 'https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile';
msg.headers = { Authorization: bearer, Accept: 'application/json' };
msg.requestTimeout = 2500;
msg.followRedirects = false;
msg.maxRedirects = 0;
delete msg.payload;
return [null, msg];
