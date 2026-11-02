import crypto from 'node:crypto';

// Concrete private monthly counter contract. No provider or storage side effects.
export function createMonthlyFriendshipApi(crypto) {
  const version = 'monthly-friendship.v1';
  const offerId = '862670f6-a476-4a18-aecb-9e27661fbad3';
  const modes = ['quote', 'purchase', 'read', 'reconcile'];
  const prefix = '/lk/integrations/v1/monthly-friendship/';
  const object = x => !!x && typeof x === 'object' && !Array.isArray(x);
  const exact = (x, keys) => object(x) && Object.keys(x).sort().join() === keys.split(',').sort().join();
  const uuid = x => typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
  const id = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(x);
  const digest = x => typeof x === 'string' && /^sha256:[a-f0-9]{64}$/.test(x);
  const iso = x => typeof x === 'string' && x.length === 24 && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
  const stable = x => JSON.stringify((function sort(v) {
    return Array.isArray(v) ? v.map(sort) : object(v)
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v;
  })(x));
  const hash = x => 'sha256:' + crypto.createHash('sha256').update(x).digest('hex');
  const operationId = c => {
    const h = hash('monthly-friendship-operation:v1\0' + c.tenant_id + '\0' + c.sub + '\0' + c.idempotency_key_sha256).slice(7,39).split('');
    h[12] = '8'; h[16] = ((parseInt(h[16],16) & 3) | 8).toString(16);
    const s = h.join(''); return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
  };
  const bodyValid = (mode, b) => exact(b, mode === 'purchase' ? 'contract,offerId,expectedRevision,amountMinor,currency' : 'contract,offerId')
    && b.contract === version && b.offerId === offerId && (mode !== 'purchase'
      || (digest(b.expectedRevision) && Number.isSafeInteger(b.amountMinor) && b.amountMinor > 0 && b.currency === 'RUB'));
  const requestHash = (mode, b) => hash(version + '\0' + mode + '\0' + stable(b));
  const header = (m, k) => typeof m.req?.headers?.[k] === 'string' ? m.req.headers[k] : null;
  const config = get => {
    if (get('LK_MONTHLY_FRIENDSHIP_API_ENABLED') !== 'true') return null;
    const values = Object.fromEntries(['ISSUER','AUDIENCE','KEY_ID','PUBLIC_KEY_PEM','TENANT_ID'].map(k => [k,get('LK_MONTHLY_FRIENDSHIP_API_' + k)]));
    if (!uuid(values.TENANT_ID) || !['ISSUER','AUDIENCE'].every(k => typeof values[k] === 'string' && /^[!-~]{1,512}$/.test(values[k])) || !id(values.KEY_ID)
      || typeof values.PUBLIC_KEY_PEM !== 'string' || values.PUBLIC_KEY_PEM.length > 8192) return null;
    return values;
  };
  const verify = (msg, get, nowMs = Date.now()) => {
    const fail = (status, code) => ({ ok: false, status, code });
    const settings = config(get); if (!settings) return fail(503, 'MONTHLY_API_UNAVAILABLE');
    try {
      const path = msg.req?.originalUrl || msg.req?.url, mode = modes.find(m => path === prefix + m);
      if (!mode || msg.req?.method !== 'POST' || !exact(msg.req.query || {}, '')
        || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(header(msg, 'content-type') || '')) return fail(400, 'MONTHLY_API_REQUEST_INVALID');
      const token = header(msg, 'x-subscription-actor-delegation');
      if (!token || token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw Error();
      const parts = token.split('.');
      const parse = part => {
        const bytes = Buffer.from(part, 'base64url'), text = bytes.toString('utf8'), v = JSON.parse(text);
        if (!object(v) || !bytes.equals(Buffer.from(text)) || Buffer.from(stable(v)).toString('base64url') !== part) throw Error();
        return v;
      };
      const h = parse(parts[0]);
      if (!exact(h, 'alg,kid,typ') || h.alg !== 'RS256' || h.kid !== settings.KEY_ID || h.typ !== 'phub-monthly-friendship-actor+jwt') throw Error();
      const key = crypto.createPublicKey(settings.PUBLIC_KEY_PEM);
      if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength < 2048
        || !crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2], 'base64url'))) throw Error();
      const c = parse(parts[1]), now = Math.floor(nowMs / 1000);
      if (!exact(c, 'iss,aud,sub,sid,jti,iat,nbf,exp,contract,caller,scope,method,path,tenant_id,tenant_key,provider,provider_client_id,provider_mapping_id,operation_id,idempotency_key_sha256,request_sha256,correlation_id,actor_token_sha256,actor_token_expires_at')
        || c.iss !== settings.ISSUER || c.aud !== settings.AUDIENCE || c.contract !== version || c.caller !== 'lk2-api'
        || c.tenant_id !== settings.TENANT_ID || c.tenant_key !== 'iSkq6G' || c.provider !== 'VIVA'
        || ![c.sub,c.sid,c.jti,c.tenant_id,c.provider_mapping_id,c.operation_id].every(uuid)
        || !id(c.provider_client_id) || !id(c.correlation_id)
        || ![c.iat,c.nbf,c.exp].every(Number.isSafeInteger) || c.nbf !== c.iat || c.iat > now || c.exp <= now || c.exp <= c.iat || c.exp - c.iat > 60
        || c.scope !== 'subscription-runtime.monthly-friendship.' + mode || c.method !== 'POST' || c.path !== path
        || header(msg, 'x-correlation-id') !== c.correlation_id
        || ![c.idempotency_key_sha256,c.request_sha256,c.actor_token_sha256].every(digest)
        || c.operation_id !== operationId(c) || !iso(c.actor_token_expires_at) || Date.parse(c.actor_token_expires_at) <= nowMs) throw Error();
      const actorToken = header(msg, 'x-subscription-actor-token');
      if (!actorToken || !/^[!-~]{16,4096}$/.test(actorToken) || hash(actorToken) !== c.actor_token_sha256) throw Error();
      if (!bodyValid(mode, msg.payload) || c.request_sha256 !== requestHash(mode, msg.payload)) return fail(400, 'MONTHLY_API_REQUEST_INVALID');
      return { ok: true, mode, claims: c, body: JSON.parse(stable(msg.payload)), actorToken };
    } catch { return fail(401, 'MONTHLY_API_ACTOR_INVALID'); }
  };
  const phone = v => {
    if (typeof v !== 'string' || v.length > 32 || !/^\+?[0-9 ()-]+$/.test(v)) return null;
    const digits = v.replace(/\D/g,''); return /^[1-9][0-9]{7,14}$/.test(digits) ? '+' + digits : null;
  };
  const profilePhone = (p, clientId) => {
    if (!object(p) || p.archived === true || p.disabled === true || p.deleted === true || p.isActive === false) return null;
    const ids = [p.id,p.clientId].filter(v => v !== undefined), phones = [p.phone,p.mobile,p.phoneNumber].filter(v => v !== undefined);
    if (!ids.length || ids.some(v => v !== clientId) || !phones.length || !phone(phones[0]) || phones.some(v => phone(v) !== phone(phones[0]))) return null;
    return phone(phones[0]);
  };
  const products = (p, productId) => {
    if (!object(p) || !Array.isArray(p.content) || p.content.length > 500 || p.number !== 0 || p.totalPages !== 1
      || p.totalElements !== p.content.length || p.numberOfElements !== p.content.length || p.last !== true) return null;
    if (p.content.some(v => !id(v?.id)) || new Set(p.content.map(v => v.id)).size !== p.content.length) return null;
    const row = p.content.find(v => v.id === productId);
    if (!row || row.archived === true || row.deleted === true || row.disabled === true || row.isActive === false
      || !Number.isSafeInteger(row.cost) || row.cost < 1 || ![row.type,row.productType].some(v => v === 'SUBSCRIPTION')
      || [row.type,row.productType].some(v => v !== undefined && v !== 'SUBSCRIPTION')) return null;
    return row;
  };
  const quote = (ctx, rawProduct) => {
    if (ctx.counterKey !== 'friendship' || ctx.saleType !== 'summer_campaign' || ctx.promoCode || ctx.discountMinor !== 0
      || ctx.productId !== rawProduct.id || ctx.priceMinor !== rawProduct.cost || !Number.isSafeInteger(ctx.priceMinor) || ctx.priceMinor <= 0
      || !Number.isSafeInteger(ctx.remainingBefore) || ctx.remainingBefore < 1) throw Error('MONTHLY_API_QUOTE_INVALID');
    const snapshot = { offerId, inventoryId: ctx.inventoryId, productId: ctx.productId, amountMinor: ctx.priceMinor, currency: 'RUB',
      counterEpoch: ctx.counterEpoch || null, releasePhase: ctx.releasePhase || null, dailyDropDate: ctx.dailyDropDate || null,
      product: rawProduct, transactionPayload: ctx.transactionPayload };
    return { contract: version, offerId, revision: hash(version + '\0quote\0' + stable(snapshot)), amountMinor: ctx.priceMinor,
      currency: 'RUB', inventoryId: ctx.inventoryId, productId: ctx.productId };
  };
  const bindingId = c => 'monthly-friendship-actor:' + c.tenant_id + ':' + c.operation_id;
  const bindingMatches = (row, c) => row?._id === bindingId(c) && row.documentType === 'MONTHLY_FRIENDSHIP_ACTOR_BINDING_V1'
    && row.tenant_id === c.tenant_id && row.userId === c.sub && row.providerClientId === c.provider_client_id
    && row.providerMappingId === c.provider_mapping_id && row.operationId === c.operation_id
    && row.idempotencyKeyHash === c.idempotency_key_sha256 && row.offerId === offerId;
  return { version, offerId, modes, prefix, exact, id, uuid, digest, iso, stable, hash, operationId, bodyValid, requestHash,
    config, verify, profilePhone, products, quote, bindingId, bindingMatches };
}
export const monthlyFriendshipApi = createMonthlyFriendshipApi(crypto);
export const monthlyFriendshipApiRuntimeSource = () => 'const monthlyFriendshipApi = (' + createMonthlyFriendshipApi.toString() + ')(nodeCrypto);\n';
