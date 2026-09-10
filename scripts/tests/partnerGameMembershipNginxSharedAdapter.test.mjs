import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../../node-red/custom-nodes/partner-game-membership-api/partner-game-membership-core.mjs";
import { generatePartnerNginxSharedOverlay, hashLocalNginxClosure, prepareLocalNginxSharedAdapter, readLocalNginxSharedAdapterBinding } from "../partner_game_membership_nginx_shared_overlay.mjs";
import { evaluateLocalNginxSharedGeneration, createLocalNginxSharedGenerationSession } from "../partner_game_membership_nginx_shared_generation.mjs";
import { PARTNER_SHARED_COVERAGE_PROBES } from "../partner_game_membership_nginx_probes.mjs";
import { PARTNER_INGRESS_REQUIRED_PROBES, verifyPartnerProductionIngress } from "../partner_game_membership_ingress_evidence.mjs";
import { createPartnerNginxTestCertificates } from "./fixtures/partner-nginx124-certificates.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "partner-shared-adapter-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const certs = createPartnerNginxTestCertificates(path.join(root, "certs"));
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const json = value => Buffer.from(canonicalJson(value));
const jsonl = rows => Buffer.from(rows.map(canonicalJson).join("\n") + "\n");
const file = (name, text) => ({ path: name, bytes: Buffer.from(text) });
const overlay = generatePartnerNginxSharedOverlay({ scope: "LOCAL_PREPARATION", exactHost: certs.exactHost, clientId: "synthetic-partner",
  sourceAddresses: ["127.0.0.1"], generationMarker: sha("new shared generation"), now: certs.now,
  clientCertificateBytes: certs.clientCertificateBytes, clientCaCertificateBytes: certs.caCertificateBytes,
  serverCertificateChainBytes: certs.serverCertificateBytes, approvedClientSpkiSha256: certs.approvedClientSpkiSha256,
  approvedClientCaSha256: sha(certs.caCertificateBytes), approvedServerChainSha256: sha(certs.serverCertificateBytes) });
const main = `worker_processes 4; events { worker_connections 1024; }
http { ssl_protocols TLSv1.2 TLSv1.3; client_header_buffer_size 2k; large_client_header_buffers 7 2k;
client_header_timeout 5s; ignore_invalid_headers on; underscores_in_headers off;
include /etc/nginx/conf.d/*.conf; include /etc/nginx/sites-enabled/*; }`;
const baseFiles = () => [file("/etc/nginx/nginx.conf", main),
  file("/etc/nginx/conf.d/existing.conf", "map $uri $existing { default 0; }") ,
  file("/etc/nginx/sites-enabled/default.conf", "server { listen 443 ssl default_server; listen [::]:443 ssl default_server; server_name shared.invalid; return 404; }")];
const args = (baselineFiles = baseFiles()) => ({ baselineFiles, candidateFiles: [...baselineFiles, file(overlay.path, overlay.configuration)],
  expectedBaselineSha256: hashLocalNginxClosure(baselineFiles), overlay });
const preparation = prepareLocalNginxSharedAdapter(args());
const workerFiles = declaration => {
  const files = baseFiles();
  files[0].bytes = Buffer.from(main.replace("worker_processes 4;", declaration));
  return files;
};

test("auto declaration is accepted without deriving a worker count or upgrading evidence", () => {
  const input = args(workerFiles("worker_processes auto;"));
  const prepared = prepareLocalNginxSharedAdapter(input);
  assert.deepEqual(prepared.dialect, preparation.dialect);
  assert.equal(prepared.state, preparation.state);
  assert.equal(prepared.productionVerified, false);
  assert.equal(prepared.dialect.nativeValidation, "NOT_RUN");
  assert.equal(prepared.dialect.loadedConfiguration, "NOT_PROVEN");
  assert.ok(input.baselineFiles[0].bytes.equals(input.candidateFiles[0].bytes));
  assert.throws(() => verifyPartnerProductionIngress(prepared), /UNSUPPORTED_INGRESS_ADAPTER/);
});

