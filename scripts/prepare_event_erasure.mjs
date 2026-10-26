import {validatePrivatePreparationPaths} from './lib/privatePreparationPaths.mjs';
/** Creates an offline erasure command; deliberately has no database/client/network dependency. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
export function prepareEventErasure(doc, {actorId, expired = false, now}) {
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== now) throw new Error('EVENT_ERASURE_TIME_INVALID');
  if (!doc || typeof doc.id !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(doc.id) ||
      !['FRIENDS','STATION','CORPORATE','LEAGUE','EVENT'].includes(doc.communityType) ||
      !Number.isSafeInteger(doc.typeSettingsRevision) || doc.typeSettingsRevision < 1 ||
      (doc.eventEntriesRevision !== undefined && (!Number.isSafeInteger(doc.eventEntriesRevision) || doc.eventEntriesRevision < 0 || doc.eventEntriesRevision >= Number.MAX_SAFE_INTEGER)) ||
      !Array.isArray(doc.eventEntries) || doc.eventEntries.length > 500) throw new Error('EVENT_ERASURE_PREIMAGE_INVALID');
  if (expired === !!actorId || (actorId && (typeof actorId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(actorId)))) throw new Error('EVENT_ERASURE_TARGET_INVALID');
  if (expired && doc.eventEntries.some(entry => !entry || typeof entry.retentionUntil !== 'string' || !Number.isFinite(Date.parse(entry.retentionUntil)) || new Date(entry.retentionUntil).toISOString() !== entry.retentionUntil)) throw new Error('EVENT_ERASURE_RETENTION_UNKNOWN');
  const selected = entry => expired ? entry.retentionUntil <= now : entry.playerId === actorId;
  const removedCount = doc.eventEntries.filter(selected).length;
  const filter = { id:doc.id, communityType:doc.communityType, typeSettingsRevision:doc.typeSettingsRevision,
    typeSettingsEffectiveAt:doc.typeSettingsEffectiveAt ?? {$exists:false},
    eventEntriesRevision:doc.eventEntriesRevision ?? {$exists:false} };
  const command = removedCount ? {filter, update:{$pull:{eventEntries:expired ? {retentionUntil:{$lte:now}} : {playerId:actorId}}, $inc:{eventEntriesRevision:1}}, options:{upsert:false}} : null;
  const receipt = {preparedAt:now, reason:expired?'retention-expired':'participant-request', operationId:crypto.randomUUID(),
    beforeCount:doc.eventEntries.length, afterCount:doc.eventEntries.length-removedCount, removedCount,
    expectedRevision:doc.eventEntriesRevision ?? 0, expectedPolicyRevision:doc.typeSettingsRevision, applied:false};
  return {command,receipt};
}
export function verifyEventErasureAck(ack) {
  if (ack?.acknowledged !== true || ack.matchedCount !== 1 || ack.modifiedCount !== 1) throw new Error('EVENT_ERASURE_CONFLICT');
  return true;
}
export const validateEventErasurePaths = validatePrivatePreparationPaths;
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args=process.argv.slice(2), value=key=>args[args.indexOf(key)+1];
  if (!args.includes('--input') || !args.includes('--out') || !args.includes('--expected-sha') || !args.includes('--now')) throw new Error('Use --input LOCAL_PRIVATE_JSON --out NEW_PRIVATE_PLAN --expected-sha SHA --now UTC_ISO (--actor ID | --expired). Offline preparation only.');
  const input=value('--input'), output=value('--out');
  validateEventErasurePaths(input,output);
  const raw=fs.readFileSync(input);
  if (crypto.createHash('sha256').update(raw).digest('hex') !== value('--expected-sha')) throw new Error('EVENT_ERASURE_SOURCE_SHA_MISMATCH');
  const plan=prepareEventErasure(JSON.parse(raw),{actorId:args.includes('--actor')?value('--actor'):undefined,expired:args.includes('--expired'),now:value('--now')});
  fs.writeFileSync(output,JSON.stringify(plan,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify(plan.receipt));
}
