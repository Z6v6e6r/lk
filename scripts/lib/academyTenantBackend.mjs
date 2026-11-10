/** Self-contained Node-RED function body; no client field selects a tenant or collection. */
export function academyTenantRuntime(stage, msg, env, action, contract) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const text = value => typeof value === 'string' ? value.trim() : '';
  const expectedIssuer = 'https://kc.vivacrm.ru/realms/clients';
  const origin = text(msg.req?.headers?.origin);
  const allowed = text(env?.get?.('ACADEMY_ALLOWED_ORIGINS'))
    || 'https://lk-reserve.89-108-64-209.sslip.io https://cg178013.tw1.ru';
  const origins = allowed.split(/[\s,]+/).filter(Boolean);
  const corsAllowed = !origin || origins.includes(origin);
  const respond = (status, payload) => {
    msg.statusCode = status;
    msg.headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    if (origin && corsAllowed) Object.assign(msg.headers, {
      'Access-Control-Allow-Origin': origin, Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    });
    msg.payload = payload;
    delete msg.url; delete msg.method; delete msg._academy; delete msg.error;
    return msg;
  };
  const fail = (status, code) => respond(status, { error: code, code });
  const readProvider = () => {
    if (msg.statusCode === 401 || msg.statusCode === 403) return null;
    if (!(msg.statusCode >= 200 && msg.statusCode < 300)) throw new Error('Provider unavailable');
    let data = msg.payload;
    if (typeof data === 'string') { if (data.length > 65536) throw new Error('Provider response too large'); data = JSON.parse(data); }
    if (!object(data)) throw new Error('Invalid provider response');
    return data;
  };
  const denied = (status, code, size = 2) => { const result = Array(size).fill(null); result[size - 1] = fail(status, code); return result; };
  const providerRequest = url => {
    msg.url = url; msg.method = 'GET'; msg.requestTimeout = 5000; msg.followRedirects = false;
    msg.headers = { Authorization: msg._academy.authorization, Accept: 'application/json' };
    msg.payload = ''; delete msg.statusCode;
    return [msg, null];
  };
  if (!corsAllowed) {
    if (stage === 'error' || stage === 'response') return fail(403, 'ORIGIN_DENIED');
    return stage === 'operation' ? denied(403, 'ORIGIN_DENIED', 6) : denied(403, 'ORIGIN_DENIED');
  }
  if (stage === 'error') return fail(503, 'ACADEMY_SERVICE_UNAVAILABLE');
  if (stage === 'prepare') {
    if (action === 'options') return [null, respond(204, '')];
    if (action === 'health') return [null, respond(200, { ok: true, tenantKey: contract.tenantKey, documentSetVersion: contract.documentSetVersion, module: 'academy-v1' })];
    const authorization = text(msg.req?.headers?.authorization);
    if (!/^Bearer [A-Za-z0-9._~-]{20,8192}$/i.test(authorization)) return denied(401, 'AUTH_REQUIRED');
    const raw = authorization.slice(7);
    let claims;
    try { claims = JSON.parse(Buffer.from(raw.split('.')[1], 'base64url').toString('utf8')); }
    catch { return denied(401, 'AUTH_INVALID'); }
    if (!object(claims)) return denied(401, 'AUTH_INVALID');
    const tokenSubject = text(claims.sub);
    const tokenTenant = text(claims.tenantKey || claims.tenant_key || claims.tenant);
    if (!tokenSubject || tokenSubject.length > 128 || tokenTenant !== contract.tenantKey
      || claims.iss !== expectedIssuer || claims.azp !== 'widget'
      || !text(claims.scope).split(/\s+/).includes('openid')) return denied(403, 'AUTH_CONTEXT_MISMATCH');
    const body = object(msg.payload) ? msg.payload : {};
    if (JSON.stringify(body).length > 65536) return denied(413, 'PAYLOAD_TOO_LARGE');
    if (body.tenantKey && body.tenantKey !== contract.tenantKey) return denied(403, 'TENANT_MISMATCH');
    msg._academy = { action, authorization, tokenSubject, tokenTenant, body };
    // Claims are only a rejection filter here. No operation is authorized until both provider reads succeed.
    return providerRequest(`${expectedIssuer}/protocol/openid-connect/userinfo`);
  }
  if (stage === 'userinfo') {
    try {
      const claims = readProvider();
      if (!claims) return denied(401, 'AUTH_DENIED');
      if (text(claims.sub) !== msg._academy.tokenSubject) return denied(403, 'AUTH_SUBJECT_MISMATCH');
      const tenant = text(claims.tenantKey || claims.tenant_key || claims.tenant);
      if (tenant && tenant !== contract.tenantKey) return denied(403, 'AUTH_TENANT_MISMATCH');
      return providerRequest(`https://api.vivacrm.ru/end-user/api/v1/${contract.tenantKey}/profile`);
    } catch { return denied(503, 'AUTH_SERVICE_UNAVAILABLE'); }
  }
  if (stage === 'operation') {
    try {
      const profile = readProvider();
      if (!profile) return denied(401, 'PROFILE_DENIED', 6);
      const clientId = text(profile.id);
      if (!clientId || clientId.length > 256) return denied(503, 'PROFILE_INVALID', 6);
      const ctx = msg._academy;
      const subject = ctx.tokenSubject;
      const body = ctx.body;
      const now = new Date();
      ctx.clientId = clientId; ctx.subject = subject;
      delete ctx.authorization; delete ctx.tokenSubject; delete ctx.tokenTenant;
      delete msg.headers; delete msg.url; delete msg.method;
      const output = index => { const result = Array(6).fill(null); result[index] = msg; return result; };
      if (ctx.action === 'consent') {
        const documents = body.documents;
        if (body.schemaVersion !== 1 || body.documentSetVersion !== contract.documentSetVersion
          || !Array.isArray(documents) || documents.length !== contract.documents.length
          || !contract.documents.every(expected => documents.some(current => object(current)
            && current.id === expected.id && current.version === expected.version
            && current.url === expected.url && current.accepted === true))) return denied(400, 'CONSENT_DOCUMENTS_INVALID', 6);
        if (!['sms', 'vkid', 'yandex'].includes(body.authMethod)) return denied(400, 'CONSENT_METHOD_INVALID', 6);
        const clientTime = Date.parse(text(body.acceptedAtClient));
        if (!Number.isFinite(clientTime) || clientTime > now.getTime() + 300000) return denied(400, 'CONSENT_TIME_INVALID', 6);
        const id = `consent:${contract.tenantKey}:${encodeURIComponent(subject)}:${contract.documentSetVersion}`;
        msg.payload = [{ _id: id }, { $setOnInsert: {
          tenantKey: contract.tenantKey, subject, clientId, documents: contract.documents,
          documentSetVersion: contract.documentSetVersion, acceptedAt: now,
          acceptedAtClient: new Date(clientTime), authMethodReported: body.authMethod,
        } }, { upsert: true }];
        delete ctx.body;
        return output(0);
      }
      if (ctx.action === 'communities') {
        msg.payload = [{ tenantKey: contract.tenantKey, members: { $elemMatch: { clientId, status: 'ACTIVE' } } }, {
          projection: { _id: 1, name: 1, slug: 1, logoUrl: 1, visibility: 1 }, limit: 100,
        }];
        delete ctx.body;
        return output(1);
      }
      if (ctx.action === 'register' || ctx.action === 'unregister') {
        const token = text(body.token);
        if (!/^[A-Za-z0-9:._-]{20,512}$/.test(token)) return denied(400, 'PUSH_TOKEN_INVALID', 6);
        const id = `push:${Buffer.from(JSON.stringify([contract.tenantKey, subject, token])).toString('base64url')}`;
        const filter = { _id: id, tenantKey: contract.tenantKey, subject };
        if (ctx.action === 'unregister') msg.payload = [filter];
        else {
          if (!['android', 'ios', 'web'].includes(body.platform)) return denied(400, 'PUSH_PLATFORM_INVALID', 6);
          msg.payload = [filter, { $set: { token, clientId, platform: body.platform, updatedAt: now }, $setOnInsert: { createdAt: now } }, { upsert: true }];
        }
        delete ctx.body;
        return output(ctx.action === 'register' ? 2 : 3);
      }
      if (ctx.action === 'events') {
        const event = text(body.event);
        if (!/^[A-Za-z0-9_.-]{1,100}$/.test(event)) return denied(400, 'EVENT_INVALID', 6);
        // Store no submitted user/URL/error/phone/token fields. Identity comes only from the verified profile.
        msg.payload = [{ tenantKey: contract.tenantKey, subject, clientId, event, receivedAt: now }];
        delete ctx.body;
        return output(4);
      }
      return denied(400, 'ACTION_INVALID', 6);
    } catch { return denied(503, 'PROFILE_SERVICE_UNAVAILABLE', 6); }
  }
  if (stage === 'response') {
    if (msg._academy?.action === 'communities') {
      const records = Array.isArray(msg.payload) ? msg.payload : [];
      const communities = records.map(record => ({
        id: String(record._id), name: text(record.name), slug: text(record.slug) || null,
        logoUrl: text(record.logoUrl) || null, visibility: record.visibility === 'OPEN' ? 'OPEN' : 'CLOSED',
      }));
      return respond(200, { communities, connections: [], total: communities.length });
    }
    return respond(200, { ok: true, tenantKey: contract.tenantKey });
  }
  return fail(500, 'STAGE_INVALID');
}
