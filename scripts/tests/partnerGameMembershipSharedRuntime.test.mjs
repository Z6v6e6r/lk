import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import ingress from "../../node-red/custom-nodes/partner-game-membership-api/partner-game-membership-ingress.cjs";
import register from "../../node-red/custom-nodes/partner-game-membership-api/partner-game-membership-node.cjs";
import settings from "../partner_game_membership_shared_runtime/settings.cjs";
import raw from "../partner_game_membership_sidecar/raw-request-guard.cjs";
import { buildPartnerGameMembershipSharedCandidate as build } from "../patch_partner_game_membership_shared_flow.mjs";

const options = { expectedHost: "fixture.invalid", audit: () => true };
function store(config = {}) {
  const types = new Map();
  register({ nodes: { registerType: (name, ctor) => types.set(name, ctor), createNode(node) {
    const events = new EventEmitter(); node.on = events.on.bind(events); node.emit = events.emit.bind(events);
  } } });
  return new (types.get("padlhub-partner-game-membership-store"))(config);
}
function guarded(body = "{}", { url = "/lk/integrations/v1/open-games/game/members", mutate, after, peer = "127.0.0.1", audit = options.audit } = {}) {
  const req = new PassThrough();
  Object.assign(req, { method: "POST", originalUrl: url, url, socket: { remoteAddress: peer }, complete: true, trailers: {}, headers: {}, headersDistinct: {} });
  req.rawHeaders = ["host", "fixture.invalid", "content-length", String(Buffer.byteLength(body)),
    ...raw.SECURITY_HEADERS.flatMap(key => [key, key === "content-type" ? "application/json" : "fixture-value"])];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    req.headers[req.rawHeaders[i]] = req.rawHeaders[i + 1]; req.headersDistinct[req.rawHeaders[i]] = [req.rawHeaders[i + 1]];
  }
  const res = new EventEmitter(); res.setHeader = () => {};
  return new Promise((resolve, reject) => {
    res.end = value => { res.emit("finish"); resolve({ error: JSON.parse(value), status: res.statusCode }); };
    mutate?.(req);
    settings.createSharedPartnerSettings({ httpAdminRoot: false }, { ...options, audit }).httpNodeMiddleware(req, res, () => {
      try { after?.(req); const result = ingress.consumePartnerIngress(req); res.emit("finish"); resolve({ result, req }); }
      catch (error) { res.emit("finish"); reject(error); }
    });
    req.end(body);
  });
}

