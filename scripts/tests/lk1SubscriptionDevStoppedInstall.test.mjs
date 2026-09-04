import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { buildRuntimeInstallCandidateBundle } from "../build_lk1_subscription_dev_runtime_install_candidate.mjs";
import { launchStoppedCandidate } from "../launch_lk1_subscription_dev_stopped_candidate.mjs";
import {
  captureCurrentHostPreflightEvidence,
  checkedHostPreflightEvidence,
} from "../validate_lk1_subscription_dev_host_preflight.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TMP_ROOT = fs.existsSync("/private/tmp") ? "/private/tmp" : os.tmpdir();
const SOURCE_COMMIT = "eca4e1a17d7b2d84489fc9e8129a2eee29c8f3a0";
const TOOLING_COMMIT = "6".repeat(40);
const TOOLING_TREE = "7".repeat(40);
const NOW = new Date("2026-09-10T12:00:00.000Z");
const ATTEMPT_ID = "a".repeat(32);
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const canonical = (value) => `${JSON.stringify(value, null, 2)}\n`;
const committed = (_commit, repositoryPath) => fs.readFileSync(path.join(ROOT, repositoryPath));
const BOOTSTRAP_UNIT_HASHES = Object.freeze({
  "lk1-subscription-dev-mongo.service": "370f07b518f14d87ba78d2cdc3e3cd15714349cf664d2bf53ac95ec2125a9980",
  "lk1-subscription-dev-cup.service": "745333370a304d2d1e70add583930d73f704002c634e9eba4343dda7dca45b90",
  "lk1-subscription-dev-provider-fixture.service": "dbf8a46a002b7f478b011b2afeb2a09837d8f44ecd5873a5225a6da6a895bca5",
  "lk1-subscription-dev-identity-fixture.service": "673fa03feb87aa886d408684ca947609263929ef178d395d93480fe096488179",
  "lk1-subscription-dev-nodered.service": "75fafcae24c5aefdca545786967bed12d509d12d2555a37d94e23571732f764a",
});

const transcript = () => [
  `HOSTNAME\t${checkedHostPreflightEvidence.target.hostname}`,
  `MACHINE_ID_SHA256\t${checkedHostPreflightEvidence.target.machineIdSha256}`,
  "SYSTEMD_VERSION\t245",
  "EXECUTION_PREREQ\ttrue\ttrue",
  ...Object.entries(checkedHostPreflightEvidence.dedicatedUnits).map(([unit, state]) => (
    `UNIT\t${unit}\t${state.loadState}\t${state.activeState}\t${state.unitFileState}`
  )),
  ...Object.keys(checkedHostPreflightEvidence.dedicatedUnits).map((unit) => (
    `UNIT_ISOLATION\t${unit}\t${BOOTSTRAP_UNIT_HASHES[unit]}\ttrue\ttrue\ttrue\ttrue`
  )),
  "LISTENER\t1880\tPRESENT",
  "LISTENER\t3036\tPRESENT",
  "LISTENER\t1882\tABSENT",
  "LISTENER\t27030\tABSENT",
  "LISTENER\t3037\tABSENT",
  "LISTENER\t3038\tABSENT",
  "LISTENER\t3039\tABSENT",
  "INPUT\ttargetFlowAbsent\ttrue",
  "INPUT\tfixtureConfigAbsent\ttrue",
  "INPUT\treleaseReceiptAbsent\ttrue",
  "INPUT\tserviceStartAuthorizationAbsent\ttrue",
  "INPUT\tinstallIdentityEnvironmentAbsent\ttrue",
  "INPUT\ttlsKeyAbsent\ttrue",
  "INPUT\ttlsCertificateAbsent\ttrue",
  "INGRESS_ISOLATION\ttrue\ttrue",
  "PRODUCTION_MARKERS_ABSENT\ttrue",
  `SHARED_FLOW_SHA256\t${checkedHostPreflightEvidence.sharedResources.flowSha256}`,
  "END",
].join("\n");

