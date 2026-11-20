import fs from 'node:fs';
const read = name => fs.readFileSync(new URL(`../nodered_tournament_admission_nodes/${name}`, import.meta.url), 'utf8');
const once = (source, anchor, replacement) => {
  if (source.split(anchor).length !== 2) throw Error('Tournament admission source drift: ' + anchor);
  return source.replace(anchor, () => replacement);
};
export function updateTournamentAdmissionCopay(source, previousAdmission) {
  const start = source.indexOf('// CUP reserves a canonical tournament seat');
  const end = source.indexOf('const ctx = isObj(msg._subscriptionBooking)', start);
  if (start < 0 || end < 0 || source.slice(start, end).trim() !== previousAdmission.trim()) {
    throw Error('Installed tournament admission fragment drift');
  }
  return source.slice(0, start) + read('admission.js') + '\n' + source.slice(end);
}
// Apply LAST to a composed booking owner, including the daily guard. Never regenerate a live graph.
export function patchTournamentAdmissionSource(source) {
  if (source.includes('const tournamentAdmissionGate =')) throw Error('Tournament admission already installed');
  const hasDailyVisitGuard = source.includes('const lk1DailyVisitAcquire = (ctx) => {');
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
  const context = 'const ctx = isObj(msg._subscriptionBooking) ? msg._subscriptionBooking : null;';
  source = once(source, context, read('admission.js') + '\n' + context + '\n'
    + 'const managedTournamentRecovery = ctx && tournamentAdmissionManagedReplay(ctx);\n'
    + 'if (managedTournamentRecovery) return managedTournamentRecovery;\n'
    + 'if (ctx) tournamentAdmissionObserveManagedRecheck(ctx);');
  source = once(source, 'if (ctx.managedCreateBinding !== undefined) {',
    'const tournamentAdmissionResult = tournamentAdmissionRoute(ctx);\nif (tournamentAdmissionResult) return tournamentAdmissionResult;\n\nif (ctx.managedCreateBinding !== undefined) {');
  for (const [name, continuation, afterGuard] of [
    ['preparePreaccept', 'preaccept', '    return lk1DailyVisitAcquire(ctx);\n  }'],
    ['prepareBookingCreate', 'booking', '    ctx.lk1DailyVisitContinuation = "booking";\n    return lk1DailyVisitAcquire(ctx);\n  }'],
    ['prepareManagedEntitlementReserve', 'reserve'],
  ]) {
    const declaration = `const ${name} = (ctx) => {`;
    const gate = `\n  const admission = tournamentAdmissionGate(ctx, "${continuation}");\n  if (admission) return admission;`;
    if (hasDailyVisitGuard && afterGuard) {
      // Recovery must block a new attempt before it can acquire somebody's daily guard.
      source = once(source, declaration, declaration + '\n  const paused = tournamentAdmissionPause(ctx); if (paused) return paused;');
      const guarded = source.indexOf(afterGuard, source.indexOf(declaration));
      const nextDeclaration = source.indexOf('\nconst ', source.indexOf(declaration));
      if (guarded < 0 || nextDeclaration < 0 || guarded >= nextDeclaration) throw Error('Tournament daily-visit gate source drift: ' + name);
      const insert = guarded + afterGuard.length;
      source = source.slice(0, insert) + gate + source.slice(insert);
    } else {
      source = once(source, declaration, declaration + gate);
    }
  }
  source = once(source, '      state: isCreatePreflight ? "PRECREATE_RESERVING" : "PENDING_CONFIRMATION",',
    '      state: isCreatePreflight ? "PRECREATE_RESERVING" : "PENDING_CONFIRMATION",\n'
    + '      ...(ctx.category === "tournament" && ctx.tournamentAdmission ? { tournamentAdmission: ctx.tournamentAdmission, tournamentProviderPhase: "PRE_DISPATCH" } : {}),');
  source = once(source, 'const prepareFailedUpdate = (ctx, statusCode, message, rawCode) => {',
    'const prepareFailedUpdate = (ctx, statusCode, message, rawCode) => {\n'
    + '  const abort = tournamentAdmissionAbortFailure(ctx, statusCode, message, rawCode); if (abort) return abort;');
  source = once(source, 'const prepareOperationReclaim = (ctx, operation, now = new Date()) => prepareMongoUpdate(ctx, "operation_reclaim", {\n  _id: ctx.operationKey,\n  operationId: operation.operationId ?? null,\n  state: operation.state,',
    'const prepareOperationReclaim = (ctx, operation, now = new Date()) => prepareMongoUpdate(ctx, "operation_reclaim", {\n  _id: ctx.operationKey,\n  operationId: operation.operationId ?? null,\n  state: operation.state,\n  ...tournamentAdmissionReclaimFence,\n  tournamentAbort: operation.tournamentAbort ?? { $exists: false },');
  const bookingPost = '  return prepareHttp(\n    ctx,\n    "booking_create",\n    "POST",';
  source = once(source, bookingPost,
    '  const dispatch = tournamentAdmissionDispatch(ctx); if (dispatch) return dispatch;\n' + bookingPost);
  const reclaimUnset = '    precreateRejection: "",\n    precreateReconciliationCode: "",\n  },\n});';
  source = once(source, reclaimUnset,
    '    ...tournamentAdmissionResetReclaimed(operation),\n' + reclaimUnset);
  if (hasDailyVisitGuard) {
    source = once(source, '  if (guard.ownerOperationKey === ctx.operationKey) {', `  if (guard.admissionRelease?.operationKey === guard.ownerOperationKey
    && guard.admissionRelease?.operationId === guard.ownerOperationId) {
    ctx.step = "lk1_daily_visit_takeover"; msg._subscriptionBooking = ctx;
    msg.payload = [{ _id: guard._id, kind: "LK1_DAILY_VISIT_V1", ownerOperationKey: guard.ownerOperationKey,
      ownerOperationId: guard.ownerOperationId, admissionRelease: guard.admissionRelease },
      { $set: { ownerOperationKey: ctx.operationKey, ownerOperationId: ctx.operationId }, $unset: { admissionRelease: "" } },
      { writeConcern: { w: "majority", j: true } }];
    delete msg.error; return emit(OUTPUT_MONGO_UPDATE);
  }
  if (guard.ownerOperationKey === ctx.operationKey) {`);
  }
  const seatCandidate = 'function lk1SeatCandidate(op) {';
  if (source.includes(seatCandidate)) {
    source = once(source, seatCandidate, seatCandidate + '\n  if (op?.tournamentAbort !== undefined) return false;');
  }
  if (source.includes('const lk1ReplayIdentityMatches =')) {
    const confirmedReplay = '    if (ctx.caller !== "split") return lk1Finish(ctx);';
    source = once(source, confirmedReplay, `    if (ctx.caller !== "split") {
      const pending = tournamentAdmissionRestoreCompletion(ctx, operation);
      if (pending) return pending;
      return lk1Finish(ctx);
    }`);
    const reclaim = '      return prepareMongoUpdate(ctx, "lk1_ingress_reclaim", reclaimQuery, {';
    source = once(source, reclaim,
      '      return prepareMongoUpdate(ctx, "lk1_ingress_reclaim", { ...reclaimQuery, ...tournamentAdmissionReclaimFence }, {');
    for (const check of [
      '    if (!quote || quote.code || quote.fingerprint !== ctx.lk1.fingerprint) {',
      '    if (quote.code || quote.fingerprint !== ctx.lk1?.fingerprint) {',
    ]) {
      const stop = '      return lk1Stop(ctx, "LK1_RULE_PRICE_OR_TARGET_CHANGED_BEFORE_WRITE");';
      source = once(source, check + '\n' + stop, check + '\n'
        + '      const abort = tournamentAdmissionManagedAbort(ctx, exercise, quote);\n'
        + '      if (abort) return abort;\n' + stop);
    }
  }
  source = once(source, 'const finishConfirmed = (ctx, bookingId, statusCode = 200) => {',
    'const finishConfirmed = (ctx, bookingId, statusCode = 200) => {\n'
    + '  if (!ctx.lk1) { const completion = tournamentAdmissionComplete(ctx, bookingId); if (completion) return completion; }');
  if (source.includes('const lk1Finish = (ctx) => {')) source = once(source, '  finishConfirmed(ctx, ctx.confirmedBookingId);',
    '  const completion = tournamentAdmissionComplete(ctx, ctx.confirmedBookingId); if (completion) return completion;\n  finishConfirmed(ctx, ctx.confirmedBookingId);');
  return source;
}
