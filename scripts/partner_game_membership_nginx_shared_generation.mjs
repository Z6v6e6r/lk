// Shared-layout LOCAL consistency + fixture host wiring. Not a production issuer.
import crypto from "node:crypto";
import net from "node:net";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { canonicalJson } from "../node-red/custom-nodes/partner-game-membership-api/partner-game-membership-core.mjs";
import { parseCanonicalIngressJson, PARTNER_INGRESS_REQUIRED_PROBES, PartnerIngressEvidenceError } from "./partner_game_membership_ingress_evidence.mjs";
import { PARTNER_SHARED_COVERAGE_PROBES } from "./partner_game_membership_nginx_probes.mjs";
import { readLocalNginxSharedAdapterBinding } from "./partner_game_membership_nginx_shared_overlay.mjs";
import { collectLocalNginxLinuxSnapshot } from "./partner_game_membership_nginx_linux.mjs";
import { openPartnerNginxLogWindow } from "./partner_game_membership_nginx_log_window.mjs";

const fail = code => { throw new PartnerIngressEvidenceError(`NGINX_SHARED_GENERATION_${code}`); };
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const requestId = value => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const exact = (value, keys) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some(key => typeof key !== "string")
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !Object.hasOwn(d, "value"))
    || !isDeepStrictEqual(Reflect.ownKeys(value).sort(), [...keys].sort())) fail("SCHEMA_INVALID");
};
const bytes = (value, max) => {
  if (!Buffer.isBuffer(value) || Object.getPrototypeOf(value) !== Buffer.prototype
    || Reflect.ownKeys(value).some(key => typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key))
    || !value.length || value.length > max) fail("BYTES_INVALID");
  return Buffer.from(value);
};
const parse = (value, max) => { try { return parseCanonicalIngressJson(bytes(value, max), max); } catch { fail("JSON_INVALID"); } };
const epochKeys = ["master", "bootSha256", "pidNamespaceSha256", "networkNamespaceSha256"];
const probeKeys = ["id", "probeId", "outcome", "errorCode", "httpStatus", "complete", "tlsAuthorized", "tlsProtocol", "alpnProtocol",
  "serverLeafSha256", "serverSpkiSha256", "actualClientLeafSha256", "sourceAddress", "peerAddress", "peerPort", "cacheControl",
  "corsHeaderPresent", "bodyBytes", "bodySha256", "startedAt", "completedAt", "ingressRequestId"];
const positiveIds = new Set(["positiveDefaultOff", "cors", ...PARTNER_SHARED_COVERAGE_PROBES]);

function snapshot(value) {
  exact(value, ["scope", "configSha256", ...epochKeys, "workers"]);
  if (value.scope !== "LOCAL_FIXTURE" || ["configSha256", ...epochKeys.slice(1)].some(key => !hash(value[key]))
    || !Array.isArray(value.workers) || value.workers.length !== 4) fail("SNAPSHOT_INVALID");
  const all = [value.master, ...value.workers];
  for (const process of all) {
    exact(process, ["pid", "parentPid", "startTicks", "executableSha256", "draining"]);
    if (!Number.isSafeInteger(process.pid) || process.pid < 1 || process.pid > 2147483647
      || !Number.isSafeInteger(process.parentPid) || process.parentPid < 0 || process.parentPid > 2147483647
      || typeof process.startTicks !== "string" || !/^[1-9][0-9]{0,19}$/.test(process.startTicks)
      || !hash(process.executableSha256) || process.draining !== false) fail("PROCESS_INVALID");
  }
  if (new Set(all.map(p => p.pid)).size !== 5 || all.some(p => p.pid === value.master.parentPid)
    || value.workers.some((p, i) => p.parentPid !== value.master.pid || p.executableSha256 !== value.master.executableSha256
      || BigInt(p.startTicks) < BigInt(value.master.startTicks) || i > 0 && p.pid <= value.workers[i - 1].pid)) fail("WORKERS_INVALID");
}
function snapshots(baseline, before, after) {
  for (const value of [baseline, before, after]) snapshot(value);
  if (!isDeepStrictEqual(before, after)) fail("RUNTIME_DRIFT");
  if (epochKeys.some(key => !isDeepStrictEqual(baseline[key], before[key]))) fail("EPOCH_CHANGED");
  // Root nginx.conf may be byte-identical: the new file is in an include. The
  // caller-supplied closure binding below is separate, never a fake root-file hash.
  const latest = baseline.workers.reduce((max, worker) => BigInt(worker.startTicks) > max ? BigInt(worker.startTicks) : max, 0n);
  if (before.workers.some(p => baseline.workers.some(old => old.pid === p.pid) || BigInt(p.startTicks) <= latest)) fail("NEW_WORKERS_REQUIRED");
}

