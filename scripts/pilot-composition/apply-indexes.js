/* global db, printjson */
// One-off index application for the isolated composition.
// Production applies the same five specs as a reviewed operator step; ENSURE_INDEXES stays false.
db.lk_residency_lifecycle_orders.createIndex({ tenantId: 1, orderId: 1 }, { unique: true, name: "residency_order_identity" });
db.lk_residency_lifecycle_orders.createIndex({ tenantId: 1, idempotencyKeyHash: 1 }, { unique: true, name: "residency_order_idempotency" });
db.lk_residency_lifecycle_orders.createIndex({ tenantId: 1, userId: 1, activeSlot: 1 }, { unique: true, name: "residency_order_active_slot", partialFilterExpression: { activeSlot: 1 } });
db.lk_residency_lifecycle_orders.createIndex({ tenantId: 1, userId: 1, state: 1 }, { name: "residency_order_user_state" });
db.lk_residency_lifecycle_orders.createIndex({ tenantId: 1, state: 1, "payment.expiresAt": 1 }, { name: "residency_order_expiry" });
printjson(db.lk_residency_lifecycle_orders.getIndexes().map((index) => ({ name: index.name, key: index.key, unique: index.unique, partial: index.partialFilterExpression })));
