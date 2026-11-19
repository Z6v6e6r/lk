import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { residencyDiscountedPrice } from "../../src/residency/compositeResidencyOrder.ts";
import { RESIDENCY_PRODUCT_ID } from "../../src/residency/residencyPurchase.ts";

const ID = /^[A-Za-z0-9._:-]{1,200}$/;
const OPERATION_ID = /^[A-Za-z0-9._:-]{8,200}$/;
const WRITE = { writeConcern: { w: "majority" } };
const READ = { readConcern: { level: "majority" }, readPreference: "primary" };

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function validateActor(actor) {
  // Tenant and Viva client identity come from the trusted caller, not the request body.
  if (typeof actor?.tenantId !== "string" || !ID.test(actor.tenantId)
    || typeof actor?.clientId !== "string" || !ID.test(actor.clientId)) fail("COMPOSITE_ACTOR_REQUIRED");
}

function operationKey(actor, operationId) {
  validateActor(actor);
  if (typeof operationId !== "string" || !OPERATION_ID.test(operationId)) fail("COMPOSITE_OPERATION_INVALID");
  return createHash("sha256").update(JSON.stringify([actor.tenantId, actor.clientId, operationId])).digest("hex");
}

function validateExercise(exerciseId) {
  if (typeof exerciseId !== "string" || !ID.test(exerciseId)) fail("COMPOSITE_EXERCISE_INVALID");
}

function quoteTerms(quote) {
  const { schemaVersion, kind, exerciseId, startsAt, durationMinutes, currency,
    participationProductId, residencyProductId, existingResidency, publicationId, policyVersion, policyDigest,
    participationBaseMinor, discountPercent, participationDiscountMinor, participationToPayMinor,
    residencyMinor, totalMinor } = quote ?? {};
  return { schemaVersion, kind, exerciseId, startsAt, durationMinutes, currency,
    participationProductId, residencyProductId, existingResidency, publicationId, policyVersion, policyDigest,
    participationBaseMinor, discountPercent, participationDiscountMinor, participationToPayMinor,
    residencyMinor, totalMinor };
}

function validateQuote(response, exerciseId, now) {
  const quote = response?.residencyPurchaseQuote;
  const terms = quoteTerms(quote);
  const startsAt = typeof terms.startsAt === "string" ? Date.parse(terms.startsAt) : NaN;
  if (terms.schemaVersion !== 1 || terms.kind !== "GROUP_TRAINING_RESIDENCY_PURCHASE_QUOTE"
    || terms.exerciseId !== exerciseId || terms.currency !== "RUB" || terms.existingResidency !== "NONE"
    || terms.residencyProductId !== RESIDENCY_PRODUCT_ID
    || typeof terms.participationProductId !== "string" || !ID.test(terms.participationProductId)
    || terms.participationProductId.toLowerCase() === RESIDENCY_PRODUCT_ID
    || typeof terms.publicationId !== "string" || !ID.test(terms.publicationId)
    || !Number.isSafeInteger(terms.policyVersion) || terms.policyVersion < 1
    || typeof terms.policyDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(terms.policyDigest)
    || ![60, 90, 120].includes(terms.durationMinutes) || !Number.isFinite(startsAt) || startsAt <= now
    || new Date(startsAt).toISOString() !== terms.startsAt
    || !Number.isSafeInteger(quote.expiresAt) || quote.expiresAt <= now
    || quote.expiresAt > Math.min(now + 30_000, startsAt)
    || !Number.isSafeInteger(terms.discountPercent) || terms.discountPercent < 1 || terms.discountPercent > 100
    || ![terms.participationBaseMinor, terms.residencyMinor].every(amount =>
      Number.isSafeInteger(amount) && amount > 0 && amount <= 1_000_000)) fail("COMPOSITE_QUOTE_INVALID");

  const afterDiscount = residencyDiscountedPrice(terms.participationBaseMinor, terms.discountPercent);
  if (terms.participationToPayMinor !== afterDiscount
    || terms.participationDiscountMinor !== terms.participationBaseMinor - afterDiscount
    || terms.totalMinor !== afterDiscount + terms.residencyMinor) fail("COMPOSITE_QUOTE_INVALID");
  return { ...terms, expiresAt: quote.expiresAt };
}

function orderResult(order) {
  return {
    operationId: order.operationId,
    state: order.state === "SUBMITTING" ? "PENDING_CONFIRMATION" : order.state,
    providerOrderId: order.providerOrderId,
    quote: order.quote,
  };
}

function providerRequest(order) {
  const { participationProductId, residencyProductId, participationBaseMinor, participationDiscountMinor,
    residencyMinor, totalMinor } = order.quote;
  return {
    reference: order._id,
    tenantId: order.tenantId,
    clientId: order.clientId,
    exerciseId: order.exerciseId,
    totalMinor,
    lines: [
      { role: "PARTICIPATION", productId: participationProductId, count: 1, costMinor: participationBaseMinor,
        discountMinor: participationDiscountMinor, exerciseId: order.exerciseId },
      { role: "RESIDENCY", productId: residencyProductId, count: 1, costMinor: residencyMinor,
        discountMinor: 0, exerciseId: null },
    ],
  };
}

