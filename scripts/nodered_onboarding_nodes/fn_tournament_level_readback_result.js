const put = msg._tournamentLevelPut;
const profile = msg.payload;
const status = msg.statusCode;
const authorized = msg._tournamentLevelReadbackAuthorized === true;
const validProfile = authorized && !msg.error && status === 200 && profile?.id === msg.clientId
  && Array.isArray(profile.customFields)
  && profile.customFields.every(field => field && typeof field.id === 'string' && field.id);
const fields = validProfile ? profile.customFields.filter(field => field.id === put?.fieldId) : [];
const values = fields.length === 1 ? fields[0].value : null;
const raw = Array.isArray(values) && values.length === 1 ? values[0] : null;
const decimal = typeof raw === 'number' || typeof raw === 'string' ? String(raw).trim() : '';
const confirmed = Boolean(put && /^\d+(?:[.,]\d+)?$/.test(decimal)
  && Number(decimal.replace(',', '.')) === Number(put.requestedValue[0]));

// Keep the PUT result and bounded evidence only. The profile can contain PII.
msg.payload = {
  ...put,
  ok: confirmed,
  error: confirmed ? null : 'Viva numeric level could not be confirmed by readback',
  readback: {
    httpStatus: authorized && Number.isInteger(status) ? status : null,
    confirmed,
  },
};
delete msg._tournamentLevelPut;
delete msg._tournamentLevelReadbackAuthorized;
delete msg.token;
delete msg.headers;
delete msg.url;
delete msg.responseUrl;
delete msg.responseCookies;
delete msg.redirectList;
delete msg.error;
return msg;
