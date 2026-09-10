import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { openPartnerNginxLogWindow } from "../partner_game_membership_nginx_log_window.mjs";
import { buildLocalNginxCorrelationLogPolicy, evaluateLocalNginxGenerationCorrelation, createLocalNginxGenerationSession } from "../partner_game_membership_nginx_generation.mjs";
import { PARTNER_INGRESS_REQUIRED_PROBES, verifyPartnerProductionIngress } from "../partner_game_membership_ingress_evidence.mjs";
import { canonicalJson } from "../../node-red/custom-nodes/partner-game-membership-api/partner-game-membership-core.mjs";
import { exchangeLocalNginxGeneration, linkLocalNginxApplicationCorrelation, createLocalNginxApplicationBudget } from "../partner_game_membership_nginx_application_link.mjs";
import { serveLocalNginxGeneration } from "./fixtures/partner-nginx-application-correlation.mjs";

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const jsonl = rows => Buffer.from(rows.map(canonicalJson).join("\n") + "\n");
function fixture() {
  const expected = { configSha256: hash("new config"), generationMarker: hash("generation literal"),
    serverSpkiSha256: hash("server key"), clientLeafSha256: hash("allowed leaf"), wrongClientLeafSha256: hash("denied leaf"),
    target: { address: "127.0.0.1", sourceBindAddress: "127.0.0.1", port: 8443, sidecarPort: 18894, exactHost: "fixture.invalid", sharedHost: "shared.invalid" } };
  const baseline = { scope: "LOCAL_FIXTURE", configSha256: hash("old config"), bootSha256: hash("boot"), pidNamespaceSha256: hash("pidns"), networkNamespaceSha256: hash("netns"),
    master: { pid: 10, parentPid: 1, startTicks: "100", executableSha256: hash("nginx executable"), draining: false },
    workers: [{ pid: 11, parentPid: 10, startTicks: "200", executableSha256: hash("nginx executable"), draining: false }] };
  const before = structuredClone(baseline); before.configSha256 = expected.configSha256; before.workers[0].pid = 12; before.workers[0].startTicks = "300";
  const transport = { state: "NGINX_TRANSPORT_OBSERVATIONS_NOT_INGRESS_PROOF", challenge: hash("fresh transport"), startedAt: 1100, completedAt: 1400,
    target: structuredClone(expected.target), probes: [], productionVerified: false, deployAuthorized: false, activationAuthorized: false,
    vantage: "UNATTESTED", applicationEvidence: "NOT_COLLECTED", upstreamAdmission: "NOT_COLLECTED" };
  const rows = [];
  for (const [index, id] of PARTNER_INGRESS_REQUIRED_PROBES.entries()) {
    const noHttp = ["wrongSni", "directSidecar"].includes(id);
    const rejectedCert = ["noClientCertificate", "wrongClientCertificate"].includes(id);
    const positive = ["positiveDefaultOff", "cors"].includes(id);
    const statuses = { positiveDefaultOff: 503, cors: 503, wrongHost: 421, sharedHost: 404, editorAdmin: 404, options: 405, query: 404, noClientCertificate: 400, wrongClientCertificate: 403 };
    const probe = { id, probeId: hash(`PADLHUB-NGINX-PROBE-V1\n${transport.challenge}\n${id}`),
      outcome: noHttp ? id === "directSidecar" ? "CONNECTION_REFUSED" : "TLS_ALERT" : "HTTP_RESPONSE",
      errorCode: noHttp ? id === "directSidecar" ? "ECONNREFUSED" : "ERR_SSL_TLSV1_UNRECOGNIZED_NAME" : null,
      httpStatus: noHttp ? null : statuses[id], complete: !noHttp, tlsAuthorized: !noHttp,
      tlsProtocol: noHttp ? null : "TLSv1.3", alpnProtocol: noHttp ? null : "http/1.1",
      serverLeafSha256: noHttp ? null : hash("server leaf"), serverSpkiSha256: noHttp ? null : expected.serverSpkiSha256,
      actualClientLeafSha256: noHttp || id === "noClientCertificate" ? null : id === "wrongClientCertificate" ? expected.wrongClientLeafSha256 : expected.clientLeafSha256,
      sourceAddress: noHttp ? null : expected.target.sourceBindAddress, peerAddress: noHttp ? null : expected.target.address, peerPort: noHttp ? null : expected.target.port,
      cacheControl: noHttp ? null : "no-store", corsHeaderPresent: false, bodyBytes: noHttp ? 0 : 2, bodySha256: noHttp ? null : hash("{}"),
      startedAt: 1110 + index * 20, completedAt: 1120 + index * 20 };
    transport.probes.push(probe);
    if (!noHttp) rows.push({ admitted: positive ? "1" : "0", clientVerified: rejectedCert ? "0" : "1", generation: expected.generationMarker,
      probeId: probe.probeId, requestId: hash(`request${index}`).slice(0, 32), source: expected.target.sourceBindAddress,
      status: String(probe.httpStatus), upstream: positive ? "503" : "-", worker: "12" });
  }
  const input = { baseline, before, after: structuredClone(before), expected, transport, logBytes: jsonl(rows), startedAt: 1000, completedAt: 1500 };
  return { input, rows };
}

