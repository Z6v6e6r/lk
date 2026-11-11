import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { directRecoveryPrefix, patchDirectRecoveryBody, verifyDirectTopology } from '../patch_direct_checkout_recovery.mjs';
const common=fs.readFileSync(new URL('../nodered_direct_checkout_recovery_nodes/common.js',import.meta.url),'utf8');
const tools=new Function('Buffer',common+'; return { dcrSha,dcrFacts,dcrOwner,DCR_DOMAIN,DCR_PRODUCT };')(Buffer);
const id='00000000-0000-4000-8000-000000000001',client='00000000-0000-4000-8000-000000000002',operationId='00000000-0000-4000-8000-000000000003';
const phone='+'+'7'+'9000000000';
const transaction={id,status:'UNPAID',client:{id:client,phone},products:[{id:tools.DCR_PRODUCT,type:'SUBSCRIPTION',count:1,cost:1980000,discount:0,used:false,refunded:false}],sum:1980000,discount:0,toPay:1980000,deposit:0,createDate:'2026-10-31T00:00:00Z',paymentDueDate:'2026-10-31T00:20:00Z',processingStatus:null,possibleDoublePayment:false,receiptPending:false,acquiringAuthCode:null,acquiringRrnCode:null,paymentMethod:'WIDGET',paymentLegs:[{source:'CARD',amountKopecks:1980000}],purchasedServices:[],receipts:[],executedSurcharges:[],paidByOtherSaleBookingIds:[],transactionRefunds:[],cardPaymentInfo:{paymentId:'fixture-payment-1',paymentUrl:'https://pay.vivacrm.ru/SYNTHETICcheckout000000000',status:'REJECTED',declineOutcome:'EXPIRED',declineReason:'OTHER',declineMessage:null}};
const sha=s=>crypto.createHash('sha256').update(s).digest('hex'),domain=tools.DCR_DOMAIN;
const proof={ownerBinding:sha(domain+id+'\0'+client+'\0'+tools.dcrOwner(transaction).phone),paymentBinding:sha(domain+id+'\0'+transaction.cardPaymentInfo.paymentId+'\0'+transaction.cardPaymentInfo.paymentUrl),legsBinding:sha(domain+id+'\0'+JSON.stringify({paymentMethod:transaction.paymentMethod,paymentLegs:transaction.paymentLegs,discountMinor:transaction.discount,toPayMinor:transaction.toPay})),createdAt:transaction.createDate,expiresAt:transaction.paymentDueDate};
const config={schemaVersion:1,productId:tools.DCR_PRODUCT,cutoff:'2026-11-01T12:00:00.000Z',observedAt:'2026-11-01T12:26:00.000Z',operationId,proofs:{[sha(domain+id)]:proof}};
const run=(kind,msg,settings={})=>new Function('msg','env','Buffer',directRecoveryPrefix(kind,config)+'; return "legacy";')(msg,{get:key=>settings[key]??({VIVA_SERVICE_USERNAME:'fixture-user',VIVA_SERVICE_PASSWORD:'fixture-password',VIVA_SERVICE_CLIENT_ID:'fixture-client'})[key]},Buffer);
const incoming=body=>({_msgid:'fixture',req:{headers:{authorization:'Bearer '+'u'.repeat(32)}},res:{fixture:true},payload:body});
function start(){const prepared=run('prepare',incoming({directCheckoutRecoveryVersion:1,transactionId:id}))[0];assert.deepEqual(prepared.payload,[{_id:{$in:[]}}]);assert.deepEqual(prepared.query,{_id:{$in:[]}});prepared.payload=[];return run('resolve',prepared)[0];}
function reply(request,payload,status=200){return {...request,payload,statusCode:status,responseUrl:request.url};}
function throughProfile(){const first=start();return run('router',reply(first,{id:client,phone}))[0];}
function throughToken(){return run('router',reply(throughProfile(),{access_token:'s'.repeat(32)}))[0];}
test('sandbox SHA-256 matches standard and random UTF-8 vectors at padding boundaries',()=>{
 const values=['','abc','abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq','Привет 🎾', 'a'.repeat(1000000), ...[1,55,56,63,64,65,127,128,129,4096].map(n=>'x'.repeat(n)),...Array.from({length:100},()=>crypto.randomBytes(150).toString('utf8'))];
 for(const x of values)assert.equal(tools.dcrSha(x),sha(x));
});
test('exact bounded closure uses current actor and terminal card with no writes or credential response',()=>{
 const profile=start();assert.equal(profile.method,'GET');assert.equal(profile.url,'https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile');
 const auth=throughProfile();assert.equal(auth.method,'POST');assert.equal(auth._directCheckoutRecovery.token,undefined);
 const read=throughToken();assert.equal(read.method,'GET');assert.equal(read.url,'https://api.vivacrm.ru/api/v1/transactions/'+id);
 for(const request of [profile,auth,read]){assert.equal(request.followRedirects,false);assert.equal(request.requestTimeout,4000);assert.equal(request.cookies,undefined);}
 const result=run('router',reply(read,transaction));assert.ok(result.every((v,i)=>i===2||v===null));
 const response=result[2];assert.equal(response.payload.directCheckoutClosure.closed,true);assert.equal(response.payload.directCheckoutClosure.transactionId,id);
 assert.equal(response.headers['Cache-Control'],'no-store');assert.deepEqual(Object.keys(response).sort(),['_msgid','req','res','statusCode','headers','payload'].sort());
 assert.ok(!JSON.stringify(response.payload).includes(phone));assert.equal(response._directCheckoutRecovery,undefined);assert.equal(response.url,undefined);
});
test('unsupported present version, malformed ID and missing credentials never fall into legacy',()=>{
 for(const body of [{directCheckoutRecoveryVersion:null,transactionId:id},{directCheckoutRecoveryVersion:2,transactionId:id},{directCheckoutRecoveryVersion:1,transactionId:'foreign'},{directCheckoutRecoveryVersion:1,transactionId:id,clientPhone:phone}]){const result=run('prepare',incoming(body));assert.equal(result[0],null);assert.equal(result[1].statusCode,400);assert.equal(result[2],null);}
 const noAuth=incoming({directCheckoutRecoveryVersion:1,transactionId:id});delete noAuth.req.headers.authorization;assert.equal(run('prepare',noAuth)[1].statusCode,401);
 assert.equal(run('prepare',incoming({paymentRef:'legacy'})),'legacy');assert.equal(run('resolve',{payload:[]}),'legacy');assert.equal(run('router',{payload:{}}),'legacy');
});
test('unknown reference is rejected before profile; invalid private states never reach legacy or writes',()=>{
 const x=run('prepare',incoming({directCheckoutRecoveryVersion:1,transactionId:'00000000-0000-4000-8000-000000000099'}))[0];assert.equal(run('resolve',x)[0],null);
 for(const privateState of [null,{}, {...start()._directCheckoutRecovery,stage:'UNEXPECTED'}, {...start()._directCheckoutRecovery,startedAt:Date.now()-16000}]){
  const msg={payload:{},_directCheckoutRecovery:privateState,statusCode:200};
  const a=run('router',msg);assert.ok(a.every((v,i)=>i===2||v===null));assert.notEqual(a[2].statusCode,200);
 }
});
test('redirects, changed response URL, errors and unknown HTTP outcomes do not prove closure',()=>{
 for(const change of [{statusCode:302},{statusCode:401},{statusCode:'ETIMEDOUT'},{responseUrl:'https://foreign.example'},{error:{message:'fixture'}},{payload:'malformed'}]){
  const read=throughToken(),result=run('router',{...reply(read,transaction),...change});assert.equal(result[0],null);assert.notEqual(result[2].statusCode,200);
 }
});
test('paid, refunded, changed payment/owner/product/money and fresh transactions retain their guards',()=>{
 const changes=[t=>{t.status='PAID'},t=>{t.state='PAID'},t=>{t.paymentDate='2026-11-01T00:00:00Z'},t=>{t.refundSum=1},t=>{t.paidAmountMinor=1},t=>{t.deposit=1},t=>{t.client.id='00000000-0000-4000-8000-000000000099'},t=>{t.client.phone='invalid'},t=>{t.clientId='foreign'},t=>{t.products[0].id='foreign'},t=>{t.products.push(t.products[0])},t=>{t.products[0].used=true},t=>{t.clientSubscriptionId='issued'},t=>{t.products[0].clientSubscriptionId='issued'},t=>{t.toPay=1},t=>{t.discount=1},t=>{t.cardPaymentInfo.status='NEW'},t=>{t.cardPaymentInfo.declineOutcome='DECLINED'},t=>{t.cardPaymentInfo.paymentId='changed'},t=>{t.cardPaymentInfo.paymentUrl+='changed'},t=>{t.paymentMethod='SMS'},t=>{t.paymentMethod='CASH'},t=>{t.processingStatus='PENDING'},t=>{t.receiptPending=true},t=>{t.receipts.push({})},t=>{t.paymentLegs.push({source:'CASH',amountKopecks:1})},t=>{t.paymentAttempts=[{status:'PAID'}]},t=>{t.createDate=new Date().toISOString()},t=>{t.paymentDueDate=new Date(Date.now()+60000).toISOString()}];
 for(const mutate of changes){const t=structuredClone(transaction);mutate(t);const result=run('router',reply(throughToken(),t));assert.equal(result[0],null);assert.notEqual(result[2].statusCode,200);assert.equal(result[2].payload.directCheckoutClosure,undefined);}
});
test('actor and card fingerprints bind to random transaction, tenant and product',()=>{
 assert.notEqual(proof.ownerBinding,sha(tools.dcrOwner(transaction).phone));
 const other=structuredClone(transaction);other.id='00000000-0000-4000-8000-000000000099';assert.equal(tools.dcrFacts(other,{id:client,phone:tools.dcrOwner(transaction).phone},proof,config.cutoff,Date.now()),false);
 const p=structuredClone(proof);p.ownerBinding='a'.repeat(64);assert.equal(tools.dcrFacts(transaction,tools.dcrOwner(transaction),p,config.cutoff,Date.now()),false);
});
test('source overlays preserve legacy bytes and reject source drift',()=>{
 for(const kind of ['prepare','resolve','router']){const source='return ["legacy"];',result=patchDirectRecoveryBody(kind,source,config,sha(source));assert.equal(result.slice(directRecoveryPrefix(kind,config).length),source);assert.throws(()=>patchDirectRecoveryBody(kind,source+'\n',config,sha(source)));}
});

