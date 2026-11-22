import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { createControl, flowHash, requestStatus, ready } = require('../nodered_reviewed_flow_deploy/lifecycle.cjs');
const { startGateway } = require('../nodered_reviewed_flow_deploy/gateway.cjs');
const runtime = process.env.RELEASE_LIFECYCLE_NODERED_RUNTIME;
const nginxImage=process.env.RELEASE_LIFECYCLE_NGINX_IMAGE || 'nginx@sha256:2e26275ed7a47e8e93f264d39a09ca4bc3f4058c904c75087e237f4ea883f2a1';
const hash = b => createHash('sha256').update(b).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(fn, timeout = 15000) { const end = Date.now() + timeout; let last; do { try { const value = await fn(); if (value) return value; } catch(e) { last = e; } await delay(50); } while(Date.now() < end); throw last || Error('fixture deadline'); }
function get(port, route = '/fixture') { return new Promise((resolve, reject) => { const req = http.get({ host: '127.0.0.1', port, path: route, agent: false, timeout: 1000 }, res => { let body = ''; res.on('data', c => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers })); }); req.on('error', reject); req.on('timeout', () => req.destroy(Error('fixture timeout'))); }); }
async function freePort() { const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }

test('real Node-RED4.0.9 + persistent proxy + nginx: slow body, forced stop, cold readiness, JSON errors and no retry', { skip: !runtime, timeout: 90000 }, async t => {
  assert.ok(fs.existsSync(runtime), 'configured physical runtime must exist');
  try { execFileSync('docker',['image','inspect',nginxImage],{stdio:'ignore',timeout:5000}); }
  catch { execFileSync('docker',['pull',nginxImage],{stdio:'pipe',timeout:60000}); }
  const base = fs.mkdtempSync('/tmp/rr-'); fs.chmodSync(base, 0o755);
  const userDir = path.join(base, 'user'); const nodesDir = path.join(base, 'nodes');
  fs.mkdirSync(userDir); fs.mkdirSync(nodesDir);
  for (const name of ['release-lifecycle.js', 'release-lifecycle.html', 'lifecycle.cjs']) fs.copyFileSync(new URL(`../nodered_reviewed_flow_deploy/${name}`, import.meta.url), path.join(nodesDir, name));
  const flowPath = path.join(userDir, 'flows.json'); const dep = path.join(base, 'dependency-ready');
  fs.writeFileSync(path.join(nodesDir,'fixture-closer.js'), `module.exports=RED=>{RED.nodes.registerType('release-fixture-slow-close',function(config){RED.nodes.createNode(this,config);this.on('close',function(done){setTimeout(done,20000);});});};`);
  fs.writeFileSync(path.join(nodesDir,'fixture-closer.html'),'<!-- isolated slow close fixture -->');
  const policyPath = path.join(base, 'policy.json'); const generation = randomUUID();
  fs.writeFileSync(policyPath, JSON.stringify({ edgeGeneration: generation }), { mode: 0o600 });
  const flow = value => [
    { id:'tab', type:'tab', label:'isolated release fixture' },
    { id:'fixture-get-in', type:'http in', z:'tab', url:'/fixture', method:'get', wires:[['getfn']] },
    { id:'getfn', type:'function', z:'tab', func:`msg.payload=${JSON.stringify(value)}; return msg;`, outputs:1, wires:[['out']] },
    { id:'fixture-post-in', type:'http in', z:'tab', url:'/fixture', method:'post', wires:[['postfn']] },
    { id:'postfn', type:'function', z:'tab', func:'msg.payload="post-ok"; return msg;', outputs:1, wires:[['out']] },
    { id:'fixture-error-in', type:'http in', z:'tab', url:'/application-error', method:'get', wires:[['errfn']] },
    { id:'errfn', type:'function', z:'tab', func:'msg.statusCode=502; msg.headers={"X-Application-Code":"fixture"}; msg.payload={code:"UPSTREAM_REFUSAL"}; return msg;', outputs:1, wires:[['out']] },
    { id:'slowclose', type:'release-fixture-slow-close', z:'tab', wires:[] },
    { id:'out', type:'http response', z:'tab', wires:[] },
  ];
  fs.writeFileSync(flowPath, JSON.stringify(flow('old')));
  const settings = path.join(userDir, 'settings.js');
  fs.writeFileSync(settings, `module.exports={uiHost:'127.0.0.1',uiPort:1880,httpAdminRoot:false,flowFile:${JSON.stringify(flowPath)},nodesDir:${JSON.stringify(nodesDir)},credentialSecret:false,logging:{console:{level:'info'}},padlhubReleaseLifecycle:{baseDir:${JSON.stringify(base)},flowPath:${JSON.stringify(flowPath)},dependencies:()=>({fixture:require('fs').existsSync(${JSON.stringify(dep)})})}};`);
  let child; const children = []; let nginxName; let gateway; let watch=false; let watching;
  t.after(async () => {
    watch=false; if(watching)await watching.catch(()=>{});
    for (const c of children) if (c.exitCode === null && c.signalCode === null) { c.kill('SIGKILL'); await once(c, 'exit').catch(() => {}); }
    if (nginxName) { try { execFileSync('docker', ['rm','-f', nginxName], { stdio:'ignore', timeout:10000 }); } catch { /* Fixture may already have exited. */ } }
    if (gateway) { gateway.server.closeAllConnections(); await Promise.all([new Promise(resolve => gateway.server.close(resolve)),new Promise(resolve => gateway.control.close(resolve))]); }
    fs.rmSync(base, { recursive:true, force:true });
  });
  const boot = () => { const output=fs.openSync(path.join(base,'node-red.log'),'a'); child = spawn(process.execPath, [runtime,'--userDir',userDir,'--settings',settings], { stdio:['ignore',output,output] }); fs.closeSync(output); children.push(child); return child; };
  gateway = startGateway({ baseDir:base }); await once(gateway.server, 'listening');
  boot();
  const source = await poll(async () => { const s = await requestStatus(base); return s.started && s.routeDigest && s; });
  assert.equal(source.httpPort,1880); assert.equal(source.runtimeDigest,flowHash(flow('old')));
  assert.equal(source.dependencies.fixture,false);
  const nginxPort = process.platform === 'linux' ? await freePort() : 8080;
  const upstream = process.platform === 'linux' ? '127.0.0.1' : 'host.docker.internal';
  const config = `events {} http { server { listen ${nginxPort}; location / { proxy_pass http://${upstream}:18809; } location = /__padlhub_release_probe { proxy_pass http://${upstream}:18809; proxy_set_header X-Padlhub-Edge-Worker $pid; proxy_set_header X-Padlhub-Edge-Generation ${generation}; } } }`;
  const configPath = path.join(base,'nginx.conf'); fs.writeFileSync(configPath,config);
  nginxName = `release-fixture-${process.pid}-${Date.now()}`;
  const args = ['run','-d','--rm','--name',nginxName, ...(process.platform==='linux'?['--network','host']:['-p','127.0.0.1::8080']), '-v',`${configPath}:/etc/nginx/nginx.conf:ro`,nginxImage];
  execFileSync('docker',args,{stdio:'pipe',timeout:15000});
  const publicPort = process.platform==='linux'?nginxPort:Number(execFileSync('docker',['port',nginxName,'8080/tcp'],{encoding:'utf8'}).trim().split(':').at(-1));
  await poll(async()=> (await get(publicPort)).status===200);
  const error = await get(publicPort,'/application-error');
  assert.equal(error.status,502); assert.equal(error.headers['x-application-code'],'fixture'); assert.deepEqual(JSON.parse(error.body),{code:'UPSTREAM_REFUSAL'});
  fs.writeFileSync(dep,'ready');
  const dump = execFileSync('docker',['exec',nginxName,'nginx','-T'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).replaceAll('host.docker.internal','127.0.0.1');
  const edgeState = await get(publicPort,'/__padlhub_release_probe');
  const worker = Number(edgeState.headers['x-padlhub-edge-worker']); assert.ok(worker>0);
  const policy = { edgeGeneration:generation,edgeConfigSha256:hash(dump),requiredDependencies:['fixture'],nginxWorkerPids:[worker] };
  fs.writeFileSync(policyPath,JSON.stringify(policy),{mode:0o600});
  const control = createControl({baseDir:base,nginxDump:()=>dump,getWorkers:()=>[worker],edgeProbe:async()=>{const s=await get(publicPort,'/__padlhub_release_probe');return{status:s.status,generation:s.headers['x-padlhub-edge-generation'],worker:Number(s.headers['x-padlhub-edge-worker'])};}});
  const b = { deploymentId:'physical-fixture', hashes:[hash(fs.readFileSync(flowPath)),hash(JSON.stringify(flow('new')))],pid:source.pid,diskDigest:hash(fs.readFileSync(flowPath)),runtimeDigest:flowHash(flow('old')) };
  await control('preflight',b);
  // Nginx buffers this body before proxy dispatch. It must reach a closed
  // persistent proxy after stop, never connect directly to the missing backend.
  const buffered = http.request({host:'127.0.0.1',port:publicPort,path:'/fixture',method:'POST',headers:{'Content-Length':'4','Content-Type':'text/plain'},agent:false});
  const bufferedResult = new Promise((resolve,reject)=>{buffered.on('error',reject);buffered.on('response',res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});});
  bufferedResult.catch(()=>{}); buffered.write('a');
  // A separately accepted slow body already at Node-RED blocks drain.
  const slow = http.request({host:'127.0.0.1',port:18809,path:'/fixture',method:'POST',headers:{'Content-Length':'4','Content-Type':'text/plain'},agent:false});
  const slowResult = new Promise((resolve,reject)=>{slow.on('error',reject);slow.on('response',res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});}); slowResult.catch(()=>{}); slow.write('a');
  await poll(async()=> (await requestStatus(base)).active>0);
  b.generation=(await control('begin',b)).generation;
  assert.equal((await get(publicPort)).status,503);
  let drained=false; const draining=control('drain',b).then(()=>{drained=true;});
  await delay(150); assert.equal(drained,false); slow.end('bcd'); assert.equal(await slowResult,200); await draining;
  const observed=[]; watch=true;
  watching=(async()=>{while(watch){observed.push((await get(publicPort)).status);await delay(10);}})();
  child.kill('SIGINT'); await delay(150); assert.equal(child.exitCode,null,'slow close must still be pending'); child.kill('SIGKILL'); await once(child,'exit');
  buffered.end('bcd'); assert.equal(await bufferedResult,503);
  await delay(100); fs.unlinkSync(dep); fs.writeFileSync(flowPath,JSON.stringify(flow('new'))); boot();
  const fresh=await poll(async()=>{const s=await requestStatus(base);return s.pid!==source.pid && s.started && s.routeDigest && s;});
  const next={...b,pid:fresh.pid,diskDigest:hash(fs.readFileSync(flowPath)),runtimeDigest:flowHash(flow('new'))};
  assert.equal(ready(fresh,next,policy),false); assert.equal((await get(publicPort)).status,503);
  fs.writeFileSync(dep,'ready'); await control('ready',next); await control('finish',next);
  watch=false; await watching;
  assert.ok(observed.length>5); assert.ok(observed.every(s=>s===503 || s===200),JSON.stringify(observed));
  const result=await get(publicPort); assert.equal(result.status,200); assert.equal(result.body,'new');
  assert.equal((await requestStatus(base,false,'gateway')).uncertain,0);
});