for (const [name, declaration] of [
  ["missing", ""], ["comment only", "# worker_processes auto;\n"],
  ["duplicate auto", "worker_processes auto; worker_processes auto;"],
  ["duplicate four", "worker_processes 4; worker_processes 4;"],
  ["mixed declarations", "worker_processes auto; worker_processes 4;"],
  ...["AUTO", "0", "1", "3", "5", "8", "04", "$workers", "auto 4", "4 auto", ""].map(value => [JSON.stringify(value), `worker_processes ${value};`]),
  ["block", "worker_processes auto {}"],
]) test(`worker declaration refuses ${name}`, () => {
  assert.throws(() => prepareLocalNginxSharedAdapter(args(workerFiles(declaration))), /NGINX_SHARED_DIALECT_/);
});

test("worker declaration counts expanded main include instances, not unique files", () => {
  const include = "include /etc/nginx/worker.conf;";
  const files = workerFiles(include);
  files.push(file("/etc/nginx/worker.conf", "worker_processes auto;"));
  assert.deepEqual(prepareLocalNginxSharedAdapter(args(files)).dialect, preparation.dialect);
  for (const declaration of [`worker_processes 4; ${include}`, `${include} ${include}`]) {
    files[0].bytes = Buffer.from(main.replace("worker_processes 4;", declaration));
    assert.throws(() => prepareLocalNginxSharedAdapter(args(files)), /NGINX_SHARED_DIALECT_DUPLICATE_SETTING/);
  }
});

test("worker text in comments and map data is not a declaration; actual non-main declarations fail", () => {
  const files = workerFiles("# worker_processes 4;\nworker_processes auto;");
  files[1].bytes = Buffer.from('map $uri $existing { worker_processes auto; default "worker_processes 4;"; }');
  assert.equal(prepareLocalNginxSharedAdapter(args(files)).productionVerified, false);
  files[0].bytes = Buffer.from(main.replace("worker_processes 4;", ""));
  assert.throws(() => prepareLocalNginxSharedAdapter(args(files)), /NGINX_SHARED_DIALECT_WORKER_DECLARATION_REQUIRED/);
  for (const statement of ["worker_processes auto;", "location /other { worker_processes auto; }"]) {
    const nested = workerFiles("worker_processes auto;");
    nested[2].bytes = Buffer.from(nested[2].bytes.toString().replace("return 404;", statement));
    assert.throws(() => prepareLocalNginxSharedAdapter(args(nested)), /NGINX_SHARED_DIALECT_MAIN_UNSUPPORTED/);
  }
});

for (const [before, after] of [["auto", "4"], ["4", "auto"]])
  test(`shared preparation cannot rewrite worker declaration ${before} to ${after}`, () => {
    const input = args(workerFiles(`worker_processes ${before};`));
    input.candidateFiles[0] = file("/etc/nginx/nginx.conf", main.replace("worker_processes 4;", `worker_processes ${after};`));
    assert.throws(() => prepareLocalNginxSharedAdapter(input), /NGINX_SHARED_EXISTING_FILE_CHANGED/);
  });

test("shared preparation retains unchanged explicit defaults, early settings and false live flags", () => {
  assert.equal(preparation.dialect.explicitUnchangedDefaults, 2);
  assert.equal(preparation.state, "LOCAL_SHARED_ADAPTER_PREPARED_NOT_DEPLOYABLE");
  for (const key of ["productionVerified", "deployAuthorized", "activationAuthorized"]) assert.equal(preparation[key], false);
  assert.throws(() => readLocalNginxSharedAdapterBinding({ ...preparation }), /SOURCE_OWNED_PREPARATION_REQUIRED/);
  assert.throws(() => verifyPartnerProductionIngress(preparation), /UNSUPPORTED_INGRESS_ADAPTER/);
  assert.match(overlay.configuration, /add_header X-Padlhub-Ingress-Request-Id \$request_id always;/);
  assert.match(overlay.configuration, /proxy_hide_header X-Padlhub-Ingress-Request-Id;/);
  for (const line of ["proxy_pass_request_headers on;", "proxy_pass_request_body on;", "proxy_redirect off;", "gzip off;"])
    assert.ok(overlay.configuration.includes(line));
  assert.match(overlay.configuration, /proxy_ignore_headers X-Accel-Redirect X-Accel-Expires X-Accel-Limit-Rate X-Accel-Buffering X-Accel-Charset;/);
});

