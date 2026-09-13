import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { SOURCE_SHA } from './build_organizer_handoff_candidate.mjs';
const directory = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(directory, 'nodered_games_maintenance_nodes', name + '.js'), 'utf8');
export const MAINTENANCE_ENTRIES = [
  'ecf32036257013bd', '9e6c24c105675e17', 'lk_staff_player_leave_post_20260812',
  'lk_split_leave_retry_inject_20260801', 'lk_split_cleanup_scheduler_20260822',
];
export const MAINTENANCE_HTTP = ['52af61191cdbe9ef', '41d9d40fefc3b1f3'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// This is a first-install HOLD packet, not proof that pre-existing operations have drained.
export function buildGamesMaintenanceBootstrap(source) {
  const flow = structuredClone(source);
  const original = new Map(source.map(n => [n.id, n]));
  if (original.size !== source.length) throw new Error('Duplicate source IDs');
  const get = id => { const n = original.get(id); if (!n) throw new Error(`Missing node ${id}`); return n; };
  const template = get('016d6797a530ed0a');
  const prefix = 'games_maintenance_20260913_';
  const responseId = prefix + 'response';
  const response = { ...get('35f7c89069fc393a'), id: responseId, name: 'Games maintenance response', wires: [] };
  const addFn = (id, func, wires) => flow.push({ ...template, id, name: id, func, outputs: wires.length, wires });
  flow.push(response);
  const admissionId = prefix + 'closed';
  addFn(admissionId, read('admission'), [[responseId]]);
  for (const id of MAINTENANCE_ENTRIES) {
    get(id);
    flow.find(n => n.id === id).wires = [[admissionId]];
  }
  const persistenceId = prefix + 'persist';
  flow.push({ ...get('lk_split_leave_game_update_20260801'), id: persistenceId,
    name: 'Persist held legacy operation evidence', collection: 'lk_game_maintenance_events',
    operation: 'insertOne', wires: [[prefix + 'ack']] });
  addFn(prefix + 'ack', `const prior = flow.get('gamesMaintenanceCapture') || { pending: 0, unhealthy: true };
if (msg.error || msg.payload?.acknowledged !== true) {
  flow.set('gamesMaintenanceCapture', { ...prior, unhealthy: true });
  node.error('Games maintenance evidence persistence unconfirmed');
  return null;
}
flow.set('gamesMaintenanceCapture', { ...prior, pending: Math.max(0, prior.pending - 1) });
if (!msg.req || !msg.res) return null;
msg.statusCode = 503;
msg.headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
msg.payload = { ok: false, code: 'GAME_OPERATION_HELD', message: 'Операция проверяется. Не повторяйте отмену до проверки.' };
return msg;`, [[responseId]]);
  flow.push({ id: prefix + 'persistence_catch', type: 'catch', z: template.z, name: 'Capture persistence failure',
    scope: [persistenceId, prefix + 'ack'], uncaught: false, x: 0, y: 0, wires: [[prefix + 'unhealthy']] });
  addFn(prefix + 'unhealthy', `const prior = flow.get('gamesMaintenanceCapture') || {};
flow.set('gamesMaintenanceCapture', { ...prior, unhealthy: true });
node.error('Maintenance evidence lost: reconciliation required');
return null;`, [[]]);
  for (const id of MAINTENANCE_HTTP) {
    if (get(id).type !== 'http request') throw new Error(`Expected HTTP request ${id}`);
    const gate = prefix + id + '_before';
    const collector = prefix + id + '_after';
    for (const [nodeId, phase] of [[gate, 'BEFORE_PROVIDER'], [collector, 'AFTER_PROVIDER']]) {
      addFn(nodeId, `const POINT = ${JSON.stringify(id)}; const PHASE = ${JSON.stringify(phase)};\n` + read('capture'), [[persistenceId]]);
    }
    // Preserve the HTTP instance, including any pending got promise; only update its wires.
    for (const n of flow) if (original.has(n.id) && Array.isArray(n.wires)) {
      n.wires = (n.wires || []).map(output => output.map(target => target === id ? gate : target));
    }
    flow.find(n => n.id === id).wires = [[collector]];
  }
  // Existing catch handlers still run; their attempts to re-enter provider nodes hit the closed gate.
  const ids = new Set(flow.map(n => n.id));
  if (ids.size !== flow.length) throw new Error('Maintenance ID collision');
  for (const n of flow) for (const target of (n.wires || []).flat()) {
    if (!ids.has(target)) throw new Error(`Broken wire ${n.id}`);
  }
  const changed = [];
  for (const n of flow.filter(n => original.has(n.id))) {
    const before = original.get(n.id);
    if (isDeepStrictEqual(before, n)) continue;
    if (!isDeepStrictEqual({ ...before, wires: [] }, { ...n, wires: [] })) throw new Error(`Non-wire mutation ${n.id}`);
    changed.push(n.id);
  }
  for (const n of flow.filter(n => !original.has(n.id) && n.type === 'function')) new Function('msg', 'node', n.func);
  return { flow, changed, added: flow.filter(n => !original.has(n.id)).map(n => n.id) };
}

export function prepareMaintenancePacket(sourceBytes, revision) {
  if (hash(sourceBytes) !== SOURCE_SHA) throw new Error('Unreviewed live source');
  if (typeof revision !== 'string' || !revision.trim() || revision.length > 200) throw new Error('Fresh Admin v2 revision required');
  const result = buildGamesMaintenanceBootstrap(JSON.parse(sourceBytes));
  return {
    request: { rev: revision, flows: result.flow },
    contract: { kind: 'games-maintenance-bootstrap-hold', sourceSha256: SOURCE_SHA,
      deploymentType: 'nodes', runtimeVersion: '4.0.9', revision,
      requestSha256: hash(JSON.stringify({ rev: revision, flows: result.flow })),
      changedWireOnly: result.changed, added: result.added,
      readyToRestart: false, readyToActivateOrganizer: false,
      blockers: ['LIVE_RUNTIME_SEMANTICS_AND_REVISION', 'LEGACY_PROVIDER_AND_MONGO_RECONCILIATION'],
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sourceFile, revision, output] = process.argv.slice(2);
  if (!sourceFile || !output || !path.isAbsolute(output) || fs.existsSync(output)) {
    throw new Error('Usage: node scripts/build_games_maintenance_bootstrap.mjs <private source> <Admin v2 rev> <new absolute directory>');
  }
  const packet = prepareMaintenancePacket(fs.readFileSync(sourceFile), revision);
  fs.mkdirSync(output, { mode: 0o700 });
  for (const [name, value] of Object.entries(packet)) fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify(packet.contract));
}
