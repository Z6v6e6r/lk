import fs from 'node:fs';
import crypto from 'node:crypto';
import { extractSubscriptionPricePreviewSource } from './subscriptionPricePreviewSources.mjs';

// Composes the reviewed node bodies for the read-only provider-account attestation route
// (lk2 ADR 0028). The Viva selection helpers are extracted from the canonical LK1 booking owner
// so the attestation and the booking owner read `subscriptions`/`exercises` identically.
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
export const PROVIDER_ACCOUNT_SELECTOR_ROOTS = Object.freeze([
  'unwrapRecord', 'extractItems', 'findOwnedSubscriptions', 'collectExactProductIds', 'pickName',
  'eventStartsAt', 'eventDurationMinutes',
]);
const selector = extractSubscriptionPricePreviewSource({
  source: read('nodered_subscription_booking_nodes/fn_subscription_booking_router.js'),
  label: 'provider account attestation selector',
  roots: [...PROVIDER_ACCOUNT_SELECTOR_ROOTS],
});
if (selector.names.some((name) => /prepare|emit|finish|ctx|msg|global|flow|node/i.test(name))) {
  throw new Error('PROVIDER_ACCOUNT_SELECTOR_NOT_PURE');
}
const selectorSource = `const paSelect = (() => {\n${selector.source}\nreturn { ${PROVIDER_ACCOUNT_SELECTOR_ROOTS.join(', ')} };\n})();`;
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
