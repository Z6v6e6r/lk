import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { preflightPartnerNginx124 } from "../partner_game_membership_nginx_preflight.mjs";
import { createLocalNginxApplicationSession, verifyLocalNginxApplicationPhase, deriveLocalNginxApplicationAddresses } from "../partner_game_membership_nginx_application.mjs";
import { parseNginxProcStat, collectLocalNginxLinuxSnapshot } from "../partner_game_membership_nginx_linux.mjs";
import { createPartnerNginxTestCertificates } from "./fixtures/partner-nginx124-certificates.mjs";
import { collectFixtureLogThenCleanup } from "./fixtures/partner-nginx-application-cleanup.mjs";
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

function nginxPreflightFixture() {
  const repoFile = relative => fs.readFileSync(new URL(`../../${relative}`, import.meta.url));
  const metadata = {
    formatVersion: 1, kind: "SANITIZED_NGINX_BUILD_CAPABILITIES", version: "1.24.0", distribution: "Ubuntu",
    inspectedFlags: ["--with-http_ssl_module", "--with-http_v2_module", "--with-control-api",
      "--without-http_limit_req_module", "--without-http_limit_conn_module"],
    presentFlags: ["--with-http_ssl_module", "--with-http_v2_module"],
  };
  const withMetadata = changes => {
    const buildMetadataBytes = bytes({ ...metadata, ...changes });
    return { buildMetadataBytes, expectedBuildMetadataSha256: digest(buildMetadataBytes) };
  };
  return { metadata, withMetadata, input: {
    ...withMetadata({}), controlsBytes: repoFile("scripts/partner_game_membership_production_controls.json"),
    sidecarSources: {
      core: repoFile("node-red/custom-nodes/partner-game-membership-api/partner-game-membership-core.mjs"),
      node: repoFile("node-red/custom-nodes/partner-game-membership-api/partner-game-membership-node.cjs"),
      settings: repoFile("scripts/partner_game_membership_sidecar/settings.cjs"),
    },
  } };
}

test("Nginx 1.24 preflight pins current source but BLOCKS unproven raw guards and live configuration", () => {
  const f = nginxPreflightFixture();
  const result = preflightPartnerNginx124(f.input);
  assert.equal(result.state, "LOCAL_NGINX_124_CAPABILITY_CHECKED_NOT_ACTIVE");
  assert.equal(result.decision, "BLOCKED");
  assert.deepEqual(result.blockers, ["RAW_DUPLICATE_HEADERS_GUARD_UNPROVEN", "RAW_DUPLICATE_JSON_GUARD_UNPROVEN", "EFFECTIVE_CONFIG_UNPROVABLE"]);
  for (const field of ["productionVerified", "configGenerationAllowed", "deployAuthorized", "activationAuthorized"]) assert.equal(result[field], false);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.coverage) && Object.isFrozen(result.blockers));
  assert.ok(result.coverage.every(row => row.evidence === "NOT_PROVEN" && Object.isFrozen(row)));
  for (const control of ["requestPolicy.duplicateCriticalHeadersRejected", "requestPolicy.duplicateJsonKeysRejected"]) {
    assert.equal(result.coverage.find(row => row.control === control).owner, "RAW_REQUEST_BEFORE_NODERED_PARSER");
  }
  const ingress = JSON.parse(f.input.controlsBytes).ingress;
  const expected = ["routing", "transport", "requestPolicy", "responsePolicy"]
    .flatMap(section => Object.keys(ingress[section]).map(key => `${section}.${key}`)).sort();
  assert.deepEqual(result.coverage.map(row => row.control), expected);
});

