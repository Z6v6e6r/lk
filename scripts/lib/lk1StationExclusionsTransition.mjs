// A source-bound transition for the LK1 station-exclusions global, not an admin API.
//
// The exclusion global is the only runtime input that lets a named station keep the
// pre-rollout behaviour for a product that otherwise carries a plan rule
// (scripts/lib/lk1PlanRules.mjs). It ships inside the Node-RED generation as
// reviewed, versioned code for the same reason the plan-rules global does: the
// contour decision belongs to a reviewed artifact, not to an out-of-band write.
//
// Owner decision 2026-09-18: the Sirius club (studio 233c1405-…, «Сочи») sells the
// base «Лето.Падел.Дружба» product, whose plan rule would charge 50 % for a
// tournament. Rule 7 of docs/LK1_ENFORCEMENT_ROLLOUT_COORDINATION.md keeps that club
// legacy, so the product/station pair below is excluded from the contour and the
// subscription keeps carrying its tournament with a consumed visit.
export const LK1_STATION_EXCLUSIONS_KEY = 'subscriptions_lk1_station_exclusions';

// Sirius («Сочи», пгт Сириус) — the station whose Дружба sales stay legacy.
export const LK1_SIRIUS_STATION_ID = '233c1405-1eac-40de-8ec6-1cf7e24c9276';
// «Лето.Падел.Дружба» — the only product the Sirius page sells (readSiriusFriendshipConfig
// falls back to the friendship plan product id).
export const LK1_SIRIUS_FRIENDSHIP_PRODUCT_ID = 'b2e6a9d4-53b5-4f79-87ec-3fb076381e9b';

export const LK1_STATION_EXCLUSIONS_DESIRED = Object.freeze({
  formatVersion: 1,
  exclusions: Object.freeze([
    Object.freeze({ stationId: LK1_SIRIUS_STATION_ID, productIds: Object.freeze([LK1_SIRIUS_FRIENDSHIP_PRODUCT_ID]) }),
  ]),
});

// Missing/empty means "no exclusions yet", which is a legitimate prior. Everything
// else must match the frozen shape exactly: a surplus, missing or mistyped key is a
// hard refusal, never a silent coercion.
function normalizeStationExclusionsGlobal(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') value = JSON.parse(value);
  const isObject = item => item !== null && typeof item === 'object' && !Array.isArray(item);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  // Stations are UUIDs without the product version/variant restriction.
  const stationUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (!isObject(value) || value.formatVersion !== 1 || !Array.isArray(value.exclusions)
    || Object.keys(value).sort().join() !== ['exclusions', 'formatVersion'].sort().join()) {
    throw new Error('LK1 station exclusions shape mismatch');
  }
  const seen = new Set();
  const exclusions = value.exclusions.map(item => {
    if (!isObject(item)
      || Object.keys(item).sort().join() !== ['productIds', 'stationId'].sort().join()
      || !Array.isArray(item.productIds) || item.productIds.length === 0) {
      throw new Error('LK1 station exclusions shape mismatch');
    }
    const stationId = typeof item.stationId === 'string' ? item.stationId.trim().toLowerCase() : '';
    const productIds = item.productIds.map(productId => (
      typeof productId === 'string' ? productId.trim().toLowerCase() : ''));
    if (!stationUuid.test(stationId) || seen.has(stationId)
      || productIds.some(productId => !uuid.test(productId))
      || new Set(productIds).size !== productIds.length) {
      throw new Error('LK1 station exclusions shape mismatch');
    }
    seen.add(stationId);
    // Canonical key order, so the write/compare stays a JSON.stringify equality.
    return { stationId, productIds };
  });
  return { formatVersion: 1, exclusions };
}

export function buildStationExclusionsTransition({ expectedPrior, desired } = {}) {
  // Explicit null means "no global yet". Missing options cannot silently become a
  // transition, and a later exclusion change must name the exact prior it replaces.
  if (expectedPrior === undefined || desired === undefined) {
    throw new Error('Explicit station-exclusions prior and desired global required');
  }
  const prior = normalizeStationExclusionsGlobal(expectedPrior);
  const next = normalizeStationExclusionsGlobal(desired);
  const declarations = `const lk1StationExclusionsKey = ${JSON.stringify(LK1_STATION_EXCLUSIONS_KEY)};
const lk1DesiredStationExclusions = ${JSON.stringify(next)};
const lk1NormalizeStationExclusions = value => (${normalizeStationExclusionsGlobal.toString()})(value);
`;
  const initialize = declarations + `const lk1StationExclusionsExpectedPrior = ${JSON.stringify(prior)};
const lk1StationExclusionsCurrent = lk1NormalizeStationExclusions(global.get(lk1StationExclusionsKey));
if (JSON.stringify(lk1StationExclusionsCurrent) !== JSON.stringify(lk1DesiredStationExclusions)) {
  if (JSON.stringify(lk1StationExclusionsCurrent) !== JSON.stringify(lk1StationExclusionsExpectedPrior)) throw new Error("station exclusions prior mismatch; no overwrite");
  global.set(lk1StationExclusionsKey, lk1DesiredStationExclusions);
}
if (JSON.stringify(lk1NormalizeStationExclusions(global.get(lk1StationExclusionsKey))) !== JSON.stringify(lk1DesiredStationExclusions)) {
  throw new Error("station exclusions readback mismatch");
}
`;
  return { expectedPrior: prior, desired: next, initialize };
}
