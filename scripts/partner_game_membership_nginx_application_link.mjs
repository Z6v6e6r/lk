// LOCAL fixture pipe/correlation glue, never a production operator or attestation.
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { performance } from "node:perf_hooks";
import { canonicalJson } from "../node-red/custom-nodes/partner-game-membership-api/partner-game-membership-core.mjs";
import { parseCanonicalIngressJson } from "./partner_game_membership_ingress_evidence.mjs";

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = () => { throw new Error("NGINX_APPLICATION_LINK_INVALID"); };
const exact = (value, keys) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || !isDeepStrictEqual(Object.keys(value).sort(), keys.toSorted())) fail();
};

// The caller owns this already-started fixture child and its cleanup. No command,
// target, path, environment or timeout override is accepted here. A failed pipe
// closes stdin; unconfirmed exit is a failure, never a successful cancellation.
export function exchangeLocalNginxGeneration(child, initial, collect, signal = null) {
  const initialBytes = Buffer.from(canonicalJson(initial) + "\n"), initialSha256 = hash(initialBytes.subarray(0, -1));
  const started = performance.now(), startedAt = Date.now();
  const inTime = () => performance.now() - started < 90000 && Date.now() >= startedAt && Date.now() - startedAt < 90000;
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0), total = 0, count = 0, result, peer, failure, settled = false, stdoutEnded = false, abortTimer;
    const abort = () => {
      if (settled) return;
      failure = new Error("NGINX_APPLICATION_CHANNEL_FAILED");
      try { child.stdin.end(); } catch { /* Outer owned-container cleanup remains mandatory. */ }
      if (!abortTimer) abortTimer = setTimeout(() => {
        if (settled) return;
        settled = true; clearTimeout(deadline); signal?.removeEventListener("abort", abort);
        try { child.kill(); } catch { /* Not a confirmed remote process exit. */ }
        reject(new Error("NGINX_APPLICATION_CHANNEL_EXIT_UNCONFIRMED"));
      }, 5000);
    };
    const deadline = setTimeout(abort, 90000);
    child.stdin.on("error", abort); child.on("error", abort);
    child.stderr.on("data", abort); child.stdout.on("error", abort);
    child.stdout.on("end", () => { stdoutEnded = true; });
    child.stdout.on("data", chunk => {
      if (failure || settled) return;
      try {
        if (!inTime() || signal?.aborted) fail();
        total += chunk.length; if (total > 8192) fail();
        buffer = Buffer.concat([buffer, chunk]);
        let end;
        while ((end = buffer.indexOf(10)) !== -1) {
          const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
          const message = parseCanonicalIngressJson(line, 8192); count++;
          if (count === 1) {
            exact(message, ["state", "initialSha256"]);
            if (message.state !== "READY_LOCAL_LOG_WINDOW" || message.initialSha256 !== initialSha256) fail();
            Promise.resolve().then(() => { if (failure || settled || !inTime() || signal?.aborted) fail(); return collect(); }).then(value => {
              if (failure || settled) return;
              if (!inTime() || signal?.aborted) fail();
              exact(value, ["transport", "networkNamespaceSha256"]); peer = value;
              const bytes = Buffer.from(canonicalJson(value.transport) + "\n"); if (bytes.length > 65536) fail();
              child.stdin.end(bytes);
            }).catch(abort);
          } else if (count === 2) {
            exact(message, ["state", "result"]);
            if (!peer || message.state !== "RESULT_LOCAL_LOG_WINDOW") fail(); result = message.result;
          } else fail();
        }
      } catch { abort(); }
    });
    child.on("close", (code, exitSignal) => {
      if (settled) return;
      settled = true; clearTimeout(deadline); clearTimeout(abortTimer);
      signal?.removeEventListener("abort", abort);
      if (failure || !inTime() || signal?.aborted || code !== 0 || exitSignal !== null || !stdoutEnded || count !== 2 || buffer.length || !result || !peer) reject(new Error("NGINX_APPLICATION_CHANNEL_FAILED"));
      else resolve({ correlation: result, peer });
    });
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (!inTime() || signal?.aborted) fail();
      exact(initial, ["baseline", "expected"]);
      if (initialBytes.length > 16384) fail();
      child.stdin.write(initialBytes);
    } catch { abort(); }
  });
}

// Shorten the new async branch to the existing runner's remaining 180s budget.
// Cancellation is not proof that a remote exec process exited; owner cleanup is mandatory.
export function createLocalNginxApplicationBudget({ startedAt, startedMonotonic }) {
  const controller = new AbortController(); let timer;
  const remaining = () => Math.min(180000 - (Date.now() - startedAt), 180000 - (performance.now() - startedMonotonic));
  const check = () => {
    if (!Number.isSafeInteger(startedAt) || !Number.isFinite(startedMonotonic) || Date.now() < startedAt
      || performance.now() < startedMonotonic || remaining() <= 0 || controller.signal.aborted) {
      controller.abort(); throw new Error("NGINX_APPLICATION_OUTER_DEADLINE");
    }
  };
  check(); timer = setTimeout(() => controller.abort(), Math.floor(remaining()));
  return Object.freeze({ signal: controller.signal, check, close() { clearTimeout(timer); } });
}

