import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildQuoteOnlyCandidateBundle } from "../build_lk1_subscription_quote_only_candidate.mjs";
import {
  ENV_KEYS,
  MARKER,
  buildQuoteComparison,
  readStartAuthorizationFromStandardInput,
  validateHttpRequest,
  validateQuoteFixture,
  validateStartAuthorization,
} from "../lk1_subscription_quote_only/quote_runtime.mjs";
import {
  validateQuoteOnlyRuntime,
  validateQuoteOnlyUnit,
  verifyQuoteOnlyCandidateBundle,
} from "../verify_lk1_subscription_quote_only_candidate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PH_ADMIN = "/private/tmp/ph-admin-exact-source-fixture";
const LK_SOURCE = "96ce3713742310d92fdd2d1e75ab2a9c2c046f3c";
const PH_SOURCE = "ec8bcaace29d07a5aafedabb8e7928f1d4244586";
const TOOLING = "a".repeat(40);
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const fixtureBytes = fs.readFileSync(path.join(ROOT, "scripts/lk1_subscription_quote_only/quote_fixture.json"));
const evaluatorBytes = fs.readFileSync(path.join(ROOT, "scripts/nodered_subscription_booking_nodes/fn_managed_subscription_policy_evaluate.js"));
const resolverBytes = fs.readFileSync(path.join(ROOT, "scripts/lk1_subscription_quote_only/subscription-sale-period-resolver.source.ts"));
const resolverRuntimeBytes = fs.readFileSync(path.join(ROOT, "scripts/lk1_subscription_quote_only/subscription-sale-period-resolver.mjs"));
const identity = {
  lkSourceCommit: LK_SOURCE,
  phAdminSourceCommit: PH_SOURCE,
  toolingCommit: TOOLING,
  candidateManifestSha256: "b".repeat(64),
  unitSha256: "c".repeat(64),
  runtimeSha256: "d".repeat(64),
  fixtureSha256: hash(fixtureBytes),
  evaluatorSha256: hash(evaluatorBytes),
  resolverSha256: hash(resolverBytes),
  resolverRuntimeSha256: hash(resolverRuntimeBytes),
  nodeBinarySha256: "1".repeat(64),
  nodeVersion: process.version,
};

function environment(overrides = {}) {
  return Object.fromEntries(Object.entries({ ...identity, ...overrides }).map(([key, value]) => [ENV_KEYS[key], value]));
}

function authorization(overrides = {}) {
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    environment: "DEV",
    purpose: "PROVIDER_INDEPENDENT_QUOTE_ONLY",
    role: "quote",
    ...identity,
    authorizationId: "e".repeat(64),
    issuedAt: "2026-09-04T10:00:00.000Z",
    expiresAt: "2026-09-04T10:30:00.000Z",
    ...overrides,
  }));
}

test("synthetic server-owned A/V1 and B/V2 quote results are distinct and zero-write", () => {
  const fixture = JSON.parse(fixtureBytes.toString("utf8"));
  assert.equal(validateQuoteFixture(fixture), true);
  const result = buildQuoteComparison({ fixture, evaluatorBytes, resolverBytes, resolverRuntimeBytes, identity });
  assert.equal(result.results.A.selectedPolicyVersion, 1);
  assert.equal(result.results.A.decision.eligible, true);
  assert.equal(result.results.A.decision.finalPriceMinor, 0);
  assert.equal(result.results.B.selectedPolicyVersion, 2);
  assert.equal(result.results.B.decision.eligible, true);
  assert.equal(result.results.B.decision.finalPriceMinor, 5000);
  assert.deepEqual(result.writeCounters, { provider: 0, booking: 0, payment: 0, entitlement: 0, mongo: 0 });
  assert.deepEqual(result.browserAcceptedFields, []);
  assert.equal(result.standardManualUat, "BLOCKED");
});