test("new generation and ID-bound shuffled HTTP logs correlate but never authorize production", () => {
  const f = fixture(); f.input.logBytes = jsonl(f.rows.reverse());
  const result = evaluateLocalNginxGenerationCorrelation(f.input);
  assert.equal(result.state, "LOCAL_NGINX_GENERATION_HTTP_CORRELATED_NOT_LIVE_PROOF");
  assert.equal(result.correlatedHttpProbes, 9); assert.equal(result.admittedHttpProbes, 2);
  assert.deepEqual(result.withoutHttpLog, ["wrongSni", "directSidecar"]);
  for (const name of ["productionVerified", "deployAuthorized", "activationAuthorized"]) assert.equal(result[name], false);
  assert.equal(result.provenance, "UNATTESTED_LOCAL_INPUTS"); assert.equal(result.controlledApplication, "NOT_PROVEN");
  assert.throws(() => verifyPartnerProductionIngress(result), /UNSUPPORTED_INGRESS_ADAPTER/);
});
for (const [name, mutate] of [
  ["old worker", f => { f.before.workers = structuredClone(f.baseline.workers); f.after = structuredClone(f.before); }],
  ["PID reuse", f => { f.before.workers[0].pid = f.baseline.workers[0].pid; f.after = structuredClone(f.before); }],
  ["same start ticks", f => { f.before.workers[0].startTicks = f.baseline.workers[0].startTicks; f.after = structuredClone(f.before); }],
  ["worker runtime drift", f => { f.after.workers[0].startTicks = "301"; }],
  ["draining worker", f => { f.before.workers[0].draining = true; f.after = structuredClone(f.before); }],
  ["mixed workers", f => { f.before.workers.push(f.baseline.workers[0]); f.after = structuredClone(f.before); }],
  ["wrong worker parent", f => { f.before.workers[0].parentPid = 1; f.after = structuredClone(f.before); }],
  ["worker executable drift", f => { f.before.workers[0].executableSha256 = hash("other"); f.after = structuredClone(f.before); }],
  ["master cycle", f => { f.before.master.parentPid = 12; f.after = structuredClone(f.before); }],
  ["config drift", f => { f.after.configSha256 = hash("other"); }],
  ["unchanged config", f => { f.baseline.configSha256 = f.before.configSha256; }],
  ["wrong expected config", f => { f.expected.configSha256 = hash("other"); }],
  ...["master", "bootSha256", "pidNamespaceSha256", "networkNamespaceSha256"].map(key => [`epoch ${key}`, f => { if (key === "master") f.baseline.master.startTicks = "90"; else f.baseline[key] = hash("other"); }]),
  ["production claims", f => { f.before.scope = "PRODUCTION"; }],
  ["extra snapshot field", f => { f.after.loadedConfigVerified = true; }],
]) test(`generation rejects ${name}`, () => { const f = fixture(); mutate(f.input); assert.throws(() => evaluateLocalNginxGenerationCorrelation(f.input), /NGINX_GENERATION_/); });

for (const [name, mutate] of [
  ["unknown probe ID", rows => { rows[0].probeId = hash("unrelated"); }],
  ["duplicate probe ID", rows => { rows[1].probeId = rows[0].probeId; }],
  ["duplicate request ID", rows => { rows[1].requestId = rows[0].requestId; }],
  ["missing row", rows => { rows.pop(); }],
  ["extra same-status row", rows => { rows.push({ ...rows[0], requestId: hash("new request").slice(0, 32), probeId: hash("unrelated") }); }],
  ["old marker", rows => { rows[0].generation = hash("old"); }],
  ["caller marker", rows => { rows[0].generation = "$http_x_generation"; }],
  ["old worker with new marker", rows => { rows[0].worker = "11"; }],
  ["wrong source", rows => { rows[0].source = "127.0.0.2"; }],
  ["wrong status", rows => { rows[0].status = "400"; }],
  ["default-off not admitted", rows => { rows[0].admitted = "0"; }],
  ["default-off not verified", rows => { rows[0].clientVerified = "0"; }],
  ["synthetic503 from edge", rows => { rows[0].upstream = "-"; }],
  ["routing denial reached upstream", rows => { rows[1].upstream = "503"; }],
  ["retry or multiple upstreams", rows => { rows[0].upstream = "503, 503"; }],
  ["wrong client admitted", rows => { rows.at(-1).admitted = "1"; }],
  ["no cert marked verified", rows => { rows.at(-2).clientVerified = "1"; }],
  ["extra secret field", rows => { rows[0].authorization = "not-real-sensitive-data"; }],
]) test(`correlation rejects ${name}`, () => { const f = fixture(); mutate(f.rows); f.input.logBytes = jsonl(f.rows); assert.throws(() => evaluateLocalNginxGenerationCorrelation(f.input), /NGINX_CORRELATION_/); });

