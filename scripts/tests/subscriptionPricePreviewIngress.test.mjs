import assert from 'node:assert/strict';import fs from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';import test from 'node:test';
import {buildSubscriptionPricePreviewNginxCandidate,previewLocation,previewGuard} from '../nginx/prepare_subscription_price_preview.mjs';
import {sha256} from '../nginx/patch_subscription_booking_proxy.mjs';
const primaryMap='map $remote_addr $lk_subscription_product_limit_key { default $binary_remote_addr; 192.0.2.100 ""; }';
const image='nginx@sha256:2e26275ed7a47e8e93f264d39a09ca4bc3f4058c904c75087e237f4ea883f2a1';
const docker=args=>execFileSync('docker',args,{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']}).trim();
test('exact preview ingress preserves existing routes, requires SHA and reserve verified TLS',()=>{
  const source='server {\n    location = /lk/subscriptions/product { return 401; }\n    location ^~ /lk/ {\n        alias /var/www/html/lk/;\n    }\n}\n';
  for(const host of ['primary','reserve']) {
    const built=buildSubscriptionPricePreviewNginxCandidate(source,sha256(source),host);
    assert.ok(built.candidate.includes('location = /lk/subscriptions/product { return 401; }'));
    assert.equal(buildSubscriptionPricePreviewNginxCandidate(built.candidate,built.candidateSha,host).changed,false);
    assert.throws(()=>buildSubscriptionPricePreviewNginxCandidate(source,'wrong',host));
    assert.match(previewLocation(host),/client_max_body_size 16k/);
    assert.match(previewLocation(host),/zone=lk_subscription_price_preview_by_ip burst=2 nodelay/);
    assert.match(previewGuard(host),/zone=lk_subscription_price_preview_by_ip:1m rate=60r\/m/);
    assert.doesNotMatch(previewGuard(host),/zone=lk_subscription_product_by_ip/);
  }
  assert.match(previewGuard('primary'),/\$lk_subscription_product_limit_key/);
  assert.match(previewGuard('reserve'),/\$binary_remote_addr/);
  assert.match(previewLocation('reserve'),/proxy_ssl_verify on/);assert.match(previewLocation('reserve'),/proxy_ssl_session_reuse off/);
});
test('real isolated nginx rejects burst/body overflow, preserves CORS, and lets OPTIONS bypass rate limit',
 {skip:process.env.LK_PRICE_PREVIEW_NGINX_TEST!=='1'&&'Opt-in isolated Docker runtime fixture',timeout:60000},async t=>{
  const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'price-preview-nginx-')));let id;
  t.after(()=>{if(id)spawnSync('docker',['rm','-f',id],{stdio:'ignore',timeout:10000});fs.rmSync(root,{recursive:true,force:true});});
  const guard=fs.readFileSync(new URL('../nginx/lk-subscription-product-guard.conf',import.meta.url),'utf8');
  fs.writeFileSync(join(root,'nginx.conf'),`pid /tmp/nginx.pid; error_log stderr warn; events {} http { access_log off; ${guard} ${primaryMap} ${previewGuard('primary')}
    server {listen 1880; location / {return 200 'fixture';}} server {listen 18080; ${previewLocation('primary')} } }`);
  id=docker(['run','-d','--network','none','--read-only','--tmpfs','/tmp','--tmpfs','/var/cache/nginx','--platform','linux/amd64',
    '-v',`${root}:/fixture:ro`,'--entrypoint','nginx',image,'-p','/tmp/','-c','/fixture/nginx.conf','-g','daemon off;']);
  const request=(method='POST',body='{}')=>docker(['exec',id,'curl','-sS','-i','-X',method,'-H','Content-Type: application/json','--data-binary',body,'http://127.0.0.1:18080/lk/subscriptions/game-price-preview']);
  let ready=false;for(let n=0;n<20&&!ready;n++){try{ready=request('OPTIONS').includes('204');}catch{/* The owned fixture may still be starting; retry within the bounded readiness loop. */}if(!ready)await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
  const burst=Array.from({length:8},()=>request());assert.ok(burst.some(r=>r.includes('200 OK')));assert.ok(burst.some(r=>r.includes('429')));
  const preflight=request('OPTIONS');assert.match(preflight,/204/);assert.match(preflight,/Access-Control-Allow-Methods: POST, OPTIONS/i);
  assert.match(request('GET'),/405/);assert.match(request('POST','x'.repeat(17000)),/413/);
});

test('catalog traffic cannot consume preview quota, while preview keeps its own burst limit',
 {skip:process.env.LK_PRICE_PREVIEW_NGINX_TEST!=='1'&&'Opt-in isolated Docker runtime fixture',timeout:60000},async t=>{
  const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'price-preview-isolation-')));let id;
  t.after(()=>{if(id)spawnSync('docker',['rm','-f',id],{stdio:'ignore',timeout:10000});fs.rmSync(root,{recursive:true,force:true});});
  const productGuard=fs.readFileSync(new URL('../nginx/lk-subscription-product-guard.conf',import.meta.url),'utf8');
  const productLocation=fs.readFileSync(new URL('../nginx/lk-subscription-product-location.conf',import.meta.url),'utf8');
  fs.writeFileSync(join(root,'nginx.conf'),`pid /tmp/nginx.pid; error_log stderr warn; events {} http { access_log off; ${productGuard} ${primaryMap} ${previewGuard('primary')}
    server {listen 1880; location / {return 200 'fixture';}} server {listen 18080; ${productLocation} ${previewLocation('primary')} } }`);
  id=docker(['run','-d','--network','none','--read-only','--tmpfs','/tmp','--tmpfs','/var/cache/nginx','--platform','linux/amd64',
    '-v',`${root}:/fixture:ro`,'--entrypoint','nginx',image,'-p','/tmp/','-c','/fixture/nginx.conf','-g','daemon off;']);
  const request=(route,method='GET')=>docker(['exec',id,'curl','-sS','-o','/dev/null','-w','%{http_code}','-X',method,'http://127.0.0.1:18080/lk/subscriptions/'+route]);
  let ready=false;for(let n=0;n<20&&!ready;n++){try{ready=request('game-price-preview','OPTIONS')==='204';}catch{/* Fixture startup can precede its listener. */}if(!ready)await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
  // These lookups are performed while loading several subscriptions, before price preview.
  const catalog=Array.from({length:8},()=>request('product'));
  assert.ok(catalog.every(status=>status==='200'),'Existing catalog burst must remain allowed');
  assert.equal(request('game-price-preview','POST'),'200','Catalog lookups must not starve the first preview');
  const burst=Array.from({length:8},()=>request('game-price-preview','POST'));
  assert.ok(burst.includes('429'),'Preview still rejects its own excessive burst');
  assert.equal(request('game-price-preview','OPTIONS'),'204');
});
