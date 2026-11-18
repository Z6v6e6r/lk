import fs from 'node:fs';
const read = name => fs.readFileSync(new URL(`../nodered_tournament_admission_nodes/${name}`, import.meta.url), 'utf8');
const once = (source, anchor, replacement) => {
  if (source.split(anchor).length !== 2) throw Error('Tournament admission source drift: ' + anchor);
  return source.replace(anchor, () => replacement);
};
// Apply LAST to a composed booking owner, including the daily guard. Never regenerate a live graph.
export function patchTournamentAdmissionSource(source) {
  if (source.includes('const tournamentAdmissionGate =')) throw Error('Tournament admission already installed');
  // The daily-visit patch puts declarations among dispatch branches. Hoist them
  // before ctx so an admission response can safely resume its continuation.
  const guardStart = source.indexOf('const lk1DailyVisitKey =');
  const ctxAt = source.indexOf('const ctx = isObj(msg._subscriptionBooking)');
  if (guardStart > ctxAt) {
    const guardEnd = source.indexOf('if (["lk1_ingress_operation_find"', guardStart);
    if (guardEnd < 0) throw Error('Daily visit declaration boundary drift');
    const declarations = source.slice(guardStart, guardEnd);
    source = source.slice(0, guardStart) + source.slice(guardEnd);
    source = source.slice(0, ctxAt) + declarations + '\n' + source.slice(ctxAt);
  }
  source = once(source, 'const ctx = isObj(msg._subscriptionBooking) ? msg._subscriptionBooking : null;',
    read('admission.js') + '\nconst ctx = isObj(msg._subscriptionBooking) ? msg._subscriptionBooking : null;');
  source = once(source, 'if (ctx.managedCreateBinding !== undefined) {',
    'const tournamentAdmissionResult = tournamentAdmissionRoute(ctx);\nif (tournamentAdmissionResult) return tournamentAdmissionResult;\n\nif (ctx.managedCreateBinding !== undefined) {');
  for (const [name, continuation] of [['preparePreaccept', 'preaccept'], ['prepareBookingCreate', 'booking'], ['prepareManagedEntitlementReserve', 'reserve']]) {
    source = once(source, `const ${name} = (ctx) => {`, `const ${name} = (ctx) => {\n  const admission = tournamentAdmissionGate(ctx, "${continuation}");\n  if (admission) return admission;`);
  }
  source = once(source, '      state: isCreatePreflight ? "PRECREATE_RESERVING" : "PENDING_CONFIRMATION",',
    '      state: isCreatePreflight ? "PRECREATE_RESERVING" : "PENDING_CONFIRMATION",\n'
    + '      ...(ctx.category === "tournament" && ctx.tournamentAdmission ? { tournamentAdmission: ctx.tournamentAdmission, tournamentProviderPhase: "PRE_DISPATCH" } : {}),');
  source = once(source, 'const prepareFailedUpdate = (ctx, statusCode, message, rawCode) => {',
    'const prepareFailedUpdate = (ctx, statusCode, message, rawCode) => {\n'
    + '  const abort = tournamentAdmissionAbortFailure(ctx, statusCode, message, rawCode); if (abort) return abort;');
  source = once(source, 'const prepareOperationReclaim = (ctx, operation, now = new Date()) => prepareMongoUpdate(ctx, "operation_reclaim", {\n  _id: ctx.operationKey,\n  operationId: operation.operationId ?? null,\n  state: operation.state,',
    'const prepareOperationReclaim = (ctx, operation, now = new Date()) => prepareMongoUpdate(ctx, "operation_reclaim", {\n  _id: ctx.operationKey,\n  operationId: operation.operationId ?? null,\n  state: operation.state,\n  ...tournamentAdmissionReclaimFence,');
  source = once(source, '  const adminVersion = ctx.caller === "split" ? "v1" : "v2";',
    '  const dispatch = tournamentAdmissionDispatch(ctx); if (dispatch) return dispatch;\n'
    + '  const adminVersion = ctx.caller === "split" ? "v1" : "v2";');
  if (source.includes('const lk1DailyVisitAcquire = (ctx) => {')) {
    source = once(source, 'const lk1DailyVisitAcquire = (ctx) => {',
      'const lk1DailyVisitAcquire = (ctx) => {\n  const admission = tournamentAdmissionGate(ctx, "preaccept");\n  if (admission) return admission;');
    source = once(source, '  if (guard.ownerOperationKey === ctx.operationKey) {', `  if (guard.admissionRelease?.operationKey === guard.ownerOperationKey
    && guard.admissionRelease?.operationId === guard.ownerOperationId) {
    ctx.step = "lk1_daily_visit_takeover"; msg._subscriptionBooking = ctx;
    msg.payload = [{ _id: guard._id, ownerOperationKey: guard.ownerOperationKey,
      ownerOperationId: guard.ownerOperationId, admissionRelease: guard.admissionRelease },
      { $set: { ownerOperationKey: ctx.operationKey, ownerOperationId: ctx.operationId }, $unset: { admissionRelease: "" } },
      { writeConcern: { w: "majority", j: true } }];
    delete msg.error; return emit(OUTPUT_MONGO_UPDATE);
  }
  if (guard.ownerOperationKey === ctx.operationKey) {`);
  }
  source = once(source, 'const finishConfirmed = (ctx, bookingId, statusCode = 200) => {',
    'const finishConfirmed = (ctx, bookingId, statusCode = 200) => {\n'
    + '  if (!ctx.lk1) { const completion = tournamentAdmissionComplete(ctx, bookingId); if (completion) return completion; }');
  if (source.includes('const lk1Finish = (ctx) => {')) source = once(source, '  finishConfirmed(ctx, ctx.confirmedBookingId);',
    '  const completion = tournamentAdmissionComplete(ctx, ctx.confirmedBookingId); if (completion) return completion;\n  finishConfirmed(ctx, ctx.confirmedBookingId);');
  return source;
}
