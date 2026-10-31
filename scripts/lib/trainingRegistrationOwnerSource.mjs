import fs from 'node:fs';
import crypto from 'node:crypto';
import { extractSubscriptionPricePreviewSource } from './subscriptionPricePreviewSources.mjs';
import { proTrainingExclusionSource, topokratyExclusionSource } from './eventPaymentSources.mjs';
const read = (path) => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const canonical = read('nodered_subscription_booking_nodes/fn_subscription_booking_router.js');
const roots = [
  'resolveManagedEnforcementDecision',
  'findOwnedSubscriptions',
  'resolveCategory',
  'eventStartsAt',
  'eventDurationMinutes',
  'collectSubscriptionPurchaseDateEvidence',
];
const extracted = extractSubscriptionPricePreviewSource({
  source: canonical,
  label: 'training owner canonical selectors',
  roots,
});
const rules = read('lib/lk1PlanRules.mjs').replace(/^export /gm, '');
const selection = [
  `const ownerSelection=(()=>{${extracted.source}\nreturn {${roots.join(',')}};})();`,
  'const collectSubscriptionPurchaseDateEvidence=ownerSelection.collectSubscriptionPurchaseDateEvidence;',
  rules,
  proTrainingExclusionSource(),
  topokratyExclusionSource(),
  read('nodered_training_registration_nodes/_training_registration_selection.js'),
].join('\n');
export const trainingSelectorSourceHash = crypto
  .createHash('sha256')
  .update(selection)
  .digest('hex');
export const trainingContractSource = () =>
  read('nodered_training_registration_nodes/_training_registration_contract.js');
export const trainingSelectionSource = () => selection;
export const trainingBookingPreludeSource = () =>
  `const trainingOwner=(()=>{${trainingContractSource()}\n${selection}\nreturn {${['trObject', 'trKeys', 'trId', 'trUuid', 'trDigest', 'trIso', 'trHash', 'trEqual', 'trRequest', 'trCanonicalBinding', 'trCanonicalImmutable', 'trCanonicalRow', 'trList', 'trAlias', 'trBookingId', 'trBookingMatches', 'trBookingActive', 'trBookingExercise', 'trExerciseTarget', 'trSelection'].join(',')}};})();\n` +
  read('nodered_training_registration_nodes/_training_registration_booking.js');
export const trainingRegistrationOwnerSource = (name, mode) =>
  [
    read('nodered_booked_operation_receiver_nodes/_booked_operation_delegation_prelude.js'),
    trainingContractSource(),
    read('nodered_booked_operation_receiver_nodes/_booked_operation_viva_contract.js'),
    name === 'verify'
      ? read('nodered_training_registration_nodes/_training_registration_delegation.js')
      : selection,
    ...(name === 'verify' ? [`const TRAINING_REGISTRATION_MODE=${JSON.stringify(mode)};`] : []),
    read('nodered_training_registration_nodes/fn_training_registration_' + name + '.js'),
  ].join('\n');
