// tournament_auto_finish_prepare_v1: preserve an existing managed protocol atomically.
// Generic creation generates the live draw; FPR creation is only a ready protocol.
const input = msg.payload;
if (input?.params) {
  msg.payload = { ...input, params: { ...input.params } };
  delete msg.payload.params.autoFinish;
}
const result = (() => { AUTO_FINISH_LEGACY_SOURCE })();
const prepared = result?.[0];
if (!prepared || Number(prepared.statusCode) >= 400) return result;
const nowIso = new Date().toISOString();
const timing = { version: 1, session: 1, startedAt: nowIso, deadlineAt: new Date(Date.parse(nowIso) + 10800000).toISOString() };
let envelope = prepared.payload;
const wrapped = Array.isArray(envelope) && envelope.length === 2 && Array.isArray(envelope[1]);
let pipeline = wrapped ? envelope[1] : Array.isArray(envelope) ? envelope : null;
const fprCreate = input?.tournamentType === 'fpr_6x25';
if (fprCreate) return result;
// Offline/imported completed tournaments are historical results, not a fresh start.
const historical = AUTO_FINISH_IS_FINAL(input || {});
if (!pipeline && envelope?.$set && envelope?.$setOnInsert) {
  pipeline = [{ $replaceRoot: { newRoot: { $mergeObjects: ['$$ROOT', { $literal: envelope.$set },
    { createdAt: { $ifNull: ['$createdAt', { $literal: envelope.$setOnInsert.createdAt }] } }] } } }];
}
if (!pipeline) throw new Error('AUTO_FINISH_UNSUPPORTED_CREATE_PIPELINE');
// The previous start/deadline/rounds win over duplicate or stale create requests.
const protectedDocument = { $eq: ['$params.autoFinish.version', 1] };
const transformed = pipeline.map(stage => {
  const expression = stage.$replaceRoot?.newRoot || stage.$replaceWith;
  if (!expression) {
    // The installed FPR wrapper appends only a deterministic _id stage.
    if (Object.keys(stage).length === 1 && stage.$set?._id && Object.keys(stage.$set).length === 1) return stage;
    throw new Error('AUTO_FINISH_UNSUPPORTED_CREATE_STAGE');
  }
  const next = historical ? expression : { $cond: [
    { $eq: [{ $type: '$_id' }, 'missing'] },
    { $let: { vars: { created: expression }, in: { $mergeObjects: ['$$created', {
      params: { $mergeObjects: ['$$created.params', { $literal: { autoFinish: timing } }] },
    }] } } }, expression,
  ] };
  return { $replaceRoot: { newRoot: { $cond: [protectedDocument, '$$ROOT', next] } } };
});
prepared.payload = [wrapped ? envelope[0] : prepared.query, transformed];
prepared._tournamentAutoFinishCreateGuard = true;
return result;
