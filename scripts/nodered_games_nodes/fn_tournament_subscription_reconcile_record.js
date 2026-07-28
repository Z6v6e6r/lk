const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};

const record = msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload)
  ? msg.payload
  : null;

if (!record || !toStr(record.paymentRef) || !toStr(record.transactionId)) {
  return null;
}

msg._summerSubscriptionCtx = {
  action: "confirm",
  step: "resolve_record",
  reconcile: true,
  paymentRef: toStr(record.paymentRef),
  counterKey: toStr(record.counterKey),
  inventoryId: toStr(record.inventoryId),
  campaignKey: toStr(record.campaignKey),
  planKey: toStr(record.planKey),
  productId: toStr(record.productId),
};
msg.payload = [record];

return msg;
