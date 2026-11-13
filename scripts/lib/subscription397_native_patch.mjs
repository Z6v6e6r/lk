// Public exact source edits only. Embedded unchanged in the browser guard.
export const SUBSCRIPTION397_IDS = ['lk_subscription_booking_router_20260804', 'lk_subscription_price_preview_20260908_router'];
export function applySubscription397Body(source, edits, reverse = false) {
  if (typeof source !== 'string' || !Array.isArray(edits) || !edits.length
    || edits.some(e => !Array.isArray(e) || e.length !== 2 || e.some(x => typeof x !== 'string' || !x))) throw Error('S397_PATCH_ARTIFACT');
  const order = reverse ? [...edits].reverse().map(([a, b]) => [b, a]) : edits;
  let result = source;
  for (const [before, after] of order) {
    if (result.split(before).length !== 2) throw Error('S397_ANCHOR_DRIFT');
    result = result.replace(before, () => after);
  }
  // Every installed source edit must be byte-reversible.
  let inverse = result;
  for (const [before, after] of [...order].reverse()) {
    if (inverse.split(after).length !== 2) throw Error('S397_INVERSE_DRIFT');
    inverse = inverse.replace(after, () => before);
  }
  if (inverse !== source) throw Error('S397_INVERSE_DRIFT');
  return result;
}
export function validateSubscription397Artifact(artifact) {
  if (!artifact || Object.keys(artifact).sort().join(',') !== [...SUBSCRIPTION397_IDS].sort().join(',')
    || SUBSCRIPTION397_IDS.some(id => !Array.isArray(artifact[id]) || !artifact[id].length)) throw Error('S397_ARTIFACT_SCOPE');
  return artifact;
}
