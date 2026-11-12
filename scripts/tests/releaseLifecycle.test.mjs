import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { attach, createControl, ready, flowHash, validateEdgeConfiguration } = require('../nodered_reviewed_flow_deploy/lifecycle.cjs');
const hash = b => createHash('sha256').update(b).digest('hex');
const generation = '00000000-0000-4000-8000-000000000001';
const edge = `events {} http { server { location /lk/ { proxy_pass http://127.0.0.1:18809; } location = /__padlhub_release_probe { proxy_pass http://127.0.0.1:18809; proxy_set_header X-Padlhub-Edge-Worker $pid; proxy_set_header X-Padlhub-Edge-Generation ${generation}; } } }`;
function fixture(t, stateOverride = {}) {
  const base = fs.mkdtempSync('/tmp/rl-'); fs.chmodSync(base, 0o755);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const policy = { edgeConfigSha256: hash(edge), requiredDependencies: ['mongo', 'vivaToken'], edgeGeneration: generation, nginxWorkerPids: [200] };
  fs.writeFileSync(path.join(base, 'policy.json'), JSON.stringify(policy), { mode: 0o600 });
  const binding = { deploymentId: 'fixture-release', hashes: ['a'.repeat(64), 'b'.repeat(64)], pid: 100,
    diskDigest: 'a'.repeat(64), runtimeDigest: 'c'.repeat(64) };
  const state = { version: 1, pid: 100, started: true, diskDigest: binding.diskDigest, runtimeDigest: binding.runtimeDigest,
    routeDigest: 'd'.repeat(64), dependencies: { mongo: true, vivaToken: true }, active: 0, uncertain: 0, connections: 0, quietMs: 1000, admissionKeyDigest: 'e'.repeat(64), httpPort: 1880, httpHost: '127.0.0.1', ...stateOverride };
  let time = 0; let count = 0;
  const run = createControl({ baseDir: base, nginxDump: () => edge,
    getWorkers: () => [200], edgeProbe: async () => ({ generation, worker: 200, status: fs.existsSync(path.join(base, 'closed.json')) ? 503 : 204 }),
    getStatus: async (_base, _drain, peer) => { count++; return peer === 'gateway' ? { version: 1, pid: 101, bootId: generation, host: '127.0.0.1', port: 18809, upstreamPort: 1880, admissionKeyDigest: 'e'.repeat(64), active: 0, uncertain: 0 } : state; }, now: () => time, sleep: async () => { time += 10_000; } });
  const control = async (action, binding) => { const result = await run(action, binding); if (action === 'begin') binding.generation = result.generation; return result; };
  return { base, binding, state, control, get calls() { return count; } };
}
test('effective edge configuration requires persistent proxy and loaded-generation probe', () => {
  validateEdgeConfiguration(edge);
  assert.throws(() => validateEdgeConfiguration(edge.replaceAll(':18809', ':1880')), /DIRECT_NODE_RED/);
  assert.throws(() => validateEdgeConfiguration(edge.replaceAll(':18809', ':18810')), /NO_GATEWAY/);
  assert.throws(() => validateEdgeConfiguration(edge.replaceAll('/__padlhub_release_probe', '/wrong')), /PROBE_MISSING/);
});
test('online/listener alone never proves flow, source, route or dependency readiness', () => {
  const b = { pid: 100, diskDigest: 'a', runtimeDigest: 'b' };
  const p = { requiredDependencies: ['mongo'] };
  const s = { version: 1, pid: 100, started: true, diskDigest: 'a', runtimeDigest: 'b', routeDigest: 'd'.repeat(64), dependencies: { mongo: true }, httpPort: 1880, httpHost: '127.0.0.1' };
  assert.equal(ready(s, b, p), true);
  for (const change of [{ pid: 99 }, { httpPort: 1881 }, { httpHost: '0.0.0.0' }, { started: false }, { diskDigest: 'wrong' }, { runtimeDigest: 'wrong' }, { routeDigest: null }, { dependencies: { mongo: false } }, { dependencies: {} }]) assert.equal(ready({ ...s, ...change }, b, p), false);
});
test('owned durable admission marker survives control crash/recreation and foreign owner cannot open it', async t => {
  const f = fixture(t); await f.control('preflight', f.binding); await f.control('begin', f.binding);
  const p = path.join(f.base, 'closed.json'); assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  await assert.rejects(f.control('finish', { ...f.binding, deploymentId: 'other-release' }), /FOREIGN_OWNER/);
  assert.equal(fs.existsSync(p), true);
  await f.control('drain', f.binding); await f.control('ready', f.binding); await f.control('finish', f.binding);
  assert.equal(fs.existsSync(p), false);
});
test('active, slow-body and idle upstream connections block drain; uncertain abort refuses restart', async t => {
  for (const change of [{ active: 1 }, { connections: 1 }, { quietMs: 0 }, { uncertain: 1 }, { pid: 99 }]) {
    const f = fixture(t, change); await f.control('begin', f.binding);
    await assert.rejects(f.control('drain', f.binding), /DRAIN/);
    assert.equal(fs.existsSync(path.join(f.base, 'closed.json')), true);
  }
});
test('readiness failure, drift and unprotected policy never release admission', async t => {
  const f = fixture(t, { started: false }); await f.control('begin', f.binding);
  await assert.rejects(f.control('ready', f.binding), /READINESS_TIMEOUT/);
  await assert.rejects(f.control('finish', f.binding), /OPEN_NOT_READY/);
  f.state.started = true;
  await assert.rejects(f.control('finish', { ...f.binding, diskDigest: 'e'.repeat(64) }), /OPEN_NOT_READY/);
  fs.chmodSync(path.join(f.base, 'policy.json'), 0o644);
  await assert.rejects(f.control('finish', f.binding), /UNPROTECTED_PATH/);
  assert.equal(fs.existsSync(path.join(f.base, 'closed.json')), true);
});
test('tracker precedes body parsers, persistent middleware survives route removal and abort is not completion', async t => {
  const base = fs.mkdtempSync('/tmp/rl-'); fs.chmodSync(base, 0o755);
  const flow = [{ id: 'tab', type: 'tab' }, { id: 'in', z: 'tab', type: 'http in', url: '/fixture', method: 'post' }];
  fs.writeFileSync(path.join(base,'admission-key'),'a'.repeat(64),{mode:0o600});
  const flowPath = path.join(base, 'flows.json'); fs.writeFileSync(flowPath, JSON.stringify(flow));
  const server = new EventEmitter(); server.getConnections = cb => cb(null, 0); server.address = () => ({ port: 10000 });
  const events = new EventEmitter(); const middlewares = []; const callback=()=>{};
  const RED = { server, events, nodes: { getNode: () => ({callback}) }, httpNode: { _router: { stack: [{ route: { path: '/fixture', methods: { post: true },stack:[{handle:callback}] } }] }, use: fn => middlewares.push(fn) } };
  const g = attach(RED, { baseDir: base, flowPath, dependencies: () => ({ mongo: true }) });
  await new Promise(resolve => g.control.listening ? resolve() : g.control.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => g.control.close(resolve)); fs.rmSync(base, { recursive: true, force: true }); });
  events.emit('flows:started', { config: { flows: flow } });
  assert.equal((await g.status()).runtimeDigest, flowHash(flow));
  const res = new EventEmitter(); server.emit('request', {}, res);
  assert.equal((await g.status()).active, 1); // before any body-parser completion
  fs.writeFileSync(path.join(base, 'closed.json'), '{}');
  RED.httpNode._router.stack = []; events.emit('flows:stopping');
  let status; let next = false;
  middlewares[0]({}, { setHeader() {}, status(n) { status = n; return this; }, json() {} }, () => { next = true; });
  assert.equal(status, 503); assert.equal(next, false);
  res.emit('close');
  assert.equal((await g.status()).active, 0); assert.equal((await g.status()).uncertain, 1);
  assert.equal((await g.status()).started, false);
});

