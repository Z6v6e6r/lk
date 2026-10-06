import { createPublicKey, verify } from 'node:crypto';

export const BOOKED_OPERATION_READ_PREFIX = '/lk/integrations/v1/booked-operations/';
export const BOOKED_OPERATION_READ_SCOPE = 'subscription-runtime.booked-operation.read';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const opaque = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/;
const opaqueText = (value) => typeof value === 'string' && opaque.test(value);
const correlation = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const iso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;

function decode(part) {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error('Invalid encoding');
  const bytes = Buffer.from(part, 'base64url');
  if (bytes.toString('base64url') !== part) throw new Error('Invalid encoding');
  const value = JSON.parse(bytes.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid claims');
  return value;
}

// Trust is injected by the host. No key discovery, service-token fallback or live activation.
export function createBookedOperationDelegationVerifier({ keys, issuer, audience, tenantBindings, now = Date.now, admission = false }) {
  const expectedPath = admission ? '/lk/integrations/v1/booked-operation-admissions' : null;
  if (typeof issuer !== 'string' || !/^[!-~]{1,512}$/.test(issuer)
    || typeof audience !== 'string' || !/^[!-~]{1,256}$/.test(audience)
    || !keys || !tenantBindings || Object.keys(keys).length === 0
    || Object.entries(tenantBindings).some(([key, value]) => !opaqueText(key) || !uuid.test(value))) {
    throw new Error('Invalid booked-operation trust configuration');
  }
  const trustedKeys = new Map(Object.entries(keys).map(([id, pem]) => {
    if (!/^[A-Za-z0-9._:-]{3,64}$/.test(id)) throw new Error('Invalid booked-operation verification key');
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) {
      throw new Error('Invalid booked-operation verification key');
    }
    return [id, key];
  }));
  return ({ token, operationId, path, correlationId }) => {
    try {
      if (typeof token !== 'string' || token.length > 4096 || !uuid.test(operationId)
        || path !== (expectedPath ?? BOOKED_OPERATION_READ_PREFIX + operationId) || !correlation.test(correlationId)) return null;
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const [headerPart, payloadPart, signaturePart] = parts;
      const header = decode(headerPart);
      if (header.alg !== 'RS256' || header.typ !== 'phub-subscription-runtime-actor-delegation+jwt'
        || Object.keys(header).some((key) => !['alg', 'typ', 'kid'].includes(key))) return null;
      const key = trustedKeys.get(header.kid);
      const signature = Buffer.from(signaturePart, 'base64url');
      if (!key || !/^[A-Za-z0-9_-]+$/.test(signaturePart)
        || signature.toString('base64url') !== signaturePart
        || !verify('RSA-SHA256', Buffer.from(`${headerPart}.${payloadPart}`), key,
          signature)) return null;
      const claims = decode(payloadPart);
      const seconds = Math.floor(now() / 1000);
      if (claims.iss !== issuer || claims.aud !== audience || claims.caller !== 'lk2-api'
        || claims.scope !== (admission ? 'subscription-runtime.booked-operation.admit' : BOOKED_OPERATION_READ_SCOPE) || claims.contract_version !== 1
        || claims.method !== (admission ? 'POST' : 'GET') || claims.path !== path || claims.operation_id !== operationId
        || claims.correlation_id !== correlationId || claims.provider !== 'VIVA'
        || !uuid.test(claims.sub) || !uuid.test(claims.tenant_id) || !uuid.test(claims.sid)
        || !uuid.test(claims.provider_mapping_id) || !uuid.test(claims.jti)
        || !opaqueText(claims.provider_client_id) || !opaqueText(claims.tenant_key)
        || !Object.hasOwn(tenantBindings, claims.tenant_key)
        || tenantBindings[claims.tenant_key] !== claims.tenant_id
        || ![claims.iat, claims.nbf, claims.exp].every(Number.isSafeInteger)
        || claims.iat > seconds || claims.nbf > seconds || claims.nbf !== claims.iat
        || claims.exp <= seconds || claims.exp - claims.iat < 10 || claims.exp - claims.iat > 60) return null;
      return claims;
    } catch {
      return null;
    }
  };
}

// The association must be written by the commercial owner, never inferred from a UUID,
// phone, court/time, membership pilot or a reader-side synthetic fixture.
function ownedAssociation(row, claims) {
  const binding = row.padlHubOperation;
  return binding?.contractVersion === 1 && binding.operationId === claims.operation_id
    && binding.tenantId === claims.tenant_id && binding.userId === claims.sub
    && binding.providerMappingId === claims.provider_mapping_id && binding.issuer === claims.iss
    && binding.caller === claims.caller;
}

