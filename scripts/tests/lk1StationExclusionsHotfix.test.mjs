// The Sirius station-exclusions generation: the reviewed delivery vehicle for the owner
// decision of 2026-09-18. The snapshot half proves the candidate against the exact installed
// flow; the hermetic half drives the composed gateway body, so the station is proved to reach
// the contour decision itself rather than only the source text.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { hubGatewaySource, planRulesSource } from '../lib/eventPaymentSources.mjs';
import { LK1_PLAN_RULES_DESIRED } from '../lib/lk1PlanRulesTransition.mjs';
import { reviewedConfigFragment } from '../patch_live_lk1_plan_rules.mjs';
import { LK1_STATION_EXCLUSIONS_DESIRED } from '../lib/lk1StationExclusionsTransition.mjs';
import {
  STATION_EXCLUSIONS_BOOKING_ID,
  STATION_EXCLUSIONS_CALL_SITE_DELTAS,
  STATION_EXCLUSIONS_DEPLOYMENT_ID,
  STATION_EXCLUSIONS_PREVIEW_ID,
  STATION_EXCLUSIONS_SOURCE_NODE_COUNT,
  STATION_EXCLUSIONS_SOURCE_SHA256,
  STATION_EXCLUSIONS_TARGET,
  composeStationExclusionsArtifacts,
  patchStationExclusionsBookingBody,
  patchStationExclusionsBookingInitialize,
  sha256,
} from '../patch_live_lk1_station_exclusions_hotfix.mjs';

const LIVE_SNAPSHOT = process.env.LK1_STATION_EXCLUSIONS_LIVE_SNAPSHOT
  ?? '/private/tmp/lk1-station-live-20260918/input/source.flow.json';
const snapshotSkip = fs.existsSync(LIVE_SNAPSHOT)
  ? false
  : `live 147 snapshot is absent: ${LIVE_SNAPSHOT} (set LK1_STATION_EXCLUSIONS_LIVE_SNAPSHOT)`;

const HUB = 'db7a5250-7369-4f43-8ac5-9111be24bc74';
const FRIENDSHIP = 'b2e6a9d4-53b5-4f79-87ec-3fb076381e9b';
const SIRIUS = '233c1405-1eac-40de-8ec6-1cf7e24c9276';
const OTHER_STATION = '6a7a9edc-6869-40ad-a5a1-8a1cdfb746a1';

// The delivered contour decision: the embedded resolver module plus the reviewed config
// fragment, with the two globals the contour reads.
const RULE_FIELDS = ['maxActiveBookings', 'freeGameMinutesPerDay', 'gameOverageDiscountPercent',
  'groupTrainingDiscountPercent', 'tournamentDiscountPercent'];
const gatewayScope = (globals) => new Function(
  'global', 'isObj', 'toStr', 'normalizeId', 'collectExactProductIds',
  'collectSubscriptionPurchaseDateEvidence', 'isValidDateKey', 'lk1ReadBoundPolicy', 'lk1Fields',
  `${planRulesSource()}\n${reviewedConfigFragment()}\nreturn { lk1Config };`,
)(
  { get: key => globals[key] },
  value => value !== null && typeof value === 'object' && !Array.isArray(value),
  value => (value === null || value === undefined ? null : String(value).trim() || null),
  value => (typeof value === 'string' ? value.trim().toLowerCase() : null),
  value => [value?.productId].filter(Boolean),
  value => ({ invalid: false, dates: [String(value?.purchaseDate || '').slice(0, 10)] }),
  value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')),
  () => ({ productId: HUB, maxActiveBookings: 4, freeGameMinutesPerDay: 60,
    gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 }),
  RULE_FIELDS,
);
const released = () => gatewayScope({
  subscriptions_lk1_plan_rules: LK1_PLAN_RULES_DESIRED,
  subscriptions_lk1_station_exclusions: LK1_STATION_EXCLUSIONS_DESIRED,
});

test('the composed gateway keeps the Sirius pair out of the contour', () => {
  const { lk1Config } = released();
  const sirius = lk1Config([{ productId: FRIENDSHIP, purchaseDate: '2026-09-05' }], SIRIUS);
  assert.deepEqual(sirius, { matched: true, legacy: true });
  // The same instance at any other station keeps the plan rule it was sold under.
  const other = lk1Config([{ productId: FRIENDSHIP, purchaseDate: '2026-09-05' }], OTHER_STATION);
  assert.equal(other.matched, true);
  assert.equal(other.legacy, undefined);
  assert.equal(other.rule.tournamentDiscountPercent, 50);
  // The annual HUB is not part of the shipped pair and never leaves the contour.
  const hub = lk1Config([{ productId: HUB, purchaseDate: '2026-08-15' }], SIRIUS);
  assert.equal(hub.matched, true);
  assert.equal(hub.legacy, undefined);
  assert.equal(hub.rule.productId, HUB);
  // A product without a rule stays untouched, with and without the exclusion.
  assert.deepEqual(lk1Config([{ productId: 'dfa72adf-233b-4285-8d69-e5eab4234fbe', purchaseDate: '2026-09-05' }], SIRIUS),
    { matched: false });
  // A missing station cannot exclude anything.
  const noStation = lk1Config([{ productId: FRIENDSHIP, purchaseDate: '2026-09-05' }], null);
  assert.equal(noStation.legacy, undefined);
  assert.equal(noStation.rule.tournamentDiscountPercent, 50);
});

