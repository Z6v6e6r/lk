// Offline only. Raw flow/candidate/contract remain in an external private workspace.
import fs from 'node:fs';
import path from 'node:path';
import { composeSplitCreateResultFlow } from './lib/splitCreateResultFlow.mjs';
const [source, output] = process.argv.slice(2);
const root = fs.realpathSync(process.cwd());
if (!source || !output || !path.isAbsolute(source) || !path.isAbsolute(output)
  || path.resolve(source) !== source || path.resolve(output) !== output || fs.existsSync(output)) throw Error('Use new canonical external output directory');
const parent = fs.realpathSync(path.dirname(output));
if (parent !== path.dirname(output) || parent === root || parent.startsWith(root + path.sep)
  || source === root || source.startsWith(root + path.sep)) throw Error('Private flow artifacts must stay outside repository');
const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(source), 'source.flow.meta.json'), 'utf8'));
if (meta.sourceKind !== 'live-147' || meta.sourceHost !== 'lk-primary-147' || meta.remoteFlowPath !== '/root/.node-red/flows.json'
  || meta.localSourcePath !== source || !Number.isFinite(Date.parse(meta.pulledAt))
  || Date.now() - Date.parse(meta.pulledAt) < 0) throw Error('Verified live-147 provenance required');
const result = composeSplitCreateResultFlow(fs.readFileSync(source), meta.sourceSha256);
fs.mkdirSync(output, { mode: 0o700 });
for (const [name, bytes] of [['candidate.flow.json', result.candidateBytes], ['contract.json', JSON.stringify(result.contract, null, 2) + '\n']]) {
  fs.writeFileSync(path.join(output, name), bytes, { mode: 0o600, flag: 'wx' });
}
console.log(JSON.stringify({ sourceSha256: meta.sourceSha256, additionCount: result.nodes.length,
  changedFunctionCount: 4, offlineCandidateBuilt: true, sourcePulledAt: meta.pulledAt,
  freshPreimageRequiredBeforeApply: true, liveMutations: 0 }));