test("Nginx preflight detects missing SSL, disabled limit modules and unreviewed control API", () => {
  const f = nginxPreflightFixture();
  for (const [presentFlags, code] of [
    [[], "NGINX_SSL_MODULE_MISSING"],
    [["--with-http_ssl_module", "--without-http_limit_req_module"], "NGINX_REQUEST_LIMIT_MODULE_DISABLED"],
    [["--with-http_ssl_module", "--without-http_limit_conn_module"], "NGINX_CONNECTION_LIMIT_MODULE_DISABLED"],
    [["--with-http_ssl_module", "--with-control-api"], "NGINX_UNREVIEWED_CONTROL_API_BUILD"],
  ]) {
    const result = preflightPartnerNginx124({ ...f.input, ...f.withMetadata({ presentFlags }) });
    assert.equal(result.decision, "BLOCKED");
    assert.ok(result.blockers.includes(code));
    assert.ok(result.blockers.includes("EFFECTIVE_CONFIG_UNPROVABLE"));
  }
});

for (const [name, changes] of [
  ["version", { version: "1.31.5" }], ["vendor", { distribution: "other" }],
  ["format", { formatVersion: 2 }], ["kind", { kind: "LIVE_VERIFIED" }],
  ["unknown flag", { presentFlags: ["--with-unknown-auth-module"] }],
  ["duplicate flag", { presentFlags: ["--with-http_ssl_module", "--with-http_ssl_module"] }],
  ["incomplete observation", { inspectedFlags: ["--with-http_ssl_module"] }],
]) {
  test(`Nginx preflight rejects unsupported metadata: ${name}`, () => {
    const f = nginxPreflightFixture();
    assert.throws(() => preflightPartnerNginx124({ ...f.input, ...f.withMetadata(changes) }), /UNSUPPORTED_NGINX_BUILD_METADATA/);
  });
}

test("Nginx preflight rejects altered metadata, controls and each sidecar source", () => {
  const f = nginxPreflightFixture();
  assert.throws(() => preflightPartnerNginx124({ ...f.input, expectedBuildMetadataSha256: "f".repeat(64) }), /NGINX_BUILD_METADATA_HASH_MISMATCH/);
  assert.throws(() => preflightPartnerNginx124({ ...f.input, controlsBytes: Buffer.from("{}") }), /NGINX_CONTROLS_DRIFT/);
  for (const field of Object.keys(f.input.sidecarSources)) {
    assert.throws(() => preflightPartnerNginx124({ ...f.input, sidecarSources: {
      ...f.input.sidecarSources, [field]: Buffer.concat([f.input.sidecarSources[field], Buffer.from("\n")]),
    } }), /NGINX_SIDECAR_SOURCE_DRIFT/);
  }
});

test("Nginx preflight refuses caller guard assertions, reload receipts, config dumps and exec hooks", () => {
  const f = nginxPreflightFixture();
  for (const extra of [
    { rawGuardVerified: true }, { productionVerified: true }, { reloadReceipt: {} },
    { configDump: "ssl_verify_client on;" }, { exec: () => assert.fail("must not execute") },
    { configGenerationAllowed: true },
  ]) assert.throws(() => preflightPartnerNginx124({ ...f.input, ...extra }), /INVALID_NGINX_PREFLIGHT_INPUT/);
  assert.throws(() => preflightPartnerNginx124({ ...f.input, sidecarSources: { ...f.input.sidecarSources, guard: Buffer.from("verified") } }), /INVALID_NGINX_SIDECAR_SOURCES/);
  assert.throws(() => verifyPartnerProductionIngress({ adapter: "nginx", preflight: preflightPartnerNginx124(f.input) }), /UNSUPPORTED_INGRESS_ADAPTER/);
});

test("Nginx preflight rejects noncanonical, oversized and malformed artifacts without disclosing bytes", () => {
  const f = nginxPreflightFixture();
  for (const buildMetadataBytes of [Buffer.alloc(4097), Buffer.from("not-json"), Buffer.from(" " + f.input.buildMetadataBytes)]) {
    assert.throws(() => preflightPartnerNginx124({ ...f.input, buildMetadataBytes, expectedBuildMetadataSha256: digest(buildMetadataBytes) }), error => {
      assert.match(error.message, /^[A-Z_]+$/); return true;
    });
  }
  assert.throws(() => preflightPartnerNginx124({ ...f.input, controlsBytes: Buffer.alloc(65537) }), /INVALID_NGINX_CONTROLS_BYTES/);
  assert.throws(() => preflightPartnerNginx124({ ...f.input, sidecarSources: { ...f.input.sidecarSources, core: Buffer.alloc(1048577) } }), /INVALID_NGINX_SIDECAR_SOURCE_BYTES/);
});