for (const directive of ['error_page 403 =302 https://redirect.invalid;', '"error_page" 403 /other;',
  'error\\_page 403 /other;', 'auth_request /authorize;', 'auth_basic "login";', 'mirror /copy;', 'proxy_method POST;',
  'proxy_set_body "replaced";', 'proxy_pass_request_body off;', 'proxy_pass_request_headers off;',
  'proxy_pass_header X-Accel-Redirect;', 'proxy_ignore_headers Set-Cookie;', 'add_trailer X-Extra value;', 'expires 1h;',
  'sub_filter old new;', 'charset utf-8;', 'content_by_lua_block { arbitrary_code; }', 'unknown_handler on;', 'ssl_conf_command Protocol TLSv1.1;'])
  test(`inherited directive rejected: ${directive.split(" ")[0]} ${directive.split(" ")[1]}`, () => {
    for (const index of [0, 1]) {
      const files = baseFiles();
      files[index].bytes = Buffer.from(index ? directive : main.replace("http {", `http { ${directive}`));
      assert.throws(() => prepareLocalNginxSharedAdapter(args(files)), /NGINX_SHARED_DIALECT_/);
    }
  });

test("nested inherited handler rejected even when same file appeared under a sibling server first", () => {
  const files = baseFiles(); files[1].bytes = Buffer.from("map $uri $existing { default 0; }");
  files[0].bytes = Buffer.from(main.replace("include /etc/nginx/sites-enabled/*;", "include /etc/nginx/sites-enabled/*; include /etc/nginx/options.conf;"));
  files[2].bytes = Buffer.from(files[2].bytes.toString().replace("return 404;", "include /etc/nginx/options.conf; return 404;"));
  files.push(file("/etc/nginx/options.conf", "error_page 403 /login;"));
  assert.throws(() => prepareLocalNginxSharedAdapter(args(files)), /NGINX_SHARED_DIALECT_INHERITED_UNSUPPORTED/);
  files[0].bytes = Buffer.from(main);
  assert.equal(prepareLocalNginxSharedAdapter(args(files)).productionVerified, false);
});

test("preparation does not reread caller Buffer methods for a different dialect snapshot", () => {
  const input = args(); let calls = 0;
  input.baselineFiles[0].bytes.toString = () => { calls++; return calls === 1 ? main + "error_page 403 /login;" : main; };
  assert.throws(() => prepareLocalNginxSharedAdapter(input), /NGINX_SHARED_CLOSURE_INVALID/);
  assert.equal(calls, 0);
});
for (const destination of ["$http_host", "$HTTP_HOST", "$http_transfer_encoding", "$http_x_padlhub_client_id",
  "$ssl_client_verify", "$request_id", "$request_method", "$upstream_status", "$sent_http_x_padlhub_ingress_request_id", "$remote_addr", "$binary_remote_addr"])
  test(`map cannot shadow guard or correlation variable ${destination}`, () => {
    const files = baseFiles(); files[1].bytes = Buffer.from(`map $uri ${destination} { default fixture.invalid; }`);
    assert.throws(() => prepareLocalNginxSharedAdapter(args(files)), /NGINX_SHARED_DIALECT_RESERVED_VARIABLE_OVERRIDE/);
  });
test("case-insensitive namespace and equivalent hostname cannot collide", () => {
  for (const text of ["map $uri $PGM_V02_ROUTE { default 1; }", "server { server_name FIXTURE.INVALID.; }"]) {
    const files = baseFiles(); files[1].bytes = Buffer.from(text);
    assert.throws(() => prepareLocalNginxSharedAdapter(args(files)), /NGINX_SHARED_(NAMESPACE_COLLISION|HOST_COLLISION)/);
  }
});

for (const context of ["location", "map"])
  test(`bare apostrophe named capture cannot shadow global variable in ${context}`, () => {
    const files = baseFiles();
    if (context === "map") files[1].bytes = Buffer.from("map $uri $existing { ~(?'http_host'.*) captured; }");
    else files[2].bytes = Buffer.from(files[2].bytes.toString().replace("return 404;", "location ~ (?'http_host'.*) { return 404; }"));
    assert.throws(() => prepareLocalNginxSharedAdapter(args(files)), /NGINX_SHARED_DIALECT_RESERVED_VARIABLE_OVERRIDE/);
  });

