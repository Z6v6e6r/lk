import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { scopeSubscriptionEvaluator, scopeSubscriptionUsage } from '../lib/subscriptionInstanceLimitSources.mjs';
import { composeSubscriptionPricePreviewArtifacts, composeSubscriptionJoinPricePreviewArtifacts, PATH } from '../patch_nodered_subscription_price_preview.mjs';

const fixturePath = process.env.LK_PRICE_PREVIEW_FLOW_FIXTURE;
const legacyOriginal = fixturePath ? JSON.parse(fs.readFileSync(fixturePath)) : null;
const original = legacyOriginal ? structuredClone(legacyOriginal) : null;
if (original) {
  const gateway = original.find(row=>row.id==='lk_subscription_booking_router_20260804');
  gateway.func = scopeSubscriptionUsage(gateway.func);
  const evaluator = original.find(row=>row.id==='lk_subscription_managed_policy_20260820');
  evaluator.func = scopeSubscriptionEvaluator(evaluator.func);
}
const packet = original ? composeSubscriptionPricePreviewArtifacts(Buffer.from(JSON.stringify(original)), 'preview-fixture') : null;
const nodes = packet?.candidate.filter(row => row.id.startsWith('lk_subscription_price_preview_20260908_')) || [];
const liveTest = (name, fn) => test(name, { skip: !original && 'Requires private exact canonical flow fixture; never copied into Git' }, fn);
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const actor = uuid(1), sub = uuid(2), room = uuid(3), studio = uuid(4), master = uuid(5), service = uuid(6);
const product = 'db7a5250-7369-4f43-8ac5-9111be24bc74';
const rule = {productId:product,maxActiveBookings:4,freeGameMinutesPerDay:60,gameOverageDiscountPercent:30,groupTrainingDiscountPercent:50,tournamentDiscountPercent:50};
const gameId = 'pay_' + uuid(70), exerciseId = uuid(71);
const target = {targetKind:'NEW_GAME',slotId:'slot:fixture',stationId:studio,roomId:room,masterServiceId:master,subServiceIds:[service],startsAt:'2099-09-21T07:00:00+03:00',durationMinutes:90,shareCount:4};
const subscription = (id=sub,extra={}) => ({subscriptionId:id, product:{id:product,name:'Падел.Дружба.ХАБ — годовая'},
  purchaseDate:'2026-09-05T06:40:26',activationDate:'2026-09-07T12:22:12',expirationDate:'2100-09-07',status:'ACTIVE',
  variant:'BY_VISITS',visitsLeft:100,hasStudioLimitation:false,hasTypeLimitation:true,availableTypes:[{id:1613}],hasDirectionLimitation:false,...extra});
const booking = (id=uuid(9), extra={}) => ({id,clientSubscriptionId:sub,client:{id:actor},paymentType:'SUBSCRIPTION',
  timeFrom:'2099-09-21T04:00:00+03:00',timeTo:'2099-09-21T05:00:00+03:00',exerciseId:uuid(10),exerciseDate:'2099-09-21T04:00:00+03:00',exerciseDateTo:'2099-09-21T05:00:00+03:00',
  exerciseType:{id:1613},exerciseDirection:{id:4588},...extra});