test("fixture fails closed on boundary, browser field, source digest, and policy pin drift", () => {
  const original = JSON.parse(fixtureBytes.toString("utf8"));
  for (const mutate of [
    (value) => { value.browserSubject = "A"; },
    (value) => { value.subjects.B.authoritativePurchasedAt = "2026-09-09T23:59:59.999Z"; },
    (value) => { value.publicationHistory[0].policyDigest = "0".repeat(64); },
    (value) => { value.subjects.A.expectedPolicyVersion = 2; },
  ]) {
    const fixture = structuredClone(original);
    mutate(fixture);
    assert.throws(() => buildQuoteComparison({ fixture, evaluatorBytes, resolverBytes, resolverRuntimeBytes, identity }), /QUOTE_/);
  }
  assert.throws(() => buildQuoteComparison({
    fixture: original, evaluatorBytes: Buffer.from(evaluatorBytes).fill(0, 0, 1), resolverBytes,
    resolverRuntimeBytes, identity,
  }), /QUOTE_SOURCE_DIGEST_MISMATCH/);
  const invalidResolver = Buffer.from("output = process;\n");
  assert.throws(() => buildQuoteComparison({
    fixture: original,
    evaluatorBytes,
    resolverBytes,
    resolverRuntimeBytes: invalidResolver,
    identity: { ...identity, resolverRuntimeSha256: hash(invalidResolver) },
  }), /QUOTE_RESOLVER_CAPABILITY_FORBIDDEN/);
  const evaluatorEscape = Buffer.from('msg.constructor.constructor("return pro" + "cess")().QUOTE_VM_ESCAPE = true; return msg;\n');
  assert.throws(() => buildQuoteComparison({
    fixture: original,
    evaluatorBytes: evaluatorEscape,
    resolverBytes,
    resolverRuntimeBytes,
    identity: { ...identity, evaluatorSha256: hash(evaluatorEscape) },
  }), /Code generation from strings disallowed/);
  assert.equal(process.QUOTE_VM_ESCAPE, undefined);
  const resolverEscape = Buffer.from('output = input.constructor.constructor("return pro" + "cess")();\n');
  assert.throws(() => buildQuoteComparison({
    fixture: original,
    evaluatorBytes,
    resolverBytes,
    resolverRuntimeBytes: resolverEscape,
    identity: { ...identity, resolverRuntimeSha256: hash(resolverEscape) },
  }), /Code generation from strings disallowed/);
});

test("HTTP surface accepts only the exact body-free and query-free GET", () => {
  assert.equal(validateHttpRequest({ method: "GET", url: "/api/internal/subscriptions/dev-uat/quote-comparison" }), true);
  for (const request of [
    { method: "POST", url: "/api/internal/subscriptions/dev-uat/quote-comparison" },
    { method: "GET", url: "/api/internal/subscriptions/dev-uat/quote-comparison?subject=A" },
    { method: "GET", url: "/api/internal/subscriptions/dev-uat/quote-comparison", headers: { "content-length": "0" } },
  ]) assert.throws(() => validateHttpRequest(request), /QUOTE_HTTP_REQUEST_INVALID/);
});

test("start authorization is exact, digest-bound, role-bound, and limited to one hour", () => {
  const now = new Date("2026-09-04T10:10:00.000Z");
  assert.equal(validateStartAuthorization(authorization(), environment(), now).expiresAt, "2026-09-04T10:30:00.000Z");
  for (const [bytes, env] of [
    [authorization({ role: "provider" }), environment()],
    [authorization({ expiresAt: "2026-09-04T11:00:00.001Z" }), environment()],
    [authorization({ expiresAt: "2026-09-04T10:09:59.999Z" }), environment()],
    [authorization({ runtimeSha256: "f".repeat(64) }), environment()],
    [authorization({ extra: true }), environment()],
    [authorization(), environment({ evaluatorSha256: "f".repeat(64) })],
  ]) assert.throws(() => validateStartAuthorization(bytes, env, now), /QUOTE_(?:START_AUTHORIZATION|SCHEMA)_INVALID/);
});

function markerStat({ directory = false, symbolic = false, mode, size = 10, uid = 0, gid = 0, nlink = 1 } = {}) {
  return {
    dev: 1, ino: 2, size, mtimeMs: 3, ctimeMs: 4, mode: mode ?? (directory ? 0o40700 : 0o100600),
    uid, gid, nlink,
    isDirectory: () => directory,
    isFile: () => !directory,
    isSymbolicLink: () => symbolic,
  };
}

