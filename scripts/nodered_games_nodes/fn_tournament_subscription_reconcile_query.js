const DEFAULT_RESERVATION_MINUTES = 30;
const DEFAULT_INVENTORY_ID = "ab_leto_2026_50_v1";
const LEGACY_STAGED_RELEASE_INVENTORY_ID = "ab_leto_2026_100_then_7_v1";
const STAGED_RELEASE_INVENTORY_ID = "ab_leto_2026_150_v2";
const REGIONAL_FRIENDSHIP_INVENTORIES = {
  kotelniki_friendship: "kotelniki_friendship_12m_2026_v1",
  network_friendship: "network_friendship_12m_2026_v1",
  piter_friendship: "piter_friendship_12m_2026_v1",
};

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};

const toInt = (value, fallback) => {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  if (!text) return fallback;
  const parsed = Number(text.replace(",", "."));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
};

const resolveReservationMinutes = () => {
  const raw = toInt(global.get("summer_subscription_reservation_minutes"), DEFAULT_RESERVATION_MINUTES);
  return Math.max(5, Math.min(360, raw));
};

const inventoryId = toStr(global.get("summer_subscription_inventory_id")) || DEFAULT_INVENTORY_ID;
const reservationMinutes = resolveReservationMinutes();
const nowTs = Date.now();
const requestedAtIso = new Date(nowTs).toISOString();
const createdAtCutoffIso = new Date(nowTs - reservationMinutes * 60 * 1000).toISOString();
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const regionalInventoryIds = Array.from(new Set(
  Object.entries(REGIONAL_FRIENDSHIP_INVENTORIES).flatMap(([counterKey, defaultInventoryId]) => [
    defaultInventoryId,
    toStr(global.get(`summer_subscription_${counterKey}_inventory_id`)),
  ]).filter(Boolean),
));
const inventoryIdPattern = `^(?:${[
  `${escapeRegex(inventoryId)}(?:_(?:friendship|ra)_.*)?`,
  `${escapeRegex(LEGACY_STAGED_RELEASE_INVENTORY_ID)}_(?:friendship|ra)`,
  `${escapeRegex(STAGED_RELEASE_INVENTORY_ID)}_(?:friendship|ra)`,
  ...regionalInventoryIds.map(escapeRegex),
].join("|")})$`;

const queryFilter = {
  inventoryId: { $regex: inventoryIdPattern },
  $or: [
    {
      // Provider state, not the local checkout deadline, is authoritative for
      // releasing bounded inventory. Keep polling expired/ambiguous transactions
      // until Viva returns an explicit PAID or FAILED terminal state.
      status: { $in: ["PAYMENT_PENDING", "PROVIDER_UNKNOWN"] },
      transactionId: { $nin: [null, ""] },
    },
    {
      // Atomic annual sales persist DISPATCHING before the Viva POST. If the
      // response is lost, recover the exact provider transaction by client,
      // product, amount and the bounded provider-attempt timestamp.
      status: { $in: ["DISPATCHING", "PROVIDER_UNKNOWN"] },
      transactionId: { $in: [null, ""] },
      counterKey: { $in: ["piter_friendship", "network_friendship"] },
      requestFingerprint: { $nin: [null, ""] },
      clientId: { $nin: [null, ""] },
      productId: { $nin: [null, ""] },
      studioId: { $nin: [null, ""] },
      providerAttemptedAt: { $nin: [null, ""] },
      amountMinor: { $gt: 0 },
    },
    {
      // A repair fence can survive a worker restart. Re-enter the atomic
      // router only to restore CLAIMED; the scheduler must never repeat the
      // provider POST for this state.
      status: "DISPATCH_REPAIRING",
      counterKey: { $in: ["piter_friendship", "network_friendship"] },
      requestFingerprint: { $nin: [null, ""] },
      paymentRef: { $nin: [null, ""] },
      dispatchGeneration: { $gt: 0 },
      repairProviderAttemptedAt: { $nin: [null, ""] },
    },
    {
      status: "PAID_PENDING_INSTANCE_BINDING",
      counterKey: "network_friendship",
      clientSubscriptionId: { $nin: [null, ""] },
      transactionId: { $nin: [null, ""] },
    },
  ],
};
msg.query = queryFilter;
msg.payload = queryFilter;
msg.sort = { updatedAt: 1 };
msg.limit = 200;
msg._summerSubscriptionReconcile = {
  inventoryId,
  requestedAt: requestedAtIso,
  reservationMinutes,
  createdAtCutoff: createdAtCutoffIso,
  regionalInventoryIds,
};

return msg;