test("sibling set and regex captures cannot declare protected global variables", () => {
  for (const statement of ["set $http_host fixture.invalid;", "location /other { set $HTTP_X_PADLHUB_CLIENT_ID synthetic-partner; }",
    'location "~(?<http_host>.*)" { return 404; }', 'location "~(?P<request_id>.*)" { return 404; }',
    'location "~(?\'http_transfer_encoding\'.*)" { return 404; }']) {
    const files = baseFiles(); files[2].bytes = Buffer.from(files[2].bytes.toString().replace("return 404;", statement));
    assert.throws(() => prepareLocalNginxSharedAdapter(args(files)), /NGINX_SHARED_DIALECT_RESERVED_VARIABLE_OVERRIDE/);
  }
  const files = baseFiles(); files[1].bytes = Buffer.from('map $uri $existing { "~(?<http_host>.*)" captured; }');
  assert.throws(() => prepareLocalNginxSharedAdapter(args(files)), /NGINX_SHARED_DIALECT_RESERVED_VARIABLE_OVERRIDE/);
  files[1].bytes = Buffer.from('map $http_host $existing { default $http_transfer_encoding; load_module literal; }');
  assert.equal(prepareLocalNginxSharedAdapter(args(files)).productionVerified, false);
});

for (const [name, mutate] of [
  ["implicit IPv4 default", files => { files[2].bytes = Buffer.from(files[2].bytes.toString().replace("443 ssl default_server", "443 ssl")); }],
  ["implicit IPv6 default", files => { files[2].bytes = Buffer.from(files[2].bytes.toString().replace("[::]:443 ssl default_server", "[::]:443 ssl")); }],
  ["conflicting explicit defaults", files => { files.push(file("/etc/nginx/sites-enabled/second.conf", "server { listen 443 ssl default_server; server_name other.invalid; }")); }],
  ["wrong server settings attached by order", files => { files[2].bytes = Buffer.from("server { listen 443 ssl default_server; listen [::]:443 ssl default_server; client_header_buffer_size 8k; server_name shared.invalid; } server { listen 443 ssl; client_header_buffer_size 2k; server_name other.invalid; }"); }],
  ["address-specific listener", files => { files[2].bytes = Buffer.from(files[2].bytes.toString().replace("listen 443", "listen 127.0.0.1:443")); }],
  ["proxy protocol", files => { files[2].bytes = Buffer.from(files[2].bytes.toString().replace("443 ssl", "443 ssl proxy_protocol")); }],
  ["shared HTTP2", files => { files[2].bytes = Buffer.from(files[2].bytes.toString().replace("443 ssl", "443 ssl http2")); }],
  ["early header buffer", files => { files[0].bytes = Buffer.from(main.replace("7 2k", "4 8k")); }],
  ["TLS downgrade", files => { files[0].bytes = Buffer.from(main.replace("TLSv1.2 TLSv1.3", "TLSv1 TLSv1.2")); }],
  ["missing early setting", files => { files[0].bytes = Buffer.from(main.replace("ignore_invalid_headers on;", "")); }],
  ["module load", files => { files[0].bytes = Buffer.from("load_module /etc/nginx/example.so;\n" + main); }],
]) test(`shared compatibility refuses ${name}`, () => {
  for (const mode of ["4", "auto"]) {
    const files = baseFiles(); mutate(files);
    files[0].bytes = Buffer.from(files[0].bytes.toString().replace("worker_processes 4;", `worker_processes ${mode};`));
    assert.throws(() => prepareLocalNginxSharedAdapter(args(files)), /NGINX_SHARED_DIALECT_/);
  }
});

