import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildBootstrapBundle } from "../build_lk1_subscription_dev_bootstrap.mjs";
import {
  validateBootstrapContract,
  verifyBootstrapBundle,
} from "../verify_lk1_subscription_dev_bootstrap.mjs";
import {
  validateLockedFixtureRuntime,
} from "../lk1_subscription_dev_bootstrap/locked_fixture_runtime.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TMP_ROOT = fs.existsSync("/private/tmp") ? "/private/tmp" : os.tmpdir();
const CONTRACT_PATH = path.join(ROOT, "scripts/lk1_subscription_dev_bootstrap_contract.json");
const INSTALLER_PATH = path.join(ROOT, "scripts/install_lk1_subscription_dev_bootstrap.sh");
const COMMIT = "a".repeat(40);
const contract = () => JSON.parse(fs.readFileSync(CONTRACT_PATH, "utf8"));

function build() {
  const root = fs.mkdtempSync(path.join(TMP_ROOT, "lk1-dev-bootstrap-test-"));
  const output = path.join(root, "bundle");
  return {
    root,
    ...buildBootstrapBundle({
      outputDirectory: output,
      sourceCommit: COMMIT,
      repositoryIdentity: () => ({ head: COMMIT, clean: true }),
    }),
  };
}

test("stopped bootstrap contract pins the exact isolated target and dependencies", () => {
  const value = contract();
  assert.equal(validateBootstrapContract(value), true);
  assert.equal(value.target.unixUser, "lk1-subscription-dev");
  assert.equal(value.target.rootPath, "/srv/lk1-subscription-dev");
  assert.deepEqual(value.listeners, [
    "127.0.0.1:1882", "127.0.0.1:27030", "127.0.0.1:3037",
    "127.0.0.1:3038", "127.0.0.1:3039",
  ]);
  assert.ok(Object.values(value.postconditions).every((item) => item === false));
});

test("contract rejects shared identity, dependency drift, open listener, and expanded authority", () => {
  for (const mutate of [
    (value) => { value.target.unixUser = "root"; },
    (value) => { value.target.rootPath = "/root/.node-red"; },
    (value) => { value.dependencies.mongo.sourcePath = "/opt/phab-subscriptions-dev/mongo"; },
    (value) => { value.dependencies.nodeRed.packageJsonSha256 = "b".repeat(64); },
    (value) => { value.listeners[0] = "0.0.0.0:1880"; },
    (value) => { value.postconditions.servicesActive = true; },
  ]) {
    const value = contract();
    mutate(value);
    assert.throws(() => validateBootstrapContract(value));
  }
});

test("locked fixture source self-checks but cannot activate any role", () => {
  const selfCheck = validateLockedFixtureRuntime(["--self-check"]);
  assert.equal(selfCheck.mode, "SELF_CHECK");
  assert.deepEqual(selfCheck.roles, ["cup", "provider", "identity"]);
  for (const role of selfCheck.roles) {
    assert.throws(
      () => validateLockedFixtureRuntime(["--role", role], () => false),
      (error) => error.code === "SERVICE_START_AUTHORIZATION_ABSENT",
    );
    assert.throws(
      () => validateLockedFixtureRuntime(["--role", role], () => true),
      /BOOTSTRAP_RUNTIME_HAS_NO_ACTIVATABLE_IMPLEMENTATION/,
    );
  }
});

test("builder emits a private immutable bundle with stopped-only authority", () => {
  const result = build();
  try {
    const verified = verifyBootstrapBundle(result.outputDirectory, result.manifestSha256);
    assert.equal(verified.manifest.sourceCommit, COMMIT);
    assert.equal(verified.manifest.mutationAuthority.createIdentity, true);
    assert.equal(verified.manifest.mutationAuthority.installStoppedDependencies, true);
    assert.equal(verified.manifest.mutationAuthority.serviceStart, false);
    assert.equal(verified.manifest.mutationAuthority.ingress, false);
    assert.equal(verified.manifest.mutationAuthority.activation, false);
    assert.equal(verified.manifest.mutationAuthority.secrets, false);
    assert.equal(fs.statSync(result.outputDirectory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(result.manifestPath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(result.root, { recursive: true });
  }
});

test("bundle verification fails on manifest, file, unit, or authority tampering", () => {
  for (const mutate of [
    (result) => fs.appendFileSync(path.join(result.outputDirectory, "payload/node-red/settings.js"), "// drift\n"),
    (result) => {
      const unit = path.join(result.outputDirectory, "payload/units/lk1-subscription-dev-cup.service");
      fs.writeFileSync(unit, fs.readFileSync(unit, "utf8").replace("IPAddressDeny=any", "IPAddressDeny=none"));
    },
    (result) => {
      const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
      manifest.mutationAuthority.serviceStart = true;
      fs.writeFileSync(result.manifestPath, `${JSON.stringify(manifest)}\n`);
    },
    (result) => fs.appendFileSync(
      path.join(result.outputDirectory, "payload/provisioning-contract.json"),
      "\n",
    ),
  ]) {
    const result = build();
    try {
      mutate(result);
      assert.throws(() => verifyBootstrapBundle(result.outputDirectory, result.manifestSha256));
    } finally {
      fs.rmSync(result.root, { recursive: true });
    }
  }
});

test("builder rejects non-temp output, existing output, and ambiguous source identity", () => {
  const exactIdentity = () => ({ head: COMMIT, clean: true });
  assert.throws(() => buildBootstrapBundle({
    outputDirectory: path.join(ROOT, "bundle"), sourceCommit: COMMIT, repositoryIdentity: exactIdentity,
  }),
    /new directory under/);
  const root = fs.mkdtempSync(path.join(TMP_ROOT, "lk1-dev-bootstrap-existing-"));
  try {
    assert.throws(() => buildBootstrapBundle({
      outputDirectory: root, sourceCommit: COMMIT, repositoryIdentity: exactIdentity,
    }), /new directory under/);
    assert.throws(() => buildBootstrapBundle({
      outputDirectory: path.join(root, "bad"), sourceCommit: "main", repositoryIdentity: exactIdentity,
    }),
      /exact 40-hex/);
    assert.throws(() => buildBootstrapBundle({
      outputDirectory: path.join(root, "dirty"), sourceCommit: COMMIT,
      repositoryIdentity: () => ({ head: COMMIT, clean: false }),
    }), /exact clean builder/);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("installer has no service-start, enable, ingress, activation, secret, or shared-state mutation", () => {
  const source = fs.readFileSync(INSTALLER_PATH, "utf8");
  assert.doesNotMatch(source, /systemctl\s+(?:start|restart|enable|reenable)/);
  assert.doesNotMatch(source, /\/root\/\.node-red/);
  assert.doesNotMatch(source, /\/opt\/phab-subscriptions-dev\/mongo(?:\/|\b)/);
  assert.doesNotMatch(source, /\/etc\/nginx|clientSubscriptionId|managedProductIds|EnvironmentFile=/);
  assert.match(source, /systemctl daemon-reload/);
  assert.match(source, /Node-RED symlink escapes installed package/);
  assert.match(source, /sealed Node-RED archive drift/);
  assert.match(source, /existing target root lacks exact resumable bootstrap marker/);
  assert.match(source, /existing staging root lacks exact resumable bootstrap marker/);
  assert.match(source, /bootstrap-evidence\/dependencies/);
  assert.doesNotMatch(source, /\/usr\/bin\/jq/);
  assert.match(source, /service-start\.approved/);
  assert.match(source, /servicesActive=false/);
  assert.match(source, /listenersOpen=false/);
});
