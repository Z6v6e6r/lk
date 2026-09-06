"use strict";
// Executed ONLY inside the network-none, portless owned rehearsal container.
const fs = require("node:fs");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");
const root = "/opt/padlhub/partner-game-membership/current";
const state = "/var/lib/padlhub/partner-game-membership";
const unitLines = fs.readFileSync(`${root}/sidecar/partner-game-membership-sidecar.service`, "utf8").split("\n");
const commands = unitLines.filter((line) => line.startsWith("ExecStart=")); assert.equal(commands.length, 1);
const unitCommand = commands[0].slice("ExecStart=".length).split(" ");
assert.deepEqual(unitCommand, [`${root}/runtime/node_modules/.bin/node-red`, "--userDir", state, "--settings", `${root}/sidecar/settings-runtime.cjs`, `${root}/candidate.flow.json`]);
const declaredEnvironment = unitLines.filter((line) => line.startsWith("Environment=")).map((line) => line.slice("Environment=".length).split("="));
assert.deepEqual(declaredEnvironment, [["NODE_ENV", "production"], ["LK_PARTNER_GAME_API_ENABLED", "false"], ["LK_PARTNER_GAME_API_PROVIDER_MODE", "disabled"], ["LK_PARTNER_GAME_API_VIVA_MUTATIONS_ENABLED", "false"]]);
assert.deepEqual(unitLines.filter((line) => line.startsWith("UnsetEnvironment=")), ["UnsetEnvironment=NODE_OPTIONS NODE_PATH NODE_RED_ENABLE_SAFE_MODE NODE_RED_ENABLE_PROJECTS"]);
assert.equal(unitLines.some((line) => line.startsWith("EnvironmentFile=")), false);
const env = { PATH: process.env.PATH, ...Object.fromEntries(declaredEnvironment) };
const rows = [];
const active = new Set();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function launch(base = root, userDir = state, extra = [], overrides = {}) {
  const args = [...unitCommand]; args[2] = userDir; args[4] = `${base}/sidecar/settings-runtime.cjs`; args[5] = `${base}/candidate.flow.json`;
  const child = spawn(process.execPath, [...args, ...extra], { env: { ...env, ...overrides }, stdio: ["ignore", "pipe", "pipe"] });
  active.add(child); let output = "";
  child.stdout.on("data", (data) => { output += data; }); child.stderr.on("data", (data) => { output += data; });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => { active.delete(child); resolve({ code, signal }); }));
  return { child, exited, output: () => output };
}
async function bounded(promise, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 15000); })]); }
  finally { clearTimeout(timer); }
}
async function start() {
  const process = launch();
  for (let i = 0; i < 150; i++) {
    if (process.output().includes("Started flows")) return process;
    if (process.child.exitCode !== null) throw new Error(`STARTUP_FAILED: ${process.output()}`);
    await delay(100);
  }
  throw new Error(`STARTUP_TIMEOUT: ${process.output()}`);
}
function request(method, url, body = "{}", duplicate = false) {
  const { SECURITY_HEADERS } = require(`${root}/sidecar/raw-request-guard.cjs`);
  const headers = ["Host", "unbound.invalid", "Connection", "close", "Content-Length", String(Buffer.byteLength(body)),
    ...SECURITY_HEADERS.flatMap((name) => [name, name === "content-type" ? "application/json" : "fixture-value"])];
  if (duplicate) headers.push("X-Padlhub-Nonce", "fixture-value");
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: 18894, method, path: url, headers, timeout: 5000 }, (res) => {
      let data = ""; res.on("data", (part) => { data += part; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("HTTP_TIMEOUT"))); req.end(body);
  });
}
async function stop(process) {
  process.child.kill("SIGINT"); const result = await bounded(process.exited, "STOP_TIMEOUT");
  assert.equal(result.code, 0); assert.match(process.output(), /Stopping flows/); assert.match(process.output(), /Stopped flows/);
  assert.equal(fs.existsSync(`${state}/raw-requests.audit.lock`), false);
  await assert.rejects(request("GET", "/", ""), { code: "ECONNREFUSED" });
}
async function main() {
  assert.equal(process.version, "v22.23.2"); assert.equal(process.platform, "linux"); assert.equal(process.arch, "x64");
  assert.equal(require(`${root}/runtime/node_modules/node-red/package.json`).version, "5.0.6");
  assert.equal(fs.lstatSync(root).isSymbolicLink(), true); assert.deepEqual(fs.readdirSync(state), []);
  let service = await start();
  const listeners = ["/proc/net/tcp", "/proc/net/tcp6"].flatMap((file) => fs.readFileSync(file, "utf8").trim().split("\n").slice(1))
    .map((line) => line.trim().split(/\s+/)).filter((columns) => columns[3] === "0A" && columns[1].endsWith(":49CE"));
  assert.equal(listeners.length, 1); assert.equal(listeners[0][1], "0100007F:49CE"); rows.push("loopback-listener-only");
  for (const [method, url, body] of [
    ["POST", "/lk/integrations/v1/open-games/fixture-game/members", "{}"],
    ["DELETE", "/lk/integrations/v1/open-games/fixture-game/members/fixture-member", "{}"],
    ["GET", "/lk/integrations/v1/operations/fixture-op", ""],
  ]) {
    const res = await request(method, url, body); assert.equal(res.status, 503); assert.equal(JSON.parse(res.body).error.code, "PARTNER_API_DISABLED");
    assert.equal(res.headers["cache-control"], "no-store"); assert.equal(res.headers["access-control-allow-origin"], undefined);
    rows.push(`${method}:business-default-off`);
  }
  for (const [name, body, duplicate, code] of [["duplicate-header", "{}", true, "RAW_HEADER_DUPLICATE"], ["duplicate-json", '{"x":1,"x":2}', false, "RAW_JSON_DUPLICATE_KEY"]]) {
    const res = await request("POST", "/lk/integrations/v1/open-games/fixture-game/members", body, duplicate);
    assert.equal(res.status, 400); assert.equal(JSON.parse(res.body).error, code); rows.push(name);
  }
  assert.equal((await request("GET", "/", "")).status, 404); rows.push("admin-disabled");
  let audit = fs.readFileSync(`${state}/raw-requests.audit.jsonl`, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(audit.map((row) => row.code), ["RAW_ACCEPTED", "RAW_ACCEPTED", "RAW_ACCEPTED", "RAW_HEADER_DUPLICATE", "RAW_JSON_DUPLICATE_KEY"]);
  assert.doesNotMatch(JSON.stringify(audit), /fixture-value|fixture-game|fixture-member/); rows.push("durable-private-audit");
  await stop(service); rows.push("graceful-stop-no-listener");
  service = await start(); assert.equal((await request("GET", "/lk/integrations/v1/operations/fixture-op", "")).status, 503);
  await stop(service); rows.push("restart-existing-audit");
  const negatives = ["define", "safe", "duplicate-settings", "env-safe", "env-projects", "enabled", "digest", "empty-flow", "skip-body", "audit-tail"];
  for (const name of negatives) {
    const base = `/tmp/negative-${name}`; fs.mkdirSync(base); fs.cpSync(`${root}/sidecar`, `${base}/sidecar`, { recursive: true });
    fs.copyFileSync(`${root}/candidate.flow.json`, `${base}/candidate.flow.json`); fs.symlinkSync(`${root}/runtime`, `${base}/runtime`);
    const userDir = `${base}/state`; fs.mkdirSync(userDir, { mode: 0o700 }); let extra = []; let overrides = {};
    if (name === "define") extra = ["--def", "httpAdminRoot=/admin"];
    if (name === "safe") extra = ["--sa"];
    if (name === "duplicate-settings") extra = ["--settings", `${base}/sidecar/settings-runtime.cjs`];
    if (name === "env-safe") overrides = { NODE_RED_ENABLE_SAFE_MODE: "0" };
    if (name === "env-projects") overrides = { NODE_RED_ENABLE_PROJECTS: "1" };
    if (name === "enabled") overrides = { LK_PARTNER_GAME_API_ENABLED: "true" };
    if (name === "digest") fs.appendFileSync(`${base}/candidate.flow.json`, " ");
    if (["empty-flow", "skip-body"].includes(name)) {
      const flow = JSON.parse(fs.readFileSync(`${base}/candidate.flow.json`));
      if (name === "skip-body") flow.find((node) => node.type === "http in").skipBodyParsing = true;
      const bytes = JSON.stringify(name === "empty-flow" ? flow.filter((node) => node.type === "tab") : flow);
      fs.writeFileSync(`${base}/candidate.flow.json`, bytes);
      const policy = JSON.parse(fs.readFileSync(`${base}/sidecar/guarded-runtime-policy.json`));
      policy.candidateFlowSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      fs.writeFileSync(`${base}/sidecar/guarded-runtime-policy.json`, JSON.stringify(policy));
    }
    if (name === "audit-tail") fs.writeFileSync(`${userDir}/raw-requests.audit.jsonl`, "{", { mode: 0o600 });
    const rejected = launch(base, userDir, extra, overrides); const result = await bounded(rejected.exited, "NEGATIVE_TIMEOUT");
    assert.notEqual(result.code, 0); assert.doesNotMatch(rejected.output(), /Started flows|Server now running/);
    assert.match(rejected.output(), /PARTNER_GUARDED_STARTUP_REFUSED/);
    await assert.rejects(request("GET", "/", ""), { code: "ECONNREFUSED" }); rows.push(`startup-refused:${name}`);
  }
  audit = fs.readFileSync(`${state}/raw-requests.audit.jsonl`, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(audit.length, 6);
  fs.writeFileSync("/out/probes.json", JSON.stringify({ state: "LOCAL_GUARDED_STARTUP_PASS_NOT_PRODUCTION", rows, auditRows: audit.length,
    nodeVersion: process.version, nodeRedVersion: "5.0.6", platform: process.platform, architecture: process.arch,
    actualNodeRedCli: true, serviceCommandAndEnvironmentVerified: true, currentSymlink: true, systemdExecuted: false, productionTouched: false }, null, 2) + "\n");
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => { for (const child of active) child.kill("SIGINT"); });
