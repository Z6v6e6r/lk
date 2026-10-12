import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hashNode = (value) => sha(JSON.stringify(value));
export const contract = {
  tab: '4b91e2a2413688db',
  target: 'e0d7883bc1a9fa8c',
  targetFunctionSha: '4fb7d6ca9961e854cefb22f0752f9c1f921e1b6cbacfea3ce16e8b8681538931',
  routes: ['7ad34f13c4b25d60', '4cb1e542db56b508'],
  read: '8b64bb43086a39e1',
  readSha: 'b6d383271f2cbb545f6ce2b67102dc5e6abc2201cdfb6666fcdd991f2fc0b7c8',
  write: '591234d213742276',
  writeSha: '2431488c00119972c85a1d2847e3e1489466eb0aedb3461a72302fa0889ffa57',
  http: 'e17f8a411d4dfa91', debug: '3b822085d5f18e97', autojoin: '5fc5eaeab97f3f88',
};
export const ids = Object.fromEntries(['preflight', 'read', 'authorize', 'write', 'ack', 'catch'].map((key) => [key, `partner_roster_${key}_20261012`]));

export function buildGuard(flow, sources, expected = contract) {
  const out = structuredClone(flow);
  if (new Set(out.map((node) => node.id)).size !== out.length) throw new Error('Duplicate node IDs');
  const get = (id) => { const n = out.find((node) => node.id === id); if (!n) throw new Error(`Missing node ${id}`); return n; };
  const target = get(expected.target);
  if (target.type !== 'function' || target.z !== expected.tab || target.outputs !== 4
    || sha(target.func) !== expected.targetFunctionSha
    || JSON.stringify(target.wires) !== JSON.stringify([['b2a10027fc45966c'], [expected.http], [expected.debug], [expected.autojoin]])) throw new Error('Live Prepare game patch drift');
  const read = get(expected.read); const write = get(expected.write);
  if (hashNode(read) !== expected.readSha || hashNode(write) !== expected.writeSha
    || read.type !== 'mongodb4' || write.type !== 'mongodb4'
    || read.collection !== 'lk_games' || write.collection !== 'lk_games'
    || read.operation !== 'find' || write.operation !== 'updateOne'
    || read.clientNode !== write.clientNode || write.wires.some((wire) => wire.length)) throw new Error('Mongo node contract drift');
  expected.routes.forEach((id) => {
    const route = get(id);
    if (route.type !== 'http in' || route.method !== 'patch' || route.z !== expected.tab
      || !['/lk/games/:gameId', '/lk/games/records/:gameId'].includes(route.url)
      || JSON.stringify(route.wires) !== JSON.stringify([[expected.target]])) throw new Error('PATCH route drift');
    route.wires = [[ids.preflight]];
  });
  for (const id of Object.values(ids)) if (out.some((node) => node.id === id)) throw new Error('Guard already exists');
  const original = target.func;
  if (sources.wrapper.split('__LIVE_SOURCE__').length !== 2) throw new Error('Wrapper marker invalid');
  target.func = sources.wrapper.replace('__LIVE_SOURCE__', original);
  target.outputs = 5;
  target.wires = [...target.wires, [ids.write]];
  const fn = (id, name, func, wires) => ({ id, type: 'function', z: expected.tab, name, func, outputs: wires.length, timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [], x: 1000, y: 500, wires });
  out.push(fn(ids.preflight, 'Partner roster PATCH preflight', sources.preflight, [[expected.target], [ids.read]]));
  out.push({ ...structuredClone(read), id: ids.read, name: 'Read exact game for Partner roster guard', wires: [[ids.authorize]] });
  out.push(fn(ids.authorize, 'Authorize legacy roster PATCH', sources.authorize, [[expected.target], [expected.http, expected.debug]]));
  out.push({ ...structuredClone(write), id: ids.write, name: 'CAS guarded legacy roster PATCH', wires: [[ids.ack]] });
  out.push(fn(ids.ack, 'Partner roster PATCH ACK', sources.ack, [[expected.http], [expected.debug], [expected.autojoin]]));
  out.push({ id: ids.catch, type: 'catch', z: expected.tab, name: 'Partner roster guard errors', scope: [ids.read, ids.write], uncaught: false, x: 1000, y: 550, wires: [[ids.ack]] });
  // An error during the read has no success response. ACK fails closed to 503.
  const allowed = new Set([...expected.routes, expected.target]);
  flow.forEach((node, index) => {
    if (!allowed.has(node.id) && JSON.stringify(node) !== JSON.stringify(out[index])) throw new Error('Foreign node changed');
  });
  if (out.length !== flow.length + Object.keys(ids).length) throw new Error('Unexpected node count');
  const allIds = new Set(out.map((node) => node.id));
  for (const node of out) for (const wire of node.wires ?? []) for (const id of wire) if (!allIds.has(id)) throw new Error(`Dangling wire ${id}`);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, expectedSha, output] = process.argv.slice(2);
  if (!input || !/^[a-f0-9]{64}$/.test(expectedSha ?? '') || !output || !path.isAbsolute(input) || !path.isAbsolute(output)) throw new Error('Usage: node scripts/patch_partner_roster_guard.mjs /private/live/flows.json EXPECTED_SHA /private/new/candidate.json');
  const bytes = fs.readFileSync(input);
  if (sha(bytes) !== expectedSha || fs.existsSync(output)) throw new Error('Preimage mismatch or output exists');
  const sources = Object.fromEntries(['preflight', 'authorize', 'ack', 'wrapper'].map((name) => [name, fs.readFileSync(path.join(directory, 'nodered_partner_roster_nodes', `fn_${name}.js`), 'utf8')]));
  const candidate = Buffer.from(`${JSON.stringify(buildGuard(JSON.parse(bytes), sources), null, 2)}\n`);
  fs.writeFileSync(output, candidate, { mode: 0o600, flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ sourceSha256: expectedSha, candidateSha256: sha(candidate), addedNodes: Object.values(ids), changedNodes: [...contract.routes, contract.target], liveMutation: false })}\n`);
}
