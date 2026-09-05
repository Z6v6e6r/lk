import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { buildRuntimeInstallCandidateBundle } from "../build_lk1_subscription_dev_runtime_install_candidate.mjs";
import {
  EXPECTED_FILES,
  UNIT_SHA256,
  assertRuntimeInstallCandidateLocation,
  validateInstallCandidateUnit,
  validateNodeRedSettings,
  validateRuntimeInstallContract,
  verifyRuntimeInstallCandidateBundle,
} from "../verify_lk1_subscription_dev_runtime_install_candidate.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CONTRACT_PATH = path.join(ROOT, "scripts/lk1_subscription_dev_runtime_install_contract.json");
const UNIT_ROOT = path.join(ROOT, "scripts/lk1_subscription_dev_runtime_install/units");
const TMP_ROOT = fs.existsSync("/private/tmp") ? "/private/tmp" : os.tmpdir();
const SOURCE_COMMIT = "eca4e1a17d7b2d84489fc9e8129a2eee29c8f3a0";
const TOOLING_COMMIT = "6".repeat(40);
const TOOLING_TREE = "7".repeat(40);
const NOW = new Date("2026-09-10T12:00:00.000Z");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));
const committed = (_commit, repositoryPath) => fs.readFileSync(path.join(ROOT, repositoryPath));

test("candidate location policy accepts only local temp or exact manifest-bound production root", () => {
  const manifestSha256 = "a".repeat(64);
  assert.equal(assertRuntimeInstallCandidateLocation(
    "/private/tmp/local/bundle", manifestSha256, "local",
  ), true);
  assert.equal(assertRuntimeInstallCandidateLocation(
    `/srv/lk1-subscription-dev/.stopped-install-${manifestSha256}/bundle`,
    manifestSha256,
    "production",
  ), true);
  assert.throws(() => assertRuntimeInstallCandidateLocation(
    `/srv/lk1-subscription-dev/.stopped-install-${"b".repeat(64)}/bundle`,
    manifestSha256,
    "production",
  ), /production path mismatch/);
  assert.throws(() => assertRuntimeInstallCandidateLocation(
    "/srv/lk1-subscription-dev/arbitrary/bundle", manifestSha256, "production",
  ), /production path mismatch/);
});

test("production verifier accepts the exact manifest-bound root and rejects an arbitrary srv path", {
  skip: process.platform !== "linux" || process.getuid() !== 0
    || fs.existsSync("/srv/lk1-subscription-dev"),
}, () => {
  const result = build();
  const serviceRoot = "/srv/lk1-subscription-dev";
  const candidateParent = path.join(serviceRoot, `.stopped-install-${result.manifestSha256}`);
  const productionBundle = path.join(candidateParent, "bundle");
  try {
    fs.mkdirSync(serviceRoot, { recursive: true, mode: 0o755 });
    fs.chmodSync(serviceRoot, 0o755);
    fs.mkdirSync(candidateParent, { mode: 0o700 });
    fs.cpSync(result.outputDirectory, productionBundle, { recursive: true });
    const privatizeDirectories = (directory) => {
      fs.chmodSync(directory, 0o700);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) privatizeDirectories(path.join(directory, entry.name));
      }
    };
    privatizeDirectories(productionBundle);
    assert.equal(verifyRuntimeInstallCandidateBundle(
      productionBundle,
      result.manifestSha256,
      { location: "production" },
    ).manifestSha256, result.manifestSha256);
    assert.throws(() => verifyRuntimeInstallCandidateBundle(
      productionBundle,
      "b".repeat(64),
      { location: "production" },
    ), /production path mismatch/);
  } finally {
    fs.rmSync(candidateParent, { recursive: true, force: true });
    fs.rmdirSync(serviceRoot);
    fs.rmSync(result.parent, { recursive: true });
  }
});

function build() {
  const parent = fs.mkdtempSync(path.join(TMP_ROOT, "lk1-runtime-install-candidate-test-"));
  const output = path.join(parent, "bundle");
  return {
    parent,
    ...buildRuntimeInstallCandidateBundle({
      outputDirectory: output,
      sourceCommit: SOURCE_COMMIT,
      now: NOW,
      repositoryIdentity: () => ({
        head: TOOLING_COMMIT,
        tree: TOOLING_TREE,
        originMain: TOOLING_COMMIT,
        headOriginMergeBase: TOOLING_COMMIT,
        sourceOriginMergeBase: SOURCE_COMMIT,
        clean: true,
      }),
      commitFile: committed,
    }),
  };
}

