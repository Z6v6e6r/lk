import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  buildLegacyGameCommandProductionRelease,
  readGitBlob,
} from "../build_legacy_game_command_production_release.mjs";
import {
  prepareLegacyGameCommandReleaseInstall,
  verifyLegacyGameCommandReleaseBundle,
  verifySealedRelease,
} from "../install_legacy_game_command_production_release.mjs";
import { canonicalJson, parseCanonicalJson } from "../lib/legacy_game_command_production_approval.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();

function makeTempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "legacy-command-release-test-")));
  t.after(() => {
    const makeWritable = (directory) => {
      if (!fs.existsSync(directory)) return;
      const stat = fs.lstatSync(directory);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        fs.chmodSync(directory, 0o700);
        for (const entry of fs.readdirSync(directory)) makeWritable(path.join(directory, entry));
      } else if (!stat.isSymbolicLink()) fs.chmodSync(directory, 0o600);
    };
    makeWritable(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function buildFixture(t) {
  const root = makeTempRoot(t);
  const bundle = path.join(root, "bundle");
  const manifest = buildLegacyGameCommandProductionRelease({
    outDir: bundle,
  });
  const verified = verifyLegacyGameCommandReleaseBundle(bundle);
  return { root, bundle, manifest, manifestSha256: verified.manifestSha256 };
}

test("release builder packages the exact runner sources and MongoDB runtime closure", (t) => {
  const { bundle, manifest } = buildFixture(t);
  const verified = verifyLegacyGameCommandReleaseBundle(bundle);
  assert.equal(verified.manifest.repositoryCommit, commit);
  assert.equal(manifest.source.liveFlowSha256, "42cbd9a4fc3e53aacadb24601c2a430e78f36d9b79a5f5725782667a87735c42");
  assert.equal(manifest.source.candidateFlowSha256, "ccc71f8f54881f3bfd5424a7fc1acc0008d4c3eceb16f1ec4560c281c448c03a");
  assert.ok(manifest.files.some((item) => item.path === "scripts/run_legacy_game_command_production_migration.mjs"));
  assert.ok(manifest.files.some((item) => item.path === "node_modules/mongodb/package.json"));
  assert.equal(
    fs.readFileSync(path.join(bundle, "scripts/legacy_game_command_production_trust_anchor.json"), "utf8"),
    "{\"algorithm\":\"Ed25519\",\"keyId\":\"UNBOUND\",\"publicKeySpkiSha256\":\"UNBOUND\",\"schemaVersion\":1,\"status\":\"UNBOUND\"}\n",
  );
});

test("Git-object source reads cannot be redirected by a tracked worktree mutation", (t) => {
  const root = makeTempRoot(t);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  fs.writeFileSync(path.join(root, "source.txt"), "committed\n");
  execFileSync("git", ["add", "source.txt"], { cwd: root });
  execFileSync("git", [
    "-c", "user.name=Release Test", "-c", "user.email=release-test@example.invalid",
    "commit", "--quiet", "-m", "fixture",
  ], { cwd: root });
  const fixtureCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(root, "source.txt"), "substituted\n");
  assert.equal(readGitBlob(root, fixtureCommit, "source.txt").toString("utf8"), "committed\n");
});

test("install plan is read-only and bundle tampering is rejected", (t) => {
  const { root, bundle, manifestSha256 } = buildFixture(t);
  const installRoot = path.join(root, "install");
  const currentUid = typeof process.getuid === "function" ? process.getuid() : 501;
  const plan = prepareLegacyGameCommandReleaseInstall({
    mode: "plan",
    bundlePath: bundle,
    installRoot,
    executorUid: currentUid + 1,
    expectedCommit: commit,
    expectedManifestSha256: manifestSha256,
    environment: "production",
    currentUid,
  });
  assert.equal(plan.deploymentPerformed, false);
  assert.equal(fs.existsSync(installRoot), false);
  assert.throws(() => prepareLegacyGameCommandReleaseInstall({
    mode: "plan",
    bundlePath: bundle,
    installRoot,
    executorUid: currentUid + 1,
    expectedCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    expectedManifestSha256: manifestSha256,
    environment: "production",
    currentUid,
  }), /independently expected commit/);
  assert.throws(() => prepareLegacyGameCommandReleaseInstall({
    mode: "plan",
    bundlePath: bundle,
    installRoot,
    executorUid: currentUid + 1,
    expectedCommit: commit,
    expectedManifestSha256: "b".repeat(64),
    environment: "production",
    currentUid,
  }), /independently expected manifest digest/);

  fs.appendFileSync(path.join(bundle, "scripts/legacy_game_revision_writers.json"), " ");
  assert.throws(() => verifyLegacyGameCommandReleaseBundle(bundle), /inventory mismatch/);

  const manifestPath = path.join(bundle, "release-manifest.json");
  const forgedManifest = parseCanonicalJson(fs.readFileSync(manifestPath), "release manifest");
  const changedPath = "scripts/legacy_game_revision_writers.json";
  const changedBody = fs.readFileSync(path.join(bundle, changedPath));
  const changedItem = forgedManifest.files.find((item) => item.path === changedPath);
  changedItem.size = changedBody.length;
  changedItem.sha256 = crypto.createHash("sha256").update(changedBody).digest("hex");
  fs.writeFileSync(manifestPath, canonicalJson(forgedManifest));
  verifyLegacyGameCommandReleaseBundle(bundle);
  assert.throws(() => prepareLegacyGameCommandReleaseInstall({
    mode: "plan",
    bundlePath: bundle,
    installRoot,
    executorUid: currentUid + 1,
    expectedCommit: commit,
    expectedManifestSha256: manifestSha256,
    environment: "production",
    currentUid,
  }), /independently expected manifest digest/);
});

test("rehearsal installs one sealed commit-addressed release and creates exact attestation", async (t) => {
  const { root, bundle, manifestSha256 } = buildFixture(t);
  const installRoot = path.join(root, "install");
  const currentUid = typeof process.getuid === "function" ? process.getuid() : 501;
  const executorUid = currentUid + 1;
  const activatedAt = new Date(Date.now() - 1_000).toISOString();
  const result = prepareLegacyGameCommandReleaseInstall({
    mode: "install",
    bundlePath: bundle,
    installRoot,
    executorUid,
    expectedCommit: commit,
    expectedManifestSha256: manifestSha256,
    environment: "rehearsal",
    deploymentId: "11111111-1111-4111-8111-111111111111",
    activatedAt,
    currentUid,
  });
  assert.equal(result.deploymentPerformed, true);
  assert.equal(result.releaseDir, path.join(installRoot, "releases", commit));
  assert.equal(fs.existsSync(path.join(installRoot, "current")), false);
  assert.equal(fs.statSync(result.releaseDir).mode & 0o222, 0);
  assert.equal(fs.statSync(path.join(result.releaseDir, "package.json")).mode & 0o222, 0);

  const attestationBody = fs.readFileSync(result.releaseAttestationPath);
  const attestation = parseCanonicalJson(attestationBody, "release attestation");
  assert.equal(attestation.status, "ACTIVE");
  assert.equal(attestation.environment, "rehearsal");
  assert.equal(attestation.repositoryCommit, commit);
  assert.equal(attestation.activatedAt, activatedAt);

  const runnerUrl = `${pathToFileURL(path.join(result.releaseDir, "scripts/run_legacy_game_command_production_migration.mjs")).href}?test=${Date.now()}`;
  const installedRunner = await import(runnerUrl);
  const actualSource = installedRunner.buildProductionStaticSourceIdentity();
  delete actualSource.releaseAttestationSha256;
  assert.deepEqual(attestation.source, actualSource);
  const attestationSha256 = crypto.createHash("sha256").update(attestationBody).digest("hex");
  const packet = {
    source: {
      ...attestation.source,
      repositoryCommit: commit,
      releaseAttestationSha256: attestationSha256,
    },
  };
  assert.throws(() => installedRunner.validateProductionReleaseAttestation(packet, attestation, {
    attestationSha256,
    actualSource: { ...actualSource, releaseAttestationSha256: attestationSha256 },
    environment: "production",
  }), /identity mismatch/);

  const installedPackage = path.join(result.releaseDir, "package.json");
  fs.chmodSync(installedPackage, 0o644);
  assert.throws(() => verifySealedRelease(result.releaseDir, currentUid), /file mode/);
  fs.chmodSync(installedPackage, 0o444);

  assert.throws(() => prepareLegacyGameCommandReleaseInstall({
    mode: "install",
    bundlePath: bundle,
    installRoot,
    executorUid,
    expectedCommit: commit,
    expectedManifestSha256: manifestSha256,
    environment: "rehearsal",
    deploymentId: "22222222-2222-4222-8222-222222222222",
    activatedAt,
    currentUid,
  }), /already exists/);
});

test("production install fails without the exact root trust boundary", (t) => {
  const { root, bundle, manifestSha256 } = buildFixture(t);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : 501;
  assert.throws(() => prepareLegacyGameCommandReleaseInstall({
    mode: "install",
    bundlePath: bundle,
    installRoot: path.join(root, "not-production"),
    executorUid: currentUid + 1,
    expectedCommit: commit,
    expectedManifestSha256: manifestSha256,
    environment: "production",
    deploymentId: "11111111-1111-4111-8111-111111111111",
    activatedAt: new Date(Date.now() - 1_000).toISOString(),
    currentUid,
  }), /exact install root/);
});
