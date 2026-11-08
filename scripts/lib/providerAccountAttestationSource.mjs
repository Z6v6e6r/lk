import fs from 'node:fs';
import crypto from 'node:crypto';
import { extractSubscriptionPricePreviewSource } from './subscriptionPricePreviewSources.mjs';

// Composes the reviewed node bodies for the read-only provider-account attestation route
// (lk2 ADR 0028). The Viva selection helpers are extracted from the canonical LK1 booking owner
// so the attestation and the booking owner read `subscriptions`/`exercises` identically.
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
export const PROVIDER_ACCOUNT_SELECTOR_ROOTS = Object.freeze([
  'unwrapRecord', 'extractItems', 'findOwnedSubscriptions', 'collectExactProductIds', 'pickName',
  'eventStartsAt', 'eventDurationMinutes', 'collectSubscriptionPurchaseDateEvidence',
  'MANAGED_ENFORCEMENT_PURCHASE_FROM',
]);
const selector = extractSubscriptionPricePreviewSource({
  source: read('nodered_subscription_booking_nodes/fn_subscription_booking_router.js'),
  label: 'provider account attestation selector',
  roots: [...PROVIDER_ACCOUNT_SELECTOR_ROOTS],
});
if (selector.names.some((name) => /prepare|emit|finish|ctx|msg|global|flow|node/i.test(name))) {
  throw new Error('PROVIDER_ACCOUNT_SELECTOR_NOT_PURE');
}
// Validity instants use the HUB money gate's reading (Moscow wall time, date-only expiry = end of day).
const lifecycle = extractSubscriptionPricePreviewSource({
  source: read('nodered_lk1_hub_nodes/gateway.js'),
  label: 'provider account lifecycle instant',
  roots: ['lk1LifecycleInstant', 'LK1_OVERLAY_HUB_PRODUCT_ID'],
});
if (lifecycle.names.some((name) => /prepare|emit|finish|ctx|msg|global|flow|node/i.test(name))) {
  throw new Error('PROVIDER_ACCOUNT_LIFECYCLE_NOT_PURE');
}
// gateway.js runs after the booking owner's calendar helpers; take `isValidDateKey` from there.
const calendar = extractSubscriptionPricePreviewSource({
  source: read('nodered_subscription_booking_nodes/fn_subscription_booking_router.js'),
  label: 'provider account calendar',
  roots: ['isValidDateKey'],
});
const selectorSource = `const paSelect = (() => {\n${selector.source}\nreturn { ${PROVIDER_ACCOUNT_SELECTOR_ROOTS.join(', ')} };\n})();\n`
  + `const paHub = (() => {\n${calendar.source}\n${lifecycle.source}\nreturn { lifecycleInstant: lk1LifecycleInstant, productId: LK1_OVERLAY_HUB_PRODUCT_ID };\n})();\n`
  + 'const paLifecycleInstant = paHub.lifecycleInstant;';
export const providerAccountSelectorSha256 =
  'sha256:' + crypto.createHash('sha256').update(selectorSource).digest('hex');
export const PROVIDER_ACCOUNT_NODE_NAMES = Object.freeze(['verify', 'router', 'response', 'probe']);
export const providerAccountAttestationSource = (name) => {
  if (!PROVIDER_ACCOUNT_NODE_NAMES.includes(name)) throw new Error('Unknown attestation node ' + name);
  return [
    read('nodered_booked_operation_receiver_nodes/_booked_operation_delegation_prelude.js'),
    read('nodered_provider_account_attestation_nodes/_provider_account_attestation_contract.js'),
    ...(name === 'router' ? [selectorSource] : []),
    read('nodered_provider_account_attestation_nodes/fn_provider_account_attestation_' + name + '.js'),
  ].join('\n');
};