for (const [name, mutate] of [
  ["challenge replay", f => { f.transport.challenge = hash("another run"); }],
  ["missing probe", f => { f.transport.probes.pop(); }],
  ["probe order changed", f => { f.transport.probes.reverse(); }],
  ["caller PASS", f => { f.transport.productionVerified = true; }],
  ["caller vantage", f => { f.transport.vantage = "PRODUCTION"; }],
  ["other target", f => { f.transport.target.address = "127.0.0.2"; }],
  ["unknown transport fields", f => { f.transport.signed = true; }],
  ["other server key", f => { f.transport.probes[0].serverSpkiSha256 = hash("other"); }],
  ["other client leaf", f => { f.transport.probes[0].actualClientLeafSha256 = hash("other"); }],
  ["incomplete response", f => { f.transport.probes[0].complete = false; }],
  ["positive control failed", f => { f.transport.probes[0].httpStatus = 400; }],
  ["positive CORS", f => { f.transport.probes[0].corsHeaderPresent = true; }],
  ["positive caching", f => { f.transport.probes[0].cacheControl = null; }],
  ["wrong socket peer", f => { f.transport.probes[0].peerAddress = "127.0.0.2"; }],
  ["TLS downgrade", f => { f.transport.probes[0].tlsProtocol = "TLSv1.1"; }],
  ["opaque refusal invented source", f => { f.transport.probes[4].sourceAddress = "127.0.0.1"; }],
  ["refusal replaced by timeout", f => { const p = f.transport.probes.find(p => p.id === "directSidecar"); p.outcome = "TIMEOUT"; p.errorCode = "PROBE_DEADLINE"; }],
  ["TLS generic error", f => { const p = f.transport.probes.find(p => p.id === "wrongSni"); p.errorCode = "ECONNRESET"; }],
  ["stale transport", f => { f.startedAt = 1101; }],
  ["reversed window", f => { f.completedAt = 999; }],
  ["overlong window", f => { f.completedAt = 100000; }],
  ["out-of-window probe", f => { f.transport.probes[0].startedAt = 900; }],
]) test(`transport binding rejects ${name}`, () => { const f = fixture(); mutate(f.input); assert.throws(() => evaluateLocalNginxGenerationCorrelation(f.input), /NGINX_CORRELATION_/); });

for (const [name, bytes] of [
  ["empty", Buffer.alloc(0)], ["partial", Buffer.from('{"x":1}')], ["blank line", Buffer.from("\n")],
  ["invalid UTF8", Buffer.from([123, 34, 120, 34, 58, 34, 0xff, 34, 125, 10])],
  ["duplicate JSON keys", Buffer.from('{"x":1,"x":1}\n')], ["noncanonical", Buffer.from('{ "x":1}\n')],
  ["oversized", Buffer.alloc(65537, 10)], ["too many lines", Buffer.from("{}\n".repeat(12))],
  ["oversized line", Buffer.from('{"x":"' + "a".repeat(2050) + '"}\n')],
]) test(`log parser rejects ${name}`, () => { const f = fixture(); f.input.logBytes = bytes; assert.throws(() => evaluateLocalNginxGenerationCorrelation(f.input), /NGINX_CORRELATION_LOG_INVALID/); });

test("TLS failure has no HTTP match and remains explicitly unproven", () => {
  const f = fixture(), probe = f.input.transport.probes.find(p => p.id === "noClientCertificate");
  const empty = f.input.transport.probes.find(p => p.id === "wrongSni");
  Object.assign(probe, { ...empty, id: probe.id, probeId: probe.probeId, startedAt: probe.startedAt, completedAt: probe.completedAt, errorCode: "ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED" });
  f.input.logBytes = jsonl(f.rows.filter(row => row.probeId !== probe.probeId));
  const result = evaluateLocalNginxGenerationCorrelation(f.input);
  assert.ok(result.withoutHttpLog.includes("noClientCertificate")); assert.equal(result.externalVantage, "NOT_PROVEN");
  f.input.logBytes = jsonl(f.rows);
  assert.throws(() => evaluateLocalNginxGenerationCorrelation(f.input), /NGINX_CORRELATION_TLS_OBSERVATION_INVALID/);
});
test("log policy has fixed literal generation and safe separate public probe header, no proof logging", () => {
  const policy = buildLocalNginxCorrelationLogPolicy(hash("marker"));
  assert.match(policy, /escape=json/); assert.match(policy, /http_x_padlhub_probe_id/); assert.match(policy, /\$remote_addr/);
  assert.ok(policy.includes(`"generation":"${hash("marker")}"`));
  assert.doesNotMatch(policy, /signature|nonce|authorization|request_body|http_x_generation|upstream_http_/i);
  for (const marker of ["$http_generation", "\"; include bad;", null, "a".repeat(65)]) assert.throws(() => buildLocalNginxCorrelationLogPolicy(marker), /NGINX_GENERATION_MARKER_INVALID/);
});