function data(prepared = preparation) {
  const binding = readLocalNginxSharedAdapterBinding(prepared);
  const process = (pid, ticks, parentPid = 10) => ({ pid, parentPid, startTicks: String(ticks), executableSha256: sha("nginx binary"), draining: false });
  const baseline = { scope: "LOCAL_FIXTURE", configSha256: sha("unchanged root file"), master: process(10, 100, 1),
    workers: Array.from({ length: 4 }, (_, i) => process(11 + i, 200 + i)), bootSha256: sha("boot"), pidNamespaceSha256: sha("pidns"), networkNamespaceSha256: sha("netns") };
  const before = { ...baseline, workers: Array.from({ length: 4 }, (_, i) => process(21 + i, 300 + i)) };
  const transport = { state: "NGINX_SHARED_TRANSPORT_OBSERVATIONS_NOT_INGRESS_PROOF", challenge: sha("fresh challenge"), startedAt: 1100, completedAt: 30000,
    target: { address: "127.0.0.1", sourceBindAddress: "127.0.0.1", port: 443, sidecarPort: 18894, exactHost: certs.exactHost, sharedHost: "shared.invalid" },
    clientId: "synthetic-partner", probes: [], productionVerified: false, deployAuthorized: false, activationAuthorized: false,
    vantage: "UNATTESTED", applicationEvidence: "NOT_COLLECTED", upstreamAdmission: "NOT_COLLECTED" };
  const rows = [], positives = new Set(["positiveDefaultOff", "cors", ...PARTNER_SHARED_COVERAGE_PROBES]);
  for (const [index, id] of [...PARTNER_INGRESS_REQUIRED_PROBES, ...PARTNER_SHARED_COVERAGE_PROBES].entries()) {
    const opaque = ["wrongSni", "directSidecar"].includes(id), external = id === "sharedHost", positive = positives.has(id);
    const statuses = { positiveDefaultOff: 503, cors: 503, wrongHost: 421, editorAdmin: 404, options: 405, query: 404, noClientCertificate: 400, wrongClientCertificate: 403, sharedHost: 404 };
    const probe = { id, probeId: sha(`PADLHUB-NGINX-SHARED-PROBE-V1\n${transport.challenge}\n${id}`),
      outcome: opaque ? id === "directSidecar" ? "CONNECTION_REFUSED" : "TLS_ALERT" : "HTTP_RESPONSE",
      errorCode: opaque ? id === "directSidecar" ? "ECONNREFUSED" : "ERR_SSL_TLSV1_UNRECOGNIZED_NAME" : null,
      httpStatus: opaque ? null : positive ? 503 : statuses[id], complete: !opaque, tlsAuthorized: !opaque,
      tlsProtocol: opaque ? null : "TLSv1.3", alpnProtocol: null,
      serverLeafSha256: opaque ? null : sha("server leaf"), serverSpkiSha256: opaque ? null : binding.serverSpkiSha256,
      actualClientLeafSha256: opaque || id === "noClientCertificate" ? null : id === "wrongClientCertificate" ? sha("wrong client") : binding.clientLeafSha256,
      sourceAddress: opaque ? null : "127.0.0.1", peerAddress: opaque ? null : "127.0.0.1", peerPort: opaque ? null : 443,
      cacheControl: opaque ? null : "no-store", corsHeaderPresent: false, bodyBytes: opaque ? 0 : 2, bodySha256: opaque ? null : sha("{}"),
      startedAt: 1200 + index * 700, completedAt: 1210 + index * 700, ingressRequestId: opaque || external ? null : sha(`response${index}`).slice(0, 32) };
    transport.probes.push(probe);
    if (!opaque && !external) rows.push({ admitted: positive ? "1" : "0", clientVerified: positive ? "1" : "0", concurrency: positive ? "PASSED" : "-",
      generation: binding.generationMarker, rate: positive ? "PASSED" : "-", requestId: probe.ingressRequestId,
      status: String(probe.httpStatus), upstream: positive ? "503" : "-", worker: String(21 + index % 4) });
  }
  return { rows, observation: { scope: "LOCAL_PREPARATION", baseline, before, after: structuredClone(before),
    closure: { baselineSha256: binding.baselineSha256, candidateSha256: binding.candidateSha256 }, transport, startedAt: 1000, completedAt: 31000 } };
}
const evaluate = (f, prepared = preparation) => evaluateLocalNginxSharedGeneration({ preparation: prepared, observationBytes: json(f.observation), logBytes: jsonl(f.rows) });