const key = (kind,...args)=>JSON.stringify([kind,'iSkq6G',...args]);
function harness(options={}) {
  const globals = {subscriptions_lk1_product_policy:rule,vivacrm_access_token:'fixture-admin',vivacrm_token_expires_at:Date.now()+60000,...options.globals};
  const subscriptions = options.subscriptions || [subscription()];
  const instances = subscriptions.map(row=>({_id:key('instance',actor,row.subscriptionId),kind:'instance',tenantKey:'iSkq6G',actorClientId:actor,subscriptionId:row.subscriptionId,productId:product}));
  const catalog = [{_id:key('product',product),kind:'product',tenantKey:'iSkq6G',productId:product,name:'Падел.Дружба.ХАБ — годовая'}];
  const calls=[];
  let msg={req:{headers:{authorization:'Bearer fixture-user'}},payload:{target:options.join ? {targetKind:'EXISTING_GAME',gameId,startsAt:target.startsAt,durationMinutes:90,...options.target} : {...target,...options.target},subscriptionIds:options.ids||subscriptions.map(row=>row.subscriptionId),...options.body}};
  const node = name=>nodes.find(row=>row.id.endsWith('_'+name));
  let current=node('entry');
  for(let i=0;i<100;i++) {
    if(current.type==='http response') return {response:structuredClone(msg),calls};
    if(current.type==='function') {
      const result = vm.compileFunction(current.func, ['msg','global','env','node'], {parsingContext:vm.createContext({})})(msg,
        {get:key=>globals[key],set(){assert.fail('No global writes allowed');}}, {get(){return undefined;}}, {warn(){assert.fail('No raw debug allowed');}});
      const outputs=Array.isArray(result)?result:[result]; const port=outputs.findIndex(Boolean);
      assert.ok(port>=0,'Every fixture request must terminate'); msg=outputs[port];
      current=nodes.find(row=>row.id===current.wires[port][0]); assert.ok(current); continue;
    }
    if(current.type==='http request') {
      assert.equal(current.method,'GET'); assert.equal(msg.method,'GET');
      const url=new URL(msg.url); assert.equal(url.origin,'https://api.vivacrm.ru');
      calls.push({kind:'GET',path:url.pathname,query:url.search});
      let payload;
      if(url.pathname.endsWith('/profile')) payload={id:actor};
      else if(url.pathname.includes('/exercises/')) payload=options.exercise || {id:exerciseId,studioId:studio,roomId:room,timeFrom:target.startsAt,timeTo:'2099-09-21T08:30:00+03:00',typeId:1613,directionId:4588,availableClientSubscriptions:subscriptions};
      else if(url.pathname.endsWith('/subscriptions')) payload={content:subscriptions,totalElements:subscriptions.length};
      else if(url.pathname.endsWith('/bookings/history')) payload=options.history||[];
      else if(url.pathname.endsWith('/bookings')) payload=options.active||[];
      else if(url.pathname.includes('/rooms/')) payload={id:room};
      else if(url.pathname.endsWith('/studios')) payload=[{id:studio}];
      else if(url.pathname.endsWith('/subServices')) payload=[{id:service}];
      else if(url.pathname.endsWith('/price')) {
        assert.equal(url.searchParams.get('fromTime'),'07:00:00');
        assert.equal(url.searchParams.get('toTime'), options.target?.durationMinutes===120?'09:00:00':options.target?.durationMinutes===60?'08:00:00':'08:30:00');
        payload={ [service]: {calculation:{fixture:{basePrice:{valueFrom:12000},impacts:[]}}} };
      } else assert.fail('Unexpected provider read');
      msg.payload=payload;msg.statusCode=200;
      if(options.mutateHttp) options.mutateHttp(msg,url);
    } else if(current.type==='mongodb4') {
      assert.equal(current.operation,'find'); calls.push({kind:'find',collection:current.collection,query:structuredClone(msg.payload)});
      if(current.collection==='lk_games') {
        assert.deepEqual(structuredClone(msg.payload),{id:gameId});
        msg.payload=options.games || [{id:gameId,booking:{studioId:studio,roomId:room,masterServiceId:master,subServiceIds:[service],date:'2099-09-21',timeFrom:'07:00',timeTo:'08:30',durationMinutes:90,vivaExerciseId:exerciseId},metadata:{splitPayment:{shareCount:4}}}];
      } else if(current.collection==='lk_subscription_daily_booking_ops') {
        assert.equal(msg.payload.actorClientId,actor); assert.equal(msg.payload['lk1.rule.productId'],product);
        msg.payload=options.operations||[];
      } else msg.payload=msg._subscriptionPricePreview.step==='catalog'?catalog:(options.instances||instances);
      if(options.mutateMongo) options.mutateMongo(msg,current);
    } else assert.fail('Write-capable or unknown node reached');
    current=nodes.find(row=>row.id===current.wires[0][0]);
  }
  assert.fail('State machine did not terminate');
}
test('preview source never calls CREATE or a product cache miss resolver',()=>{
  const router=fs.readFileSync(new URL('../nodered_subscription_price_preview_nodes/router.js',import.meta.url),'utf8');
  assert.doesNotMatch(router,/\/split\/create|\/seliger|insertOne|updateOne|global\.set/);
});
liveTest('90 minute preview uses actual state machine, exact tariff DTO and canonical evaluator',()=>{
  const {response,calls}=harness(); assert.equal(response.statusCode,200);const q=response.payload.quotes[0];
  assert.deepEqual([q.amountMinor,q.freeMinutes,q.paidMinutes],[70000,60,30]);
  assert.equal(calls.filter(c=>c.path?.endsWith('/subscriptions')).length,1);
  assert.equal(calls.filter(c=>c.path?.endsWith('/profile')).length,1);
});
liveTest('60 and120 minute preview keeps canonical free/paid allocation',()=>{
  for(const [duration,amount,paid] of [[60,0,0],[120,105000,60]]) {
    const {response}=harness({target:{durationMinutes:duration}}); assert.equal(response.statusCode,200);
    assert.deepEqual([response.payload.quotes[0].amountMinor,response.payload.quotes[0].paidMinutes],[amount,paid]);
  }
});
liveTest('daily free allowance exhausted yields paid quote; history does not inflate active count',()=>{
  const {response}=harness({history:[booking(),booking(uuid(11),{isCancelled:true})]});assert.equal(response.statusCode,200);
  assert.equal(response.payload.quotes[0].amountMinor,210000);
});
liveTest('active booking limit and zero visits cannot advertise a free place',()=>{
  const busy=harness({active:[1,2,3,4].map(n=>booking(uuid(20+n),{exerciseDate:'2099-09-22'}))}).response;
  assert.equal(busy.statusCode,200);assert.equal(busy.payload.quotes[0].status,'LIMIT_USED');
  const empty=harness({subscriptions:[subscription(sub,{visitsLeft:0})]}).response;
  assert.equal(empty.payload.quotes[0].status,'LIMIT_USED');
});
liveTest('all instances return exactly one result and legacy price remains free',()=>{
  const {response}=harness({subscriptions:[subscription(),subscription(uuid(12),{purchaseDate:'2026-08-29T10:00:00'})]});
  assert.equal(response.statusCode,200);assert.equal(response.payload.quotes.length,2);
  assert.deepEqual(response.payload.quotes.map(q=>q.amountMinor),[70000,0]);
});
liveTest('durable minutes and covered Viva booking are counted once',()=>{
  const b=booking();const op={clientSubscriptionId:sub,tenantKey:'iSkq6G',actorClientId:actor,serviceDate:'2099-09-21',state:'CONFIRMED',bookingId:b.id,
    lk1:{rule,decision:{gameMinutes:{localDate:'2099-09-21',freeMinutes:30}}}};
  const {response}=harness({history:[b],operations:[op]});assert.equal(response.statusCode,200);
  assert.deepEqual([response.payload.quotes[0].freeMinutes,response.payload.quotes[0].amountMinor],[30,140000]);
});
liveTest('policy OFF/mismatch, cache miss, foreign ownership and incomplete pages fail the whole batch',()=>{
  const variants=[{globals:{subscriptions_lk1_product_policy:null}},
    {globals:{subscriptions_lk1_product_policy:{...rule,freeGameMinutesPerDay:120}}},{instances:[]},
    {subscriptions:[subscription(sub,{clientId:uuid(88)})]},
    {mutateHttp(msg,url){if(url.pathname.endsWith('/bookings'))msg.payload={content:[],totalElements:2,last:false};}},
    {mutateHttp(msg,url){if(url.pathname.endsWith('/subscriptions'))msg.payload={content:[subscription()],totalElements:2};}},
    {mutateMongo(msg,node){if(node.collection==='lk_subscription_daily_booking_ops')msg.error={message:'fixture failure'};}}];
  for(const options of variants){const {response}=harness(options);assert.ok(response.statusCode>=400);assert.equal(response.payload.quotes,undefined);}
});
liveTest('invalid client price/actor/duplicate IDs stop before any provider call',()=>{
  for(const options of [{body:{actorClientId:uuid(99)}},{target:{basePriceMinor:0}},{ids:[sub,sub]},{ids:[]}]) {
    const {response,calls}=harness(options);assert.equal(response.statusCode,400);assert.equal(calls.length,0);
  }
});
liveTest('graph cannot reach an existing node or a business write; evaluator byte identity preserved',()=>{
  assert.equal(packet.contract.allowedChanges.length,0);
  const ids=new Set(nodes.map(n=>n.id));
  for(const n of nodes){for(const id of (n.wires||[]).flat()) assert.ok(ids.has(id));
    if(n.type==='mongodb4')assert.equal(n.operation,'find');if(n.type==='http request')assert.equal(n.method,'GET');}
  assert.equal(nodes.find(n=>n.id.endsWith('_evaluate')).func, original.find(n=>n.id==='lk_subscription_managed_policy_20260820').func);
  assert.ok(nodes.some(n=>n.type==='http in'&&n.url===PATH&&n.method==='post'));
});