test("install contract resolves marker custody and grants only stopped-install execution authority", () => {
  const contract = readJson(CONTRACT_PATH);
  assert.equal(validateRuntimeInstallContract(contract), true);
  assert.equal(contract.authorizationCustody.sourceDirectoryOwner, "root:lk1-subscription-dev");
  assert.equal(contract.authorizationCustody.sourceDirectoryMode, "0750");
  assert.equal(contract.authorizationCustody.transport, "ROOT_OWNED_GROUP_READ_ONLY_FILE");
  assert.equal(contract.authorizationCustody.authorizationTransportHostSupportVerified, true);
  assert.equal(contract.candidateContents.installExecutor, "INCLUDED_STOPPED_ONLY");
  assert.equal(contract.candidateContents.rollbackExecutor, "INCLUDED_SEPARATELY_AUTHORIZED");
    assert.equal(contract.candidateContents.nodeRedFlow, "GENERATED_EXACT_SOURCE_CANDIDATE");
  assert.equal(contract.candidateContents.installedIdentityEnvironmentFile, "NOT_INCLUDED");
  assert.equal(contract.runtimeCapabilityDisclosure.nodeRedExposure, "DORMANT_WRITE_CAPABLE_SOURCE_GRAPH");
  assert.deepEqual(contract.runtimeCapabilityDisclosure.mongoOperations, ["find", "insertOne", "updateOne"]);
  assert.equal(contract.runtimeCapabilityDisclosure.positiveUat, "NOT_AUTHORIZED");
  assert.equal(contract.authority.bundleBuildAllowed, true);
  assert.equal(contract.authority.hostReadAllowed, true);
  assert.equal(contract.authority.hostInstallAllowed, true);
  assert.equal(
    Object.entries(contract.authority).every(([key, value]) => (
      ["bundleBuildAllowed", "hostReadAllowed", "hostInstallAllowed"].includes(key) || value === false
    )),
    true,
  );
  assert.equal(contract.intendedStoppedPostconditions.payloadInstalled, true);
  assert.equal(contract.intendedStoppedPostconditions.preimagePreserved, true);
  assert.equal(contract.intendedStoppedPostconditions.installEvidenceCreated, true);
  assert.equal(contract.intendedStoppedPostconditions.servicesActive, false);
});

test("install contract rejects marker, support, postcondition, contents, and authority drift", () => {
  const baseline = readJson(CONTRACT_PATH);
  for (const mutate of [
    (value) => { value.environment = "PROD"; },
    (value) => { value.target.unixUser = "root"; },
    (value) => { value.authorizationCustody.sourceDirectoryMode = "0770"; },
    (value) => { value.authorizationCustody.transport = "DIRECT_FILE_READ"; },
    (value) => { value.authorizationCustody.authorizationTransportHostSupportVerified = false; },
    (value) => { value.credentialBinding.requiresUnexpiredCredential = false; },
    (value) => { value.prerequisites.freshHostReadbackRequired = false; },
    (value) => { value.candidateContents.installExecutor = "NOT_INCLUDED"; },
    (value) => { value.runtimeCapabilityDisclosure.positiveUat = "AUTHORIZED"; },
    (value) => { value.runtimeCapabilityDisclosure.mongoOperations = ["find"]; },
    (value) => { value.intendedStoppedPostconditions.servicesActive = true; },
    (value) => { value.authority.daemonReloadAllowed = true; },
  ]) {
    const changed = clone(baseline);
    mutate(changed);
    assert.throws(() => validateRuntimeInstallContract(changed));
  }
});