test("auto still requires four distinct correlated workers and rejects partial coverage", () => {
  const prepared = prepareLocalNginxSharedAdapter(args(workerFiles("worker_processes auto;")));
  const f = data(prepared);
  const result = evaluate(f, prepared);
  assert.equal(result.state, "LOCAL_SHARED_FOUR_WORKERS_CORRELATED_NOT_LIVE_PROOF");
  assert.equal(result.productionVerified, false);
  for (const row of f.rows) row.worker = "21";
  assert.equal(evaluate(f, prepared).state, "LOCAL_SHARED_WORKER_COVERAGE_NOT_PROVEN");
  for (const which of ["baseline", "before", "after"]) {
    for (const count of [3, 5]) {
      const wrong = data(prepared), workers = wrong.observation[which].workers;
      if (count === 3) workers.pop();
      else workers.push({ ...workers.at(-1), pid: workers.at(-1).pid + 1 });
      assert.throws(() => evaluate(wrong, prepared), /NGINX_SHARED_GENERATION_SNAPSHOT_INVALID/);
    }
  }
});

test("four distinct new workers correlate by server response ID, not log order or caller probe ID", () => {
  const f = data(); f.rows.reverse(); const result = evaluate(f);
  assert.equal(result.state, "LOCAL_SHARED_FOUR_WORKERS_CORRELATED_NOT_LIVE_PROOF");
  assert.equal(result.coveredWorkers, 4); assert.equal(result.admittedHttpProbes, 18);
  assert.deepEqual(result.uncorrelatedProbes, ["wrongSni", "sharedHost", "directSidecar"]);
  assert.equal(f.observation.baseline.configSha256, f.observation.before.configSha256); // Root file unchanged is legitimate.
  for (const key of ["productionVerified", "deployAuthorized", "activationAuthorized"]) assert.equal(result[key], false);
  assert.equal(result.closureCustody, "NOT_CHECKED"); assert.equal(result.controlledApplication, "NOT_PROVEN");
  assert.throws(() => verifyPartnerProductionIngress(result), /UNSUPPORTED_INGRESS_ADAPTER/);
  assert.doesNotMatch(JSON.stringify(result), /requestId|sourceAddress|serverSpki|synthetic-partner|127\.0\.0\.1/);
});
test("coverage budget ending with only one worker yields NOT_PROVEN, never four-worker success", () => {
  const f = data(); for (const row of f.rows) row.worker = "21";
  const result = evaluate(f); assert.equal(result.coveredWorkers, 1); assert.equal(result.state, "LOCAL_SHARED_WORKER_COVERAGE_NOT_PROVEN");
});
for (const [name, mutate] of [
  ["old worker", f => { f.observation.before.workers[0] = f.observation.baseline.workers[0]; f.observation.after = structuredClone(f.observation.before); }],
  ["PID reuse", f => { f.observation.before.workers[0].pid = 11; f.observation.after = structuredClone(f.observation.before); }],
  ["worker too old", f => { f.observation.before.workers[0].startTicks = "203"; f.observation.after = structuredClone(f.observation.before); }],
  ["extra worker", f => { f.observation.before.workers.push({ ...f.observation.before.workers[0], pid: 25 }); f.observation.after = structuredClone(f.observation.before); }],
  ["draining worker", f => { f.observation.before.workers[0].draining = true; f.observation.after = structuredClone(f.observation.before); }],
  ["worker parent", f => { f.observation.before.workers[0].parentPid = 1; f.observation.after = structuredClone(f.observation.before); }],
  ["worker binary", f => { f.observation.before.workers[0].executableSha256 = sha("other"); f.observation.after = structuredClone(f.observation.before); }],
  ["snapshot drift", f => { f.observation.after.workers[0].startTicks = "999"; }],
  ["epoch drift", f => { f.observation.baseline.bootSha256 = sha("oldboot"); }],
  ["wrong closure", f => { f.observation.closure.candidateSha256 = sha("otherclosure"); }],
  ["root file used as closure", f => { f.observation.closure.candidateSha256 = f.observation.before.configSha256; }],
  ["caller proof", f => { f.observation.transport.productionVerified = true; }],
  ["wrong clientId", f => { f.observation.transport.clientId = "another-partner"; }],
  ["challenge substitution", f => { f.observation.transport.challenge = sha("otherchallenge"); }],
  ["wrong source", f => { f.observation.transport.target.sourceBindAddress = "127.0.0.2"; }],
  ["missing probe", f => { f.observation.transport.probes.pop(); }],
  ["duplicate response ID", f => { f.observation.transport.probes[1].ingressRequestId = f.observation.transport.probes[0].ingressRequestId; }],
  ["invented response ID", f => { f.observation.transport.probes[0].ingressRequestId = sha("invented").slice(0, 32); }],
  ["probeId used as response ID", f => { f.observation.transport.probes[0].ingressRequestId = f.observation.transport.probes[0].probeId; }],
  ["positive missing ID", f => { f.observation.transport.probes[0].ingressRequestId = null; }],
  ["wrong server key", f => { f.observation.transport.probes[0].serverSpkiSha256 = sha("wrong server"); }],
  ["wrong client leaf", f => { f.observation.transport.probes[0].actualClientLeafSha256 = sha("wrong leaf"); }],
  ["cache enabled", f => { f.observation.transport.probes[0].cacheControl = null; }],
  ["CORS enabled", f => { f.observation.transport.probes[0].corsHeaderPresent = true; }],
  ["truncated response", f => { f.observation.transport.probes[0].complete = false; }],
  ["old marker", f => { f.rows[0].generation = sha("old marker"); }],
  ["unknown audit worker", f => { f.rows[0].worker = "11"; }],
  ["duplicate audit ID", f => { f.rows[1].requestId = f.rows[0].requestId; }],
  ["unmatched traffic", f => { f.rows.push({ ...f.rows[0], requestId: sha("unknown").slice(0, 32) }); }],
  ["edge synthetic 503", f => { f.rows[0].upstream = "-"; }],
  ["retry", f => { f.rows[0].upstream = "503, 503"; }],
  ["dry-run limiter", f => { f.rows[0].rate = "REJECTED_DRY_RUN"; }],
  ["negative upstream", f => { f.rows[1].upstream = "503"; }],
  ["audit secret extra", f => { f.rows[0].nonce = "synthetic"; }],
  ["legacy audit fields", f => { f.rows[0].probeId = sha("legacy"); f.rows[0].source = "127.0.0.1"; }],
  ["time window", f => { f.observation.completedAt = 999; }],
]) test(`shared generation refuses ${name}`, () => { const f = data(); mutate(f); assert.throws(() => evaluate(f), /NGINX_SHARED_GENERATION_/); });

