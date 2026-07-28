const update = msg.payload && typeof msg.payload === 'object' ? msg.payload : null;
if (!update?.fieldId || !Array.isArray(update.value)) return null;

msg._vivaFieldUpdate = {
  fieldId: String(update.fieldId),
  requestedValue: update.value,
};
msg.method = 'PUT';
msg.url = `https://api.vivacrm.ru/api/v1/clients/${encodeURIComponent(msg.clientId)}/custom-fields/${encodeURIComponent(update.fieldId)}`;
msg.headers = { Authorization: `Bearer ${msg.token}`, 'Content-Type': 'application/json' };
msg.payload = update.value;
return msg;