liveTest('changed canonical helper or usage cannot become new public executable code',()=>{
  for(const id of ['lk_subscription_booking_router_20260804','8f7bd5b482fe9763','lk_subscription_managed_policy_20260820']) {
    const altered=structuredClone(original);altered.find(row=>row.id===id).func+='\n// drift';
    assert.throws(()=>composeSubscriptionPricePreviewArtifacts(Buffer.from(JSON.stringify(altered)),'fixture-drift'),/canonical/);
  }
});

liveTest('HAB cohort must have one valid purchase date; cutoff preserves legacy behavior',()=>{
  for(const change of [{purchaseDate:undefined},{purchaseDate:'invalid'},{purchaseDate:'2026-09-05',purchaseAt:'2026-08-31'}]) {
    const {response}=harness({subscriptions:[subscription(sub,change)]});assert.equal(response.statusCode,503);assert.equal(response.payload.quotes,undefined);
  }
  for(const [date,amount] of [['2026-08-31',0],['2026-09-01',70000]]) {
    assert.equal(harness({subscriptions:[subscription(sub,{purchaseDate:date})]}).response.payload.quotes[0].amountMinor,amount);
  }
});
liveTest('malformed persisted product ID cannot be resolved by a legacy name',()=>{
  const {response}=harness({mutateMongo(msg){if(msg._subscriptionPricePreview.step==='metadata')msg.payload[0].productId='-'.repeat(36);}});
  assert.equal(response.statusCode,503);assert.equal(response.payload.quotes,undefined);
});

