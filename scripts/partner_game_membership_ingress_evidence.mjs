import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { canonicalJson } from "../node-red/custom-nodes/partner-game-membership-api/partner-game-membership-core.mjs";

const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const MAX_BYTES = 1024 * 1024;
const AUDIT_DOMAIN = "PADLHUB-PARTNER-INGRESS-REACHABILITY-V1\n";
const REQUIRED_CONTEXT = Object.freeze([
  "approvedCommit", "approvedTree", "packetManifestSha256", "controlsSha256",
  "runtimeManifestSha256", "auditReportSha256", "configClosureSha256",
  "effectiveConfigSha256", "clientCertificateSpkiSha256", "clientCaBundleSha256",
  "hostMachineIdSha256", "bootIdSha256", "serviceIdentitySha256", "executableSha256",
  "processStartIdentitySha256", "runtimeGenerationSha256", "exactHost", "audience",
]);
export const PARTNER_INGRESS_REQUIRED_PROBES = Object.freeze([
  "positiveDefaultOff", "wrongHost", "wrongSni", "sharedHost", "directSidecar",
  "editorAdmin", "options", "query", "cors", "noClientCertificate", "wrongClientCertificate",
]);

export class PartnerIngressEvidenceError extends Error {
  constructor(code) {
    super(code);
    this.name = "PartnerIngressEvidenceError";
    this.code = code;
  }
}
const fail = code => { throw new PartnerIngressEvidenceError(code); };
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const exact = (value, keys, code) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())) fail(code);
};

// Canonical bytes reject duplicate keys and ambiguous encodings without accepting
// one JSON parser's last-key-wins interpretation of a signed artifact.
export function parseCanonicalIngressJson(bytes, maxBytes = 65536) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES
    || !Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maxBytes) fail("INVALID_ARTIFACT_BYTES");
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
    if (!Buffer.from(canonicalJson(parsed), "utf8").equals(bytes)) fail("NON_CANONICAL_ARTIFACT");
  } catch (error) {
    if (error instanceof PartnerIngressEvidenceError) throw error;
    fail("NON_CANONICAL_ARTIFACT");
  }
  return parsed;
}

export function validateIngressContext(value) {
  exact(value, REQUIRED_CONTEXT, "INVALID_INGRESS_CONTEXT");
  for (const key of REQUIRED_CONTEXT) {
    if (["exactHost", "audience"].includes(key)) continue;
    if (typeof value[key] !== "string" || !(key === "approvedCommit" || key === "approvedTree" ? SHA : HASH).test(value[key])) {
      fail("INVALID_INGRESS_CONTEXT");
    }
  }
  if (typeof value.exactHost !== "string" || value.exactHost.length > 253
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value.exactHost)
    || typeof value.audience !== "string" || !/^[a-z0-9][a-z0-9._:-]{2,127}$/.test(value.audience)) {
    fail("INVALID_INGRESS_CONTEXT");
  }
  return true;
}

const canonicalTime = value => typeof value === "string" && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;

export function verifySignedPartnerReachability({
  envelopeBytes, reviewerPublicKeyBytes, approvedReviewerSpkiSha256, expectedContext, now,
}) {
  validateIngressContext(expectedContext);
  if (!Number.isSafeInteger(now) || !HASH.test(approvedReviewerSpkiSha256)) fail("MISSING_REVIEWER_TRUST_ANCHOR");
  if (!Buffer.isBuffer(reviewerPublicKeyBytes) || reviewerPublicKeyBytes.length > 8192
    || !reviewerPublicKeyBytes.toString("utf8").startsWith("-----BEGIN PUBLIC KEY-----")) {
    fail("INVALID_REVIEWER_PUBLIC_KEY");
  }
  let key;
  try { key = crypto.createPublicKey(reviewerPublicKeyBytes); } catch { fail("INVALID_REVIEWER_PUBLIC_KEY"); }
  if (key.asymmetricKeyType !== "ed25519"
    || digest(key.export({ type: "spki", format: "der" })) !== approvedReviewerSpkiSha256) {
    fail("UNTRUSTED_REVIEWER_KEY");
  }
  const envelope = parseCanonicalIngressJson(envelopeBytes);
  exact(envelope, ["payload", "signature"], "INVALID_REACHABILITY_ENVELOPE");
  exact(envelope.payload, ["formatVersion", "kind", "context", "issuedAt", "expiresAt", "decision", "reachableHighPackages"], "INVALID_REACHABILITY_PAYLOAD");
  const payload = envelope.payload;
  if (payload.formatVersion !== 1 || payload.kind !== "PARTNER_INGRESS_REACHABILITY"
    || payload.decision !== "NO_REACHABLE_HIGH_OR_CRITICAL"
    || !isDeepStrictEqual(payload.reachableHighPackages, [])) fail("UNSAFE_REACHABILITY_DECISION");
  validateIngressContext(payload.context);
  if (!isDeepStrictEqual(payload.context, expectedContext)) fail("REACHABILITY_CONTEXT_MISMATCH");
  if (!canonicalTime(payload.issuedAt) || !canonicalTime(payload.expiresAt)
    || Date.parse(payload.issuedAt) > now || Date.parse(payload.expiresAt) <= now
    || Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt) > 86400000
    || Date.parse(payload.expiresAt) <= Date.parse(payload.issuedAt)) fail("STALE_REACHABILITY_EVIDENCE");
  if (typeof envelope.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature)) fail("INVALID_REACHABILITY_SIGNATURE");
  const signature = Buffer.from(envelope.signature, "base64url");
  if (signature.toString("base64url") !== envelope.signature
    || !crypto.verify(null, Buffer.from(AUDIT_DOMAIN + canonicalJson(payload)), key, signature)) {
    fail("INVALID_REACHABILITY_SIGNATURE");
  }
  return { state: "SIGNED_REACHABILITY_VERIFIED_NOT_AUTHORIZED", envelopeSha256: digest(envelopeBytes) };
}