test('generation mismatch and stale edge workers cannot open another admission generation', async t => {
  const f=fixture(t); await f.control('begin',f.binding);
  await assert.rejects(f.control('finish',{...f.binding,generation:'00000000-0000-4000-8000-000000000099'}),/FOREIGN_OWNER/);
  const policyPath=path.join(f.base,'policy.json');const p=JSON.parse(fs.readFileSync(policyPath));p.nginxWorkerPids=[201];fs.writeFileSync(policyPath,JSON.stringify(p));
  await assert.rejects(f.control('finish',f.binding),/WORKER_DRIFT/);
  assert.equal(fs.existsSync(path.join(f.base,'closed.json')),true);
});

test('persistent proxy preserves application errors and waits for upstream response after client disconnect', async t => {
  const http=await import('node:http');
  const {startGateway}=require('../nodered_reviewed_flow_deploy/gateway.cjs');
  const {requestStatus}=require('../nodered_reviewed_flow_deploy/lifecycle.cjs');
  const base=fs.mkdtempSync('/tmp/rg-');fs.chmodSync(base,0o755);
  fs.writeFileSync(path.join(base,'policy.json'),JSON.stringify({edgeGeneration:generation}),{mode:0o600});
  let calls=0;
  const backend=http.createServer((req,res)=>{calls++;req.resume();req.on('end',()=>setTimeout(()=>{res.writeHead(502,{'Content-Type':'application/json','X-Application-Code':'preserved'});res.end('{"code":"FIXTURE_ERROR"}');},50));});
  backend.listen(0,'127.0.0.1');await new Promise(resolve=>backend.once('listening',resolve));
  const g=startGateway({baseDir:base,port:0,upstreamPort:backend.address().port});await new Promise(resolve=>g.server.once('listening',resolve));
  await new Promise(resolve=>g.control.listening?resolve():g.control.once('listening',resolve));
  t.after(async()=>{g.server.closeAllConnections();backend.closeAllConnections();await Promise.all([new Promise(resolve=>g.server.close(resolve)),new Promise(resolve=>g.control.close(resolve)),new Promise(resolve=>backend.close(resolve))]);fs.rmSync(base,{recursive:true,force:true});});
  const port=g.server.address().port;
  const request=()=>new Promise((resolve,reject)=>{const q=http.get({host:'127.0.0.1',port,path:'/fixture',agent:false},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));});q.on('error',reject);});
  const response=await request();assert.equal(response.status,502);assert.equal(response.body,'{"code":"FIXTURE_ERROR"}');assert.equal(response.headers['x-application-code'],'preserved');assert.equal(calls,1);
  const q=http.get({host:'127.0.0.1',port,path:'/fixture',agent:false});q.on('error',()=>{});
  while(calls<2)await new Promise(resolve=>setTimeout(resolve,5));q.destroy();
  await new Promise(resolve=>setTimeout(resolve,100));
  const status=await requestStatus(base,false,'gateway');assert.equal(status.active,0);assert.equal(status.uncertain,0);assert.equal(calls,2);
  fs.writeFileSync(path.join(base,'closed.json'),'{}');const closed=await request();assert.equal(closed.status,503);assert.equal(closed.headers['retry-after'],'5');assert.equal(calls,2);
});

