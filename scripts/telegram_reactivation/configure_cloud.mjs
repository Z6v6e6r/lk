import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// One-off administrator tool. Never install it as a Function library.
// Existing credentials stay in memory and are sent only to this app's loopback API.
const fail = code => { throw new Error(code); };
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const names = ['TG_REACTIVATION_MONGO_URI', 'TG_REACTIVATION_BOT_TOKEN'];

export const controllerFingerprint = node => digest(JSON.stringify({
  func:node.func, initialize:node.initialize, finalize:node.finalize, libs:node.libs
}));
export const mongoFingerprint = node => digest(JSON.stringify({
  hostname:node.hostname,port:node.port,db:node.db,connectOptions:node.connectOptions,topology:node.topology
}));

export function validatePlan(plan) {
  const keys = ['userDir','port','adminRoot','username','flowId','controllerId','controllerHash','mongoId','mongoHash','botConfigId','botId','database'];
  if (!plan || Object.keys(plan).some(k => !keys.includes(k)) || keys.some(k => plan[k] === undefined)) fail('invalid_setup_plan');
  if (!path.isAbsolute(plan.userDir) || !Number.isInteger(plan.port) || plan.port < 1 || plan.port > 65535 ||
      !/^\/[A-Za-z0-9/_-]*$/.test(plan.adminRoot) || !/^[A-Za-z0-9_-]+$/.test(plan.username) ||
      !['flowId','controllerId','mongoId','botConfigId'].every(k => /^[A-Za-z0-9_-]+$/.test(plan[k])) ||
      !/^[a-f0-9]{64}$/.test(plan.controllerHash) || !/^[a-f0-9]{64}$/.test(plan.mongoHash) ||
      !/^\d+$/.test(plan.botId) || !/^[A-Za-z0-9_-]+$/.test(plan.database)) fail('invalid_setup_plan');
  if (new Set([plan.flowId,plan.controllerId,plan.mongoId,plan.botConfigId]).size !== 4) fail('invalid_setup_plan');
  return plan;
}

export function decodeStore(store, secrets) {
  if (!store || typeof store.$ !== 'string' || !/^[a-f0-9]{32}/i.test(store.$)) fail('encrypted_store_required');
  for (const secret of [...new Set(secrets)].filter(s => typeof s === 'string' && s.length)) {
    try {
      const key = crypto.createHash('sha256').update(secret).digest();
      const d = crypto.createDecipheriv('aes-256-ctr', key, Buffer.from(store.$.slice(0,32),'hex'));
      const value = JSON.parse(d.update(store.$.slice(32),'base64','utf8') + d.final('utf8'));
      if (value && !Array.isArray(value) && typeof value === 'object') return value;
    } catch { /* Never expose JSON/crypto diagnostics containing credential bytes. */ }
  }
  fail('credential_store_unavailable');
}

export function chooseSession(sessions, username, now = Date.now()) {
  if (!sessions || Array.isArray(sessions) || typeof sessions !== 'object') fail('admin_session_unavailable');
  // Conservative: only an existing full-scope session for the named operator.
  const candidates = Object.entries(sessions).filter(([key,s]) => s && s.user === username && s.scope === '*' &&
    typeof s.accessToken === 'string' && key === s.accessToken && Number.isFinite(s.expires) && s.expires > now);
  candidates.sort((a,b) => b[1].expires - a[1].expires);
  if (!candidates.length) fail('admin_session_unavailable');
  return candidates[0][1].accessToken;
}