function logs(raw) {
  const value = bytes(raw, 65536);
  if (value.at(-1) !== 10 || !Buffer.from(value.toString("utf8")).equals(value)) fail("LOG_INVALID");
  const lines = value.subarray(0, -1).toString("utf8").split("\n");
  if (lines.length > 27) fail("LOG_INVALID");
  const rows = lines.map(line => parse(Buffer.from(line), 2048));
  for (const row of rows) {
    exact(row, ["admitted", "client", "clientVerified", "concurrency", "generation", "rate", "requestId", "status", "upstream", "worker"]);
    // The audit row carries the client identity derived from the presented certificate, not
    // the client-supplied header, so per-client forensics survive a multi-client allowlist.
    if (typeof row.client !== "string" || (row.client !== "" && !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(row.client))
      || !["0", "1"].includes(row.admitted) || !["0", "1"].includes(row.clientVerified) || !hash(row.generation) || !requestId(row.requestId)
      || !["", "-", "503"].includes(row.upstream) || !/^[2-5][0-9]{2}$/.test(row.status)
      || !/^[1-9][0-9]{0,9}$/.test(row.worker)
      || !["", "-", "PASSED", "DELAYED", "REJECTED"].includes(row.rate)
      || !["", "-", "PASSED", "REJECTED"].includes(row.concurrency)) fail("LOG_INVALID");
  }
  if (new Set(rows.map(row => row.requestId)).size !== rows.length) fail("DUPLICATE_AUDIT_ID");
  return { rows, logSha256: sha(value) };
}

