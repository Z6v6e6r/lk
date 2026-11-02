// Same five output ports as the annual atomic graph: find, ledger CAS,
// compatibility projection CAS, response, bounded provider transport.
function runMonthlyFriendshipCustody({ msg, globalContext, capacityProbe, observe, admission, now = () => new Date().toISOString() }) {
  const ctx = msg._summerSubscriptionCtx;
  if (ctx?.counterKey !== 'friendship' || !(ctx.step === 'piter_reserve_start' || String(ctx.step).startsWith('monthly_'))) return undefined;
  const c = monthlyFriendshipCustody;
  const ports = index => { const out = [null, null, null, null, null]; out[index] = msg; return out; };
  const scrub = () => { for (const k of ['url','method','headers','error','statusCode','responseUrl','requestTimeout','httpRequestTimeout']) delete msg[k]; };
  const reply = (code, status = 202, operation = null) => {
    if (ctx.reconcile === true) {
      if (code && typeof node !== 'undefined' && typeof node.warn === 'function') node.warn(JSON.stringify({ event: 'monthly_friendship_reconciliation', code }));
      return [null,null,null,null,null];
    }
    scrub(); msg.statusCode = !operation && status < 400 ? 503 : status; msg.headers = { 'Content-Type': 'application/json; charset=utf-8' };
    msg.payload = operation ? { ok: true, counterKey: 'friendship', paymentRef: operation.request.paymentRef,
      status: operation.state === 'PAID' ? 'PAID' : operation.state === 'PAYMENT_PENDING' ? 'PAYMENT_PENDING' : 'PROVIDER_UNKNOWN',
      paid: operation.state === 'PAID', transactionId: operation.transactionId,
      clientSubscriptionId: operation.state === 'PAID' ? operation.subscriptionId : null,
      paymentUrl: operation.state === 'PAYMENT_PENDING' && Date.parse(operation.expiresAt) > Date.parse(now()) ? operation.paymentUrl : null,
      paymentExpiresAt: operation.expiresAt, toPayMinor: operation.state === 'PAID' ? 0 : operation.request.amountMinor,
      priceMinor: operation.request.amountMinor, toPay: operation.state === 'PAID' ? 0 : operation.request.amountMinor / 100,
      inventoryId: operation.request.inventoryId, productId: operation.request.productId, productName: operation.request.productName,
      campaignKey: operation.request.campaignKey, planType: 'friendship', code }
      : { ok: false, status: 'PROVIDER_UNKNOWN', paymentRef: ctx?.paymentRef || null, code };
    return ports(3);
  };
  const binding = globalContext.get('monthly_friendship_custody_binding');
  const scope = ctx.monthlyScope || (binding?.version === 1 && typeof binding.tenantId === 'string' && binding.tenantId
    && binding.inventoryId === ctx.inventoryId ? { tenant_id: binding.tenantId, counterKey: 'friendship', inventoryId: binding.inventoryId } : null);
  const enabled = () => !!scope && binding?.version === 1 && binding.enabled === true
    && binding.tenantId === scope.tenant_id && binding.inventoryId === scope.inventoryId
    && (ctx.releasePhase !== 'daily' || ctx.dailyDropDate === new Date(Date.parse(now()) - 7 * 3600000).toISOString().slice(0, 10))
    && (!(ctx.promoCode || ctx.monthlyRequest?.providerPayload?.promoCode) || globalContext.get('summer_subscription_friendship_promo_enabled') === true)
    && admission(ctx, globalContext) && globalContext.get('summer_subscription_friendship_admission_closed') !== true;
  const find = (step, query = null) => { scrub(); ctx.step = step; msg.payload = query || { $or: [
    { counterKey: 'friendship', inventoryId: ctx.inventoryId }, { paymentRef: ctx.paymentRef },
  ] }; return ports(0); };
  const cas = (step, mutation, options = {}) => {
    scrub(); ctx.step = step; ctx.monthlyMutation = mutation;
    msg.payload = [mutation.query, mutation.update, { upsert: false, ...options }]; return ports(1);
  };
  const exactAck = () => !msg.error && msg.payload?.acknowledged === true && msg.payload.matchedCount === 1 && msg.payload.modifiedCount === 1;
  const http = (step, method, path, body) => {
    scrub(); ctx.step = step; ctx.monthlyExpectedUrl = 'https://api.vivacrm.ru/api/v1' + path;
    msg.url = ctx.monthlyExpectedUrl; msg.method = method; msg.payload = body;
    msg.headers = { Authorization: 'Bearer ' + ctx.token, 'Content-Type': 'application/json', Accept: 'application/json' };
    msg.requestTimeout = 10000; msg.httpRequestTimeout = 10000; msg.followRedirects = false; msg.maxRedirects = 0;
    return ports(4);
  };
  const httpOkay = () => !msg.error && msg.statusCode >= 200 && msg.statusCode < 300
    && msg.url === ctx.monthlyExpectedUrl && msg.responseUrl === ctx.monthlyExpectedUrl;
  const claimIdentity = (kind, value, resume) => {
    const o = c.lookup(ctx.monthlyLedger, ctx.paymentRef);
    ctx.monthlyIdentityClaim = { _id: 'monthly-friendship-' + kind + ':' + encodeURIComponent(scope.tenant_id) + ':' + encodeURIComponent(value),
      documentType: 'MONTHLY_FRIENDSHIP_IDENTITY_V1', tenant_id: scope.tenant_id, identityKind: kind, identityValue: value,
      ownerLedgerId: ctx.monthlyLedger._id, paymentRefOwner: ctx.paymentRef, attemptedAt: o.attemptedAt, generation: o.generation };
    ctx.monthlyIdentityResume = resume;
    const field = kind === 'transaction' ? 'transactionId' : 'clientSubscriptionId';
    const operationField = kind === 'transaction' ? 'operations.transactionId' : 'operations.subscriptionId';
    return find('monthly_identity_existing', { $or: [{ [field]: value }, { [operationField]: value }] });
  };
  const request = () => ({ ...scope, paymentRef: ctx.paymentRef, clientId: ctx.clientId,
    clientPhone: ctx.transactionPayload.clientPhone, productId: ctx.productId, productName: ctx.productName,
    campaignKey: ctx.campaignKey, amountMinor: ctx.priceMinor, providerProductCostMinor: ctx.providerProductCostMinor,
    discountMinor: ctx.discountMinor, releasePhase: ctx.releasePhase || null, dailyDropDate: ctx.dailyDropDate || null, counterEpoch: ctx.counterEpoch || null,
    providerPayload: JSON.parse(JSON.stringify(ctx.transactionPayload)) });
  const project = operation => {
    scrub(); ctx.monthlyOperation = operation; ctx.step = 'monthly_projection_ack';
    const r = operation.request, key = c.id(r.tenant_id, r.inventoryId);
    const row = { ...r, providerPayload: undefined, _id: key + ':' + r.paymentRef,
      status: operation.state === 'PAID' ? 'PAID' : 'PAYMENT_PENDING',
      monthlyCustody: { version: 1, ledgerId: key, tenantId: r.tenant_id, revision: ctx.monthlyLedger.revision },
      transactionId: operation.transactionId, paymentUrl: operation.paymentUrl, expiresAt: operation.expiresAt,
      clientSubscriptionId: operation.subscriptionId, createdAt: operation.createdAt, updatedAt: operation.updatedAt,
      paidAt: operation.paidAt, planKey: 'friendship', saleType: 'summer_campaign' };
    delete row.providerPayload;
    msg.payload = [{ _id: row._id, 'monthlyCustody.ledgerId': key, paymentRef: r.paymentRef,
      $or: [{ 'monthlyCustody.revision': { $lte: ctx.monthlyLedger.revision } }, { 'monthlyCustody.revision': { $exists: false } }] },
      { $set: row }, { upsert: true }]; return ports(2);
  };
  try {
    if (!scope) return reply('MONTHLY_FRIENDSHIP_BINDING_UNAVAILABLE', 503);
    ctx.monthlyScope = scope;
    if (ctx.step === 'piter_reserve_start') {
      if (!enabled()) return reply('MONTHLY_FRIENDSHIP_ADMISSION_CLOSED', 503);
      ctx.monthlyReadMode = false;
      return http('monthly_client', 'GET', '/clients?phone=' + encodeURIComponent(ctx.clientPhone) + '&size=20');
    }
    if (ctx.step === 'monthly_client') {
      const p = msg.payload;
      if (!httpOkay() || !Array.isArray(p?.content) || p.number !== 0 || p.totalPages !== 1
        || p.totalElements !== p.content.length || p.content.length > 20 || p.last !== true || p.numberOfElements !== p.content.length) return reply('MONTHLY_FRIENDSHIP_CLIENT_LOOKUP_INCOMPLETE');
      const phone = v => typeof v === 'string' ? v.replace(/[^0-9]/g, '').replace(/^8(?=[0-9]{10}$)/, '7') : null;
      const rows = p.content.filter(r => [r.phone,r.mobile,r.phoneNumber].some(v => phone(v) === phone(ctx.clientPhone)));
      if (rows.length !== 1) return reply('MONTHLY_FRIENDSHIP_CLIENT_AMBIGUOUS', 409);
      const row = rows[0], ids = [row.id,row.uuid,row.clientId].filter(v => v != null);
      const phones = [row.phone,row.mobile,row.phoneNumber].filter(v => v != null);
      if (!ids.length || ids.some(v => typeof v !== 'string' || !v || v !== ids[0])
        || phones.some(v => phone(v) !== phone(ctx.clientPhone))
        || (ctx.clientId && ctx.clientId !== ids[0])) return reply('MONTHLY_FRIENDSHIP_CLIENT_MISMATCH', 409);
      ctx.clientId = ids[0]; ctx.monthlyRequest = request(); return find('monthly_found');
    }
    if (ctx.step === 'monthly_confirm_start') { ctx.monthlyReadMode = true; return find('monthly_found'); }
    if (ctx.step === 'monthly_inserted' || ctx.step === 'monthly_reserved') return find('monthly_found');
    if (ctx.step === 'monthly_found') {
      if (msg.error || !Array.isArray(msg.payload)) return reply('MONTHLY_FRIENDSHIP_STORAGE_UNAVAILABLE', 503);
      const rows = msg.payload;
      if (rows.some(r => r.paymentRef === ctx.paymentRef && r.inventoryId !== ctx.inventoryId)) return reply('MONTHLY_FRIENDSHIP_PAYMENT_REF_CONFLICT', 409);
      if (rows.some(r => r.documentType === c.kind && r.inventoryId === scope.inventoryId && r.tenant_id !== scope.tenant_id)) return reply('MONTHLY_FRIENDSHIP_TENANT_CONFLICT', 409);
      const matches = rows.filter(r => r._id === c.id(scope.tenant_id, scope.inventoryId));
      if (matches.length > 1) return reply('MONTHLY_FRIENDSHIP_STORAGE_UNAVAILABLE', 503);
      if (!matches.length) {
        if (!enabled() || ctx.monthlyReadMode) return reply('MONTHLY_FRIENDSHIP_OPERATION_UNKNOWN');
        const initial = c.initial(scope, now());
        return cas('monthly_inserted', { query: { _id: initial._id }, update: { $setOnInsert: initial } }, { upsert: true });
      }
      const ledger = matches[0]; if (!c.validate(ledger)) return reply('MONTHLY_FRIENDSHIP_LEDGER_INVALID', 503);
      ctx.monthlyLedger = ledger;
      const existing = c.lookup(ledger, ctx.paymentRef);
      if (existing) {
        if (ctx.monthlyReadMode) {
          if (ctx.clientId !== existing.request.clientId || ctx.productId !== existing.request.productId) return reply('MONTHLY_FRIENDSHIP_BINDING_CONFLICT', 409);
          ctx.monthlyRequest = existing.request;
          if (!existing.transactionId) {
            ctx.monthlyReturnOnly = true;
            return find('monthly_observation_read', { _id: ledger._id + ':provider:' + encodeURIComponent(ctx.paymentRef), tenant_id: scope.tenant_id });
          }
          return http('monthly_transaction', 'GET', '/transactions/' + encodeURIComponent(existing.transactionId));
        }
        if (c.stable(existing.request) !== c.stable(ctx.monthlyRequest)) return reply('MONTHLY_FRIENDSHIP_IDEMPOTENCY_CONFLICT', 409);
        if (existing.state !== 'CLAIMED') {
          if (!existing.transactionId) return find('monthly_observation_read', { _id: ledger._id + ':provider:' + encodeURIComponent(ctx.paymentRef), tenant_id: scope.tenant_id });
          return project(existing);
        }
        if (!enabled()) return reply('MONTHLY_FRIENDSHIP_ADMISSION_CLOSED', 503);
        return cas('monthly_dispatch_ack', c.dispatch(ledger, ctx.monthlyRequest, now()));
      }
      if (ctx.monthlyReadMode || !enabled()) return reply('MONTHLY_FRIENDSHIP_OPERATION_UNKNOWN');
      // A legacy row using this ref must never be adopted as a fresh monthly intent.
      if (rows.some(r => r.paymentRef === ctx.paymentRef)) return reply('MONTHLY_FRIENDSHIP_LEGACY_PAYMENT_REF_CONFLICT', 409);
      const counted = c.countingRows(rows, scope);
      const probeCtx = JSON.parse(JSON.stringify(ctx));
      const probe = capacityProbe({ _summerSubscriptionCtx: probeCtx, payload: counted }, globalContext);
      if (probe?.ok !== true || !Number.isSafeInteger(probe.context.remainingBefore) || probe.context.remainingBefore < 1
        || probe.context.releasePhase !== ctx.releasePhase || probe.context.dailyDropDate !== ctx.dailyDropDate) return reply('MONTHLY_FRIENDSHIP_CAPACITY_UNAVAILABLE', 409);
      const mutation = c.reserve(ledger, ctx.monthlyRequest, { ledgerRevision: ledger.revision, inventoryId: ledger.inventoryId,
        counterKey: 'friendship', remaining: probe.context.remainingBefore }, now());
      return cas('monthly_reserved', mutation);
    }
    if (ctx.step === 'monthly_dispatch_ack') {
      // Lost ACK is deliberately not repaired into another POST, even after TTL.
      if (!exactAck() || !c.acknowledgedDispatch(ctx.monthlyMutation, msg.payload)) return reply('MONTHLY_FRIENDSHIP_RECONCILIATION_REQUIRED');
      ctx.monthlyLedger = ctx.monthlyMutation.next;
      if (!enabled()) return reply('MONTHLY_FRIENDSHIP_ADMISSION_CLOSED');
      return http('monthly_provider_result', 'POST', '/transactions', ctx.monthlyRequest.providerPayload);
    }
    if (ctx.step === 'monthly_provider_result') {
      const body = msg.payload;
      const response = { statusCode: httpOkay() ? msg.statusCode : 0,
        transactionId: body?.id, amountMinor: body?.toPay,
        paymentUrl: body?.paymentUrl, expiresAt: body?.paymentDueDate };
      const observation = c.observation(ctx.monthlyLedger, ctx.monthlyRequest, response);
      ctx.monthlyExpectedObservation = observation; ctx.step = 'monthly_observation_ack'; scrub();
      msg.payload = [{ _id: observation._id, tenant_id: scope.tenant_id }, { $setOnInsert: observation }, { upsert: true }];
      return ports(2);
    }
    if (ctx.step === 'monthly_observation_ack') return find('monthly_observation_read', {
      _id: ctx.monthlyExpectedObservation._id, tenant_id: scope.tenant_id });
    if (ctx.step === 'monthly_observation_read') {
      if (msg.error || !Array.isArray(msg.payload) || msg.payload.length !== 1
        || !c.observationMatches(msg.payload[0], ctx.monthlyLedger, ctx.monthlyRequest)
        || (ctx.monthlyExpectedObservation && c.stable(msg.payload[0]) !== c.stable(ctx.monthlyExpectedObservation))) {
        return reply('MONTHLY_FRIENDSHIP_PROVIDER_OBSERVATION_UNAVAILABLE');
      }
      ctx.monthlyObservation = msg.payload[0]; ctx.monthlyResultRetries = 0;
      if (ctx.monthlyObservation.response.transactionId) return claimIdentity('transaction', ctx.monthlyObservation.response.transactionId, 'result');
      return find('monthly_result_readback');
    }
    if (ctx.step === 'monthly_identity_existing') {
      const claim = ctx.monthlyIdentityClaim;
      if (msg.error || !Array.isArray(msg.payload)) return reply('MONTHLY_FRIENDSHIP_IDENTITY_UNAVAILABLE');
      const conflict = msg.payload.some(row => {
        if (row._id === ctx.monthlyLedger._id && c.validate(row)) {
          const field = claim.identityKind === 'transaction' ? 'transactionId' : 'subscriptionId';
          return row.operations.some(o => o[field] === claim.identityValue && o.request.paymentRef !== ctx.paymentRef);
        }
        return !(row._id === ctx.monthlyLedger._id + ':' + ctx.paymentRef && row.monthlyCustody?.ledgerId === ctx.monthlyLedger._id
          && row.paymentRef === ctx.paymentRef && row.clientId === ctx.monthlyRequest.clientId && row.productId === ctx.monthlyRequest.productId);
      });
      if (conflict) return reply('MONTHLY_FRIENDSHIP_IDENTITY_ALREADY_OWNED', 409);
      scrub(); ctx.step = 'monthly_identity_ack';
      msg.payload = [{ _id: claim._id, tenant_id: scope.tenant_id }, { $setOnInsert: claim }, { upsert: true }]; return ports(2);
    }
    if (ctx.step === 'monthly_identity_ack') return find('monthly_identity_read', { _id: ctx.monthlyIdentityClaim._id, tenant_id: scope.tenant_id });
    if (ctx.step === 'monthly_identity_read') {
      if (msg.error || !Array.isArray(msg.payload) || msg.payload.length !== 1
        || c.stable(msg.payload[0]) !== c.stable(ctx.monthlyIdentityClaim)) return reply('MONTHLY_FRIENDSHIP_IDENTITY_ALREADY_OWNED', 409);
      if (ctx.monthlyIdentityResume === 'confirm') return cas('monthly_confirm_ack', ctx.monthlyPendingConfirmation);
      return find('monthly_result_readback');
    }
    if (ctx.step === 'monthly_result_ack' || ctx.step === 'monthly_confirm_ack') {
      // Never expose a result based only on the in-memory provider response.
      ctx.monthlyReturnOnly = true; return find('monthly_result_readback');
    }
    if (ctx.step === 'monthly_result_readback') {
      if (msg.error || !Array.isArray(msg.payload)) return reply('MONTHLY_FRIENDSHIP_STORAGE_UNAVAILABLE', 503);
      const ledgers = msg.payload.filter(r => r._id === c.id(scope.tenant_id, scope.inventoryId));
      if (ledgers.length !== 1 || !c.validate(ledgers[0])) return reply('MONTHLY_FRIENDSHIP_STORAGE_UNAVAILABLE', 503);
      ctx.monthlyLedger = ledgers[0];
      const saved = c.lookup(ledgers[0], ctx.paymentRef);
      if (!saved || c.stable(saved.request) !== c.stable(ctx.monthlyRequest)) return reply('MONTHLY_FRIENDSHIP_BINDING_CONFLICT', 409);
      if (ctx.monthlyObservation && ['DISPATCHING','PROVIDER_UNKNOWN'].includes(saved.state)
        && ctx.monthlyResultRetries < 3 && c.observationMatches(ctx.monthlyObservation, ledgers[0], ctx.monthlyRequest)) {
        ctx.monthlyResultRetries++;
        return cas('monthly_result_ack', c.result(ledgers[0], ctx.monthlyRequest, ctx.monthlyObservation.response, now()));
      }
      return project(saved);
    }
    if (ctx.step === 'monthly_projection_ack') {
      if (msg.error || msg.payload?.acknowledged !== true
        || !(msg.payload.matchedCount === 1 || msg.payload.upsertedCount === 1)) return reply('MONTHLY_FRIENDSHIP_PROJECTION_PENDING');
      return reply(null, 200, ctx.monthlyOperation);
    }
    if (ctx.step === 'monthly_transaction') {
      if (!httpOkay()) return reply('MONTHLY_FRIENDSHIP_PROVIDER_UNAVAILABLE');
      const original = c.lookup(ctx.monthlyLedger, ctx.paymentRef);
      const fact = observe(msg.payload, { productId: original.request.productId, clientId: original.request.clientId, requireInstance: false });
      if (fact.transactionId !== original.transactionId || fact.clientId !== original.request.clientId
        || fact.amountMinor !== original.request.amountMinor || fact.costMinor !== original.request.providerProductCostMinor
        || fact.discountMinor !== original.request.discountMinor) return reply('MONTHLY_FRIENDSHIP_PROVIDER_MISMATCH');
      if (fact.state !== 'PAID') return reply('MONTHLY_FRIENDSHIP_NOT_ISSUED', 202, original);
      ctx.monthlyTransaction = msg.payload; ctx.monthlyPage = 0; ctx.monthlySubscriptions = [];
      return http('monthly_instances', 'GET', '/clients/' + encodeURIComponent(original.request.clientId) + '/subscriptions?includeFinished=true&size=200&page=0');
    }
    if (ctx.step === 'monthly_instances') {
      const p = msg.payload;
      if (!httpOkay() || !Array.isArray(p?.content) || p.content.length > 200 || p.number !== ctx.monthlyPage
        || !Number.isSafeInteger(p.totalPages) || p.totalPages < 1 || p.totalPages > 50
        || !Number.isSafeInteger(p.totalElements) || p.totalElements < 0 || p.totalElements > 10000
        || p.totalPages !== Math.max(1, Math.ceil(p.totalElements / 200)) || p.numberOfElements !== p.content.length
        || p.last !== (p.number === p.totalPages - 1) || (p.last === false && p.content.length !== 200)
        || (ctx.monthlyPage > 0 && (p.totalPages !== ctx.monthlyTotalPages || p.totalElements !== ctx.monthlyTotalElements))) return reply('MONTHLY_FRIENDSHIP_INSTANCE_SNAPSHOT_INCOMPLETE');
      ctx.monthlyTotalPages = p.totalPages; ctx.monthlyTotalElements = p.totalElements;
      ctx.monthlySubscriptions.push(...p.content);
      const instanceIds = ctx.monthlySubscriptions.map(s => {
        const ids = [s?.id,s?.uuid,s?.subscriptionId,s?.clientSubscriptionId].filter(v => v != null);
        return ids.length && ids.every(v => typeof v === 'string' && v && v === ids[0]) ? ids[0] : null;
      });
      if (instanceIds.some(v => v === null) || new Set(instanceIds).size !== instanceIds.length) return reply('MONTHLY_FRIENDSHIP_INSTANCE_SNAPSHOT_INCOMPLETE');
      if (++ctx.monthlyPage < p.totalPages) return http('monthly_instances', 'GET', '/clients/' + encodeURIComponent(ctx.monthlyRequest.clientId)
        + '/subscriptions?includeFinished=true&size=200&page=' + ctx.monthlyPage);
      if (ctx.monthlySubscriptions.length !== p.totalElements) return reply('MONTHLY_FRIENDSHIP_INSTANCE_SNAPSHOT_INCOMPLETE');
      const mutation = c.confirm(ctx.monthlyLedger, ctx.paymentRef, ctx.monthlyTransaction,
        { complete: true, clientId: ctx.monthlyRequest.clientId, subscriptions: ctx.monthlySubscriptions,
          rowCount: p.totalElements, pages: p.totalPages }, observe, now());
      if (mutation.existing) return project(mutation.existing);
      ctx.monthlyPendingConfirmation = mutation;
      const next = c.lookup(mutation.next, ctx.paymentRef);
      return claimIdentity('subscription', next.subscriptionId, 'confirm');
    }
    return reply('MONTHLY_FRIENDSHIP_STAGE_INVALID', 503);
  } catch {
    // Neither provider bodies nor stored client identity escape error responses/logs.
    return reply('MONTHLY_FRIENDSHIP_RECONCILIATION_REQUIRED');
  }
}
