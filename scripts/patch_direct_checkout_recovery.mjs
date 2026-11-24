import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const FRIENDSHIP_TWO_HOURS = '6b98e7e3-5bd3-4e94-9dc3-7723ea52513e';
const RA = 'b91e14d1-fe6e-4d0b-be39-3e45ad86b759';
const installedPrefix = {
  prepare: '28680b6873d65b45299db3fe01be4ede451cc071422f84c9818efa443ba9ce74',
  resolve: 'fecef9101c089ec54c571a1c31515a4b1cf0169cdacb4a2da9f0b526f04dba91',
  router: '34180ac4e483bcd00c4456e59098e683d894b571781c77c4c06ec38d777ec322',
};
// Normalized prefixes of the reviewed frozen-proof generation, before version 2.
const installedFrozenPrefix = {
  prepare: 'b66ca795a6e4079563459849d8a76e3ef9283dd182aad9ad810915fd646e6592',
  resolve: '58f0f7dd6a572cab612686e6a1ce27546050fb2caf52c7b7196cad47f8962db9',
  router: '9b76abe384a3953bae5966c43763846ddff5bd9ead6fb7ec8390e7a223d10c93',
};
const directory = new URL('./nodered_direct_checkout_recovery_nodes/', import.meta.url);
export const DIRECT_RECOVERY_NODES = {
  prepare: { id: '1da9af2cb4f7db52', outputs: 3, preimage: '99bfb856eaef7891ac1fdd88c2421b12859527adb8011778bba5ee0e954a4873' },
  resolve: { id: 'ca022fd14027a5b0', outputs: 5, preimage: '98b13ab70475b6d1849042bfbbd3add78f46091bb9d14eb40bdd2912ff6a2e2a' },
  router: { id: '566ae4b886c37ae5', outputs: 5, preimage: '917dd30375dab1602a311d61be3d6d024d4925d8ab21e642cce166f9a6983e91' },
};
export function verifyDirectTopology(flow, expectedHeadersSha256 = '798486fd162b938f3bc24a9f1e71aaaa37ca41ef1a9cec4281673d639cb31bfc') {
  const by = new Map(flow.map(n => [n.id,n])), tab = by.get('f9575c8726e29196');
  if (!tab || tab.type !== 'tab' || tab.disabled !== false) throw Error('Direct recovery owner tab is not active');
  const wires = {
    '80379d333be8dfca': [['1da9af2cb4f7db52']],
    '1da9af2cb4f7db52': [['a1ca8b5eca626475'],['10fe94a32b8adc35'],['03cc3ac17f7e154a']],
    'a1ca8b5eca626475': [['ca022fd14027a5b0']],
    'ca022fd14027a5b0': [['fdc3f25f39199546'],['10fe94a32b8adc35'],['03cc3ac17f7e154a'],['piter_atomic_router_20260903'],['subscription_poll_admit_20260914']],
    'fdc3f25f39199546': [['566ae4b886c37ae5']],
    '566ae4b886c37ae5': [['fdc3f25f39199546'],['57ec7b72ef16e3a3'],['10fe94a32b8adc35'],['03cc3ac17f7e154a'],['piter_atomic_router_20260903']],
  };
  for (const [id,expected] of Object.entries(wires)) {
    const node = by.get(id);
    if (!node || node.z !== tab.id || node.d || node.disabled || JSON.stringify(node.wires) !== JSON.stringify(expected)) throw Error('Direct recovery topology drift: '+id);
  }
  const input = by.get('80379d333be8dfca'),mongo = by.get('a1ca8b5eca626475'),http = by.get('fdc3f25f39199546');
  if (input.type !== 'http in' || input.method !== 'post' || input.url !== '/lk/tournaments/summer-subscription/confirm'
    || mongo.type !== 'mongodb4' || mongo.mode !== 'collection' || mongo.collection !== 'lk_tournament_subscription_sales' || mongo.operation !== 'find'
    || http.type !== 'http request' || http.method !== 'use' || http.ret !== 'obj' || http.url !== '' || http.authType !== '' || http.senderr !== true || http.persist !== false
    || http.insecureHTTPParser !== false || http.httpProxy
    || (http.headers || []).some(h => h.keyType !== 'other' || h.keyValue !== 'User-Agent' || h.valueType !== 'other' || typeof h.valueValue !== 'string')
    || sha(JSON.stringify(http.headers || [])) !== expectedHeadersSha256) throw Error('Direct recovery transport contract drift');
  const response = by.get('10fe94a32b8adc35');
  if (!response || response.type !== 'http response' || response.z !== tab.id || response.d || response.disabled || response.wires?.some(port => port.length)) throw Error('Direct recovery response target drift');
  const sensitive = new Set([...Object.keys(wires),response.id]);
  if (flow.some(n => n.type === 'catch' && n.z === tab.id && !n.d
    && (!Array.isArray(n.scope) || n.scope.some(id => sensitive.has(id))))) throw Error('Direct recovery catch custody changed');
}
const uuid = x => typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
const iso = x => typeof x === 'string' && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
export function validateDirectProofs(config) {
  if (!config || Object.keys(config).sort().join() !== ['schemaVersion','productId','cutoff','observedAt','operationId','proofs'].sort().join()
    || config.schemaVersion !== 1 || ![FRIENDSHIP_TWO_HOURS, RA].includes(config.productId) || !uuid(config.operationId)
    || !iso(config.cutoff) || !iso(config.observedAt) || Date.parse(config.cutoff) > Date.parse(config.observedAt) - 26 * 60000
    || Date.parse(config.observedAt) > Date.now() || !config.proofs || Array.isArray(config.proofs) || typeof config.proofs !== 'object'
    || Object.keys(config.proofs).length < 1 || Object.keys(config.proofs).length > (config.productId === RA ? 500 : 100)) throw Error('Invalid bounded direct recovery proof set');
  for (const [key,proof] of Object.entries(config.proofs)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !proof || Object.keys(proof).sort().join() !== ['ownerBinding','paymentBinding','legsBinding','createdAt','expiresAt'].sort().join()
      || !['ownerBinding','paymentBinding','legsBinding'].every(k => typeof proof[k] === 'string' && /^[a-f0-9]{64}$/.test(proof[k]))
      || !['createdAt','expiresAt'].every(k => typeof proof[k] === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(proof[k]) && Number.isFinite(Date.parse(proof[k])))
      || Date.parse(proof.createdAt) >= Date.parse(config.cutoff)) throw Error('Invalid direct recovery fingerprint');
  }
  return config;
}
function recoveryPrefix(kind, liveRa, configs) {
  if (!DIRECT_RECOVERY_NODES[kind]) throw Error('Unknown recovery stage');
  const common = fs.readFileSync(new URL('common.js',directory),'utf8').replace('__DIRECT_CHECKOUT_LIVE_RA__', String(liveRa));
  let block = fs.readFileSync(new URL(kind+'.js',directory),'utf8');
  if (kind === 'resolve') block = block.replace('__DIRECT_CHECKOUT_PROOFS__', JSON.stringify(configs.map(validateDirectProofs)));
  return '// BEGIN bounded direct checkout recovery '+kind+'\n'+common+'\n'+block+'// END bounded direct checkout recovery '+kind+'\n';
}
export function directRecoveryPrefix(kind, ...configs) {
  return recoveryPrefix(kind, false, configs);
}

