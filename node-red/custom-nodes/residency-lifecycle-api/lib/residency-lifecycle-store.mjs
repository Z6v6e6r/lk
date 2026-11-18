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
  const copy = structuredClone(document);
  delete copy._id;
  return copy;
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
      const result = await collection.insertOne(document);
      return { ok: result?.acknowledged === true || result?.insertedId != null };
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
    return { ok: result?.matchedCount === 1 };
  }

  async function findUnresolvedOrder(tenantId, userId) {
    const row = await collection.findOne({ tenantId, userId, state: { $in: UNRESOLVED_STATES } });
    return clone(withoutMongoId(row));
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

  return { findOrderByKey, getOrder, insertOrder, updateOrder, findUnresolvedOrder, listExpiredPending };
}

/**
 * Index contract for the Mongo adapter. Applying indexes is an operational step;
 * this function only describes them for a reviewed migration/check.
 */
export const RESIDENCY_LIFECYCLE_INDEXES = Object.freeze([
  { keys: { tenantId: 1, orderId: 1 }, options: { unique: true, name: "residency_order_identity" } },
  { keys: { tenantId: 1, idempotencyKeyHash: 1 }, options: { unique: true, name: "residency_order_idempotency" } },
  { keys: { tenantId: 1, userId: 1, state: 1 }, options: { name: "residency_order_user_state" } },
  { keys: { tenantId: 1, state: 1, "payment.expiresAt": 1 }, options: { name: "residency_order_expiry" } },
]);