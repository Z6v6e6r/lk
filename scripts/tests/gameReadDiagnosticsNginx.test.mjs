import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { prepareGameReadDiagnostics, sha256, HTTP_FRAGMENT } from '../nginx/prepare_game_read_diagnostics.mjs';
const source = `server {
    listen 127.0.0.1:PORT;
    location ^~ /lk/games/ {
    proxy_pass http://127.0.0.1:UPSTREAM;
    proxy_set_header Host $host;
    proxy_set_header X-Existing existing-header;
    access_log /var/log/nginx/access.log;
    access_log SUPPORT combined;
    add_header Access-Control-Allow-Origin "https://page.invalid" always;
    add_header Access-Control-Allow-Methods "GET, POST, PATCH, OPTIONS" always;
    add_header Access-Control-Allow-Headers "Content-Type, Authorization, X-Correlation-ID" always;
    add_header X-Existing-Security existing-security always;
    if ($request_method = OPTIONS) { return 204; }
    }
}
`;
test('candidate preserves existing upstream, log and header directives and rejects drift/ambiguous inheritance',()=>{
 const r=prepareGameReadDiagnostics(source,sha256(source));assert.ok(r.changed);
 assert.equal(prepareGameReadDiagnostics(r.candidate,r.candidateSha256).candidate,r.candidate);
 const fragment=r.candidate.match(/# lk-game-read-diagnostics-v1\n(?:[^\n]+\n){3}/)[0];
 const moved=r.candidate.replace(fragment,'')+`\nserver { location /other {\n${fragment}} }\n`;
 assert.throws(()=>prepareGameReadDiagnostics(moved,sha256(moved)),/DIAGNOSTIC_CONFLICT/);
 const partial=r.candidate.replace('    proxy_set_header X-LK-Client-Build "";\n','');
 assert.throws(()=>prepareGameReadDiagnostics(partial,sha256(partial)),/DIAGNOSTIC_CONFLICT/);
 assert.match(r.candidate,/X-Correlation-ID, X-LK-Client-Request-ID, X-LK-Client-Build/);
 for(const old of ['proxy_pass http://127.0.0.1:UPSTREAM;','proxy_set_header X-Existing existing-header;','access_log SUPPORT combined;','add_header X-Existing-Security existing-security always;'])assert.ok(r.candidate.includes(old));
 assert.throws(()=>prepareGameReadDiagnostics(source,'wrong'),/HASH_MISMATCH/);
 for(const bad of [source.replace('access_log /var/log/nginx/access.log;',''),source.replace('proxy_set_header Host $host;',''),source.replace('proxy_set_header Host $host;','include PRIVATE;'),source+source,source.replace('location ^~ /lk/games/ {','location ^~ /lk/games/ { location /nested { return 200; }')])assert.throws(()=>prepareGameReadDiagnostics(bad,sha256(bad)));
});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
function request(p,url,headers={},method='GET') {return new Promise((resolve,reject)=>{const r=http.request({host:'127.0.0.1',port:p,path:url,method,headers},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));});r.on('error',reject);r.end();});}