export function liveRaRecoveryPrefix(kind, ...configs) {
  return recoveryPrefix(kind, true, configs);
}

export function patchDirectRecoveryBody(kind,body,config,expected=DIRECT_RECOVERY_NODES[kind]?.preimage) {
  if (sha(body)!==expected || body.includes('// BEGIN bounded direct checkout recovery')) throw Error('Direct recovery source preimage drift');
  const result=directRecoveryPrefix(kind,config)+body;
  new Function('msg','env','global','node','flow',result);
  return result;
}
function readInstalledStage(kind, body, requireRa = false) {
  const end = '// END bounded direct checkout recovery ' + kind + '\n';
  const split = body.indexOf(end);
  if (split < 0) throw Error('Installed direct recovery prefix missing: ' + kind);
  const prefix = body.slice(0, split + end.length);
  const suffix = body.slice(prefix.length);
  const match = kind === 'resolve' ? /,(config|configs)=(\{[^\n]+\}|\[[^\n]+\]);/.exec(prefix) : null;
  const saved = match ? JSON.parse(match[2]) : null;
  const configs = Array.isArray(saved) ? saved : saved ? [saved] : [];
  if (kind === 'resolve' && (configs.length !== (requireRa ? 2 : 1) || configs[0]?.productId !== FRIENDSHIP_TWO_HOURS
    || requireRa && configs[1]?.productId !== RA)) throw Error('Installed checkout proof sets mismatch');
  configs.forEach(validateDirectProofs);
  const normalized = match ? prefix.replace(match[0], ',config=__DIRECT_CHECKOUT_PROOFS__;') : prefix;
  const historical = (!match || match[1] === 'config') && sha(normalized) === installedPrefix[kind];
  const frozen = sha(normalized) === installedFrozenPrefix[kind];
  const reviewed = frozen || historical && (!requireRa || kind === 'prepare');
  if (!reviewed && prefix !== directRecoveryPrefix(kind, ...configs)) {
    throw Error('Installed direct recovery prefix drift: ' + kind);
  }
  if (requireRa && sha(suffix)!==DIRECT_RECOVERY_NODES[kind].preimage) throw Error('Direct recovery legacy suffix drift: ' + kind);
  return { suffix, config: configs[0] ?? null, configs };
}

