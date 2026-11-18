if (Object.prototype.hasOwnProperty.call(msg, '_directCheckoutRecovery')) {
  const ctx=msg._directCheckoutRecovery,config=__DIRECT_CHECKOUT_PROOFS__;
  const fail=()=>dcrResponse(msg,404,{ok:false,code:'CHECKOUT_RECOVERY_UNAVAILABLE'},1,5);
  if(!dcrObject(ctx)||ctx.version!==1||ctx.stage!=='PREPARED'||!dcrUUID(ctx.transactionId)
    ||!Number.isSafeInteger(ctx.startedAt)||Date.now()<ctx.startedAt||Date.now()-ctx.startedAt>15000
    ||typeof ctx.token!=='string'||!ctx.token||!dcrObject(config.proofs)||config.productId!==DCR_PRODUCT||!dcrUUID(config.operationId)||!dcrDate(config.cutoff))return fail();
  const proof=config.proofs[dcrSha(DCR_DOMAIN+ctx.transactionId)];
  if(!dcrObject(proof)||!['ownerBinding','paymentBinding','legsBinding'].every(k=>dcrHash(proof[k]))||!dcrDate(proof.createdAt)||!dcrDate(proof.expiresAt))return fail();
  return dcrRequest(msg,{...ctx,proof,cutoff:config.cutoff,operationId:config.operationId},'PROFILE',
    'https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile','GET',{Authorization:'Bearer '+ctx.token,Accept:'application/json'},undefined);
}
