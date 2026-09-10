// Controlled application verifier candidate. All exported results are LOCAL ONLY.
// A pure reducer cannot authenticate a caller's observation; the owned collector
// must execute the probes. This is never an alternative production entry point.
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { performance } from "node:perf_hooks";
import { generatePartnerNginx124Candidate } from "./partner_game_membership_nginx_candidate.mjs";
import { buildLocalNginxCorrelationLogPolicy } from "./partner_game_membership_nginx_generation.mjs";

const fail = code => { throw new Error(code); };
const requireThat = (condition, code) => { if (!condition) fail(code); };
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const HASH = /^[a-f0-9]{64}$/;
const exact = (value, keys, code) => requireThat(value && Object.getPrototypeOf(value) === Object.prototype
  && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort()), code);
const privateIp = value => typeof value === "string" && /^(?:172\.(?:1[6-9]|2[0-9]|3[01])|192\.168)\.(?:0|[1-9][0-9]{0,2})\.(?:[1-9][0-9]{0,2})$/.test(value)
  && value.split(".").every(part => Number(part) <= 255) && Number(value.split(".")[3]) < 255;
const phases = ["baseline", "applied", "revoked"];

// Only the two private default Docker pool forms observed on this local host.
// Docker allocates the owned internal network; we neither select/alter host pools
// nor accept a caller CIDR. Derive two exact hosts inside that actual allocation.
export function deriveLocalNginxApplicationAddresses(subnet) {
  requireThat(typeof subnet === "string", "NGINX_APPLICATION_DOCKER_SUBNET_UNSUPPORTED");
  const pool172 = /^172\.(?:1[6-9]|2[0-9]|3[01])\.0\.0\/16$/.test(subnet);
  const pool192 = /^192\.168\.(?:0|[1-9][0-9]{0,2})\.0\/20$/.test(subnet)
    && Number(subnet.split(".")[2]) <= 240 && Number(subnet.split(".")[2]) % 16 === 0;
  requireThat(pool172 || pool192, "NGINX_APPLICATION_DOCKER_SUBNET_UNSUPPORTED");
  const prefix = subnet.split(".").slice(0, 3).join(".");
  return { peerAddress: `${prefix}.2`, probeAddress: `${prefix}.3` };
}

function configFor(binding, probeAddress, challenge, phase) {
  const candidate = generatePartnerNginx124Candidate(binding);
  requireThat(candidate.clientIdentities.length === 3 && privateIp(probeAddress), "NGINX_APPLICATION_FIXTURE_INVALID");
  const marker = hash(`PADLHUB-NGINX-APPLICATION-V1\n${challenge}\n${phase}`);
  let config = candidate.configuration;
  // Exact source-owned substitutions only. The old candidate remains byte-for-byte
  // unchanged; this fixture has a separate network/log/application acceptance target.
  const replace = (before, after, count = 1) => {
    requireThat(config.split(before).length - 1 === count, "NGINX_APPLICATION_TEMPLATE_DRIFT");
    config = config.split(before).join(after);
  };
  replace("pid /tmp/nginx.pid;", "pid /control/nginx.pid;");
  replace('log_format partner escape=json \'{"requestId":', `log_format partner escape=json '{"generation":"${marker}","worker":"$pid","requestId":`);
  replace("  access_log /out/nginx-access.jsonl partner;", `  access_log /out/nginx-access.jsonl partner;\n  ${buildLocalNginxCorrelationLogPolicy(marker)}  access_log /out/correlation/access.jsonl partner_correlation;`);
  replace("listen 127.0.0.1:8443", "listen 0.0.0.0:8443", 3);
  replace("      allow 127.0.0.1;\n      allow 127.0.0.3; # Second fixed source in the isolated source-limit fixture only.", `      allow ${probeAddress};`);
  if (phase === "revoked") {
    const entry = `"~^${encodeURIComponent(binding.clientCertificateBytes.toString())}$" fixture-client;`;
    replace(entry, "");
    replace('"SUCCESS:fixture-client" 1;', "");
  }
  return { phase, marker, configSha256: hash(config), configuration: config,
    clientLeafDerSha256: { client: hash(new crypto.X509Certificate(binding.clientCertificateBytes).raw),
      "client-2": hash(new crypto.X509Certificate(binding.sourceLimitClients[0].clientCertificateBytes).raw) },
    certificateHashes: candidate.certificateHashes, sourceCandidateSha256: candidate.configSha256 };
}