test("shared settings preserve unrelated settings and do not touch ordinary requests", () => {
  const calls = [], req = { url: "/lk/games", originalUrl: "/lk/games" }, res = {}, context = {};
  Object.defineProperty(req, "headers", { get() { throw new Error("ordinary headers touched"); } });
  Object.defineProperty(req, "body", { get() { throw new Error("ordinary body touched"); } });
  const base = { uiPort: 1880, httpAdminRoot: "/admin", apiMaxLength: "5mb", contextStorage: context };
  const composed = settings.createSharedPartnerSettings(base, { ...options, audit: () => assert.fail("unrelated audit") });
  for (const key of Object.keys(base).filter(k => k !== "httpNodeMiddleware")) assert.equal(composed[key], base[key]);
  composed.httpNodeMiddleware(req, res, () => calls.push(3)); assert.deepEqual(calls, [3]);
});
test("unsupported global CORS, root, middleware or default admin API are refused without mutation", () => {
  for (const base of [{}, { httpAdminRoot: "/" }, { httpNodeCors: { origin: "*" }, httpAdminRoot: false }, { httpNodeMiddleware: () => {}, httpAdminRoot: false }, { httpNodeRoot: "/api", httpAdminRoot: false }, { httpNodeRoot: false, httpAdminRoot: false }]) {
    const before = { ...base }; assert.throws(() => settings.createSharedPartnerSettings(base, options), /SETTINGS_UNSUPPORTED/); assert.deepEqual(base,before);
  }
});
test("a scoped or disabled admin API remains compatible", () => {
  assert.equal(typeof settings.createSharedPartnerSettings({ httpAdminRoot: "/admin" }, options).httpNodeMiddleware, "function");
  assert.equal(typeof settings.createSharedPartnerSettings({ httpAdminRoot: false }, options).httpNodeMiddleware, "function");
});
for (const url of ["/lk/integrations/v1", "/LK/INTEGRATIONS/V1/open-games/a/members", "/lk/integrations/v1?x=1", "/lk/integrations/v1/open-games/a/members/"]) {
  test(`namespace noncanonical target rejected: ${url}`, async () => assert.equal((await guarded("{}",{url})).error.error, "RAW_ROUTE_INVALID"));
}
test("lookalike namespace stays ordinary, matched alias remains protected", () => {
  assert.equal(ingress.isPartnerRequest({url:"/lk/integrations/v10/a"}),false);
  assert.equal(ingress.isPartnerRequest({url:"/unusual",route:{path:"/lk/integrations/v1/open-games/:gameId/members"}}),true);
});
test("valid guarded command is captured once; duplicates rejected before store", async () => {
  const accepted = await guarded('{"fixture":true}'); assert.deepEqual(accepted.result[4], { fixture:true });
  assert.throws(() => ingress.consumePartnerIngress(accepted.req), { code: "PARTNER_INGRESS_REQUIRED" });
  assert.equal((await guarded('{"a":1,"a":2}')).error.error, "RAW_JSON_DUPLICATE_KEY");
});
for (const [label, after] of Object.entries({ body: r => { r.body.x = 1; }, headers: r => { r.headers.host = "other.invalid"; }, url: r => { r.url += "?x=1"; } })) {
  test(`proof rejects downstream change: ${label}`, async () => assert.rejects(guarded("{}",{after}), { code: "PARTNER_INGRESS_REQUIRED" }));
}
test("non-loopback socket cannot spoof ingress with forwarding headers", async () => {
  let event;
  assert.equal((await guarded("{}", { peer: "192.0.2.4", mutate: r => { r.headers["x-forwarded-for"] = "127.0.0.1"; }, audit: e => { event = e; return true; } })).status,503);
  assert.deepEqual({ stage: event.stage, code: event.code }, { stage: "RAW_REQUEST_GUARD", code: "RAW_PEER_INVALID" });
});
test("forged body parser flags cannot initialize shared runtime", async () => {
  const s = store({ requireIngressProof: true }); s.getRuntime = () => assert.fail("runtime touched before ingress");
  await assert.rejects(s.handleHttpMessage({req:{_body:true,skipRawBodyParser:true,headers:{},body:{}}}), {code:"PARTNER_INGRESS_REQUIRED"});
});
test("store drains active command and refuses new work during redeploy", async () => {
  const s = store(); let finish, handled = 0, closed = false;
  // Boundary test injects a service; provider/database behavior is covered separately.
  s.getRuntime = async () => ({service:{handle: () => { handled++; return new Promise(r => { finish = r; }); }}});
  const active = s.handleHttpMessage({}); await Promise.resolve();
  const closing = new Promise((resolve,reject) => s.emit("close",false,e => { closed = true; e ? reject(e) : resolve(); }));
  assert.equal(closed,false);
  await assert.rejects(s.handleHttpMessage({}),{code:"PARTNER_API_CLOSING"});
  finish({statusCode:200}); await active; await closing; assert.equal(handled,1);
});
test("shared builder preserves source and creates only its own guarded tab", () => {
  const source = [{id:"t",type:"tab",label:"LK Games"},{id:"n",type:"http in",url:"/lk/games/:id",method:"get",z:"t"}];
  const before = structuredClone(source), result = build(source);
  assert.deepEqual(source,before); assert.deepEqual(result.flow.slice(0,source.length),before);
  assert.equal(result.addedNodeIds.length,8);
  const added = result.flow.slice(source.length), tab = added.find(n => n.type === "tab");
  assert.equal(added.find(n => n.type === "padlhub-partner-game-membership-store").requireIngressProof,true);
  assert.equal(added.filter(n => n.type === "http in").length,3);
  assert.ok(added.filter(n => n.z).every(n => n.z === tab.id));
  assert.throws(() => build(result.flow), /already exists/);
});
for (const url of ["/lk/integrations/v1", "/LK/INTEGRATIONS/V1/operations/:id", "/lk/*", "/:anything", "*", "/lk/integrations/:version/anything"]) {
  test(`builder refuses overlapping route ${url}`, () => assert.throws(() => build([{id:"r",type:"http in",url}]), /overlap/));
}
