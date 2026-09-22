import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

export const SOURCE_SHA = '5b030bf1154eb64bb4de22402e0032ae801a093b03a16276db71ca2db848a601';
export const PREIMAGES = Object.freeze({
  lk_subscription_booking_router_20260804: '864c846f69c4ccbcdd44c7b2f68942b47a4a8f67470cb4cb77caf2e46550567e',
  lk_subscription_price_preview_20260908_router: '794a6ae1113d970dca6844b16952ec7f9a2d84cd2ed45a6f821b5eb2eabb1e7b',
});
export const BEFORE = 'return /^(энергия|energy) (5|25)$/.test(normalized || "");';
export const AFTER = 'return /^(энергия|energy) (5|25)(?: |$)/.test(normalized || "");';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const PRO_MODULE_START = 'const PRO_TRAINING_DIRECTION_IDS =';
const BOOKING_MODULE_END = 'if (ctx.step === "exercise") {\n';
const PREVIEW_MODULE_END = 'const lk1PlanRulesGlobal =';

function embeddedModuleSource() {
  return fs.readFileSync(new URL('./lib/proTrainingExclusion.mjs', import.meta.url), 'utf8')
    .replace(/^export /gm, '');
}

function replaceEmbeddedModule(body, endAnchor, label, moduleSource) {
  const starts = body.split(PRO_MODULE_START).length - 1;
  const ends = body.split(endAnchor).length - 1;
  if (starts !== 1 || ends !== 1) throw new Error(`${label} module boundary drift`);
  const start = body.indexOf(PRO_MODULE_START);
  const end = body.indexOf(endAnchor, start);
  if (end <= start) throw new Error(`${label} module ordering drift`);
  return `${body.slice(0, start)}${moduleSource}\n${body.slice(end)}`;
}

export function composeEnergySuffix(bytes) {
  if (sha(bytes) !== SOURCE_SHA) throw new Error('Full-flow preimage drift');
  const flow = JSON.parse(bytes);
  const module = embeddedModuleSource();
  if (!module.includes(AFTER) || module.includes(BEFORE)) throw new Error('Source rule drift');
  const changes = [];
  for (const [id, hash] of Object.entries(PREIMAGES)) {
    const rows = flow.filter(row => row.id === id);
    if (rows.length !== 1 || rows[0].type !== 'function' || sha(rows[0].func) !== hash) throw new Error('Node preimage drift');
    const node = rows[0];
    if (node.func.split(BEFORE).length !== 2) throw new Error('Rule anchor drift');
    node.func = replaceEmbeddedModule(node.func,
      id === 'lk_subscription_booking_router_20260804' ? BOOKING_MODULE_END : PREVIEW_MODULE_END,
      id, module).replace(BEFORE, AFTER);
    new Function('msg', 'node', 'env', 'global', node.func);
    changes.push({ id, fields: ['func'], func: { beforeSha256: hash, afterSha256: sha(node.func) } });
  }
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes: bytes, candidateBytes,
    deploymentId: 'lk1-pro-energy-suffix', allowedChanges: changes.map(({id, fields}) => ({id, fields})), allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });
  const booking = flow.find(row => row.id === 'lk_subscription_booking_router_20260804');
  const preview = flow.find(row => row.id === 'lk_subscription_price_preview_20260908_router');
  return { candidateBytes, report: {
    sourceSha256: SOURCE_SHA, candidateSha256: sha(candidateBytes), changedNodeCount: 2, addedNodeCount: 0,
    deploymentPerformed: false, liveMutationPerformed: false, changes,
    booking: { id: booking.id, moduleEmbeddedOnce: booking.func.split('function isProTrainingEnergyPack(value) {').length === 2,
      refusalBound: booking.func.includes('PRO_TRAINING_SUBSCRIPTION_UNAVAILABLE'),
      refusalPrecedesContour: booking.func.indexOf('PRO_TRAINING_SUBSCRIPTION_UNAVAILABLE') < booking.func.indexOf('const selectedRule = lk1Config(selectedOwned, exercise?.studio?.id || exercise?.studioId || null);') },
    preview: { id: preview.id, refusalBound: preview.func.includes('canonical.isProTrainingExercise'),
      inertStubAbsent: !preview.func.includes('const isProTrainingExercise = () => false;'), initializeUnchanged: preview.initialize === '' },
  }};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const values = new Map();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i], value = process.argv[i + 1];
    if (!['--workspace', '--output', '--report'].includes(key) || !value || values.has(key)) throw new Error('Invalid arguments');
    values.set(key, value);
  }
  if (values.size !== 3) throw new Error('Expected workspace, output and report');
  const verified = verifyWorkspace(values.get('--workspace'), { quiet: true });
  const built = composeEnergySuffix(fs.readFileSync(verified.sourcePath));
  for (const key of ['--output', '--report']) {
    const target = values.get(key);
    if (!path.isAbsolute(target) || path.resolve(target) !== target || fs.existsSync(target)
      || target.startsWith(`${verified.workspace}${path.sep}`)) throw new Error('Unsafe output path');
  }
  fs.writeFileSync(values.get('--output'), built.candidateBytes, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(values.get('--report'), `${JSON.stringify(built.report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify(built.report));
}