export function evaluateLocalNginxSharedGeneration(input) {
  exact(input, ["preparation", "observationBytes", "logBytes"]);
  const binding = readLocalNginxSharedAdapterBinding(input.preparation);
  const observationBytes = bytes(input.observationBytes, 262144), observation = parse(observationBytes, 262144);
  exact(observation, ["scope", "baseline", "before", "after", "closure", "transport", "startedAt", "completedAt"]);
  const { baseline, before, after, closure, transport, startedAt, completedAt } = observation;
  if (observation.scope !== "LOCAL_PREPARATION" || !Number.isSafeInteger(startedAt) || startedAt < 0
    || !Number.isSafeInteger(completedAt) || completedAt < startedAt || completedAt - startedAt > 90000) fail("WINDOW_INVALID");
  snapshots(baseline, before, after);
  exact(closure, ["baselineSha256", "candidateSha256"]);
  if (closure.baselineSha256 !== binding.baselineSha256 || closure.candidateSha256 !== binding.candidateSha256
    || closure.baselineSha256 === closure.candidateSha256) fail("CLOSURE_MISMATCH");
  exact(transport, ["state", "challenge", "startedAt", "completedAt", "target", "clientId", "probes", "productionVerified",
    "deployAuthorized", "activationAuthorized", "vantage", "applicationEvidence", "upstreamAdmission"]);
  if (transport.state !== "NGINX_SHARED_TRANSPORT_OBSERVATIONS_NOT_INGRESS_PROOF" || !hash(transport.challenge)
    || typeof transport.clientId !== "string"
    || !binding.clients.some(client => client.clientId === transport.clientId)
    || transport.productionVerified !== false || transport.deployAuthorized !== false || transport.activationAuthorized !== false
    || transport.vantage !== "UNATTESTED" || transport.applicationEvidence !== "NOT_COLLECTED" || transport.upstreamAdmission !== "NOT_COLLECTED"
    || !Number.isSafeInteger(transport.startedAt) || transport.startedAt < startedAt || !Number.isSafeInteger(transport.completedAt)
    || transport.completedAt > completedAt || transport.completedAt < transport.startedAt || transport.completedAt - transport.startedAt > 60000) fail("TRANSPORT_INVALID");
  exact(transport.target, ["address", "sourceBindAddress", "port", "sidecarPort", "exactHost", "sharedHost"]);
  const target = transport.target;
  if (target.exactHost !== binding.exactHost || typeof target.sharedHost !== "string" || target.sharedHost === target.exactHost
    || !/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(target.sharedHost) || !binding.sourceAddresses.includes(target.sourceBindAddress)
    || typeof target.address !== "string" || net.isIP(target.address) !== 4
    || ["port", "sidecarPort"].some(key => !Number.isSafeInteger(target[key]) || target[key] < 1 || target[key] > 65535)
    || target.port === target.sidecarPort) fail("TARGET_INVALID");
  if (!Array.isArray(transport.probes) || !isDeepStrictEqual(transport.probes.map(p => p?.id), [...PARTNER_INGRESS_REQUIRED_PROBES, ...PARTNER_SHARED_COVERAGE_PROBES])) fail("MATRIX_INVALID");
  const { rows, logSha256 } = logs(input.logBytes), ids = new Set(), joined = new Set(), covered = new Set(), uncorrelated = [];
  const currentPids = new Set(before.workers.map(p => String(p.pid)));
  for (const row of rows) if (row.generation !== binding.generationMarker || !currentPids.has(row.worker)) fail("GENERATION_NOT_APPLIED");
  let previousEnd = transport.startedAt, admitted = 0;
  for (const probe of transport.probes) {
    exact(probe, probeKeys);
    if (probe.probeId !== sha(`PADLHUB-NGINX-SHARED-PROBE-V1\n${transport.challenge}\n${probe.id}`)
      || !Number.isSafeInteger(probe.startedAt) || probe.startedAt < previousEnd || !Number.isSafeInteger(probe.completedAt)
      || probe.completedAt < probe.startedAt || probe.completedAt > transport.completedAt || probe.completedAt - probe.startedAt > 5000) fail("PROBE_INVALID");
    previousEnd = probe.completedAt;
    if (probe.ingressRequestId !== null && (!requestId(probe.ingressRequestId) || ids.has(probe.ingressRequestId))) fail("RESPONSE_ID_INVALID");
    if (probe.ingressRequestId) ids.add(probe.ingressRequestId);
    const row = rows.find(r => r.requestId === probe.ingressRequestId);
    const positive = positiveIds.has(probe.id);
    if (probe.outcome !== "HTTP_RESPONSE") {
      if (positive || row || probe.ingressRequestId !== null) fail("UNJOINED_POSITIVE");
      // TLS/default-vhost failures are observations, not proof of server denial.
      if (!["TLS_ALERT", "TRANSPORT_ERROR", "TLS_IDENTITY_MISMATCH", "CONNECTION_REFUSED", "HTTP_INCOMPLETE"].includes(probe.outcome)
        || probe.complete !== false || probe.httpStatus !== null || probe.bodyBytes !== 0 || probe.bodySha256 !== null) fail("OPAQUE_INVALID");
      uncorrelated.push(probe.id); continue;
    }
    if (probe.errorCode !== null || probe.complete !== true || probe.tlsAuthorized !== true || !["TLSv1.2", "TLSv1.3"].includes(probe.tlsProtocol)
      || ![null, "http/1.1"].includes(probe.alpnProtocol) || !hash(probe.serverLeafSha256)
      || probe.sourceAddress !== target.sourceBindAddress || probe.peerAddress !== target.address || probe.peerPort !== target.port
      || probe.corsHeaderPresent !== false || !Number.isSafeInteger(probe.bodyBytes) || probe.bodyBytes < 0 || probe.bodyBytes > 16384 || !hash(probe.bodySha256)) fail("HTTP_INVALID");
    if (!row) {
      if (positive || probe.ingressRequestId !== null || !["wrongSni", "sharedHost", "noClientCertificate", "wrongClientCertificate"].includes(probe.id)) fail("LOG_MATCH_MISSING");
      uncorrelated.push(probe.id); continue;
    }
    if (probe.serverSpkiSha256 !== binding.serverSpkiSha256 || row.status !== String(probe.httpStatus)) fail("LOG_IDENTITY_MISMATCH");
    joined.add(row.requestId);
    if (positive) {
      if (probe.httpStatus !== 503 || probe.cacheControl !== "no-store"
        || probe.actualClientLeafSha256 !== binding.clients.find(client => client.clientId === transport.clientId).clientLeafSha256
        || row.upstream !== "503" || row.admitted !== "1" || row.clientVerified !== "1" || row.client !== transport.clientId
        || !["PASSED", "DELAYED"].includes(row.rate) || row.concurrency !== "PASSED") fail("ADMISSION_UNPROVEN");
      covered.add(row.worker); admitted++;
    } else {
      const allowed = { wrongHost: [400, 421], wrongSni: [400, 403, 421], editorAdmin: [404], options: [400, 404, 405], query: [400, 404], noClientCertificate: [400, 403], wrongClientCertificate: [400, 403] };
      if (!allowed[probe.id]?.includes(probe.httpStatus) || !["", "-"].includes(row.upstream)
        || ["noClientCertificate", "wrongClientCertificate"].includes(probe.id) && (row.admitted !== "0" || row.client !== "")) fail("DENIAL_UNPROVEN");
    }
  }
  if (joined.size !== rows.length || admitted !== positiveIds.size) fail("UNRELATED_AUDIT_TRAFFIC");
  return Object.freeze({ state: covered.size === 4 ? "LOCAL_SHARED_FOUR_WORKERS_CORRELATED_NOT_LIVE_PROOF" : "LOCAL_SHARED_WORKER_COVERAGE_NOT_PROVEN",
    coveredWorkers: covered.size, requiredWorkers: 4, correlatedHttpProbes: joined.size, admittedHttpProbes: admitted,
    uncorrelatedProbes: Object.freeze(uncorrelated), observationSha256: sha(observationBytes), logSha256,
    baselineClosureSha256: binding.baselineSha256, candidateClosureSha256: binding.candidateSha256,
    snapshotSha256: sha(canonicalJson(after)), generationMarker: binding.generationMarker,
    productionVerified: false, deployAuthorized: false, activationAuthorized: false,
    provenance: "UNATTESTED_LOCAL_INPUTS", closureCustody: "NOT_CHECKED", controlledApplication: "NOT_PROVEN", externalVantage: "NOT_PROVEN" });
}