test('variable-port or upstream alias cannot bypass admission behind an otherwise valid probe', () => {
  assert.throws(()=>validateEdgeConfiguration(edge.replace('proxy_pass http://127.0.0.1:18809;', 'proxy_pass http://127.0.0.1:01880;')),/DIRECT_NODE_RED/);
  assert.throws(()=>validateEdgeConfiguration(edge.replace('proxy_pass http://127.0.0.1:18809;', 'set $node_red_port 1880; proxy_pass http://127.0.0.1:$node_red_port;')),/VARIABLE_PROXY/);
  assert.throws(()=>validateEdgeConfiguration(edge.replace('proxy_pass http://127.0.0.1:18809;', 'proxy_pass http://node_red;')),/UNSUPPORTED_PROXY/);
});

test('crash after marker hard-link publication recovers only the exact private temporary inode', async t => {
  const f=fixture(t);await f.control('begin',f.binding);
  const final=path.join(f.base,'closed.json');const temporary=path.join(f.base,`.gate-${f.binding.generation}`);
  fs.linkSync(final,temporary);assert.equal(fs.statSync(final).nlink,2);
  await f.control('drain',f.binding);assert.equal(fs.statSync(final).nlink,1);assert.equal(fs.existsSync(temporary),false);
  fs.linkSync(final,path.join(f.base,'unrecognized-link'));
  await assert.rejects(f.control('finish',f.binding));assert.equal(fs.existsSync(final),true);
});