function prepare() {
  const parent = fs.mkdtempSync(path.join(TMP_ROOT, "lk1-stopped-install-test-"));
  fs.chmodSync(parent, 0o700);
  const bundleDirectory = path.join(parent, "bundle");
  const built = buildRuntimeInstallCandidateBundle({
    outputDirectory: bundleDirectory,
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
  });
  const evidence = captureCurrentHostPreflightEvidence({
    runSsh: () => transcript(),
    assertPinnedHostKey: () => {},
    now: NOW,
    readRepositoryIdentity: () => ({
      headSha: TOOLING_COMMIT, treeSha: TOOLING_TREE, clean: true,
    }),
  });
  const rootPrefix = path.join(parent, "root");
  for (const directory of [
    rootPrefix,
    path.join(rootPrefix, "srv"),
    path.join(rootPrefix, "srv/lk1-subscription-dev"),
    path.join(rootPrefix, "srv/lk1-subscription-dev/fixtures"),
    path.join(rootPrefix, "srv/lk1-subscription-dev/node-red"),
    path.join(rootPrefix, "srv/lk1-subscription-dev/bootstrap-evidence"),
    path.join(rootPrefix, "etc"),
    path.join(rootPrefix, "etc/systemd"),
    path.join(rootPrefix, "etc/systemd/system"),
    path.join(rootPrefix, "run"),
    path.join(rootPrefix, "run/lock"),
  ]) {
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  }
  fs.copyFileSync(
    path.join(ROOT, "scripts/lk1_subscription_dev_bootstrap/settings.js"),
    path.join(rootPrefix, "srv/lk1-subscription-dev/node-red/settings.js"),
  );
  fs.chownSync(
    path.join(rootPrefix, "srv/lk1-subscription-dev/node-red/settings.js"),
    process.getuid(), process.getgid(),
  );
  for (const name of Object.keys(BOOTSTRAP_UNIT_HASHES)) {
    fs.copyFileSync(
      path.join(ROOT, "scripts/lk1_subscription_dev_bootstrap/units", name),
      path.join(rootPrefix, "etc/systemd/system", name),
    );
    fs.chownSync(
      path.join(rootPrefix, "etc/systemd/system", name),
      process.getuid(), process.getgid(),
    );
  }
  return { parent, rootPrefix, evidence, ...built };
}

async function loadInstaller(bundleDirectory) {
  const file = path.join(bundleDirectory, "payload/install_lk1_subscription_dev_stopped_candidate.mjs");
  return import(`${pathToFileURL(file).href}?test=${crypto.randomUUID()}`);
}

test("stopped installer atomically installs six exact files and a separate rollback restores every preimage", async () => {
  const prepared = prepare();
  try {
    const installer = await loadInstaller(prepared.outputDirectory);
    const preflightEvidenceSha256 = sha256(Buffer.from(canonical(prepared.evidence)));
    const result = installer.installStoppedCandidate({
      bundleDirectory: prepared.outputDirectory,
      expectedManifestSha256: prepared.manifestSha256,
      preflightEvidence: prepared.evidence,
      preflightEvidenceSha256,
      now: NOW,
      attemptId: ATTEMPT_ID,
      environment: "rehearsal",
      rootPrefix: prepared.rootPrefix,
      probe: ({ phase }) => ({ phase, sharedFlowSha256: checkedHostPreflightEvidence.sharedResources.flowSha256 }),
    });
    assert.equal(result.state, "INSTALLED_STOPPED");
    assert.equal(result.installedFiles.length, 6);
    assert.equal(result.daemonReloadPerformed, false);
    assert.equal(result.servicesStarted, false);
    assert.equal(result.externalWrites, false);
    for (const item of result.installedFiles) {
      const installed = path.join(prepared.rootPrefix, item.path.slice(1));
      assert.equal(sha256(fs.readFileSync(installed)), item.sha256);
    }
    const rollback = installer.rollbackStoppedCandidate({
      bundleDirectory: prepared.outputDirectory,
      expectedManifestSha256: prepared.manifestSha256,
      evidenceDirectory: path.dirname(result.evidencePath),
      environment: "rehearsal",
      rootPrefix: prepared.rootPrefix,
      probe: ({ phase }) => ({ phase }),
    });
    assert.equal(rollback.state, "ROLLED_BACK_TO_EXACT_PREIMAGE");
    assert.equal(rollback.postRollback.phase, "POSTROLLBACK");
    assert.equal(fs.existsSync(path.join(
      prepared.rootPrefix, "srv/lk1-subscription-dev/fixtures/fixture_runtime.mjs",
    )), false);
    assert.equal(fs.existsSync(path.join(
      prepared.rootPrefix, "srv/lk1-subscription-dev/node-red/flows.json",
    )), false);
    for (const [name, expected] of Object.entries(BOOTSTRAP_UNIT_HASHES)) {
      const restored = path.join(prepared.rootPrefix, "etc/systemd/system", name);
      assert.equal(sha256(fs.readFileSync(restored)), expected);
      const stat = fs.statSync(restored);
      assert.equal(stat.uid, process.getuid());
      assert.equal(stat.gid, process.getgid());
      assert.equal(stat.mode & 0o777, 0o644);
    }
    assert.equal(fs.existsSync(result.evidencePath), true);
    assert.equal(fs.existsSync(rollback.evidencePath), true);
  } finally {
    fs.rmSync(prepared.parent, { recursive: true });
  }
});

