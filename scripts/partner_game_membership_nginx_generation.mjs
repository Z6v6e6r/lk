// LOCAL evidence consistency, not a production verdict, reload or trusted operator.
import crypto from "node:crypto";
import net from "node:net";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { canonicalJson } from "../node-red/custom-nodes/partner-game-membership-api/partner-game-membership-core.mjs";
import { PARTNER_INGRESS_REQUIRED_PROBES, parseCanonicalIngressJson, PartnerIngressEvidenceError } from "./partner_game_membership_ingress_evidence.mjs";
import { openPartnerNginxLogWindow } from "./partner_game_membership_nginx_log_window.mjs";
import { collectLocalNginxLinuxSnapshot } from "./partner_game_membership_nginx_linux.mjs";

const fail = code => { throw new PartnerIngressEvidenceError(code); };
const hostFailure = error => {
  if (error instanceof PartnerIngressEvidenceError) throw error;
  if (typeof error?.message === "string" && /^(?:NGINX|LOCAL_NGINX)_[A-Z0-9_]{1,72}$/.test(error.message)) fail(error.message);
  fail("NGINX_HOST_OBSERVATION_FAILED");
};
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const HASH = /^[a-f0-9]{64}$/, HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const exact = (value, fields, code) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || !isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort())) fail(code);
};
const hashed = value => typeof value === "string" && HASH.test(value);
const LOG_KEYS = ["admitted", "clientVerified", "generation", "probeId", "requestId", "source", "status", "upstream", "worker"];
const PROBE_KEYS = ["id", "probeId", "outcome", "errorCode", "httpStatus", "complete", "tlsAuthorized", "tlsProtocol", "alpnProtocol",
  "serverLeafSha256", "serverSpkiSha256", "actualClientLeafSha256", "sourceAddress", "peerAddress", "peerPort", "cacheControl",
  "corsHeaderPresent", "bodyBytes", "bodySha256", "startedAt", "completedAt"];

// Fixed, source-only http{} fragment. Caller cannot substitute request/upstream
// variables as the generation literal, arbitrary snippets, paths or log fields.
export function buildLocalNginxCorrelationLogPolicy(generationMarker) {
  if (!hashed(generationMarker)) fail("NGINX_GENERATION_MARKER_INVALID");
  return `map $http_x_padlhub_probe_id $partner_probe_id { default ""; "~^[a-f0-9]{64}$" $http_x_padlhub_probe_id; }
log_format partner_correlation escape=json '{"admitted":"$partner_admitted","clientVerified":"$partner_verified","generation":"${generationMarker}","probeId":"$partner_probe_id","requestId":"$request_id","source":"$remote_addr","status":"$status","upstream":"$upstream_status","worker":"$pid"}';
`;
}

