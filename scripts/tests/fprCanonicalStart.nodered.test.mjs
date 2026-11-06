import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { patchFprCanonicalStart, startHash } from '../patch_fpr_canonical_start.mjs';
const fn=name=>new Function('msg',fs.readFileSync(new URL(`../nodered_fpr_start_nodes/${name}.js`,import.meta.url),'utf8'));
const prepare=fn('prepare'),authorize=fn('authorize'),resolve=fn('resolve');
const request=()=>({payload:{clientIds:['p1']},req:{headers:{authorization:'Bearer test-session'}}});
const host=()=>({id:'host',customFields:[{id:'e17a32f3-65f7-47c5-bda1-33d79932c884',value:['проводит турниры']}]});
const state=()=>({clientId:'p1',playerKey:'client:p1',ownership:'CUP_CANONICAL',ratingNumeric:4.03664,lastEventId:'event:phone:private-test-alias',phoneNorm:'PRIVATE',name:'PRIVATE'});
function authorized(profile=host(),statusCode=200){const [msg]=prepare(request());msg.payload=profile;msg.statusCode=statusCode;return authorize(msg);}
test('verified global host reads only numeric levels and opaque source versions, including manual newcomers',()=>{
  const [msg,error]=authorized();assert.equal(error,null);
  assert.equal(msg.payload[1].limit,85);assert.equal(msg.payload[1].maxTimeMS,5000);
  msg.payload=[state()];const [create,out]=resolve(msg);assert.equal(create,null);assert.equal(out.statusCode,200);
  assert.equal(out.payload.rows[0].ratingNumeric,4.03664);assert.match(out.payload.rows[0].version,/^v1-[a-f0-9]{16}$/);
  assert.equal(JSON.stringify(out.payload).includes('PRIVATE'),false);assert.equal(JSON.stringify(out.payload).includes('private-test-alias'),false);
  assert.equal(out.headers['Cache-Control'],'no-store');
});
test('hosting option ID is accepted; forged body permissions, non-host and auth errors fail closed',()=>{
  const profile=host();profile.customFields[0].value=['host-option'];profile.customFields[0].attributes={options:[{id:'host-option',name:'проводит турниры'}]};
  assert.ok(authorized(profile)[0]);
  for(const [p,status,expected] of [[{id:'owner'},200,403],[host(),401,401],[host(),403,401],[host(),500,503],[{},200,403]]){
    const [ok,error]=authorized(p,status);assert.equal(ok,null);assert.equal(error.statusCode,expected);assert.equal(error.headers.Authorization,undefined);
  }
});
test('batch rejects duplicates, malformed IDs, oversized input and missing auth',()=>{
  for(const ids of [[],['p1','p1'],[{$ne:null}],Array.from({length:29},(_,i)=>'p'+i),[' p1']]){
    const msg=request();msg.payload.clientIds=ids;assert.equal(prepare(msg)[2].statusCode,400);
  }
  const msg=request();msg.req.headers={};assert.equal(prepare(msg)[2].statusCode,401);
});
test('canonical missing/duplicate/ownership/alias conflicts and non-finite levels fail the entire batch',()=>{
  for(const states of [[],[state(),state()],[{...state(),ownership:'VIVA'}],[{...state(),ratingNumeric:NaN}],[{...state(),ratingNumeric:0}],
    [state(),{...state(),clientId:'other',playerKey:'client:other',identityAliases:{clientIds:['p1']}}]]){
    const [msg]=authorized();msg.payload=states;const [ok,out]=resolve(msg);assert.equal(ok,null);assert.equal(out.statusCode,503);assert.equal(out.payload.rows,undefined);
  }
});
test('create checks exact canonical values and source version; ordinary create bypass remains byte-for-byte',()=>{
  const generic={payload:{tournamentType:'americano'},_fprStartCreate:true};assert.equal(prepare(generic)[1],generic);
  const [read]=authorized();read.payload=[state()];const snapshot=resolve(read)[1].payload;
  const body={tournamentType:'fpr_6x25',params:{fpr6x25:{players:[{id:'p1',level:4.03664}]},fprCanonicalStart:snapshot},participants:[{id:'p1',rating:'3.037'}]};
  for(const mutate of [()=>{},b=>{b.params.fpr6x25.players[0].level=3.037;},b=>{b.params.fprCanonicalStart.rows[0].version='stale';}]){
    const input=structuredClone(body);mutate(input);const req=request();req.payload=input;req._fprStartCreate=true;
    const [m]=prepare(req);m.payload=host();m.statusCode=200;const [auth]=authorize(m);auth.payload=[state()];const [ok,out]=resolve(auth);
    if(input.params.fpr6x25.players[0].level===4.03664&&input.params.fprCanonicalStart.rows[0].version!=='stale')assert.equal(ok.payload.participants[0].rating,'4.03664');
    else assert.equal(out.statusCode,409);
  }
});
test('offline patch is exact-preimage guarded and changes only the create edge plus scoped new nodes',()=>{
  const flow=[{id:'tab',type:'tab'},{id:'route',type:'http in',z:'tab',method:'post',url:'/lk/tournaments/americano',wires:[['prepare','debug']]},
    {id:'prepare',type:'function',z:'tab',func:'// FPR_6X25_DISPATCH_V1 (prepare)\nreturn msg;',wires:[]},{id:'db',type:'mongodb4-client'},{id:'debug',type:'debug',wires:[]}];
  const bytes=Buffer.from(JSON.stringify(flow));const contract={flowSha256:startHash(bytes),createRoute:{id:'route',sha256:startHash(JSON.stringify(flow[1]))},prepare:{id:'prepare',sha256:startHash(JSON.stringify(flow[2]))},mongoClient:{id:'db',sha256:startHash(JSON.stringify(flow[3]))}};
  const result=patchFprCanonicalStart(bytes,contract),after=JSON.parse(result.output);
  assert.deepEqual(after[2],flow[2]);assert.deepEqual(after[3],flow[3]);assert.equal(result.report.changedNodes.length,1);
  assert.equal(after[1].wires[0][1],'debug');
  assert.throws(()=>patchFprCanonicalStart(Buffer.from(JSON.stringify([...flow,{id:'foreign'}])),contract),/PREIMAGE/);
  const error=fn('error')({error:{message:'sensitive'},headers:{Authorization:'secret'},_fprStart:{}});
  assert.equal(JSON.stringify(error).includes('sensitive'),false);assert.equal(error.headers.Authorization,undefined);
});
