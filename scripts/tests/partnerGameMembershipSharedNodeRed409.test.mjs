import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runtime = "/private/tmp/partner-shared-runtime-20260910/node_modules/node-red/red.js";
const packageRoot = path.join(root, "node-red/custom-nodes/partner-game-membership-api");
const adapter = path.join(root, "scripts/partner_game_membership_shared_runtime/settings.cjs");
const ingress = path.join(packageRoot, "partner-game-membership-ingress.cjs");
const rawHeaders = {
  host: "fixture.invalid", "content-type": "application/json",
  "x-padlhub-client-id": "fixture-client", "x-padlhub-audience": "fixture-audience",
  "x-padlhub-key-id": "fixture-key", "x-padlhub-timestamp": "1234567890",
  "x-padlhub-nonce": "fixture-nonce", "idempotency-key": "00000000-0000-4000-8000-000000000001",
  "x-correlation-id": "00000000-0000-4000-8000-000000000002", "x-padlhub-signature": "fixture-signature",
};
const port = () => new Promise((resolve, reject) => {
  const server = net.createServer(); server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(error => error ? reject(error) : resolve(value)); });
});
const request = (portNumber, target, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port: portNumber, path: target, method: "POST", headers: { "content-length": "2", ...headers } }, res => {
    let body = ""; res.setEncoding("utf8"); res.on("data", part => { body += part; }); res.on("end", () => resolve({ status: res.statusCode, body }));
  });
  req.once("error", reject); req.end("{}");
});
const waitFor = (child, pattern) => new Promise((resolve, reject) => {
  let output = ""; const timeout = setTimeout(() => reject(new Error(`Node-RED did not start: ${output}`)), 15_000);
  const onData = chunk => { output += chunk; if (pattern.test(output)) { clearTimeout(timeout); resolve(output); } };
  child.stdout.on("data", onData); child.stderr.on("data", onData); child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Node-RED exited ${code}: ${output}`)); });
});

test("Node-RED 4.0.9 runs ordinary HTTP and guarded disabled Partner route once", { timeout: 30_000 }, async (t) => {
  assert.equal(fs.existsSync(runtime), true, "install Node-RED 4.0.9 in the documented temporary runtime");
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "partner-shared-nr409-"));
  t.after(() => fs.rmSync(userDir, { recursive: true, force: true }));
  const portNumber = await port();
  const moduleDir = path.join(userDir, "node_modules/@padlhub"); fs.mkdirSync(moduleDir, { recursive: true });
  fs.symlinkSync(packageRoot, path.join(moduleDir, "node-red-partner-game-membership-api"), "dir");
  fs.writeFileSync(path.join(userDir, "settings.js"), `const c=require(${JSON.stringify(adapter)});module.exports=c.createSharedPartnerSettings({uiHost:'127.0.0.1',uiPort:${portNumber},flowFile:'flows.json',httpNodeRoot:'/',httpAdminRoot:false},{expectedHost:'fixture.invalid',audit:()=>true},require(${JSON.stringify(ingress)}));\n`);
  fs.writeFileSync(path.join(userDir, "flows.json"), JSON.stringify([
    { id: "tab", type: "tab", label: "fixture" },
    { id: "ordinary-in", type: "http in", z: "tab", url: "/ordinary", method: "post", wires: [["ordinary-fn"]] },
    { id: "ordinary-fn", type: "function", z: "tab", func: "msg.payload={ordinary:true};return msg;", wires: [["ordinary-out"]] },
    { id: "ordinary-out", type: "http response", z: "tab" },
    { id: "store", type: "padlhub-partner-game-membership-store", name: "off", requireIngressProof: true },
    { id: "partner-in", type: "http in", z: "tab", url: "/lk/integrations/v1/open-games/:gameId/members", method: "post", upload: false, wires: [["partner-handler"]] },
    { id: "partner-handler", type: "padlhub-partner-game-membership-http", z: "tab", store: "store", wires: [["partner-out"]] },
    { id: "partner-out", type: "http response", z: "tab" },
  ]));
  const child = spawn(process.execPath, [runtime, "--userDir", userDir, "--settings", path.join(userDir, "settings.js")], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (!child.killed) child.kill("SIGTERM"); });
  await waitFor(child, /Started flows/);
  const ordinary = await request(portNumber, "/ordinary");
  assert.equal(ordinary.status, 200, ordinary.body);
  assert.doesNotThrow(() => JSON.parse(ordinary.body), ordinary.body);
  assert.deepEqual(JSON.parse(ordinary.body), { ordinary: true });
  const partner = await request(portNumber, "/lk/integrations/v1/open-games/game/members", rawHeaders);
  assert.equal(partner.status, 503, partner.body); assert.equal(JSON.parse(partner.body).error.code, "PARTNER_API_DISABLED");
});
