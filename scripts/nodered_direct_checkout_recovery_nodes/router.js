if (Object.prototype.hasOwnProperty.call(msg, '_directCheckoutRecovery')) {
  const ctx=msg._directCheckoutRecovery;
  const respond=(status,payload)=>dcrResponse(msg,status,payload,2,5);
  const unavailable=()=>respond(409,{ok:false,code:'CHECKOUT_RECOVERY_UNAVAILABLE'});
  if(!dcrObject(ctx)||ctx.version!==1||!dcrUUID(ctx.transactionId)||!Number.isSafeInteger(ctx.startedAt)
    ||Date.now()<ctx.startedAt||Date.now()-ctx.startedAt>15000||msg.error||Number(msg.statusCode)!==200
    ||msg.responseUrl!==ctx.expectedUrl||!dcrObject(msg.payload))return unavailable();
  const data=msg.payload;
  if(ctx.stage==='PROFILE') {
    const id=dcrExact([data.id,data.clientId]),phone=dcrPhone(data.phone);
    if(!dcrUUID(id)||!phone)return respond(401,{ok:false,code:'CHECKOUT_AUTH_REQUIRED'});
    const username=env.get('VIVA_SERVICE_USERNAME'),password=env.get('VIVA_SERVICE_PASSWORD'),clientId=env.get('VIVA_SERVICE_CLIENT_ID')||'React-auth-dev';
    const tokenUrl=env.get('VIVA_SERVICE_TOKEN_URL')||'https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token';
    if(typeof username!=='string'||!username||typeof password!=='string'||!password||typeof clientId!=='string'||tokenUrl!=='https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token')return unavailable();
    const {token,...next}=ctx;
    return dcrRequest(msg,{...next,actor:{id,phone}},'SERVICE_TOKEN',tokenUrl,'POST',{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},
      'grant_type=password&client_id='+encodeURIComponent(clientId)+'&username='+encodeURIComponent(username)+'&password='+encodeURIComponent(password));
  }
  if(ctx.stage==='SERVICE_TOKEN') {
    const token=data.access_token;
    if(typeof token!=='string'||!/^[A-Za-z0-9._~-]{20,8000}$/.test(token))return unavailable();
    return dcrRequest(msg,ctx,'TRANSACTION','https://api.vivacrm.ru/api/v1/transactions/'+ctx.transactionId,'GET',
      {Authorization:'Bearer '+token,Accept:'application/json'},undefined);
  }
  if(ctx.stage==='TRANSACTION') {
    const t=dcrObject(data.data)?data.data:data;
    if(t.id!==ctx.transactionId||!dcrFacts(t,ctx.actor,ctx.proof,ctx.cutoff,Date.now()))return unavailable();
    return respond(200,{ok:true,directCheckoutClosure:{version:1,productId:DCR_PRODUCT,transactionId:ctx.transactionId,
      state:'PROVIDER_CARD_EXPIRED_UNPAID',operationId:ctx.operationId,paid:false,closed:true,verifiedAt:new Date().toISOString()}});
  }
  return unavailable();
}