function logFixture(t, prefix = "historical nonsensitive line\n") {
  const root = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), ".generation-log-")); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logPath = path.join(root, "access.jsonl"); fs.writeFileSync(logPath, prefix, { mode: 0o600 });
  const options = { absolutePath: logPath, expectedOwnerUid: process.getuid() };
  return { root, logPath, options, open() { const window = openPartnerNginxLogWindow(options); t.after(() => window.close()); return window; } };
}
test("held descriptor captures only fresh suffix, then closes after final custody check", t => {
  const f = logFixture(t), window = f.open(), rows = fixture().rows, suffix = jsonl(rows);
  fs.appendFileSync(f.logPath, suffix); const captured = window.capture();
  assert.deepEqual(captured, suffix); captured.fill(0);
  const receipt = window.finish(); assert.equal(receipt.suffixSha256, hash(suffix)); assert.equal(receipt.prefixSha256, hash("historical nonsensitive line\n"));
  assert.equal(receipt.productionVerified, false); assert.match(receipt.state, /NOT_APPEND_ONLY_PROOF/);
  assert.throws(() => window.capture(), /NGINX_LOG_WINDOW_CLOSED/); window.close();
});
for (const [name, mutate] of [
  ["rename/recreate", f => { fs.renameSync(f.logPath, path.join(f.root, "old")); fs.writeFileSync(f.logPath, "replacement\n", { mode: 0o600 }); }],
  ["unlink", f => { fs.unlinkSync(f.logPath); }], ["truncate", f => { fs.truncateSync(f.logPath, 0); }],
  ["same-size prefix rewrite", f => { const bytes = fs.readFileSync(f.logPath); bytes[0] = 88; fs.writeFileSync(f.logPath, bytes); }],
  ["partial final row", f => { fs.appendFileSync(f.logPath, "partial"); }],
  ["oversized suffix", f => { fs.appendFileSync(f.logPath, Buffer.alloc(65537, 10)); }],
  ["writable mode", f => { fs.chmodSync(f.logPath, 0o666); }],
  ["hardlink", f => { fs.linkSync(f.logPath, path.join(f.root, "alias")); }],
  ["ancestor mode", f => { fs.chmodSync(f.root, 0o777); }],
  ["same-target symlink", f => { fs.renameSync(f.logPath, path.join(f.root, "moved")); fs.symlinkSync(path.join(f.root, "moved"), f.logPath); }],
]) test(`held log reader refuses ${name} with latched failure and redacted error`, t => {
  const f = logFixture(t), window = f.open(); mutate(f);
  assert.throws(() => window.capture(), error => { assert.match(error.code, /^NGINX_LOG_/); assert.equal(error.message, error.code); assert.ok(!error.message.includes(f.root)); return true; });
  assert.throws(() => window.finish(), /NGINX_LOG_WINDOW_CLOSED/);
});
test("partial initial line, unsafe modes/paths and oversized initial file are rejected", t => {
  for (const content of ["partial", Buffer.alloc(1048577, 10)]) {
    const f = logFixture(t, content); assert.throws(() => f.open(), /NGINX_LOG_/);
  }
  const f = logFixture(t); fs.chmodSync(f.logPath, 0o644); assert.throws(() => f.open(), /NGINX_LOG_CUSTODY_CHANGED/);
  assert.throws(() => openPartnerNginxLogWindow({ ...f.options, absolutePath: "relative" }), /NGINX_LOG_POLICY_INVALID/);
  assert.throws(() => openPartnerNginxLogWindow({ ...f.options, allowRotation: true }), /NGINX_LOG_POLICY_INVALID/);
});
test("special mode bits are refused even where the OS strips chmod setuid", t => {
  const f = logFixture(t), window = f.open(), original = fs.fstatSync;
  t.mock.method(fs, "fstatSync", (...args) => {
    const stat = original(...args); stat.mode |= 0o4000n; return stat;
  });
  assert.throws(() => window.capture(), /NGINX_LOG_CUSTODY_CHANGED/);
});
test("append during final read is rejected rather than retried", t => {
  const f = logFixture(t), window = f.open(), original = fs.readSync; let changed = false;
  fs.appendFileSync(f.logPath, "{}\n");
  t.mock.method(fs, "readSync", (...args) => { const result = original(...args); if (!changed) { changed = true; fs.appendFileSync(f.logPath, "{}\n"); } return result; });
  assert.throws(() => window.capture(), /NGINX_LOG_CHANGED_DURING_READ/);
});
test("short read and late file or ancestor change fail finalization", t => {
  const a = logFixture(t), first = a.open(); first.capture(); fs.appendFileSync(a.logPath, "{}\n");
  assert.throws(() => first.finish(), /NGINX_LOG_CHANGED_AFTER_CAPTURE/);
  const b = logFixture(t), second = b.open(); second.capture(); fs.chmodSync(b.root, 0o750);
  assert.throws(() => second.finish(), /NGINX_LOG_ANCESTOR_CHANGED/);
  const c = logFixture(t), third = c.open(); t.mock.method(fs, "readSync", () => 0);
  assert.throws(() => third.capture(), /NGINX_LOG_CHANGED_DURING_READ/);
});
test("log deadline closes descriptor even when timer callback has not run", t => {
  const f = logFixture(t), window = f.open(), original = performance.now.bind(performance); let closes = 0;
  const close = fs.closeSync; t.mock.method(fs, "closeSync", fd => { closes++; return close(fd); });
  t.mock.method(performance, "now", () => original() + 90001);
  assert.throws(() => window.capture(), /NGINX_LOG_WINDOW_EXPIRED/); assert.equal(closes, 1); window.close(); assert.equal(closes, 1);
});
test("same-inode truncate then exact-prefix restoration cannot prove append-only history", t => {
  const f = logFixture(t), window = f.open(), prefix = fs.readFileSync(f.logPath);
  fs.truncateSync(f.logPath, 0); fs.appendFileSync(f.logPath, Buffer.concat([prefix, Buffer.from("{}\n")]));
  assert.equal(window.capture().toString(), "{}\n");
  assert.equal(window.finish().state, "PREFIX_PRESERVED_SUFFIX_OBSERVED_NOT_APPEND_ONLY_PROOF");
});
test("host-session wiring rejects non-Linux fixture without signals, network or live fallback", t => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  t.after(() => Object.defineProperty(process, "platform", platform));
  const f = logFixture(t), data = fixture().input;
  assert.throws(() => createLocalNginxGenerationSession({ baseline: data.baseline, expected: data.expected, logPath: f.logPath }), /LOCAL_NGINX_LINUX_FIXTURE_REQUIRED/);
});

