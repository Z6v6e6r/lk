// tournament_auto_finish_write_v1: server-owned lifecycle; snapshot CAS on every writer.
const rows = Array.isArray(msg.payload) ? msg.payload : [msg.payload];
const original = rows[0];
const snapshot = original && Object.fromEntries(AUTO_FINISH_WRITE_FIELDS.map(key => [key,
  Object.prototype.hasOwnProperty.call(original, key)
    ? { value: key === '_id' || key.endsWith('At') ? original[key] : JSON.parse(JSON.stringify(original[key])) }
    : { missing: true },
]));
const lifecycle = original?.params?.autoFinish;
const managed = lifecycle?.version === 1;
const nowIso = new Date().toISOString();
const fpr = original?.tournamentType === 'fpr_6x25';
const fprFinished = ['completed', 'incomplete'].includes(original?.params?.fpr6x25?.status);
const genericFinished = AUTO_FINISH_IS_CLOSED(original || {});
const params = msg.req?.body?.params || {};
const resume = params.resumeRequested === true || params.resumeTournament === true;
const internal = msg._tournamentAutoFinishInternal === true;
const correction = fpr && params.fprCommand?.action === 'correct_score';
const fail = (code, message) => {
  delete msg.mongoQuery; delete msg.mongoUpdate; delete msg.query;
  msg.statusCode = 409;
  msg.payload = { error: code, message, retryable: false };
  return msg;
};
if (managed && !internal) {
  if ((params.autoFinish || lifecycle.session > 1) && params.autoFinish?.session !== lifecycle.session) return fail('TOURNAMENT_SESSION_CHANGED', 'Сеанс турнира изменился. Проверьте сохранённые локально результаты');
  if (rows.length !== 1) return fail('TOURNAMENT_AMBIGUOUS', 'Требуется проверка записей турнира');
  if (fpr && resume) return fail('TOURNAMENT_CLOSED', 'Протокол ФПР не поддерживает возобновление');
  if (!resume && !correction && (genericFinished || fprFinished)) return fail('TOURNAMENT_CLOSED', 'Турнир завершён. Результаты сохранены локально для проверки организатором');
  if (!resume && !correction && Date.parse(lifecycle.deadlineAt) <= Date.parse(nowIso)) return fail('TOURNAMENT_DEADLINE_REACHED', 'Три часа истекли. Результаты сохранены локально для проверки организатором');
  if (resume && !genericFinished) return fail('TOURNAMENT_NOT_CLOSED', 'Возобновить можно только завершённый турнир');
}
// Request params must never replace server timing, including on legacy tournaments.
if (msg.req?.body?.params) {
  msg.req = { ...msg.req, body: { ...msg.req.body, params: { ...params } } };
  delete msg.req.body.params.autoFinish;
}
const result = (() => { AUTO_FINISH_LEGACY_SOURCE })();
if (!result?.mongoQuery || !result.mongoUpdate?.$set || !original) return result;
const set = result.mongoUpdate.$set;
const getParam = key => Object.prototype.hasOwnProperty.call(set, 'params.' + key)
  ? set['params.' + key] : set.params?.[key];
let next = managed ? { ...lifecycle } : null;
// FPR is created ready; its first server-confirmed round start arms the timer.
if (!next && fpr && original.params?.fpr6x25?.status === 'ready'
    && getParam('fpr6x25')?.status === 'in_progress') {
  next = { version: 1, session: 1, startedAt: nowIso, deadlineAt: new Date(Date.parse(nowIso) + 10800000).toISOString() };
}
if (next && resume) next = {
  version: 1, session: next.session + 1, startedAt: next.startedAt,
  resumedAt: nowIso, deadlineAt: new Date(Date.parse(nowIso) + 10800000).toISOString(),
};
if (next) {
  if (!internal && !resume && (getParam('finished') === true
      || ['completed', 'incomplete'].includes(getParam('fpr6x25')?.status))) {
    next.reason = 'manual'; next.processedAt = nowIso;
  }
  if (set.params) set.params = { ...set.params, autoFinish: next };
  else set['params.autoFinish'] = next;
  result.payload.params = { ...result.payload.params, autoFinish: next };
}
// Preserve any existing FPR/monthly guards and add the pre-mutation snapshot.
const conditions = Object.entries(snapshot).map(([key, state]) => state.missing
  ? { [key]: { $exists: false } } : { [key]: { $eq: state.value } });
result.mongoQuery = { ...result.mongoQuery, $and: [...(result.mongoQuery.$and || []), ...conditions] };
return result;
