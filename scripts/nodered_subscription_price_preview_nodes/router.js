// Diagnostic observer: optional, no-throw; sourceHash is the uninstrumented business preimage.
const lkDiagnostic = (fields = {}) => {
  try {
    const observer = typeof global !== "undefined" && typeof global.get === "function"
      ? global.get("lkDiagnostics") : null;
    if (typeof observer?.observe === "function") {
      observer.observe(msg, "preview_router", { sourceHash: "d421c9c431db409c6c4b39f5ce445f31f2e6eecdd6f6d919b9ba2f9c03e93536", ...fields });
      return;
    }
  } catch { /* Observability cannot alter business execution. */ }
  // Installed flows may predate the shared observer. Use a separate info event,
  // so this does not duplicate the final node's legacy refusal warning/count.
  try {
    if (fields.code === 'PRICE_PREVIEW_BOOKINGS_INCOMPLETE') {
      if (!['activeBookings', 'historyBookings'].includes(fields.operationStage)
        || !['upstream_status', 'list_incomplete_or_unrecognized', 'row_not_object',
          'row_id_missing', 'row_owner_mismatch'].includes(fields.firstFailure)
        || typeof node === 'undefined' || typeof node.log !== 'function') return;
      const event = { event: 'subscription_price_preview_bookings_refused', code: fields.code,
        stage: 'preview_router', operationStage: fields.operationStage, firstFailure: fields.firstFailure };
      if (Number.isInteger(fields.upstreamStatus) && fields.upstreamStatus >= 100 && fields.upstreamStatus <= 599) {
        event.upstreamStatus = fields.upstreamStatus;
      }
      node.log(JSON.stringify(event));
      return;
    }
    const reasons = ['target_upstream_error', 'target_missing', 'target_identity', 'target_category',
      'target_studio', 'target_room', 'target_duration', 'target_start_invalid', 'target_cancelled',
      'target_lifecycle', 'PRICE_PREVIEW_SUBSCRIPTION_SCHEMA_INVALID'];
    if (fields.code !== 'PRICE_PREVIEW_GAME_UNRESOLVED' || !reasons.includes(fields.reason)
      || typeof node === 'undefined' || typeof node.log !== 'function') return;
    const event = { event: 'subscription_price_preview_exercise_refused', code: fields.code,
      step: 'exercise', reason: fields.reason };
    if (Number.isInteger(fields.upstreamStatus) && fields.upstreamStatus >= 100 && fields.upstreamStatus <= 599) {
      event.upstreamStatus = fields.upstreamStatus;
    }
    if (['object', 'array', 'text', 'number', 'boolean', 'null', 'missing', 'UNKNOWN'].includes(fields.responseKind)) {
      event.responseKind = fields.responseKind;
    }
    if (['json', 'text', 'html', 'other', 'missing'].includes(fields.contentTypeClass)) {
      event.contentTypeClass = fields.contentTypeClass;
    }
    if (fields.reason === 'target_duration') {
      const enums = {
        previewCanonicalDuration: ['NULL', 'DIFFERENT', 'UNKNOWN'],
        previewExplicitDuration: ['ABSENT', 'VALID', 'INVALID', 'UNKNOWN'],
        previewEndpointDuration: ['NULL', 'MATCH_TARGET', 'DIFFERENT', 'UNKNOWN'],
      };
      for (const [key, values] of Object.entries(enums)) {
        if (values.includes(fields[key])) event[key] = fields[key];
      }
      for (const key of ['previewExplicitMatchesEndpoints', 'previewEndpointOffsetPairValid',
        'previewEndpointStartMatch', 'previewDurationFactsFailed']) {
        if (typeof fields[key] === 'boolean') event[key] = fields[key];
      }
    }
    node.log(JSON.stringify(event));
  } catch { /* The optional fallback cannot change a business verdict either. */ }
};
lkDiagnostic({ code: "STAGE_ENTER" });
// Dedicated advisory graph. `canonical` consists only of source-bound helpers.
const ctx = msg._subscriptionPricePreview;
if (!ctx) return null;
// Only called after the existing legacy guard has refused. Never rerun a resolver,
// inspect provider rows, or put plan/product names or identity into diagnostics.
const lkLegacyPlanDiagnostic = (plan, configured, name) => {
  try {
    const event = { event: 'subscription_price_preview_legacy_plan_refused', schemaVersion: 1,
      code: 'PRICE_PREVIEW_LEGACY_PLAN_UNRESOLVED', stage: 'preview_router', step: 'next',
      previewLegacyPlanVerdict: !plan ? 'NO_PLAN' : typeof plan === 'string' ? 'OPEN_GAME_EXCLUDED' : 'UNKNOWN',
      previewLegacyRuleDisposition: 'UNKNOWN', previewLegacyResolverEvidence: !plan ? 'NO_RECOGNIZED_MARKER' : 'UNKNOWN',
      previewTargetKind: 'UNKNOWN', previewLegacyOrigin: 'UNKNOWN',
      previewLegacyRequestedCountBucket: 'UNKNOWN', previewLegacyFactsFailed: true };
    try {
      const own = (object, key) => {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor) return undefined;
        if (!Object.hasOwn(descriptor, 'value')) throw 0;
        return descriptor.value;
      };
      const matched = own(configured, 'matched'), legacy = own(configured, 'legacy');
      if (matched === false) event.previewLegacyRuleDisposition = 'NO_MATCH';
      else if (matched === true && legacy === true) {
        if (own(configured, 'stationLegacy') === true) event.previewLegacyRuleDisposition = 'STATION_EXCLUDED';
        else {
          const purchase = own(configured, 'purchaseDate'), cutoff = own(configured, 'enforceFrom');
          if (own(configured, 'source') === 'PLAN' && typeof purchase === 'string'
            && typeof cutoff === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(purchase)
            && /^\d{4}-\d{2}-\d{2}$/.test(cutoff) && purchase < cutoff) {
            event.previewLegacyRuleDisposition = 'SALE_BEFORE_CUTOFF';
          }
        }
      } else if (matched === true && legacy === false) event.previewLegacyRuleDisposition = 'MANAGED';
      const existing = own(ctx, 'existingGame');
      event.previewTargetKind = existing === true ? 'EXISTING_GAME' : existing === false ? 'NEW_GAME' : 'UNKNOWN';
      const requested = own(ctx, 'requestedIds'), quotes = own(ctx, 'quotes');
      if (Array.isArray(requested)) {
        const count = own(requested, 'length');
        if (Number.isSafeInteger(count)) {
          event.previewLegacyRequestedCountBucket = count === 1 ? 'ONE' : count > 1 ? 'MULTIPLE' : 'UNKNOWN';
        }
      }
      if (Array.isArray(quotes)) {
        const count = own(quotes, 'length');
        if (Number.isSafeInteger(count)) event.previewLegacyPartialQuotesDiscarded = count > 0;
      }
      if (typeof name === 'string') event.previewLegacyBoundNamePresent = name.trim().length > 0;
      event.previewLegacyFactsFailed = false;
    } catch { /* Missing/unreadable optional facts stay UNKNOWN; no exception text. */ }
    // Dedicated info event also works when an installed scoped observer silently
    // filters other codes. It does not duplicate the final refusal warning/count.
    if (typeof node !== 'undefined' && typeof node.log === 'function') node.log(JSON.stringify(event));
  } catch { /* Optional diagnostics cannot change the business verdict. */ }
};
// Event identity is checked again against Viva; caller input cannot select a game tariff.
const eventCategory = ctx.eventCategory || (ctx.groupTraining ? 'GROUP_TRAINING' : null);
const eventRoute = eventCategory === 'GROUP_TRAINING'
  ? { category: 'group_training', action: 'BOOK_GROUP_TRAINING', rule: 'groupTrainingDiscountPercent',
    kind: 'GROUP_TRAINING_SUBSCRIPTION_DISCOUNT_V1', error: 'GROUP_DISCOUNT' }
  : eventCategory === 'TOURNAMENT'
    ? { category: 'tournament', action: 'BOOK_TOURNAMENT', rule: 'tournamentDiscountPercent',
      kind: 'TOURNAMENT_SUBSCRIPTION_DISCOUNT_V1', error: 'TOURNAMENT_DISCOUNT' } : null;
// The club court-hourly co-pay (owner decision 2026-10-05) is not a percentage of the event
// tariff, so an event quote that carries it gets its own kind and its own numbers instead of a
// percent: `discountPercent` stays 0, and `chargeableHours`/`hourlyCourtPriceMinor`/`perHourMinor`
// are what the widget validates and displays. The percentage kinds above stay byte-compatible.
const COURT_COPAY_QUOTE_KIND = 'GROUP_TRAINING_COURT_COPAY_V1';
const out = index => { const result = [null, null, null, null, null, null]; result[index] = msg; return result; };
const stop = (code, status = 503) => { ctx.done = true; ctx.error = code; ctx.statusCode = status; return out(4); };
// A decision blocker states something about this subscription, not about the request.
// Only the codes below describe a state the client can act on (book with another
// subscription, or pay the ordinary price); every other code stays a fail-closed 503.
// `ACTIVE_SERVICES_LIMIT_REACHED` is the superseded cap blocker: the cap is a discount
// now (`aboveActiveLimit`), and the code is kept only for generations that still emit it.
// `USAGE_SNAPSHOT_BUCKET_MISMATCH` is what that cap used to mask for a client whose
// active bookings are full and whose free-minute snapshot does not prove the day, so it
// restores the pre-release answer for exactly that cohort.
const LIMIT_DECISION_BLOCKERS = ['ACTIVE_SERVICES_LIMIT_REACHED', 'USAGE_SNAPSHOT_BUCKET_MISMATCH'];
// A subscription that cannot be applied to this booking is not a transport failure: the
// target is outside the rule, the event is not included, or a partial benefit has no
// proven tariff to attach the paid part to (the contract forbids inventing the surcharge).
const UNAVAILABLE_DECISION_BLOCKERS = ['TARGET_NOT_SERVER_RESOLVED', 'EVENT_NOT_INCLUDED',
  'LK1_GAME_OVERAGE_ALLOCATION_UNBOUND'];
