if (Object.prototype.hasOwnProperty.call(msg, '_directCheckoutRecovery')) {
  const ctx=msg._directCheckoutRecovery,configs=__DIRECT_CHECKOUT_PROOFS__;
  const fail=()=>dcrResponse(msg,404,{ok:false,code:'CHECKOUT_RECOVERY_UNAVAILABLE'},1,5);
  if(!dcrObject(ctx)||ctx.version!==1||ctx.stage!=='PREPARED'||!dcrUUID(ctx.transactionId)
    ||!Number.isSafeInteger(ctx.startedAt)||Date.now()<ctx.startedAt||Date.now()-ctx.startedAt>15000
    ||typeof ctx.token!=='string'||!ctx.token||!Array.isArray(configs))return fail();
  let match;
  for (const config of configs) {
    if(!dcrObject(config)||!dcrObject(config.proofs)||!dcrProduct(config.productId)||!dcrUUID(config.operationId)||!dcrDate(config.cutoff))return fail();
    const proof=config.proofs[dcrSha(dcrDomain(config.productId)+ctx.transactionId)];
    if(!proof)continue;
    if(match)return fail();
    match={proof,productId:config.productId,cutoff:config.cutoff,operationId:config.operationId};
  }
  if(!match)return fail();
  const {proof}=match;
  if(!dcrObject(proof)||!['ownerBinding','paymentBinding','legsBinding'].every(k=>dcrHash(proof[k]))||!dcrDate(proof.createdAt)||!dcrDate(proof.expiresAt))return fail();
  return dcrRequest(msg,{...ctx,...match},'PROFILE',
    'https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile','GET',{Authorization:'Bearer '+ctx.token,Accept:'application/json'},undefined);
}