test("canonical bounded JSON and source-owned preparation reject extra fields or raw-input methods", () => {
  const f = data();
  for (const observationBytes of [Buffer.from("{}"), Buffer.from('{"scope":1,"scope":2}'), Buffer.alloc(262145), Buffer.from([255])])
    assert.throws(() => evaluateLocalNginxSharedGeneration({ preparation, observationBytes, logBytes: jsonl(f.rows) }), /NGINX_SHARED_GENERATION_/);
  assert.throws(() => evaluateLocalNginxSharedGeneration({ preparation: { ...preparation }, observationBytes: json(f.observation), logBytes: jsonl(f.rows) }), /SOURCE_OWNED_PREPARATION_REQUIRED/);
  const value = json(f.observation); value.toString = () => { throw new Error("must not execute"); };
  assert.throws(() => evaluateLocalNginxSharedGeneration({ preparation, observationBytes: value, logBytes: jsonl(f.rows) }), /NGINX_SHARED_GENERATION_/);
});
test("host wiring retains nonroot Linux fixture boundary, never opens production fallback", t => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...original, value: "darwin" });
  t.after(() => Object.defineProperty(process, "platform", original));
  assert.throws(() => createLocalNginxSharedGenerationSession({ preparation, baselineBytes: json(data().observation.baseline), logPath: "/not/opened" }), /LOCAL_NGINX_LINUX_FIXTURE_REQUIRED/);
});

