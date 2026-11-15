import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = x => createHash('sha256').update(x).digest('hex');
const body = (folder, name) => fs.readFileSync(path.join(root, 'scripts', folder, name), 'utf8');
const ids = ['abccacd291f24659', '1a27d9a916e742a0', '0006d5707259bc5b', '47c460de0db646e6',
  'max_new_outbox_send_main', 'max_new_outbox_send_academy', '0b0670d7eeec9cb5', '6f399ab785a116d2'];
const need = (x, code) => { if (!x) throw Error(code); };
export const SUPPORT_PHOTO_PREIMAGE_IDS = Object.freeze(ids);

/** Pure local candidate construction. Raw flow/candidate stays outside Git. No imports/deploys. */
export function prepareSupportPhotos(bytes, pins) {
  need(sha(bytes) === pins.flowSha256, 'FLOW_PREIMAGE_DRIFT');
  const flow = JSON.parse(String(bytes)), by = new Map(flow.map(n => [n.id, n]));
  need(by.size === flow.length, 'DUPLICATE_NODE');
  for (const id of ids) need(by.has(id) && sha(JSON.stringify(by.get(id))) === pins.nodes[id], 'NODE_PREIMAGE_DRIFT');
  const incoming = by.get(ids[0]), history = by.get(ids[1]);
  const eventResponse = by.get(ids[6]);
  need(by.get(ids[7]).type === 'function' && by.get(ids[7]).z === incoming.z, 'EVENT_PREPARE_GRAPH_DRIFT');
  by.get(ids[7]).func = body('nodered_support_nodes', 'fn_support_event_prepare.js');
  need(incoming.type === 'http in' && incoming.method === 'post' && incoming.url === '/lk/support/dialogs/events' &&
    JSON.stringify(incoming.wires) === '[["6f399ab785a116d2"]]', 'INGRESS_GRAPH_DRIFT');
  need(history.type === 'function' && JSON.stringify(history.wires) === '[["9d2ab6d44c9ab611"],["ca7984daa2fe8824"]]' && history.z === incoming.z, 'HISTORY_GRAPH_DRIFT');
  need(eventResponse.type === 'function' && eventResponse.z === incoming.z &&
    JSON.stringify(eventResponse.wires) === '[["e2e7ac514b442d4a"],["d6cd11bef22dfad0"]]', 'EVENT_RESPONSE_GRAPH_DRIFT');
  for (const [dispatch, sender, bot] of [[ids[2], ids[4], 'a5d5eca27e9e56da'], [ids[3], ids[5], '55b05444842e7b84']]) {
    const d = by.get(dispatch), s = by.get(sender);
    need(d.type === 'function' && d.wires?.[0]?.length === 1 && d.wires[0][0] === sender &&
      s.type === 'maxbot-send' && s.d !== true && s.bot === bot, 'MAX_SENDER_GRAPH_DRIFT');
    d.func = body('nodered_max_nodes', 'fn_max_legacy_photo_dispatch_prepare.js');
    s.type = 'max-legacy-outbox-send';
  }
  const added = [], z = incoming.z;
  const add = (id, type, config) => { need(!by.has(id), 'PHOTO_ID_OCCUPIED'); const node = { id, type, z, ...config }; by.set(id, node); flow.push(node); added.push(id); };
  const fn = (id, file, outputs, wires) => add(id, 'function', { name: file, func: body('nodered_support_nodes', file + '.js'), outputs, wires, x: 1400, y: 900 });
  fn('support_photo_prepare', 'fn_support_photo_prepare', 3, [['6f399ab785a116d2'], ['support_photo_prepare_http'], ['e2e7ac514b442d4a']]);
  fn('support_photo_prepared', 'fn_support_photo_prepared', 2, [['6f399ab785a116d2'], ['e2e7ac514b442d4a']]);
  fn('support_photo_resolve', 'fn_support_photo_resolve', 3, [['9d2ab6d44c9ab611'], ['support_photo_resolve_http'], ['9d2ab6d44c9ab611']]);
  fn('support_photo_resolved', 'fn_support_photo_resolved', 1, [['9d2ab6d44c9ab611']]);
  fn('support_photo_error', 'fn_support_photo_error', 2, [['e2e7ac514b442d4a'], ['9d2ab6d44c9ab611']]);
  fn('support_photo_debug', 'fn_support_photo_debug', 1, [['ca7984daa2fe8824']]);
  for (const [id, next] of [['support_photo_prepare_http', 'support_photo_prepared'], ['support_photo_resolve_http', 'support_photo_resolved']]) {
    add(id, 'http request', { name: 'Private CUP support media', method: 'use', ret: 'obj', paytoqs: 'ignore',
      url: '', tls: '', persist: false, proxy: '', insecureHTTPParser: false, senderr: false, headers: [],
      x: 1600, y: 900, wires: [[next]] });
  }
  add('support_photo_catch', 'catch', { name: 'Private support media failure',
    scope: ['support_photo_prepare_http', 'support_photo_resolve_http'], uncaught: false, wires: [['support_photo_error']], x: 1400, y: 1000 });
  incoming.wires[0] = ['support_photo_prepare']; history.wires[0] = ['support_photo_resolve'];
  history.wires[1] = ['support_photo_debug'];
  eventResponse.func = body('nodered_support_nodes', 'fn_support_photo_event_response.js');
  eventResponse.wires[0] = ['support_photo_resolve'];
  const candidate = JSON.stringify(flow, null, 2) + '\n';
  return { candidate, changedIds: [...ids], addedIds: added, sha256: sha(candidate) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, pinFile, output] = process.argv.slice(2);
  need(source && pinFile && output && [source, pinFile, output].every(p => path.isAbsolute(p) && !p.startsWith(root + path.sep)), 'EXTERNAL_PATHS_REQUIRED');
  for (const file of [source, pinFile, output]) {
    const directory = fs.realpathSync(path.dirname(file));
    const canonical = fs.existsSync(file) ? fs.realpathSync(file) : path.join(directory, path.basename(file));
    const git = spawnSync('git', ['-C', path.dirname(canonical), 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
    need(git.status !== 0 || git.stdout.trim() !== 'true', 'RAW_FLOW_INSIDE_GIT');
    need(!canonical.startsWith(root + path.sep), 'EXTERNAL_PATHS_REQUIRED');
  }
  const pins = JSON.parse(fs.readFileSync(pinFile)), raw = fs.readFileSync(source);
  const result = prepareSupportPhotos(raw, pins);
  fs.writeFileSync(output, result.candidate, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ candidateSha256: result.sha256, changedIds: result.changedIds, addedIds: result.addedIds }));
}
