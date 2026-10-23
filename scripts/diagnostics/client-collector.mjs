import { sha } from './source-hooks.mjs';
// Candidate-only gate for an existing diagnostics endpoint. Never create a second collector.
// HTTP response stays on output 1 with the ORIGINAL message; storage/debug receive only the safe envelope.
export function addClientCollectorGate(flow, { routeId, routeHash, responseId, persistenceId, debugIds = [] }) {
  const candidate = structuredClone(flow);
  const route = candidate.find(n => n.id === routeId);
  const response = candidate.find(n => n.id === responseId);
  const persistence = candidate.find(n => n.id === persistenceId);
  const expected = [responseId, persistenceId, ...debugIds].sort();
  if (!route || route.type !== 'http in' || !['/lk/analytics/events', '/lk/analytics/event'].includes(route.url)
    || sha(JSON.stringify(route)) !== routeHash || response?.type !== 'http response' || persistence?.type !== 'mongodb4'
    || debugIds.some(id => candidate.find(n => n.id === id)?.type !== 'debug')
    || JSON.stringify(route.wires?.flat().sort()) !== JSON.stringify(expected)) throw new Error('DIAGNOSTIC_COLLECTOR_SOURCE_DRIFT');
  const id = `diag_ingest_${routeId}`;
  if (candidate.some(n => n.id === id)) throw new Error('DIAGNOSTIC_COLLECTOR_DUPLICATE');
  route.wires = [[id]];
  candidate.push({ id, type: 'function', z: route.z, name: 'Safe client diagnostics v1 intake', outputs: 2,
    wires: [[responseId], [persistenceId, ...debugIds]],
    func: `if (msg.payload?.event !== "client_error") return [msg, msg];\ntry {\n  const safe = global.get("lkDiagnostics")?.clientEnvelope(msg.payload, msg);\n  return [msg, safe ? { payload: safe } : null];\n} catch { return [msg, null]; }` });
  return candidate;
}
