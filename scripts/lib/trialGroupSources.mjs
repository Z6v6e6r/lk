import fs from 'node:fs';

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
export function assertNoInstalledTrialGateOverwrite(flow) {
  const booking = flow.find(row => row.id === 'lk_subscription_booking_router_20260804');
  if (booking?.func?.includes('TRIAL_GROUP_POLICY_GLOBAL')) {
    throw new Error('Installed trial eligibility must be preserved; base gateway regeneration is prohibited');
  }
}
export const trialGroupPolicySource = () => read('./trialGroupEligibility.mjs').replace(/^export /gm, '');
export const trialGroupGateSource = () => read('../nodered_trial_group_nodes/visit_gate.js');
export const trialGroupCheckoutSource = () => trialGroupPolicySource() + '\n' + trialGroupGateSource()
  + '\n' + read('../nodered_trial_group_nodes/checkout.js');

function replaceOnce(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw new Error('Trial gate source anchor drift');
  return source.replace(anchor, () => replacement);
}
// Capture the server target, but allow existing operation readback before a new
// eligibility decision. Only a new reservation/provider dispatch needs a gate.
export function patchTrialGroupBookingSource(source) {
  if (source.includes('TRIAL_GROUP_POLICY_GLOBAL')) throw new Error('Trial gate already installed');
  source = replaceOnce(source, 'const emit = (index, value = msg) => {',
    'const emit = (index, value = msg) => {\n'
    + '  if (index === OUTPUT_MONGO_INSERT && ctx?.trialExercise && ctx.trialInsertGrant !== true) {\n'
    + '    ctx.trialSavedInsert = { step: ctx.step, payload: value.payload };\n'
    + '    const gated = trialBeginGate(ctx, ctx.trialExercise, "insert");\n'
    + '    if (gated) return gated;\n'
    + '    delete ctx.trialSavedInsert;\n'
    + '  }\n  if (ctx) delete ctx.trialInsertGrant;');
  source = replaceOnce(source, 'const preparePreaccept = (ctx) => {',
    'const preparePreaccept = (ctx) => {\n'
    + '  if (ctx.trialExercise && ctx.trialBookingGrant !== true) {\n'
    + '    const gated = trialBeginGate(ctx, ctx.trialExercise, "booking");\n'
    + '    if (gated) return gated;\n'
    + '  }\n  delete ctx.trialBookingGrant;');
  source = replaceOnce(source, 'const prepareBookingCreate = (ctx) => {',
    'const prepareBookingCreate = (ctx) => {\n'
    + '  if (ctx.trialExercise && !trialEvidenceMatches(ctx)) {\n'
    + '    const gated = trialBeginGate(ctx, ctx.trialExercise, "provider");\n'
    + '    if (gated) return gated;\n'
    + '  }');
  const dispatch = `
if (ctx.step === 'trial_visit_history') {
  const outcome = trialHistoryOutcome(ctx);
  const stopped = trialGateDecision(ctx, outcome);
  if (stopped) return stopped;
  const gate = ctx.trialVisitGate;
  delete ctx.trialVisitGate;
  if (gate.resume === 'insert') {
    const saved = ctx.trialSavedInsert; delete ctx.trialSavedInsert;
    ctx.step = saved.step; msg.payload = saved.payload;
    ctx.trialInsertGrant = true;
    return emit(OUTPUT_MONGO_INSERT);
  }
  if (gate.resume === 'booking') {
    ctx.trialBookingGrant = true;
    return preparePreaccept(ctx);
  }
  if (gate.resume === 'provider') return prepareBookingCreate(ctx);
  return trialFinish(503, 'TRIAL_TRAINING_CONTINUATION_UNVERIFIED');
}
if (['exercise', 'exercise_recheck'].includes(ctx.step) && isHttpOk(msg.statusCode) && ctx.action !== 'release') {
  const target = unwrapRecord(msg.payload);
  if (isTrialGroupExercise(target)) {
    if (trialId(target.id) !== ctx.exerciseId) return trialFinish(503, 'TRIAL_TRAINING_TARGET_UNVERIFIED');
    ctx.trialExercise = target;
    ctx.trialRequestedAt ||= ctx.startedAt || new Date().toISOString();
  } else delete ctx.trialExercise;
}
`;
  source = replaceOnce(source, 'if (ctx.step === "profile") {', dispatch + '\nif (ctx.step === "profile") {');
  source = trialGroupPolicySource() + '\n' + trialGroupGateSource() + '\n' + source;
  new Function('msg', 'global', 'node', source);
  return source;
}
