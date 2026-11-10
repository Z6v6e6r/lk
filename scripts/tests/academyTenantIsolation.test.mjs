import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
async function load(entry,tenant='005JDA',extra={}){
 const result=await build({entryPoints:[entry],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',define:{'import.meta.env':JSON.stringify({MODE:'dev',VITE_TENANT_KEY:tenant,VITE_ACADEMY_BACKEND_BASE:'https://academy.invalid/lk/analytics/academy-005JDA',...extra})},loader:{'.svg':'text','.png':'dataurl','.webp':'dataurl','.css':'empty'},external:['react','react/jsx-runtime','react-dom'],logLevel:'silent'});
 const m={exports:{}};new Function('require','module','exports',result.outputFiles[0].text)(require,m,m.exports);return m.exports;
}
function browser(){
 const cookies=new Map([['padlhubAuthToken','primary-access'],['padlhubRefreshToken','primary-refresh']]);
 const local=new Map([['padlhub_auth_token_v1',JSON.stringify({token:'primary-local',expiresAt:null})],['padlhub_refresh_token_v1',JSON.stringify({token:'primary-refresh-local',expiresAt:null})]]);
 const session=new Map([['padlhub_viva_oauth_pending_v1','primary-oauth'],['padlhub_subscription_snapshot_v1','primary-snapshot'],['padlhub_tournament_pending_v1:fixture','primary-payment']]);
 const storage=map=>({getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k),key:i=>[...map.keys()][i]??null,get length(){return map.size}});
 const previous={window:globalThis.window,document:globalThis.document};
 const doc={};Object.defineProperty(doc,'cookie',{get:()=>[...cookies].map(([k,v])=>k+'='+v).join('; '),set:value=>{const [pair]=value.split(';'),[k,...v]=pair.split('=');if(value.includes('expires=Thu, 01 Jan 1970'))cookies.delete(k);else cookies.set(k,v.join('='));}});
 globalThis.window={localStorage:storage(local),sessionStorage:storage(session),location:{href:'https://academy.invalid/lk/academy-preview/index.html',origin:'https://academy.invalid',pathname:'/lk/academy-preview/index.html',search:'',hash:''},setTimeout,clearTimeout};globalThis.document=doc;
 return{cookies,local,session,restore(){for(const[k,v]of Object.entries(previous))if(v===undefined)delete globalThis[k];else globalThis[k]=v;}};
}
test('005JDA read/write/logout never adopts or clears primary tenant credentials, OAuth or payment state',async()=>{
 const b=browser();try{
  const auth=await load('src/utils/vivaAuthStorage.ts');assert.equal(auth.readVivaAccessToken(),null);assert.equal(auth.readVivaRefreshToken(),null);
  auth.persistVivaAuthTokens('academy-access',300,'academy-refresh',600);assert.equal(auth.readVivaAccessToken(),'academy-access');assert.equal(b.cookies.get('padlhubAuthToken'),'primary-access');assert.equal(b.cookies.get('005JDAAuthToken'),'academy-access');
  const mode=await load('src/utils/authMode.ts');assert.equal(mode.getVivaOAuthStorageKey(),'lk_005JDA_viva_oauth_pending_v1');assert.equal(mode.hasPendingVivaOAuthState(),false);
  auth.clearVivaAuthTokens();assert.equal(auth.readVivaAccessToken(),null);assert.equal(b.cookies.get('padlhubAuthToken'),'primary-access');assert.equal(b.cookies.get('padlhubRefreshToken'),'primary-refresh');assert.ok(b.local.has('padlhub_auth_token_v1'));assert.equal(b.session.get('padlhub_subscription_snapshot_v1'),'primary-snapshot');assert.equal(b.session.get('padlhub_tournament_pending_v1:fixture'),'primary-payment');
 }finally{b.restore();}
});
test('primary tenant continues using exact canonical and legacy cookie names',async()=>{
 const b=browser();try{const auth=await load('src/utils/vivaAuthStorage.ts','iSkq6G');assert.equal(auth.readVivaAccessToken(),'primary-access');auth.persistVivaAuthTokens('primary-next',300,'primary-next-refresh',600);assert.equal(b.cookies.get('padlhubAuthToken'),'primary-next');assert.equal(b.cookies.get('iSkq6GAuthToken'),'primary-next');const mode=await load('src/utils/authMode.ts','iSkq6G');assert.equal(mode.getVivaOAuthStorageKey(),'padlhub_viva_oauth_pending_v1');}finally{b.restore();}
});
test('Rodina canonical consent documents and endpoint never fall back to PadlHub',async()=>{
 const c=await load('src/utils/authConsents.ts');assert.equal(c.AUTH_CONSENT_DOCUMENT_SET_VERSION,'2026-11-10-rodina');assert.deepEqual(c.AUTH_CONSENT_DOCUMENTS.map(d=>d.url),['https://cg178013.tw1.ru/docs/service-rules.pdf','https://cg178013.tw1.ru/docs/privacy-policy.pdf']);
 const config=await load('src/consts/tenantIntegrations.ts');assert.equal(config.academyEndpoint('communities'),'https://academy.invalid/lk/analytics/academy-005JDA/communities');assert.throws(()=>config.academyEndpoint('../communities'));
 const bad=await load('src/consts/tenantIntegrations.ts','005JDA',{VITE_ACADEMY_BACKEND_BASE:'https://padlhub.su/lk'});assert.throws(()=>bad.academyEndpoint('auth-consents'));
 const old=await load('src/utils/authConsents.ts','iSkq6G');assert.equal(old.AUTH_CONSENT_DOCUMENT_SET_VERSION,'2026-07-14');assert.equal(old.AUTH_CONSENT_DOCUMENTS[0].url,'https://padlhub.ru/docs');
});
test('academy catalog and community reads use only their configured tenant endpoints',async()=>{
 const b=browser(),previousFetch=globalThis.fetch,calls=[];
 try{
  const auth=await load('src/utils/vivaAuthStorage.ts');auth.persistVivaAuthTokens('academy-access',300,'academy-refresh',600);
  globalThis.fetch=async(url,options={})=>{calls.push({url:String(url),auth:options.headers instanceof Headers?options.headers.get('Authorization'):options.headers?.Authorization});return new Response(JSON.stringify(String(url).includes('/products/')?[]:{error:'fixture-unavailable'}),{status:String(url).includes('/products/')?200:404,headers:{'Content-Type':'application/json'}});};
  const api=await load('src/utils/apiClient.ts');const catalog=await api.apiGetSubscriptionsForSale();assert.deepEqual(catalog.data,[]);
  const row=calls.find(c=>c.url.includes('/products/'));assert.equal(row.url,'https://api.vivacrm.ru/end-user/api/v2/005JDA/products/subscriptions/list');assert.equal(row.auth,'Bearer academy-access');
  const community=await load('src/utils/communityApi.ts');await community.apiFetchCommunities({phone:'foreign-phone',clientId:'foreign-client'});
  const reads=calls.filter(c=>c.url.endsWith('/communities'));assert.equal(reads.length,1);assert.equal(reads[0].url,'https://academy.invalid/lk/analytics/academy-005JDA/communities');
  assert.equal(calls.some(c=>c.url.includes('sub_for_sale')||c.url.includes('iSkq6G')||c.url.includes('padlhub.su')),false);
 }finally{globalThis.fetch=previousFetch;b.restore();}
});
test('academy purchase creation does not retry an ambiguous provider failure',async()=>{
 const b=browser(),previousFetch=globalThis.fetch,calls=[];
 try{
  const auth=await load('src/utils/vivaAuthStorage.ts');auth.persistVivaAuthTokens('academy-access',300,'academy-refresh',600);
  globalThis.fetch=async(url,options={})=>{calls.push({url:String(url),method:options.method,body:options.body});return new Response(JSON.stringify({error:'fixture-ambiguous'}),{status:503,headers:{'Content-Type':'application/json'}});};
  const api=await load('src/utils/apiClient.ts');await api.apiBuySubscroption('fixture-product','fixture-phone');
  const creates=calls.filter(c=>c.url.endsWith('/transactions'));assert.equal(creates.length,1);assert.equal(creates[0].url,'https://api.vivacrm.ru/end-user/api/v1/005JDA/transactions');assert.equal(JSON.parse(creates[0].body).products[0].id,'fixture-product');assert.equal(JSON.parse(creates[0].body).amount,undefined);
 }finally{globalThis.fetch=previousFetch;b.restore();}
});
