import fs from 'node:fs';
import { createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
const check = (ok, code) => { if (!ok) throw Error(code); };
export const ROUTE_ID = '17cd943f9a72e572';
export const RESPONSE_ID = '18b77aadbd8d16a4';
export const MONGO_ID = 'bbae8103e401a034';
export const DEBUG_ID = '4095456cbdf92dc0';

// A self-contained pure sanitizer, compiled into one Node-RED function. No modules,
// settings/global mutation, startup hook, provider call or process restart is needed.
export function collectorFunction(release) {
  check(/^[a-f0-9]{40}$/.test(release), 'LCI_RELEASE');
  const core = fs.readFileSync(new URL('../../src/utils/errorDiagnosticsCore.mjs', import.meta.url), 'utf8');
  check(!/^\s*import\b/m.test(core) && !/\brequire\s*\(/.test(core), 'LCI_CORE_DEPENDENCY');
  const body = core.replace(/^export /gm, '');
  check(!/^\s*export\b/m.test(body), 'LCI_CORE_EXPORT');
  const func = `// SPLIT_LEAVE_COLLECTOR_V1 source=${release}\n`
    + `if (msg.payload?.event !== 'client_error' || msg.payload?.payload?.code !== 'SPLIT_LEAVE_INITIATED') return [msg, msg];\n`
    + `try {\n${body}\n`
    + `const safe = sanitizeEvent(msg.payload.payload);\n`
    + `if (!safe?.leaveTrace || safe.source !== 'browser' || safe.eventKind !== 'client_error' || safe.method !== 'POST' || safe.routeTemplate !== '/lk/games/:gameId/split/leave' || safe.stage !== 'leave_initiator') return [msg, null];\n`
    + `const payload = sanitizeEvent({...safe, serverRelease: '${release}', serverIngestTime: new Date().toISOString(), serverTimeUtc: undefined, serverRequestId: undefined, deviceClockTrusted: false});\n`
    + `return [msg, payload ? {payload: {event: 'client_error', timestamp: payload.deviceEventTime, payload}} : null];\n`
    + `} catch { return [msg, null]; }`;
  new Function('msg', func);
  return func;
}

export function buildCollectorCandidate(flow, { release, routeHash } = {}) {
  check(Array.isArray(flow) && flow.every(node => node && typeof node.id === 'string')
    && new Set(flow.map(node => node.id)).size === flow.length, 'LCI_FLOW_IDENTITY');
  const candidate = structuredClone(flow);
  const route = candidate.find(node => node.id === ROUTE_ID);
  check(route?.type === 'http in' && route.url === '/lk/analytics/events' && route.method === 'post'
    && sha(JSON.stringify(route)) === routeHash && route.d !== true, 'LCI_ROUTE_PIN');
  const tab = candidate.find(node => node.id === route.z);
  check(tab?.type === 'tab' && tab.disabled !== true, 'LCI_TAB');
  check(JSON.stringify(route.wires) === JSON.stringify([[DEBUG_ID, RESPONSE_ID, MONGO_ID]]), 'LCI_ROUTE_WIRES');
  for (const [id, type] of [[RESPONSE_ID, 'http response'], [MONGO_ID, 'mongodb4'], [DEBUG_ID, 'debug']]) {
    const node = candidate.find(node => node.id === id);
    check(node?.type === type && node.z === route.z && node.d !== true, 'LCI_DOWNSTREAM');
    if (id === MONGO_ID) check(node.collection === 'events' && node.operation === 'insertOne', 'LCI_PERSISTENCE');
  }
  const beforeWires = structuredClone(route.wires);
  const gate = { id: `diag_ingest_${ROUTE_ID}`, type: 'function', z: route.z,
    name: 'Split leave safe initiator intake', func: collectorFunction(release), outputs: 2,
    timeout: 0, noerr: 0, initialize: '', finalize: '', libs: [],
    x: 410, y: 340, wires: [[RESPONSE_ID], [MONGO_ID, DEBUG_ID]] };
  check(!candidate.some(node => node.id === gate.id), 'LCI_ALREADY_INSTALLED');
  route.wires = [[gate.id]]; candidate.push(gate);
  return { candidate, gate, targetId: ROUTE_ID, beforeWires,
    beforeRouteSha256: routeHash, gateSha256: sha(JSON.stringify(gate)) };
}