function standardInputFs({
  writable = false, oPath = false, wrongTarget = false, statDrift = false,
  uid = 0, gid = 0, mode = 0o100600, nlink = 1, declaredSize = 10, missingFlags = false,
} = {}) {
  const bytes = Buffer.from("0123456789");
  let offset = 0;
  let fdStats = 0;
  const marker = markerStat({ mode, size: declaredSize, uid, gid, nlink });
  const drifted = { ...marker, mtimeMs: 5 };
  return {
    fstatSync: () => {
      fdStats += 1;
      return statDrift && fdStats > 1 ? drifted : marker;
    },
    readlinkSync: () => wrongTarget ? `${MARKER}.copy` : MARKER,
    readFileSync: () => missingFlags ? "" : `flags:\t${oPath ? "010000000" : writable ? "0100001" : "0100000"}\n`,
    readSync: (_fd, target, start, length) => {
      const count = Math.min(length, bytes.length - offset);
      if (count <= 0) return 0;
      bytes.copy(target, start, offset, offset + count);
      offset += count;
      return count;
    },
  };
}

test("systemd StandardInput marker FD proves root custody without traversing its root-only directory", () => {
  assert.equal(readStartAuthorizationFromStandardInput(standardInputFs()).toString(), "0123456789");
  for (const options of [
    { writable: true }, { oPath: true }, { wrongTarget: true }, { statDrift: true },
    { uid: 501 }, { gid: 20 }, { mode: 0o100640 }, { nlink: 2 }, { declaredSize: 0 },
    { declaredSize: 16385 }, { missingFlags: true },
  ]) assert.throws(
    () => readStartAuthorizationFromStandardInput(standardInputFs(options)),
    /QUOTE_START_AUTHORIZATION_(?:CUSTODY_INVALID|CHANGED)/,
  );
});

test("runtime and unit reject write-capable or post-245-incompatible drift", () => {
  const runtime = fs.readFileSync(path.join(ROOT, "scripts/lk1_subscription_quote_only/quote_runtime.mjs"), "utf8");
  const unit = fs.readFileSync(path.join(ROOT, "scripts/lk1_subscription_quote_only/lk1-subscription-dev-quote.service"), "utf8");
  assert.equal(validateQuoteOnlyRuntime(runtime), true);
  assert.equal(validateQuoteOnlyUnit(unit), true);
  for (const drift of [
    "fetch(\"https://vivacrm.invalid\")", "const x = \"/payment\"", "http.request({})",
    "fs.rmSync(\"/tmp/x\")", "import(\"node:net\")", "fs[\"write\" + \"FileSync\"](\"/tmp/x\", \"x\")",
    "http[\"g\" + \"et\"](\"http://127.0.0.1\")", "process[\"bind\" + \"ing\"](\"fs\")",
  ]) assert.throws(
    () => validateQuoteOnlyRuntime(`${runtime}\n${drift}\n`),
    /forbidden capability|exact digest mismatch/,
  );
  for (const drift of [
    `${unit}User=root\n`, `${unit}IPAddressAllow=any\n`, `${unit}StandardInput=data\n`,
    `${unit}Restart=always\n`, `${unit}RuntimeMaxSec=infinity\n`, `${unit}ExecStop=/bin/true\n`,
    unit.replace("StandardInput=file:", "LoadCredential=marker:"),
  ]) assert.throws(() => validateQuoteOnlyUnit(drift), /not the exact/);
});