liveTest('one visit remains a HAB 90/120 minute candidate while legacy cannot use two visits',()=>{
  for(const durationMinutes of [90,120]) for(const status of ['ACTIVE','NEW']) {
    const lifecycle=status==='NEW'?{status,activationDate:null,expirationDate:null}: {status};
    const current=harness({target:{durationMinutes},subscriptions:[subscription(sub,{...lifecycle,visitsLeft:1})]}).response;
    assert.equal(current.statusCode,200);
    assert.equal(current.payload.quotes[0].status,'AVAILABLE');
    assert.equal(current.payload.quotes[0].paidMinutes,durationMinutes-60);
    assert.ok(current.payload.quotes[0].amountMinor>0);
    const legacy=harness({target:{durationMinutes},subscriptions:[subscription(sub,{...lifecycle,visitsLeft:1,purchaseDate:'2026-08-29T10:00:00'})]}).response;
    assert.equal(legacy.statusCode,200);
    assert.notEqual(legacy.payload.quotes[0].status,'AVAILABLE');
    assert.equal(legacy.payload.quotes[0].amountMinor,null);
  }
});


test('tariff query runs in a Function sandbox without Node global URLSearchParams',()=>{
  const source=fs.readFileSync(new URL('../nodered_subscription_price_preview_nodes/router.js',import.meta.url),'utf8');
  const context=vm.createContext({});
  assert.equal(vm.runInContext('typeof URLSearchParams',context),'undefined');
  const run=vm.compileFunction(source,['msg','pricing'],{parsingContext:context});
  const msg={statusCode:200,payload:[{id:service}],_subscriptionPricePreview:{
    tenantKey:'fixture',auth:'Bearer fixture-user',step:'subservices',startedAt:Date.now(),target}};
  const outputs=run(msg,{extractList:value=>value});
  assert.equal(outputs[0],msg);
  const url=new URL(msg.url);
  assert.equal(msg.method,'GET');
  assert.equal(url.origin,'https://api.vivacrm.ru');
  assert.equal(url.searchParams.get('studioId'),studio);
  assert.equal(url.searchParams.get('roomId'),room);
  assert.equal(url.searchParams.get('subServiceIds'),service);
  assert.equal(url.searchParams.get('fromDate'),'2099-09-21');
  assert.equal(url.searchParams.get('fromTime'),'07:00:00');
  assert.equal(url.searchParams.get('toTime'),'08:30:00');
});

