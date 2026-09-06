#!/usr/bin/env node
// Explicit local Docker rehearsal, never a production/deployment entry point.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import guardModule from "./partner_game_membership_sidecar/raw-request-guard.cjs";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const NODE = "node@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96";
const NGINX = "nginx@sha256:2e26275ed7a47e8e93f264d39a09ca4bc3f4058c904c75087e237f4ea883f2a1";
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024, ...options }).trim();
const docker = (...args) => run("docker", args);
if (process.argv.slice(2).join(" ") !== "--install-locked-runtime") throw new Error("Usage: --install-locked-runtime (explicit local Docker/npm registry access)");
const output = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "partner-raw-guard-rehearsal-"));
fs.chmodSync(output, 0o700);
const runtime = path.join(output, "runtime");
const fixture = path.join(output, "fixture");
const results = path.join(output, "results");
const runId = crypto.randomBytes(8).toString("hex");
const label = `padlhub.partner-raw-guard=${runId}`;
const owned = [];
const receipt = { scope: "LOCAL_RAW_GUARD_ONLY", productionTouched: false, runId, output,
  orchestratorSha256: sha(fs.readFileSync(fileURLToPath(import.meta.url))), sources: {}, containers: [], cleanup: [] };
function prepareFixture() {
fs.mkdirSync(results, { mode: 0o700 });
fs.mkdirSync(runtime, { mode: 0o700 });
fs.mkdirSync(path.join(runtime, "partner-package"));
fs.mkdirSync(fixture, { mode: 0o700 });
for (const name of ["package.json", "package-lock.json"]) {
  const bytes = fs.readFileSync(path.join(scripts, "partner_game_membership_runtime", name));
  fs.writeFileSync(path.join(runtime, name), bytes);
  receipt.sources[`partner_game_membership_runtime/${name}`] = sha(bytes);
}
for (const name of ["package.json", "package-lock.json", "partner-game-membership-core.mjs", "partner-game-membership-mongo.mjs",
  "partner-game-membership-viva.mjs", "partner-game-membership-node.cjs", "partner-game-membership-node.html"]) {
  const relative = `../node-red/custom-nodes/partner-game-membership-api/${name}`;
  const bytes = fs.readFileSync(path.join(scripts, relative));
  fs.writeFileSync(path.join(runtime, "partner-package", name), bytes);
  receipt.sources[relative] = sha(bytes);
}
const sources = {
  "settings.cjs": "partner_game_membership_sidecar/settings.cjs",
  "settings-guarded.cjs": "partner_game_membership_sidecar/settings-guarded.cjs",
  "raw-request-guard.cjs": "partner_game_membership_sidecar/raw-request-guard.cjs",
  "runner.cjs": "tests/fixtures/partner-raw-guard-runtime.cjs",
  "http-fixture.cjs": "tests/fixtures/partner-raw-guard-http.cjs",
};
for (const [name, source] of Object.entries(sources)) {
  const bytes = fs.readFileSync(path.join(scripts, source));
  fs.writeFileSync(path.join(fixture, name), bytes);
  receipt.sources[source] = sha(bytes);
}
// Ephemeral self-signed fixture identities, never imported from the host or Git.
const openssl = (...args) => run("openssl", args, { cwd: fixture, stdio: ["ignore", "pipe", "pipe"] });
receipt.opensslVersion = openssl("version");
openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Local raw guard fixture CA", "-keyout", "ca.key", "-out", "ca.crt");
for (const name of ["server", "client"]) {
  openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", `/CN=${name === "server" ? "fixture.invalid" : "local-fixture-client"}`, "-keyout", `${name}.key`, "-out", `${name}.csr`);
  fs.writeFileSync(path.join(fixture, `${name}.ext`), name === "server" ? "subjectAltName=DNS:fixture.invalid\nextendedKeyUsage=serverAuth\n" : "extendedKeyUsage=clientAuth\n");
  openssl("x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-set_serial", name === "server" ? "2" : "3", "-days", "1", "-extfile", `${name}.ext`, "-out", `${name}.crt`);
  fs.chmodSync(path.join(fixture, `${name}.key`), 0o600);
}
fs.chmodSync(path.join(fixture, "ca.key"), 0o600);
receipt.publicCertificates = Object.fromEntries(["ca.crt", "server.crt", "client.crt"].map((name) => [name, sha(fs.readFileSync(path.join(fixture, name)))]));
// Test configuration, NOT a production generator or a 47-control attestation.
const config = `pid /tmp/nginx.pid;
error_log /dev/null crit;
events { worker_connections 128; }
http {
  log_format guard escape=json '{"status":"$status","upstream":"$upstream_status","requestId":"$request_id"}';
  access_log /out/nginx-access.jsonl guard;
  client_body_temp_path /tmp/body;
  proxy_temp_path /tmp/proxy;
  fastcgi_temp_path /tmp/fastcgi;
  uwsgi_temp_path /tmp/uwsgi;
  scgi_temp_path /tmp/scgi;
  map "$http_transfer_encoding$http_content_encoding$http_trailer$http_expect$http_upgrade$http_proxy_connection" $bad_framing { "" 0; default 1; }
  map $http_connection $bad_connection { "" 0; ~*^(close|keep-alive)$ 0; default 1; }
  server {
    listen 127.0.0.1:8443 ssl;
    server_name fixture.invalid;
    ssl_certificate /fixture/server.crt;
    ssl_certificate_key /fixture/server.key;
    ssl_client_certificate /fixture/ca.crt;
    ssl_verify_client on;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 16k;
    client_body_timeout 1s;
    add_header Cache-Control no-store always;
    if ($bad_framing) { return 400; }
    if ($bad_connection) { return 400; }
    location / {
      proxy_pass http://127.0.0.1:18894;
      proxy_http_version 1.1;
      proxy_set_header Host $http_host;
      proxy_set_header Connection close;
      proxy_request_buffering off;
      proxy_next_upstream off;
      proxy_read_timeout 2s;
    }
  }
}
`;
fs.writeFileSync(path.join(fixture, "nginx.conf"), config);
receipt.nginxConfigSha256 = sha(Buffer.from(config));
}
const inspect = (id) => JSON.parse(docker("inspect", id))[0];
const user = `${process.getuid()}:${process.getgid()}`;
const isolation = ["--platform", "linux/amd64", "--label", label, "--read-only", "--cap-drop", "ALL",
  "--security-opt", "no-new-privileges", "--memory", "512m", "--cpus", "1", "--pids-limit", "128",
  "--user", user, "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m,mode=1777"];