test("trusted out-of-bundle launcher verifies custody and hashes before locked execution", () => {
  const prepared = prepare();
  try {
    let invocation;
    const argv = [
      "--mode", "install",
      "--bundle", prepared.outputDirectory,
      "--manifest-sha256", prepared.manifestSha256,
      "--preflight-evidence", "/private/tmp/evidence.json",
      "--preflight-sha256", "b".repeat(64),
      "--attempt-id", ATTEMPT_ID,
    ];
    assert.equal(launchStoppedCandidate({
      argv,
      environment: "rehearsal",
      expectedUid: process.getuid(),
      runLocked: (runtime, installerPath, forwardedArgs) => {
        invocation = { runtime, installerPath, forwardedArgs };
      },
    }), true);
    assert.equal(invocation.forwardedArgs, argv);
    assert.equal(path.dirname(invocation.installerPath), path.join(prepared.outputDirectory, "payload"));
    fs.chmodSync(invocation.installerPath, 0o750);
    fs.appendFileSync(invocation.installerPath, "\n");
    fs.chmodSync(invocation.installerPath, 0o550);
    assert.throws(() => launchStoppedCandidate({
      argv,
      environment: "rehearsal",
      expectedUid: process.getuid(),
      runLocked: () => assert.fail("tampered installer must not execute"),
    }), /payload drift/);
  } finally {
    fs.rmSync(prepared.parent, { recursive: true });
  }
});

test("dangling target and metadata drift fail before any target mutation", async () => {
  for (const scenario of ["dangling", "metadata"]) {
    const prepared = prepare();
    try {
      const installer = await loadInstaller(prepared.outputDirectory);
      const targetFlow = path.join(
        prepared.rootPrefix, "srv/lk1-subscription-dev/node-red/flows.json",
      );
      if (scenario === "dangling") fs.symlinkSync("/missing-lk1-target", targetFlow);
      else fs.chmodSync(path.join(
        prepared.rootPrefix, "etc/systemd/system/lk1-subscription-dev-cup.service",
      ), 0o600);
      assert.throws(() => installer.installStoppedCandidate({
        bundleDirectory: prepared.outputDirectory,
        expectedManifestSha256: prepared.manifestSha256,
        preflightEvidence: prepared.evidence,
        preflightEvidenceSha256: sha256(Buffer.from(canonical(prepared.evidence))),
        now: NOW,
        attemptId: ATTEMPT_ID,
        environment: "rehearsal",
        rootPrefix: prepared.rootPrefix,
        probe: () => ({}),
      }), /preimage|custody/);
      if (scenario === "dangling") assert.equal(fs.lstatSync(targetFlow).isSymbolicLink(), true);
      assert.equal(fs.existsSync(path.join(
        prepared.rootPrefix, "srv/lk1-subscription-dev/fixtures/fixture_runtime.mjs",
      )), false);
    } finally {
      fs.rmSync(prepared.parent, { recursive: true });
    }
  }
});

