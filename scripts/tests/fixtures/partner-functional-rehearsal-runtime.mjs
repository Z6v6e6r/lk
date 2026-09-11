// Executed ONLY inside the network-none, portless owned functional rehearsal
// container created by scripts/rehearse_partner_game_membership_runtime_functional.mjs.
// The exact runtime was installed by the separate bridge-network install container
// and is mounted read-only here, so no outbound access is possible while probing.
// It proves custom-node load / default-off / flow-removal / package-removal
// compatibility against the pinned linux/amd64 runtime. It is not a deploy test.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const input = "/input";
const output = "/output";
const installedRuntime = path.join(input, "runtime");
const work = path.join(output, "work");
const partnerPackage = path.join(work, "node_modules/@padlhub/node-red-partner-game-membership-api");
const port = 18894;
const save = (name, value) => fs.writeFileSync(
  path.join(output, name),
  typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
  { mode: 0o600 },
);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function partnerFlowMatches(flowFile) {
  return readJson(flowFile).filter((node) => (
    String(node.type || "").startsWith("padlhub-partner-game-membership")
    || (node.type === "http in" && String(node.url || "").startsWith("/lk/integrations/v1/"))
  )).length;
}

function palettePartnerMatches() {
  const manifest = path.join(partnerPackage, "package.json");
  if (!fs.existsSync(manifest)) return 0;
  const nodeRed = readJson(manifest)["node-red"];
  return nodeRed && nodeRed.nodes ? Object.keys(nodeRed.nodes).length : 0;
}