function syntheticCollector(t, f) {
  const mapping = new Map();
  const procStat = (pid, parent, ticks) => `${pid} (nginx) S ${[parent, ...Array(17).fill("0"), ticks].join(" ")}\n`;
  for (const [source, content] of Object.entries({
    "/control/nginx.pid": "10\n", "/control/nginx.conf": "new config",
    "/proc/10/stat": procStat(10, 1, "100"), "/proc/12/stat": procStat(12, 10, "300"),
    "/proc/10/cmdline": "nginx: master process /usr/sbin/nginx -c /control/nginx.conf -g daemon off;\0",
    "/proc/12/cmdline": "nginx: worker process\0", "/proc/10/exe": "nginx executable", "/proc/12/exe": "nginx executable",
    "/proc/10/task/10/children": "12", "/proc/sys/kernel/random/boot_id": "boot",
  })) {
    const target = path.join(f.root, `fixture-${mapping.size}`); fs.writeFileSync(target, content, { mode: 0o600 }); mapping.set(source, target);
  }
  mapping.set("/out/correlation/access.jsonl", f.logPath); mapping.set("/out/correlation", f.root); mapping.set("/out", f.root);
  // Only these fixed synthetic files are substituted, not a fake collector return.
  // This is entrypoint wiring evidence, NOT a real Linux /proc observation.
  for (const method of ["openSync", "lstatSync", "readFileSync"]) {
    const original = fs[method]; t.mock.method(fs, method, (file, ...args) => original(mapping.get(file) ?? file, ...args));
  }
  const realpath = fs.realpathSync, readlink = fs.readlinkSync;
  t.mock.method(fs, "realpathSync", file => mapping.has(file) ? file : realpath(file));
  t.mock.method(fs, "readlinkSync", file => /^\/proc\/(self|10)\/ns\/(pid|net)$/.test(file) ? file.endsWith("/pid") ? "pidns" : "netns" : readlink(file));
  for (const [name, value] of [["platform", "linux"], ["arch", "x64"]]) {
    const descriptor = Object.getOwnPropertyDescriptor(process, name);
    Object.defineProperty(process, name, { ...descriptor, value }); t.after(() => Object.defineProperty(process, name, descriptor));
  }
}
test("host session reads fixed collector and held log, then finalizes once (synthetic proc metadata)", t => {
  const f = logFixture(t), data = fixture(); syntheticCollector(t, f);
  let now = 1000; t.mock.method(Date, "now", () => now);
  const session = createLocalNginxGenerationSession({ baseline: data.input.baseline, expected: data.input.expected, logPath: f.logPath });
  t.after(() => session.close()); fs.appendFileSync(f.logPath, jsonl(data.rows)); now = 1500;
  const result = session.finish(data.input.transport);
  assert.equal(result.correlatedHttpProbes, 9); assert.equal(result.provenance, "LOCAL_HOST_READS_TRANSPORT_UNATTESTED");
  assert.equal(result.logWindow.suffixSha256, hash(jsonl(data.rows))); assert.equal(result.productionVerified, false);
  assert.throws(() => session.finish(data.input.transport), /NGINX_CORRELATION_SESSION_CLOSED/);
});

