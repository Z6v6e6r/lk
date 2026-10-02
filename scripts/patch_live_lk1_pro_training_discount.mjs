import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { proTrainingExclusionSource, topokratyExclusionSource } from './lib/eventPaymentSources.mjs';
import { PRO_TRAINING_ENERGY_CALL_SITE_DELTAS } from './patch_live_lk1_pro_training_energy_exclusions_hotfix.mjs';
import { previewSources } from './patch_nodered_subscription_price_preview.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

export const TARGET = Object.freeze({
  source: 'd72dc13b3a641a2de979b36d931742d620a4cc61a6a569c693dba0d4e37cec98',
  booking: 'cfce248c5573aa5d9d85d4ff291fd25e9f7bd4896e04c9d99d2200a220a7790b',
  preview: '0681948096431961e141b98e35f4c3c26c834bafbb4054b52fe7dd5d963eb1f3',
  evaluator: '2d3f5b5080152c07ace9e4aaf31e7b0280878576c027ca7f5c30dd15d9b45602',
  pricing: 'd93de261c85ba62e3ba782acad1a364bc63e97433bcbebba81b20f5c3eb7206b',
  join: '8b312b97a75112d8e10d13642be649cd795f77a506c4925152338b6854c2b074',
  nodeCount: 4804,
});
export const BOOKING_ID = 'lk_subscription_booking_router_20260804';
export const PREVIEW_ID = 'lk_subscription_price_preview_20260908_router';
export const DEPLOYMENT_ID = 'lk1-pro-training-discount-20261002';
export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export function replaceExact(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('PRO discount anchor drift: ' + before.slice(0, 65));
  return source.replace(before, () => after);
}
const indent = source => source.split('\n').map(line => line ? '  ' + line : line).join('\n');
export function patchBookingBody(source) {
  if (source.includes('isProTrainingDiscountRule')) throw new Error('PRO discount already installed');
  const ast = ts.createSourceFile('booking.js', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const declarations = [];
  const visit = node => {
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (/^(PRO_TRAINING_|proTraining(?:IsRecord|Str|Num)$)/.test(declaration.name.getText(ast))) declarations.push(node);
      }
    }
    if (ts.isFunctionDeclaration(node) && /^isProTraining(?:Name|Exercise|EnergyPack)$/.test(node.name?.text || '')) declarations.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (declarations.length !== 9) throw new Error('PRO module declaration drift');
  const start = Math.min(...declarations.map(node => node.getStart(ast)));
  const end = Math.max(...declarations.map(node => node.getEnd()));
  source = source.slice(0, start) + proTrainingExclusionSource() + source.slice(end);
  const hooks = fs.readFileSync(new URL('./nodered_lk1_hub_nodes/gateway_hooks.js', import.meta.url), 'utf8');
  const instance = hooks.slice(hooks.indexOf('// Resolve the instance first.'), hooks.indexOf('// A Topokraty event'));
  source = replaceExact(source, PRO_TRAINING_ENERGY_CALL_SITE_DELTAS[0].after, indent(instance));
  const ruleAnchor = '  const productRule = lk1Config(ownedSubscriptions, exercise?.studio?.id || exercise?.studioId || null);';
  const guardStart = hooks.indexOf('if (resolveCategory(exercise) === "group_training" && isProTrainingExercise(exercise)');
  const guardEnd = hooks.indexOf('// A legacy cohort', guardStart);
  if (guardStart < 0 || guardEnd < 0) throw new Error('Reviewed source guard missing');
  source = replaceExact(source, ruleAnchor, ruleAnchor + '\n' + indent(hooks.slice(guardStart, guardEnd).trim()));
  source = replaceExact(source, '  if (configured.legacy) return { legacy: true };',
    '  if (configured.legacy) return { legacy: true };\n  if (resolveCategory(exercise) === "group_training" && isProTrainingExercise(exercise)\n    && !isProTrainingDiscountRule(configured.rule)) return { code: "PRO_TRAINING_SUBSCRIPTION_UNAVAILABLE" };');
  source = replaceExact(source, '    directionId: exerciseDirectionId(exercise),',
    '    directionId: exerciseDirectionId(exercise),\n    ...(resolveCategory(exercise) === "group_training" && isProTrainingExercise(exercise)\n      ? { proTraining: true } : {}),');
  source = replaceExact(source, 'if (!products || !category) return false;',
    'if (!products || !category) return false;\n  if (category === "group_training" && [5502, 5503, 5504, 5505, 5506, 5507].includes(Number(directionId))) return false;');
  source = replaceExact(source, 'const freeFirstCovered = lk1FreeFirstEventCovers(',
    'const freeFirstCovered = ctx.lk1.target?.proTraining !== true && lk1FreeFirstEventCovers(');
  source = replaceExact(source, 'if (freeFirstCovered && lk1FreeFirstEventCovers(ctx.lk1.rule.productId,\n      lk1OperationCategory',
    'if (freeFirstCovered && operation.lk1?.target?.proTraining !== true\n      && lk1FreeFirstEventCovers(ctx.lk1.rule.productId,\n      lk1OperationCategory');
  source = replaceExact(source, 'if (freeFirstCovered && lk1FreeFirstEventCovers(ctx.lk1.rule.productId, category,',
    'if (freeFirstCovered && !(category === "group_training"\n      && typeof isProTrainingExercise === "function" && isProTrainingExercise(booking.exercise || booking))\n      && lk1FreeFirstEventCovers(ctx.lk1.rule.productId, category,');
  new Function('msg', 'node', 'global', source);
  return source;
}
export function compose(raw) {
  if (sha256(raw) !== TARGET.source) throw new Error('Live flow source drift');
  const flow = JSON.parse(raw);
  if (flow.length !== TARGET.nodeCount) throw new Error('Live flow node count drift');
  const node = (id, pin) => {
    const matches = flow.filter(row => row.id === id);
    if (matches.length !== 1 || matches[0].type !== 'function' || sha256(matches[0].func) !== pin) throw new Error('Live function drift: ' + id);
    return matches[0];
  };
  const booking = node(BOOKING_ID, TARGET.booking);
  const preview = node(PREVIEW_ID, TARGET.preview);
  node('lk_subscription_managed_policy_20260820', TARGET.evaluator);
  node('8f7bd5b482fe9763', TARGET.pricing);
  node('e92e68bf3f08a70c', TARGET.join);
  const installedPreview = preview.func;
  booking.func = patchBookingBody(booking.func);
  const from = booking.func.indexOf('if (ctx.step === "lk1_usage_operations") {');
  const to = booking.func.indexOf('if (ctx.step === "lk1_policy_decision") {');
  if (from < 0 || to <= from) throw new Error('Usage boundary drift');
  const generated = previewSources(flow, { pins: { ...TARGET, booking: sha256(booking.func) },
    installedUsageSha256: sha256(booking.func.slice(from, to)) });
  // Preserve the existing external Topokraty helpers used by the router and club usage.
  const restrictionStart = installedPreview.indexOf("  if (eventRoute && eventRoute.category === 'group_training' && isTopokratyExercise(exercise)) {");
  const restrictionEnd = installedPreview.indexOf('  // An annual HUB event quote', restrictionStart);
  const generatedStart = generated.router.indexOf('  if (!available.length)');
  const generatedEnd = generated.router.indexOf('  // An annual HUB event quote', generatedStart);
  if ([restrictionStart, restrictionEnd, generatedStart, generatedEnd].some(offset => offset < 0)) {
    throw new Error('Installed Topokraty boundary drift');
  }
  // Keep the live group-only restriction and its ordering; game-route rollout is separate.
  const focusedRouter = generated.router.slice(0, generatedStart)
    + installedPreview.slice(restrictionStart, restrictionEnd) + generated.router.slice(generatedEnd);
  preview.func = topokratyExclusionSource() + '\n' + focusedRouter;
  new Function('msg', 'node', 'global', preview.func);
  const candidate = Buffer.from(JSON.stringify(flow, null, 2) + '\n');
  const contract = buildExactGraphContract({ liveBytes: raw, candidateBytes: candidate, deploymentId: DEPLOYMENT_ID,
    allowedChanges: [{ id: BOOKING_ID, fields: ['func'] }, { id: PREVIEW_ID, fields: ['func'] }], allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: raw, candidateBytes: candidate, contract, deploymentId: DEPLOYMENT_ID });
  return { candidate, contract, bookingSha256: sha256(booking.func), previewSha256: sha256(preview.func) };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [source, output] = process.argv.slice(2);
  if (!source || !output || output !== path.resolve(output)
    || !output.startsWith('/private/tmp/')
    || fs.realpathSync(path.dirname(output)) !== path.dirname(output)) throw new Error('Usage: source.flow.json /private/tmp/new-output-directory');
  const result = compose(fs.readFileSync(source));
  fs.mkdirSync(output, { mode: 0o700 });
  fs.writeFileSync(output + '/candidate.flow.json', result.candidate, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(output + '/contract.json', JSON.stringify(result.contract, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ sourceSha256: TARGET.source, candidateSha256: sha256(result.candidate),
    bookingSha256: result.bookingSha256, previewSha256: result.previewSha256, changedNodeCount: 2, addedNodeCount: 0 }));
}