test("manual rollback refuses a failed stopped-state precheck without changing targets", async () => {
  const prepared = prepare();
  try {
    const installer = await loadInstaller(prepared.outputDirectory);
    const result = installer.installStoppedCandidate({
      bundleDirectory: prepared.outputDirectory,
      expectedManifestSha256: prepared.manifestSha256,
      preflightEvidence: prepared.evidence,
      preflightEvidenceSha256: sha256(Buffer.from(canonical(prepared.evidence))),
      now: NOW,
      attemptId: ATTEMPT_ID,
      environment: "rehearsal",
      rootPrefix: prepared.rootPrefix,
      probe: () => ({}),
    });
    const installedFlow = path.join(
      prepared.rootPrefix, "srv/lk1-subscription-dev/node-red/flows.json",
    );
    const before = sha256(fs.readFileSync(installedFlow));
    assert.throws(() => installer.rollbackStoppedCandidate({
      bundleDirectory: prepared.outputDirectory,
      expectedManifestSha256: prepared.manifestSha256,
      evidenceDirectory: path.dirname(result.evidencePath),
      environment: "rehearsal",
      rootPrefix: prepared.rootPrefix,
      probe: ({ phase }) => {
        if (phase === "PRE_ROLLBACK") throw new Error("synthetic active unit");
        return {};
      },
    }), /active unit/);
    assert.equal(sha256(fs.readFileSync(installedFlow)), before);
  } finally {
    fs.rmSync(prepared.parent, { recursive: true });
  }
});

test("manual rollback rejects tampered preimage records without changing installed files", async () => {
  const prepared = prepare();
  try {
    const installer = await loadInstaller(prepared.outputDirectory);
    const result = installer.installStoppedCandidate({
      bundleDirectory: prepared.outputDirectory,
      expectedManifestSha256: prepared.manifestSha256,
      preflightEvidence: prepared.evidence,
      preflightEvidenceSha256: sha256(Buffer.from(canonical(prepared.evidence))),
      now: NOW,
      attemptId: ATTEMPT_ID,
      environment: "rehearsal",
      rootPrefix: prepared.rootPrefix,
      probe: () => ({}),
    });
    const installedFlow = path.join(
      prepared.rootPrefix, "srv/lk1-subscription-dev/node-red/flows.json",
    );
    const installedSha256 = sha256(fs.readFileSync(installedFlow));
    const evidenceDirectory = path.dirname(result.evidencePath);
    const preimagePath = path.join(evidenceDirectory, "preimage.json");
    const preimage = JSON.parse(fs.readFileSync(preimagePath, "utf8"));
    preimage.records[0].sourceSha256 = "0".repeat(64);
    fs.writeFileSync(preimagePath, canonical(preimage), { mode: 0o600 });
    assert.throws(() => installer.rollbackStoppedCandidate({
      bundleDirectory: prepared.outputDirectory,
      expectedManifestSha256: prepared.manifestSha256,
      evidenceDirectory,
      environment: "rehearsal",
      rootPrefix: prepared.rootPrefix,
      probe: () => ({}),
    }), /record binding mismatch/);
    assert.equal(sha256(fs.readFileSync(installedFlow)), installedSha256);
  } finally {
    fs.rmSync(prepared.parent, { recursive: true });
  }
});

test("install failure automatically restores exact preimages and preserves failure evidence", async () => {
  const prepared = prepare();
  try {
    const installer = await loadInstaller(prepared.outputDirectory);
    let probes = 0;
    assert.throws(() => installer.installStoppedCandidate({
      bundleDirectory: prepared.outputDirectory,
      expectedManifestSha256: prepared.manifestSha256,
      preflightEvidence: prepared.evidence,
      preflightEvidenceSha256: sha256(Buffer.from(canonical(prepared.evidence))),
      now: NOW,
      attemptId: ATTEMPT_ID,
      environment: "rehearsal",
      rootPrefix: prepared.rootPrefix,
      probe: () => {
        probes += 1;
        if (probes === 2) throw new Error("synthetic postcheck failure");
        return {};
      },
    }), /synthetic postcheck failure/);
    assert.equal(fs.existsSync(path.join(
      prepared.rootPrefix, "srv/lk1-subscription-dev/node-red/flows.json",
    )), false);
    const evidenceDirectory = path.join(
      prepared.rootPrefix,
      "srv/lk1-subscription-dev/bootstrap-evidence/stopped-install",
      prepared.manifestSha256,
      ATTEMPT_ID,
    );
    assert.equal(JSON.parse(fs.readFileSync(
      path.join(evidenceDirectory, "failure.json"), "utf8",
    )).state, "AUTO_ROLLED_BACK");
    const retry = installer.installStoppedCandidate({
      bundleDirectory: prepared.outputDirectory,
      expectedManifestSha256: prepared.manifestSha256,
      preflightEvidence: prepared.evidence,
      preflightEvidenceSha256: sha256(Buffer.from(canonical(prepared.evidence))),
      now: NOW,
      attemptId: "b".repeat(32),
      environment: "rehearsal",
      rootPrefix: prepared.rootPrefix,
      probe: () => ({}),
    });
    assert.equal(retry.state, "INSTALLED_STOPPED");
    assert.equal(retry.attemptId, "b".repeat(32));
  } finally {
    fs.rmSync(prepared.parent, { recursive: true });
  }
});

