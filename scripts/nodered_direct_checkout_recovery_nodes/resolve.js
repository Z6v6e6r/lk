if (Object.prototype.hasOwnProperty.call(msg, '_directCheckoutRecovery')) {
  const ctx=msg._directCheckoutRecovery,configs=__DIRECT_CHECKOUT_PROOFS__;
  const fail=()=>dcrResponse(msg,404,{ok:false,code:'CHECKOUT_RECOVERY_UNAVAILABLE'},1,5);
  if(!dcrObject(ctx)||(ctx.version!==1 && !(DCR_LIVE_RA_ENABLED && ctx.version===2))||ctx.stage!=='PREPARED'||!dcrUUID(ctx.transactionId)
    ||!Number.isSafeInteger(ctx.startedAt)||Date.now()<ctx.startedAt||Date.now()-ctx.startedAt>15000
    ||typeof ctx.token!=='string'||!ctx.token||!Array.isArray(configs))return fail();
  if(ctx.version===2) {
    // Limit the new profile -> service token -> exact transaction fan-out at
    // admission. Node context is shared by the function for this process.
    const now=Date.now(), second=Math.floor(now/1000);
    try {
      const bucket=context.get('liveRaReadBudget') || {second,count:0};
      const count=bucket.second===second?bucket.count:0;
      if(count>=6)return dcrResponse(msg,429,{ok:false,code:'CHECKOUT_RECOVERY_BUSY'},1,5);
      context.set('liveRaReadBudget',{second,count:count+1});
    } catch {
      return dcrResponse(msg,503,{ok:false,code:'CHECKOUT_RECOVERY_UNAVAILABLE'},1,5);
    }
    return dcrRequest(msg,{...ctx,productId:DCR_RA_PRODUCT},'PROFILE',
      'https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile','GET',{Authorization:'Bearer '+ctx.token,Accept:'application/json'},undefined);
  }
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
