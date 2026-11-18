import { isDeepStrictEqual } from 'node:util';
import { prepareSupportPhotos, SUPPORT_PHOTO_PREIMAGE_IDS } from './prepare_support_photos.mjs';
import { sha256 } from './nodered_max_outbox_resume.mjs';

export const PHOTO_POLLERS = Object.freeze(['e75785ffa19c2e20', 'c1ecd06ce451751b']);
export const PHOTO_FIELDS = Object.freeze([
  { id: 'abccacd291f24659', fields: ['wires'] },
  { id: '1a27d9a916e742a0', fields: ['wires'] },
  { id: '0006d5707259bc5b', fields: ['func'] },
  { id: '47c460de0db646e6', fields: ['func'] },
  { id: 'max_new_outbox_send_main', fields: ['type'] },
  { id: 'max_new_outbox_send_academy', fields: ['type'] },
  { id: '0b0670d7eeec9cb5', fields: ['func', 'wires'] },
  { id: '6f399ab785a116d2', fields: ['func'] },
]);
export const PHOTO_ADDITIONS = Object.freeze(['support_photo_prepare', 'support_photo_prepared',
  'support_photo_resolve', 'support_photo_resolved', 'support_photo_error', 'support_photo_debug',
  'support_photo_prepare_http', 'support_photo_resolve_http', 'support_photo_catch']);
export const PHOTO_PURPOSES = Object.freeze(['pause', 'install', 'resume', 'pause-photo', 'recover']);
const need = (value, code) => { if (!value) throw Error(code); };
const encoded = flow => JSON.stringify(flow, null, 2) + '\n';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const equal = (a, b) => isDeepStrictEqual(canonical(a), canonical(b));
export const PHOTO_REQUIRED_IDS = Object.freeze([...SUPPORT_PHOTO_PREIMAGE_IDS, ...PHOTO_POLLERS]);

export function photoPins(raw) {
  const flow = JSON.parse(String(raw));
  need(Array.isArray(flow) && flow.every(n => n && typeof n.id === 'string')
    && new Set(flow.map(n => n.id)).size === flow.length, 'PHOTON_SOURCE_IDS');
  return { flowSha256: sha256(raw), nodes: Object.fromEntries(PHOTO_REQUIRED_IDS.map(id => {
    const node = flow.find(n => n.id === id); need(node, 'PHOTON_REQUIRED_NODE');
    return [id, sha256(JSON.stringify(node))];
  })) };
}

/** Pure construction from the original ACTIVE protected snapshot. No live IO. */
export function buildSupportPhotoStates(original, pins) {
  need(equal(photoPins(original), pins), 'PHOTON_ORIGINAL_PINS');
  const originalActive = JSON.parse(String(original));
  for (const id of PHOTO_POLLERS) {
    const node = originalActive.find(n => n.id === id);
    need(node.type === 'inject' && node.d === false, 'PHOTON_ACTIVE_POLLERS_REQUIRED');
  }
  const built = prepareSupportPhotos(original, pins);
  need(equal(built.changedIds, SUPPORT_PHOTO_PREIMAGE_IDS) && equal(built.addedIds, PHOTO_ADDITIONS), 'PHOTON_BUILDER_SCOPE');
  const photoActive = JSON.parse(built.candidate);
  const pause = flow => flow.map(node => PHOTO_POLLERS.includes(node.id) ? { ...node, d: true } : structuredClone(node));
  return { originalActive, originalPaused: pause(originalActive), photoActive, photoPaused: pause(photoActive) };
}

export function buildSupportPhotoTransition(current, original, pins, purpose) {
  need(PHOTO_PURPOSES.includes(purpose), 'PHOTON_PURPOSE');
  const states = buildSupportPhotoStates(original, pins);
  const pairs = { pause: ['originalActive', 'originalPaused'], install: ['originalPaused', 'photoPaused'],
    resume: ['photoPaused', 'photoActive'], 'pause-photo': ['photoActive', 'photoPaused'], recover: ['photoPaused', 'originalPaused'] };
  const [pre, post] = pairs[purpose], before = JSON.parse(String(current));
  need(equal(before, states[pre]), 'PHOTON_CURRENT_SOURCE_DRIFT');
  const flow = structuredClone(states[post]), operations = supportPhotoOperations(before, flow, purpose);
  return { purpose, flow, candidateJson: encoded(flow), sourceSha256: sha256(current),
    changedIds: operations.edits.map(e => e.id), addedIds: operations.additions.map(n => n.id),
    removedIds: operations.removals, liveFlowWritten: false };
}

export function supportPhotoOperations(before, after, purpose) {
  need(PHOTO_PURPOSES.includes(purpose), 'PHOTON_PURPOSE');
  const flags = ['pause', 'resume', 'pause-photo'].includes(purpose);
  const scope = flags ? PHOTO_POLLERS.map(id => ({ id, fields: ['d'] })) : PHOTO_FIELDS;
  const by = new Map(before.map(n => [n.id, n])), post = new Map(after.map(n => [n.id, n]));
  need(by.size === before.length && post.size === after.length, 'PHOTON_OPERATION_IDS');
  const edits = [];
  for (const [id, node] of by) {
    if (!post.has(id)) { need(purpose === 'recover' && PHOTO_ADDITIONS.includes(id), 'PHOTON_REMOVAL_SCOPE'); continue; }
    const target = post.get(id), keys = [...new Set([...Object.keys(node), ...Object.keys(target)])]
      .filter(k => !isDeepStrictEqual(node[k], target[k])).sort();
    if (!keys.length) continue;
    const allowed = scope.find(s => s.id === id);
    need(allowed && keys.every(k => allowed.fields.includes(k)), 'PHOTON_EDIT_SCOPE');
    if (flags) need(keys.length === 1 && keys[0] === 'd' && typeof node.d === 'boolean'
      && target.d === (purpose !== 'resume') && node.d !== target.d, 'PHOTON_FLAG_TRANSITION');
    edits.push({ id, set: Object.fromEntries(keys.filter(k => Object.hasOwn(target, k)).map(k => [k, target[k]])),
      unset: keys.filter(k => !Object.hasOwn(target, k)) });
  }
  const additions = after.filter(n => !by.has(n.id)), removals = before.filter(n => !post.has(n.id)).map(n => n.id);
  need(edits.length === scope.length && equal(edits.map(e => e.id).sort(), scope.map(s => s.id).sort()), 'PHOTON_EDIT_SET');
  need(equal(additions.map(n => n.id), purpose === 'install' ? PHOTO_ADDITIONS : [])
    && equal(removals, purpose === 'recover' ? PHOTO_ADDITIONS : []), 'PHOTON_ADDITION_SET');
  need(equal(before.filter(n => !removals.includes(n.id)).map(n => n.id), after.filter(n => by.has(n.id)).map(n => n.id)),
    'PHOTON_EXISTING_ORDER');
  if (purpose === 'install') need(equal(after.slice(-PHOTO_ADDITIONS.length).map(n => n.id), PHOTO_ADDITIONS), 'PHOTON_SUFFIX');
  if (!flags) need(PHOTO_POLLERS.every(id => by.get(id)?.d === true && post.get(id)?.d === true), 'PHOTON_CONSUMERS_NOT_PAUSED');
  return { purpose, edits, additions: structuredClone(additions), removals };
}
