const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};

const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : null;
const syncSignature = toStr(payload?.syncSignature);
const resultId = toStr(payload?.resultId);
const tenantKey = toStr(payload?.tenantKey);
const resultRevision = Number(payload?.resultRevision);

if (!syncSignature || !resultId || !tenantKey || !Number.isSafeInteger(resultRevision) || resultRevision < 1) {
  return [null, msg];
}

msg._resultVivaSyncSummarySeed = {
  syncSignature,
  resultId,
  tenantKey,
  resultRevision,
};
msg.payload = {
  tenantKey,
  syncSignature,
  resultId,
  resultRevision,
  kind: 'VIVA_ONBOARDING_LEVEL',
};
return [msg, null];
