// Synthetic subscription instances for the LK1 plan-rules acceptance matrix
// (line T). Shapes follow the two producers the gateway consumes: the Viva
// `availableClientSubscriptions` row and the server identity layer
// (`ctx.lk1ProductIdentity.subscription`, contract §2.1). No customer data.
import { HUB_PRODUCT_ID, PLAN_PRODUCTS, UNKNOWN_PRODUCTS } from './products.js';

export const ACTOR_CLIENT_ID = 'fixture-actor-0001';
export const CLIENT_SUBSCRIPTION_ID = 'fixture-sub-0001';
export const TENANT_KEY = 'fixture-tenant';

export const PURCHASE_DATES = Object.freeze({
  hubBeforeContour: '2026-08-15',
  planBeforeBoundary: '2026-08-31',
  boundary: '2026-09-01',
  boundaryNextDay: '2026-09-02',
});

const raProduct = PLAN_PRODUCTS.find(product => product.key === 'ra');
const energyProduct = UNKNOWN_PRODUCTS.find(product => product.key === 'energy5');

const baseRecord = {
  actorClientId: ACTOR_CLIENT_ID,
  clientSubscriptionId: CLIENT_SUBSCRIPTION_ID,
  tenantKey: TENANT_KEY,
  name: 'Fixture plan',
  status: 'ACTIVE',
  activationDate: '2026-08-01T00:00:00+03:00',
  expirationDate: '2027-08-01T00:00:00+03:00',
  visitsLeft: 20,
};

/**
 * A subscription record as returned by Viva. `purchaseDate` is the only sales
 * date evidence the resolver consumes (contract §2, §2.1).
 */
export const subscriptionRecord = ({ productId, purchaseDate, extra = {} }) => ({
  ...baseRecord,
  subscriptionId: CLIENT_SUBSCRIPTION_ID,
  productId,
  purchaseDate,
  ...extra,
});

/** Server identity proof for the same instance (contract §2.1 candidate #1). */
export const identityProof = ({ productId, purchaseDate, extra = {} }) => ({
  actorClientId: ACTOR_CLIENT_ID,
  tenantKey: TENANT_KEY,
  subscriptionId: CLIENT_SUBSCRIPTION_ID,
  productId,
  purchaseDate,
  subscription: subscriptionRecord({ productId, purchaseDate, extra }),
});

/** Alias map required by the existing preview/gateway ownership checks. */
export const availableSubscription = ({ productId, purchaseDate, extra = {} }) => ({
  ...subscriptionRecord({ productId, purchaseDate, extra }),
  clientId: ACTOR_CLIENT_ID,
  clientSubscriptionId: CLIENT_SUBSCRIPTION_ID,
  id: CLIENT_SUBSCRIPTION_ID,
});

/**
 * Contract §2.1 priority candidates. Order of keys mirrors the frozen list:
 * identity → subscriptionProductId → productId → product.id → templateId/template.id.
 */
export const priorityCandidates = Object.freeze([
  { key: 'identity', field: 'lk1ProductIdentity' },
  { key: 'subscriptionProductId', field: 'subscriptionProductId' },
  { key: 'productId', field: 'productId' },
  { key: 'product.id', field: 'product' },
  { key: 'templateId', field: 'templateId' },
]);

/**
 * One record whose candidates disagree, plus the raw shape for the harness.
 * `priority` selects which candidate carries `priorityProductId`; every other
 * candidate carries `otherProductId`.
 */
export const mismatchedRecord = ({ priorityProductId, otherProductId, purchaseDate, priority }) => {
  const record = { ...baseRecord, subscriptionId: CLIENT_SUBSCRIPTION_ID, purchaseDate };
  const values = {
    subscriptionProductId: otherProductId,
    productId: otherProductId,
    product: { id: otherProductId },
    templateId: otherProductId,
  };
  if (priority === 'identity') {
    record.lk1ProductIdentity = {
      actorClientId: ACTOR_CLIENT_ID,
      tenantKey: TENANT_KEY,
      subscriptionId: CLIENT_SUBSCRIPTION_ID,
      productId: priorityProductId,
      purchaseDate,
      subscription: { ...record, productId: priorityProductId, subscriptionProductId: otherProductId },
    };
  } else {
    values[priority] = priorityProductId;
  }
  return { ...record, ...values };
};

export const RA_PRODUCT_ID = raProduct.productId;
export const ENERGY_PRODUCT_ID = energyProduct.productId;
export const HUB_ID = HUB_PRODUCT_ID;
