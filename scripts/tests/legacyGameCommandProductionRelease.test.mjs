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

const fileSha256 = (filePath) => crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");

async function buildFixture(t) {
  const root = makeTempRoot(t);
  const bundle = path.join(root, "bundle");
  const manifest = buildLegacyGameCommandProductionRelease({
    outDir: bundle,
  });
  const installerPath = path.join(bundle, "scripts/install_legacy_game_command_production_release.mjs");
  const installer = await import(`${pathToFileURL(installerPath).href}?fixture=${crypto.randomUUID()}`);
  const verified = installer.verifyLegacyGameCommandReleaseBundle(bundle);
  return {
    root,
    bundle,
    manifest,
    manifestSha256: verified.manifestSha256,
    installerSha256: fileSha256(installerPath),
    installer,
  };
}

test("release builder packages and authenticates the bootstrap installer and runtime closure", async (t) => {
  const { bundle, manifest, installer, installerSha256 } = await buildFixture(t);
  const verified = installer.verifyLegacyGameCommandReleaseBundle(bundle);
  assert.equal(verified.manifest.repositoryCommit, commit);
  assert.equal(manifest.source.liveFlowSha256, "42cbd9a4fc3e53aacadb24601c2a430e78f36d9b79a5f5725782667a87735c42");
  assert.equal(manifest.source.candidateFlowSha256, "ccc71f8f54881f3bfd5424a7fc1acc0008d4c3eceb16f1ec4560c281c448c03a");
  assert.equal(manifest.source.installerSha256, installerSha256);
  assert.ok(manifest.files.some((item) => item.path === "scripts/install_legacy_game_command_production_release.mjs"
    && item.sha256 === installerSha256));
  assert.ok(manifest.files.some((item) => item.path === "scripts/run_legacy_game_command_production_migration.mjs"));
  assert.ok(manifest.files.some((item) => item.path === "node_modules/mongodb/package.json"));
  const installerBody = fs.readFileSync(
    path.join(bundle, "scripts/install_legacy_game_command_production_release.mjs"),
    "utf8",
  );
  const staticImports = [...installerBody.matchAll(/^import .* from ["']([^"']+)["'];$/gm)]
    .map((match) => match[1]);
  assert.ok(staticImports.length > 0);
  assert.ok(staticImports.every((specifier) => specifier.startsWith("node:")));
  assert.equal(
    fs.readFileSync(path.join(bundle, "scripts/legacy_game_command_production_trust_anchor.json"), "utf8"),
    "{\"algorithm\":\"Ed25519\",\"keyId\":\"UNBOUND\",\"publicKeySpkiSha256\":\"UNBOUND\",\"schemaVersion\":1,\"status\":\"UNBOUND\"}\n",
  );
});

test("mid-copy failure removes its private partial staging tree", async (t) => {
  const { root, bundle, manifestSha256, installerSha256, installer } = await buildFixture(t);
  const installRoot = path.join(root, "failed-install");
  const currentUid = typeof process.getuid === "function" ? process.getuid() : 501;
  const deploymentId = "33333333-3333-4333-8333-333333333333";
  const copyFileSync = fs.copyFileSync;
  let copies = 0;
  fs.copyFileSync = (...args) => {
    copies += 1;
    if (copies === 3) throw new Error("injected mid-copy fault");
    return copyFileSync(...args);
  };
  try {
    await assert.rejects(installer.prepareLegacyGameCommandReleaseInstall({
      mode: "install",
      bundlePath: bundle,
      installRoot,
      executorUid: currentUid + 1,
      expectedCommit: commit,
      expectedManifestSha256: manifestSha256,
      expectedInstallerSha256: installerSha256,
      environment: "rehearsal",
      deploymentId,
      activatedAt: new Date(Date.now() - 1_000).toISOString(),
      currentUid,
    }), /injected mid-copy fault/);
  } finally {
    fs.copyFileSync = copyFileSync;
  }
  assert.equal(copies, 3);
  assert.equal(fs.existsSync(path.join(installRoot, "releases", `.staging-${deploymentId}`)), false);
  assert.equal(fs.existsSync(path.join(installRoot, "releases", commit)), false);
});

