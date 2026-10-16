/** Local-only Zero Block checkout fixture. All fetch requests are intercepted;
 * no real login, profile, purchase or confirmation endpoints are contacted.
 * Build the storefront first, then: node scripts/preview-zero-block.mjs
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const port = Number(process.env.PREVIEW_PORT || 5197);
const fixturePhone = `+${'7'}${'900000000'}`;
const token = [Buffer.from('{"alg":"none"}').toString('base64url'), Buffer.from(JSON.stringify({ phone_number: fixturePhone, exp: Math.floor(Date.now() / 1000) + 3600, sub: 'zero-fixture' })).toString('base64url'), 'fixture'].join('.');
const files = {
  '/subscription-storefront.js': new URL('../dist/subscription-storefront/subscription-storefront.js', import.meta.url),
  '/main.js': new URL('../docs/zero-block/padlhub-main-subscriptions.js', import.meta.url),
  '/bindings.js': new URL('../docs/zero-block/padlhub-zero-block.js', import.meta.url),
};
const runtimeIntegrity = 'sha384-' + createHash('sha384').update(await readFile(files['/subscription-storefront.js'])).digest('base64');
function page(main = false) {
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zero Block · локальная проверка</title>
<style>[hidden]{display:none!important}body{margin:24px;font:16px Arial}main{display:flex;flex-wrap:wrap;gap:20px}.card{padding:20px;border:1px solid #ccc;border-radius:16px;width:230px}.card a{display:block;padding:14px;background:#eee;margin-top:16px}[data-ph-hidden=true]{display:none!important}[aria-disabled=true]{opacity:.5}#log{white-space:pre-wrap;font:12px monospace;overflow-wrap:anywhere}</style>
<h1>Локальная проверка Zero Block</h1><p>Все запросы входа и оплаты заглушены.</p>
<style>:root{--text:rgb(12,34,56);--bg:rgb(245,222,123)}#external-form{color:var(--text);background:var(--bg)}</style>
<div id="external-form"><button class="auth-btn" id="external-button">Внешняя кнопка сайта</button></div>
<button id="check-isolation">Проверить изоляцию</button>
${main ? '<button id="show-subscriptions">Открыть подписки</button>' : ''}
<main ${main ? 'id="rec4807682401" hidden' : ''}>${main ? '<div class="ph-period-month"><div class="tn-atom">месяц</div></div><div class="ph-period-year"><div class="tn-atom">год</div></div><p class="ph-period-label">/ мес</p>' : ''}${(main ? ['friendship','ra','academy','energy5'] : ['friendship','friendship-year','academy','ra-promo']).map(key => `<section class="card ph-card-${key}"><h2>${key}</h2><div class="ph-price-${key}"><div class="tn-atom">—</div></div><p class="ph-status-${key}">Загрузка</p><div class="ph-buy-${key}"><a class="tn-atom" href="https://padlhub.ru/sub_hab">Оформить ${key}</a></div></section>`).join('')}</main>
<p><button id="reset">Сбросить только тестовые попытки</button> <button id="destroy">Отключить блок</button></p><pre id="log"></pre>
<script>
const query=new URLSearchParams(location.search);
window.__LK_AUTH_MODE__='viva';
const token=${JSON.stringify(token)};
localStorage.removeItem('padlhub_viva_auth_access_token_v1');
localStorage.removeItem('padlhub_viva_auth_refresh_token_v1');
localStorage.removeItem('padlhub_auth_token_v1');
localStorage.removeItem('padlhub_refresh_token_v1');
document.cookie.split(';').forEach(part=>{const name=part.split('=')[0].trim();if(/(?:AuthToken|RefreshToken)$/.test(name))document.cookie=name+'=; Max-Age=0; path=/';});
function note(text){document.getElementById('log').textContent+=text+'\\n';}
function login(){
  localStorage.setItem('padlhub_auth_token_v1',JSON.stringify({token:token,expiresAt:Date.now()+3600000}));
  localStorage.setItem('padlhub_viva_auth_access_token_v1',JSON.stringify({token:token,expiresAt:Date.now()+3600000}));
}
if(query.get('auth')==='1') login();
const reply=data=>Promise.resolve(new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}}));
window.fetch=async function(input,init={}){
  const url=String(typeof input==='string'?input:input.url||input);
  if(url.includes('subscription-storefront/release')){note('GET manifest (fixture only)');if(query.get('fail')==='module')return new Response('{}',{status:503});return reply({version:'fixture',checkoutVersion:1,checkoutIsolationVersion:1,checkoutChannel:'prod',script:{fileName:'subscription-storefront.js',integrity:${JSON.stringify(runtimeIntegrity)}}});}
  if(url.includes('summer-subscription/status')) {
    const key=new URL(url,location.href).searchParams.get('counterKey')||'friendship';
    note('GET counter '+key);
    if(query.get('fail')==='status')return new Response('{}',{status:503});
    return reply([{counterKey:key,priceMinor:({network_friendship:6800000,friendship:980000,ra:2380000,academy:2380000,energy5:1980000})[key]||980000,canPurchase:true,bindingReady:true,unlimited:false,totalLimit:10,remainingCount:3}]);
  }
  if(url.includes('/profile')){note('GET synthetic profile');return reply({id:'zero-fixture',phone:${JSON.stringify(fixturePhone)}});}
  if(url.includes('/transactions')||url.includes('summer-subscription/purchase')){
    note('POST purchase (fixture only)');
    if(query.get('fail')==='slow') await new Promise(resolve=>setTimeout(resolve,6000));
    if(query.get('fail')==='timeout') throw new Error('fixture timeout');
    return reply({});
  }
  if(url.includes('summer-subscription/confirm')){note('POST confirm existing ref (fixture only)');return reply({paid:query.get('paid')==='1',failed:false,status:query.get('paid')==='1'?'PAID':'PENDING'});}
  if(url.includes('/sms/authentication-code')){note('SMS request (fixture only)');return reply({});}
  if(url.includes('/protocol/openid-connect/token')){note('Login (fixture only)');return reply({access_token:token,refresh_token:'fixture-refresh',expires_in:3600});}
  note('Blocked other fetch: '+new URL(url,location.href).pathname);
  return reply({});
};
// Fixture-only transport fences: no telemetry, XHR or sockets reach production.
navigator.sendBeacon=()=>true;
XMLHttpRequest.prototype.send=function(){throw new Error('Fixture blocks XHR');};
window.WebSocket=class {constructor(){throw new Error('Fixture blocks WebSocket');}};
const isolationBase={fetch:window.fetch,xhr:XMLHttpRequest.prototype.send,beacon:navigator.sendBeacon,ws:window.WebSocket,error:console.error};
const external=document.getElementById('external-button');
function appearance(){const c=getComputedStyle(external);return JSON.stringify([c.color,c.backgroundColor,c.padding,c.font,c.width,getComputedStyle(document.documentElement).getPropertyValue('--text')]);}
const originalAppearance=appearance();
document.getElementById('check-isolation').onclick=()=>note('isolation='+JSON.stringify({fetch:window.fetch===isolationBase.fetch,xhr:XMLHttpRequest.prototype.send===isolationBase.xhr,beacon:navigator.sendBeacon===isolationBase.beacon,websocket:window.WebSocket===isolationBase.ws,console:console.error===isolationBase.error,styles:appearance()===originalAppearance,idleAbsent:!window.__LK_IDLE_DATA_GUARD_V1__}));
const append=document.head.appendChild.bind(document.head);
document.head.appendChild=function(element){if(element.tagName==='SCRIPT'&&element.src.includes('/lk/subscription-storefront/subscription-storefront')){note('LOAD runtime (fixture only)');isolationBase.error=console.error;element.src='/subscription-storefront.js';}return append(element);};
const show=document.getElementById('show-subscriptions');if(show)show.onclick=()=>{document.getElementById('rec4807682401').hidden=false;};
document.getElementById('reset').onclick=()=>{
  Object.keys(localStorage).filter(key=>key.startsWith('padlhub_zero_checkout_attempt_v1:')||key.startsWith('padlhub_storefront_promo_attempt_v1:')).forEach(key=>localStorage.removeItem(key));
  sessionStorage.removeItem('padlhub_zero_checkout_selection_v1');location.href=location.pathname+location.search;
};
</script>
${main ? '' : '<script src="/subscription-storefront.js"></script>'}<script src="/bindings.js"></script>
${main ? '<script src="/main.js"></script>' : ''}
<script>window.fixture=${main ? 'window.phSubscriptions' : "PadlHubZeroBlock.init({offerKeys:['friendship','friendship-year','academy','ra-promo']})"};document.getElementById('destroy').onclick=()=>note('destroy='+fixture.destroy());</script>
</html>`;
}
createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/') { response.writeHead(200, {'content-type':'text/html; charset=utf-8'}).end(page(url.searchParams.get('main') === '1')); return; }
  const file = files[url.pathname];
  if (!file) { response.writeHead(404).end(); return; }
  try { response.writeHead(200, {'content-type':'text/javascript; charset=utf-8'}).end(await readFile(file)); }
  catch { response.writeHead(404).end('Build the storefront first'); }
}).listen(port, '127.0.0.1', () => console.log(`Local fixture: http://127.0.0.1:${port}/?auth=0 (main=1, auth=1, fail=timeout|status|slow|module, paid=1)`));