const common = [...isolation,
  "--mount", `type=bind,src=${fixture},dst=/fixture,readonly`, "--mount", `type=bind,src=${results},dst=/out`];
const imageIds = new Map();
const expectedContainers = new Map();
function createContainer(image, network, mounts, args) {
  const id = docker("create", ...args);
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Ambiguous create; inspect exact run label before cleanup");
  owned.push(id);
  expectedContainers.set(id, { image, network, mounts });
  verifyContainer(id);
  docker("start", id);
  return id;
}
function verifyContainer(id) {
  const info = inspect(id);
  const expected = expectedContainers.get(id);
  const config = info.HostConfig;
  assert.equal(info.Id, id);
  assert.equal(info.Image, imageIds.get(expected.image));
  assert.equal(info.Config.Image, expected.image);
  assert.equal(config.NetworkMode, expected.network);
  assert.equal(info.Config.User, user);
  assert.equal(info.Config.Labels?.["padlhub.partner-raw-guard"], runId);
  assert.equal(config.Privileged, false);
  assert.equal(config.ReadonlyRootfs, true);
  assert.deepEqual(config.CapDrop, ["ALL"]);
  assert.deepEqual(config.SecurityOpt, ["no-new-privileges"]);
  assert.deepEqual(config.Tmpfs, { "/tmp": "rw,noexec,nosuid,size=256m,mode=1777" });
  assert.equal(config.Memory, 512 * 1024 * 1024);
  assert.equal(config.NanoCpus, 1000000000);
  assert.equal(config.PidsLimit, 128);
  assert.equal(Object.keys(config.PortBindings || {}).length, 0);
  assert.equal(Object.values(info.NetworkSettings.Ports || {}).filter(Boolean).length, 0);
  const mounts = info.Mounts.map(({ Type, Source, Destination, RW }) => ({ type: Type, source: Source, destination: Destination, writable: RW }))
    .sort((a, b) => a.destination < b.destination ? -1 : 1);
  assert.deepEqual(mounts, [...expected.mounts].sort((a, b) => a.destination < b.destination ? -1 : 1));
  return { id, imageId: info.Image, image: info.Config.Image, networkMode: config.NetworkMode,
    user, publishedPorts: 0, readOnlyRootfs: true, capabilitiesDropped: ["ALL"], noNewPrivileges: true, mounts };
}
const mount = (source, destination, writable = false) => ({ type: "bind", source, destination, writable });
const fixtureMounts = [mount(fixture, "/fixture"), mount(results, "/out", true)];
function runtimeDigest() {
  const entries = [];
  const walk = (relative = "") => {
    for (const name of fs.readdirSync(path.join(runtime, relative)).sort()) {
      const rel = relative ? `${relative}/${name}` : name;
      const absolute = path.join(runtime, rel);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        if (!fs.realpathSync(absolute).startsWith(`${runtime}/`)) throw new Error("Runtime symlink escapes fixture");
        entries.push([rel, "link", stat.mode & 0o777, fs.readlinkSync(absolute)]);
      } else if (stat.isDirectory()) { entries.push([rel, "directory", stat.mode & 0o777]); walk(rel); }
      else if (stat.isFile()) entries.push([rel, "file", stat.mode & 0o777, sha(fs.readFileSync(absolute))]);
      else throw new Error("Unexpected runtime file type");
    }
  };
  walk();
  return sha(Buffer.from(JSON.stringify(entries)));
}
function expectedProbeNames() {
  const names = [];
  for (const prefix of ["direct", "nginx"]) {
    for (const name of ["post-object-preserved", "delete-empty", "get-empty"]) names.push(`${prefix}:${name}`);
    for (const header of guardModule.SECURITY_HEADERS) {
      for (const mixed of [false, true]) for (const same of [false, true]) names.push(`${prefix}:duplicate:${header}:${mixed}:${same}`);
      names.push(`${prefix}:comma:${header}`);
    }
    for (const name of ["duplicate", "escaped", "nested", "surrogate", "invalid", "bom", "scalar", "depth"]) names.push(`${prefix}:json:${name}`);
    for (const name of ["16384-bytes", "16385-bytes", "query", "body-deadline"]) names.push(`${prefix}:${name}`);
    for (const name of ["Content-Encoding", "Trailer", "Expect", "Connection"]) names.push(`${prefix}:framing:${name}`);
  }
  return names.concat(["nginx:duplicate-content-length:2", "nginx:duplicate-content-length:3", "nginx:duplicate-host", "nginx:CL-plus-TE",
    "nginx:chunked-without-CL", "nginx:no-client-certificate", "direct:client-abort"]);
}
try {
  prepareFixture();
  for (const image of [NODE, NGINX]) {
    const metadata = JSON.parse(docker("image", "inspect", image))[0];
    if (metadata.Architecture !== "amd64" || metadata.Os !== "linux") throw new Error("Fixture platform mismatch; pull pinned amd64 image first");
    imageIds.set(image, metadata.Id);
  }
  // Registry access exists ONLY in setup, with lifecycle scripts disabled and no
  // host .npmrc, environment, fixture keys or Docker socket mounted.
  const installId = createContainer(NODE, "bridge", [mount(runtime, "/runtime", true)], [...isolation, "--network", "bridge",
    "--name", `partner-raw-guard-${runId}-install`, "--mount", `type=bind,src=${runtime},dst=/runtime`, "--workdir", "/runtime",
    "--env", "npm_config_cache=/tmp/npm-cache", NODE, "npm", "ci", "--ignore-scripts", "--no-fund", "--no-audit", "--registry=https://registry.npmjs.org"]);
  receipt.containers.push(verifyContainer(installId));
  if (docker("wait", installId) !== "0") throw new Error("Locked fixture runtime installation failed");
  fs.writeFileSync(path.join(results, "install.log"), docker("logs", installId));
  receipt.install = { command: "npm ci --ignore-scripts --no-fund --no-audit --registry=https://registry.npmjs.org", exitCode: 0,
    logSha256: sha(fs.readFileSync(path.join(results, "install.log"))) };
  receipt.runtimeTreeBeforeSha256 = runtimeDigest();
  const nodeId = createContainer(NODE, "none", [...fixtureMounts, mount(runtime, "/runtime")], [...common, "--network", "none", "--name", `partner-raw-guard-${runId}-node`,
    "--mount", `type=bind,src=${runtime},dst=/runtime,readonly`, NODE, "node", "/fixture/runner.cjs", "serve"]);
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { docker("exec", nodeId, "node", "-e", "process.exit(require('fs').existsSync('/tmp/guard-ready') ? 0 : 1)"); ready = true; break; } catch { /* bounded startup */ }
    if (!inspect(nodeId).State.Running) throw new Error("Fixture Node-RED exited before readiness");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error("Fixture Node-RED readiness timeout");
  const nginxId = createContainer(NGINX, `container:${nodeId}`, fixtureMounts, [...common, "--network", `container:${nodeId}`, "--name", `partner-raw-guard-${runId}-nginx`,
    "--entrypoint", "nginx", NGINX, "-c", "/fixture/nginx.conf", "-g", "daemon off;"]);
  for (const id of [nodeId, nginxId]) receipt.containers.push(verifyContainer(id));
  docker("exec", nginxId, "nginx", "-t", "-c", "/fixture/nginx.conf");
  const version = spawnSync("docker", ["exec", nginxId, "nginx", "-v"], { encoding: "utf8", timeout: 10000 });
  receipt.nginxVersion = version.stderr.trim();
  if (version.status !== 0 || receipt.nginxVersion !== "nginx version: nginx/1.24.0") throw new Error("Fixture Nginx version mismatch");
  const result = docker("exec", nodeId, "node", "/fixture/runner.cjs", "test");
  const probes = JSON.parse(fs.readFileSync(path.join(results, "probes.json")));
  if (probes.node !== "v22.23.2" || probes.nodeRed !== "5.0.6" || probes.platform !== "linux" || probes.architecture !== "x64"
    || probes.state !== "LOCAL_RAW_GUARD_REHEARSAL_PASS_NOT_PRODUCTION") throw new Error("Fixture runtime/proof mismatch");
  assert.equal(probes.protocol, "HTTP/1.1");
  assert.equal(probes.flowPreflightFailures, 3);
  for (const flag of ["http2Tested", "businessProviderTested", "productionVerified"]) assert.equal(probes[flag], false);
  assert.equal(probes.httpInSourceSha256, sha(fs.readFileSync(path.join(runtime, "node_modules/@node-red/nodes/core/network/21-httpin.js"))));
  assert.deepEqual(probes.rows.map((row) => row.name).sort(), expectedProbeNames().sort());
  for (const row of probes.rows) {
    assert.equal(row.result, "PASS");
    const accepted = /:(post-object-preserved|delete-empty|get-empty|16384-bytes)$/.test(row.name);
    assert.equal(row.observerCalls, accepted ? 1 : 0);
    if (accepted) { assert.equal(row.status, 200); assert.deepEqual(row.guardCodes, ["RAW_ACCEPTED"]); }
    else {
      assert.ok(row.name === "direct:client-abort" ? row.status === null : [400, 408, 413, 414, 431].includes(row.status));
      assert.ok(row.guardCodes.every((code) => /^RAW_[A-Z_]+$/.test(code) && code !== "RAW_ACCEPTED"));
    }
  }
  receipt.probesSha256 = sha(fs.readFileSync(path.join(results, "probes.json")));
  receipt.runtimeTreeAfterSha256 = runtimeDigest();
  assert.equal(receipt.runtimeTreeBeforeSha256, receipt.runtimeTreeAfterSha256);
  for (const id of owned) verifyContainer(id);
  receipt.result = JSON.parse(result);
  assert.equal(receipt.result.passed, expectedProbeNames().length);
  receipt.state = "PROBES_PASSED_CLEANUP_PENDING";
} catch (error) {
  receipt.state = "FAILED";
  receipt.error = error.message.slice(0, 1500);
  // Only fixture-owned logs; no environment/config dump or certificate bytes.
  for (const id of owned) {
    try { fs.writeFileSync(path.join(results, `${id.slice(0, 12)}.log`), docker("logs", id)); } catch { /* retain primary failure */ }
  }
  process.exitCode = 1;
} finally {
  for (const id of [...owned].reverse()) {
    try {
      const info = inspect(id);
      assert.equal(info.Config.Labels?.["padlhub.partner-raw-guard"], runId, "Refusing cleanup of unowned container");
      docker("stop", "--time", "10", id);
      docker("rm", id);
      const present = docker("ps", "-aq", "--filter", `id=${id}`) !== "";
      receipt.cleanup.push({ id, presentAfterCleanup: present });
      if (present) process.exitCode = 1;
    } catch {
      receipt.cleanup.push({ id, presentAfterCleanup: "UNKNOWN", error: "CLEANUP_FAILED_MANUAL_OWNERSHIP_CHECK_REQUIRED" });
      process.exitCode = 1;
    }
  }
  if (receipt.cleanup.length !== owned.length || receipt.cleanup.some((entry) => entry.presentAfterCleanup !== false)) receipt.state = "FAILED_CLEANUP";
  else {
    try {
      for (const name of ["ca.key", "server.key", "client.key", "server.csr", "client.csr"]) {
        const target = path.join(fixture, name);
        if (fs.existsSync(target)) fs.unlinkSync(target);
      }
      receipt.syntheticPrivateKeysRemoved = true;
      const logsPath = path.join(results, "nginx-access.jsonl");
      if (fs.existsSync(logsPath)) {
        const bytes = fs.readFileSync(logsPath);
        const lines = bytes.toString("utf8").trim().split("\n").filter(Boolean);
        for (const line of lines) {
          const entry = JSON.parse(line);
          assert.deepEqual(Object.keys(entry), ["status", "upstream", "requestId"]);
          assert.match(entry.status, /^[1-5][0-9]{2}$/);
          // Empty is the observed Nginx 1.24 value before upstream dispatch.
          assert.match(entry.upstream, /^(?:|-|[1-5][0-9]{2})$/);
          assert.match(entry.requestId, /^[a-f0-9]{32}$/);
        }
        receipt.nginxAuditSha256 = sha(bytes);
        receipt.nginxAuditRowCount = lines.length;
      }
      if (receipt.state === "PROBES_PASSED_CLEANUP_PENDING") {
        assert.equal(receipt.nginxAuditRowCount, expectedProbeNames().filter((name) => name.startsWith("nginx:")).length);
        const auditBytes = fs.readFileSync(path.join(results, "guard-audit.jsonl"));
        const events = auditBytes.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
        for (const event of events) {
          assert.deepEqual(Object.keys(event), ["stage", "code", "requestId"]);
          assert.equal(event.stage, "RAW_REQUEST_GUARD");
          assert.match(event.code, /^RAW_[A-Z_]+$/);
          assert.match(event.requestId, /^[a-f0-9-]{36}$/);
        }
        const probes = JSON.parse(fs.readFileSync(path.join(results, "probes.json")));
        assert.deepEqual(events.map((event) => event.code), probes.rows.flatMap((row) => row.guardCodes));
        assert.equal(new Set(events.map((event) => event.requestId)).size, events.length);
        receipt.guardAuditSha256 = sha(auditBytes);
        receipt.guardAuditRowCount = events.length;
        receipt.state = "PASS_LOCAL_ONLY";
      }
    } catch { receipt.state = "FAILED_FINALIZATION"; process.exitCode = 1; }
  }
  try { fs.writeFileSync(path.join(results, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n"); }
  catch { receipt.state = "FAILED_RECEIPT_WRITE"; process.exitCode = 1; }
  console.log(JSON.stringify({ state: receipt.state, output: results, passed: receipt.result?.passed || 0, cleanup: receipt.cleanup }));
}