export function projectBookedOperation(row, claims) {
  if (!row || row.tenantKey !== claims.tenant_key || row.operationId !== claims.operation_id
    || row.actorClientId !== claims.provider_client_id || !ownedAssociation(row, claims)) return null;
  // A missing or impossible timestamp is not evidence of a terminal outcome.
  const asOf = iso(row.updatedAt) && iso(row.createdAt) && row.updatedAt >= row.createdAt
    ? row.updatedAt : null;
  let status = 'UNKNOWN';
  let reason = 'RECONCILIATION_REQUIRED';
  const managed = row.managedDecision != null || row.managedEntitlementOperationId != null
    || row.managedEntitlementState != null;
  const entitlementConfirmed = !managed || (opaqueText(row.managedEntitlementOperationId)
    && row.managedEntitlementState === 'CONFIRMED' && iso(row.managedEntitlementConfirmedAt)
    && row.managedEntitlementConfirmedAt >= row.createdAt && row.managedEntitlementConfirmedAt <= asOf);
  const activationConfirmed = row.activationState === 'NOT_REQUIRED'
    || (row.activationState === 'CONFIRMED' && iso(row.activationConfirmedAt)
      && Number.isSafeInteger(row.activationRevision) && row.activationRevision > 0
      && row.activationConfirmedAt >= row.createdAt && row.activationConfirmedAt <= asOf);
  if (asOf && ['PREPARED', 'PRECREATE_RESERVING', 'PRECREATE_RESERVED',
    'PRECREATE_ATTEMPTING', 'PENDING_CONFIRMATION'].includes(row.state)) {
    status = 'PENDING';
    reason = 'OWNER_PENDING';
  }
  // Confirmation is only the owner's durable booking receipt. It does not create a game
  // and does not certify a quote, payment mode or a future cancellation.
  if (asOf && row.state === 'CONFIRMED' && opaqueText(row.bookingId)
    && iso(row.confirmedAt) && row.confirmedAt >= row.createdAt && row.confirmedAt <= asOf
    && activationConfirmed
    && row.precreatedEntitlementReserved !== true
    && entitlementConfirmed) {
    status = 'CONFIRMED';
    reason = 'OWNER_BOOKING_CONFIRMED';
  }
  return { contractVersion: 1, operationId: claims.operation_id, status, asOf, reason };
}

export function createBookedOperationMongoReader(collection) {
  return async (claims, { signal } = {}) => {
    const rows = await collection.find({
      tenantKey: claims.tenant_key,
      operationId: claims.operation_id,
      actorClientId: claims.provider_client_id,
    }, {
      limit: 2, maxTimeMS: 1000, timeoutMS: 1500, signal, readConcern: { level: 'majority' },
      projection: { _id: 0, tenantKey: 1, operationId: 1, actorClientId: 1, padlHubOperation: 1,
        state: 1, createdAt: 1, updatedAt: 1, confirmedAt: 1, bookingId: 1,
        activationState: 1, activationConfirmedAt: 1, activationRevision: 1, managedEntitlementOperationId: 1, managedEntitlementState: 1,
        managedEntitlementConfirmedAt: 1, managedDecision: 1,
        precreatedEntitlementReserved: 1 },
    }).toArray();
    // No unique operationId index exists. Never pick an arbitrary duplicate.
    return rows.length === 1 ? projectBookedOperation(rows[0], claims) : null;
  };
}

export function createBookedOperationReadHandler({ verifyDelegation, read }) {
  return async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json');
    const send = (code, body) => { response.writeHead(code); response.end(JSON.stringify(body)); };
    const path = request.url;
    if (request.method !== 'GET') return send(405, { code: 'BOOKED_OPERATION_READ_ONLY' });
    if (typeof path !== 'string' || !path.startsWith(BOOKED_OPERATION_READ_PREFIX)
      || !uuid.test(path.slice(BOOKED_OPERATION_READ_PREFIX.length))) {
      return send(404, { code: 'BOOKED_OPERATION_NOT_FOUND' });
    }
    if (!verifyDelegation || !read) return send(503, { code: 'BOOKED_OPERATION_READ_DISABLED' });
    const claims = verifyDelegation({ token: request.headers['x-subscription-actor-delegation'],
      operationId: path.slice(BOOKED_OPERATION_READ_PREFIX.length), path,
      correlationId: request.headers['x-correlation-id'] });
    if (!claims) return send(401, { code: 'BOOKED_OPERATION_DELEGATION_REJECTED' });
    const controller = new AbortController();
    let timer;
    const cancel = () => controller.abort();
    response.once?.('close', cancel);
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Booked-operation read deadline')); }, 1500);
    });
    try {
      const outcome = await Promise.race([read(claims, { signal: controller.signal }), deadline]);
      if (!outcome) return send(404, { code: 'BOOKED_OPERATION_NOT_FOUND' });
      return send(200, outcome);
    } catch {
      return send(503, { code: 'BOOKED_OPERATION_READ_UNAVAILABLE' });
    } finally {
      clearTimeout(timer);
      response.removeListener?.('close', cancel);
    }
  };
}
