import fs from 'node:fs';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

export const startHash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const prefix = 'fpr_canonical_start_20261106_';
const id = name => prefix + name;
const read = name => fs.readFileSync(new URL(`./nodered_fpr_start_nodes/${name}.js`, import.meta.url), 'utf8');

/** Offline candidate only. Never connects/imports/restarts Node-RED. */
export function patchFprCanonicalStart(bytes, contract, sources = {}) {
  if (startHash(bytes) !== contract.flowSha256) throw Error('FPR_START_FLOW_PREIMAGE');
  const flow = JSON.parse(bytes), original = structuredClone(flow);
  if (!Array.isArray(flow) || new Set(flow.map(n => n.id)).size !== flow.length || flow.some(n => n.id.startsWith(prefix))) throw Error('FPR_START_FLOW_SHAPE');
  const lookup = (entry, type) => {
    const n = flow.find(n => n.id === entry?.id);
    if (!n || n.type !== type || startHash(JSON.stringify(n)) !== entry.sha256) throw Error('FPR_START_NODE_PREIMAGE');
    return n;
  };
  const route = lookup(contract.createRoute, 'http in'), prepare = lookup(contract.prepare, 'function');
  const mongo = lookup(contract.mongoClient, 'mongodb4-client');
  if (String(route.method).toLowerCase() !== 'post' || route.url !== '/lk/tournaments/americano' || !prepare.func.includes('FPR_6X25_DISPATCH_V1 (prepare)')
    || !Array.isArray(route.wires) || route.wires.length !== 1 || route.wires[0].filter(target=>target===prepare.id).length !== 1
    || route.z !== prepare.z) throw Error('FPR_START_CREATE_GRAPH');
  if (flow.some(n => n.type === 'http in' && n.url === '/lk/tournaments/fpr/start-ratings')) throw Error('FPR_START_ROUTE_COLLISION');
  const z = route.z;
  const fn = (name, source, outputs, wires) => ({ id: id(name), type: 'function', z, name: `FPR canonical ${name}`, func: source, outputs, timeout: '', noerr: 0, initialize: '', finalize: '', libs: [], wires, x: 500, y: 2800 });
  const nodes = [
    { id: id('read'), type: 'http in', z, name: 'FPR canonical start ratings', url: '/lk/tournaments/fpr/start-ratings', method: 'post', upload: false, swaggerDoc: '', wires: [[id('prepare')]], x: 200, y: 2800 },
    { id: id('options'), type: 'http in', z, name: 'FPR canonical start options', url: '/lk/tournaments/fpr/start-ratings', method: 'options', upload: false, swaggerDoc: '', wires: [[id('cors')]], x: 200, y: 2860 },
    fn('cors', `msg.statusCode=204; msg.headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Cache-Control':'no-store'}; msg.payload=''; return msg;`, 1, [[id('response')]]),
    fn('create', 'msg._fprStartCreate = true; return msg;', 1, [[id('prepare')]]),
    fn('prepare', sources.prepare || read('prepare'), 3, [[id('profile')], [prepare.id], [id('response')]]),
    { id: id('profile'), type: 'http request', z, name: 'Verify FPR hosting profile', method: 'use', ret: 'obj', paytoqs: 'ignore', url: '', persist: false, insecureHTTPParser: false, requestTimeout: '10000', wires: [[id('authorize')]], x: 800, y: 2800 },
    fn('authorize', sources.authorize || read('authorize'), 2, [[id('find')], [id('response')]]),
    { id: id('find'), type: 'mongodb4', z, name: 'Read canonical FPR start levels', clientNode: mongo.id, mode: 'collection', collection: 'player_rating_state', operation: 'find', output: 'toArray', maxTimeMS: '5000', handleDocId: false, wires: [[id('resolve')]], x: 1100, y: 2800 },
    fn('resolve', sources.resolve || read('resolve'), 2, [[prepare.id], [id('response')]]),
    { id: id('catch'), type: 'catch', z, name: 'Catch FPR canonical read errors', scope: ['prepare','profile','authorize','find','resolve'].map(id), uncaught: false, wires: [[id('error')]], x: 800, y: 2920 },
    fn('error', sources.error || read('error'), 1, [[id('response')]]),
    { id: id('response'), type: 'http response', z, name: 'FPR canonical response', statusCode: '', headers: {}, wires: [], x: 1400, y: 2860 },
  ];
  for (const n of nodes.filter(n => n.type === 'function')) new Function('msg', n.func);
  route.wires = route.wires.map(output=>output.map(target=>target===prepare.id ? id('create') : target));
  if (original.some((n,i) => !isDeepStrictEqual(n, flow[i]) && (n.id !== route.id || !isDeepStrictEqual({ ...flow[i], wires:n.wires }, n)))) throw Error('FPR_START_FOREIGN_CHANGE');
  flow.push(...nodes);
  const ids = new Set(flow.map(n=>n.id));
  if (nodes.some(n=>(n.wires||[]).flat().some(target=>!ids.has(target)))) throw Error('FPR_START_DANGLING_WIRE');
  return { output: JSON.stringify(flow, null, 2)+'\n', report: { beforeSha256:contract.flowSha256, addedNodes:nodes.map(n=>n.id), changedNodes:[route.id], ordinaryCreateUnchanged:true } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || new Set(args).size !== 4) throw Error('Usage: input.json contract.json NEW-candidate.json NEW-report.json');
  const [input, contract, output, report] = args;
  if (fs.existsSync(output) || fs.existsSync(report)) throw Error('Use new output paths');
  const result = patchFprCanonicalStart(fs.readFileSync(input), JSON.parse(fs.readFileSync(contract,'utf8')));
  fs.writeFileSync(output,result.output,{flag:'wx',mode:0o600});
  fs.writeFileSync(report,JSON.stringify(result.report,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify(result.report));
}
