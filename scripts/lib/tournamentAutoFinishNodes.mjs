import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TOURNAMENT_WRITE_FIELDS } from './communityMonthlyFinalization.mjs';
import { isTournamentFinalized } from './tournamentFinalization.mjs';

export const AUTO_FINISH_NODES = {
  prepare: '4f0f1ce8189a9e8c', write: '2e70b2e547e77c00', ack: '745f991e11130b08',
};
export function isAutoFinishProtocolClosed(tournament) {
  // A summary can be completed merely because every currently scheduled match is scored.
  // The managed session remains editable until explicit finish or its deadline.
  const summary = { ...(tournament.summary || {}) };
  delete summary.status; delete summary.state; delete summary.tournamentStatus;
  return isTournamentFinalized({ ...tournament, summary });
}
export function buildAutoFinishNode(source, kind) {
  if (!Object.hasOwn(AUTO_FINISH_NODES, kind)) throw new Error('UNKNOWN_AUTO_FINISH_NODE');
  if (source.includes('tournament_auto_finish_' + kind + '_v1')) throw new Error('AUTO_FINISH_ALREADY_INSTALLED');
  const template = fs.readFileSync(fileURLToPath(new URL('../nodered_tournament_auto_finish_nodes/' + kind + '.js', import.meta.url)), 'utf8');
  const helper = `const AUTO_FINISH_WRITE_FIELDS = ${JSON.stringify(TOURNAMENT_WRITE_FIELDS)};\n`
    + `const AUTO_FINISH_IS_FINAL = ${isTournamentFinalized.toString().replaceAll('isRecord(', 'autoFinishIsRecord(')};\n`
    + `const AUTO_FINISH_IS_CLOSED = ${isAutoFinishProtocolClosed.toString().replaceAll("isTournamentFinalized(", "AUTO_FINISH_IS_FINAL(")};\n`
    + 'const autoFinishIsRecord = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);\n';
  const result = helper + template.replace('AUTO_FINISH_LEGACY_SOURCE', () => source);
  new Function('msg', result);
  return result;
}
export function assertAutoFinishWriters(flow) {
  for (const [kind, id] of Object.entries(AUTO_FINISH_NODES)) {
    const matches = flow.filter(n => n.id === id);
    const node = matches[0];
    if (matches.length !== 1 || node.type !== 'function' || node.disabled === true
        || !flow.some(tab => tab.id === node.z && tab.type === 'tab' && tab.disabled !== true)
        || !node.func?.includes('tournament_auto_finish_' + kind + '_v1')) throw new Error('AUTO_FINISH_WRITERS_NOT_INSTALLED');
  }
}