// A narrow artifact reader: never follows symlinks, never prints file contents,
// accepts only the caller's explicit approval pin, and checks identity after read.
export function readPinnedIngressArtifact({ absolutePath, expectedSha256, expectedOwnerUid = 0, maxBytes = MAX_BYTES }) {
  if (typeof absolutePath !== "string" || !path.isAbsolute(absolutePath)
    || path.normalize(absolutePath) !== absolutePath || !HASH.test(expectedSha256)
    || !Number.isSafeInteger(expectedOwnerUid) || expectedOwnerUid < 0
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) fail("INVALID_ARTIFACT_PATH_POLICY");
  let fd;
  try {
    if (fs.realpathSync(absolutePath) !== absolutePath) fail("UNSAFE_ARTIFACT_PATH");
    let ancestor = path.dirname(absolutePath);
    while (true) {
      const stat = fs.lstatSync(ancestor);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0
        || ![0, expectedOwnerUid].includes(stat.uid)) fail("UNSAFE_ARTIFACT_ANCESTRY");
      if (ancestor === path.dirname(ancestor)) break;
      ancestor = path.dirname(ancestor);
    }
    fd = fs.openSync(absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(expectedOwnerUid)
      || (before.mode & 0o777n) !== 0o600n || before.size < 1n || before.size > BigInt(maxBytes)) fail("UNSAFE_ARTIFACT_FILE");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(absolutePath, { bigint: true });
    const identity = stat => [stat.dev, stat.ino, stat.size, stat.mode, stat.uid, stat.gid, stat.nlink, stat.mtimeNs, stat.ctimeNs];
    if (!isDeepStrictEqual(identity(before), identity(after)) || !isDeepStrictEqual(identity(after), identity(named))
      || offset !== Number(before.size) || fs.realpathSync(absolutePath) !== absolutePath) fail("ARTIFACT_CHANGED_DURING_READ");
    const result = bytes.subarray(0, offset);
    if (digest(result) !== expectedSha256) fail("ARTIFACT_HASH_MISMATCH");
    return result;
  } catch (error) {
    if (error instanceof PartnerIngressEvidenceError) throw error;
    fail("ARTIFACT_READ_FAILED");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// This reducer is deliberately local-only. A production collector has not been
// selected/reviewed, so callers cannot promote synthetic outcomes to live proof.
export function evaluateLocalPartnerIngressObservations({ before, after, probes, startedAt, completedAt }) {
  validateIngressContext(before);
  validateIngressContext(after);
  if (!isDeepStrictEqual(before, after)) fail("RUNTIME_DRIFT");
  if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(completedAt)
    || completedAt < startedAt || completedAt - startedAt > 60000) fail("INVALID_PROBE_WINDOW");
  if (!Array.isArray(probes) || probes.length !== PARTNER_INGRESS_REQUIRED_PROBES.length
    || !isDeepStrictEqual(probes.map(probe => probe?.id).sort(), [...PARTNER_INGRESS_REQUIRED_PROBES].sort())) fail("INCOMPLETE_PROBE_MATRIX");
  for (const probe of probes) {
    exact(probe, ["id", "outcome", "httpStatus", "tlsAuthorized", "cacheControl", "corsHeaderPresent", "capturedAt", "vantage"], "INVALID_PROBE_RESULT");
    if (probe.vantage !== "LOCAL_FIXTURE" || !Number.isSafeInteger(probe.capturedAt)
      || probe.capturedAt < startedAt || probe.capturedAt > completedAt
      || typeof probe.tlsAuthorized !== "boolean" || typeof probe.corsHeaderPresent !== "boolean") fail("INVALID_PROBE_RESULT");
    if (probe.id === "directSidecar") {
      if (probe.outcome !== "CONNECTION_REFUSED" || probe.httpStatus !== null || probe.tlsAuthorized) fail("DIRECT_SIDECAR_NOT_REFUSED");
    } else if (["wrongSni", "noClientCertificate", "wrongClientCertificate"].includes(probe.id)) {
      if (probe.outcome !== "TLS_ALERT_REJECTED" || probe.httpStatus !== null || probe.tlsAuthorized) fail("MTLS_OR_SNI_NOT_ENFORCED");
    } else {
      const statuses = {
        positiveDefaultOff: [503], wrongHost: [400, 421], sharedHost: [404],
        editorAdmin: [404], options: [400, 404, 405], query: [400, 404], cors: [503],
      };
      if (probe.outcome !== "HTTP_RESPONSE" || !probe.tlsAuthorized || !statuses[probe.id].includes(probe.httpStatus)) fail("INGRESS_PROBE_REJECTED");
    }
    if (probe.corsHeaderPresent) fail("UPSTREAM_CORS_EXPOSED");
    if (["positiveDefaultOff", "cors"].includes(probe.id) && probe.cacheControl !== "no-store") fail("INGRESS_CACHE_POLICY_WEAKENED");
  }
  return Object.freeze({
    state: "LOCAL_INGRESS_OBSERVATIONS_VALIDATED_NOT_LIVE_PROOF",
    productionVerified: false, deployAuthorized: false, activationAuthorized: false,
    probeCount: probes.length,
  });
}

// No implicit vendor guess, static-dump fallback, command injection or live IO.
// A reviewed, vendor-authoritative collector must replace this stop in a later
// explicitly selected adapter implementation; the generic core is not that adapter.
export function verifyPartnerProductionIngress() {
  fail("UNSUPPORTED_INGRESS_ADAPTER");
}
