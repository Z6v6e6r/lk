// MongoDB adapter for the residency lifecycle engine.
//
// Every query is tenant-scoped. The store owns durability only; it does not decide
// lifecycle transitions. An update is a revision CAS so two callbacks cannot both
// activate the same order.

const UNRESOLVED_STATES = ["PENDING_PAYMENT", "PAID", "PAID_ACTIVATION_PENDING", "ACTIVATION_FAILED", "PAID_REQUIRES_REVIEW"];

function assertCollection(collection) {
  if (!collection || typeof collection.findOne !== "function" || typeof collection.insertOne !== "function"
    || typeof collection.updateOne !== "function" || typeof collection.find !== "function") {
    throw new Error("RESIDENCY_STORE_COLLECTION_INVALID");
  }
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function withoutMongoId(document) {
  if (!document || typeof document !== "object") return document;
  const copy = { ...document };
  delete copy._id;
  return structuredClone(copy);
}

/**
 * @param {object} deps
 * @param {object} deps.collection MongoDB collection with the lifecycle orders.
 * @param {() => number} [deps.now]
 */
export function createMongoResidencyLifecycleStore({ collection }) {
  assertCollection(collection);

  async function findOrderByKey(tenantId, keyHash) {
    const row = await collection.findOne({ tenantId, idempotencyKeyHash: keyHash });
    return clone(withoutMongoId(row));
  }

  async function getOrder(tenantId, userId, orderId) {
    const row = await collection.findOne({ tenantId, userId, orderId });
    return clone(withoutMongoId(row));
  }

  async function insertOrder(order) {
    const document = { ...clone(order), _id: order.orderId };
    try {
      // A durable attempt is only durable when the write was acknowledged by the server;
      // an unacknowledged insert never becomes a "successful" order.
      const result = await collection.insertOne(document);
      return { ok: result?.acknowledged === true && (result.insertedId != null || result.insertedCount === 1) };
    } catch (error) {
      if (error && (error.code === 11000 || error.codeName === "DuplicateKey")) return { ok: false };
      throw error;
    }
  }

  async function updateOrder(tenantId, orderId, expectedRevision, next) {
    const fields = clone(next);
    delete fields.revision;
    delete fields.createdAt;
    delete fields._id;
    const result = await collection.updateOne(
      { tenantId, orderId, revision: expectedRevision },
      { $set: fields, $inc: { revision: 1 } },
    );
    return { ok: result?.acknowledged === true && result.matchedCount === 1 };
  }

  async function findUnresolvedOrder(tenantId, userId) {
    const row = await collection.findOne({ tenantId, userId, state: { $in: UNRESOLVED_STATES } });
    return clone(withoutMongoId(row));
  }

  async function listUnresolvedOrders(tenantId, userId, limit = 20) {
    const cursor = collection.find({ tenantId, userId, state: { $in: UNRESOLVED_STATES } })
      .sort({ createdAt: -1 }).limit(Math.max(1, Math.min(50, limit)));
    const rows = await cursor.toArray();
    return rows.map((row) => clone(withoutMongoId(row)));
  }

  /**
   * Looks up the lifecycle orders that already own a provider transaction. Used only to
   * separate this service's own payments from a purchase started by the old checkout.
   */
  async function findOrdersByTransactionIds(tenantId, userId, transactionIds) {
    const ids = (Array.isArray(transactionIds) ? transactionIds : []).filter((id) => typeof id === "string" && id.length > 0).slice(0, 100);
    if (!ids.length) return [];
    const cursor = collection.find({ tenantId, userId, "payment.providerTransactionId": { $in: ids } }).limit(50);
    const rows = await cursor.toArray();
    return rows.map((row) => clone(withoutMongoId(row)));
  }

  /**
   * Recent orders for the external-conflict view. Unlike listUnresolvedOrders this includes
   * ACTIVE and terminal rows: an activation must not hide the paid operation it raced with.
   * The window is bounded by the external lookback; the caller still decides the view.
   */
  async function listRecentOrders(tenantId, userId, sinceIso, limit = 50) {
    const cursor = collection.find({ tenantId, userId, updatedAt: { $gte: sinceIso } })
      .sort({ updatedAt: -1 }).limit(Math.max(1, Math.min(50, limit)));
    const rows = await cursor.toArray();
    return rows.map((row) => clone(withoutMongoId(row)));
  }

  async function listExpiredPending(tenantId, nowIso) {
    const cursor = collection.find({
      tenantId,
      state: "PENDING_PAYMENT",
      "payment.expiresAt": { $type: "string", $lte: nowIso },
    }).limit(50);
    const rows = await cursor.toArray();
    return rows.map((row) => clone(withoutMongoId(row)));
  }

  return { findOrderByKey, getOrder, insertOrder, updateOrder, findUnresolvedOrder, listUnresolvedOrders,
    listRecentOrders, findOrdersByTransactionIds, listExpiredPending };
}

/**
 * Verifies an installed index really is the reviewed one: same keys, same uniqueness and
 * the same partial predicate. An index name alone proves nothing.
 */
export function indexSpecMatches(installed, spec) {
  if (!installed || typeof installed !== "object") return false;
  const keys = installed.key && typeof installed.key === "object" ? installed.key : {};
  const expectedKeys = Object.entries(spec.keys);
  if (Object.keys(keys).length !== expectedKeys.length) return false;
  for (const [field, direction] of expectedKeys) {
    if (keys[field] !== direction) return false;
  }
  const unique = installed.unique === true;
  if (unique !== (spec.options.unique === true)) return false;
  const expectedPartial = spec.options.partialFilterExpression;
  if (!expectedPartial) return installed.partialFilterExpression === undefined;
  const partial = installed.partialFilterExpression;
  if (!partial || typeof partial !== "object") return false;
  const expectedEntries = Object.entries(expectedPartial);
  if (Object.keys(partial).length !== expectedEntries.length) return false;
  return expectedEntries.every(([field, value]) => partial[field] === value);
}

/**
 * Index contract for the Mongo adapter. Applying indexes is an operational step;
 * this function only describes them for a reviewed migration/check.
 */
export const RESIDENCY_LIFECYCLE_INDEXES = Object.freeze([
  { keys: { tenantId: 1, orderId: 1 }, options: { unique: true, name: "residency_order_identity" } },
  { keys: { tenantId: 1, idempotencyKeyHash: 1 }, options: { unique: true, name: "residency_order_idempotency" } },
  { keys: { tenantId: 1, userId: 1, activeSlot: 1 }, options: { unique: true, name: "residency_order_active_slot", partialFilterExpression: { activeSlot: 1 } } },
  { keys: { tenantId: 1, userId: 1, state: 1 }, options: { name: "residency_order_user_state" } },
  { keys: { tenantId: 1, state: 1, "payment.expiresAt": 1 }, options: { name: "residency_order_expiry" } },
]);