test('the generation names the reviewed preimage and the exact pairs it changes', () => {
  assert.equal(STATION_EXCLUSIONS_SOURCE_NODE_COUNT, 4804);
  assert.match(STATION_EXCLUSIONS_SOURCE_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(STATION_EXCLUSIONS_DEPLOYMENT_ID, 'lk1-station-exclusions');
  assert.equal(STATION_EXCLUSIONS_BOOKING_ID, 'lk_subscription_booking_router_20260804');
  assert.equal(STATION_EXCLUSIONS_PREVIEW_ID, 'lk_subscription_price_20260908_router'.replace('price_', 'price_preview_'));
  for (const field of ['liveBookingFuncSha256', 'patchedBookingFuncSha256',
    'liveBookingInitializeSha256', 'patchedBookingInitializeSha256',
    'livePreviewFuncSha256', 'patchedPreviewFuncSha256']) {
    assert.match(STATION_EXCLUSIONS_TARGET[field], /^[0-9a-f]{64}$/, field);
  }
  assert.notEqual(STATION_EXCLUSIONS_TARGET.liveBookingFuncSha256, STATION_EXCLUSIONS_TARGET.patchedBookingFuncSha256);
  // Every contour decision of the installed body is named once.
  assert.deepEqual(STATION_EXCLUSIONS_CALL_SITE_DELTAS.map(delta => delta.id), [
    'quote-station', 'money-gate-station', 'checkout-station', 'hooks-selected-station',
    'hooks-product-station', 'projection-station', 'projection-exercise', 'projection-caller-exercise',
  ]);
  assert.deepEqual(LK1_STATION_EXCLUSIONS_DESIRED, { formatVersion: 1, exclusions: [
    { stationId: SIRIUS, productIds: [FRIENDSHIP] },
  ] });
  // The station-less forms the generation removes are exactly the reviewed ones.
  const reviewedSources = [
    ['gateway', hubGatewaySource()],
    ['hooks', fs.readFileSync(new URL('../nodered_lk1_hub_nodes/gateway_hooks.js', import.meta.url), 'utf8')],
    ['product identity', fs.readFileSync(new URL('../nodered_subscription_product_nodes/gateway.js', import.meta.url), 'utf8')],
  ];
  for (const delta of STATION_EXCLUSIONS_CALL_SITE_DELTAS) {
    const match = reviewedSources.find(([, text]) => text.includes(delta.after));
    assert.ok(match, `a reviewed source must carry ${delta.id}`);
    assert.equal(match[1].includes(delta.before), false,
      `the reviewed ${match[0]} source must not carry the pre-station form of ${delta.id}`);
  }
});

test('the generation applies to the installed flow as exactly two changed nodes', { skip: snapshotSkip }, () => {
  const bytes = fs.readFileSync(LIVE_SNAPSHOT);
  assert.equal(sha256(bytes), STATION_EXCLUSIONS_SOURCE_SHA256, 'installed flow drift');
  const built = composeStationExclusionsArtifacts(bytes, STATION_EXCLUSIONS_DEPLOYMENT_ID);
  assert.equal(built.changes.length, 2);
  assert.equal(built.addedNodeCount, 0);
  assert.equal(built.flow.length, STATION_EXCLUSIONS_SOURCE_NODE_COUNT);
  assert.deepEqual(built.changes.map(change => change.id).sort(),
    [STATION_EXCLUSIONS_BOOKING_ID, STATION_EXCLUSIONS_PREVIEW_ID].sort());
  assert.deepEqual(built.changes.find(change => change.id === STATION_EXCLUSIONS_BOOKING_ID).fields,
    ['func', 'initialize']);
  assert.deepEqual(built.changes.find(change => change.id === STATION_EXCLUSIONS_PREVIEW_ID).fields, ['func']);
  for (const flag of ['stationCallSites', 'stationExclusionsBound', 'stationWriterBound',
    'planRulesWriterKept', 'hubPolicyWriterKept']) {
    assert.equal(built.booking[flag], true, flag);
  }
  assert.equal(built.preview.stationAware, true);
  assert.equal(built.preview.initializeUnchanged, true);
  // Every node except the two patched ones is byte-identical.
  const live = JSON.parse(bytes.toString('utf8'));
  const changed = new Set([STATION_EXCLUSIONS_BOOKING_ID, STATION_EXCLUSIONS_PREVIEW_ID]);
  assert.deepEqual(built.flow.filter(node => JSON.stringify(node) !== JSON.stringify(live.find(row => row.id === node.id)))
    .map(node => node.id).sort(), [...changed].sort());
  // The candidate is idempotence-proof: a second application is refused.
  const candidate = JSON.parse(built.candidateBytes.toString('utf8'));
  const patchedBooking = candidate.find(node => node.id === STATION_EXCLUSIONS_BOOKING_ID);
  assert.throws(() => patchStationExclusionsBookingBody(patchedBooking.func), /already carries/);
  assert.throws(() => patchStationExclusionsBookingInitialize(patchedBooking.initialize), /already carries/);
});

test('the patcher refuses a foreign preimage and a second application', () => {
  assert.throws(() => patchStationExclusionsBookingBody('const x = 1;\n'), /preimage drift/);
  assert.throws(() => patchStationExclusionsBookingInitialize('const x = 1;\n'), /preimage drift/);
});
