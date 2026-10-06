import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { BOOKED_OPERATION_READ_PREFIX, createBookedOperationDelegationVerifier } from '../../lib/bookedOperationRead.mjs';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const operationId = randomUUID();
const path = BOOKED_OPERATION_READ_PREFIX + operationId;
const now = Math.floor(Date.now() / 1000);
const claims = { contract_version: 1, scope: 'subscription-runtime.booked-operation.read',
  caller: 'lk2-api', method: 'GET', path, operation_id: operationId,
  iss: 'https://lk2.example.test', aud: 'lk1-booked-read', sub: randomUUID(),
  tenant_id: randomUUID(), tenant_key: 'tenant-synthetic', sid: randomUUID(),
  provider: 'VIVA', provider_client_id: 'synthetic-client-01', provider_mapping_id: randomUUID(),
  correlation_id: 'b1-synthetic-correlation', iat: now, nbf: now, exp: now + 30, jti: randomUUID() };
function token(overrides = {}, headerOverrides = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const content = `${encode({ alg: 'RS256', typ: 'phub-subscription-runtime-actor-delegation+jwt', kid: 'synthetic-key', ...headerOverrides })}.${encode({ ...claims, ...overrides })}`;
  return content + '.' + sign('RSA-SHA256', Buffer.from(content), keys.privateKey).toString('base64url');
}
const verifier = createBookedOperationDelegationVerifier({
  keys: { 'synthetic-key': keys.publicKey.export({ type: 'spki', format: 'pem' }) },
  issuer: claims.iss, audience: claims.aud,
  tenantBindings: { [claims.tenant_key]: claims.tenant_id },
});
function receipt(overrides = {}) {
  return { tenantKey: claims.tenant_key, operationId, actorClientId: claims.provider_client_id,
    padlHubOperation: { contractVersion: 1, operationId, tenantId: claims.tenant_id,
      userId: claims.sub, providerMappingId: claims.provider_mapping_id, issuer: claims.iss, caller: claims.caller },
    state: 'CONFIRMED', bookingId: 'private-booking-001', activationState: 'NOT_REQUIRED',
    createdAt: '2026-10-06T08:00:00.000Z', updatedAt: '2026-10-06T08:01:00.000Z',
    confirmedAt: '2026-10-06T08:01:00.000Z', ...overrides };
}

const fixturePrivateKeyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
export { claims, receipt, token, verifier, path, operationId, fixturePrivateKeyPem };
