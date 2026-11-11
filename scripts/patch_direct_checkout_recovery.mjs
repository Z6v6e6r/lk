import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
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
    || config.schemaVersion !== 1 || config.productId !== '6b98e7e3-5bd3-4e94-9dc3-7723ea52513e' || !uuid(config.operationId)
    || !iso(config.cutoff) || !iso(config.observedAt) || Date.parse(config.cutoff) > Date.parse(config.observedAt) - 26 * 60000
    || Date.parse(config.observedAt) > Date.now() || !config.proofs || Array.isArray(config.proofs) || typeof config.proofs !== 'object'
    || Object.keys(config.proofs).length < 1 || Object.keys(config.proofs).length > 100) throw Error('Invalid bounded direct recovery proof set');
  for (const [key,proof] of Object.entries(config.proofs)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !proof || Object.keys(proof).sort().join() !== ['ownerBinding','paymentBinding','legsBinding','createdAt','expiresAt'].sort().join()
      || !['ownerBinding','paymentBinding','legsBinding'].every(k => typeof proof[k] === 'string' && /^[a-f0-9]{64}$/.test(proof[k]))
      || !['createdAt','expiresAt'].every(k => typeof proof[k] === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(proof[k]) && Number.isFinite(Date.parse(proof[k])))
      || Date.parse(proof.createdAt) >= Date.parse(config.cutoff)) throw Error('Invalid direct recovery fingerprint');
  }
  return config;
}
export function directRecoveryPrefix(kind,config) {
  if (!DIRECT_RECOVERY_NODES[kind]) throw Error('Unknown recovery stage');
  const common = fs.readFileSync(new URL('common.js',directory),'utf8');
  let block = fs.readFileSync(new URL(kind+'.js',directory),'utf8');
  if (kind === 'resolve') block = block.replace('__DIRECT_CHECKOUT_PROOFS__', JSON.stringify(validateDirectProofs(config)));
  return '// BEGIN bounded direct checkout recovery '+kind+'\n'+common+'\n'+block+'// END bounded direct checkout recovery '+kind+'\n';
}
export function patchDirectRecoveryBody(kind,body,config,expected=DIRECT_RECOVERY_NODES[kind]?.preimage) {
  if (sha(body)!==expected || body.includes('// BEGIN bounded direct checkout recovery')) throw Error('Direct recovery source preimage drift');
  const result=directRecoveryPrefix(kind,config)+body;
  new Function('msg','env','global','node','flow',result);
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [workspace,proofPath,output] = process.argv.slice(2);
  if (!workspace || !proofPath || !output || fs.existsSync(output)) throw Error('Usage: <fresh live workspace> <private frozen proofs> <new candidate>');
  const st=fs.lstatSync(proofPath);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink!==1 || (st.mode&0o777)!==0o600 || st.uid!==process.getuid()) throw Error('Unsafe private proof file');
  const config=validateDirectProofs(JSON.parse(fs.readFileSync(proofPath,'utf8'))),verified=verifyWorkspace(workspace);
  const flow=JSON.parse(fs.readFileSync(path.join(verified.workspace,'input/source.flow.json'),'utf8'));
  verifyDirectTopology(flow);
  for(const [kind,contract] of Object.entries(DIRECT_RECOVERY_NODES)) {
    const node=flow.find(n=>n.id===contract.id);
    if(!node||node.type!=='function'||node.outputs!==contract.outputs)throw Error('Direct recovery node contract drift');
    node.func=patchDirectRecoveryBody(kind,node.func,config);
  }
  fs.writeFileSync(output,JSON.stringify(flow,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({changedNodeIds:Object.values(DIRECT_RECOVERY_NODES).map(n=>n.id),proofSetSha256:sha(JSON.stringify(config)),proofCount:Object.keys(config.proofs).length,candidateSha256:sha(fs.readFileSync(output))}));
}
