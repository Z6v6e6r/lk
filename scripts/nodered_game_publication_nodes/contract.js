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
  const bookingContract = splitPublicationBookingContract({ masterServiceId: split.masterServiceId, subServiceIds: split.subServiceIds,
    shareAmountMinor: split.shareAmountMinor ?? (Number.isFinite(split.shareAmount) ? Math.round(split.shareAmount * 100) : null),
    totalAmount: split.totalAmount ?? null, oneTimeBaseAmount: split.oneTimeBaseAmount ?? null,
    pricingPolicy: split.pricingPolicy ?? null, deadlineAt: split.deadlineAt ?? null, assembleDeadlineAt: split.assembleDeadlineAt ?? null });
  if (!intent || !bookingContract || !ctx.actorClientId || !ctx.actorPhone || !ctx.tenantKey || !ctx.operationId) return null;
  return { version: 1, state: 'PENDING', intent, intentJson: JSON.stringify(intent),
    actorClientId: ctx.actorClientId, actorPhone: ctx.actorPhone, tenantKey: ctx.tenantKey,
    operationId: ctx.operationId, createPayloadJson: JSON.stringify(ctx.lk1CreatePayload),
    bookingContract, bookingContractJson: JSON.stringify(bookingContract) };
}
function splitPublicationReplayMatches(stored, ctx, split) {
  const requested = splitPublicationIntent(split?.publicationIntent);
  if (!stored) return !requested || split?.publicationEnabled !== true
    || (ctx.lk1?.decision?.benefit?.finalPriceMinor > 0 || ctx.lk1?.decision?.subscriptionVisitCount === 0);
  return !!stored && !!requested && stored.version === 1
    && stored.intentJson === JSON.stringify(requested) && stored.actorClientId === ctx.actorClientId
    && stored.tenantKey === ctx.tenantKey && stored.operationId === ctx.operationId
    && stored.bookingContract?.masterServiceId === split.masterServiceId
    && Array.isArray(split.subServiceIds)
    && JSON.stringify(stored.bookingContract.subServiceIds) === JSON.stringify([...new Set(split.subServiceIds)].sort());
}
function splitPublicationGameId(tenantKey, exerciseId) {
  return 'gsp_' + Buffer.from(JSON.stringify([tenantKey, exerciseId]), 'utf8').toString('base64url');
}
// These are source locators and the server-resolved display quote, not permission
// to charge a later player. The existing JOIN path revalidates its tariff in Viva.
function splitPublicationBookingContract(value) {
  const locator = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(v);
  if (!value || !locator(value.masterServiceId) || !Array.isArray(value.subServiceIds)
    || !value.subServiceIds.length || value.subServiceIds.length > 32 || !value.subServiceIds.every(locator)) return null;
  const money = v => v == null ? null : Number.isFinite(v) && v >= 0 && v <= 1e9 ? v : undefined;
  const date = v => v == null ? null : typeof v === 'string' && v.length <= 64 && Number.isFinite(Date.parse(v)) ? v : undefined;
  const p = value.pricingPolicy;
  let pricingPolicy = null;
  if (p != null) {
    if (!locator(p.id) || p.pricingMode !== 'PER_PARTICIPANT_HOUR' || p.currency !== 'RUB'
      || !Number.isFinite(p.twoTeamsHourlyAmount) || p.twoTeamsHourlyAmount < 0
      || !Number.isFinite(p.fourPlayersHourlyAmount) || p.fourPlayersHourlyAmount < 0) return null;
    pricingPolicy = { id: p.id, title: typeof p.title === 'string' ? p.title.slice(0, 120) : null,
      pricingMode: p.pricingMode, currency: p.currency, twoTeamsHourlyAmount: p.twoTeamsHourlyAmount,
      fourPlayersHourlyAmount: p.fourPlayersHourlyAmount, activeFrom: date(p.activeFrom), activeTo: date(p.activeTo),
      version: typeof p.version === 'string' ? p.version.slice(0, 200) : p.id };
    if (Object.values(pricingPolicy).includes(undefined)) return null;
  }
  const result = { masterServiceId: value.masterServiceId, subServiceIds: [...new Set(value.subServiceIds)].sort(),
    shareAmountMinor: money(value.shareAmountMinor), totalAmount: money(value.totalAmount),
    oneTimeBaseAmount: money(value.oneTimeBaseAmount), pricingPolicy,
    deadlineAt: date(value.deadlineAt), assembleDeadlineAt: date(value.assembleDeadlineAt) };
  return Object.values(result).includes(undefined) ? null : result;
}