function linkedFixture() {
  const f = fixture(), correlation = { ...evaluateLocalNginxGenerationCorrelation(f.input),
    provenance: "LOCAL_HOST_READS_TRANSPORT_UNATTESTED", logWindow: {
      state: "PREFIX_PRESERVED_SUFFIX_OBSERVED_NOT_APPEND_ONLY_PROOF", prefixBytes: 0, prefixSha256: hash(""),
      suffixBytes: f.input.logBytes.length, suffixSha256: hash(f.input.logBytes), productionVerified: false } };
  const peer = { transport: f.input.transport, networkNamespaceSha256: hash("peer namespace") };
  const application = { state: "LOCAL_CONTROLLED_APPLICATION_VERIFIED_NOT_LIVE_PROOF", startedAt: 500, completedAt: 1000,
    productionVerified: false, deployAuthorized: false, activationAuthorized: false, unapplied: { synthetic: true },
    records: ["baseline", "applied", "revoked"].map(phase => ({ result: { phase, configSha256: f.input.expected.configSha256,
      marker: f.input.expected.generationMarker, snapshot: structuredClone(f.input.after) }, observed: { upstreamAfter: 7,
      probes: [{ clientLeafDerSha256: f.input.expected.wrongClientLeafSha256 }, { clientLeafDerSha256: f.input.expected.clientLeafSha256, networkNamespaceSha256: peer.networkNamespaceSha256 }] } })) };
  return { application, correlation, peer, expected: f.input.expected, upstreamBefore: 7, upstreamAfter: 9 };
}
test("local synthetic supplement links revoked generation, previous leaf, namespace and independent +2 only", () => {
  const result = linkLocalNginxApplicationCorrelation(linkedFixture());
  assert.equal(result.state, "LOCAL_APPLICATION_TRANSPORT_LOG_LINKED_NOT_LIVE_PROOF");
  assert.equal(result.productionVerified, false); assert.equal(result.provenance, "UNATTESTED_UNTIL_OWNED_RUNNER_EXECUTION");
  assert.throws(() => verifyPartnerProductionIngress(result), /UNSUPPORTED_INGRESS_ADAPTER/);
});
for (const [name, mutate] of [
  ["missing prior phases", f => f.application.records.pop()], ["no disk-only negative", f => { f.application.unapplied = null; }],
  ["old marker", f => { f.correlation.generationMarker = hash("old"); }],
  ["old worker snapshot", f => { f.correlation.snapshotSha256 = hash("old"); }],
  ["other config", f => { f.expected.configSha256 = hash("other"); }],
  ["swapped client leaf", f => { f.expected.clientLeafSha256 = f.expected.wrongClientLeafSha256; }],
  ["wrong revoked leaf", f => { f.expected.wrongClientLeafSha256 = hash("other"); }],
  ["same namespace", f => { f.peer.networkNamespaceSha256 = f.application.records[2].result.snapshot.networkNamespaceSha256; }],
  ["different prior peer", f => { f.application.records[2].observed.probes[1].networkNamespaceSha256 = hash("other"); }],
  ["hidden traffic before", f => { f.upstreamBefore++; }], ["unexpected dispatch", f => { f.upstreamAfter++; }],
  ["forged admission count", f => { f.correlation.admittedHttpProbes = 3; }],
  ["unmatched transport", f => { f.peer.transport.challenge = hash("other"); }],
  ["earlier transport", f => { f.application.completedAt = 1500; }],
  ["overlong aggregate window", f => { f.application.startedAt = -200000; }],
  ["wrong target", f => { f.expected.target.address = "127.0.0.2"; }],
  ["wrong suffix", f => { f.correlation.logWindow.suffixSha256 = hash("other"); }],
  ["missing FD evidence", f => { delete f.correlation.logWindow; }],
  ["extra evidence", f => { f.correlation.approved = true; }],
  ["fake host provenance", f => { f.correlation.provenance = "UNATTESTED_LOCAL_INPUTS"; }],
  ...["application", "correlation", "peer"].map(key => [`production ${key}`, f => { (key === "peer" ? f.peer.transport : f[key]).productionVerified = true; }]),
]) test(`application link rejects ${name}`, () => { const f = linkedFixture(); mutate(f); assert.throws(() => linkLocalNginxApplicationCorrelation(f)); });

