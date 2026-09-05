import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { canonicalJson } from "../../node-red/custom-nodes/partner-game-membership-api/partner-game-membership-core.mjs";
import {
  PARTNER_INGRESS_REQUIRED_PROBES, evaluateLocalPartnerIngressObservations,
  parseCanonicalIngressJson, readPinnedIngressArtifact, validateIngressContext,
  verifyPartnerProductionIngress, verifySignedPartnerReachability,
} from "../partner_game_membership_ingress_evidence.mjs";

const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const bytes = value => Buffer.from(canonicalJson(value));
const NOW = Date.parse("2026-09-05T13:00:00.000Z");
const context = () => ({
  approvedCommit: "1".repeat(40), approvedTree: "2".repeat(40),
  ...Object.fromEntries([
    "packetManifestSha256", "controlsSha256", "runtimeManifestSha256", "auditReportSha256",
    "configClosureSha256", "effectiveConfigSha256", "clientCertificateSpkiSha256", "clientCaBundleSha256",
    "hostMachineIdSha256", "bootIdSha256", "serviceIdentitySha256", "executableSha256",
    "processStartIdentitySha256", "runtimeGenerationSha256",
  ].map(field => [field, digest(field)])),
  exactHost: "partner.example.test", audience: "partner-production",
});

function signedFixture() {
  // Ephemeral synthetic signing keys stay in process memory, never in Git/files.
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const expectedContext = context();
  const payload = {
    formatVersion: 1, kind: "PARTNER_INGRESS_REACHABILITY", context: expectedContext,
    issuedAt: new Date(NOW - 60000).toISOString(), expiresAt: new Date(NOW + 60000).toISOString(),
    decision: "NO_REACHABLE_HIGH_OR_CRITICAL", reachableHighPackages: [],
  };
  const sign = value => bytes({ payload: value, signature: crypto.sign(null,
    Buffer.from("PADLHUB-PARTNER-INGRESS-REACHABILITY-V1\n" + canonicalJson(value)), privateKey).toString("base64url") });
  return { payload, sign, options: {
    envelopeBytes: sign(payload), reviewerPublicKeyBytes: Buffer.from(publicKey.export({ type: "spki", format: "pem" })),
    approvedReviewerSpkiSha256: digest(publicKey.export({ type: "spki", format: "der" })),
    expectedContext, now: NOW,
  } };
}

test("signed reachability pins every context field and remains non-authorizing", () => {
  const f = signedFixture();
  assert.deepEqual(verifySignedPartnerReachability(f.options), {
    state: "SIGNED_REACHABILITY_VERIFIED_NOT_AUTHORIZED", envelopeSha256: digest(f.options.envelopeBytes),
  });
});

for (const key of Object.keys(context())) {
  test(`signed reachability rejects cross-context replay: ${key}`, () => {
    const f = signedFixture();
    const changed = { ...f.options.expectedContext, [key]: key === "exactHost" ? "other.example.test"
      : key === "audience" ? "other-audience" : "f".repeat(key.startsWith("approved") ? 40 : 64) };
    assert.throws(() => verifySignedPartnerReachability({ ...f.options, expectedContext: changed }), /REACHABILITY_CONTEXT_MISMATCH/);
  });
}

test("reachability rejects tampering, unpinned and embedded trust anchors", () => {
  const f = signedFixture();
  const envelope = JSON.parse(f.options.envelopeBytes);
  envelope.signature = "A".repeat(86);
  assert.throws(() => verifySignedPartnerReachability({ ...f.options, envelopeBytes: bytes(envelope) }), /INVALID_REACHABILITY_SIGNATURE/);
  assert.throws(() => verifySignedPartnerReachability({ ...f.options, approvedReviewerSpkiSha256: "f".repeat(64) }), /UNTRUSTED_REVIEWER_KEY/);
  assert.throws(() => verifySignedPartnerReachability({ ...f.options, approvedReviewerSpkiSha256: undefined }), /MISSING_REVIEWER_TRUST_ANCHOR/);
  envelope.publicKey = f.options.reviewerPublicKeyBytes.toString();
  assert.throws(() => verifySignedPartnerReachability({ ...f.options, envelopeBytes: bytes(envelope) }), /INVALID_REACHABILITY_ENVELOPE/);
  assert.throws(() => verifySignedPartnerReachability({ ...f.options, reviewerPublicKeyBytes: Buffer.from("invalid") }), /INVALID_REVIEWER_PUBLIC_KEY/);
});