function matchesReceipt(request, receipt) {
  return typeof receipt?.providerOrderId === "string" && ID.test(receipt.providerOrderId)
    && receipt.reference === request.reference
    && receipt.tenantId === request.tenantId && receipt.clientId === request.clientId
    && receipt.exerciseId === request.exerciseId && receipt.totalMinor === request.totalMinor
    && isDeepStrictEqual(receipt.lines, request.lines);
}

/**
 * Group training backend. readQuote invokes the trusted server-side price
 * resolver from #457 with the verified actor and the selected exercise.
 * The provider returns verified, normalized receipts and can look up the original
 * reference after an unknown outcome. Viva has no enabled adapter (#458).
 */
export function createCompositeResidencyCheckout({ collection, readQuote, provider = null, now = Date.now }) {
  if (provider && (typeof provider.create !== "function" || typeof provider.lookup !== "function")) {
    fail("COMPOSITE_PROVIDER_CONTRACT_INVALID");
  }

  async function freshQuote(actor, exerciseId) {
    const response = await readQuote(actor, exerciseId);
    return validateQuote(response, exerciseId, now());
  }

  async function saveReceipt(order, request, receipt) {
    if (!matchesReceipt(request, receipt)) return orderResult(order);
    const providerOrderId = receipt.providerOrderId;
    const result = await collection.updateOne({ _id: order._id, state: "SUBMITTING" },
      { $set: { state: "CREATED", providerOrderId } }, WRITE);
    if (result.acknowledged && result.matchedCount === 1) return orderResult({ ...order, state: "CREATED", providerOrderId });
    const saved = await collection.findOne({ _id: order._id }, READ);
    if (saved?.state !== "CREATED" || saved.providerOrderId !== providerOrderId) fail("COMPOSITE_ORDER_UNRESOLVED");
    return orderResult(saved);
  }

  async function recover(order) {
    if (order.state !== "SUBMITTING" || !provider) return orderResult(order);
    const request = providerRequest(order);
    let receipt;
    try {
      receipt = await provider.lookup(structuredClone(request));
    } catch {
      return orderResult(order);
    }
    return saveReceipt(order, request, receipt);
  }

  async function replay(order, exerciseId, acceptedQuote) {
    if (order.exerciseId !== exerciseId || !isDeepStrictEqual(quoteTerms(order.quote), quoteTerms(acceptedQuote))) {
      fail("COMPOSITE_OPERATION_CONFLICT");
    }
    return recover(order);
  }

  return {
    async quote(actor, exerciseId) {
      validateActor(actor);
      validateExercise(exerciseId);
      return freshQuote(actor, exerciseId);
    },

    async checkout(actor, { operationId, exerciseId, acceptedQuote, consentAccepted }) {
      const _id = operationKey(actor, operationId);
      validateExercise(exerciseId);
      if (consentAccepted !== true) fail("CONSENT_REQUIRED");

      const previous = await collection.findOne({ _id }, READ);
      if (previous) return replay(previous, exerciseId, acceptedQuote);
      if (!provider) fail("VIVA_COMPOSITE_FORMAT_UNAVAILABLE");

      const quote = await freshQuote(actor, exerciseId);
      if (!isDeepStrictEqual(quoteTerms(quote), quoteTerms(acceptedQuote))) fail("COMPOSITE_QUOTE_CHANGED");

      const order = {
        _id, schemaVersion: 1, operationId, exerciseId, quote,
        tenantId: actor.tenantId, clientId: actor.clientId, acceptedAt: new Date(now()).toISOString(),
        state: "SUBMITTING", providerOrderId: null,
      };
      try {
        const inserted = await collection.insertOne(order, WRITE);
        if (!inserted.acknowledged) fail("COMPOSITE_ORDER_UNRESOLVED");
      } catch (error) {
        if (error?.code !== 11000) throw error;
        const winner = await collection.findOne({ _id }, READ);
        if (!winner) fail("COMPOSITE_ORDER_UNRESOLVED");
        return replay(winner, exerciseId, acceptedQuote);
      }

      if (now() >= quote.expiresAt) {
        const state = "EXPIRED_BEFORE_DISPATCH";
        const result = await collection.updateOne({ _id, state: "SUBMITTING" }, { $set: { state } }, WRITE);
        if (!result.acknowledged || result.matchedCount !== 1) fail("COMPOSITE_ORDER_UNRESOLVED");
        return orderResult({ ...order, state });
      }
      const request = providerRequest(order);
      let receipt;
      try {
        receipt = await provider.create(structuredClone(request));
      } catch {
        return orderResult(order);
      }
      return saveReceipt(order, request, receipt);
    },

    async getOrder(actor, operationId) {
      const order = await collection.findOne({ _id: operationKey(actor, operationId) }, READ);
      return order ? recover(order) : null;
    },
  };
}