liveTest('three instances isolate active bookings and free-minute ledger in the complete preview route',()=>{
  const second=uuid(12),third=uuid(13);
  const active=[1,2,3,4].map(n=>booking(uuid(40+n),{exerciseDate:'2099-09-22'}));
  const operations=[{tenantKey:'iSkq6G',actorClientId:actor,clientSubscriptionId:sub,serviceDate:'2099-09-21',state:'CONFIRMED',lk1:{rule,decision:{gameMinutes:{localDate:'2099-09-21',freeMinutes:60}}}}];
  const {response,calls}=harness({subscriptions:[subscription(),subscription(second),subscription(third)],active,operations,target:{durationMinutes:60}});
  assert.equal(response.statusCode,200);
  const [a,b,c]=response.payload.quotes;
  assert.equal(a.reasonCode,'ACTIVE_SERVICES_LIMIT_REACHED');
  assert.equal(a.status,'LIMIT_USED');
  for(const q of [b,c]) assert.deepEqual([q.status,q.amountMinor,q.freeMinutes],['AVAILABLE',0,60]);
  assert.deepEqual([b.subscriptionId,c.subscriptionId],[second,third]);
  assert.equal(calls.filter(call=>call.collection==='lk_subscription_daily_booking_ops').length,1);
  assert.equal(calls.filter(call=>call.path?.endsWith('/bookings')).length,1);
});

liveTest('preview refuses missing or conflicting subscription membership in active and history reads',()=>{
  for(const extra of [{clientSubscriptionId:null},{subscriptionId:uuid(12)},{subscription:{id:uuid(12)}},{clientSubscription:{uuid:uuid(12)}}]) {
    for(const list of ['active','history']) {
      const {response}=harness({[list]:[booking(uuid(77),extra)]});
      assert.ok(response.statusCode>=400);
      assert.equal(response.payload.quotes,undefined);
    }
  }
});

liveTest('fresh preview install rejects the old actor-wide CREATE runtime',()=>{
  assert.throws(()=>composeSubscriptionPricePreviewArtifacts(Buffer.from(JSON.stringify(legacyOriginal)),'fixture-old-runtime'),/canonical/);
});