export function buildUpdate(snapshot, credentials, plan) {
  validatePlan(plan);
  if (!snapshot?.rev || !Array.isArray(snapshot.flows)) fail('flow_snapshot_unavailable');
  const source = snapshot.flows;
  const one = id => {
    const matches = source.filter(n => n.id === id);
    if (matches.length !== 1) fail('setup_target_mismatch');
    return matches[0];
  };
  const tab = one(plan.flowId), controller = one(plan.controllerId), mongoNode = one(plan.mongoId), bot = one(plan.botConfigId);
  if (tab.type !== 'tab' || controller.type !== 'function' || controller.z !== tab.id ||
      controllerFingerprint(controller) !== plan.controllerHash || mongoNode.type !== 'mongodb' ||
      bot.type !== 'telegram bot' || mongoNode.db !== plan.database || mongoFingerprint(mongoNode) !== plan.mongoHash) fail('setup_target_mismatch');
  if (source.some(n => n.z === tab.id && n.type === 'inject' && (n.once || n.repeat || n.crontab))) fail('automatic_sender_forbidden');
  const children = source.filter(n => n.z === tab.id);
  const ids = new Set([tab.id,...children.map(n => n.id)]);
  if (children.some(n => !['function','inject','debug'].includes(n.type) ||
      (n.type === 'function' && n.id !== controller.id) || (n.wires ?? []).flat().some(id => !ids.has(id)))) fail('unexpected_sender_node');
  const env = tab.env ?? [];
  if (new Set(env.map(e => e.name)).size !== env.length) fail('setup_target_mismatch');
  if (!env.some(e => e.name === 'TG_REACTIVATION_SEND_ENABLED' && e.type === 'str' && e.value === 'false') ||
      !env.some(e => e.name === 'TG_REACTIVATION_MONGO_DB' && e.type === 'str' && e.value === plan.database)) fail('sender_must_be_disabled');
  if (env.some(e => names.includes(e.name))) fail('destination_credentials_already_present');
  if (credentials[plan.flowId] && Object.keys(credentials[plan.flowId]).length) fail('destination_credentials_already_present');
  const m = credentials[plan.mongoId], t = credentials[plan.botConfigId];
  if (!m || typeof m.user !== 'string' || !m.user || typeof m.password !== 'string' || !m.password ||
      !t || typeof t.token !== 'string' || !new RegExp('^' + plan.botId + ':[A-Za-z0-9_-]{20,}$').test(t.token.trim())) fail('source_credentials_unavailable');
  // Narrow supported profile: existing SRV host includes its auth database and query.
  // Do not append the operations db after a query as this legacy config node does.
  if (mongoNode.topology !== 'dnscluster' || typeof mongoNode.hostname !== 'string' ||
      !/^[A-Za-z0-9.-]+\/[A-Za-z0-9_-]+\?[^\s#@]+$/.test(mongoNode.hostname) || mongoNode.connectOptions) fail('unsupported_mongo_configuration');
  const address = new URL('mongodb+srv://' + mongoNode.hostname);
  const options = [...address.searchParams];
  const validOptions = {retryWrites:/^(true|false)$/,w:/^majority$/,authSource:/^[A-Za-z0-9_-]+$/};
  if (!options.length || new Set(options.map(([k])=>k)).size !== options.length ||
      options.some(([k,v])=>!validOptions[k]?.test(v))) fail('unsupported_mongo_configuration');
  const uri = 'mongodb+srv://' + encodeURIComponent(m.user) + ':' + encodeURIComponent(m.password) + '@' + mongoNode.hostname;
  const flows = structuredClone(source);
  const target = flows.find(n => n.id === tab.id);
  target.env = [...env, ...names.map(name => ({name,type:'cred'}))];
  target.credentials = { TG_REACTIVATION_MONGO_URI: uri, TG_REACTIVATION_BOT_TOKEN: t.token.trim() };
  return { rev: snapshot.rev, flows };
}

function jsonFile(p) {
  const s = fs.lstatSync(p);
  if (!s.isFile() || s.isSymbolicLink()) fail('invalid_private_store');
  return JSON.parse(fs.readFileSync(p,'utf8'));
}

export function loopbackRequest(plan, bearer, method, route, body) {
  return new Promise((resolve,reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { Authorization: 'Bearer ' + bearer, 'Node-RED-API-Version': 'v2' };
    if (data !== null) Object.assign(headers, {'Content-Type':'application/json','Node-RED-Deployment-Type':'nodes','Content-Length':Buffer.byteLength(data)});
    const req = http.request({hostname:'127.0.0.1',port:plan.port,path:plan.adminRoot.replace(/\/$/,'') + route,method,headers},res => {
      let result = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { result += chunk; if (result.length > 12_000_000) req.destroy(); });
      res.on('error', () => reject(new Error('admin_request_failed')));
      res.on('aborted', () => reject(new Error('admin_request_failed')));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('admin_request_rejected'));
        try { resolve(result ? JSON.parse(result) : null); } catch { reject(new Error('admin_response_invalid')); }
      });
    });
    req.setTimeout(30000, () => req.destroy());
    req.on('error', () => reject(new Error('admin_request_failed')));
    req.end(data);
  });
}