function validateSnapshot(value, expectedConfig) {
  exact(value, ["scope", "configSha256", "master", "workers", "bootSha256", "pidNamespaceSha256", "networkNamespaceSha256"], "NGINX_APPLICATION_SNAPSHOT_INVALID");
  requireThat(value.scope === "LOCAL_FIXTURE" && value.configSha256 === expectedConfig, "NGINX_APPLICATION_CONFIG_MISMATCH");
  for (const key of ["bootSha256", "pidNamespaceSha256", "networkNamespaceSha256"]) requireThat(HASH.test(value[key]), "NGINX_APPLICATION_SNAPSHOT_INVALID");
  const processIdentity = item => {
    exact(item, ["pid", "parentPid", "startTicks", "executableSha256", "draining"], "NGINX_APPLICATION_PROCESS_INVALID");
    requireThat(Number.isSafeInteger(item.pid) && item.pid > 0 && Number.isSafeInteger(item.parentPid) && item.parentPid >= 0
      && typeof item.startTicks === "string" && /^[1-9][0-9]{0,19}$/.test(item.startTicks)
      && HASH.test(item.executableSha256) && item.draining === false, "NGINX_APPLICATION_PROCESS_INVALID");
  };
  processIdentity(value.master);
  requireThat(Array.isArray(value.workers) && value.workers.length === 1 && Object.keys(value.workers).join() === "0", "NGINX_APPLICATION_WORKER_SET_INVALID");
  const worker = value.workers[0]; processIdentity(worker);
  requireThat(worker.pid !== value.master.pid && worker.parentPid === value.master.pid
    && worker.executableSha256 === value.master.executableSha256
    && BigInt(worker.startTicks) >= BigInt(value.master.startTicks), "NGINX_APPLICATION_PROCESS_INVALID");
}

export function verifyLocalNginxApplicationPhase({ expected, observed, previous, peerAddress, probeAddress }) {
  requireThat(privateIp(peerAddress) && privateIp(probeAddress) && peerAddress !== probeAddress, "NGINX_APPLICATION_VANTAGE_INVALID");
  exact(observed, ["phase", "before", "after", "probes", "logs", "upstreamBefore", "upstreamAfter"], "NGINX_APPLICATION_OBSERVATION_INVALID");
  requireThat(phases.includes(expected.phase) && observed.phase === expected.phase && HASH.test(expected.marker), "NGINX_APPLICATION_PHASE_MISMATCH");
  validateSnapshot(observed.before, expected.configSha256); validateSnapshot(observed.after, expected.configSha256);
  requireThat(isDeepStrictEqual(observed.before, observed.after), "NGINX_APPLICATION_RUNTIME_DRIFT");
  if (previous) {
    for (const key of ["master", "bootSha256", "pidNamespaceSha256", "networkNamespaceSha256"]) {
      requireThat(isDeepStrictEqual(previous[key], observed.before[key]), "NGINX_APPLICATION_EPOCH_CHANGED");
    }
    requireThat(previous.workers[0].pid !== observed.before.workers[0].pid
      && BigInt(previous.workers[0].startTicks) < BigInt(observed.before.workers[0].startTicks), "NGINX_APPLICATION_NEW_WORKER_REQUIRED");
  }
  requireThat(Array.isArray(observed.probes) && observed.probes.length === 3
    && isDeepStrictEqual(observed.probes.map(row => row.name), ["client", "client-2", "direct-sidecar"])
    && Array.isArray(observed.logs) && observed.logs.length === 2, "NGINX_APPLICATION_MATRIX_INCOMPLETE");
  let admitted = 0;
  for (const [index, probe] of observed.probes.entries()) {
    exact(probe, ["name", "outcome", "status", "tlsAuthorized", "noStore", "cors", "complete", "sourceAddress", "peerAddress", "port", "networkNamespaceSha256", "clientLeafDerSha256"], "NGINX_APPLICATION_PROBE_INVALID");
    requireThat(probe.sourceAddress === (index === 2 ? null : probeAddress) && probe.peerAddress === peerAddress
      && HASH.test(probe.networkNamespaceSha256)
      && probe.networkNamespaceSha256 !== observed.before.networkNamespaceSha256
      && probe.networkNamespaceSha256 === observed.probes[0].networkNamespaceSha256, "NGINX_APPLICATION_VANTAGE_INVALID");
    if (index === 2) {
      requireThat(probe.port === 18894 && probe.outcome === "CONNECTION_REFUSED" && probe.status === null
        && probe.tlsAuthorized === false && probe.complete === false && probe.noStore === false && probe.cors === false
        && probe.clientLeafDerSha256 === null, "NGINX_APPLICATION_DIRECT_SIDECAR_NOT_REFUSED");
      continue;
    }
    const denied = expected.phase === "revoked" && index === 0;
    requireThat(HASH.test(probe.clientLeafDerSha256) && probe.clientLeafDerSha256 === expected.clientLeafDerSha256[probe.name], "NGINX_APPLICATION_CLIENT_LEAF_MISMATCH");
    requireThat(probe.port === 8443 && probe.outcome === "HTTP_RESPONSE" && probe.tlsAuthorized === true
      && probe.complete === true && probe.noStore === true && probe.cors === false
      && probe.status === (denied ? 403 : 503), "NGINX_APPLICATION_INGRESS_PROBE_FAILED");
    const log = observed.logs[index];
    exact(log, ["generation", "worker", "requestId", "status", "upstream", "clientVerified", "rate", "concurrency"], "NGINX_APPLICATION_LOG_INVALID");
    requireThat(log.generation === expected.marker && log.worker === String(observed.before.workers[0].pid)
      && /^[a-f0-9]{32}$/.test(log.requestId), "NGINX_APPLICATION_GENERATION_NOT_APPLIED");
    requireThat(log.status === String(probe.status) && log.upstream === (denied ? "" : "503")
      && log.clientVerified === "1" && log.rate === (denied ? "" : "PASSED")
      && log.concurrency === (denied ? "" : "PASSED"), "NGINX_APPLICATION_ADMISSION_NOT_PROVEN");
    if (!denied) admitted++;
  }
  requireThat(new Set(observed.logs.map(row => row.requestId)).size === 2, "NGINX_APPLICATION_LOG_INVALID");
  requireThat(Number.isSafeInteger(observed.upstreamBefore) && observed.upstreamBefore >= 0
    && observed.upstreamAfter === observed.upstreamBefore + admitted, "NGINX_APPLICATION_UPSTREAM_MISMATCH");
  return { state: "LOCAL_NGINX_APPLICATION_PHASE_VERIFIED", phase: expected.phase, admitted,
    configSha256: expected.configSha256, marker: expected.marker, snapshot: structuredClone(observed.after) };
}