// Synthetic /proc files exercise the real fixed reader and held-fd wiring. They
// are not a native Linux/Nginx run and never change host metadata or global paths.
function hostFixture(t, finalRead, initialRead = () => {}) {
  const directory = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), ".shared-generation-")); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const logPath = path.join(directory, "audit.jsonl"); fs.writeFileSync(logPath, "", { mode: 0o600 });
  const source = new Map([["/control/nginx.pid", "10\n"], ["/control/nginx.conf", "unchanged root file"],
    ["/proc/10/task/10/children", "21 22 23 24"], ["/proc/sys/kernel/random/boot_id", "boot"]]);
  for (const p of [data().observation.before.master, ...data().observation.before.workers]) {
    source.set(`/proc/${p.pid}/stat`, `${p.pid} (nginx) S ${[p.parentPid, ...Array(17).fill("0"), p.startTicks].join(" ")}\n`);
    source.set(`/proc/${p.pid}/cmdline`, p.pid === 10 ? "nginx: master process /usr/sbin/nginx -c /control/nginx.conf -g daemon off;\0" : "nginx: worker process\0");
    source.set(`/proc/${p.pid}/exe`, "nginx binary");
  }
  const mapping = new Map();
  for (const [name, content] of source) {
    const filePath = path.join(directory, `source-${mapping.size}`); fs.writeFileSync(filePath, content, { mode: 0o600 }); mapping.set(name, filePath);
  }
  let namespaceReads = 0;
  for (const method of ["openSync", "lstatSync", "readFileSync"]) {
    const original = fs[method]; t.mock.method(fs, method, (name, ...args) => original(mapping.get(name) ?? name, ...args));
  }
  const realpath = fs.realpathSync, readlink = fs.readlinkSync;
  t.mock.method(fs, "realpathSync", name => mapping.has(name) ? name : realpath(name));
  t.mock.method(fs, "readlinkSync", name => {
    if (/^\/proc\/(self|10)\/ns\/(pid|net)$/.test(name)) {
      namespaceReads++;
      if (namespaceReads === 4) initialRead();
      if (namespaceReads === 12) finalRead(); // Last read of the third snapshot.
      return name.endsWith("/pid") ? "pidns" : "netns";
    }
    return readlink(name);
  });
  for (const [name, value] of [["platform", "linux"], ["arch", "x64"]]) {
    const original = Object.getOwnPropertyDescriptor(process, name);
    Object.defineProperty(process, name, { ...original, value });
    t.after(() => Object.defineProperty(process, name, original));
  }
  return { logPath };
}
test("shared host session binds fixed reader and fresh log suffix once (synthetic proc)", t => {
  const f = data(), host = hostFixture(t, () => {}); let now = 1000;
  t.mock.method(Date, "now", () => now);
  const session = createLocalNginxSharedGenerationSession({ preparation, baselineBytes: json(f.observation.baseline), logPath: host.logPath });
  t.after(() => session.close()); fs.appendFileSync(host.logPath, jsonl(f.rows)); now = 31000;
  const result = session.finish(json(f.observation.transport));
  assert.equal(result.coveredWorkers, 4); assert.equal(result.logWindow.suffixSha256, sha(jsonl(f.rows)));
  assert.equal(result.provenance, "LOCAL_FIXTURE_READS_CLOSURE_AND_TRANSPORT_UNATTESTED");
  assert.throws(() => session.finish(json(f.observation.transport)), /SESSION_CLOSED/);
});
test("crossing outer deadline during final snapshot cannot return success or leave session open", t => {
  const f = data(); let monotonic = 0, now = 1000;
  const host = hostFixture(t, () => { monotonic = 90001; }, () => { monotonic = 1000; });
  t.mock.method(Date, "now", () => now); t.mock.method(performance, "now", () => monotonic);
  const session = createLocalNginxSharedGenerationSession({ preparation, baselineBytes: json(f.observation.baseline), logPath: host.logPath });
  t.after(() => session.close()); fs.appendFileSync(host.logPath, jsonl(f.rows)); now = 31000; monotonic = 89000;
  assert.throws(() => session.finish(json(f.observation.transport)), /NGINX_SHARED_GENERATION_WINDOW_INVALID/);
  assert.throws(() => session.finish(json(f.observation.transport)), /SESSION_CLOSED/);
});