test("controlled Nginx application candidate: local lifecycle and fail-closed evidence", async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "partner-application-unit-"));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const binding = createPartnerNginxTestCertificates(path.join(root, "fixture"), { sourceLimits: true });
  const network = { peerAddress: "172.24.0.2", probeAddress: "172.24.0.3" };
  const session = () => createLocalNginxApplicationSession({ binding, ...network });
  const identity = (pid, startTicks, parentPid) => ({ pid, parentPid, startTicks, executableSha256: "a".repeat(64), draining: false });
  function observation(s, phase, index, upstreamBefore, marker = null) {
    const expected = s.configuration(phase);
    const snapshot = { scope: "LOCAL_FIXTURE", configSha256: expected.configSha256, master: identity(1, "10", 0),
      workers: [identity(11 + index, String(100 + index * 10), 1)], bootSha256: "b".repeat(64),
      pidNamespaceSha256: "c".repeat(64), networkNamespaceSha256: "d".repeat(64) };
    const status = phase === "revoked" ? [403, 503] : [503, 503];
    return { phase, before: snapshot, after: structuredClone(snapshot), upstreamBefore,
      upstreamAfter: upstreamBefore + (phase === "revoked" ? 1 : 2),
      probes: ["client", "client-2", "direct-sidecar"].map((name, i) => ({ name,
        outcome: i === 2 ? "CONNECTION_REFUSED" : "HTTP_RESPONSE", status: status[i] ?? null,
        tlsAuthorized: i !== 2, noStore: i !== 2, cors: false, complete: i !== 2,
        sourceAddress: i === 2 ? null : network.probeAddress, peerAddress: network.peerAddress, port: i === 2 ? 18894 : 8443,
        networkNamespaceSha256: "e".repeat(64), clientLeafDerSha256: i === 2 ? null : expected.clientLeafDerSha256[name] })),
      logs: status.map((code, i) => ({ generation: marker ?? expected.marker, worker: String(11 + index),
        requestId: String(index * 10 + i + 1).padStart(32, "0"), status: String(code), clientVerified: "1",
        upstream: code === 403 ? "" : "503", rate: code === 403 ? "" : "PASSED", concurrency: code === 403 ? "" : "PASSED" })),
    };
  }
  function baseline(s) { const row = observation(s, "baseline", 0, 0); s.record(row); return row; }
  function unapplied(s) { const row = observation(s, "applied", 0, 2, s.configuration("baseline").marker); s.recordUnapplied(row); return row; }
  function complete(s) { baseline(s); unapplied(s); s.record(observation(s, "applied", 1, 4)); s.record(observation(s, "revoked", 2, 6)); return s.finish(); }

  await t.test("three generations plus disk-only negative finish once, never production", () => {
    const s = session(), proof = complete(s);
    assert.equal(proof.state, "LOCAL_CONTROLLED_APPLICATION_VERIFIED_NOT_LIVE_PROOF");
    assert.equal(proof.records.length, 3); assert.equal(proof.records[2].observed.upstreamAfter, 7);
    assert.equal(proof.productionVerified, false); assert.equal(proof.deployAuthorized, false); assert.equal(proof.activationAuthorized, false);
    assert.equal(proof.revocation, "LEAF_BINDING_REMOVAL_NOT_CA_CRL_OR_OCSP");
    assert.throws(() => s.finish(), /SESSION_CLOSED/); assert.throws(() => s.configuration("baseline"), /SESSION_CLOSED/);
    assert.throws(() => verifyPartnerProductionIngress({ adapter: "nginx", proof }), /UNSUPPORTED_INGRESS_ADAPTER/);
    assert.throws(() => verifyPartnerProductionIngress({ adapter: "nginx", proof: { ...proof, productionVerified: true } }), /UNSUPPORTED_INGRESS_ADAPTER/);
  });
  await t.test("closed fixture preserves thresholds and removes only the formerly admitted leaf", () => {
    const s = session(), a = s.configuration("baseline"), b = s.configuration("applied"), c = s.configuration("revoked");
    assert.notEqual(a.marker, b.marker); assert.notEqual(a.configSha256, b.configSha256);
    assert.match(a.configuration, /"worker":"\$pid"/); assert.ok(a.configuration.includes(a.marker));
    assert.match(a.configuration, /listen 0\.0\.0\.0:8443/); assert.match(a.configuration, /allow 172\.24\.0\.3;/);
    for (const config of [a, b, c]) { assert.match(config.configuration, /partner_source_rate burst=20/); assert.match(config.configuration, /partner_source_connections 8/); }
    assert.match(a.configuration, /"SUCCESS:fixture-client" 1;/); assert.doesNotMatch(c.configuration, /"SUCCESS:fixture-client" 1;/);
    assert.match(c.configuration, /"SUCCESS:fixture-client-2" 1;/); assert.match(c.configuration, /"SUCCESS:fixture-client-3" 1;/);
    a.marker = "f".repeat(64); assert.notEqual(s.configuration("baseline").marker, a.marker);
  });
  await t.test("unknown options, external/loopback/identical targets and production inputs fail", () => {
    for (const change of [{ exec() {} }, { productionVerified: true }, { probeAddress: "127.0.0.1" },
      { peerAddress: "203.0.113.1" }, { peerAddress: network.probeAddress }, { probeAddress: "172.999.0.3" }]) {
      assert.throws(() => createLocalNginxApplicationSession({ binding, ...network, ...change }));
    }
    assert.throws(() => createLocalNginxApplicationSession({ binding: { ...binding, scope: "PRODUCTION" }, ...network }));
  });
  await t.test("owned Docker allocation supports both observed private pool forms without caller CIDRs", () => {
    for (const subnet of ["172.17.0.0/16", "172.31.0.0/16", "192.168.0.0/20", "192.168.16.0/20", "192.168.240.0/20"]) {
      const addresses = deriveLocalNginxApplicationAddresses(subnet);
      const prefix = subnet.split(".").slice(0, 3).join(".");
      assert.deepEqual(addresses, { peerAddress: `${prefix}.2`, probeAddress: `${prefix}.3` });
      const s = createLocalNginxApplicationSession({ binding, ...addresses });
      assert.ok(s.configuration("baseline").configuration.includes(`      allow ${prefix}.3;`));
    }
  });
  await t.test("Docker subnet parser rejects public, broad, misaligned, malformed and unsupported pools", () => {
    for (const subnet of [null, {}, "", "172.15.0.0/16", "172.32.0.0/16", "172.24.1.0/16", "172.24.0.0/12",
      "192.169.0.0/20", "192.168.1.0/20", "192.168.256.0/20", "192.168.016.0/20", "192.168.16.0/16",
      "192.168.16.1/20", "192.168.16.0/20\n", "0.0.0.0/0", "10.0.0.0/8", "127.0.0.0/8", "::1/128"]) {
      assert.throws(() => deriveLocalNginxApplicationAddresses(subnet), /NGINX_APPLICATION_DOCKER_SUBNET_UNSUPPORTED/);
    }
    for (const probeAddress of ["192.168.256.3", "192.168.016.3", "192.168.16.0", "192.168.16.255", "192.169.16.3", "192.168.16.3/20"]) {
      assert.throws(() => createLocalNginxApplicationSession({ binding, ...network, probeAddress }), /VANTAGE_INVALID/);
    }
  });
  await t.test("different sessions have independent challenges and reject cross-run evidence", () => {
    const a = session(), b = session(); assert.notEqual(a.challenge, b.challenge);
    assert.throws(() => b.record(observation(a, "baseline", 0, 0)), /CONFIG_MISMATCH/);
    assert.throws(() => b.record(observation(b, "baseline", 0, 0)), /SESSION_CLOSED/);
  });
  await t.test("phase ordering, replay, incomplete finish and failure latch", () => {
    const a = session(); assert.throws(() => a.finish(), /MATRIX_INCOMPLETE/); assert.throws(() => a.finish(), /SESSION_CLOSED/);
    const b = session(); baseline(b); assert.throws(() => b.record(observation(b, "baseline", 0, 2)), /PHASE_ORDER/);
    const c = session(); baseline(c); assert.throws(() => c.record(observation(c, "applied", 1, 2)), /UNAPPLIED_PROOF_REQUIRED/);
    const d = session(); assert.throws(() => d.recordUnapplied(observation(d, "applied", 0, 0)), /PHASE_ORDER/);
  });
  await t.test("expiry and clock rollback close a session permanently", () => {
    const now = Date.now, current = now(), a = session(), b = session();
    try {
      Date.now = () => current + 120001; assert.throws(() => a.configuration("baseline"), /SESSION_EXPIRED/);
      Date.now = () => current - 1; assert.throws(() => b.configuration("baseline"), /SESSION_EXPIRED/);
    } finally { Date.now = now; }
    assert.throws(() => a.configuration("baseline"), /SESSION_CLOSED/);
  });
  await t.test("disk files B and old worker/marker A are not applied B", () => {
    const s = session(), old = baseline(s), row = unapplied(s);
    assert.throws(() => verifyLocalNginxApplicationPhase({ expected: s.configuration("applied"), observed: row, previous: old.after, ...network }), /NEW_WORKER_REQUIRED/);
  });
  await t.test("new PID from worker respawn cannot substitute for a new applied marker", () => {
    const s = session(); baseline(s); unapplied(s);
    const row = observation(s, "applied", 1, 4, s.configuration("baseline").marker);
    assert.throws(() => s.record(row), /GENERATION_NOT_APPLIED/);
  });
  for (const [name, mutate] of [
    ["old worker still present", row => { row.before.workers.push(identity(99, "99", 1)); }],
    ["draining worker", row => { row.before.workers[0].draining = true; }],
    ["PID reuse", row => { row.before.workers[0].pid = 11; row.after.workers[0].pid = 11; }],
    ["wrong master", row => { row.before.master.startTicks = "11"; row.after.master.startTicks = "11"; }],
    ["wrong boot", row => { row.before.bootSha256 = "f".repeat(64); row.after.bootSha256 = "f".repeat(64); }],
    ["executable drift", row => { row.after.master.executableSha256 = "f".repeat(64); }],
    ["config drift", row => { row.after.configSha256 = "f".repeat(64); }],
    ["upstream spoofed marker", row => { row.logs[0].generation = "UNTRUSTED_UPSTREAM_MARKER"; }],
    ["wrong logged worker", row => { row.logs[0].worker = "999"; }],
    ["loopback namespace posing as external", row => { row.probes[0].networkNamespaceSha256 = row.before.networkNamespaceSha256; }],
    ["different direct vantage", row => { row.probes[2].networkNamespaceSha256 = "f".repeat(64); }],
    ["wrong peer target", row => { row.probes[2].peerAddress = "172.24.0.9"; }],
    ["invented actual source on refused socket", row => { row.probes[2].sourceAddress = network.probeAddress; }],
    ["timeout instead of direct refusal", row => { row.probes[2].outcome = "TIMEOUT"; }],
    ["missing positive control", row => { row.probes[1].status = 403; }],
    ["truncated response", row => { row.probes[0].complete = false; }],
    ["CORS leakage", row => { row.probes[0].cors = true; }],
    ["hidden upstream", row => { row.upstreamAfter++; }],
    ["hidden gap traffic", row => { row.upstreamBefore++; row.upstreamAfter++; }],
    ["incomplete logs", row => { row.logs.pop(); }],
    ["duplicated request id", row => { row.logs[1].requestId = row.logs[0].requestId; }],
    ["caller authorization", row => { row.productionVerified = true; }],
  ]) await t.test(`reject ${name}`, () => {
    const s = session(); baseline(s); unapplied(s); const row = observation(s, "applied", 1, 4); mutate(row);
    assert.throws(() => s.record(row)); assert.throws(() => s.finish(), /SESSION_CLOSED/);
  });
  await t.test("revocation must deny old leaf before upstream and keep another identity working", () => {
    for (const mutate of [row => { row.probes[0].status = 503; }, row => { row.logs[0].upstream = "403"; },
      row => { row.logs[0].clientVerified = "0"; }, row => { row.probes[1].status = 403; }]) {
      const s = session(); baseline(s); unapplied(s); s.record(observation(s, "applied", 1, 4));
      const row = observation(s, "revoked", 2, 6); mutate(row); assert.throws(() => s.record(row));
    }
  });
  await t.test("same-CA unbound leaf cannot substitute for the previously admitted revoked leaf", () => {
    const other = digest(new crypto.X509Certificate(fs.readFileSync(path.join(root, "fixture/other-client.crt"))).raw);
    const s = session(); baseline(s); unapplied(s); s.record(observation(s, "applied", 1, 4));
    const row = observation(s, "revoked", 2, 6); row.probes[0].clientLeafDerSha256 = other;
    assert.throws(() => s.record(row), /CLIENT_LEAF_MISMATCH/);
  });
  await t.test("actual leaf is mandatory for every TLS control and cannot be claimed on refused TCP", () => {
    for (const index of [0, 1, 2]) {
      const s = session(), row = observation(s, "baseline", 0, 0);
      row.probes[index].clientLeafDerSha256 = index === 2 ? "f".repeat(64) : null;
      assert.throws(() => s.record(row));
    }
  });
  await t.test("log read/write failure still performs owned cleanup and is not a passing log result", () => {
    const actions = [];
    const result = collectFixtureLogThenCleanup(() => { actions.push("log"); throw new Error("log unavailable"); }, () => actions.push("cleanup"));
    assert.deepEqual(actions, ["log", "cleanup"]); assert.deepEqual(result, { logCollectionFailed: true });
  });
  await t.test("cleanup failure is never swallowed after a log failure", () => {
    assert.throws(() => collectFixtureLogThenCleanup(() => { throw new Error("log unavailable"); }, () => { throw new Error("cleanup unconfirmed"); }), /cleanup unconfirmed/);
    assert.deepEqual(collectFixtureLogThenCleanup(() => {}, () => {}), { logCollectionFailed: false });
  });
  await t.test("Linux stat parser rejects wrong PID/command/malformed identity", () => {
    const fields = Array(49).fill("0"); fields[0] = "1"; fields[18] = "100";
    const raw = `12 (nginx) S ${fields.join(" ")}\n`;
    assert.deepEqual(parseNginxProcStat(raw, 12), { pid: 12, parentPid: 1, startTicks: "100" });
    for (const bad of [raw.replace("nginx", "node"), raw.replace("100", "-1"), "12 (nginx) S", raw + "SECRET_SHOULD_NOT_APPEAR"]) {
      assert.throws(() => parseNginxProcStat(bad, 12), error => { assert.equal(error.message, "NGINX_PROC_STAT_INVALID"); return true; });
    }
    assert.throws(() => parseNginxProcStat(raw, 13), /NGINX_PROC_STAT_INVALID/);
    if (process.platform !== "linux" || process.arch !== "x64" || process.getuid() === 0) assert.throws(() => collectLocalNginxLinuxSnapshot(), /LOCAL_NGINX_LINUX_FIXTURE_REQUIRED/);
  });
});