function validateSnapshot(value) {
  exact(value, ["scope", "configSha256", "master", "workers", "bootSha256", "pidNamespaceSha256", "networkNamespaceSha256"], "NGINX_GENERATION_SNAPSHOT_INVALID");
  if (value.scope !== "LOCAL_FIXTURE" || ["configSha256", "bootSha256", "pidNamespaceSha256", "networkNamespaceSha256"].some(key => !hashed(value[key]))) fail("NGINX_GENERATION_SNAPSHOT_INVALID");
  const process = item => {
    exact(item, ["pid", "parentPid", "startTicks", "executableSha256", "draining"], "NGINX_GENERATION_PROCESS_INVALID");
    if (!Number.isSafeInteger(item.pid) || item.pid < 1 || !Number.isSafeInteger(item.parentPid) || item.parentPid < 0
      || typeof item.startTicks !== "string" || !/^[1-9][0-9]{0,19}$/.test(item.startTicks)
      || !hashed(item.executableSha256) || item.draining !== false) fail("NGINX_GENERATION_PROCESS_INVALID");
  };
  process(value.master);
  // Keep the existing one-worker fixture dialect; do not guess shared nginx's
  // worker topology or claim that an unobserved worker has the same configuration.
  if (!Array.isArray(value.workers) || value.workers.length !== 1 || Object.keys(value.workers).join() !== "0") fail("NGINX_GENERATION_WORKERS_INVALID");
  const worker = value.workers[0]; process(worker);
  if (worker.pid === value.master.pid || worker.parentPid !== value.master.pid || worker.executableSha256 !== value.master.executableSha256
    || value.master.parentPid === value.master.pid || value.master.parentPid === worker.pid
    || BigInt(worker.startTicks) < BigInt(value.master.startTicks)) fail("NGINX_GENERATION_PROCESS_INVALID");
}
function generation(baseline, before, after, expected) {
  for (const snapshot of [baseline, before, after]) validateSnapshot(snapshot);
  if (!isDeepStrictEqual(before, after)) fail("NGINX_GENERATION_RUNTIME_DRIFT");
  for (const key of ["master", "bootSha256", "pidNamespaceSha256", "networkNamespaceSha256"]) {
    if (!isDeepStrictEqual(baseline[key], before[key])) fail("NGINX_GENERATION_EPOCH_CHANGED");
  }
  if (before.configSha256 !== expected.configSha256 || before.configSha256 === baseline.configSha256) fail("NGINX_GENERATION_CONFIG_MISMATCH");
  if (before.workers[0].pid === baseline.workers[0].pid || BigInt(before.workers[0].startTicks) <= BigInt(baseline.workers[0].startTicks)) fail("NGINX_GENERATION_NEW_WORKER_REQUIRED");
}
function binding(expected) {
  exact(expected, ["configSha256", "generationMarker", "target", "serverSpkiSha256", "clientLeafSha256", "wrongClientLeafSha256"], "NGINX_CORRELATION_BINDING_INVALID");
  if (Object.entries(expected).some(([key, value]) => key !== "target" && !hashed(value))
    || expected.clientLeafSha256 === expected.wrongClientLeafSha256) fail("NGINX_CORRELATION_BINDING_INVALID");
  exact(expected.target, ["address", "sourceBindAddress", "port", "sidecarPort", "exactHost", "sharedHost"], "NGINX_CORRELATION_BINDING_INVALID");
  for (const key of ["address", "sourceBindAddress"]) if (typeof expected.target[key] !== "string" || net.isIP(expected.target[key]) !== 4) fail("NGINX_CORRELATION_BINDING_INVALID");
  for (const key of ["port", "sidecarPort"]) if (!Number.isSafeInteger(expected.target[key]) || expected.target[key] < 1 || expected.target[key] > 65535) fail("NGINX_CORRELATION_BINDING_INVALID");
  for (const key of ["exactHost", "sharedHost"]) if (typeof expected.target[key] !== "string" || expected.target[key].length > 253 || !HOST.test(expected.target[key])) fail("NGINX_CORRELATION_BINDING_INVALID");
  if (expected.target.exactHost === expected.target.sharedHost || expected.target.port === expected.target.sidecarPort) fail("NGINX_CORRELATION_BINDING_INVALID");
}
function parseLogs(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 65536 || bytes.at(-1) !== 10) fail("NGINX_CORRELATION_LOG_INVALID");
  const lines = bytes.subarray(0, -1).toString("utf8").split("\n");
  if (lines.length > 11) fail("NGINX_CORRELATION_LOG_INVALID");
  // Reject invalid UTF8 before converting back to buffers for strict JSON parsing.
  if (!Buffer.from(lines.join("\n") + "\n").equals(bytes)) fail("NGINX_CORRELATION_LOG_INVALID");
  return lines.map(line => {
    let row;
    try { row = parseCanonicalIngressJson(Buffer.from(line), 2048); }
    catch { fail("NGINX_CORRELATION_LOG_INVALID"); }
    exact(row, LOG_KEYS, "NGINX_CORRELATION_LOG_INVALID");
    if (!["0", "1"].includes(row.admitted) || !["0", "1"].includes(row.clientVerified) || !hashed(row.generation) || !hashed(row.probeId)
      || typeof row.requestId !== "string" || !/^[a-f0-9]{32}$/.test(row.requestId) || typeof row.source !== "string" || net.isIP(row.source) !== 4
      || typeof row.status !== "string" || !/^[2-5][0-9]{2}$/.test(row.status)
      || !["", "-", "503"].includes(row.upstream) || typeof row.worker !== "string" || !/^[1-9][0-9]{0,9}$/.test(row.worker)) fail("NGINX_CORRELATION_LOG_INVALID");
    return row;
  });
}