const ok = () => !msg.error && Number(msg.statusCode) >= 200 && Number(msg.statusCode) < 300;
const rows = () => canonical.extractItems(msg.payload);
const key = (kind, ...parts) => JSON.stringify([kind, ctx.tenantKey, ...parts]);
const find = (step, query, output = 1) => {
  ctx.step = step; delete msg.error; delete msg.headers; delete msg.statusCode;
  msg.payload = query; return out(output);
};
const http = (step, path, admin = false) => {
  const token = admin ? global.get('vivacrm_access_token') : null;
  if (admin && (typeof token !== 'string' || !token
    || !Number.isFinite(Number(global.get('vivacrm_token_expires_at'))) || Number(global.get('vivacrm_token_expires_at')) <= Date.now() + 30000)) return stop('VIVA_SERVICE_TOKEN_UNAVAILABLE');
  // A request's provenance must be its own response: Node-RED sets `msg.responseUrl`
  // on every reply and the group-tariff step compares it with the URL it asked for.
  // A stale value from the previous step made every event quote fail
  // `LK1_EVENT_TARIFF_UNVERIFIED` while the response itself was correct.
  ctx.step = step; delete msg.error; delete msg.responseUrl; delete msg.statusCode;
  msg.method = 'GET'; msg.url = 'https://api.vivacrm.ru' + path;
  msg.headers = { Authorization: admin ? `Bearer ${token}` : ctx.auth, Accept: 'application/json' };
  msg.payload = undefined; msg.requestTimeout = 10000; msg.followRedirects = false; msg.maxRedirects = 0;
  return out(0);
};
const quote = (subscriptionId, status, amountMinor = null, freeMinutes = 0, paidMinutes = 0, reasonCode = null, courtCoPay = null) => {
  ctx.quotes.push({ subscriptionId, selectionKey: ctx.selectionKey, status, basePriceMinor: ctx.basePriceMinor,
    amountMinor, freeMinutes, paidMinutes, reasonCode,
    ...(eventRoute ? { kind: courtCoPay ? COURT_COPAY_QUOTE_KIND : eventRoute.kind, exerciseId: ctx.exerciseId,
      actorClientId: ctx.actorClientId, productId: ctx.priceProductId, subscriptionName: ctx.metadata[subscriptionId] ? ctx.catalog[ctx.metadata[subscriptionId].productId] : undefined,
      discountPercent: ctx.groupDiscountPercent, startsAt: ctx.target.startsAt, durationMinutes: ctx.target.durationMinutes } : {}),
    // Only the court co-pay carries the court's own numbers; every other event and game quote keeps
    // exactly the fields it had before, so the existing client validators see the same shape.
    ...(eventRoute && courtCoPay ? { chargeableHours: courtCoPay.chargeableHours,
      hourlyCourtPriceMinor: courtCoPay.hourlyCourtPriceMinor, perHourMinor: courtCoPay.perHourMinor } : {}),
    evaluatedAt: Date.now(), expiresAt: Date.now() + 30000 });
};
// The Viva direction of the event, read through the same aliases the booking gateway uses,
// so the advisory quote and the booking evaluate the club direction identically.
const previewDirectionId = (canonical, exercise) => {
  const rawDirection = exercise?.direction ?? exercise?.exerciseDirection;
  const nested = canonical.isObj(rawDirection) ? rawDirection : null;
  const value = nested ? (nested.id ?? nested.directionId) : rawDirection;
  const numeric = Number(value ?? exercise?.directionId ?? exercise?.exerciseDirectionId);
  return Number.isInteger(numeric) ? numeric : null;
};
// The preview owns no rule copy. It asks the shared resolver named in the
// rollout contract (scripts/lib/lk1PlanRules.mjs), which Node-RED receives as a
// generated declaration inside this node's helper closure. The guarded fallback
// below only keeps an un-generated runtime on its current HUB-only behaviour and
// owns no rule constant of its own.
const previewRule = (owned, stationId) => {
  if (typeof canonical.resolveLk1Rule === 'function') {
    try {
      const globalReader = typeof canonical.lk1PlanRulesGlobal === 'function' ? canonical.lk1PlanRulesGlobal : null;
      const planRules = globalReader ? globalReader() : undefined;
      const stationReader = typeof canonical.lk1ReadStationExclusions === 'function' ? canonical.lk1ReadStationExclusions : null;
      const stationExclusions = stationReader ? stationReader() : undefined;
      // The station of the priced target travels with the instance: an excluded station has
      // to reach the same legacy verdict as the booking gateway, otherwise the preview keeps
      // advertising a discount the write path will not charge.
      return canonical.resolveLk1Rule({ owned, stationId,
        ...(planRules === undefined ? {} : { planRules }),
        ...(stationExclusions === undefined ? {} : { stationExclusions }) });
    } catch (_) { return { matched: true, code: 'LK1_PLAN_RULES_INVALID' }; }
  }
  const configured = canonical.lk1Config(owned, stationId);
  if (!configured.matched || configured.code) return configured;
  const dates = canonical.collectSubscriptionPurchaseDateEvidence(owned);
  if (dates.invalid || dates.dates.length !== 1) return { matched: true, code: 'SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED' };
  const enforceFrom = '2026-09-01';
  return dates.dates[0] < enforceFrom
    ? { matched: true, legacy: true, purchaseDate: dates.dates[0], enforceFrom, source: 'PLAN' }
    : { matched: true, legacy: false, rule: configured.rule, productId: configured.rule.productId,
      purchaseDate: dates.dates[0], enforceFrom, source: 'PLAN' };
};
const previewRuleCode = (configured) => configured.code === 'LK1_PRODUCT_RULE_SOURCE_MISMATCH'
  ? 'LK1_PLAN_RULES_INVALID' : configured.code;