test("automatic rollback records an incomplete state when its stopped-state postcheck fails", async () => {
  const prepared = prepare();
  try {
    const installer = await loadInstaller(prepared.outputDirectory);
    assert.throws(() => installer.installStoppedCandidate({
      bundleDirectory: prepared.outputDirectory,
      expectedManifestSha256: prepared.manifestSha256,
      preflightEvidence: prepared.evidence,
      preflightEvidenceSha256: sha256(Buffer.from(canonical(prepared.evidence))),
      now: NOW,
      attemptId: ATTEMPT_ID,
      environment: "rehearsal",
      rootPrefix: prepared.rootPrefix,
      probe: ({ phase }) => {
        if (phase !== "PREINSTALL") throw new Error(`synthetic ${phase} failure`);
        return {};
      },
    }), /automatic rollback did not pass/);
    const failure = JSON.parse(fs.readFileSync(path.join(
      prepared.rootPrefix,
      "srv/lk1-subscription-dev/bootstrap-evidence/stopped-install",
      prepared.manifestSha256,
      ATTEMPT_ID,
      "failure.json",
    ), "utf8"));
    assert.equal(failure.state, "AUTO_ROLLBACK_INCOMPLETE");
    assert.match(failure.rollbackError, /POST_AUTO_ROLLBACK/);
    const evidenceDirectory = path.dirname(path.join(
      prepared.rootPrefix,
      "srv/lk1-subscription-dev/bootstrap-evidence/stopped-install",
      prepared.manifestSha256,
      ATTEMPT_ID,
      "failure.json",
    ));
    const recovery = installer.recoverIncompleteStoppedCandidate({
      bundleDirectory: prepared.outputDirectory,
      expectedManifestSha256: prepared.manifestSha256,
      evidenceDirectory,
      environment: "rehearsal",
      rootPrefix: prepared.rootPrefix,
      probe: ({ phase }) => ({ phase }),
    });
    assert.equal(recovery.state, "RECOVERED_TO_EXACT_PREIMAGE");
    assert.equal(recovery.restoredTargets, 6);
  } finally {
    fs.rmSync(prepared.parent, { recursive: true });
  }
});

test("stopped installer rejects stale evidence, preimage drift, and missing production authority", async () => {
  for (const scenario of ["stale", "preimage", "authority"]) {
    const prepared = prepare();
    try {
      const installer = await loadInstaller(prepared.outputDirectory);
      if (scenario === "preimage") fs.appendFileSync(
        path.join(prepared.rootPrefix, "etc/systemd/system/lk1-subscription-dev-cup.service"),
        "\n",
      );
      const options = {
        bundleDirectory: prepared.outputDirectory,
        expectedManifestSha256: prepared.manifestSha256,
        preflightEvidence: prepared.evidence,
        preflightEvidenceSha256: sha256(Buffer.from(canonical(prepared.evidence))),
        now: scenario === "stale" ? new Date(NOW.getTime() + 3600_001) : NOW,
        attemptId: ATTEMPT_ID,
        environment: scenario === "authority" ? "production" : "rehearsal",
        rootPrefix: scenario === "authority" ? "" : prepared.rootPrefix,
        currentUid: scenario === "authority" ? 501 : process.getuid(),
        targetGid: process.getgid(),
        hostname: HOSTNAME,
        confirmation: undefined,
        probe: () => ({}),
      };
      assert.throws(() => installer.installStoppedCandidate(options));
    } finally {
      fs.rmSync(prepared.parent, { recursive: true });
    }
  }
});

const HOSTNAME = "89-108-64-209.cloudvps.regruhosting.ru";