function fakeChild() {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; };
  return child;
}
const initialFor = () => { const f = fixture().input; return { baseline: f.baseline, expected: f.expected }; };
const readyFor = initial => canonicalJson({ state: "READY_LOCAL_LOG_WINDOW", initialSha256: hash(canonicalJson(initial)) }) + "\n";
const resultLine = () => canonicalJson({ state: "RESULT_LOCAL_LOG_WINDOW", result: linkedFixture().correlation }) + "\n";
async function closeFake(child, code = 0, signal = null) {
  child.stdout.end(); await new Promise(resolve => setImmediate(resolve)); child.emit("close", code, signal);
}
test("bounded parent pipe waits for READY, transport EOF, stdout EOF and successful close", async () => {
  const child = fakeChild(), initial = initialFor(); let calls = 0, outgoing = "";
  child.stdin.on("data", data => { outgoing += data.toString(); });
  const promise = exchangeLocalNginxGeneration(child, initial, () => { calls++; return linkedFixture().peer; });
  assert.equal(calls, 0); child.stdout.write(readyFor(initial));
  await new Promise(resolve => child.stdin.once("finish", resolve)); assert.equal(calls, 1);
  assert.equal(outgoing.split("\n").filter(Boolean).length, 2);
  child.stdout.write(resultLine()); let done = false; promise.then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false);
  await closeFake(child); const result = await promise; assert.equal(result.correlation.productionVerified, false);
});
for (const [name, output, code, signal] of [
  ["wrong READY hash", canonicalJson({ state: "READY_LOCAL_LOG_WINDOW", initialSha256: hash("other") }) + "\n", 0, null],
  ["RESULT before READY", resultLine(), 0, null], ["blank", "\n", 0, null], ["CRLF", readyFor(initialFor()).replace("\n", "\r\n"), 0, null],
  ["duplicate keys", '{"state":"x","state":"y"}\n', 0, null], ["oversized output", "x".repeat(8193), 0, null],
  ["truncated output", readyFor(initialFor()).trimEnd(), 0, null], ["nonzero close", "", 1, null], ["signal", "", null, "SIGTERM"],
]) test(`parent pipe rejects ${name} before collection`, async () => {
  const child = fakeChild(); let calls = 0;
  const promise = exchangeLocalNginxGeneration(child, initialFor(), () => { calls++; return linkedFixture().peer; });
  const rejection = assert.rejects(promise, /NGINX_APPLICATION_CHANNEL_/);
  if (output) child.stdout.write(output); await closeFake(child, code, signal); await rejection; assert.equal(calls, 0);
});
for (const [name, tail, code] of [["extra RESULT", resultLine(), 0], ["late raw bytes", "private-error", 0], ["RESULT then failure", "", 1]]) {
  test(`parent pipe rejects ${name}`, async () => {
    const child = fakeChild(), initial = initialFor(); const promise = exchangeLocalNginxGeneration(child, initial, () => linkedFixture().peer);
    const rejection = assert.rejects(promise, /NGINX_APPLICATION_CHANNEL_/); child.stdout.write(readyFor(initial));
    await new Promise(resolve => child.stdin.once("finish", resolve)); child.stdout.write(resultLine() + tail);
    await closeFake(child, code); await rejection;
  });
}
test("collector failure closes stdin and rejects after actual child close without exposing raw errors", async () => {
  const child = fakeChild(), initial = initialFor();
  const promise = exchangeLocalNginxGeneration(child, initial, () => { throw new Error("private synthetic detail"); });
  const rejection = assert.rejects(promise, error => error.message === "NGINX_APPLICATION_CHANNEL_FAILED");
  child.stdout.write(readyFor(initial)); await new Promise(resolve => child.stdin.once("finish", resolve));
  await closeFake(child, 1); await rejection;
});
test("unconfirmed child close at deadline is not successful cleanup", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = fakeChild(), promise = exchangeLocalNginxGeneration(child, initialFor(), () => assert.fail("no READY"));
  const rejection = assert.rejects(promise, /CHANNEL_EXIT_UNCONFIRMED/);
  t.mock.timers.tick(90000); assert.equal(child.stdin.writableEnded, true);
  t.mock.timers.tick(5000); await rejection; assert.equal(child.killed, true);
});
for (const stage of ["READY", "RESULT", "close"]) test(`elapsed deadline rejects late ${stage} before timer callback`, async t => {
  const original = performance.now.bind(performance); let elapsed = 0, calls = 0;
  t.mock.method(performance, "now", () => original() + elapsed);
  const child = fakeChild(), initial = initialFor(), promise = exchangeLocalNginxGeneration(child, initial, () => { calls++; return linkedFixture().peer; });
  const rejection = assert.rejects(promise, /NGINX_APPLICATION_CHANNEL_FAILED/);
  if (stage === "READY") elapsed = 90001;
  child.stdout.write(readyFor(initial));
  if (stage !== "READY") {
    await new Promise(resolve => child.stdin.once("finish", resolve));
    if (stage === "RESULT") elapsed = 90001;
    child.stdout.write(resultLine()); elapsed = 90001;
  }
  await closeFake(child); await rejection; assert.equal(calls, stage === "READY" ? 0 : 1);
});
test("late supplement gets only remaining outer budget; cancellation closes pending host input", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const budget = createLocalNginxApplicationBudget({ startedAt: Date.now() - 179900, startedMonotonic: performance.now() - 179900 });
  const child = fakeChild(), promise = exchangeLocalNginxGeneration(child, initialFor(), () => assert.fail("no ready"), budget.signal);
  const rejection = assert.rejects(promise, /NGINX_APPLICATION_CHANNEL_FAILED/);
  t.mock.timers.tick(101); assert.equal(budget.signal.aborted, true); assert.equal(child.stdin.writableEnded, true);
  await closeFake(child, 1); await rejection; budget.close();
});
test("outer budget rejects expired start and wall rollback without waiting for watchdog", t => {
  assert.throws(() => createLocalNginxApplicationBudget({ startedAt: Date.now() - 180001, startedMonotonic: performance.now() }), /OUTER_DEADLINE/);
  const now = Date.now(), budget = createLocalNginxApplicationBudget({ startedAt: now, startedMonotonic: performance.now() });
  t.mock.method(Date, "now", () => now - 1);
  assert.throws(() => budget.check(), /OUTER_DEADLINE/); assert.equal(budget.signal.aborted, true); budget.close();
});

