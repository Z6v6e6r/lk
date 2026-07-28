const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};

const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : null;
const syncSignature = toStr(payload?.syncSignature);
const resultId = toStr(payload?.resultId);

if (!syncSignature || !resultId) {
  return [null, msg];
}

msg._resultVivaSyncSummarySeed = {
  syncSignature,
  resultId,
};
msg.payload = {
  syncSignature,
  resultId,
  kind: 'VIVA_ONBOARDING_LEVEL',
};
return [msg, null];