function launch(flowFile, userDir) {
  const child = spawn(process.execPath, [
    path.join(work, "node_modules/.bin/node-red"),
    "--userDir", userDir,
    "--settings", path.join(work, "settings.cjs"),
    flowFile,
  ], { env: { PATH: process.env.PATH, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"] });
  let text = "";
  child.stdout.on("data", (chunk) => { text += chunk; });
  child.stderr.on("data", (chunk) => { text += chunk; });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  return { child, exited, output: () => text };
}

async function start(flowFile, userDir) {
  fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
  const service = launch(flowFile, userDir);
  for (let i = 0; i < 900; i += 1) {
    if (service.output().includes("Started flows")) return service;
    if (service.child.exitCode !== null) throw new Error(`STARTUP_FAILED: ${service.output()}`);
    await delay(100);
  }
  throw new Error(`STARTUP_TIMEOUT: ${service.output()}`);
}

async function stop(service) {
  service.child.kill("SIGINT");
  const result = await Promise.race([
    service.exited,
    delay(20000).then(() => { throw new Error("STOP_TIMEOUT"); }),
  ]);
  assert.equal(result.code, 0, `stop exit code: ${result.code}`);
  assert.match(service.output(), /Stopping flows/);
  assert.match(service.output(), /Stopped flows/);
}

function request(method, url, body = "{}") {
  const payload = method === "GET" ? "" : body;
  return new Promise((resolve, reject) => {
    const headers = { Host: "unbound.invalid", Connection: "close" };
    if (method !== "GET") {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    const req = http.request({ host: "127.0.0.1", port, method, path: url, headers, timeout: 5000 }, (res) => {
      let data = "";
      res.on("data", (part) => { data += part; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("HTTP_TIMEOUT")));
    req.end(payload);
  });
}

async function main() {
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  assert.equal(process.version, "v22.23.2");
  const installedPackageCount = Number(process.env.PARTNER_INSTALLED_PACKAGE_COUNT);
  assert.ok(Number.isSafeInteger(installedPackageCount) && installedPackageCount > 0, "missing install count from the install container");

  // The installed runtime is mounted read-only; copy it so package removal can be
  // exercised without touching the pinned input.
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  fs.cpSync(installedRuntime, work, { recursive: true, dereference: false, verbatimSymlinks: true });
  assert.equal(readJson(path.join(work, "node_modules/node-red/package.json")).version, "5.0.6");
  assert.equal(fs.existsSync(partnerPackage), true, "custom node must be installed by the install container");

  const settings = `"use strict";
module.exports = {
  uiHost: "127.0.0.1",
  uiPort: ${port},
  httpNodeRoot: "/",
  httpAdminRoot: false,
  disableEditor: true,
  credentialSecret: false,
  flowFilePretty: true,
  nodesDir: ${JSON.stringify(partnerPackage)},
  contextStorage: { default: { module: "memory" } },
  externalModules: { autoInstall: false, palette: { allowInstall: false, allowUpload: false }, modules: { allowInstall: false } },
  logging: { console: { level: "info", metrics: false, audit: false } },
};
`;
  fs.writeFileSync(path.join(work, "settings.cjs"), settings, { mode: 0o600 });

  const candidateFlow = path.join(input, "flows/candidate.flow.json");
  const sourceFlow = path.join(input, "flows/source.flow.json");
  const candidateFlowSha256 = sha(fs.readFileSync(candidateFlow));
  const sourceFlowSha256 = sha(fs.readFileSync(sourceFlow));
  const results = { installedPackageCount, candidateFlowSha256, sourceFlowSha256 };

  // 1. Candidate load with the runtime default-off: every business route must be
  // refused before any provider or database access. The container has no network,
  // so an outbound Mongo or Viva call is impossible by construction.
  let service = await start(candidateFlow, path.join(output, "candidate-state"));
  const defaultOffRoutes = [];
  for (const [method, url, body] of [
    ["POST", "/lk/integrations/v1/open-games/fixture-game/members", "{}"],
    ["DELETE", "/lk/integrations/v1/open-games/fixture-game/members/fixture-member", "{}"],
    ["GET", "/lk/integrations/v1/operations/fixture-op", ""],
  ]) {
    const res = await request(method, url, body);
    assert.equal(res.status, 503, `${method} expected default-off 503`);
    assert.equal(JSON.parse(res.body).error.code, "PARTNER_API_DISABLED");
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.headers["access-control-allow-origin"], undefined);
    defaultOffRoutes.push(`${method}:${res.status}`);
  }
  assert.equal((await request("GET", "/", "")).status, 404, "admin root must stay disabled");
  results.defaultOff = {
    httpStatus: 503, cacheControl: "no-store", corsResponseHeader: null,
    errorCode: "PARTNER_API_DISABLED", mongoCalls: 0, vivaCalls: 0, routes: defaultOffRoutes,
    adminHttpStatus: 404,
  };
  await stop(service);
  results.shutdown = { logMarkers: ["Stopping flows", "Stopped flows"] };

  // 2. Flow removal: the package stays installed, only the partner routes are gone.
  service = await start(sourceFlow, path.join(output, "flow-rollback-state"));
  const flowRollback = await request("GET", "/lk/integrations/v1/operations/fixture-op", "");
  assert.equal(flowRollback.status, 404);
  await stop(service);
  results.flowRollback = { httpStatus: flowRollback.status, partnerFlowMatches: partnerFlowMatches(sourceFlow) };
  assert.equal(results.flowRollback.partnerFlowMatches, 0);

  // 3. Package removal: the custom node is no longer installed, so the partner
  // palette entry disappears; the flow is absent as well.
  fs.rmSync(path.join(work, "node_modules/@padlhub"), { recursive: true, force: true });
  const packageLinkPresent = fs.existsSync(partnerPackage);
  assert.equal(packageLinkPresent, false);
  service = await start(sourceFlow, path.join(output, "package-rollback-state"));
  const packageRollback = await request("GET", "/lk/integrations/v1/operations/fixture-op", "");
  assert.equal(packageRollback.status, 404);
  await stop(service);
  results.packageRollback = {
    httpStatus: packageRollback.status, packageLinkPresent, palettePartnerMatches: palettePartnerMatches(),
  };
  assert.equal(results.packageRollback.palettePartnerMatches, 0);

  save("functional-observation.json", {
    state: "LOCAL_FUNCTIONAL_REHEARSAL_PASS_NOT_PRODUCTION",
    platform: process.platform, architecture: process.arch, nodeVersion: process.version.slice(1),
    nodeRedVersion: "5.0.6", productionTouched: false, results,
  });
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