test("reachability rejects a different signing algorithm", () => {
  const f = signedFixture();
  const { publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  assert.throws(() => verifySignedPartnerReachability({ ...f.options,
    reviewerPublicKeyBytes: Buffer.from(publicKey.export({ type: "spki", format: "pem" })),
    approvedReviewerSpkiSha256: digest(publicKey.export({ type: "spki", format: "der" })),
  }), /UNTRUSTED_REVIEWER_KEY/);
});

test("reachability rejects expired, future, overlong and ambiguous dates", () => {
  const f = signedFixture();
  for (const changes of [
    { expiresAt: new Date(NOW).toISOString() },
    { issuedAt: new Date(NOW + 1).toISOString() },
    { expiresAt: new Date(NOW + 86400001).toISOString() },
    { issuedAt: "2026-09-05T12:59:00Z" },
    { issuedAt: new Date(NOW - 86400000).toISOString(), expiresAt: new Date(NOW - 1).toISOString() },
  ]) assert.throws(() => verifySignedPartnerReachability({ ...f.options, envelopeBytes: f.sign({ ...f.payload, ...changes }) }), /STALE_REACHABILITY_EVIDENCE/);
});

test("reachability rejects unsafe decisions, extra authorization and invalid schemas", () => {
  const f = signedFixture();
  for (const changes of [{ decision: "UNKNOWN" }, { reachableHighPackages: ["unexpected-package"] }, { formatVersion: 2 }]) {
    assert.throws(() => verifySignedPartnerReachability({ ...f.options, envelopeBytes: f.sign({ ...f.payload, ...changes }) }), /UNSAFE_REACHABILITY_DECISION/);
  }
  assert.throws(() => verifySignedPartnerReachability({ ...f.options, envelopeBytes: f.sign({ ...f.payload, deployAuthorized: true }) }), /INVALID_REACHABILITY_PAYLOAD/);
  assert.throws(() => validateIngressContext({ ...context(), approvedCommit: "short" }), /INVALID_INGRESS_CONTEXT/);
  assert.throws(() => validateIngressContext({ ...context(), exactHost: "https://example.test/path" }), /INVALID_INGRESS_CONTEXT/);
  assert.throws(() => validateIngressContext({ ...context(), audience: "prod\n" }), /INVALID_INGRESS_CONTEXT/);
});

test("canonical JSON rejects duplicate fields, whitespace, floats, malformed and oversized bytes", () => {
  for (const raw of ['{"a":1,"a":1}', '{ "a":1}', '{"a":1.5}', '{"a":', '{"__proto__":1,"__proto__":2}']) {
    assert.throws(() => parseCanonicalIngressJson(Buffer.from(raw)), /NON_CANONICAL_ARTIFACT/);
  }
  assert.throws(() => parseCanonicalIngressJson(Buffer.alloc(65537)), /INVALID_ARTIFACT_BYTES/);
  assert.throws(() => parseCanonicalIngressJson(Buffer.alloc(0)), /INVALID_ARTIFACT_BYTES/);
  assert.deepEqual(parseCanonicalIngressJson(bytes({ a: 1 })), { a: 1 });
});

function fileFixture(t, parent = path.dirname(fileURLToPath(import.meta.url))) {
  const root = fs.mkdtempSync(path.join(parent, ".partner-ingress-evidence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.chmodSync(root, 0o700);
  const absolutePath = path.join(root, "artifact.json");
  const data = bytes({ fixture: "public non-secret test data" });
  fs.writeFileSync(absolutePath, data, { mode: 0o600, flag: "wx" });
  return { root, data, options: { absolutePath, expectedSha256: digest(data), expectedOwnerUid: process.getuid() } };
}

test("artifact reader verifies exact bounded bytes and redacts failures", t => {
  const f = fileFixture(t);
  assert.deepEqual(readPinnedIngressArtifact(f.options), f.data);
  for (const changes of [{ expectedSha256: "f".repeat(64) }, { expectedOwnerUid: process.getuid() + 1 }, { maxBytes: 2 }]) {
    assert.throws(() => readPinnedIngressArtifact({ ...f.options, ...changes }), error => {
      assert.ok(!error.message.includes(f.root)); assert.ok(!error.message.includes("public non-secret")); return true;
    });
  }
  assert.throws(() => readPinnedIngressArtifact({ ...f.options, absolutePath: "relative" }), /INVALID_ARTIFACT_PATH_POLICY/);
});

test("artifact reader rejects symlinks, hardlinks, public modes and directory aliases", t => {
  const f = fileFixture(t);
  const alias = path.join(f.root, "alias.json");
  fs.symlinkSync(f.options.absolutePath, alias);
  assert.throws(() => readPinnedIngressArtifact({ ...f.options, absolutePath: alias }), /UNSAFE_ARTIFACT_PATH/);
  fs.linkSync(f.options.absolutePath, path.join(f.root, "hardlink.json"));
  assert.throws(() => readPinnedIngressArtifact(f.options), /UNSAFE_ARTIFACT_FILE/);
  const g = fileFixture(t);
  fs.chmodSync(g.options.absolutePath, 0o644);
  assert.throws(() => readPinnedIngressArtifact(g.options), /UNSAFE_ARTIFACT_FILE/);
  const parentAlias = path.join(f.root, "parent-alias");
  fs.symlinkSync(g.root, parentAlias);
  assert.throws(() => readPinnedIngressArtifact({ ...g.options, absolutePath: path.join(parentAlias, "artifact.json") }), /UNSAFE_ARTIFACT_PATH/);
});

test("artifact reader rejects writable ancestry and source replacement during read", t => {
  const f = fileFixture(t);
  fs.chmodSync(f.root, 0o777);
  assert.throws(() => readPinnedIngressArtifact(f.options), /UNSAFE_ARTIFACT_ANCESTRY/);
  fs.chmodSync(f.root, 0o700);
  const read = fs.readSync;
  let replaced = false;
  t.mock.method(fs, "readSync", (...args) => {
    const result = read(...args);
    if (!replaced) {
      replaced = true;
      const replacement = path.join(f.root, "replacement.json");
      fs.writeFileSync(replacement, f.data, { mode: 0o600 });
      fs.renameSync(replacement, f.options.absolutePath);
    }
    return result;
  });
  assert.throws(() => readPinnedIngressArtifact(f.options), /ARTIFACT_CHANGED_DURING_READ/);
});

test("artifact reader rejects a world-writable temporary ancestor", t => {
  const f = fileFixture(t, fs.realpathSync(os.tmpdir()));
  // Some platforms have private tmp roots, so explicitly create the weak ancestor.
  fs.chmodSync(f.root, 0o777);
  assert.throws(() => readPinnedIngressArtifact(f.options), /UNSAFE_ARTIFACT_ANCESTRY/);
});

function observations() {
  const status = { positiveDefaultOff: 503, wrongHost: 421, sharedHost: 404, editorAdmin: 404, options: 405, query: 400, cors: 503 };
  return { before: context(), after: context(), startedAt: NOW, completedAt: NOW + 1000,
    probes: PARTNER_INGRESS_REQUIRED_PROBES.map(id => ({
      id, outcome: id === "directSidecar" ? "CONNECTION_REFUSED" : status[id] ? "HTTP_RESPONSE" : "TLS_ALERT_REJECTED",
      httpStatus: status[id] ?? null, tlsAuthorized: Boolean(status[id]),
      cacheControl: status[id] === 503 ? "no-store" : null, corsHeaderPresent: false,
      capturedAt: NOW + 100, vantage: "LOCAL_FIXTURE",
    })),
  };
}

test("local reducer is non-live and non-authorizing, including with a passing matrix", () => {
  const result = evaluateLocalPartnerIngressObservations(observations());
  assert.deepEqual(result, { state: "LOCAL_INGRESS_OBSERVATIONS_VALIDATED_NOT_LIVE_PROOF", productionVerified: false, deployAuthorized: false, activationAuthorized: false, probeCount: 11 });
  assert.ok(Object.isFrozen(result));
});

for (const id of PARTNER_INGRESS_REQUIRED_PROBES) {
  test(`local matrix rejects missing, duplicate, timed-out or ambiguous probe: ${id}`, () => {
    const f = observations();
    assert.throws(() => evaluateLocalPartnerIngressObservations({ ...f, probes: f.probes.filter(p => p.id !== id) }), /INCOMPLETE_PROBE_MATRIX/);
    assert.throws(() => evaluateLocalPartnerIngressObservations({ ...f, probes: [...f.probes, f.probes.find(p => p.id === id)] }), /INCOMPLETE_PROBE_MATRIX/);
    for (const outcome of ["NOT_RUN", "TIMEOUT", "UNKNOWN", "CONNECTION_RESET"]) {
      assert.throws(() => evaluateLocalPartnerIngressObservations({ ...f, probes: f.probes.map(p => p.id === id ? { ...p, outcome } : p) }));
    }
  });
}

test("runtime changes including correct config but wrong running generation are rejected", () => {
  for (const key of ["effectiveConfigSha256", "runtimeGenerationSha256", "processStartIdentitySha256", "bootIdSha256", "executableSha256"]) {
    const f = observations(); f.after[key] = "e".repeat(64);
    assert.throws(() => evaluateLocalPartnerIngressObservations(f), /RUNTIME_DRIFT/);
  }
});

test("local reducer rejects CORS leakage, cache weakening, false positives and remote-vantage claims", () => {
  for (const [id, changes] of [
    ["cors", { corsHeaderPresent: true }], ["positiveDefaultOff", { cacheControl: "public" }],
    ["wrongHost", { httpStatus: 503 }], ["sharedHost", { httpStatus: 503 }],
    ["wrongSni", { outcome: "HTTP_RESPONSE", httpStatus: 503, tlsAuthorized: true }],
    ["noClientCertificate", { outcome: "HTTP_RESPONSE", httpStatus: 503, tlsAuthorized: true }],
    ["wrongClientCertificate", { outcome: "HTTP_RESPONSE", httpStatus: 503, tlsAuthorized: true }],
    ["query", { vantage: "EXTERNAL_PRODUCTION" }], ["query", { capturedAt: NOW - 1 }],
    ["query", { deployAuthorized: true }], ["query", { tlsAuthorized: false }],
  ]) {
    const f = observations(); Object.assign(f.probes.find(p => p.id === id), changes);
    assert.throws(() => evaluateLocalPartnerIngressObservations(f));
  }
  assert.throws(() => evaluateLocalPartnerIngressObservations({ ...observations(), completedAt: NOW + 60001 }), /INVALID_PROBE_WINDOW/);
});

test("production has no adapter, static-dump fallback or caller-controlled executable", () => {
  for (const input of [undefined, { adapter: "nginx", command: "true" }, { adapter: "fixture-v1" },
    { adapter: "caddy", readback: "caller-provided", ...Object.fromEntries(PARTNER_INGRESS_REQUIRED_PROBES.map(id => [id, true])) }]) {
    assert.throws(() => verifyPartnerProductionIngress(input), /UNSUPPORTED_INGRESS_ADAPTER/);
  }
});
