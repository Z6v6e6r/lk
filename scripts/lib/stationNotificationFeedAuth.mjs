import crypto from 'node:crypto';
import { smKeys, smCanonical, smUuid, smId } from './stationMembershipLifetime.mjs';
import { NF_NAMESPACE, NF_VERSION, nfPath, nfBodyHash, nfRequest, nfError } from './stationNotificationFeed.mjs';

export const NF_CONFIG_PREFIX = 'LK_STATION_NOTIFICATION_FEED_';
export function verifyStationNotificationFeed(msg, get, mode, nowMs = Date.now()) {
  const fail = (status, code) => ({ response: nfError(null, status, code) });
  if (get(NF_CONFIG_PREFIX + 'ENABLED') !== 'true') return fail(503, 'STATION_NOTIFICATION_DISABLED');
  const config = Object.fromEntries(['ISSUER','AUDIENCE','KEY_ID','PUBLIC_KEY_PEM','TENANT_ID','OWNER_NAMESPACE'].map(k => [k,get(NF_CONFIG_PREFIX + k)]));
  if (!Object.values(config).every(x => typeof x === 'string' && x.length > 0) || !smUuid(config.TENANT_ID) || config.OWNER_NAMESPACE !== NF_NAMESPACE) return fail(503, 'STATION_NOTIFICATION_AUTH_UNAVAILABLE');
  try {
    const token = msg.req?.headers?.['x-station-notification-delegation'];
    if (typeof token !== 'string' || token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw Error();
    const parts = token.split('.');
    const parse = part => { const bytes = Buffer.from(part, 'base64url'), text = bytes.toString('utf8'), value = JSON.parse(text); if (!bytes.equals(Buffer.from(text)) || Buffer.from(smCanonical(value)).toString('base64url') !== part) throw Error(); return value; };
    const header = parse(parts[0]);
    if (!smKeys(header, ['alg','typ','kid']) || header.alg !== 'RS256' || header.typ !== 'phub-station-notification-feed+jwt' || header.kid !== config.KEY_ID) throw Error();
    const key = crypto.createPublicKey(config.PUBLIC_KEY_PEM);
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength < 2048 || !crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2], 'base64url'))) throw Error();
    const c = parse(parts[1]), now = Math.floor(nowMs / 1000);
    if (!smKeys(c, ['iss','aud','sub','jti','iat','nbf','exp','tenant_id','owner_namespace','scope','method','path','body_sha256','correlation_id','request_id','contract']) || c.iss !== config.ISSUER || c.aud !== config.AUDIENCE || c.sub !== 'lk2-station-notification-importer' || c.tenant_id !== config.TENANT_ID || c.owner_namespace !== NF_NAMESPACE || c.contract !== NF_VERSION || !smUuid(c.jti) || !smUuid(c.request_id) || !smId(c.correlation_id) || /[\r\n]/.test(c.correlation_id) || ![c.iat,c.nbf,c.exp].every(Number.isSafeInteger) || c.nbf !== c.iat || c.iat > now || c.exp <= now || c.exp <= c.iat || c.exp - c.iat > 30) throw Error();
    if (c.scope !== 'communities.station-notifications.' + mode || c.method !== 'POST' || c.path !== nfPath(mode) || msg.req?.method !== 'POST' || (msg.req.originalUrl || msg.req.url) !== c.path || Object.keys(msg.req.query || {}).length || msg.req.headers['x-correlation-id'] !== c.correlation_id || msg.req.headers['x-padlhub-station-notification-contract'] !== NF_VERSION) throw Error();
    if (Buffer.byteLength(JSON.stringify(msg.payload) || '') > 8192 || !nfRequest(mode, msg.payload) || c.request_id !== msg.payload.requestId || c.body_sha256 !== nfBodyHash(msg.payload)) return fail(400, 'STATION_NOTIFICATION_REQUEST_INVALID');
    return { request: msg.payload, expiresAtMs: c.exp * 1000 };
  } catch { return fail(401, 'STATION_NOTIFICATION_AUTH_INVALID'); }
}
