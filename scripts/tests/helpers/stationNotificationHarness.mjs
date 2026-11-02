import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { messageDb, uid } from './stationMessageHarness.mjs';
import { stationStreamAdoptionPlan } from '../../lib/stationMessageStream.mjs';
import { beginStationMessage, runStationMessage } from '../../lib/stationMessageOwner.mjs';
import { nfReadiness, nfFact, NF_VERSION, NF_NAMESPACE, nfPath, nfBodyHash } from '../../lib/stationNotificationFeed.mjs';
import { smCanonical } from '../../lib/stationMembershipLifetime.mjs';
export { uid };
export async function notificationFixture({ members = 4, messages = 3 } = {}) {
  const db = messageDb(), c = db.tables.get('lk_communities')[0];
  c.members = Array.from({ length: members }, (_,i) => ({ id: i === 0 ? 'player-a' : 'recipient-' + String(i).padStart(3,'0'), name: 'Synthetic' }));
  Object.assign(c, stationStreamAdoptionPlan(c, uid(900)).update.$set);
  for (let i = 1; i <= messages; i++) assert.equal((await runStationMessage(db, beginStationMessage({ communityId: c.id, actor: c.members[0], requestId: uid(i), text: 'Synthetic private body '+i, requiredContract: true }))).response.status, 200);
  return { db, c, records: db.tables.get('lk_community_chat_messages') || [], events: db.tables.get('lk_community_events') || [] };
}
export function requestFor(c, fields = {}) {
  const s = nfReadiness(c);
  return { contractVersion: 1, requestId: uid(950), communityId: c.id, streamId: s.streamId, incarnationHash: s.incarnationHash, ...fields };
}
export const publications = c => requestFor(c, { afterSequence: 0, throughSequence: null, limit: 50 });
export const recipients = (c,d,afterPlayerId = null,limit = 50) => requestFor(c, { fact: nfFact(c,d), afterPlayerId, limit });
export const eligibility = (c,d,playerId = 'recipient-001') => { const p = c.stationMembershipLifetime.players.find(p => p.playerId === playerId); return requestFor(c, { fact: nfFact(c,d), recipient: { playerId, membershipEpoch: p.epoch, baselineSequence: p.readPosition.baselineSequence, readThroughSequence: p.readPosition.readThroughSequence } }); };
// Test-only interpreter for the feed's actual bounded read descriptors; Mongo semantics are separately tested in CI.
export function feedMemory(db) {
  return { collection(name) { return { aggregate(pipeline,options) {
    assert.equal(options.maxTimeMS,3000); assert.equal(options.allowDiskUse,false);
    return { async toArray() {
      let rows = structuredClone(db.tables.get(name) || []);
      for (const stage of pipeline) {
        if (stage.$match) rows = rows.filter(row => Object.entries(stage.$match).every(([k,v]) => {
          if (k === '$expr') return Buffer.byteLength(JSON.stringify(row)) <= 65536;
          if (v && typeof v === 'object') {
            if (v.$in) return v.$in.includes(row[k]);
            return ('$gt' in v ? row[k] > v.$gt : true) && ('$lte' in v ? row[k] <= v.$lte : true);
          }
          return row[k] === v;
        }));
        else if (stage.$sort) rows.sort((a,b) => a.sequence - b.sequence);
        else if (stage.$limit) rows = rows.slice(0,stage.$limit);
        else throw Error('Unexpected non-read descriptor');
      }
      return rows;
    } };
  } }; } };
}
const keys = crypto.generateKeyPairSync('rsa',{modulusLength:2048});
export const authEnvironment = {
  LK_STATION_NOTIFICATION_FEED_ENABLED:'true', LK_STATION_NOTIFICATION_FEED_ISSUER:'https://synthetic.example.test', LK_STATION_NOTIFICATION_FEED_AUDIENCE:'synthetic-station-notification-owner', LK_STATION_NOTIFICATION_FEED_KEY_ID:'synthetic-notification-key', LK_STATION_NOTIFICATION_FEED_PUBLIC_KEY_PEM:keys.publicKey.export({type:'spki',format:'pem'}), LK_STATION_NOTIFICATION_FEED_TENANT_ID:uid(999), LK_STATION_NOTIFICATION_FEED_OWNER_NAMESPACE:NF_NAMESPACE,
};
export function signedMessage(mode,body,{ claims = {}, header = {}, nowMs = Date.now() } = {}) {
  const now = Math.floor(nowMs/1000),path = nfPath(mode),h = {alg:'RS256',typ:'phub-station-notification-feed+jwt',kid:authEnvironment.LK_STATION_NOTIFICATION_FEED_KEY_ID,...header};
  const c = {iss:authEnvironment.LK_STATION_NOTIFICATION_FEED_ISSUER,aud:authEnvironment.LK_STATION_NOTIFICATION_FEED_AUDIENCE,sub:'lk2-station-notification-importer',jti:uid(997),iat:now,nbf:now,exp:now+30,tenant_id:uid(999),owner_namespace:NF_NAMESPACE,scope:'communities.station-notifications.'+mode,method:'POST',path,body_sha256:nfBodyHash(body),correlation_id:'synthetic-feed',request_id:body.requestId,contract:NF_VERSION,...claims};
  const data=Buffer.from(smCanonical(h)).toString('base64url')+'.'+Buffer.from(smCanonical(c)).toString('base64url');
  return {req:{method:'POST',originalUrl:path,query:{},headers:{'x-station-notification-delegation':data+'.'+crypto.sign('RSA-SHA256',Buffer.from(data),keys.privateKey).toString('base64url'),'x-correlation-id':'synthetic-feed','x-padlhub-station-notification-contract':NF_VERSION}},payload:structuredClone(body)};
}
