if (Object.prototype.hasOwnProperty.call(msg.payload || {}, 'directCheckoutRecoveryVersion')) {
  const body=msg.payload,authorization=msg.req?.headers?.authorization;
  if(!dcrObject(body)||body.directCheckoutRecoveryVersion!==1||!dcrUUID(body.transactionId)
    ||Object.keys(body).some(k=>!['directCheckoutRecoveryVersion','transactionId'].includes(k)))
    return dcrResponse(msg,400,{ok:false,code:'INVALID_CHECKOUT_RECOVERY'},1,3);
  if(typeof authorization!=='string'||!/^Bearer [A-Za-z0-9._~-]{20,8000}$/.test(authorization))
    return dcrResponse(msg,401,{ok:false,code:'CHECKOUT_AUTH_REQUIRED'},1,3);
  return [{_msgid:msg._msgid,req:msg.req,res:msg.res,
    _directCheckoutRecovery:{version:1,stage:'PREPARED',transactionId:body.transactionId,token:authorization.slice(7),startedAt:Date.now()},
    query:{_id:{$in:[]}},payload:[{_id:{$in:[]}}]},null,null];
}