test("installer omission and byte tampering are rejected by the bundle inventory", async (t) => {
  const { bundle, installer } = await buildFixture(t);
  const installerPath = path.join(bundle, "scripts/install_legacy_game_command_production_release.mjs");
  const body = fs.readFileSync(installerPath);
  fs.unlinkSync(installerPath);
  assert.throws(() => installer.verifyLegacyGameCommandReleaseBundle(bundle), /inventory mismatch/);
  fs.writeFileSync(installerPath, body);
  fs.appendFileSync(installerPath, "\n");
  assert.throws(() => installer.verifyLegacyGameCommandReleaseBundle(bundle), /inventory mismatch/);
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

test("self-contained bundle plan is read-only and rejects identity drift", async (t) => {
  const { root, bundle, manifestSha256, installerSha256, installer } = await buildFixture(t);
  const { prepareLegacyGameCommandReleaseInstall, verifyLegacyGameCommandReleaseBundle } = installer;
  const installRoot = path.join(root, "install");
  const currentUid = typeof process.getuid === "function" ? process.getuid() : 501;
  const plan = await prepareLegacyGameCommandReleaseInstall({
    mode: "plan",
    bundlePath: bundle,
    installRoot,
    executorUid: currentUid + 1,
    expectedCommit: commit,
    expectedManifestSha256: manifestSha256,
    expectedInstallerSha256: installerSha256,
    environment: "production",
    currentUid,
  });
  assert.equal(plan.deploymentPerformed, false);
  assert.equal(fs.existsSync(installRoot), false);
  await assert.rejects(prepareLegacyGameCommandReleaseInstall({
    mode: "plan",
    bundlePath: bundle,
    installRoot,
    executorUid: currentUid + 1,
    expectedCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    expectedManifestSha256: manifestSha256,
    expectedInstallerSha256: installerSha256,
    environment: "production",
    currentUid,
  }), /independently expected commit/);
  await assert.rejects(prepareLegacyGameCommandReleaseInstall({
    mode: "plan",
    bundlePath: bundle,
    installRoot,
    executorUid: currentUid + 1,
    expectedCommit: commit,
    expectedManifestSha256: "b".repeat(64),
    expectedInstallerSha256: installerSha256,
    environment: "production",
    currentUid,
  }), /independently expected manifest digest/);
  await assert.rejects(prepareLegacyGameCommandReleaseInstall({
    mode: "plan",
    bundlePath: bundle,
    installRoot,
    executorUid: currentUid + 1,
    expectedCommit: commit,
    expectedManifestSha256: manifestSha256,
    expectedInstallerSha256: "c".repeat(64),
    environment: "production",
    currentUid,
  }), /independently expected installer digest/);

  const cli = execFileSync(process.execPath, [
    path.join(bundle, "scripts/install_legacy_game_command_production_release.mjs"),
    "--mode", "plan",
    "--bundle", bundle,
    "--install-root", installRoot,
    "--executor-uid", String(currentUid + 1),
    "--expected-commit", commit,
    "--expected-manifest-sha256", manifestSha256,
    "--expected-installer-sha256", installerSha256,
    "--environment", "production",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(JSON.parse(cli).deploymentPerformed, false);

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
  await assert.rejects(prepareLegacyGameCommandReleaseInstall({
    mode: "plan",
    bundlePath: bundle,
    installRoot,
    executorUid: currentUid + 1,
    expectedCommit: commit,
    expectedManifestSha256: manifestSha256,
    expectedInstallerSha256: installerSha256,
    environment: "production",
    currentUid,
  }), /independently expected manifest digest/);
});

test("rehearsal installs one sealed commit-addressed release and creates exact attestation", async (t) => {
  const { root, bundle, manifestSha256, installerSha256, installer } = await buildFixture(t);
  const { prepareLegacyGameCommandReleaseInstall, verifySealedRelease } = installer;
  const installRoot = path.join(root, "install");
  const currentUid = typeof process.getuid === "function" ? process.getuid() : 501;
  const executorUid = currentUid + 1;
  const activatedAt = new Date(Date.now() - 1_000).toISOString();
  const result = await prepareLegacyGameCommandReleaseInstall({
    mode: "install",
    bundlePath: bundle,
    installRoot,
    executorUid,
    expectedCommit: commit,
    expectedManifestSha256: manifestSha256,
    expectedInstallerSha256: installerSha256,
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

  await assert.rejects(prepareLegacyGameCommandReleaseInstall({
    mode: "install",
    bundlePath: bundle,
    installRoot,
    executorUid,
    expectedCommit: commit,
    expectedManifestSha256: manifestSha256,
    expectedInstallerSha256: installerSha256,
    environment: "rehearsal",
    deploymentId: "22222222-2222-4222-8222-222222222222",
    activatedAt,
    currentUid,
  }), /already exists/);
});

test("production install fails without the exact root trust boundary", async (t) => {
  const { root, bundle, manifestSha256, installerSha256, installer } = await buildFixture(t);
  const { prepareLegacyGameCommandReleaseInstall } = installer;
  const currentUid = typeof process.getuid === "function" ? process.getuid() : 501;
  await assert.rejects(prepareLegacyGameCommandReleaseInstall({
    mode: "install",
    bundlePath: bundle,
    installRoot: path.join(root, "not-production"),
    executorUid: currentUid + 1,
    expectedCommit: commit,
    expectedManifestSha256: manifestSha256,
    expectedInstallerSha256: installerSha256,
    environment: "production",
    deploymentId: "11111111-1111-4111-8111-111111111111",
    activatedAt: new Date(Date.now() - 1_000).toISOString(),
    currentUid,
  }), /exact install root/);
});