test('live preparation rejects changed writes, debug wiring and catch custody', () => {
 const commonTab = { z: 'f9575c8726e29196' };
 const flow = [
  { id: 'f9575c8726e29196', type: 'tab', disabled: false },
  { ...commonTab, id: '80379d333be8dfca', type: 'http in', method: 'post', url: '/lk/tournaments/summer-subscription/confirm', wires: [['1da9af2cb4f7db52']] },
  { ...commonTab, id: '1da9af2cb4f7db52', wires: [['a1ca8b5eca626475'], ['10fe94a32b8adc35'], ['03cc3ac17f7e154a']] },
  { ...commonTab, id: 'a1ca8b5eca626475', type: 'mongodb4', mode: 'collection', operation: 'find', collection: 'lk_tournament_subscription_sales', wires: [['ca022fd14027a5b0']] },
  { ...commonTab, id: 'ca022fd14027a5b0', wires: [['fdc3f25f39199546'], ['10fe94a32b8adc35'], ['03cc3ac17f7e154a'], ['piter_atomic_router_20260903'], ['subscription_poll_admit_20260914']] },
  { ...commonTab, id: 'fdc3f25f39199546', type: 'http request', method: 'use', ret: 'obj', url: '', authType: '', senderr: true, persist: false, insecureHTTPParser: false, wires: [['566ae4b886c37ae5']] },
  { ...commonTab, id: '566ae4b886c37ae5', wires: [['fdc3f25f39199546'], ['57ec7b72ef16e3a3'], ['10fe94a32b8adc35'], ['03cc3ac17f7e154a'], ['piter_atomic_router_20260903']] },
 ];
 flow.push({ ...commonTab, id: '10fe94a32b8adc35', type: 'http response', wires: [] });
 assert.doesNotThrow(() => verifyDirectTopology(flow,sha('[]')));
 assert.doesNotThrow(() => verifyDirectTopology([...flow,{...commonTab,type:'catch',scope:['unrelated-node']}],sha('[]')));
 for (const mutate of [f => { f[3].operation = 'updateOne'; }, f => { f[4].wires[0] = ['debug']; }, f => { f.push({ ...commonTab, type: 'catch', scope: null }); }, f => { f[5].httpProxy = 'foreign'; }, f => { f.push({ ...commonTab, type: 'catch', scope: ['1da9af2cb4f7db52'] }); }, f => { f[7].type = 'debug'; }]) {
  const changed = structuredClone(flow); mutate(changed); assert.throws(() => verifyDirectTopology(changed,sha('[]')));
 }
});

test('expired promo invoices require their own exact frozen discount and amount', () => {
 const promo = structuredClone(transaction); promo.products[0].discount = 990000; promo.discount = 990000; promo.toPay = 990000;
 assert.equal(tools.dcrFacts(promo,tools.dcrOwner(promo),proof,config.cutoff,Date.now()),false);
 const frozen = { ...proof, legsBinding: sha(domain+id+'\0'+JSON.stringify({paymentMethod:promo.paymentMethod,paymentLegs:promo.paymentLegs,discountMinor:promo.discount,toPayMinor:promo.toPay})) };
 assert.equal(tools.dcrFacts(promo,tools.dcrOwner(promo),frozen,config.cutoff,Date.now()),true);
 promo.products[0].discount = 1000000; promo.discount = 1000000; promo.toPay = 980000;
 assert.equal(tools.dcrFacts(promo,tools.dcrOwner(promo),frozen,config.cutoff,Date.now()),false);
});