test('real isolated Nginx: 499 correlation, timings, CORS, header stripping, 304 and PII-free dedicated log', {skip:!process.env.LK_TEST_NGINX}, async t=>{
 const binary=process.env.LK_TEST_NGINX;
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lk-499-nginx-test-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const calls=[];let slowArrived;
 const slowSeen=new Promise(r=>{slowArrived=r;});
 const upstream=http.createServer((req,res)=>{
  calls.push({url:req.url,headers:req.headers,method:req.method});
  if(req.url.includes('/slow')){slowArrived();setTimeout(()=>{if(!res.destroyed)res.end('ok');},150);return;}
  res.setHeader('ETag','"fixture"');
  if(req.headers['if-none-match']==='"fixture"'){res.statusCode=304;res.end();return;}
  if(req.url.includes('/missing'))res.statusCode=404;
  res.end('{}');
 });
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');t.after(()=>new Promise(r=>upstream.close(r)));
 const p=await port(),up=upstream.address().port;
 const candidate=prepareGameReadDiagnostics(source,sha256(source)).candidate.replace('PORT',String(p)).replace('UPSTREAM',String(up))
  .replace('/var/log/nginx/access.log',`${dir}/canonical.log`).replace('SUPPORT',`${dir}/support.log`).replace('/var/log/nginx/lk-game-read-diagnostics.jsonl',`${dir}/diagnostics.jsonl`);
 const conf=`daemon off; master_process off; pid ${dir}/nginx.pid; error_log ${dir}/error.log notice; events { worker_connections 64; } http { ${HTTP_FRAGMENT}\n${candidate}\n}`;
 fs.writeFileSync(`${dir}/nginx.conf`,conf);fs.mkdirSync(`${dir}/logs`);
 const checked=spawnSync(binary,['-t','-p',dir+'/', '-c',`${dir}/nginx.conf`],{encoding:'utf8'});assert.equal(checked.status,0,checked.stderr);
 const child=spawn(binary,['-p',dir+'/', '-c',`${dir}/nginx.conf`],{stdio:'ignore'});t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}});
 let ready=false;for(let i=0;i<50;i++){try{await request(p,'/lk/games/available');ready=true;break;}catch{await pause(10);}}assert.ok(ready);
 const id='11111111-1111-4111-8111-111111111111',build='a'.repeat(40),headers={'X-LK-Client-Request-ID':id,'X-LK-Client-Build':build,Authorization:'PRIVATE-AUTH',Referer:'https://page.invalid/?PRIVATE-REF','User-Agent':'PRIVATE-UA'};
 const ok=await request(p,'/lk/games/PRIVATE-GAME?phone=PRIVATE-PHONE',headers);assert.equal(ok.status,200);assert.equal(ok.headers['etag'],'"fixture"');
 assert.equal(ok.headers['x-existing-security'],'existing-security');assert.equal(ok.headers['access-control-allow-origin'],'https://page.invalid');
 const cached=await request(p,'/lk/games/fixture/result/state',{...headers,'If-None-Match':'"fixture"'});assert.equal(cached.status,304);
 const missing=await request(p,'/lk/games/missing',headers);assert.equal(missing.status,404);
 const before=calls.length;const opt=await request(p,'/lk/games/fixture',{Origin:'https://page.invalid','Access-Control-Request-Headers':'x-lk-client-request-id,x-lk-client-build'},'OPTIONS');
 assert.equal(opt.status,204);assert.equal(calls.length,before);assert.match(opt.headers['access-control-allow-headers'],/X-LK-Client-Request-ID, X-LK-Client-Build/);
 await request(p,'/lk/games/fixture',{'X-LK-Client-Request-ID':`${id}, ${id}`,'X-LK-Client-Build':'PRIVATE-BUILD'});
 await request(p,'/lk/games/fixture',{'X-LK-Client-Request-ID':'PRIVATE-ID','X-LK-Client-Build':build});
 await request(p,'/lk/games/fixture',{'X-LK-Client-Request-ID':[id,id],'X-LK-Client-Build':build});
 await request(p,'/lk/games/available',headers);await request(p,'/lk/games/fixture',headers,'POST');
 const abort=http.request({host:'127.0.0.1',port:p,path:'/lk/games/slow/result/state',headers});abort.on('error',()=>{});abort.end();await slowSeen;abort.destroy();
 for(let i=0;i<50;i++){if(fs.existsSync(`${dir}/diagnostics.jsonl`)&&fs.readFileSync(`${dir}/diagnostics.jsonl`,'utf8').includes('"httpStatus":499'))break;await pause(10);}
 const raw=fs.readFileSync(`${dir}/diagnostics.jsonl`,'utf8');const logs=raw.trim().split('\n').map(JSON.parse);
 assert.equal(logs.length,7);assert.equal(logs.filter(r=>r.httpStatus===499).length,1);
 const closed=logs.find(r=>r.httpStatus===499);assert.equal(closed.clientRequestId,id);assert.equal(closed.callerBuild,build);assert.equal(closed.bodyBytes,0);
 for(const key of ['requestTimeSeconds','upstreamConnectTimeSeconds','upstreamHeaderTimeSeconds','upstreamResponseTimeSeconds'])assert.ok(key in closed);
 assert.ok(logs.some(r=>r.httpStatus===304));assert.ok(logs.some(r=>r.httpStatus===404));
 const successful=logs.find(r=>r.httpStatus===200);
 for(const key of ['requestTimeSeconds','upstreamConnectTimeSeconds','upstreamHeaderTimeSeconds','upstreamResponseTimeSeconds'])assert.match(successful[key],/^[0-9]+\.[0-9]+$/);
 assert.equal(successful.upstreamStatus,'200');assert.equal(successful.requestCompletion,'OK');assert.equal(closed.requestCompletion,'');
 assert.equal(logs.filter(r=>r.clientRequestId==='UNKNOWN').length,3);assert.ok(logs.some(r=>r.callerBuild==='UNKNOWN'));
 assert.ok(logs.every(r=>/^[0-9a-f]{32}$/.test(r.edgeRequestId)&&r.method==='GET'));
 assert.ok(logs.every(r=>['/lk/games/:gameId','/lk/games/:gameId/result/state'].includes(r.routeTemplate)));
 assert.ok(!raw.includes('PRIVATE'));assert.ok(!raw.includes('127.0.0.1'));assert.ok(!raw.includes('page.invalid'));
 assert.ok(calls.every(r=>!r.headers['x-lk-client-request-id']&&!r.headers['x-lk-client-build']));
 assert.ok(calls.every(r=>r.headers['x-existing']==='existing-header'));assert.equal(calls[1].headers.authorization,'PRIVATE-AUTH');
 assert.ok(fs.readFileSync(`${dir}/canonical.log`,'utf8').includes('PRIVATE-GAME'));assert.ok(fs.readFileSync(`${dir}/support.log`,'utf8').includes('PRIVATE-GAME'));
});
