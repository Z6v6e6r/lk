'use strict';
// Installed separately, before any guarded restart. No HTTP business probes.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const BASE = '/var/lib/padlhub-nodered-release';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const flowHash = flow => hash(JSON.stringify([...flow].sort((a, b) => a.id.localeCompare(b.id)).map(canonical)));
const fail = code => { throw new Error(code); };
function validateEdgeConfiguration(config) {
  const text = config.replace(/#[^\n]*/g, '');
  // No remaining direct or aliased upstream may bypass the persistent proxy.
  if (/:1880\b/.test(text)) fail('LIFECYCLE_EDGE_DIRECT_NODE_RED');
  for (const match of text.matchAll(/proxy_pass\s+([^;]+);/g)) {
    const target = match[1].trim();
    if (target.includes('$')) fail('LIFECYCLE_EDGE_VARIABLE_PROXY');
    let url; try { url = new URL(target); } catch { fail('LIFECYCLE_EDGE_UNSUPPORTED_PROXY'); }
    if (url.port === '1880') fail('LIFECYCLE_EDGE_DIRECT_NODE_RED');
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.')) fail('LIFECYCLE_EDGE_UNSUPPORTED_PROXY');
  }
  if (!/proxy_pass\s+http:\/\/127\.0\.0\.1:18809(?:[/;\s])/.test(text)) fail('LIFECYCLE_EDGE_NO_GATEWAY');
  if (!/location\s*=\s*\/__padlhub_release_probe\s*\{/.test(text)
    || !/proxy_set_header\s+X-Padlhub-Edge-Worker\s+\$pid\s*;/.test(text)
    || !/proxy_set_header\s+X-Padlhub-Edge-Generation\s+["']?[a-f0-9-]{36}["']?\s*;/.test(text)) fail('LIFECYCLE_EDGE_PROBE_MISSING');
}
function protectedPath(file, { directory = false, mode = 0o600, uid = process.getuid(), maxLinks = 1 } = {}) {
  const s = fs.lstatSync(file);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile()) || s.uid !== uid
    || (s.mode & 0o777) !== mode || (!directory && (s.nlink < 1 || s.nlink > maxLinks))) fail('LIFECYCLE_UNPROTECTED_PATH');
  return s;
}
function syncDir(dir) { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
const ADMISSION_HEADER = 'x-padlhub-release-admitted';
function admissionKey(base, create = false) {
  const p = path.join(base, 'admission-key');
  if (create && !fs.existsSync(p)) {
    const fd = fs.openSync(p, 'wx', 0o600);
    try { fs.writeFileSync(fd, crypto.randomBytes(32).toString('hex')); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncDir(base);
  }
  protectedPath(p);
  const key = fs.readFileSync(p, 'utf8');
  if (!/^[a-f0-9]{64}$/.test(key)) fail('LIFECYCLE_ADMISSION_KEY_INVALID');
  return key;
}
function stripAdmission(req) {
  const value = req.headers?.[ADMISSION_HEADER];
  if (req.headers) delete req.headers[ADMISSION_HEADER];
  if (req.rawHeaders) req.rawHeaders = req.rawHeaders.filter((_v, i, all) => (i % 2 ? all[i-1] : all[i]).toLowerCase() !== ADMISSION_HEADER);
  return value;
}
function marker(base) { return path.join(base, 'closed.json'); }
function readMarker(base) {
  if (!fs.existsSync(marker(base))) return null;
  const stat = protectedPath(marker(base), { maxLinks: 2 });
  const v = JSON.parse(fs.readFileSync(marker(base), 'utf8'));
  if (v.version !== 1 || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(v.deploymentId)
    || !/^[a-f0-9-]{36}$/.test(v.generation || '') || !Array.isArray(v.hashes) || v.hashes.length !== 2 || !v.hashes.every(x => /^[a-f0-9]{64}$/.test(x))) fail('LIFECYCLE_MARKER_INVALID');
  if (stat.nlink === 2) {
    const temporary = path.join(base, `.gate-${v.generation}`);
    const temp = protectedPath(temporary, { maxLinks: 2 });
    if (temp.dev !== stat.dev || temp.ino !== stat.ino) fail('LIFECYCLE_MARKER_PUBLICATION_AMBIGUOUS');
    fs.unlinkSync(temporary); syncDir(base);
    protectedPath(marker(base));
  }
  return v;
}
function expectedRoutes(RED, flow) {
  const tabs = new Map(flow.filter(n => n.type === 'tab').map(n => [n.id, n]));
  const routes = [];
  for (const n of flow.filter(n => n.type === 'http in' && !n.d)) {
    const tab = tabs.get(n.z);
    if (!tab) fail('LIFECYCLE_UNSUPPORTED_SUBFLOW_HTTP');
    if (tab.disabled) continue;
    const instance = RED.nodes.getNode(n.id);
    if (!instance || typeof n.url !== 'string') fail('LIFECYCLE_ROUTE_INSTANCE_MISSING');
    const routesForInput = (RED.httpNode._router?.stack || []).filter(s => s.route?.path === n.url && s.route.methods?.[n.method]);
    if (routesForInput.length !== 1 || typeof instance.callback !== 'function'
      || !routesForInput[0].route.stack?.some(s => s.handle === instance.callback)) fail('LIFECYCLE_ROUTE_MISSING');
    routes.push(`${n.method} ${n.url}`);
  }
  if (!routes.length) fail('LIFECYCLE_NO_ROUTES');
  return hash(JSON.stringify(routes.sort()));
}
function attach(RED, options) {
  const { baseDir = BASE, flowPath = '/root/.node-red/flows.json', dependencies } = options || {};
  if (typeof dependencies !== 'function') fail('LIFECYCLE_DEPENDENCY_CHECKS_REQUIRED');
  protectedPath(baseDir, { directory: true, mode: 0o755 });
  const runtimeDir = path.join(baseDir, 'runtime');
  if (!fs.existsSync(runtimeDir)) fs.mkdirSync(runtimeDir, { mode: 0o700 });
  protectedPath(runtimeDir, { directory: true, mode: 0o700 });
  const socket = path.join(runtimeDir, 'runtime.sock');
  const key = admissionKey(baseDir);
  let active = 0; let started = false; let runtimeFlow = null;
  const unresolved = new Set(); let uncertaintyRevision = 0;
  const bootId = crypto.randomUUID(); let resolvedId = null;
  let lastAdmission = Date.now();
  const admitted = Symbol('release-admitted');
  const track = (req, res) => {
    const proof = stripAdmission(req);
    const priorAdmission = typeof proof === 'string' && /^[a-f0-9]{64}$/.test(proof)
      && crypto.timingSafeEqual(Buffer.from(proof), Buffer.from(key));
    // Accepted gateway requests and nested self-HTTP of already active work
    // must still finish while the external fence is closed. Once active=0,
    // unsigned local requests cannot race the final drain/stop transition.
    req[admitted] = priorAdmission || !fs.existsSync(marker(baseDir)) || active > 0;
    if (!req[admitted]) return;
    active++; lastAdmission = Date.now();
    let complete = false; let ended = false; const attempt = {};
    const end = res.end;
    if (typeof end === 'function') res.end = function (...args) {
      const result = end.apply(this, args); ended = true;
      // The application can finish its HTTP work after the client disconnects.
      // This has the same HTTP-only scope as normal response completion.
      unresolved.delete(attempt);
      return result;
    };
    res.once('finish', () => { if (!complete) { complete = true; active--; } });
    res.once('close', () => { if (!complete) { complete = true; active--; if (!ended) { unresolved.add(attempt); uncertaintyRevision++; } } });
  };
  // Account before Node-RED admin/body parsers, including slow request bodies.
  RED.server.prependListener('request', track);
  RED.server.prependListener('upgrade', req => stripAdmission(req));
  RED.httpNode.use((req, res, next) => {
    if (req[admitted] === true && started) return next();
    // Persistent middleware remains installed when HTTP-in routes are removed.
    res.setHeader('Retry-After', '5'); res.setHeader('Cache-Control', 'no-store');
    res.status(503).json({ code: 'NODE_RED_RELEASING', retryable: true });
  });
  RED.events.on('flows:starting', () => { started = false; });
  RED.events.on('flows:stopping', () => { started = false; });
  RED.events.on('flows:stopped', () => { started = false; });
  RED.events.on('flows:started', event => {
    runtimeFlow = event?.config?.flows;
    started = Array.isArray(runtimeFlow);
  });
  async function status() {
    let routeDigest = null; let runtimeDigest = null; let dependencyState = {};
    try {
      if (started) { routeDigest = expectedRoutes(RED, runtimeFlow); runtimeDigest = flowHash(runtimeFlow); }
      const result = dependencies(RED);
      if (!result || typeof result !== 'object' || Array.isArray(result)) fail('LIFECYCLE_DEPENDENCIES_INVALID');
      for (const [k, v] of Object.entries(result)) {
        if (!/^[a-z][a-zA-Z0-9]{0,31}$/.test(k) || typeof v !== 'boolean') fail('LIFECYCLE_DEPENDENCIES_INVALID');
        dependencyState[k] = v;
      }
    } catch { dependencyState = {}; routeDigest = null; }
    const connections = await new Promise((resolve, reject) => RED.server.getConnections((e, n) => e ? reject(e) : resolve(n)));
    return { version: 1, pid: process.pid, started, runtimeDigest, routeDigest,
      diskDigest: hash(fs.readFileSync(flowPath)), dependencies: dependencyState,
      active, uncertain: unresolved.size, uncertaintyRevision, connections, quietMs: Date.now() - lastAdmission, bootId,
      httpPort: RED.server.address()?.port || null, httpHost: RED.server.address()?.address || null,
      admissionKeyDigest: hash(key) };
  }
  const control = http.createServer(async (req, res) => {
    try {
      if (req.method === 'POST' && req.url === '/drain') {
        if (!readMarker(baseDir)) fail('LIFECYCLE_ADMISSION_NOT_CLOSED');
        RED.server.closeIdleConnections?.();
      } else if (req.method === 'POST' && req.url === '/resolve') {
        const r = readResolution(baseDir);
        if (!readMarker(baseDir) || active || r.nodePid !== process.pid || r.nodeBootId !== bootId
          || r.nodeUncertaintyRevision !== uncertaintyRevision
          || !(r.resolutionId === resolvedId ? unresolved.size === 0 : r.nodeUncertain === unresolved.size)) fail('LIFECYCLE_RESOLUTION_MISMATCH');
        unresolved.clear(); resolvedId = r.resolutionId;
      } else if (req.method !== 'GET' || req.url !== '/status') fail('LIFECYCLE_CONTROL_REQUEST_INVALID');
      const result = await status();
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
    } catch { res.writeHead(503); res.end('{"code":"LIFECYCLE_UNAVAILABLE"}'); }
  });
  // A dead predecessor may have left a socket. Never unlink a live peer's socket.
  const listen = () => control.listen(socket, () => fs.chmodSync(socket, 0o600));
  if (fs.existsSync(socket)) {
    const s = fs.lstatSync(socket);
    if (!s.isSocket() || s.uid !== process.getuid()) fail('LIFECYCLE_SOCKET_INVALID');
    const probe = require('node:net').createConnection(socket);
    probe.once('connect', () => { probe.destroy(); control.emit('error', new Error('LIFECYCLE_SOCKET_IN_USE')); });
    probe.once('error', e => {
      if (e.code !== 'ECONNREFUSED') return control.emit('error', new Error('LIFECYCLE_SOCKET_UNVERIFIED'));
      fs.unlinkSync(socket); listen();
    });
  } else listen();
  // Socket lifetime is process lifetime, independent of flows:stopping/started.
  return { control, status, track };
}
function readResolution(base) {
  const p = path.join(base, 'uncertainty-resolution.json'); protectedPath(p);
  const r = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (r.decision !== 'HTTP_OUTCOMES_REVIEWED' || !/^[a-f0-9]{64}$/.test(r.evidenceSha256 || '')
    || !/^[a-f0-9-]{36}$/.test(r.resolutionId || '')) fail('LIFECYCLE_RESOLUTION_INVALID');
  return r;
}
async function requestStatus(base, drain = false, peer = 'runtime') {
  const socket = path.join(base, `runtime/${peer}.sock`);
  protectedPath(path.dirname(socket), { directory: true, mode: 0o700 });
  const s = fs.lstatSync(socket);
  if (!s.isSocket() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o600) fail('LIFECYCLE_SOCKET_INVALID');
  return new Promise((resolve, reject) => {
    const endpoint = drain === 'resolve' ? '/resolve' : drain ? '/drain' : '/status';
    const req = http.request({ socketPath: socket, path: endpoint, method: drain ? 'POST' : 'GET', timeout: 1000 }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; if (body.length > 16384) req.destroy(new Error('LIFECYCLE_RESPONSE_TOO_LARGE')); });
      res.on('end', () => { try { if (res.statusCode !== 200) fail('LIFECYCLE_NOT_READY'); resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('LIFECYCLE_CONTROL_TIMEOUT'))); req.end();
  });
}
function ready(s, binding, policy) {
  return s?.version === 1 && s.pid === binding.pid && s.started === true && s.diskDigest === binding.diskDigest
    && s.runtimeDigest === binding.runtimeDigest && /^[a-f0-9]{64}$/.test(s.routeDigest || '')
    && s.httpPort === 1880 && s.httpHost === '127.0.0.1' && policy.requiredDependencies.every(k => s.dependencies?.[k] === true);
}
function nginxWorkers() {
  return execFileSync('ps', ['-C', 'nginx', '-o', 'pid=,args='], { encoding: 'utf8', timeout: 1000 })
    .split('\n').filter(s => /nginx: worker process/.test(s)).map(s => Number(s.trim().split(/\s/)[0])).sort((a, b) => a - b);
}
async function probeEdge() {
  return new Promise((resolve, reject) => {
    const req = require('node:https').get({ hostname: 'padlhub.su', servername: 'padlhub.su',
      path: '/__padlhub_release_probe', lookup: (_host, options, cb) => options.all
        ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4),
      agent: false, timeout: 1000 }, res => {
      res.resume(); resolve({ status: res.statusCode, generation: res.headers['x-padlhub-edge-generation'], worker: Number(res.headers['x-padlhub-edge-worker']) });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('LIFECYCLE_EDGE_PROBE_TIMEOUT')));
  });
}
function createControl({ baseDir = BASE, nginxDump = () => execFileSync('nginx', ['-T'], { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 }), getStatus = requestStatus,
  getWorkers = nginxWorkers, edgeProbe = probeEdge,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  function policy() {
    protectedPath(baseDir, { directory: true, mode: 0o755 });
    const p = path.join(baseDir, 'policy.json'); protectedPath(p);
    const v = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!/^[a-f0-9]{64}$/.test(v.edgeConfigSha256 || '') || !Array.isArray(v.requiredDependencies)
      || !v.requiredDependencies.length || !v.requiredDependencies.every(k => /^[a-z][a-zA-Z0-9]{0,31}$/.test(k))) fail('LIFECYCLE_POLICY_INVALID');
    const dump = nginxDump();
    if (hash(dump) !== v.edgeConfigSha256) fail('LIFECYCLE_EDGE_CONFIG_DRIFT');
    validateEdgeConfiguration(dump);
    if (!/^[a-f0-9-]{36}$/.test(v.edgeGeneration || '') || !Array.isArray(v.nginxWorkerPids)
      || !v.nginxWorkerPids.length || !v.nginxWorkerPids.every(x => Number.isSafeInteger(x) && x > 0)
      || JSON.stringify([...v.nginxWorkerPids].sort((a,b) => a-b)) !== JSON.stringify(getWorkers())) fail('LIFECYCLE_EDGE_WORKER_DRIFT');
    return v;
  }
  const sameOwner = (m, b) => m && m.deploymentId === b.deploymentId && JSON.stringify(m.hashes) === JSON.stringify(b.hashes);
  const owned = (m, b) => sameOwner(m, b) && m.generation === b.generation;
  async function edge(p, closed) {
    const missing = new Set(p.nginxWorkerPids); const deadline = now() + 10000;
    do {
      const s = await edgeProbe();
      if (s.generation !== p.edgeGeneration || s.status !== (closed ? 503 : 204) || !p.nginxWorkerPids.includes(s.worker)) fail('LIFECYCLE_EDGE_NOT_LOADED');
      missing.delete(s.worker);
      if (!missing.size) return;
    } while (now() < deadline);
    fail('LIFECYCLE_EDGE_WORKER_UNPROVEN');
  }
  async function gateway(m) {
    const g = await getStatus(baseDir, false, 'gateway');
    if (g.version !== 1 || g.host !== '127.0.0.1' || g.port !== 18809 || g.upstreamPort !== 1880
      || m && (g.pid !== m.gatewayPid || g.bootId !== m.gatewayBootId)) fail('LIFECYCLE_GATEWAY_DRIFT');
    return g;
  }
  async function wait(binding, p, drain = false) {
    const deadline = now() + (drain ? 20000 : 30000);
    do {
      try {
        const m = readMarker(baseDir); if (!owned(m, binding)) fail('LIFECYCLE_FOREIGN_OWNER');
        const g = await gateway(m);
        const s = await getStatus(baseDir, drain);
        if (s.admissionKeyDigest !== g.admissionKeyDigest) fail('LIFECYCLE_ADMISSION_KEY_DRIFT');
        if (drain ? g.active === 0 && g.uncertain === 0 && s.pid === binding.pid && s.active === 0 && s.uncertain === 0 && s.connections === 0 && s.quietMs >= 500
          : g.active === 0 && g.uncertain === 0 && ready(s, binding, p)) return s;
        if (drain && (s.pid !== binding.pid || s.uncertain > 0 || g.uncertain > 0)) fail('LIFECYCLE_UNCERTAIN_DRAIN');
      } catch (e) { if (drain) throw e; }
      await sleep(100);
    } while (now() < deadline);
    fail(drain ? 'LIFECYCLE_DRAIN_TIMEOUT' : 'LIFECYCLE_READINESS_TIMEOUT');
  }
  return async (action, b) => {
    const p = policy();
    if (action === 'preflight') {
      if (readMarker(baseDir)) fail('LIFECYCLE_ADMISSION_ALREADY_CLOSED');
      const s = await getStatus(baseDir);
      if (!ready(s, b, p)) fail('LIFECYCLE_SOURCE_NOT_READY');
      const g = await gateway(); if (s.admissionKeyDigest !== g.admissionKeyDigest) fail('LIFECYCLE_ADMISSION_KEY_DRIFT');
      await edge(p, false);
    } else if (action === 'begin') {
      const prior = readMarker(baseDir);
      if (prior && !sameOwner(prior, b)) fail('LIFECYCLE_FOREIGN_OWNER');
      if (!prior) {
        const g = await gateway();
        const data = { version: 1, deploymentId: b.deploymentId, hashes: b.hashes, generation: crypto.randomUUID(), gatewayPid: g.pid, gatewayBootId: g.bootId };
        // Validate the proposed shape before durable no-clobber publication.
        if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(data.deploymentId) || !Array.isArray(data.hashes)
          || data.hashes.length !== 2 || !data.hashes.every(x => /^[a-f0-9]{64}$/.test(x))) fail('LIFECYCLE_BINDING_INVALID');
        const temporary = path.join(baseDir, `.gate-${data.generation}`);
        const fd = fs.openSync(temporary, 'wx', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.linkSync(temporary, marker(baseDir)); fs.unlinkSync(temporary);
        syncDir(baseDir);
      }
      await edge(p, true);
      return { ok: true, action, generation: readMarker(baseDir).generation };
    } else {
      const m = readMarker(baseDir);
      if (!owned(m, b)) fail('LIFECYCLE_FOREIGN_OWNER');
      if (action === 'drain') await wait(b, p, true);
      else if (action === 'ready') await wait(b, p);
      else if (action === 'verify') {
        const g = await gateway(m); const s = await getStatus(baseDir);
        if (g.active || g.uncertain || s.admissionKeyDigest !== g.admissionKeyDigest || !ready(s, b, p)) fail('LIFECYCLE_NOT_READY');
      } else if (action === 'resolve-uncertainty') {
        await gateway(m); await getStatus(baseDir, 'resolve'); await getStatus(baseDir, 'resolve', 'gateway');
      }
      else if (action === 'finish') {
        const g = await gateway(m); if (g.active || g.uncertain) fail('LIFECYCLE_UNCERTAIN_DRAIN');
        await edge(p, true);
        const s = await getStatus(baseDir);
        if (!b.hashes.includes(b.diskDigest) || s.admissionKeyDigest !== g.admissionKeyDigest || !ready(s, b, p)) fail('LIFECYCLE_OPEN_NOT_READY');
        if (!owned(readMarker(baseDir), b)) fail('LIFECYCLE_FOREIGN_OWNER');
        fs.unlinkSync(marker(baseDir)); syncDir(baseDir);
      } else fail('LIFECYCLE_ACTION_INVALID');
    }
    return { ok: true, action };
  };
}
module.exports = { attach, createControl, flowHash, ready, requestStatus, validateEdgeConfiguration, protectedPath, readMarker, readResolution, admissionKey, ADMISSION_HEADER, syncDir, BASE };
if (require.main === module) {
  if (process.getuid() !== 0) fail('LIFECYCLE_ROOT_REQUIRED');
  const action = process.argv[2];
  let input = ''; process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { input += c; if (input.length > 4096) fail('LIFECYCLE_INPUT_TOO_LARGE'); });
  process.stdin.on('end', async () => {
    try { const result = await createControl()(action, JSON.parse(input)); process.stdout.write(JSON.stringify(result)); }
    catch (e) { process.stderr.write((/^LIFECYCLE_[A-Z_]+$/.test(e.message) ? e.message : 'LIFECYCLE_OPERATION_FAILED') + '\n'); process.exitCode = 1; }
  });
}