if (ctx.done) return out(4);
if (eventRoute && typeof canonical.identityMoneyOwned !== 'function') return stop(eventRoute.error + '_BACKEND_NOT_READY');
if (msg.error) return stop('PRICE_PREVIEW_READ_FAILED');
if (Date.now() - ctx.startedAt > 28000) return stop('PRICE_PREVIEW_TIMEOUT');
if (ctx.step === 'start') return http('profile', `/end-user/api/v1/${ctx.tenantKey}/profile`);
if (ctx.step === 'profile') {
  const profile = canonical.unwrapRecord(msg.payload);
  if (!ok() || !profile || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(profile.id || profile.clientId || '')) return stop('PRICE_PREVIEW_AUTH_REQUIRED', 401);
  ctx.actorClientId = profile.id || profile.clientId;
  if (eventRoute) return http('groupExercise', `/end-user/api/v1/${ctx.tenantKey}/exercises/${ctx.exerciseId}`);
  if (ctx.existingGame) return find('game', { id: ctx.target.gameId }, 5);
  return http('subscriptions', `/end-user/api/v1/${ctx.tenantKey}/subscriptions?includeFinished=true&size=1000`);
}
if (ctx.step === 'groupExercise') {
  const exercise = canonical.unwrapRecord(msg.payload);
  const start = Date.parse(canonical.eventStartsAt(exercise));
  const duration = canonical.eventDurationMinutes(exercise);
  const targetUnresolved = reason => {
    const upstreamStatus = Number(msg.statusCode);
    ctx.errorDetails = { reason,
      upstreamStatus: Number.isInteger(upstreamStatus) && upstreamStatus >= 100 && upstreamStatus <= 599
        ? upstreamStatus : null };
    return stop(eventRoute.error + '_TARGET_UNRESOLVED');
  };
  // Preserve the fail-closed guard and its order, while identifying its failed predicate.
  if (!ok()) return targetUnresolved('target_upstream_error');
  if (!exercise) return targetUnresolved('target_missing');
  if (String(exercise.id || exercise.exerciseId || '') !== ctx.exerciseId) return targetUnresolved('target_identity');
  if (canonical.resolveCategory(exercise) !== eventRoute?.category) return targetUnresolved('target_category');
  if (!Number.isFinite(start)) return targetUnresolved('target_start_invalid');
  if (start <= Date.now()) {
    // A dedicated info event also works with older, code-filtered observers.
    // No payload, target identity, date, clock value or error text may leave here.
    try {
      const event = { event: 'subscription_price_preview_target_not_future', schemaVersion: 1,
        code: 'TARGET_NOT_FUTURE', step: 'groupExercise', reason: 'target_not_future',
        startRelation: 'UNKNOWN', startAlias: 'UNKNOWN', startFormat: 'UNKNOWN',
        elapsedBucket: 'UNKNOWN', factsFailed: true };
      try {
        const own = (object, key) => {
          const prototype = Object.getPrototypeOf(object);
          // Plain Node-RED messages can originate outside this function's VM.
          if (prototype !== null && Object.getPrototypeOf(prototype) !== null) throw 0;
          const descriptor = Object.getOwnPropertyDescriptor(object, key);
          if (!descriptor) return undefined;
          if (!Object.hasOwn(descriptor, 'value')) throw 0;
          const value = descriptor.value;
          if (value != null && !['string', 'number', 'boolean'].includes(typeof value)) throw 0;
          if (typeof value === 'string' && value.length > 128) throw 0;
          return value;
        };
        const aliases = [['timeFrom', 'TIME_FROM'], ['startsAt', 'STARTS_AT'],
          ['startAt', 'START_AT'], ['fromTime', 'FROM_TIME']];
        const parsed = aliases.map(([key, alias]) => {
          const raw = String(own(exercise, key) || '');
          return { raw, alias, instant: new Date(raw).getTime() };
        }).filter(value => Number.isFinite(value.instant));
        const selected = parsed[0];
        // The observer must agree with the owning parser; never invent an alias.
        if (!selected || selected.instant !== start) throw 0;
        const now = Date.now();
        const entered = own(ctx, 'startedAt');
        const age = now - entered;
        const clockKnown = Number.isFinite(now) && Number.isFinite(entered) && age >= 0;
        const raw = selected.raw;
        const iso = raw.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):?(\d{2}))$/i);
        let explicitOffsetValid = false;
        if (iso && Number(iso[5] || 0) <= 23 && Number(iso[6] || 0) <= 59) {
          const offset = iso[3].toUpperCase() === 'Z' ? 0
            : (iso[4] === '-' ? -1 : 1) * (Number(iso[5]) * 60 + Number(iso[6]));
          explicitOffsetValid = new Date(start + offset * 60000).toISOString().slice(0, 23)
            === `${iso[1]}.${(iso[2] || '').padEnd(3, '0')}`;
        }
        Object.assign(event, {
          startRelation: !clockKnown ? 'UNKNOWN' : start < entered ? 'PAST_AT_ENTRY'
            : start === entered ? 'NOW_AT_ENTRY' : start <= now ? 'CROSSED_DURING_REQUEST' : 'UNKNOWN',
          startAlias: selected.alias,
          startFormat: /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? 'ISO_OFFSET'
            : /^\d{4}-\d{2}-\d{2}T/.test(raw) ? 'ISO_OFFSETLESS'
              : /^\d{4}-\d{2}-\d{2}$/.test(raw) ? 'DATE_ONLY' : 'OTHER',
          elapsedBucket: !clockKnown ? 'UNKNOWN' : age < 1000 ? 'LT1S' : age < 5000 ? 'LT5S'
            : age < 15000 ? 'LT15S' : age <= 28000 ? 'LE28S' : 'OVER28S',
          explicitOffsetValid, aliasConflict: parsed.some(value => value.instant !== start), factsFailed: false,
        });
      } catch { /* Unsafe or unrecognized data yields only the fixed UNKNOWN shape. */ }
      if (typeof node !== 'undefined' && typeof node?.log === 'function') node.log(JSON.stringify(event));
    } catch { /* Diagnostics cannot change the guard, response or continuation. */ }
    lkDiagnostic({ code: "TARGET_NOT_FUTURE", targetFuture: false, targetTimeValid: Number.isFinite(start), sourceTimeValid: true,
      deltaBucket: start < Date.now() ? "past" : "now", branch: eventRoute ? "schedule" : ctx.existingGame ? "game" : "UNKNOWN", targetType: eventRoute ? "schedule" : ctx.existingGame ? "game" : "UNKNOWN" });
    return targetUnresolved('target_not_future');
  }
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 720) return targetUnresolved('target_duration');
  if (!canonical.exerciseRoomId(exercise)) return targetUnresolved('target_room');
  if (!(exercise.studio?.id || exercise.studioId)) return targetUnresolved('target_studio');
  if (!canonical.managedExternalEventTypeId(exercise)) return targetUnresolved('target_type');
  if (exercise.isCancelled === true || exercise.isCanceled === true) return targetUnresolved('target_cancelled');
  if (['CANCELLED', 'CANCELED', 'DELETED', 'FINISHED', 'COMPLETED'].includes(String(exercise.status || '').toUpperCase())) {
    return targetUnresolved('target_lifecycle');
  }
  if (canonical.isSpanishTrainingExercise(exercise)) {
    ctx.quotes = [];
    ctx.done = true;
    return out(4);
  }
  ctx.exercise = exercise;
  const proTraining = eventRoute.category === 'group_training' && canonical.isProTrainingExercise(exercise);
  // The direction decides whether this event is the club direction whose co-pay is charged
  // against the hour of court; it is read here once, by the same helper the target carries.
  ctx.directionId = previewDirectionId(canonical, exercise);
  ctx.target = { ...ctx.target, ...(proTraining ? { proTraining: true } : {}), startsAt: new Date(start + 180 * 60000).toISOString().slice(0, 23) + '+03:00',
    durationMinutes: duration, stationId: exercise.studio?.id || exercise.studioId, roomId: canonical.exerciseRoomId(exercise) };
  return http('subscriptions', `/end-user/api/v1/${ctx.tenantKey}/subscriptions?includeFinished=true&size=1000`);
}
if (ctx.step === 'game') {
  if (!Array.isArray(msg.payload) || msg.payload.length !== 1 || msg.payload[0]?.id !== ctx.target.gameId) return stop('PRICE_PREVIEW_GAME_UNRESOLVED');
  const game = msg.payload[0];
  const booking = game.booking || {};
  const metadata = game.metadata || {};
  const splitPayment = metadata.splitPayment || {};
  const exerciseIds = [splitPayment.vivaExerciseId, splitPayment.viva_exercise_id, booking.vivaExerciseId,
    booking.exerciseId, metadata.vivaExerciseId, metadata.exerciseId, metadata.viva_exercise_id,
    metadata.exercise_id, splitPayment.exerciseId, splitPayment.exercise_id].filter(value => value != null && value !== '');
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const stationId = booking.studioId || metadata.studioId;
  const roomId = booking.roomId || metadata.roomId;
  const masterServiceId = booking.masterServiceId || metadata.masterServiceId;
  const subServiceIds = booking.subServiceIds || metadata.subServiceIds;
  const storedDuration = canonical.eventDurationMinutes({timeFrom: booking.timeFrom, timeTo: booking.timeTo});
  const start = `${booking.date}T${String(booking.timeFrom || '').length === 5 ? booking.timeFrom + ':00' : booking.timeFrom}+03:00`;
  if (game.isCancelled === true || game.isCanceled === true || ['CANCELLED', 'CANCELED', 'DELETED', 'FINISHED', 'COMPLETED'].includes(String(game.status || '').toUpperCase())
    || !canonical.isObj(metadata.splitPayment) || splitPayment.enabled === false
    || storedDuration !== ctx.target.durationMinutes
    || (booking.durationMinutes != null && Number(booking.durationMinutes) !== storedDuration)
    || !exerciseIds.length || exerciseIds.some(id => !uuid(id)) || new Set(exerciseIds).size !== 1
    || !uuid(stationId) || !uuid(roomId) || !uuid(masterServiceId)
    || !Array.isArray(subServiceIds) || subServiceIds.length < 1 || subServiceIds.length > 20
    || subServiceIds.some(id => !uuid(id)) || new Set(subServiceIds).size !== subServiceIds.length
    || Date.parse(start) !== Date.parse(ctx.target.startsAt)) return stop('PRICE_PREVIEW_GAME_UNRESOLVED');
  ctx.exerciseId = exerciseIds[0];
  ctx.target = { ...ctx.target, stationId, roomId, masterServiceId, subServiceIds: [...subServiceIds].sort(),
    shareCount: joinPricing.resolveIsSinglesGame({game, booking, metadata, splitPayment}) ? 2 : 4 };
  return http('exercise', `/end-user/api/v1/${ctx.tenantKey}/exercises/${ctx.exerciseId}`);
}
if (ctx.step === 'exercise') {
  const exercise = canonical.unwrapRecord(msg.payload);
  const durationFacts = actual => {
    const facts = { previewCanonicalDuration: actual === null ? 'NULL'
      : Number.isInteger(actual) && actual > 0 && actual <= 1440 ? 'DIFFERENT' : 'UNKNOWN',
      previewDurationFactsFailed: true };
    try {
      // Fixed own primitive fields only: never invoke getters/custom coercion,
      // enumerate the provider record or retain raw values in diagnostics.
      const own = (object, key) => {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor) {
          if (key in object) throw Error('inherited');
          return undefined;
        }
        if (!Object.hasOwn(descriptor, 'value')) throw Error('accessor');
        const value = descriptor.value;
        if (value != null && !['string', 'number', 'boolean'].includes(typeof value)) throw Error('non_primitive');
        if (typeof value === 'string' && value.length > 128) throw Error('oversized');
        return value;
      };
      const endpoints = {};
      for (const key of ['timeFrom', 'startsAt', 'startAt', 'fromTime', 'timeTo', 'endsAt', 'endAt']) {
        endpoints[key] = own(exercise, key);
      }
      const rawExplicit = own(exercise, 'durationMinutes') ?? own(exercise, 'duration');
      const explicit = Number(rawExplicit);
      const explicitValid = Number.isInteger(explicit) && explicit > 0 && explicit <= 1440;
      const expected = own(ctx.target, 'durationMinutes');
      if (![60, 90, 120].includes(expected)) return facts;
      // Use the owning parser without explicit duration, not a second duration parser.
      const endpointDuration = canonical.eventDurationMinutes(endpoints);
      const resolved = Number.isInteger(endpointDuration) && endpointDuration > 0 && endpointDuration <= 1440;
      const details = {
        previewExplicitDuration: rawExplicit == null ? 'ABSENT' : explicitValid ? 'VALID' : 'INVALID',
        previewEndpointDuration: endpointDuration === null ? 'NULL' : !resolved ? 'UNKNOWN'
          : endpointDuration === expected ? 'MATCH_TARGET' : 'DIFFERENT',
      };
      if (explicitValid && resolved) details.previewExplicitMatchesEndpoints = explicit === endpointDuration;
      // A clock-fallback result is not proof of a valid provider interval. Mark
      // only a strictly round-tripped, forward explicit-offset pair as such.
      const offsetTimestamp = value => {
        if (typeof value !== 'string') return null;
        const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/);
        if (!match || Number(match[5] || 0) > 23 || Number(match[6] || 0) > 59) return null;
        const parsed = Date.parse(value);
        if (!Number.isFinite(parsed)) return null;
        const offset = match[3] === 'Z' ? 0 : (match[4] === '-' ? -1 : 1) * (Number(match[5]) * 60 + Number(match[6]));
        const local = new Date(parsed + offset * 60000).toISOString();
        return local.slice(0, 23) === `${match[1]}.${(match[2] || '').padEnd(3, '0')}` ? parsed : null;
      };
      const from = offsetTimestamp(endpoints.timeFrom || endpoints.startsAt || endpoints.startAt);
      const to = offsetTimestamp(endpoints.timeTo || endpoints.endsAt || endpoints.endAt);
      details.previewEndpointOffsetPairValid = from !== null && to !== null
        && to > from && to - from <= 1440 * 60000 && resolved;
      const start = Date.parse(canonical.eventStartsAt(endpoints));
      const expectedStart = own(ctx.target, 'startsAt');
      const targetStart = typeof expectedStart === 'string' ? Date.parse(expectedStart) : NaN;
      if (Number.isFinite(start) && Number.isFinite(targetStart)) details.previewEndpointStartMatch = start === targetStart;
      return { ...facts, ...details, previewDurationFactsFailed: false };
    } catch { return facts; }
  };
  const unresolved = (reason, actualDuration) => {
    // Explain the first failed predicate without changing the HTTP error contract.
    // Observe only safe enums/status; never copy the provider record or headers.
    try {
      const payload = msg.payload;
      const type = typeof msg.headers?.['content-type'] === 'string'
        ? msg.headers['content-type'].split(';', 1)[0].trim().toLowerCase() : '';
      const status = Number(msg.statusCode);
      lkDiagnostic({ code: 'PRICE_PREVIEW_GAME_UNRESOLVED', reason,
        ...(reason === 'target_duration' ? durationFacts(actualDuration) : {}),
        upstreamStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined,
        responseKind: payload === null ? 'null' : payload === undefined ? 'missing'
          : Array.isArray(payload) ? 'array' : typeof payload === 'string' ? 'text'
            : ['object', 'number', 'boolean'].includes(typeof payload) ? typeof payload : 'UNKNOWN',
        contentTypeClass: !type ? 'missing' : type === 'application/json' || type.endsWith('+json') ? 'json'
          : type === 'text/html' ? 'html' : type.startsWith('text/') ? 'text' : 'other',
        outcome: 'refused' });
    } catch { /* Diagnostics cannot turn a refusal into an exception. */ }
    return stop('PRICE_PREVIEW_GAME_UNRESOLVED');
  };
  // Preserve the original predicates, short-circuit order and fail-closed verdict.
  if (!ok()) return unresolved('target_upstream_error');
  if (!exercise) return unresolved('target_missing');
  if (String(exercise.id || exercise.exerciseId || '') !== ctx.exerciseId) return unresolved('target_identity');
  if (canonical.resolveCategory(exercise) !== 'open_game') return unresolved('target_category');
  if (String(exercise.studio?.id || exercise.studioId || '') !== ctx.target.stationId) return unresolved('target_studio');
  if (canonical.exerciseRoomId(exercise) !== ctx.target.roomId) return unresolved('target_room');
  const exerciseDuration = canonical.eventDurationMinutes(exercise);
  if (exerciseDuration !== ctx.target.durationMinutes) return unresolved('target_duration', exerciseDuration);
  if (Date.parse(canonical.eventStartsAt(exercise)) !== Date.parse(ctx.target.startsAt)) return unresolved('target_start_invalid');
  if (exercise.isCancelled === true || exercise.isCanceled === true) return unresolved('target_cancelled');
  if (['CANCELLED', 'CANCELED', 'DELETED', 'FINISHED', 'COMPLETED'].includes(String(exercise.status || '').toUpperCase())) return unresolved('target_lifecycle');
  if (!Array.isArray(exercise.availableClientSubscriptions)) return unresolved('PRICE_PREVIEW_SUBSCRIPTION_SCHEMA_INVALID');
  ctx.exercise = exercise;
  return http('subscriptions', `/end-user/api/v1/${ctx.tenantKey}/subscriptions?includeFinished=true&size=1000`);
}
if (ctx.step === 'subscriptions') {
  const body = msg.payload;
  const list = Array.isArray(body) ? body : body?.content;
  if (!ok() || !Array.isArray(list) || list.some(row => !canonical.isObj(row))
    || (!Array.isArray(body) && (body.totalElements !== list.length || (body.number !== undefined && body.number !== 0)
      || (body.totalPages !== undefined && ![0, 1].includes(body.totalPages)) || body.last === false || body.hasNext === true))) {
    return stop('PRICE_PREVIEW_SUBSCRIPTIONS_INCOMPLETE');
  }
  if (eventRoute && ctx.requestedIds === undefined) {
    ctx.requestedIds = list.filter(row => row.status === 'ACTIVE').map(row => row.subscriptionId || row.clientSubscriptionId || row.id);
    if (ctx.requestedIds.length > 20 || ctx.requestedIds.some(id => typeof id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      || new Set(ctx.requestedIds).size !== ctx.requestedIds.length) return stop('PRICE_PREVIEW_OWNERSHIP_UNRESOLVED');
    if (!ctx.requestedIds.length) { ctx.quotes = []; ctx.done = true; ctx.statusCode = 200; return out(4); }
  }
  ctx.subscriptions = {};
  for (const id of ctx.requestedIds) {
    const matches = list.filter(row => (eventRoute ? row.subscriptionId || row.clientSubscriptionId || row.id : row.subscriptionId) === id);
    if (matches.length !== 1 || [matches[0].clientSubscriptionId, matches[0].id].some(v => v !== undefined && v !== id)
      || [matches[0].clientId, matches[0].client?.id].some(v => v !== undefined && v !== ctx.actorClientId)) return stop('PRICE_PREVIEW_OWNERSHIP_UNRESOLVED');
    ctx.subscriptions[id] = matches[0];
  }
  return find('metadata', { _id: { $in: ctx.requestedIds.map(id => key('instance', ctx.actorClientId, id)) } });
}
if (ctx.step === 'metadata') {
  if (msg.error || !Array.isArray(msg.payload)) return stop('SUBSCRIPTION_PRODUCT_CURRENT_STATE_UNAVAILABLE');
  ctx.metadata = {};
  ctx.instanceErrors = {};
  // The same resolver decides which products carry a rule; the selected
  // instance's product comes from its server-owned identity, never from a name.
  ctx.rules = {};
  for (const id of ctx.requestedIds) {
    const providerProductIds = canonical.collectExactProductIds(ctx.subscriptions[id]);
    if (new Set(providerProductIds).size > 1) return stop('SUBSCRIPTION_PRODUCT_CURRENT_STATE_UNAVAILABLE');
    const matches = msg.payload.filter(row => row?._id === key('instance', ctx.actorClientId, id));
    const row = matches[0];
    if (matches.length === 0) {
      ctx.instanceErrors[id] = 'SUBSCRIPTION_PRODUCT_CURRENT_STATE_UNAVAILABLE';
      continue;
    }
    if (matches.length !== 1 || row.kind !== 'instance' || row.tenantKey !== ctx.tenantKey
      || row.actorClientId !== ctx.actorClientId || row.subscriptionId !== id || row.invalid === true
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[0-9a-f]{12}$/i.test(row.productId || '')
      || providerProductIds.some(product => product !== row.productId.toLowerCase())) return stop('SUBSCRIPTION_PRODUCT_CURRENT_STATE_UNAVAILABLE');
    ctx.metadata[id] = row;
    const configured = previewRule([{ ...ctx.subscriptions[id], productId: row.productId.toLowerCase() }],
      ctx.target.stationId);
    if (configured.code) return stop(previewRuleCode(configured));
    ctx.rules[id] = configured;
  }
  ctx.ruleProductIds = [...new Set(Object.values(ctx.metadata).map(row => row.productId.toLowerCase()))];
  if (eventRoute) {
    // The contour decides which subscriptions the managed evaluator prices, never
    // which ones the client may see a price for. Out-of-contour subscriptions (a sale
    // date before the rule, or no plan rule at all) stay in the batch and are quoted at
    // the ordinary event tariff below. Dropping them produced an empty quote batch and
    // blocked every group training and tournament booking for that cohort (2026-09-15).
    ctx.managedIds = ctx.requestedIds.filter(id => ctx.rules[id]?.matched && !ctx.rules[id].legacy);
    ctx.outOfContourIds = ctx.requestedIds.filter(id => !ctx.managedIds.includes(id));
  }
  return find('catalog', { _id: { $in: [...new Set(Object.values(ctx.metadata).map(row => key('product', row.productId)))] } });
}
if (ctx.step === 'catalog') {
  if (msg.error || !Array.isArray(msg.payload)) return stop('SUBSCRIPTION_PRODUCT_CATALOG_UNAVAILABLE');
  ctx.catalog = {};
  for (const mapping of Object.values(ctx.metadata)) {
    const matches = msg.payload.filter(row => row?._id === key('product', mapping.productId));
    const row = matches[0];
    if (matches.length !== 1 || row.kind !== 'product' || row.tenantKey !== ctx.tenantKey
      || row.productId !== mapping.productId || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 500) return stop('SUBSCRIPTION_PRODUCT_CATALOG_UNAVAILABLE');
    ctx.catalog[mapping.productId] = row.name;
  }
  return http('activeBookings', `/end-user/api/v2/${ctx.tenantKey}/bookings?size=1000`);
}
if (ctx.step === 'activeBookings' || ctx.step === 'historyBookings') {
  const refuseBookings = firstFailure => {
    try {
      // Read only a primitive status; diagnostics must not invoke a getter or
      // provider-controlled coercion, inspect the DTO again, or expose its values.
      const raw = Object.getOwnPropertyDescriptor(msg, 'statusCode')?.value;
      const status = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : null;
      lkDiagnostic({ eventKind: 'audit', code: 'PRICE_PREVIEW_BOOKINGS_INCOMPLETE',
        operationStage: ctx.step, firstFailure,
        upstreamStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined,
        httpStatus: 503, outcome: 'refused' });
    } catch { /* Diagnostics cannot change the refusal. */ }
    return stop('PRICE_PREVIEW_BOOKINGS_INCOMPLETE');
  };
  // Keep the original predicates, helper calls and short-circuit order. In
  // particular, a missing row owner is still accepted by the existing contract.
  if (!ok()) return refuseBookings('upstream_status');
  if (!canonical.hasCompleteBookingList(msg.payload)) return refuseBookings('list_incomplete_or_unrecognized');
  let firstFailure;
  if (rows().some(row => {
    if (!canonical.isObj(row)) { firstFailure = 'row_not_object'; return true; }
    if (!canonical.bookingId(row)) { firstFailure = 'row_id_missing'; return true; }
    if (canonical.bookingClientId(row)
      && canonical.normalizeId(canonical.bookingClientId(row)) !== canonical.normalizeId(ctx.actorClientId)) {
      firstFailure = 'row_owner_mismatch'; return true;
    }
    return false;
  })) return refuseBookings(firstFailure);
  if (ctx.step === 'activeBookings') {
    ctx.activePayload = msg.payload;
    ctx.activeObservedAt = new Date().toISOString();
    return http('historyBookings', `/end-user/api/v2/${ctx.tenantKey}/bookings/history?includeCanceled=true&size=1000`);
  }
  ctx.cancellationSnapshot = { observedAt: ctx.activeObservedAt,
    active: canonical.extractItems(ctx.activePayload), history: canonical.extractItems(msg.payload) };
  ctx.bookings = canonical.mergeBookings(ctx.activePayload, msg.payload);
  ctx.activeBookings = canonical.mergeBookings(ctx.activePayload, []).filter(row => !canonical.isInactiveBooking(row));
  delete ctx.activePayload;
  return find('operations', { tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId,
    'lk1.rule.productId': { $in: ctx.ruleProductIds } }, 2);
}
if (ctx.step === 'operations') {
  if (msg.error || !Array.isArray(msg.payload)) return stop('LK1_ALLOWANCE_READ_FAILED');
  ctx.operations = msg.payload;
  if (eventRoute) return http('groupTariff', `/end-user/api/v2/${ctx.tenantKey}/products/one-times?exerciseId=${ctx.exerciseId}`);
  return http('room', `/api/v1/studios/${encodeURIComponent(ctx.target.stationId)}/rooms/${encodeURIComponent(ctx.target.roomId)}`, true);
}
// The club co-pay of «Дружба Топократы» is charged against the HOURLY court price, so the
// advisory quote needs the same whole-window court total the booking gateway proves before it
// prices the club training (owner decision 2026-10-05). The preview uses the same master
// service table and the same verified price route as the write path; the two are separate
// processes, so parity comes from the shared table plus the shared formula, not from a shared
// cache. An unresolvable station or an invalid lookup stops the quote with the same code the
// booking refuses with.
const lk1CourtMasterServices = Object.freeze({
  '6a7a9edc-6869-40ad-a5a1-8a1cdfb746a1': { masterServiceId: '2f4155ad-7bc0-4a15-a12c-da7fce15c37a', subServiceId: '415edff9-b4ad-4d88-8709-75f1ab7d4081' },
  '0d5504f6-ea6f-44bb-a9e4-947faf0273ab': { masterServiceId: 'e2caa535-6660-479a-bd32-3638ba7f6b89', subServiceId: '96d2179a-5a96-41bd-a0c9-1df9e5890e16' },
  '6b2d7e60-caff-4b22-89f6-6f19d7d311ab': { masterServiceId: '22b928b2-1ba6-4491-bc43-756676fcd723', subServiceId: '4d1df04c-774f-46ff-93bd-fd1cca0cb1c4' },
  '42c6d4df-833d-480a-bdc8-986716569884': { masterServiceId: '1c54e3b4-0421-482e-8faf-0c1cd5fdaf3d', subServiceId: '59fdd182-ce16-4c37-a814-a45cb026d24d' },
  '588b6151-f4f5-47d9-9449-80edf8cbc748': { masterServiceId: 'd9a5061a-e027-4960-9029-4bf5ec8a0c64', subServiceId: '2689586b-e7f6-4389-bdd2-5c1a35d4c0e7' },
  '3656cbaa-6426-490f-a44f-915404cbdd2b': { masterServiceId: 'cf54da75-52dd-48bb-861e-c6d53abc052a', subServiceId: '8fd8fe7b-9563-4b56-836c-1b63fe4698f5' },
  '1ea77cbf-bc36-49a1-96d6-f35c216a409b': { masterServiceId: '899db365-5286-43f6-a3a4-efcf406a28eb', subServiceId: '6a16a7a8-db84-422d-b5f8-5fd00fe0d54c' },
  '233c1405-1eac-40de-8ec6-1cf7e24c9276': { masterServiceId: '86e13da6-2282-4daf-9239-c0cd3ddefaf7', subServiceId: '50d7e7a0-39ea-4ccd-a912-a6ddb77fa3ed' },
});
const lk1CourtWindowId = value => {
  const text = String(value ?? '').trim();
  return text && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/.test(text) ? text : null;
};
// The window total is the only money this quote may carry and it must be a whole positive
// number of minor units, exactly as the write path validates it. The step that consumes this
// payload has already proved the URL it answered, so the request identity is not re-asserted
// from the body.
const lk1CourtWindowTotal = payload => {
  if (!canonical.isObj(payload)) return null;
  const total = Number(payload.total);
  if (!Number.isSafeInteger(total) || total <= 0 || total > 10_000_000) return null;
  return total;
};

const lk1CourtWindowAmounts = (payload, durationMinutes) => {
  const windowTotalMinor = lk1CourtWindowTotal(payload);
  if (windowTotalMinor === null) return null;
  const hourlyCourtPriceMinor = Math.round(windowTotalMinor * 60 / durationMinutes);
  return Number.isSafeInteger(hourlyCourtPriceMinor) && hourlyCourtPriceMinor > 0
    ? { windowTotalMinor, hourlyCourtPriceMinor } : null;
};
const lk1StartCourtWindow = () => {
  const mapped = lk1CourtMasterServices[String(ctx.target.stationId || '')] || null;
  const masterServiceId = mapped ? lk1CourtWindowId(mapped.masterServiceId) : null;
  const subServiceId = mapped ? lk1CourtWindowId(mapped.subServiceId) : null;
  const fromTime = ctx.target.startsAt.slice(11, 16);
  const durationMinutes = Number(ctx.target.durationMinutes);
  if (!masterServiceId || !subServiceId || !/^([01]\d|2[0-3]):[0-5]\d$/.test(fromTime)
    || !Number.isSafeInteger(durationMinutes) || durationMinutes <= 0) {
    return stop('LK1_COURT_PRICE_UNRESOLVED');
  }
  const endMinutes = Number(fromTime.slice(0, 2)) * 60 + Number(fromTime.slice(3, 5)) + durationMinutes;
  const toTime = `${String(Math.floor(endMinutes / 60) % 24).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;
  // Function nodes do not expose Node.js URLSearchParams in their sandbox.
  const query = Object.entries({ studioId: ctx.target.stationId, roomId: ctx.target.roomId,
    subServiceIds: subServiceId, fromTime, toTime, fromDate: ctx.target.startsAt.slice(0, 10) })
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&');
  ctx.courtWindowUrl = `/end-user/api/v1/${ctx.tenantKey}/products/master-services/`
    + `${encodeURIComponent(masterServiceId)}/price?${query}`;
  return http('courtWindow', ctx.courtWindowUrl);
};
if (ctx.step === 'room') {
  if (!ok() || String(msg.payload?.id || msg.payload?.roomId || '') !== ctx.target.roomId) return stop('SPLIT_PRICING_ROOM_STUDIO_MISMATCH');
  return http('studios', `/end-user/api/v1/${ctx.tenantKey}/products/master-services/${ctx.target.masterServiceId}/studios?`);
}
if (ctx.step === 'studios') {
  if (!ok() || !pricing.extractList(msg.payload).some(row => String(row?.id || row?.uuid || row?.studioId || row?.stationId || '') === ctx.target.stationId)) return stop('SPLIT_EXACT_PRICE_MASTER_SERVICE_MISMATCH');
  return http('subservices', `/end-user/api/v1/${ctx.tenantKey}/products/master-services/${ctx.target.masterServiceId}/subServices?studioId=${ctx.target.stationId}&showAll=true`);
}
if (ctx.step === 'subservices') {
  const ids = new Set(pricing.extractList(msg.payload).flatMap(row => Array.isArray(row?.subServices) ? row.subServices : [row])
    .map(row => String(row?.id || row?.uuid || row?.subServiceId || row?.serviceId || row?.productId || '')));
  if (!ok() || ctx.target.subServiceIds.some(id => !ids.has(id))) return stop('SPLIT_EXACT_PRICE_SUBSERVICE_MISMATCH');
  const localEnd = new Date(Date.parse(ctx.target.startsAt) + (ctx.target.durationMinutes + 180) * 60000).toISOString();
  // Clubs close at 00:00. /price keeps the start-day tariff and its 00:00 end clock;
  // CREATE represents that closing boundary as next-day midnight in its ISO endpoint.
  // Any overrun beyond closing remains unsupported and fails before the price request.
  const nextDay = new Date(Date.parse(ctx.target.startsAt.slice(0, 10) + 'T00:00:00Z') + 86400000)
    .toISOString().slice(0, 10);
  const endsAtClosing = localEnd.slice(0, 10) === nextDay && localEnd.slice(11) === '00:00:00.000Z';
  if (localEnd.slice(0, 10) !== ctx.target.startsAt.slice(0, 10) && !endsAtClosing) {
    // Derive bounded shape only. Never attach target, dates, clock times, IDs or provider rows.
    // Keep derivation inside the no-throw boundary as well as the optional observer call.
    try {
      const targetKind = ctx.target.targetKind;
      const elapsed = typeof ctx.startedAt === 'number' ? Date.now() - ctx.startedAt : NaN;
      const dayDelta = Date.parse(localEnd.slice(0, 10) + 'T00:00:00Z')
        - Date.parse(ctx.target.startsAt.slice(0, 10) + 'T00:00:00Z');
      lkDiagnostic({ code: 'PRICE_PREVIEW_CROSS_DAY_UNRESOLVED', httpStatus: 503, outcome: 'refused',
        previewTargetKind: ['NEW_GAME', 'EXISTING_GAME'].includes(targetKind) ? targetKind : 'UNKNOWN',
        previewTargetSource: targetKind === 'NEW_GAME' && ctx.existingGame === false ? 'CLIENT_INPUT'
          : targetKind === 'EXISTING_GAME' && ctx.existingGame === true ? 'SERVER_CONFIRMED' : 'UNKNOWN',
        previewDuration: [60, 90, 120].includes(ctx.target.durationMinutes)
          ? 'MINUTES_' + ctx.target.durationMinutes : 'UNKNOWN',
        previewDayRelation: dayDelta === 86400000 ? 'NEXT_DAY' : Number.isFinite(dayDelta) ? 'OTHER' : 'UNKNOWN',
        previewOffsetValid: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?\+03:00$/.test(ctx.target.startsAt)
          && new Date(Date.parse(ctx.target.startsAt) + 180 * 60000).toISOString().slice(0, 19) === ctx.target.startsAt.slice(0, 19),
        previewEndAtMidnight: localEnd.slice(11) === '00:00:00.000Z',
        previewSelectedSubserviceCount: Math.min(ctx.target.subServiceIds.length, 20),
        previewSubserviceSetSize: Math.min(ids.size, 21), // 21 means 21 or more, not an exact catalogue size.
        previewSubservicesMatched: true, previewSubservices2xx: true,
        previewElapsedBucket: !Number.isFinite(elapsed) || elapsed < 0 ? 'UNKNOWN'
          : elapsed < 1000 ? 'LT1S' : elapsed < 5000 ? 'LT5S' : elapsed < 15000 ? 'LT15S'
            : elapsed <= 28000 ? 'LE28S' : 'OVER28S',
      });
    } catch { /* Diagnostic derivation cannot change the refusal. */ }
    return stop('PRICE_PREVIEW_CROSS_DAY_UNRESOLVED');
  }
  // Function nodes do not expose Node.js URLSearchParams in their sandbox.
  const query = Object.entries({ studioId: ctx.target.stationId, roomId: ctx.target.roomId,
    subServiceIds: ctx.target.subServiceIds.join(','), fromTime: ctx.target.startsAt.slice(11, 19),
    toTime: localEnd.slice(11, 19), fromDate: ctx.target.startsAt.slice(0, 10) })
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&');
  return http('price', `/end-user/api/v1/${ctx.tenantKey}/products/master-services/${ctx.target.masterServiceId}/price?${query}`);
}
if (ctx.step === 'price') {
  const total = pricing.extractExactCourtPrice(msg.payload, ctx.target.subServiceIds);
  if (!ok() || total === null || total < 0) return stop('SPLIT_EXACT_PRICE_INVALID');
  ctx.basePriceMinor = Math.round(total / ctx.target.shareCount * 100);
  if (!Number.isSafeInteger(ctx.basePriceMinor) || ctx.basePriceMinor > 1000000) return stop('SPLIT_EXACT_PRICE_INVALID');
  // The club game direction is charged against the same court hour: the preview derives it from
  // the whole window it just verified, exactly as the write path derives it from the split
  // proof. An unproven hour keeps the game on its base share and lets the evaluator fail closed.
  const gameAmounts = lk1CourtWindowAmounts(msg.payload, ctx.target.durationMinutes);
  if (gameAmounts !== null) ctx.hourlyCourtPriceMinor = gameAmounts.hourlyCourtPriceMinor;
  ctx.pending = [...ctx.requestedIds]; ctx.quotes = []; ctx.step = 'next';
}
if (ctx.step === 'courtWindow') {
  if (!ok() || !ctx.courtWindowUrl || (msg.url !== undefined && msg.url !== ctx.courtWindowUrl)
    || (msg.responseUrl !== undefined && msg.responseUrl !== ctx.courtWindowUrl)) {
    return stop('LK1_COURT_PRICE_UNRESOLVED');
  }
  const amounts = lk1CourtWindowAmounts(msg.payload, ctx.target.durationMinutes);
  if (amounts === null) return stop('LK1_COURT_PRICE_UNRESOLVED');
  ctx.windowTotalMinor = amounts.windowTotalMinor;
  ctx.hourlyCourtPriceMinor = amounts.hourlyCourtPriceMinor;
  ctx.pending = [...ctx.requestedIds]; ctx.quotes = []; ctx.step = 'next';
}
if (ctx.step === 'groupTariff') {
  const tariffDetails = (reason, stage, observed = {}) => ({
    exerciseId: ctx.exerciseId, tariffCount: ctx.tariffCount ?? null, reason, stage, observed,
  });
  if (!ok()) {
    ctx.errorDetails = tariffDetails('upstream_error', 'tariff_response');
    return stop('LK1_EVENT_TARIFF_UNAVAILABLE');
  }
  if (!canonical.hasCompleteBookingList(msg.payload)) {
    ctx.errorDetails = tariffDetails('incomplete_tariff_list', 'tariff_response');
    return stop('LK1_EVENT_TARIFF_UNAVAILABLE');
  }
  const rows = canonical.extractItems(msg.payload);
  ctx.tariffCount = rows.length;
  // Viva scopes this product list by the request, without echoing exerciseId.
  const tariffUrl = `https://api.vivacrm.ru/end-user/api/v2/${ctx.tenantKey}/products/one-times?exerciseId=${encodeURIComponent(ctx.exerciseId)}`;
  // Every refusal below names the exact sub-condition it refused on and the observed
  // shape (counts and enum values only, never amounts or names). The accept/reject
  // decision is unchanged: the detail exists so a production refusal can be diagnosed
  // from the response instead of guessed, without widening what this node accepts.
  const tariffRefusal = (stage, observed) => {
    ctx.errorDetails = tariffDetails(stage, stage, observed);
    return stop('LK1_EVENT_TARIFF_UNVERIFIED');
  };
  if (msg.method !== 'GET' || msg.url !== tariffUrl
    || (msg.responseUrl !== undefined && msg.responseUrl !== tariffUrl)) {
    return tariffRefusal('request_url', { method: msg.method || null,
      urlMatch: msg.url === tariffUrl, responseUrlMatch: msg.responseUrl === undefined || msg.responseUrl === tariffUrl });
  }
  if (rows.length !== 1 || !canonical.isObj(rows[0])) {
    const reason = rows.length === 0 ? 'empty_tariff_list'
      : rows.length > 1 ? 'multiple_tariffs' : 'invalid_tariff_record';
    ctx.errorDetails = tariffDetails(reason, 'tariff_shape');
    if (reason === 'empty_tariff_list') {
      const binding = {};
      try {
        // Comparisons only, with no new reads or changes to the decision. The
        // shared observer inspects the already-read tariff reply before stop.
        if (canonical.isObj(ctx.exercise)) {
          const identity = ctx.exercise.id || ctx.exercise.exerciseId;
          if (typeof identity === 'string' && identity) binding.tariffEventIdentityMatch = identity === ctx.exerciseId;
          binding.tariffEventCategoryMatch = canonical.resolveCategory(ctx.exercise) === eventRoute?.category;
          const eventStart = Date.parse(canonical.eventStartsAt(ctx.exercise));
          const targetStart = Date.parse(ctx.target?.startsAt);
          if (Number.isFinite(eventStart) && Number.isFinite(targetStart)) binding.tariffEventStartMatch = eventStart === targetStart;
        }
      } catch { /* Missing comparison evidence stays unknown. */ }
      lkDiagnostic({ eventKind: 'audit', code: 'PREVIEW_EMPTY_TARIFF_OBSERVED', reason, tariffCount: rows.length,
        httpStatus: 503, outcome: 'refused', ...binding });
    }
    return stop("LK1_EVENT_TARIFF_AMBIGUOUS");
  }
  const product = rows[0];
  const productIds = [product.id, product.productId].filter((id) => id !== undefined);
  const eventIds = [product.exerciseId, product.exercise?.id].filter((id) => id !== undefined);
  // The DTO carries two kinds of money: the paid price (`cost`/`price`/`amount` are
  // aliases of one number and must agree) and the trial price (`trialCost`), which
  // describes a different offer and only has to be a non-negative integer. Requiring the
  // trial price to equal the paid one refused every exercise whose trial tariff differs
  // (live evidence 2026-09-15: both fields present, two distinct non-zero integers).
  const paidFields = ['cost', 'price', 'amount'].filter((field) => product[field] !== undefined);
  const paidAmounts = paidFields.map((field) => product[field]);
  const trialPresent = product.trialCost !== undefined;
  const trialAmount = trialPresent ? product.trialCost : null;
  const types = [product.productType, product.type].filter((type) => type !== undefined);
  const allowedTypes = ["SERVICE", "ONE_TIME", "INSTANT_SUB_SERVICE", "ADVANCE_SUB_SERVICE"];
  // Field names and shapes only: an amount is never copied into the refusal, but the
  // names and the number of distinct (and zero) values are what identifies the rule.
  const observed = { productIds: productIds.length, idsAgree: new Set(productIds).size === 1,
    eventIds: eventIds.length, eventIdMatches: !eventIds.some((id) => id !== ctx.exerciseId),
    types: types.map((type) => String(type).slice(0, 40)), paidFields, paidDistinct: new Set(paidAmounts).size,
    paidZero: paidAmounts.filter((amount) => amount === 0).length,
    paidAgree: new Set(paidAmounts).size === 1,
    paidAreNonNegativeIntegers: paidAmounts.every((amount) => Number.isSafeInteger(amount) && amount >= 0),
    trialPresent, trialIsNonNegativeInteger: !trialPresent || (Number.isSafeInteger(trialAmount) && trialAmount >= 0) };
  if (!productIds.length || !productIds.every((id) => typeof id === "string" && id.trim())
    || new Set(productIds).size !== 1 || eventIds.some((id) => id !== ctx.exerciseId)) {
    return tariffRefusal('product_identity', observed);
  }
  if (!types.length || types.some((type) => !allowedTypes.includes(type))) return tariffRefusal('product_type', observed);
  if (!paidAmounts.length || paidAmounts.some((amount) => !Number.isSafeInteger(amount) || amount < 0)
    || new Set(paidAmounts).size !== 1) return tariffRefusal('product_amount', observed);
  if (trialPresent && (!Number.isSafeInteger(trialAmount) || trialAmount < 0)) {
    return tariffRefusal('product_trial_amount', observed);
  }
  ctx.basePriceMinor = paidAmounts[0]; ctx.priceProductId = productIds[0];
  if (ctx.basePriceMinor > 1000000) return tariffRefusal('amount_ceiling', observed);
  // A club training of direction 6233 (priced by the club product) is charged against the
  // hour of court, so the quote has to prove that hour before it prices the event. Every other
  // event keeps this exact flow.
  if (eventRoute.category === 'group_training' && Number(ctx.directionId) === 6233
    && ctx.requestedIds.some(id => ctx.rules[id]?.matched && !ctx.rules[id].legacy
      && String(ctx.rules[id].rule?.productId || '').toLowerCase() === '14692232-12be-4218-9fa1-2d5b79b62035')) {
    return lk1StartCourtWindow();
  }
  ctx.pending = [...ctx.requestedIds]; ctx.quotes = []; ctx.step = 'next';
}
if (ctx.step === 'evaluate') {
  const decision = msg._managedSubscriptionPolicyDecision;
  if (!canonical.isObj(decision)) return stop('PRICE_PREVIEW_DECISION_INVALID');
  if (!decision.eligible) {
    const code = decision.blockers?.length === 1 ? decision.blockers[0].code : null;
    if (LIMIT_DECISION_BLOCKERS.includes(code)) quote(ctx.currentId, 'LIMIT_USED', null, 0, 0, code);
    else if (UNAVAILABLE_DECISION_BLOCKERS.includes(code)) quote(ctx.currentId, 'UNAVAILABLE', null, 0, 0, code);
    else {
      // Name the blocker (codes only) so an unmapped refusal is diagnosed from the
      // response instead of reproduced. The verdict itself stays fail-closed.
      ctx.errorDetails = { stage: 'decision_blockers',
        blockers: (decision.blockers || []).map((blocker) => String(blocker?.code || 'UNNAMED').slice(0, 60)) };
      return stop('PRICE_PREVIEW_DECISION_UNRESOLVED');
    }
  } else {
    if (!Number.isSafeInteger(decision.benefit?.finalPriceMinor) || decision.benefit.finalPriceMinor < 0
      || decision.benefit.finalPriceMinor > ctx.basePriceMinor) return stop('PRICE_PREVIEW_DECISION_INVALID');
    // The club co-pay (owner decision 2026-10-05) is not a discount on the event tariff: it is
    // the hour of court, so the server amount may legitimately exceed the configured percent's
    // price. It is accepted only when the decision's own numbers reproduce it from the hourly
    // court price this quote proved, and every other shape keeps the reviewed arithmetic.
    const courtCoPay = decision.benefit?.kind === 'COURT_HOURLY_COPAY';
    const courtQuote = courtCoPay && Number.isInteger(decision.eventDiscountPercent)
      && decision.eventDiscountPercent === 0
      && Number.isSafeInteger(decision.benefit?.partialPriceCalculation?.hourlyCourtPriceMinor)
      && Number.isSafeInteger(decision.benefit?.partialPriceCalculation?.perHourMinor)
      && Number.isSafeInteger(decision.benefit?.partialPriceCalculation?.chargeableHours)
      && decision.benefit.partialPriceCalculation.chargeableHours > 0
      && Number.isSafeInteger(ctx.hourlyCourtPriceMinor) && ctx.hourlyCourtPriceMinor > 0
      && decision.benefit.partialPriceCalculation.hourlyCourtPriceMinor === ctx.hourlyCourtPriceMinor
      && decision.benefit.partialPriceCalculation.perHourMinor
        === Math.floor(ctx.hourlyCourtPriceMinor / 4)
      && decision.benefit.finalPriceMinor
        === decision.benefit.partialPriceCalculation.perHourMinor
          * decision.benefit.partialPriceCalculation.chargeableHours;
    if (courtCoPay && !courtQuote) return stop(eventRoute ? eventRoute.error + '_DECISION_INVALID'
      : 'PRICE_PREVIEW_DECISION_INVALID');
    if (courtQuote) {
      // The club co-pay: the charged amount is the court's own money, so the free minutes are
      // the decision's own reviewed field (`courtMinutes` for a training, the shared game
      // bucket for a club game) and the hour count has to add up with the paid minutes.
      const minutes = canonical.isObj(decision.courtMinutes) ? decision.courtMinutes : decision.gameMinutes;
      if (!canonical.isObj(minutes) || !Number.isSafeInteger(minutes.freeMinutes) || minutes.freeMinutes < 0
        || !Number.isSafeInteger(minutes.paidOverageMinutes) || minutes.paidOverageMinutes < 0
        || minutes.freeMinutes + minutes.paidOverageMinutes !== ctx.target.durationMinutes
        || decision.subscriptionVisitCount !== 1
        || Math.ceil(minutes.paidOverageMinutes / 60)
          !== decision.benefit.partialPriceCalculation.chargeableHours) {
        return stop(eventRoute ? eventRoute.error + '_DECISION_INVALID' : 'PRICE_PREVIEW_DECISION_INVALID');
      }
      const configuredPercent = ctx.groupDiscountPercent;
      // `discountPercent` is 0 for this quote: the co-pay is the court's own money, not a share of
      // the event tariff, and the new kind plus these numbers carry its meaning.
      ctx.groupDiscountPercent = 0;
      const courtCalculation = decision.benefit.partialPriceCalculation;
      quote(ctx.currentId, 'AVAILABLE', decision.benefit.finalPriceMinor,
        minutes.freeMinutes, minutes.paidOverageMinutes, null,
        { chargeableHours: courtCalculation.chargeableHours,
          hourlyCourtPriceMinor: courtCalculation.hourlyCourtPriceMinor,
          perHourMinor: courtCalculation.perHourMinor });
      ctx.groupDiscountPercent = configuredPercent;
    } else if (eventRoute) {
      // The first covered event of the subscription's day is carried by the plan itself: one
      // visit is consumed and nothing is charged. It is quoted as the full benefit at zero (100%
      // of the base), which is the shape the widget validates and the shape the booking gateway
      // accepts as the expectation for a free covered event. Every later event of that day keeps
      // the configured discount.
      const freeCovered = decision.subscriptionVisitCount === 1
        && decision.benefit?.kind === 'FREE_ENTITLEMENT' && decision.benefit.finalPriceMinor === 0;
      // A club training («Дружба Топократы», direction 6233) is charged like a game: the free
      // hour is spent first and the minutes above it carry the co-pay, so the event quote is a
      // partial price with its own percent instead of the configured event discount.
      const paidShare = decision.benefit?.kind === 'PARTIAL_PRICE_PERCENT_DISCOUNT'
        && decision.subscriptionVisitCount === 1 && canonical.isObj(decision.gameMinutes)
        && Number.isSafeInteger(decision.gameMinutes.freeMinutes) && decision.gameMinutes.freeMinutes > 0
        && Number.isSafeInteger(decision.gameMinutes.paidOverageMinutes) && decision.gameMinutes.paidOverageMinutes > 0
        && Number.isInteger(decision.eventDiscountPercent)
        && decision.eventDiscountPercent >= 0 && decision.eventDiscountPercent <= 100;
      // The percent a flat quote must satisfy is the one the decision itself fixed: the club
      // training can charge the full price (0 %) where the configured event percent would
      // have priced a discount the decision did not grant. A visit-covered first event keeps
      // the reviewed normalization below.
      const quotedPercent = !freeCovered && Number.isInteger(decision.eventDiscountPercent)
        && decision.eventDiscountPercent >= 0 && decision.eventDiscountPercent <= 100
        ? decision.eventDiscountPercent : ctx.groupDiscountPercent;
      if (!freeCovered && !paidShare && (decision.subscriptionVisitCount !== 0
        || (!Number.isSafeInteger(quotedPercent) || quotedPercent < 0 || quotedPercent > 100)
        || decision.benefit.finalPriceMinor !== ctx.basePriceMinor - Math.floor(ctx.basePriceMinor * quotedPercent / 100))) {
        return stop(eventRoute.error + '_DECISION_INVALID');
      }
      if (paidShare) {
        const freeMinutes = decision.gameMinutes.freeMinutes;
        const paidMinutes = decision.gameMinutes.paidOverageMinutes;
        const chargedMinor = Math.floor(ctx.basePriceMinor * paidMinutes / (freeMinutes + paidMinutes));
        if (chargedMinor - Math.floor(chargedMinor * decision.eventDiscountPercent / 100) !== decision.benefit.finalPriceMinor) {
          return stop(eventRoute.error + '_DECISION_INVALID');
        }
        const configuredPercent = ctx.groupDiscountPercent;
        ctx.groupDiscountPercent = decision.eventDiscountPercent;
        quote(ctx.currentId, 'AVAILABLE', decision.benefit.finalPriceMinor, freeMinutes, paidMinutes);
        ctx.groupDiscountPercent = configuredPercent;
      } else if (freeCovered) {
        const configuredPercent = ctx.groupDiscountPercent;
        ctx.groupDiscountPercent = 100;
        quote(ctx.currentId, 'AVAILABLE', 0, 0, ctx.target.durationMinutes);
        ctx.groupDiscountPercent = configuredPercent;
      } else {
        const configuredPercent = ctx.groupDiscountPercent;
        ctx.groupDiscountPercent = quotedPercent;
        quote(ctx.currentId, 'AVAILABLE', decision.benefit.finalPriceMinor, 0, ctx.target.durationMinutes);
        ctx.groupDiscountPercent = configuredPercent;
      }
    } else {
      if (!decision.gameMinutes) return stop('PRICE_PREVIEW_DECISION_INVALID');
      quote(ctx.currentId, 'AVAILABLE', decision.benefit.finalPriceMinor, decision.gameMinutes.freeMinutes, decision.gameMinutes.paidOverageMinutes);
    }
  }
  delete msg._managedSubscriptionPolicyDecision; delete msg._managedSubscriptionPolicyInput;
  ctx.step = 'next';
}
while (ctx.step === 'next') {
  const id = ctx.pending.shift();
  if (!id) { ctx.done = true; ctx.statusCode = 200; return out(4); }
  if (ctx.instanceErrors?.[id]) {
    quote(id, 'UNAVAILABLE', null, 0, 0, ctx.instanceErrors[id]);
    continue;
  }
  const live = ctx.subscriptions[id];
  const productId = ctx.metadata[id].productId;
  const name = ctx.catalog[productId];
  const bound = { tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId, clientSubscriptionId: id,
    lk1ProductIdentity: { tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId, subscriptionId: id,
      productId, name, purchaseDate: live.purchaseDate, subscription: live } };
  const exercise = ctx.exercise || { id: 'preview', studioId: ctx.target.stationId, roomId: ctx.target.roomId,
    timeFrom: ctx.target.startsAt, timeTo: new Date(Date.parse(ctx.target.startsAt) + ctx.target.durationMinutes * 60000).toISOString(),
    directionId: 4588, typeId: 1613, availableClientSubscriptions: [live] };
  if (!eventRoute && ['availableStudios', 'availableTypes', 'availableDirections'].some(field => live[field] != null && !Array.isArray(live[field]))) return stop('PRICE_PREVIEW_SUBSCRIPTION_SCHEMA_INVALID');
  if (!eventRoute && (canonical.preflightAvailability.resolveSplitSubscriptionLifecycle(live, ctx.target.startsAt.slice(0, 10)) === 'UNAVAILABLE'
    || live.holdUntil || live.frozenUntil || live.isFrozen === true || live.visitsLeft === 0)) {
    quote(id, live.visitsLeft === 0 ? 'LIMIT_USED' : 'UNAVAILABLE', null, 0, 0, live.visitsLeft === 0 ? 'SUBSCRIPTION_VISITS_EXHAUSTED' : 'SUBSCRIPTION_NOT_OWNED_OR_UNAVAILABLE'); continue;
  }
  const available = ctx.existingGame ? exercise.availableClientSubscriptions.filter(row => {
    if (!canonical.isObj(row)) return false;
    const ids = [row.clientSubscriptionId, row.subscriptionId, row.clientSubId, row.clientSubscription?.id,
      row.clientSubscription?.clientSubscriptionId, row.clientSub?.id].filter(value => value !== undefined && value !== null);
    const aliases = ids.length ? ids : [row.id, row.uuid].filter(value => value !== undefined && value !== null);
    return aliases.length > 0 && aliases.every(value => typeof value === 'string' && canonical.normalizeId(value) === canonical.normalizeId(id));
  }) : [live];
  if (!available.length) { quote(id, 'UNAVAILABLE', null, 0, 0, 'SUBSCRIPTION_NOT_OWNED_OR_UNAVAILABLE'); continue; }
  // A Topokraty event — club direction 6180 «Топократы игра» or 6233 «Топократы тренировка» —
  // is outside every non-club subscription: Viva scopes «РА», «Академия» and «Дружба» to their
  // own directions and refuses a carried write on those directions with 400 BAD_REQUEST, so the
  // advisory quote must not promise that benefit on the training or the game route. Only the club
  // product «Дружба Топократы» keeps its own rule (the club game visit mechanism and the training
  // co-pay) and stays quoted. The predicate comes from the reviewed club module
  // (`scripts/lib/topokratyExclusion.mjs`), which the composition of this generation embeds into
  // the body; the `typeof` guard keeps a body without that module on its previous pricing instead
  // of failing the whole quote.
  if (typeof isTopokratyExercise === 'function' && isTopokratyExercise(exercise)) {
    const topokratyClubRow = Object.assign({}, canonical.isObj(live) ? live : {},
      { productId: productId || live?.productId });
    if (!(typeof isTopokratyClubPack === 'function' && isTopokratyClubPack(topokratyClubRow))) {
      quote(id, 'UNAVAILABLE', null, 0, 0, 'TOPOKRATY_SUBSCRIPTION_UNAVAILABLE'); continue;
    }
  }
  // An annual HUB event quote keeps its money mandate (the strict instance money
  // identity); every other product is verified by the product identity layer, which
  // applies the same HUB constraints for HUB and stays product-agnostic otherwise.
  // Before this split only HUB could ever be owned on the event route, so a plan
  // product that passed the cohort gate died here with PRODUCT_IDENTITY_UNRESOLVED.
  const productIsHub = canonical.normalizeId(productId) === canonical.LK1_OVERLAY_HUB_PRODUCT_ID;
  const owned = eventRoute && productIsHub
    ? canonical.identityMoneyOwned(bound, available)
    : canonical.identityOwned(bound, available, exercise);
  if (owned.length !== 1) return stop('PRICE_PREVIEW_PRODUCT_IDENTITY_UNRESOLVED');
  const dates = canonical.collectSubscriptionPurchaseDateEvidence(owned);
  const configured = previewRule(owned, ctx.target.stationId);
  if (configured.code) return stop(previewRuleCode(configured));
  ctx.previewResolved = configured.matched && !configured.legacy && productId.toLowerCase() === configured.rule.productId;
  // Never expose a legacy/full-price subscription path or another plan on PRO.
  if (ctx.target.proTraining === true
    && !(ctx.previewResolved && canonical.isProTrainingDiscountRule(configured.rule))) continue;
  if (ctx.previewResolved && (dates.invalid || dates.dates.length !== 1)) return stop('SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED');
  if (eventRoute && ctx.previewResolved) {
    const activation = canonical.lk1LifecycleInstant(live.activationDate);
    const expiry = canonical.lk1LifecycleInstant(live.expirationDate, true);
    const targetStart = Date.parse(ctx.target.startsAt);
    if (live.status !== 'ACTIVE' || activation === null || expiry === null || activation > Date.now()
      || activation > targetStart || expiry < Date.now() || expiry < targetStart + ctx.target.durationMinutes * 60000 - 1
      || live.holdUntil || live.frozenUntil || live.isFrozen === true) {
      quote(id, 'UNAVAILABLE', null, 0, 0, 'LK1_MONEY_SUBSCRIPTION_VALIDITY_UNPROVEN'); continue;
    }
    ctx.groupDiscountPercent = configured.rule[eventRoute.rule];
    if ((!Number.isSafeInteger(ctx.groupDiscountPercent) || ctx.groupDiscountPercent < 0 || ctx.groupDiscountPercent > 100)) return stop(eventRoute.error + '_RULE_UNCONFIRMED');
  }
  const visitCount = ctx.previewResolved ? 1 : ctx.target.durationMinutes >= 90 ? 2 : 1;
  // Existing Patriots games have their own Viva direction/type. Both values come from
  // the resolved exercise; a client-provided target cannot widen the product scope.
  const patriotsGameType = canonical.supportsPatriotsGameScope === true && !eventRoute
    && productId.toLowerCase() === '37ab3713-4431-4815-96ba-d7ece76a9241'
    ? canonical.managedExternalEventTypeId(exercise) : null;
  if (patriotsGameType && !['viva:direction:4588:type:1613', 'viva:direction:6181:type:2349'].includes(patriotsGameType)) {
    quote(id, 'UNAVAILABLE', null, 0, 0, 'EVENT_NOT_INCLUDED'); continue;
  }
  const patriotsClubGame = patriotsGameType === 'viva:direction:6181:type:2349';
  if (!eventRoute && canonical.preflightAvailability.filterSplitEligibleSubscriptions(owned,
    new Set([patriotsClubGame ? '2349' : '1613']), new Set([patriotsClubGame ? '6181' : '4588']),
    ctx.target.stationId, visitCount, ctx.target.durationMinutes, ctx.target.startsAt.slice(0, 10)).length !== 1) {
    quote(id, 'UNAVAILABLE', null, 0, 0, 'SUBSCRIPTION_NOT_OWNED_OR_UNAVAILABLE'); continue;
  }
  if (!ctx.previewResolved) {
    // Contour off for this subscription (sale before the rule, or no plan rule): the
    // subscription still has to produce a price the client can act on. The group and
    // tournament validators accept only an AVAILABLE quote whose amount equals the base
    // price less the quoted discount, so an ordinary-tariff quote at zero discount is
    // the exact representation of "no managed benefit here".
    if (eventRoute) {
      ctx.groupDiscountPercent = 0;
      quote(id, 'AVAILABLE', ctx.basePriceMinor, 0, ctx.target.durationMinutes);
      continue;
    }
    const plan = canonical.compatibilityPlanKey(canonical.resolvePlanKey(owned), { enabled: false });
    if (!plan || !canonical.PLAN_CATEGORIES[plan]?.includes('open_game')) {
      lkLegacyPlanDiagnostic(plan, configured, name);
      return stop('PRICE_PREVIEW_LEGACY_PLAN_UNRESOLVED');
    }
    const limit = canonical.resolveLimitMode(plan, ctx.target.startsAt.slice(0, 10));
    let conflict = false;
    for (const booking of ctx.bookings) {
      if (!canonical.isSubscriptionBooking(booking) || canonical.isInactiveBooking(booking)
        || canonical.eventDate(booking) !== ctx.target.startsAt.slice(0, 10)) continue;
      const subscription = canonical.bookingSubscriptionId(booking);
      if (!subscription && limit !== 'event') return stop('SUBSCRIPTION_DAILY_LIMIT_BOOKING_UNRESOLVED');
      if (canonical.normalizeId(subscription) !== canonical.normalizeId(id) || limit === 'event') continue;
      const category = canonical.resolveCategory(booking);
      if (!category) return stop('SUBSCRIPTION_DAILY_LIMIT_BOOKING_UNRESOLVED');
      if (limit === 'shared_day' ? canonical.PLAN_CATEGORIES[plan].includes(category) : category === 'open_game') conflict = true;
    }
    quote(id, conflict ? 'LIMIT_USED' : 'AVAILABLE', conflict ? null : 0,
      conflict ? 0 : ctx.target.durationMinutes, 0, conflict ? 'SUBSCRIPTION_CATEGORY_DAILY_LIMIT_REACHED' : null);
    continue;
  }
  ctx.currentId = id;
  const usageContext = { tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId, clientSubscriptionId: id,
    serviceDate: ctx.target.startsAt.slice(0, 10), managedAction: eventRoute ? eventRoute.action : ctx.existingGame ? 'JOIN_GAME' : 'CREATE_GAME', step: 'lk1_usage_operations',
    // The same instance identity the booking gateway binds before its policy decision: the
    // shared usage block takes the proven visit balance from it, and a covered product without
    // that balance would otherwise fail closed on a snapshot the preview could not stand behind.
    lk1ProductIdentity: { tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId, subscriptionId: id,
      productId, name, purchaseDate: live.purchaseDate, subscription: live },
    // The shared usage block reads the resolved source category for the cohort table; the
    // gateway sets it during target resolution, the preview has to carry it explicitly.
    category: eventRoute ? eventRoute.category : 'open_game',
    lk1: { rule: configured.rule, bookings: ctx.bookings, activeBookings: ctx.activeBookings,
      cancellationSnapshot: ctx.cancellationSnapshot,
      target: { resolutionSource: 'SERVER', eventId: ctx.exerciseId || 'preview', category: eventRoute ? eventCategory : 'GAME', currency: 'RUB', priceSource: 'VIVA_EXISTING_TARIFF',
        basePriceMinor: ctx.basePriceMinor, startsAt: ctx.target.startsAt, durationMinutes: ctx.target.durationMinutes,
        // The club co-pay base: the hourly court price this quote proved for the event window,
        // or for the game window the split price lookup returned. It is absent when no server
        // lookup proved it, and the shared evaluator refuses the club charge then.
        ...(Number.isSafeInteger(ctx.hourlyCourtPriceMinor) && ctx.hourlyCourtPriceMinor > 0
          ? { hourlyCourtPriceMinor: ctx.hourlyCourtPriceMinor } : {}),
        ...(eventRoute ? { stationId: ctx.target.stationId, roomId: ctx.target.roomId,
          externalEventTypeId: canonical.managedExternalEventTypeId(exercise), productTypeId: null,
          // The club training co-pay is bound to the Viva direction of the event, which the
          // booking gateway carries in the same field of its server-resolved target.
          directionId: previewDirectionId(canonical, exercise),
          // PRO-training scope (main) and the Patriots existing-game scope (branch) both ride
          // on this server-resolved usage context; the else-branch keeps the resolved exercise
          // identity so a Patriots game cannot be priced off a client-supplied target.
          ...(ctx.target.proTraining === true ? { proTraining: true } : {}),
          priceProductId: ctx.priceProductId } : {
          externalEventTypeId: canonical.managedExternalEventTypeId(exercise) }) } } };
  // The batch is deliberately wider than one product: the query above asks for every product
  // this client owns (`ctx.ruleProductIds`), because the shared usage builder scopes the day and
  // minute accounting per subscription. Demanding a single rule product here rejected the whole
  // batch for a client who owns two managed products (HUB + plan), which surfaced as a 503 and
  // "Не удалось проверить скидку по подписке" on every group and tournament form.
  if (ctx.operations.some(row => !ctx.ruleProductIds.includes(String(row?.lk1?.rule?.productId || '').toLowerCase()))) {
    return stop('LK1_ALLOWANCE_RECORD_INVALID');
  }
  const usageMessage = { payload: ctx.operations, _subscriptionBooking: usageContext };
  canonicalUsage(usageMessage);
  if (usageMessage.previewError || !usageMessage._managedSubscriptionPolicyInput) return stop(usageMessage.previewError || 'LK1_ALLOWANCE_READ_FAILED');
  msg._managedSubscriptionPolicyInput = usageMessage._managedSubscriptionPolicyInput;
  ctx.step = 'evaluate'; return out(3);
}
return stop('PRICE_PREVIEW_STEP_INVALID');
