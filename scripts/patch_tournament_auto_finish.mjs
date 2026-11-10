#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AUTO_FINISH_NODES, buildAutoFinishNode, assertAutoFinishWriters } from './lib/tournamentAutoFinishNodes.mjs';

export function buildTournamentAutoFinish(flow) {
  if (!Array.isArray(flow) || new Set(flow.map(n => n.id)).size !== flow.length) throw new Error('INVALID_FLOW');
  const candidate = structuredClone(flow);
  for (const [kind, id] of Object.entries(AUTO_FINISH_NODES)) {
    const node = candidate.find(n => n.id === id && n.type === 'function' && n.disabled !== true);
    if (!node || !candidate.some(tab => tab.id === node.z && tab.type === 'tab' && tab.disabled !== true)) throw new Error('ACTIVE_TOURNAMENT_WRITER_REQUIRED');
    node.func = buildAutoFinishNode(node.func, kind);
  }
  assertAutoFinishWriters(candidate);
  return candidate;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = name => process.argv[process.argv.indexOf(name) + 1];
  if (!['--source', '--source-sha256', '--output'].every(key => process.argv.includes(key))) throw new Error('Usage: --source <private-flow> --source-sha256 <sha256> --output <new-private-candidate>');
  const input = fs.readFileSync(arg('--source'));
  if (crypto.createHash('sha256').update(input).digest('hex') !== arg('--source-sha256')) throw new Error('FLOW_PREIMAGE_MISMATCH');
  const candidate = buildTournamentAutoFinish(JSON.parse(input));
  fs.writeFileSync(arg('--output'), JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ changedNodes: Object.values(AUTO_FINISH_NODES), candidateSha256: crypto.createHash('sha256').update(fs.readFileSync(arg('--output'))).digest('hex') }));
}