liveTest('selected-instance unresolved provider date/category refuses preview',()=>{
  for(const extra of [{exerciseDate:null,timeFrom:null},{exerciseType:null,exerciseDirection:null}]){
    for(const list of ['active','history']){
      const {response}=harness({[list]:[booking(uuid(78),extra)]});
      assert.ok(response.statusCode>=400);
      assert.equal(response.payload.quotes,undefined);
    }
  }
});

liveTest('existing game joins use canonical game, exercise and the same instance-scoped quote',()=>{
  const {response,calls}=harness({join:true,subscriptions:[subscription(),subscription(uuid(12),{purchaseDate:'2026-08-29T10:00:00'})]});
  assert.equal(response.statusCode,200);
  assert.deepEqual(response.payload.quotes.map(q=>q.amountMinor),[70000,0]);
  assert.equal(response.payload.quotes[0].selectionKey,JSON.stringify(['EXISTING_GAME',gameId,target.startsAt,90]));
  assert.equal(calls.filter(c=>c.collection==='lk_games').length,1);
  assert.equal(calls.filter(c=>c.path?.includes('/exercises/')).length,1);
  assert.ok(calls.every(c=>['GET','find'].includes(c.kind)));
});
liveTest('join spent allowance, active limits and last visit stay specific to the purchased instance',()=>{
  const ids=[sub,uuid(12)];
  const rows=ids.map(id=>subscription(id,{visitsLeft:1}));
  const busy=harness({join:true,subscriptions:rows,active:[1,2,3,4].map(n=>booking(uuid(20+n),{exerciseDate:'2099-09-22'}))}).response;
  assert.equal(busy.statusCode,200); assert.deepEqual(busy.payload.quotes.map(q=>q.status),['LIMIT_USED','AVAILABLE']);
  const used=harness({join:true,subscriptions:rows,history:[booking()]}).response;
  assert.equal(used.statusCode,200); assert.deepEqual(used.payload.quotes.map(q=>q.amountMinor),[210000,70000]);
});
liveTest('join rejects missing game, conflicting target and untrusted price before a quote',()=>{
  for(const options of [{games:[]},{target:{durationMinutes:60}},{target:{startsAt:'2099-09-21T07:30:00+03:00'}},
    {target:{amountMinor:0}},{target:{stationId:studio}},{games:[{id:gameId,booking:{}}]}]) {
    const {response}=harness({join:true,...options});assert.notEqual(response.statusCode,200);assert.equal(response.payload.quotes,undefined);
  }
});
liveTest('join requires current exercise subscription availability, not just owned catalog',()=>{
  const result=harness({join:true,mutateHttp(msg,url){if(url.pathname.includes('/exercises/'))msg.payload.availableClientSubscriptions=[];}}).response;
  assert.equal(result.statusCode,200);assert.equal(result.payload.quotes[0].status,'UNAVAILABLE');
  for(const change of [{id:uuid(99)},{studioId:uuid(99)},{roomId:uuid(99)},{typeId:123,directionId:123},{isCancelled:true},{availableClientSubscriptions:null}]) {
    const {response}=harness({join:true,mutateHttp(msg,url){if(url.pathname.includes('/exercises/'))Object.assign(msg.payload,change);}});
    assert.notEqual(response.statusCode,200);assert.equal(response.payload.quotes,undefined);
  }
});
liveTest('join provider or metadata failures have no price and no write-capable path',()=>{
  for(const options of [{instances:[]},{mutateHttp(msg,url){if(url.pathname.includes('/exercises/'))msg.statusCode=503;}},
    {mutateMongo(msg,node){if(node.collection==='lk_games')msg.error={message:'fixture-read-error'};}}]) {
    const {response,calls}=harness({join:true,...options});assert.notEqual(response.statusCode,200);assert.equal(response.payload.quotes,undefined);
    assert.ok(calls.every(c=>['GET','find'].includes(c.kind)));
  }
});

