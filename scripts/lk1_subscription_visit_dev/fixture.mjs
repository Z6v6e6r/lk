// Dedicated synthetic provider. No proxy, real identity, payment SDK or outbound I/O.
export const TOKEN = 'fixture-service';
export const USER_TOKEN = 'fixture-user';
// Synthetic E.164 value assembled like other repository fixtures for PII scans.
export const PHONE = '+7' + '0000000001';
export const ACTOR = '00000000-0000-4000-8000-000000000001';
export const TENANT = 'iSkq6G';
export const PRODUCT = 'db7a5250-7369-4f43-8ac5-9111be24bc74';
export const SUBSCRIPTIONS = ['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b'];
export const RULE = { productId: PRODUCT, maxActiveBookings: 4, freeGameMinutesPerDay: 60,
  gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 };
export function initialState() {
  const serviceDate = new Date(Date.now()+14*86400000).toISOString().slice(0,10);
  return { _id:'fixture', serviceDate, sequence:0, subscriptions:SUBSCRIPTIONS.map(subscriptionId=>({
    subscriptionId,clientId:ACTOR,productId:PRODUCT,name:'Падел.Дружба.ХАБ',product:{id:PRODUCT,name:'Падел.Дружба.ХАБ'},status:'ACTIVE',
    purchaseDate:'2026-09-01',activationDate:'2026-09-01',expirationDate:'2100-01-01',
    variant:'BY_VISITS',type:'BY_VISITS',visitsTotal:365,visitsLeft:365 })),bookings:[],transactions:[],deltas:[],refunds:[] };
}
export function exercise(state) {
  return { id:'fixture-exercise',roomId:'fixture-room',studio:{id:'fixture-studio'},
    direction:{id:4588,name:'Открытая игра'},type:{id:1613,name:'Открытая игра'},
    timeFrom:state.serviceDate+'T12:00:00+03:00',timeTo:state.serviceDate+'T13:30:00+03:00',
    availableClientSubscriptions:structuredClone(state.subscriptions) };
}
const deny = (code,status=400) => { const e=new Error(code);e.statusCode=status;throw e; };
const exact = (object,keys) => object && !Array.isArray(object) && Object.keys(object).sort().join()===keys.sort().join();
export function providerRequest(state,{method,url,headers={},body},origin) {
  const parsed=new URL(url,origin), path=parsed.pathname;
  if(!['Bearer '+TOKEN,'Bearer '+USER_TOKEN].includes(headers.authorization)) deny('FIXTURE_AUTH_REQUIRED',401);
  const admin=path.startsWith('/api/');
  if(admin && headers.authorization!=='Bearer '+TOKEN) deny('FIXTURE_SERVICE_AUTH_REQUIRED',403);
  if(method==='GET' && path==='/api/v1/studios/fixture-studio/rooms/fixture-room')return {status:200,body:{id:'fixture-room',studioId:'fixture-studio'}};
  const pricing='/end-user/api/v1/'+TENANT+'/products/master-services/fixture-master/';
  if(method==='GET' && path===pricing+'studios')return {status:200,body:[{id:'fixture-studio'}]};
  if(method==='GET' && path===pricing+'subServices' && parsed.searchParams.get('studioId')==='fixture-studio')return {status:200,body:[{id:'fixture-subservice'}]};
  if(method==='GET' && path===pricing+'price') {
    const expected={studioId:'fixture-studio',roomId:'fixture-room',subServiceIds:'fixture-subservice',fromDate:state.serviceDate,fromTime:'12:00',toTime:'13:30'};
    if(Object.entries(expected).some(([k,v])=>parsed.searchParams.get(k)!==v))deny('FIXTURE_PRICE_INPUT_INVALID');
    return {status:200,body:{value:4500}};
  }
  if(method==='GET' && path==='/healthz')return {status:200,body:{environment:'DEV',synthetic:true}};
  if(method==='GET' && path===`/end-user/api/v1/${TENANT}/profile`)return {status:200,body:{id:ACTOR,phone:'70000000001'}};
  if(method==='GET' && path.includes('/subscriptions')) {
    const one=path.match(/^\/api\/v1\/clients\/00000000-0000-4000-8000-000000000001\/subscriptions\/(00000000-0000-4000-8000-00000000000[ab])$/);
    if(one)return {status:200,body:structuredClone(state.subscriptions.find(s=>s.subscriptionId===one[1]))};
    if(path===`/end-user/api/v1/${TENANT}/subscriptions` || path===`/api/v1/clients/${ACTOR}/subscriptions`)
      return {status:200,body:{content:structuredClone(state.subscriptions),totalElements:2,last:true}};
  }
  if(method==='PUT' && path.match(/^\/api\/v1\/clients\/00000000-0000-4000-8000-000000000001\/subscriptions\/00000000-0000-4000-8000-00000000000[ab]\/limit$/)) {
    if(!exact(body,['type','value']) || body.type!=='BY_VISITS' || ![-1,1].includes(body.value))deny('FIXTURE_LIMIT_INVALID');
    const sub=state.subscriptions.find(s=>s.subscriptionId===path.split('/').at(-2));
    if(sub.visitsLeft+body.value<0)deny('FIXTURE_LIMIT_EXHAUSTED',409);
    sub.visitsTotal+=body.value;sub.visitsLeft+=body.value;state.deltas.push({subscriptionId:sub.subscriptionId,value:body.value});
    const dropReply=state.fault===(body.value===-1?'DEBIT_ACK_LOST':'RETURN_ACK_LOST');
    if(dropReply)delete state.fault;
    return {status:200,body:structuredClone(sub),dropReply};
  }
  if(method==='GET' && [ `/end-user/api/v1/${TENANT}/exercises/fixture-exercise`, '/api/v1/exercises/fixture-exercise'].includes(path))return {status:200,body:exercise(state)};
  if(method==='GET' && [`/end-user/api/v2/${TENANT}/bookings`,`/end-user/api/v2/${TENANT}/bookings/history`,'/api/v1/exercises/fixture-exercise/bookings'].includes(path)) {
    const history=path.endsWith('/history'),adminList=path.startsWith('/api/');
    const rows=state.bookings.filter(b=>adminList || (history?b.isCancelled:!b.isCancelled));
    return {status:200,body:{content:structuredClone(rows),totalElements:rows.length,totalPages:1,last:true}};
  }
  if(method==='POST' && ['/api/v1/exercises/fixture-exercise/bookings','/api/v2/exercises/fixture-exercise/bookings'].includes(path)) {
    if(!body || body.clientId!==ACTOR || body.phone!==PHONE || !Array.isArray(body.customFields) || body.customFields.length!==0 || body.paymentType!=='ON_PLACE' || body.clientSubscriptionId!==undefined || body.count!==undefined)deny('FIXTURE_PAID_BOOKING_REQUIRED');
    const booking={id:'fixture-booking-'+(++state.sequence),clientId:ACTOR,exerciseId:'fixture-exercise',
      paymentType:'ON_PLACE',isCancelled:false,exerciseDate:state.serviceDate,exercise:exercise(state)};
    state.bookings.push(booking);return {status:201,body:structuredClone(booking)};
  }
  if(method==='POST' && path==='/api/v1/products/available/by-booking') {
    if(!exact(body,['bookingIds','clientId','studioId']) || body.clientId!==ACTOR || body.studioId!=='fixture-studio' || !Array.isArray(body.bookingIds) || body.bookingIds.length!==1 || !state.bookings.some(b=>b.id===body.bookingIds[0]&&!b.isCancelled))deny('FIXTURE_CARRIER_BINDING_INVALID');
    return {status:200,body:[{id:'fixture-carrier',cost:1000000,type:'SERVICE',productType:'SERVICE'}]};
  }
  if(method==='POST' && path==='/api/v1/transactions') {
    const product=body?.products?.[0];
    if(!body || body.clientPhone!==PHONE || body.studioId!=='fixture-studio' || body.paymentMethod!=='SMS' || body.offlineTillId!==null || body.deposit!==0 || product?.customAmount!==null || !Array.isArray(body.products) || body.products.length!==1 || product?.id!=='fixture-carrier' || product.type!=='SERVICE' || product.count!==1
      || !Number.isSafeInteger(product.discount) || product.discount<0 || product.discount>1000000
      || product.bookingIds?.length!==1 || !state.bookings.some(b=>b.id===product.bookingIds[0]&&!b.isCancelled))deny('FIXTURE_TRANSACTION_INVALID');
    const id='fixture-transaction-'+(++state.sequence);
    const transaction={id,clientId:ACTOR,bookingIds:product.bookingIds,toPayMinor:1000000-product.discount,
      currency:'RUB',paymentUrl:'https://checkout.invalid/fixture-pay/'+id,paid:false,refunded:false};
    state.transactions.push(transaction);return {status:201,body:{id}};
  }
  if(method==='GET' && path.startsWith('/api/v1/transactions/')) {
    const tx=state.transactions.find(t=>t.id===path.split('/').at(-1));if(!tx)deny('FIXTURE_TRANSACTION_MISSING',404);
    return {status:200,body:structuredClone(tx)};
  }
  const cancel=path.match(new RegExp('^/end-user/api/v1/'+TENANT+'/bookings/(fixture-booking-[0-9]+)(/cancel)?$'));
  if(cancel) {
    const booking=state.bookings.find(b=>b.id===cancel[1]);if(!booking)deny('FIXTURE_BOOKING_MISSING',404);
    const tx=state.transactions.find(t=>t.bookingIds.includes(booking.id));
    if(method==='GET' && cancel[2])return {status:200,body:{cancellationOptions:{money:{available:tx?.paid===true},cancellationOnly:{available:!tx?.paid}}}};
    if(method==='DELETE' && !cancel[2]) {
      if(!exact(body||{},tx?.paid?['refundMethod']:[]) || (tx?.paid&&body.refundMethod!=='CURRENCY'))deny('FIXTURE_REFUND_INVALID');
      if(!booking.isCancelled){booking.isCancelled=true;booking.cancelledAt=new Date().toISOString();
        if(tx?.paid){tx.refunded=true;state.refunds.push({transactionId:tx.id,amountMinor:tx.toPayMinor});}}
      return {status:200,body:{ok:true}};
    }
  }
  deny('FIXTURE_ROUTE_NOT_IMPLEMENTED:'+method+' '+path,404);
}