export function createLocalNginxApplicationSession(options) {
  exact(options, ["binding", "peerAddress", "probeAddress"], "NGINX_APPLICATION_FIXTURE_INVALID");
  const { binding, peerAddress, probeAddress } = options;
  requireThat(privateIp(peerAddress) && privateIp(probeAddress) && peerAddress !== probeAddress, "NGINX_APPLICATION_VANTAGE_INVALID");
  const challenge = crypto.randomBytes(32).toString("hex"), started = performance.now(), startedAt = Date.now();
  const configurations = phases.map(phase => configFor(binding, probeAddress, challenge, phase));
  let next = 0, closed = false, unapplied = null; const records = [];
  const checkLive = () => {
    if (closed) fail("NGINX_APPLICATION_SESSION_CLOSED");
    if (performance.now() - started > 120000 || Date.now() < startedAt || Date.now() - startedAt > 120000) {
      closed = true; fail("NGINX_APPLICATION_SESSION_EXPIRED");
    }
  };
  return Object.freeze({
    challenge,
    configuration(phase) { checkLive(); requireThat(phases.includes(phase), "NGINX_APPLICATION_PHASE_MISMATCH"); return structuredClone(configurations[phases.indexOf(phase)]); },
    recordUnapplied(observed) {
      checkLive();
      try {
        requireThat(next === 1 && !unapplied, "NGINX_APPLICATION_PHASE_ORDER");
        // Files B are on disk but the real requests must still expose marker A
        // and worker A. This is a mandatory physical negative, not application PASS.
        const expected = { ...configurations[1], marker: configurations[0].marker };
        verifyLocalNginxApplicationPhase({ expected, observed, previous: null, peerAddress, probeAddress });
        for (const key of ["master", "workers", "bootSha256", "pidNamespaceSha256", "networkNamespaceSha256"]) {
          requireThat(isDeepStrictEqual(observed.before[key], records[0].result.snapshot[key]), "NGINX_APPLICATION_UNAPPLIED_EPOCH_CHANGED");
        }
        requireThat(observed.upstreamBefore === records[0].observed.upstreamAfter, "NGINX_APPLICATION_HIDDEN_TRAFFIC");
        unapplied = structuredClone(observed);
        return { state: "LOCAL_DISK_CHANGE_WITHOUT_APPLICATION_CONFIRMED" };
      } catch (error) { closed = true; throw error; }
    },
    record(observed) {
      checkLive();
      try {
        requireThat(next < 3 && observed.phase === phases[next], "NGINX_APPLICATION_PHASE_ORDER");
        const result = verifyLocalNginxApplicationPhase({ expected: configurations[next], observed,
          previous: records.at(-1)?.result.snapshot, peerAddress, probeAddress });
        if (next === 1) requireThat(unapplied !== null, "NGINX_APPLICATION_UNAPPLIED_PROOF_REQUIRED");
        if (next) requireThat(observed.upstreamBefore === (next === 1 ? unapplied.upstreamAfter : records.at(-1).observed.upstreamAfter), "NGINX_APPLICATION_HIDDEN_TRAFFIC");
        records.push({ result, observed: structuredClone(observed) }); next++;
        return structuredClone(result);
      } catch (error) { closed = true; throw error; }
    },
    finish() {
      checkLive(); closed = true;
      requireThat(next === 3, "NGINX_APPLICATION_MATRIX_INCOMPLETE");
      return Object.freeze({ state: "LOCAL_CONTROLLED_APPLICATION_VERIFIED_NOT_LIVE_PROOF", challenge,
        startedAt, completedAt: Date.now(), records: structuredClone(records), unapplied: structuredClone(unapplied),
        productionVerified: false, deployAuthorized: false, activationAuthorized: false,
        revocation: "LEAF_BINDING_REMOVAL_NOT_CA_CRL_OR_OCSP", externalVantage: "OWNED_INTERNAL_DOCKER_NETWORK_ONLY" });
    },
  });
}
