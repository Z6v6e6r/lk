// Shared pure contract: composed into Node-RED and loaded by the publication worker.
// Only author choices travel in the intent. Identity, roster and payment never do.
function splitPublicationIntent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = ['version', 'settings', 'gameTitle', 'participantComment', 'joinPrice', 'studioName', 'roomName', 'gameFormat'];
  if (Object.keys(value).some(k => !keys.includes(k)) || value.version !== 1) return null;
  const s = value.settings;
  if (!s || Object.keys(s).some(k => !['isPrivate', 'ratingGame', 'minRating', 'maxRating'].includes(k))
    || typeof s.isPrivate !== 'boolean' || typeof s.ratingGame !== 'boolean') return null;
  const text = (v, limit) => v == null ? null : typeof v === 'string' && v.length <= limit && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v) ? v.trim() || null : undefined;
  const result = { version: 1, settings: { isPrivate: s.isPrivate, ratingGame: s.ratingGame,
    minRating: text(s.minRating, 24), maxRating: text(s.maxRating, 24) },
  gameTitle: text(value.gameTitle, 120), participantComment: text(value.participantComment, 1000),
  joinPrice: text(value.joinPrice, 12), studioName: text(value.studioName, 120), roomName: text(value.roomName, 120),
  gameFormat: value.gameFormat === 'singles' ? 'singles' : value.gameFormat === 'doubles' ? 'doubles' : undefined };
  if (Object.values(result).includes(undefined) || Object.values(result.settings).includes(undefined)
    || (result.joinPrice !== null && !/^\d{1,9}$/.test(result.joinPrice))) return null;
  return result;
}
function splitPublicationSnapshot(ctx, split) {
  if (ctx?.caller !== 'split' || ctx.managedAction !== 'CREATE_GAME' || ctx.lk1BeforeCreate !== true
    || split?.action !== 'create' || split.publicationEnabled !== true || !split.publicationIntent || !ctx.lk1
    || ctx.lk1.decision?.benefit?.finalPriceMinor !== 0 || ctx.lk1.decision?.subscriptionVisitCount !== 1) return null;
  const intent = splitPublicationIntent(split.publicationIntent);
  if (!intent || !ctx.actorClientId || !ctx.actorPhone || !ctx.tenantKey || !ctx.operationId) return null;
  return { version: 1, state: 'PENDING', intent, intentJson: JSON.stringify(intent),
    actorClientId: ctx.actorClientId, actorPhone: ctx.actorPhone, tenantKey: ctx.tenantKey,
    operationId: ctx.operationId, createPayloadJson: JSON.stringify(ctx.lk1CreatePayload) };
}
function splitPublicationSame(stored, requested) {
  if (!stored) return !requested || split?.publicationEnabled !== true;
  return !!stored && !!requested && stored.version === 1 && requested.version === 1
    && ['intentJson', 'actorClientId', 'actorPhone', 'tenantKey', 'operationId', 'createPayloadJson']
      .every(k => stored[k] === requested[k]);
}
function splitPublicationReplayMatches(stored, ctx, split) {
  const requested = splitPublicationIntent(split?.publicationIntent);
  if (!stored && !requested) return true;
  return !!stored && !!requested && stored.version === 1
    && stored.intentJson === JSON.stringify(requested) && stored.actorClientId === ctx.actorClientId
    && stored.tenantKey === ctx.tenantKey && stored.operationId === ctx.operationId;
}
function splitPublicationGameId(tenantKey, exerciseId) {
  return 'gsp_' + Buffer.from(JSON.stringify([tenantKey, exerciseId]), 'utf8').toString('base64url');
}