test("unit candidates use exact root-owned authorization path and remain unstartable", () => {
  for (const name of Object.keys(UNIT_SHA256)) {
    const source = fs.readFileSync(path.join(UNIT_ROOT, name), "utf8");
    assert.equal(validateInstallCandidateUnit(name, source), true);
    assert.match(source, /LK1_SUBSCRIPTION_DEV_START_AUTHORIZATION_FILE=\/srv\/lk1-subscription-dev\/authorization\/service-start\.approved/);
    assert.match(source, /RefuseManualStart=yes/);
    assert.doesNotMatch(source, /\[Install\]|WantedBy=|systemctl|ExecStartPre=|ExecStartPost=/);
  }
  const nodeRed = fs.readFileSync(path.join(UNIT_ROOT, "lk1-subscription-dev-nodered.service"), "utf8");
  assert.match(nodeRed, /ReadOnlyPaths=.*flows\.json.*release-identity\.json.*settings\.js/);
  assert.match(nodeRed, /NODE_EXTRA_CA_CERTS=\/srv\/lk1-subscription-dev\/tls\/server\.crt/);
  assert.match(
    nodeRed,
    /ExecCondition=.*fixture_runtime\.mjs --validate-start-authorization --role nodered/,
  );
});

test("candidate includes exact loopback-only editor-locked Node-RED settings", () => {
  const source = fs.readFileSync(
    path.join(ROOT, "scripts/lk1_subscription_dev_bootstrap/settings.js"),
    "utf8",
  );
  assert.equal(validateNodeRedSettings(source), true);
  for (const changed of [
    source.replace('uiHost: "127.0.0.1"', 'uiHost: "0.0.0.0"'),
    source.replace("disableEditor: true", "disableEditor: false"),
    source.replace("autoInstall: false", "autoInstall: true"),
  ]) assert.throws(() => validateNodeRedSettings(changed));
});

test("unit validator rejects credential bypass, role drift, start hooks, enablement, and writable receipt drift", () => {
  const cupName = "lk1-subscription-dev-cup.service";
  const cup = fs.readFileSync(path.join(UNIT_ROOT, cupName), "utf8");
  const nodeName = "lk1-subscription-dev-nodered.service";
  const nodeRed = fs.readFileSync(path.join(UNIT_ROOT, nodeName), "utf8");
  for (const [name, source] of [
    [cupName, cup.replace("Environment=LK1_SUBSCRIPTION_DEV_START_AUTHORIZATION_FILE=", "# Environment=LK1_SUBSCRIPTION_DEV_START_AUTHORIZATION_FILE=")],
    [cupName, cup.replace("--role cup", "--role provider")],
    [cupName, `${cup}\n[Install]\nWantedBy=multi-user.target\n`],
    [cupName, cup.replace("Restart=no", "Restart=no\nExecStartPost=/bin/true")],
    [nodeName, nodeRed.replace(/^ReadOnlyPaths=.*$/m, "")],
    [nodeName, nodeRed.replace(/^ExecCondition=.*$/m, "")],
  ]) {
    assert.throws(() => validateInstallCandidateUnit(name, source));
  }
});

test("builder emits a self-contained immutable stopped-install candidate without config, receipt, or credential", () => {
  const result = build();
  try {
    const verified = verifyRuntimeInstallCandidateBundle(result.outputDirectory, result.manifestSha256);
    assert.equal(verified.manifest.sourceCommit, SOURCE_COMMIT);
    assert.equal(verified.manifest.toolingCommit, TOOLING_COMMIT);
    assert.equal(verified.receiptTemplate.state, "SOURCE_ONLY");
    assert.equal(verified.sourceCandidateManifest.hostPreimage.state, "ABSENT");
    assert.equal(verified.manifest.stage, "STOPPED_INSTALL_CANDIDATE");
    assert.equal(verified.manifest.toolingTreeSha, TOOLING_TREE);
    assert.equal(verified.manifest.authority.hostRead, true);
    assert.equal(verified.manifest.authority.hostInstall, true);
    assert.equal(verified.manifest.authority.daemonReload, false);
    assert.equal(fs.statSync(result.outputDirectory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(result.outputDirectory, "manifest.json")).mode & 0o777, 0o600);
    assert.equal(EXPECTED_FILES.includes("payload/install_lk1_subscription_dev_stopped_candidate.mjs"), true);
    assert.equal(EXPECTED_FILES.some((file) => /fixture\.json|release-identity|service-start\.approved/.test(file)), false);
    const bundledVerifier = path.join(
      result.outputDirectory,
      "payload/verify_lk1_subscription_dev_runtime_install_candidate.mjs",
    );
    const output = execFileSync(process.execPath, [bundledVerifier, "--bundle", result.outputDirectory], {
      encoding: "utf8",
      env: {
        ...process.env,
        LK1_RUNTIME_INSTALL_CANDIDATE_MANIFEST_SHA256: result.manifestSha256,
      },
    });
    assert.match(output, /LK1_DEV_RUNTIME_INSTALL_CANDIDATE=VERIFIED/);
  } finally {
    fs.rmSync(result.parent, { recursive: true });
  }
});