export function evaluateLocalNginxGenerationCorrelation(input) {
  exact(input, ["baseline", "before", "after", "expected", "transport", "logBytes", "startedAt", "completedAt"], "NGINX_CORRELATION_INPUT_INVALID");
  const { baseline, before, after, expected, transport, logBytes, startedAt, completedAt } = input;
  binding(expected); generation(baseline, before, after, expected);
  if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(completedAt) || completedAt < startedAt || completedAt - startedAt > 90000) fail("NGINX_CORRELATION_WINDOW_INVALID");
  exact(transport, ["state", "challenge", "startedAt", "completedAt", "target", "probes", "productionVerified", "deployAuthorized", "activationAuthorized", "vantage", "applicationEvidence", "upstreamAdmission"], "NGINX_CORRELATION_TRANSPORT_INVALID");
  if (transport.state !== "NGINX_TRANSPORT_OBSERVATIONS_NOT_INGRESS_PROOF" || !hashed(transport.challenge)
    || transport.productionVerified !== false || transport.deployAuthorized !== false || transport.activationAuthorized !== false
    || transport.vantage !== "UNATTESTED" || transport.applicationEvidence !== "NOT_COLLECTED" || transport.upstreamAdmission !== "NOT_COLLECTED"
    || !isDeepStrictEqual(expected.target, transport.target) || !Number.isSafeInteger(transport.startedAt) || !Number.isSafeInteger(transport.completedAt)
    || transport.startedAt < startedAt || transport.completedAt > completedAt || transport.completedAt < transport.startedAt
    || transport.completedAt - transport.startedAt > 60000) fail("NGINX_CORRELATION_TRANSPORT_INVALID");
  if (!Array.isArray(transport.probes) || !isDeepStrictEqual(transport.probes.map(row => row?.id), PARTNER_INGRESS_REQUIRED_PROBES)) fail("NGINX_CORRELATION_MATRIX_INVALID");
  const logs = parseLogs(logBytes), seen = new Set(), ids = new Set(), requestIds = new Set(), withoutHttpLog = [];
  for (const row of logs) {
    if (ids.has(row.probeId) || requestIds.has(row.requestId)) fail("NGINX_CORRELATION_DUPLICATE_LOG");
    ids.add(row.probeId); requestIds.add(row.requestId);
    if (row.generation !== expected.generationMarker || row.worker !== String(before.workers[0].pid)) fail("NGINX_CORRELATION_GENERATION_NOT_APPLIED");
    if (row.source !== expected.target.sourceBindAddress) fail("NGINX_CORRELATION_SOURCE_MISMATCH");
  }
  let admitted = 0, previousEnd = transport.startedAt;
  const emptyResponse = probe => probe.httpStatus === null && probe.complete === false && probe.bodyBytes === 0
    && probe.bodySha256 === null && probe.cacheControl === null && probe.corsHeaderPresent === false;
  const emptyTls = probe => probe.tlsAuthorized === false && ["tlsProtocol", "alpnProtocol", "serverLeafSha256", "serverSpkiSha256",
    "actualClientLeafSha256", "sourceAddress", "peerAddress", "peerPort"].every(key => probe[key] === null);
  const observedTls = probe => probe.tlsAuthorized === true && ["TLSv1.2", "TLSv1.3"].includes(probe.tlsProtocol)
    && [null, "http/1.1"].includes(probe.alpnProtocol) && probe.serverSpkiSha256 === expected.serverSpkiSha256 && hashed(probe.serverLeafSha256)
    && probe.actualClientLeafSha256 === (probe.id === "noClientCertificate" ? null : probe.id === "wrongClientCertificate" ? expected.wrongClientLeafSha256 : expected.clientLeafSha256)
    && probe.sourceAddress === expected.target.sourceBindAddress && probe.peerAddress === expected.target.address && probe.peerPort === expected.target.port;
  for (const probe of transport.probes) {
    exact(probe, PROBE_KEYS, "NGINX_CORRELATION_PROBE_INVALID");
    const probeId = hash(`PADLHUB-NGINX-PROBE-V1\n${transport.challenge}\n${probe.id}`);
    if (probe.probeId !== probeId || !Number.isSafeInteger(probe.startedAt) || !Number.isSafeInteger(probe.completedAt)
      || probe.startedAt < previousEnd || probe.completedAt < probe.startedAt || probe.completedAt > transport.completedAt
      || probe.completedAt - probe.startedAt > 5000) fail("NGINX_CORRELATION_PROBE_INVALID");
    previousEnd = probe.completedAt;
    const row = logs.find(row => row.probeId === probeId);
    if (probe.id === "directSidecar") {
      if (probe.outcome !== "CONNECTION_REFUSED" || probe.errorCode !== "ECONNREFUSED" || !emptyResponse(probe) || !emptyTls(probe) || row) fail("NGINX_CORRELATION_DIRECT_SIDECAR_UNPROVEN");
      withoutHttpLog.push(probe.id); continue;
    }
    if (["wrongSni", "noClientCertificate", "wrongClientCertificate"].includes(probe.id) && probe.outcome === "TLS_ALERT") {
      if (typeof probe.errorCode !== "string" || !/^ERR_SSL_(?:TLSV1_UNRECOGNIZED_NAME|SSLV3_ALERT_HANDSHAKE_FAILURE|TLSV13_ALERT_CERTIFICATE_REQUIRED|SSLV3_ALERT_BAD_CERTIFICATE|TLSV1_ALERT_UNKNOWN_CA|TLSV1_ALERT_ACCESS_DENIED|SSLV3_ALERT_CERTIFICATE_UNKNOWN)$/.test(probe.errorCode)
        || !emptyResponse(probe) || !(emptyTls(probe) || observedTls(probe)) || row) fail("NGINX_CORRELATION_TLS_OBSERVATION_INVALID");
      withoutHttpLog.push(probe.id); continue;
    }
    const statuses = { positiveDefaultOff: [503], cors: [503], wrongHost: [400, 421], sharedHost: [404],
      editorAdmin: [404], options: [400, 404, 405], query: [400, 404], noClientCertificate: [400, 403], wrongClientCertificate: [400, 403] };
    if (probe.outcome !== "HTTP_RESPONSE" || probe.errorCode !== null || probe.complete !== true || !observedTls(probe)
      || !statuses[probe.id]?.includes(probe.httpStatus)
      || probe.corsHeaderPresent !== false || !Number.isSafeInteger(probe.bodyBytes) || probe.bodyBytes < 0 || probe.bodyBytes > 16384 || !hashed(probe.bodySha256)) fail("NGINX_CORRELATION_HTTP_CONTROL_FAILED");
    if (!row || row.status !== String(probe.httpStatus)) fail("NGINX_CORRELATION_LOG_MATCH_MISSING");
    seen.add(probeId);
    if (["positiveDefaultOff", "cors"].includes(probe.id)) {
      if (probe.cacheControl !== "no-store" || row.admitted !== "1" || row.clientVerified !== "1" || row.upstream !== "503") fail("NGINX_CORRELATION_ADMISSION_UNPROVEN");
      admitted++;
    } else {
      if (!["", "-"].includes(row.upstream)) fail("NGINX_CORRELATION_UNEXPECTED_UPSTREAM");
      if (["noClientCertificate", "wrongClientCertificate"].includes(probe.id) && row.admitted !== "0"
        || probe.id === "noClientCertificate" && row.clientVerified !== "0") fail("NGINX_CORRELATION_MTLS_ADMISSION_UNPROVEN");
    }
  }
  if (seen.size !== logs.length || admitted !== 2) fail("NGINX_CORRELATION_UNRELATED_TRAFFIC");
  return Object.freeze({ state: "LOCAL_NGINX_GENERATION_HTTP_CORRELATED_NOT_LIVE_PROOF", generationMarker: expected.generationMarker,
    configSha256: expected.configSha256, snapshotSha256: hash(canonicalJson(after)), transportSha256: hash(canonicalJson(transport)),
    logSha256: hash(logBytes), correlatedHttpProbes: seen.size, admittedHttpProbes: admitted, withoutHttpLog,
    productionVerified: false, deployAuthorized: false, activationAuthorized: false,
    provenance: "UNATTESTED_LOCAL_INPUTS", controlledApplication: "NOT_PROVEN", externalVantage: "NOT_PROVEN" });
}