test('partial upstream response closes downstream promptly and records uncertainty without retry',async t=>{
  const http=await import('node:http');const {startGateway}=require('../nodered_reviewed_flow_deploy/gateway.cjs');const {requestStatus}=require('../nodered_reviewed_flow_deploy/lifecycle.cjs');
  const base=fs.mkdtempSync('/tmp/rg-');fs.chmodSync(base,0o755);fs.writeFileSync(path.join(base,'policy.json'),JSON.stringify({edgeGeneration:generation}),{mode:0o600});
  let calls=0;const backend=http.createServer((_req,res)=>{calls++;res.writeHead(200,{'Content-Length':'1000'});res.write('partial');setTimeout(()=>res.destroy(),10);});backend.listen(0,'127.0.0.1');await new Promise(resolve=>backend.once('listening',resolve));
  const g=startGateway({baseDir:base,port:0,upstreamPort:backend.address().port});await new Promise(resolve=>g.server.once('listening',resolve));await new Promise(resolve=>g.control.listening?resolve():g.control.once('listening',resolve));
  t.after(async()=>{g.server.closeAllConnections();backend.closeAllConnections();await Promise.all([new Promise(resolve=>g.server.close(resolve)),new Promise(resolve=>g.control.close(resolve)),new Promise(resolve=>backend.close(resolve))]);fs.rmSync(base,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{const q=http.get({host:'127.0.0.1',port:g.server.address().port,path:'/',agent:false,timeout:500},res=>{res.resume();res.once('aborted',resolve);res.once('end',()=>reject(Error('truncated body accepted')));res.on('error',()=>{});});q.on('error',reject);q.on('timeout',()=>q.destroy(Error('downstream hung')));});
  const s=await requestStatus(base,false,'gateway');assert.equal(s.active,0);assert.equal(s.uncertain,1);assert.equal(calls,1);
});

test('explicit uncertainty resolution binds boot/revision and stale replay cannot clear a later abort',async t=>{
  const {requestStatus}=require('../nodered_reviewed_flow_deploy/lifecycle.cjs');
  const base=fs.mkdtempSync('/tmp/ra-');fs.chmodSync(base,0o755);fs.writeFileSync(path.join(base,'admission-key'),'a'.repeat(64),{mode:0o600});
  const flowPath=path.join(base,'flows.json');fs.writeFileSync(flowPath,'[]');
  const server=new EventEmitter();server.getConnections=cb=>cb(null,0);server.address=()=>({port:1880,address:'127.0.0.1'});
  const RED={server,events:new EventEmitter(),nodes:{getNode:()=>null},httpNode:{use(){}}};
  const g=attach(RED,{baseDir:base,flowPath,dependencies:()=>({fixture:true})});await new Promise(resolve=>g.control.once('listening',resolve));
  t.after(async()=>{await new Promise(resolve=>g.control.close(resolve));fs.rmSync(base,{recursive:true,force:true});});
  const response=()=>{const res=new EventEmitter();res.end=function(){return this;};return res;};
  const a=response();server.emit('request',{headers:{}},a);a.emit('close');let s=await g.status();assert.equal(s.uncertain,1);
  fs.writeFileSync(path.join(base,'closed.json'),JSON.stringify({version:1,deploymentId:'fixture-release',generation,hashes:['a'.repeat(64),'b'.repeat(64)]}),{mode:0o600});
  const receipt={decision:'HTTP_OUTCOMES_REVIEWED',resolutionId:generation,evidenceSha256:'c'.repeat(64),nodePid:s.pid,nodeBootId:s.bootId,nodeUncertain:1,nodeUncertaintyRevision:0};
  const write=()=>fs.writeFileSync(path.join(base,'uncertainty-resolution.json'),JSON.stringify(receipt),{mode:0o600});write();await assert.rejects(requestStatus(base,'resolve'));
  receipt.nodeUncertaintyRevision=s.uncertaintyRevision;write();await requestStatus(base,'resolve');await requestStatus(base,'resolve');assert.equal((await g.status()).uncertain,0);
  a.end();assert.equal((await g.status()).uncertain,0);
  const b=response();server.emit('request',{headers:{'x-padlhub-release-admitted':'a'.repeat(64)}},b);b.emit('close');s=await g.status();assert.equal(s.uncertain,1);
  await assert.rejects(requestStatus(base,'resolve'));assert.equal((await g.status()).uncertain,1);
  b.end();assert.equal((await g.status()).uncertain,0);
});

test('accepted gateway handoff drains nested self-HTTP while closed, then fences unsigned requests at zero',async t=>{
  const base=fs.mkdtempSync('/tmp/rh-');fs.chmodSync(base,0o755);const key='a'.repeat(64);fs.writeFileSync(path.join(base,'admission-key'),key,{mode:0o600});
  const flow=[{id:'tab',type:'tab'},{id:'input',type:'http in',z:'tab',url:'/fixture',method:'get'}];const flowPath=path.join(base,'flows.json');fs.writeFileSync(flowPath,JSON.stringify(flow));
  const server=new EventEmitter();server.getConnections=cb=>cb(null,0);server.address=()=>({port:1880,address:'127.0.0.1'});const events=new EventEmitter();let middleware;const callback=()=>{};
  const RED={server,events,nodes:{getNode:()=>({callback})},httpNode:{use(fn){middleware=fn;},_router:{stack:[{route:{path:'/fixture',methods:{get:true},stack:[{handle:callback}]}}]}}};
  const g=attach(RED,{baseDir:base,flowPath,dependencies:()=>({fixture:true})});await new Promise(resolve=>g.control.once('listening',resolve));
  t.after(async()=>{await new Promise(resolve=>g.control.close(resolve));fs.rmSync(base,{recursive:true,force:true});});events.emit('flows:started',{config:{flows:flow}});
  fs.writeFileSync(path.join(base,'closed.json'),'{}');
  const parent={headers:{'x-padlhub-release-admitted':key},rawHeaders:['x-padlhub-release-admitted',key,'Host','fixture']};const parentRes=new EventEmitter();server.emit('request',parent,parentRes);
  let passed=0;const res={setHeader(){},status(n){this.code=n;return this;},json(){}};
  middleware(parent,res,()=>passed++);assert.equal(passed,1);assert.equal(parent.headers['x-padlhub-release-admitted'],undefined);assert.deepEqual(parent.rawHeaders,['Host','fixture']);
  const nested={headers:{}};const nestedRes=new EventEmitter();server.emit('request',nested,nestedRes);middleware(nested,res,()=>passed++);assert.equal(passed,2);
  nestedRes.emit('finish');parentRes.emit('finish');assert.equal((await g.status()).active,0);
  const fresh={headers:{'x-padlhub-release-admitted':'é'.repeat(64)}};assert.doesNotThrow(()=>server.emit('request',fresh,new EventEmitter()));middleware(fresh,res,()=>passed++);assert.equal(res.code,503);assert.equal(passed,2);
});