liveTest('join canonical game corruption never produces a price',()=>{
  for (const change of [game=>game.status='CANCELLED',game=>game.metadata.splitPayment.enabled=false,
    game=>game.booking.timeTo='09:00',game=>game.booking.durationMinutes=60,
    game=>game.booking.exerciseId=uuid(99),game=>game.booking.masterServiceId=null]) {
    const {response}=harness({join:true,mutateMongo(msg,node){if(node.collection==='lk_games')change(msg.payload[0]);}});
    assert.notEqual(response.statusCode,200);assert.equal(response.payload.quotes,undefined);
  }
  const duplicate=harness({join:true,mutateMongo(msg,node){if(node.collection==='lk_games')msg.payload.push({...msg.payload[0]});}}).response;
  assert.notEqual(duplicate.statusCode,200);
});
liveTest('join server pricing preserves singles share and known unavailable rows',()=>{
  const singles=harness({join:true,mutateMongo(msg,node){if(node.collection==='lk_games')msg.payload[0].metadata.splitPayment.shareCount=2;}}).response;
  assert.equal(singles.statusCode,200); assert.equal(singles.payload.quotes[0].amountMinor,140000);
  for (const [extra,status] of [[{visitsLeft:0},'LIMIT_USED'],[{visitsLeft:1,purchaseDate:'2026-08-29T10:00:00'},'UNAVAILABLE'],
    [{expirationDate:'2026-09-07'},'UNAVAILABLE'],[{isFrozen:true},'UNAVAILABLE']]) {
    const result=harness({join:true,subscriptions:[subscription(sub,extra)]}).response;
    assert.equal(result.statusCode,200);assert.equal(result.payload.quotes[0].status,status);
  }
});

const installedFixture = process.env.LK_JOIN_PREVIEW_INSTALLED_FLOW_FIXTURE;
test('existing preview upgrade preserves every unrelated node and fails on source drift', {skip:!installedFixture && 'Requires private installed preview fixture'},()=>{
  const bytes=fs.readFileSync(installedFixture), before=JSON.parse(bytes);
  const packet=composeSubscriptionJoinPricePreviewArtifacts(bytes,'join-upgrade-test');
  const changed=['lk_subscription_price_preview_20260908_entry','lk_subscription_price_preview_20260908_router','lk_subscription_price_preview_20260908_catch'];
  for(const row of before) if(!changed.includes(row.id)) assert.deepEqual(packet.candidate.find(n=>n.id===row.id),row);
  assert.equal(packet.candidate.length,before.length+1);
  const added=packet.candidate.at(-1);assert.equal(added.collection,'lk_games');assert.equal(added.operation,'find');
  before.find(n=>n.id===changed[0]).func+='\n// drift';
  assert.throws(()=>composeSubscriptionJoinPricePreviewArtifacts(Buffer.from(JSON.stringify(before)),'join-upgrade-test'),/preimage drift/);
});
liveTest('join 60 and 120 minute calculations retain canonical minute allocation',()=>{
  for(const [duration,end,amount,free,paid] of [[60,'08:00',0,60,0],[120,'09:00',105000,60,60]]) {
    const result=harness({join:true,target:{durationMinutes:duration},mutateMongo(msg,node){if(node.collection==='lk_games')Object.assign(msg.payload[0].booking,{timeTo:end,durationMinutes:duration});},
      mutateHttp(msg,url){if(url.pathname.includes('/exercises/'))msg.payload.timeTo=`2099-09-21T${end}:00+03:00`;}}).response;
    assert.equal(result.statusCode,200);assert.deepEqual([result.payload.quotes[0].amountMinor,result.payload.quotes[0].freeMinutes,result.payload.quotes[0].paidMinutes],[amount,free,paid]);
  }
});