test("actual host stream entrypoint brackets synthetic Linux reads and a held log until EOF", async t => {
  const f = logFixture(t), data = fixture(); syntheticCollector(t, f);
  let now = 1000; t.mock.method(Date, "now", () => now);
  const input = new PassThrough(), output = new PassThrough(); let received = "";
  output.on("data", bytes => {
    received += bytes;
    if (received.split("\n").length === 2) { fs.appendFileSync(f.logPath, jsonl(data.rows)); now = 1500; input.end(canonicalJson(data.input.transport) + "\n"); }
  });
  const promise = serveLocalNginxGeneration(input, output); input.write(canonicalJson(initialFor()) + "\n"); await promise;
  const lines = received.trimEnd().split("\n").map(JSON.parse); assert.equal(lines.length, 2);
  assert.equal(lines[1].result.state, "LOCAL_NGINX_GENERATION_HTTP_CORRELATED_NOT_LIVE_PROOF");
  assert.equal(lines[1].result.provenance, "LOCAL_HOST_READS_TRANSPORT_UNATTESTED");
});
for (const [name, tail] of [["missing transport", ""], ["partial transport", "{}"], ["blank transport", "\n"],
  ["extra line", canonicalJson(fixture().input.transport) + "\n{}\n"], ["oversized input", "x".repeat(81921)]]) {
  test(`host stream rejects ${name} and closes held fd`, async t => {
    const f = logFixture(t); syntheticCollector(t, f); let closes = 0, opened;
    const open = fs.openSync, close = fs.closeSync;
    t.mock.method(fs, "openSync", (file, ...args) => { const fd = open(file, ...args); if (file === "/out/correlation/access.jsonl") opened = fd; return fd; });
    t.mock.method(fs, "closeSync", fd => { if (fd === opened) closes++; return close(fd); });
    const input = new PassThrough(), output = new PassThrough(); let received = "";
    output.on("data", bytes => { received += bytes; input.end(tail); });
    const promise = serveLocalNginxGeneration(input, output); input.write(canonicalJson(initialFor()) + "\n");
    await assert.rejects(promise); assert.equal(closes, 1); assert.doesNotMatch(received, /RESULT_LOCAL_LOG_WINDOW/);
  });
}