test("bundle verifier rejects manifest mode, payload, unit, symlink, and unexpected executor drift", () => {
  for (const mutate of [
    (result) => fs.chmodSync(path.join(result.outputDirectory, "manifest.json"), 0o644),
    (result) => {
      const file = path.join(result.outputDirectory, "payload/runtime-install-contract.json");
      fs.chmodSync(file, 0o700);
    },
    (result) => fs.appendFileSync(
      path.join(result.outputDirectory, "payload/units/lk1-subscription-dev-cup.service"),
      "\n",
    ),
    (result) => fs.writeFileSync(path.join(result.outputDirectory, "payload/install.sh"), "#!/bin/sh\n"),
    (result) => fs.symlinkSync(
      path.join(result.outputDirectory, "manifest.json"),
      path.join(result.outputDirectory, "payload/manifest-link"),
    ),
  ]) {
    const result = build();
    try {
      mutate(result);
      assert.throws(() => verifyRuntimeInstallCandidateBundle(
        result.outputDirectory,
        result.manifestSha256,
      ));
    } finally {
      fs.rmSync(result.parent, { recursive: true });
    }
  }
});

test("builder rejects dirty or divergent ancestry, blobs, and non-new output", () => {
  const exact = () => ({
    head: TOOLING_COMMIT,
    tree: TOOLING_TREE,
    originMain: TOOLING_COMMIT,
    headOriginMergeBase: TOOLING_COMMIT,
    sourceOriginMergeBase: SOURCE_COMMIT,
    clean: true,
  });
  assert.throws(() => buildRuntimeInstallCandidateBundle({
    outputDirectory: path.join(ROOT, "candidate"),
    sourceCommit: SOURCE_COMMIT,
    repositoryIdentity: exact,
    commitFile: committed,
  }), /new temporary/);
  const parent = fs.mkdtempSync(path.join(TMP_ROOT, "lk1-runtime-install-candidate-reject-"));
  try {
    assert.throws(() => buildRuntimeInstallCandidateBundle({
      outputDirectory: parent,
      sourceCommit: SOURCE_COMMIT,
      repositoryIdentity: exact,
      commitFile: committed,
    }), /new temporary/);
    assert.throws(() => buildRuntimeInstallCandidateBundle({
      outputDirectory: path.join(parent, "dirty"),
      sourceCommit: SOURCE_COMMIT,
      repositoryIdentity: () => ({ head: TOOLING_COMMIT, clean: false }),
      commitFile: committed,
    }), /clean tooling HEAD/);
    assert.throws(() => buildRuntimeInstallCandidateBundle({
      outputDirectory: path.join(parent, "wrong-ancestry"),
      sourceCommit: SOURCE_COMMIT,
      repositoryIdentity: () => ({
        head: TOOLING_COMMIT,
        tree: TOOLING_TREE,
        originMain: "7".repeat(40),
        headOriginMergeBase: TOOLING_COMMIT,
        sourceOriginMergeBase: SOURCE_COMMIT,
        clean: true,
      }),
      commitFile: committed,
    }), /containing current origin\/main/);
    assert.throws(() => buildRuntimeInstallCandidateBundle({
      outputDirectory: path.join(parent, "wrong-source-ancestry"),
      sourceCommit: SOURCE_COMMIT,
      repositoryIdentity: () => ({
        head: TOOLING_COMMIT,
        tree: TOOLING_TREE,
        originMain: TOOLING_COMMIT,
        headOriginMergeBase: TOOLING_COMMIT,
        sourceOriginMergeBase: "7".repeat(40),
        clean: true,
      }),
      commitFile: committed,
    }), /frozen source base/);
    assert.throws(() => buildRuntimeInstallCandidateBundle({
      outputDirectory: path.join(parent, "divergent"),
      sourceCommit: SOURCE_COMMIT,
      repositoryIdentity: exact,
      commitFile: () => Buffer.from("divergent"),
    }), /do not belong to tooling HEAD|exact-main source blob/);
  } finally {
    fs.rmSync(parent, { recursive: true });
  }
});
