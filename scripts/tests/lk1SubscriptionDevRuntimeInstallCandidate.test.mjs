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
  validateInstallCandidateUnit,
  validateNodeRedSettings,
  validateRuntimeInstallContract,
  verifyRuntimeInstallCandidateBundle,
} from "../verify_lk1_subscription_dev_runtime_install_candidate.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CONTRACT_PATH = path.join(ROOT, "scripts/lk1_subscription_dev_runtime_install_contract.json");
const UNIT_ROOT = path.join(ROOT, "scripts/lk1_subscription_dev_runtime_install/units");
const TMP_ROOT = fs.existsSync("/private/tmp") ? "/private/tmp" : os.tmpdir();
const SOURCE_COMMIT = "28bc541bb1f4b0c421d91a66afb3cfce932d5356";
const TOOLING_COMMIT = "6".repeat(40);
const NOW = new Date("2026-09-10T12:00:00.000Z");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));
const committed = (_commit, repositoryPath) => fs.readFileSync(path.join(ROOT, repositoryPath));

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
        head: TOOLING_COMMIT, originMain: SOURCE_COMMIT, mergeBase: SOURCE_COMMIT, clean: true,
      }),
      commitFile: committed,
    }),
  };
}

test("install contract resolves marker custody through systemd credentials without execution authority", () => {
  const contract = readJson(CONTRACT_PATH);
  assert.equal(validateRuntimeInstallContract(contract), true);
  assert.equal(contract.authorizationCustody.sourceDirectoryOwner, "root:root");
  assert.equal(contract.authorizationCustody.sourceDirectoryMode, "0700");
  assert.equal(contract.authorizationCustody.transport, "SYSTEMD_LOAD_CREDENTIAL");
  assert.equal(contract.authorizationCustody.hostSupportVerified, false);
    assert.equal(contract.candidateContents.installExecutor, "NOT_INCLUDED");
    assert.equal(contract.candidateContents.nodeRedFlow, "GENERATED_EXACT_SOURCE_CANDIDATE");
  assert.equal(contract.candidateContents.installedIdentityEnvironmentFile, "NOT_INCLUDED");
  assert.equal(contract.runtimeCapabilityDisclosure.nodeRedExposure, "DORMANT_WRITE_CAPABLE_SOURCE_GRAPH");
  assert.deepEqual(contract.runtimeCapabilityDisclosure.mongoOperations, ["find", "insertOne", "updateOne"]);
  assert.equal(contract.runtimeCapabilityDisclosure.positiveUat, "NOT_AUTHORIZED");
  assert.equal(contract.authority.bundleBuildAllowed, true);
  assert.equal(
    Object.entries(contract.authority).every(([key, value]) => key === "bundleBuildAllowed" || value === false),
    true,
  );
  assert.equal(Object.values(contract.intendedStoppedPostconditions).every((value) => value === false), true);
});

test("install contract rejects marker, support, postcondition, contents, and authority drift", () => {
  const baseline = readJson(CONTRACT_PATH);
  for (const mutate of [
    (value) => { value.environment = "PROD"; },
    (value) => { value.target.unixUser = "root"; },
    (value) => { value.authorizationCustody.sourceDirectoryMode = "0750"; },
    (value) => { value.authorizationCustody.transport = "DIRECT_FILE_READ"; },
    (value) => { value.authorizationCustody.hostSupportVerified = true; },
    (value) => { value.credentialBinding.requiresUnexpiredCredential = false; },
    (value) => { value.prerequisites.freshHostReadbackRequired = false; },
    (value) => { value.candidateContents.installExecutor = "INCLUDED"; },
    (value) => { value.runtimeCapabilityDisclosure.positiveUat = "AUTHORIZED"; },
    (value) => { value.runtimeCapabilityDisclosure.mongoOperations = ["find"]; },
    (value) => { value.intendedStoppedPostconditions.servicesActive = true; },
    (value) => { value.authority.hostInstallAllowed = true; },
  ]) {
    const changed = clone(baseline);
    mutate(changed);
    assert.throws(() => validateRuntimeInstallContract(changed));
  }
});

test("unit candidates use exact root-to-service credential transport and remain unstartable", () => {
  for (const name of Object.keys(UNIT_SHA256)) {
    const source = fs.readFileSync(path.join(UNIT_ROOT, name), "utf8");
    assert.equal(validateInstallCandidateUnit(name, source), true);
    assert.match(source, /LoadCredential=service-start\.approved:/);
    assert.match(source, /RefuseManualStart=yes/);
    assert.doesNotMatch(source, /\[Install\]|WantedBy=|systemctl|ExecStartPre=|ExecStartPost=/);
  }
  const nodeRed = fs.readFileSync(path.join(UNIT_ROOT, "lk1-subscription-dev-nodered.service"), "utf8");
  assert.match(nodeRed, /ReadOnlyPaths=.*flows\.json.*release-identity\.json.*settings\.js/);
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
    [cupName, cup.replace("LoadCredential=", "# LoadCredential=")],
    [cupName, cup.replace("--role cup", "--role provider")],
    [cupName, `${cup}\n[Install]\nWantedBy=multi-user.target\n`],
    [cupName, cup.replace("Restart=no", "Restart=no\nExecStartPost=/bin/true")],
    [nodeName, nodeRed.replace(/^ReadOnlyPaths=.*$/m, "")],
    [nodeName, nodeRed.replace(/^ExecCondition=.*$/m, "")],
  ]) {
    assert.throws(() => validateInstallCandidateUnit(name, source));
  }
});

test("builder emits a self-contained immutable candidate with no installer, config, receipt, or credential", () => {
  const result = build();
  try {
    const verified = verifyRuntimeInstallCandidateBundle(result.outputDirectory, result.manifestSha256);
    assert.equal(verified.manifest.sourceCommit, SOURCE_COMMIT);
    assert.equal(verified.manifest.toolingCommit, TOOLING_COMMIT);
    assert.equal(verified.receiptTemplate.state, "SOURCE_ONLY");
    assert.equal(verified.sourceCandidateManifest.hostPreimage.state, "ABSENT");
    assert.equal(verified.manifest.stage, "LOCAL_INSTALL_CANDIDATE");
    assert.equal(Object.values(verified.manifest.authority).every((value) => value === false), true);
    assert.equal(fs.statSync(result.outputDirectory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(result.outputDirectory, "manifest.json")).mode & 0o777, 0o600);
    assert.equal(EXPECTED_FILES.some((file) => /install(?:er|\.sh|\.mjs$)/i.test(file)), false);
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
    head: TOOLING_COMMIT, originMain: SOURCE_COMMIT, mergeBase: SOURCE_COMMIT, clean: true,
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
        head: TOOLING_COMMIT, originMain: "7".repeat(40), mergeBase: SOURCE_COMMIT, clean: true,
      }),
      commitFile: committed,
    }), /exact origin\/main ancestry/);
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