export function linkLocalNginxApplicationCorrelation(input) {
  exact(input, ["application", "correlation", "peer", "expected", "upstreamBefore", "upstreamAfter"]);
  const { application, correlation, peer, expected, upstreamBefore, upstreamAfter } = input;
  exact(peer, ["transport", "networkNamespaceSha256"]);
  exact(correlation, ["state", "generationMarker", "configSha256", "snapshotSha256", "transportSha256", "logSha256", "correlatedHttpProbes", "admittedHttpProbes", "withoutHttpLog",
    "productionVerified", "deployAuthorized", "activationAuthorized", "provenance", "controlledApplication", "externalVantage", "logWindow"]);
  const last = application.records?.[2], transport = peer.transport;
  if (application.state !== "LOCAL_CONTROLLED_APPLICATION_VERIFIED_NOT_LIVE_PROOF" || application.records.length !== 3
    || application.records.map(row => row.result.phase).join() !== "baseline,applied,revoked"
    || !application.unapplied || !last || last.result.phase !== "revoked"
    || correlation.state !== "LOCAL_NGINX_GENERATION_HTTP_CORRELATED_NOT_LIVE_PROOF"
    || correlation.provenance !== "LOCAL_HOST_READS_TRANSPORT_UNATTESTED"
    || correlation.controlledApplication !== "NOT_PROVEN" || correlation.externalVantage !== "NOT_PROVEN"
    || correlation.configSha256 !== expected.configSha256 || correlation.generationMarker !== expected.generationMarker
    || correlation.configSha256 !== last.result.configSha256 || correlation.generationMarker !== last.result.marker
    || correlation.snapshotSha256 !== hash(canonicalJson(last.result.snapshot))
    || correlation.transportSha256 !== hash(canonicalJson(transport))
    || !isDeepStrictEqual(transport.target, expected.target)
    || expected.clientLeafSha256 !== last.observed.probes[1].clientLeafDerSha256
    || expected.wrongClientLeafSha256 !== last.observed.probes[0].clientLeafDerSha256
    || peer.networkNamespaceSha256 !== last.observed.probes[1].networkNamespaceSha256
    || peer.networkNamespaceSha256 === last.result.snapshot.networkNamespaceSha256
    || transport.startedAt < application.completedAt || transport.completedAt < transport.startedAt
    || transport.completedAt - application.startedAt > 180000
    || !Number.isSafeInteger(upstreamBefore) || upstreamBefore !== last.observed.upstreamAfter
    || upstreamAfter !== upstreamBefore + 2 || correlation.admittedHttpProbes !== 2
    || correlation.correlatedHttpProbes !== transport.probes.filter(row => row.outcome === "HTTP_RESPONSE").length
    || !isDeepStrictEqual(correlation.withoutHttpLog, transport.probes.filter(row => row.outcome !== "HTTP_RESPONSE").map(row => row.id))) fail();
  for (const value of [application, correlation, transport]) {
    if (["productionVerified", "deployAuthorized", "activationAuthorized"].some(key => value[key] !== false)) fail();
  }
  const log = correlation.logWindow;
  exact(log, ["state", "prefixBytes", "prefixSha256", "suffixBytes", "suffixSha256", "productionVerified"]);
  if (log.state !== "PREFIX_PRESERVED_SUFFIX_OBSERVED_NOT_APPEND_ONLY_PROOF" || log.productionVerified !== false
    || !Number.isSafeInteger(log.prefixBytes) || log.prefixBytes < 0 || log.prefixBytes > 1048576
    || !/^[a-f0-9]{64}$/.test(log.prefixSha256) || !Number.isSafeInteger(log.suffixBytes) || log.suffixBytes < 1 || log.suffixBytes > 65536
    || !/^[a-f0-9]{64}$/.test(log.suffixSha256) || log.suffixSha256 !== correlation.logSha256) fail();
  return Object.freeze({ state: "LOCAL_APPLICATION_TRANSPORT_LOG_LINKED_NOT_LIVE_PROOF",
    applicationSha256: hash(canonicalJson(application)), correlationSha256: hash(canonicalJson(correlation)),
    transportSha256: correlation.transportSha256, configSha256: correlation.configSha256,
    generationMarker: correlation.generationMarker, upstreamBefore, upstreamAfter,
    provenance: "UNATTESTED_UNTIL_OWNED_RUNNER_EXECUTION", externalVantage: "OWNED_INTERNAL_DOCKER_NETWORK_ONLY",
    productionVerified: false, deployAuthorized: false, activationAuthorized: false });
}