export function extendDirectRecovery(flow, raConfig) {
  if (validateDirectProofs(raConfig).productId !== RA) throw Error('Expected RA proof set');
  verifyDirectTopology(flow);
  const node = kind => {
    const spec = DIRECT_RECOVERY_NODES[kind];
    const result = flow.find(item => item.id === spec.id);
    if (result?.type !== 'function' || result.outputs !== spec.outputs) throw Error('Direct recovery node contract drift');
    return result;
  };
  readInstalledStage('prepare', node('prepare').func);
  const resolve = readInstalledStage('resolve', node('resolve').func);
  const router = readInstalledStage('router', node('router').func);
  const replacement = new Map();
  for (const [kind,stage] of Object.entries({resolve,router})) {
    const func = directRecoveryPrefix(kind, resolve.config, raConfig) + stage.suffix;
    new Function('msg','env','global','node','flow',func);
    replacement.set(node(kind).id, func);
  }
  return flow.map(item => replacement.has(item.id) ? {...item,func:replacement.get(item.id)} : item);
}

export function enableLiveRaRecovery(flow) {
  verifyDirectTopology(flow);
  const stages = new Map();
  for (const [kind, spec] of Object.entries(DIRECT_RECOVERY_NODES)) {
    const node = flow.find(item => item.id === spec.id);
    if (node?.type !== 'function' || node.outputs !== spec.outputs) throw Error('Direct recovery node contract drift');
    stages.set(kind, readInstalledStage(kind, node.func, true));
  }
  const configs = stages.get('resolve').configs;
  const replacements = new Map();
  for (const [kind, stage] of stages) {
    const func = liveRaRecoveryPrefix(kind, ...configs) + stage.suffix;
    new Function('msg','env','global','node','flow',func);
    replacements.set(DIRECT_RECOVERY_NODES[kind].id, func);
  }
  return flow.map(node => replacements.has(node.id) ? { ...node, func: replacements.get(node.id) } : node);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const extend = args[0] === '--extend-ra';
  const liveRa = args[0] === '--enable-ra-live';
  const [workspace, proofPath, output] = liveRa ? [args[1], null, args[2]] : extend ? args.slice(1) : args;
  if (!workspace || !output || (!liveRa && !proofPath) || fs.existsSync(output)) {
    throw Error('Usage: --enable-ra-live <fresh live workspace> <new candidate> OR [--extend-ra] <fresh live workspace> <private frozen proofs> <new candidate>');
  }
  let config;
  if (proofPath) {
    const st=fs.lstatSync(proofPath);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink!==1 || (st.mode&0o777)!==0o600 || st.uid!==process.getuid()) throw Error('Unsafe private proof file');
    config=validateDirectProofs(JSON.parse(fs.readFileSync(proofPath,'utf8')));
  }
  const verified=verifyWorkspace(workspace);
  const source=JSON.parse(fs.readFileSync(path.join(verified.workspace,'input/source.flow.json'),'utf8'));
  let flow;
  if (liveRa) {
    flow=enableLiveRaRecovery(source);
  } else if (extend) {
    flow=extendDirectRecovery(source,config);
  } else {
    if (config.productId !== FRIENDSHIP_TWO_HOURS) throw Error('Initial overlay requires Friendship 2.0');
    verifyDirectTopology(source);
    flow=source.map(node => {
      const kind=Object.keys(DIRECT_RECOVERY_NODES).find(key => DIRECT_RECOVERY_NODES[key].id === node.id);
      if(!kind)return node;
      if(node.type!=='function'||node.outputs!==DIRECT_RECOVERY_NODES[kind].outputs)throw Error('Direct recovery node contract drift');
      return {...node,func:patchDirectRecoveryBody(kind,node.func,config)};
    });
  }
  fs.writeFileSync(output,JSON.stringify(flow,null,2)+'\n',{mode:0o600,flag:'wx'});
  const changedNodeIds=flow.filter((node,index)=>node!==source[index]).map(node=>node.id);
  console.log(JSON.stringify({changedNodeIds,...(config?{proofSetSha256:sha(JSON.stringify(config)),proofCount:Object.keys(config.proofs).length}:{}),candidateSha256:sha(fs.readFileSync(output))}));
}
