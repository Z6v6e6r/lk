import fs from 'node:fs';
import crypto from 'node:crypto';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

const root = new URL('../', import.meta.url);
const read = file => fs.readFileSync(new URL(file, root), 'utf8');
const sha = source => crypto.createHash('sha256').update(source).digest('hex');
const prefix = 'lk_subscription_price_preview_20260908_';
export const ERROR_CAUSE_PREIMAGES = Object.freeze({
  auth_consent_prepare_20260714: 'f718b13e4318fc8a8ca064935e0a3c34ad5df872504e2df340bba1fe53f700b3',
  auth_consent_build_upsert_20260714: 'a4012db9a91fa438567bcf9fca9daac413f3680c6666f78bae5e9c7b117b6841',
  [prefix + 'router']: 'dbc2f7d403ec26e83f78d620b82d21b49bd0583c2b43ee1238ee8f5e07623ff7',
  [prefix + 'final']: '929268dd238c01b9b3ac03437dccbc852838ef0e9408cbc4e3dd7a0760e7d062',
  '9ec08e9a627fa3e2': '4190fbc2200b9a05b9ccb882dc9d5c24cf6eb3eb3e37b6f29b70dafb2c457bbd',
});
const segment = (source, start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0 || source.indexOf(start, from + start.length) >= 0) throw new Error('Source segment drift');
  return source.slice(from, to);
};

// Pure, offline composition: never imports, deploys, calls a provider, or writes a flow.
// The caller must supply the separately reviewed, fresh whole-source digest.
export function composeErrorCauseCandidate(liveBytes, deploymentId, { expectedSourceSha256, pins = ERROR_CAUSE_PREIMAGES } = {}) {
  if (!/^[a-f0-9]{64}$/.test(expectedSourceSha256 || '') || sha(liveBytes) !== expectedSourceSha256) {
    throw new Error('Error-cause source preimage drift');
  }
  const candidate = JSON.parse(Buffer.from(liveBytes).toString('utf8'));
  if (!Array.isArray(candidate) || candidate.some(n => !n || typeof n.id !== 'string')
    || new Set(candidate.map(n => n.id)).size !== candidate.length) throw new Error('Invalid source flow');
  const node = id => {
    const n = candidate.find(n => n.id === id);
    if (!n) throw new Error(`Missing target ${id}`);
    return n;
  };
  const changes = [];
  for (const id of Object.keys(ERROR_CAUSE_PREIMAGES)) {
    const n = node(id);
    if (n.type !== 'function' || !pins[id] || sha(n.func || '') !== pins[id]) throw new Error(`Function preimage drift: ${id}`);
  }
  const replaceFunction = (id, source) => {
    new Function('msg', 'node', source);
    node(id).func = source;
    changes.push({ id, fields: ['func'] });
  };
  replaceFunction('auth_consent_prepare_20260714', read('scripts/nodered_auth_consent_nodes/fn_auth_consent_prepare.js'));
  replaceFunction('auth_consent_build_upsert_20260714', read('scripts/nodered_auth_consent_nodes/fn_auth_consent_build_upsert.js'));
  const userinfo = node('auth_consent_userinfo_20260714');
  if (userinfo.type !== 'http request' || userinfo.method !== 'use' || userinfo.ret !== 'obj' || userinfo.url !== '') throw new Error('Userinfo HTTP preimage drift');
  userinfo.ret = 'txt';
  changes.push({ id: userinfo.id, fields: ['ret'] });

  const guardStart = "if (ctx.step === 'groupExercise') {";
  const guardEnd = '  ctx.exercise = exercise;';
  const router = node(prefix + 'router');
  const oldGuard = segment(router.func, guardStart, guardEnd);
  const newGuard = segment(read('scripts/nodered_subscription_price_preview_nodes/router.js'), guardStart, guardEnd);
  replaceFunction(router.id, router.func.replace(oldGuard, newGuard));
  replaceFunction(prefix + 'final', read('scripts/nodered_subscription_price_preview_nodes/final.js'));
  const http = node(prefix + 'http');
  if (http.type !== 'http request' || http.method !== 'GET' || http.ret !== 'obj' || http.url !== '') throw new Error('Preview HTTP preimage drift');
  http.method = 'use';
  changes.push({ id: http.id, fields: ['method'] });

  const list = node('9ec08e9a627fa3e2');
  const helperStart = 'const resolveCommunityLogoFields =';
  const helperEnd = 'const normalizeCommunityForResponse =';
  const oldHelper = segment(list.func, helperStart, helperEnd);
  const newHelper = segment(read('scripts/patch_nodered_communities_flow.mjs'), helperStart, helperEnd);
  replaceFunction(list.id, list.func.replace(oldHelper, newHelper));

  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId, allowedChanges: changes });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidate, candidateBytes, contract, changedNodeIds: changes.map(n => n.id) };
}