export function createLocalNginxSharedGenerationSession(input) {
  exact(input, ["preparation", "baselineBytes", "logPath"]);
  const preparation = input.preparation;
  const binding = readLocalNginxSharedAdapterBinding(preparation), baseline = parse(input.baselineBytes, 8192);
  snapshot(baseline);
  const start = performance.now(), startedAt = Date.now();
  const guard = () => {
    if (performance.now() - start >= 90000 || Date.now() < startedAt || Date.now() - startedAt >= 90000) fail("WINDOW_INVALID");
  };
  // Retain the existing nonroot Linux/x64 /control fixture guard; no production
  // paths, collector injection, reload or silent scope conversion.
  const before = collectLocalNginxLinuxSnapshot(); snapshots(baseline, before, before);
  const window = openPartnerNginxLogWindow({ absolutePath: input.logPath, expectedOwnerUid: process.getuid() });
  let closed = false;
  const close = () => { closed = true; window.close(); };
  return Object.freeze({ close, finish(transportBytes) {
    if (closed) fail("SESSION_CLOSED");
    try {
      guard();
      const logBytes = window.capture(), after = collectLocalNginxLinuxSnapshot(), transport = parse(transportBytes, 262144);
      const observationBytes = Buffer.from(canonicalJson({ scope: "LOCAL_PREPARATION", baseline, before, after,
        closure: { baselineSha256: binding.baselineSha256, candidateSha256: binding.candidateSha256 }, transport, startedAt, completedAt: Date.now() }));
      const result = evaluateLocalNginxSharedGeneration({ preparation, observationBytes, logBytes });
      if (!isDeepStrictEqual(after, collectLocalNginxLinuxSnapshot())) fail("RUNTIME_DRIFT");
      guard();
      const logWindow = window.finish();
      guard();
      return Object.freeze({ ...result, logWindow, provenance: "LOCAL_FIXTURE_READS_CLOSURE_AND_TRANSPORT_UNATTESTED" });
    } finally { close(); }
  } });
}