test("builder emits deterministic exact-source inventory and verifier rejects tampering", (t) => {
  const temporary = fs.mkdtempSync("/private/tmp/lk1-quote-only-test-");
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const readSource = (_repository, _commit, repositoryPath) => {
    if (repositoryPath.startsWith("src/subscriptions/")) return resolverBytes;
    return fs.readFileSync(path.join(ROOT, repositoryPath));
  };
  const options = {
    lkSourceCommit: LK_SOURCE,
    phAdminRepository: PH_ADMIN,
    phAdminSourceCommit: PH_SOURCE,
    identities: () => ({
      tooling: {
        head: TOOLING, originMain: LK_SOURCE, originMainMergeBase: LK_SOURCE,
        sourceOriginMergeBase: LK_SOURCE, headSourceMergeBase: LK_SOURCE,
        committedAt: "2026-09-04T12:00:00.000Z", clean: true,
      },
      phAdmin: {
        head: PH_SOURCE, originMain: PH_SOURCE, originMainMergeBase: PH_SOURCE,
        sourceOriginMergeBase: PH_SOURCE, headSourceMergeBase: PH_SOURCE,
        committedAt: "2026-09-04T12:00:00.000Z", clean: true,
      },
    }),
    commitFile: readSource,
  };
  const first = buildQuoteOnlyCandidateBundle({ ...options, outputDirectory: path.join(temporary, "one") });
  const second = buildQuoteOnlyCandidateBundle({ ...options, outputDirectory: path.join(temporary, "two") });
  assert.equal(first.manifestSha256, second.manifestSha256);
  assert.deepEqual(first.manifest.files.map((row) => row.path), [
    "payload/quote_runtime.mjs", "payload/quote_fixture.json",
    "payload/fn_managed_subscription_policy_evaluate.js", "payload/subscription-sale-period-resolver.ts",
    "payload/subscription-sale-period-resolver.mjs",
    "payload/quote_contract.json", "payload/lk1-subscription-dev-quote.service",
    "payload/verify_lk1_subscription_quote_only_candidate.mjs",
  ]);
  assert.equal(verifyQuoteOnlyCandidateBundle(first.outputDirectory, first.manifestSha256).toolingCommit, TOOLING);
  fs.chmodSync(path.join(first.outputDirectory, "payload/quote_contract.json"), 0o640);
  assert.throws(() => verifyQuoteOnlyCandidateBundle(first.outputDirectory, first.manifestSha256), /file mismatch/);
  const secondManifestPath = path.join(second.outputDirectory, "manifest.json");
  fs.chmodSync(secondManifestPath, 0o644);
  assert.throws(() => verifyQuoteOnlyCandidateBundle(second.outputDirectory, second.manifestSha256), /manifest custody/);
  fs.chmodSync(secondManifestPath, 0o600);
  const incomplete = structuredClone(second.manifest);
  delete incomplete.authority.paymentWrites;
  const incompleteBytes = Buffer.from(`${JSON.stringify(incomplete, null, 2)}\n`);
  fs.writeFileSync(secondManifestPath, incompleteBytes);
  assert.throws(
    () => verifyQuoteOnlyCandidateBundle(second.outputDirectory, hash(incompleteBytes)),
    /authority schema mismatch/,
  );
});

test("builder rejects dirty/drifted source identity and non-temporary output", () => {
  const exactIdentities = () => ({
    tooling: {
      head: TOOLING, originMain: LK_SOURCE, originMainMergeBase: LK_SOURCE,
      sourceOriginMergeBase: LK_SOURCE, headSourceMergeBase: LK_SOURCE,
      committedAt: "2026-09-04T12:00:00.000Z", clean: true,
    },
    phAdmin: {
      head: PH_SOURCE, originMain: PH_SOURCE, originMainMergeBase: PH_SOURCE,
      sourceOriginMergeBase: PH_SOURCE, headSourceMergeBase: PH_SOURCE,
      committedAt: "2026-09-04T12:00:00.000Z", clean: true,
    },
  });
  const common = {
    outputDirectory: `/private/tmp/lk1-quote-only-invalid-identity-${process.pid}`,
    lkSourceCommit: LK_SOURCE,
    phAdminRepository: PH_ADMIN,
    phAdminSourceCommit: PH_SOURCE,
    identities: () => ({
      tooling: {
        head: TOOLING, originMain: "f".repeat(40), originMainMergeBase: LK_SOURCE,
        sourceOriginMergeBase: LK_SOURCE, headSourceMergeBase: LK_SOURCE,
        committedAt: "2026-09-04T12:00:00.000Z", clean: false,
      },
      phAdmin: {
        head: PH_SOURCE, originMain: PH_SOURCE, originMainMergeBase: PH_SOURCE,
        sourceOriginMergeBase: PH_SOURCE, headSourceMergeBase: PH_SOURCE,
        committedAt: "2026-09-04T12:00:00.000Z", clean: true,
      },
    }),
    commitFile: () => Buffer.from("unused"),
  };
  assert.throws(() => buildQuoteOnlyCandidateBundle(common), /exact frozen source identities/);
  assert.throws(() => buildQuoteOnlyCandidateBundle({
    ...common,
    identities: exactIdentities,
    outputDirectory: path.join(ROOT, "local-candidate"),
  }), /new temporary directory/);
});
