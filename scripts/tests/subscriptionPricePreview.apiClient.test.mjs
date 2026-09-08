import assert from 'node:assert/strict';import fs from 'node:fs';import test from 'node:test';import ts from 'typescript';
const source=fs.readFileSync(new URL('../../src/utils/apiClient.ts',import.meta.url),'utf8');
const body=source.slice(source.indexOf('export async function apiFetchSubscriptionPricePreview('),source.indexOf('export async function apiFetchSubscriptioName('));
const js=ts.transpileModule(body.replace('export ',''),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
async function run(statuses,aborted=false){const calls=[];const controller=new AbortController();if(aborted)controller.abort();
 const fn=new Function('resolveLkApiBaseUrlCandidates','SERV2','SERV2_FALLBACK','rawRequest','getServ2Origin',js+';return apiFetchSubscriptionPricePreview;')(
 ()=>['https://primary.invalid','https://reserve.invalid'],'','',async(path,options)=>{calls.push({path,options});return {status:statuses.shift(),data:null,error:null};},()=> '');
 const result=await fn({targetKind:'NEW_GAME'},['fixture-sub'],controller.signal);return {calls,result};}
test('one response source: backend 4xx/5xx never falls back to another quote',async()=>{
 for(const status of [200,401,403,404,429,500,502,503]){const {calls,result}=await run([status,200]);assert.equal(calls.length,1);assert.equal(result.status,status);}
});
test('transport-unreachable primary permits only sequential fallback with same abort and auth',async()=>{
 const {calls}=await run([null,200]);assert.equal(calls.length,2);
 for(const {path,options} of calls){assert.equal(path,'/lk/subscriptions/game-price-preview');assert.equal(options.method,'POST');assert.equal(options.auth,true);
 assert.deepEqual(JSON.parse(options.body),{target:{targetKind:'NEW_GAME'},subscriptionIds:['fixture-sub']});}
 assert.equal(calls[0].options.signal,calls[1].options.signal);assert.equal((await run([null,200],true)).calls.length,0);
});
