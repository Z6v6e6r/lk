import {isDeepStrictEqual} from 'node:util';
import {buildMaxOutboxOnlyResume,sha256} from './nodered_max_outbox_resume.mjs';
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'
  ?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;

// Only the exact inverse of the reviewed forward builder. The original comes
// from its protected pre-deployment backup, never from the current Git snapshot.
export function buildMaxOutboxOnlyInverse(current,original,trustedPins){
  const before=buildMaxOutboxOnlyResume(original,trustedPins);
  const source=Buffer.isBuffer(current)||typeof current==='string'?current:JSON.stringify(current);
  const flow=JSON.parse(source.toString());
  if(!isDeepStrictEqual(canonical(flow),canonical(before.flow)))throw Error('MAXO_INVERSE_SOURCE_DRIFT');
  const restored=JSON.parse(original.toString());
  const candidateJson=JSON.stringify(restored,null,2)+'\n';
  return {flow:restored,candidateJson,changedIds:before.changedIds,removedIds:before.addedIds,
    originalSourceSha256:sha256(original),sourceSha256:sha256(source),candidateSha256:sha256(candidateJson)};
}
export function inverseContract(current,original,trustedPins){
  const built=buildMaxOutboxOnlyInverse(current,original,trustedPins);
  return {kind:'max-outbox-exact-inverse-v1',sourceSha256:built.sourceSha256,
    originalSourceSha256:built.originalSourceSha256,candidateSha256:built.candidateSha256,
    changedIds:built.changedIds,removedIds:built.removedIds};
}
