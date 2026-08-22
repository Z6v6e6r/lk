const DEFAULT_RESERVATION_MINUTES = 30;
const DEFAULT_INVENTORY_ID = "ab_leto_2026_50_v1";
const STAGED_RELEASE_INVENTORY_ID = "ab_leto_2026_100_then_7_v1";
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
  `${escapeRegex(STAGED_RELEASE_INVENTORY_ID)}_(?:friendship|ra)`,
  ...regionalInventoryIds.map(escapeRegex),
].join("|")})$`;

const queryFilter = {
  inventoryId: { $regex: inventoryIdPattern },
  status: "PAYMENT_PENDING",
  transactionId: { $nin: [null, ""] },
  $or: [
    { expiresAt: { $gt: requestedAtIso } },
    { paymentExpiresAt: { $gt: requestedAtIso } },
    {
      $and: [
        {
          $or: [
            { expiresAt: { $exists: false } },
            { expiresAt: null },
            { expiresAt: "" },
          ],
        },
        {
          $or: [
            { paymentExpiresAt: { $exists: false } },
            { paymentExpiresAt: null },
            { paymentExpiresAt: "" },
          ],
        },
        { createdAt: { $gt: createdAtCutoffIso } },
      ],
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
