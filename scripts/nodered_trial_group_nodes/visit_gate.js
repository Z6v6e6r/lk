// Embedded after the policy library. Outputs match the existing booking gateway.
function trialFinish(status, code, details) {
  msg.statusCode = status;
  msg.headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*' };
  msg.payload = { error: code === 'TRIAL_TRAINING_VISIT_LIMIT_EXCEEDED'
    ? 'Пробная групповая тренировка доступна при не более двух посещениях за последние 6 месяцев'
    : 'Не удалось проверить доступ к пробной тренировке. Повторите попытку позже.',
  details: { code, ...details } };
  const out = [null, null, null, null, null, null, null]; out[4] = msg; return out;
}
function trialReadPolicy() {
  let value;
  try { value = global.get(TRIAL_GROUP_POLICY_GLOBAL); } catch { return { code: 'TRIAL_TRAINING_POLICY_UNVERIFIED' }; }
  return normalizeTrialGroupPolicy(value);
}
function trialHttp(ctx, step, url) {
  ctx.step = step;
  msg._subscriptionBooking = ctx;
  msg.method = 'GET'; msg.url = url;
  msg.headers = { Authorization: ctx.authHeader, Accept: 'application/json' };
  msg.payload = undefined;
  delete msg.error;
  msg.requestTimeout = 10000; msg.followRedirects = false; msg.maxRedirects = 0;
  const out = [msg, null, null, null, null, null, null]; return out;
}
function trialReadHistory(ctx) {
  const gate = ctx.trialVisitGate;
  const url = `https://api.vivacrm.ru/end-user/api/v2/${ctx.tenantKey}/bookings/history?includeCanceled=true&size=1000&page=${gate.page}`;
  gate.read = { url, actorId: ctx.actorClientId, authHeader: ctx.authHeader };
  return trialHttp(ctx, 'trial_visit_history', url);
}
function trialBeginGate(ctx, exercise, resume) {
  const policy = trialReadPolicy();
  if (policy.code) return trialFinish(503, policy.code);
  ctx.trialExercise = exercise;
  if (policy.mode === 'off') return null;
  if (!ctx.actorClientId || !/^Bearer\s+\S+$/i.test(ctx.authHeader || '')
    || trialId(exercise?.id) !== ctx.exerciseId) return trialFinish(503, 'TRIAL_TRAINING_TARGET_UNVERIFIED');
  // Created by this server gate, never accepted from an HTTP body.
  ctx.trialRequestedAt ||= new Date().toISOString();
  ctx.trialVisitGate = { policy, exercise, resume, page: 0, rows: [], requestedAt: ctx.trialRequestedAt };
  return trialReadHistory(ctx);
}
function trialHistoryOutcome(ctx) {
  const gate = ctx.trialVisitGate;
  const policy = trialReadPolicy();
  if (!gate || JSON.stringify(policy) !== JSON.stringify(gate.policy)) return { code: 'TRIAL_TRAINING_POLICY_CHANGED' };
  if (msg.error || !Number.isInteger(msg.statusCode) || msg.statusCode < 200 || msg.statusCode >= 300
    || msg.method !== 'GET' || msg.url !== gate.read?.url
    || (msg.responseUrl !== undefined && msg.responseUrl !== gate.read.url)
    || msg.followRedirects !== false || msg.maxRedirects !== 0
    || gate.read.actorId !== ctx.actorClientId || gate.read.authHeader !== ctx.authHeader) {
    return { code: 'TRIAL_TRAINING_HISTORY_UNAVAILABLE' };
  }
  const page = trialHistoryPage(msg.payload, gate.page, gate.total, gate.totalPages);
  if (page.code) return page;
  const rowIds = new Set(gate.rows.map(row => trialId(row.id ?? row.bookingId)));
  for (const row of page.rows) {
    const id = trialId(row?.id ?? row?.bookingId);
    if (!id || rowIds.has(id)) return { code: 'TRIAL_TRAINING_HISTORY_INCOMPLETE' };
    rowIds.add(id);
  }
  gate.total = page.total; gate.totalPages = page.totalPages; gate.rows.push(...page.rows);
  if (!page.last) { gate.page += 1; return { next: true }; }
  if (gate.rows.length !== gate.total) return { code: 'TRIAL_TRAINING_HISTORY_INCOMPLETE' };
  return evaluateTrialGroupVisits({ rows: gate.rows, actorId: ctx.actorClientId, requestedAt: gate.requestedAt });
}
function trialGateDecision(ctx, outcome) {
  const gate = ctx.trialVisitGate;
  if (outcome.code === 'TRIAL_TRAINING_POLICY_CHANGED') return trialFinish(503, outcome.code);
  if (outcome.next) return trialReadHistory(ctx);
  // Diagnostics contain counts/codes only, never raw history, phone or tokens.
  if (typeof node !== 'undefined' && typeof node.warn === 'function' && gate?.policy?.mode === 'shadow') {
    node.warn({ code: outcome.code || 'TRIAL_TRAINING_ALLOWED', mode: 'shadow', count: outcome.count ?? null });
  }
  if (gate?.policy?.mode !== 'shadow' && (outcome.code || outcome.eligible !== true)) {
    return trialFinish(outcome.code === 'TRIAL_TRAINING_VISIT_LIMIT_EXCEEDED' ? 409 : 503,
      outcome.code || 'TRIAL_TRAINING_ATTENDANCE_UNVERIFIED', { count: outcome.count ?? null, maxVisits: 2 });
  }
  ctx.trialVisitEvidence = { version: gate.policy.version, mode: gate.policy.mode,
    requestedAt: gate.requestedAt, actorId: ctx.actorClientId, exerciseId: ctx.exerciseId,
    count: outcome.count ?? null, code: outcome.code ?? null };
  return null;
}
function trialEvidenceMatches(ctx) {
  const evidence = ctx.trialVisitEvidence;
  const policy = trialReadPolicy();
  return !policy.code && evidence?.actorId === ctx.actorClientId && evidence.exerciseId === ctx.exerciseId
    && evidence.requestedAt === ctx.trialRequestedAt && evidence.version === policy.version && evidence.mode === policy.mode;
}