// Host-side wiring for the existing nonroot Linux/x64 fixture only. It reads its
// own fixed /control and /proc inputs; no injectable collector/commands or reload.
// The external transport value is untrusted: result never gains live provenance.
export function createLocalNginxGenerationSession(options) {
  exact(options, ["baseline", "expected", "logPath"], "NGINX_CORRELATION_INPUT_INVALID");
  const baseline = structuredClone(options.baseline), expected = structuredClone(options.expected);
  binding(expected); validateSnapshot(baseline);
  const start = performance.now(), startedAt = Date.now();
  const log = openPartnerNginxLogWindow({ absolutePath: options.logPath, expectedOwnerUid: process.getuid() });
  let closed = false, before;
  const close = () => { closed = true; log.close(); };
  try { before = collectLocalNginxLinuxSnapshot(); generation(baseline, before, before, expected); }
  catch (error) { close(); hostFailure(error); }
  return Object.freeze({
    finish(transport) {
      if (closed) fail("NGINX_CORRELATION_SESSION_CLOSED");
      try {
        if (performance.now() - start >= 90000 || Date.now() < startedAt || Date.now() - startedAt >= 90000) fail("NGINX_CORRELATION_WINDOW_INVALID");
        const logBytes = log.capture(), after = collectLocalNginxLinuxSnapshot();
        const result = evaluateLocalNginxGenerationCorrelation({ baseline, before, after, expected, transport, logBytes, startedAt, completedAt: Date.now() });
        if (!isDeepStrictEqual(after, collectLocalNginxLinuxSnapshot())) fail("NGINX_GENERATION_RUNTIME_DRIFT");
        const logWindow = log.finish();
        return Object.freeze({ ...result, logWindow, provenance: "LOCAL_HOST_READS_TRANSPORT_UNATTESTED" });
      } catch (error) { hostFailure(error); }
      finally { close(); }
    },
    close,
  });
}