export async function configure(plan, {apply=false, request=loopbackRequest} = {}) {
  validatePlan(plan);
  const require = createRequire(path.join(plan.userDir,'settings.js'));
  // Existing trusted application settings execute synchronously. Suppress their
  // incidental console output as well; this CLI must never forward config data.
  const out = process.stdout.write, err = process.stderr.write;
  let settings;
  try {
    const settingsPath = path.join(plan.userDir,'settings.js');
    const stat = fs.lstatSync(settingsPath);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('invalid_private_store');
    process.stdout.write = process.stderr.write = () => true;
    settings = require(settingsPath);
  } finally { process.stdout.write = out; process.stderr.write = err; }
  if (settings.credentialSecret === false || settings.safeMode || settings.editorTheme?.projects?.enabled) fail('unsupported_credential_configuration');
  const runtime = jsonFile(path.join(plan.userDir,'.config.runtime.json'));
  // Existing generated key is tried first, matching core's credential-key migration path.
  const secrets = [settings._credentialSecret, runtime._credentialSecret, settings.credentialSecret];
  const credentials = decodeStore(jsonFile(path.join(plan.userDir,'flows_cred.json')), secrets);
  const bearer = chooseSession(jsonFile(path.join(plan.userDir,'.sessions.json')), plan.username);
  const before = await request(plan,bearer,'GET','/flows');
  const update = buildUpdate(before,credentials,plan);
  if (!apply) return { checked:true, changed:false, targetFlow:plan.flowId, sendingEnabled:false };
  const applied = await request(plan,bearer,'POST','/flows',update);
  const after = await request(plan,bearer,'GET','/flows');
  const others = snapshot => digest(JSON.stringify(snapshot.flows.filter(n => n.id !== plan.flowId)));
  const tab = after?.flows?.find(n => n.id === plan.flowId);
  const expectedTab = structuredClone(update.flows.find(n => n.id === plan.flowId));
  delete expectedTab.credentials;
  if (!tab || typeof applied?.rev !== 'string' || after.rev !== applied.rev ||
      others(before) !== others(after) || JSON.stringify(tab) !== JSON.stringify(expectedTab)) fail('setup_readback_failed');
  const persisted = decodeStore(jsonFile(path.join(plan.userDir,'flows_cred.json')), secrets)[plan.flowId];
  const wanted = update.flows.find(n => n.id === plan.flowId).credentials;
  if (!persisted || names.some(name => persisted[name] !== wanted[name])) fail('setup_readback_failed');
  return { configured:true, changed:true, targetFlow:plan.flowId, sendingEnabled:false, otherNodesUnchanged:true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [planPath,mode] = process.argv.slice(2);
    if (!planPath || !path.isAbsolute(planPath) || !['--check','--apply'].includes(mode)) fail('invalid_setup_arguments');
    const result = await configure(jsonFile(planPath),{apply:mode === '--apply'});
    console.log(JSON.stringify(result));
  } catch {
    // Deliberately suppress every driver, response, stack and filesystem detail.
    console.error('cloud_configuration_failed');
    process.exitCode = 1;
  }
}
