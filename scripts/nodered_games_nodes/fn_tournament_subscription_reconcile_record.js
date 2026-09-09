const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};

const record = msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload)
  ? msg.payload
  : null;

const status = String(record?.status || "").trim().toUpperCase();
const recoverableMissingTransaction = (
  !toStr(record?.transactionId)
  && ["DISPATCHING", "PROVIDER_UNKNOWN", "DISPATCH_REPAIRING"].includes(status)
  && ["piter_friendship", "network_friendship"].includes(toStr(record?.counterKey))
);

if (record?.documentType === 'ANNUAL_HISTORY_RECONCILIATION_JOB_V1') {
  msg._summerSubscriptionCtx = { action: "confirm", step: "resolve_record", reconcile: true,
    counterKey: record.counterKey, inventoryId: record.inventoryId, annualHistoryJob: true };
  msg.payload = [record];
  return msg;
}
if (record?.schemaVersion === 3 && record.history?.version === 1
  && ["HUB_ATOMIC_INVENTORY_LEDGER", "PITER_ATOMIC_INVENTORY_LEDGER"].includes(record.documentType)) {
  msg._summerSubscriptionCtx = { action: "confirm", step: "resolve_record", reconcile: true,
    counterKey: record.counterKey, inventoryId: record.inventoryId, annualHistoryLedger: true };
  msg.payload = [record];
  return msg;
}

if (!record || !toStr(record.paymentRef)
  || (!toStr(record.transactionId) && !recoverableMissingTransaction)) {
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
