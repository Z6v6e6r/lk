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
  assert.equal(manifest.source.liveFlowSha256, "14b5aff65e0b49fd4f37d6d1d9465af8af3ccdf2e6cfa77bc76b4a9f2a831350");
  assert.equal(manifest.source.candidateFlowSha256, "d88ea0afc5fd00e5f4e532415b57d33ed2691c320c3ba23fd2a54ba804fb139c");
  assert.equal(manifest.source.installerSha256, installerSha256);
  assert.ok(manifest.files.some((item) => item.path === "scripts/install_legacy_game_command_production_release.mjs"
    && item.sha256 === installerSha256));
  assert.ok(manifest.files.some((item) => item.path === "scripts/run_legacy_game_command_production_migration.mjs"));
  assert.ok(manifest.files.some((item) => item.path === "node_modules/mongodb/package.json"));
  const installerBody = fs.readFileSync(
    path.join(bundle, "scripts/install_legacy_game_command_production_release.mjs"),
    "utf8",
  );
  const staticImports = [...installerBody.matchAll(/^\s*import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["'];/gm)]
    .map((match) => match[1]);
  assert.deepEqual(staticImports.sort(), [
    "node:crypto",
    "node:fs",
    "node:path",
    "node:url",
    "node:util",
  ]);
  assert.equal(
    fs.readFileSync(path.join(bundle, "scripts/legacy_game_command_production_trust_anchor.json"), "utf8"),
    "{\"algorithm\":\"Ed25519\",\"keyId\":\"UNBOUND\",\"publicKeySpkiSha256\":\"UNBOUND\",\"schemaVersion\":1,\"status\":\"UNBOUND\"}\n",
  );
});

test("production runbook freezes root custody and both digests before exec", () => {
  const runbook = fs.readFileSync(
    path.join(repositoryRoot, "docs/LEGACY_GAME_COMMAND_PRODUCTION_RELEASE_INSTALL.md"),
    "utf8",
  );
  const custody = runbook.indexOf("chown -hR 0:0 \"$CUSTODY_BUNDLE\"");
  const protection = runbook.indexOf("BAD_CUSTODY_ENTRY=");
  const manifestDigest = runbook.indexOf("ACTUAL_MANIFEST_SHA256=");
  const installerDigest = runbook.indexOf("ACTUAL_INSTALLER_SHA256=", manifestDigest);
  const execute = runbook.indexOf("exec env LK_LEGACY_COMMAND_RELEASE_INSTALL=");
  assert.ok(custody > 0 && protection > custody);
  assert.ok(manifestDigest > protection && installerDigest > manifestDigest);
  assert.ok(execute > installerDigest);
  assert.match(runbook, /never\s+execute Node from `DELIVERY_BUNDLE`/);
  assert.match(runbook, /! -user root -o -perm \/022/);
  assert.match(runbook, /\$ACTUAL_MANIFEST_SHA256.*\$EXPECTED_MANIFEST_SHA256/);
  assert.match(runbook, /\$ACTUAL_INSTALLER_SHA256.*\$EXPECTED_INSTALLER_SHA256/);
});

test("host-hardening plan keeps permission and executor mutations behind separate gates", () => {
  const plan = fs.readFileSync(
    path.join(repositoryRoot, "docs/LEGACY_GAME_COMMAND_HOST_HARDENING_PLAN.md"),
    "utf8",
  );
  assert.match(plan, /does not authorize `chmod`, `groupadd`,/);
  assert.match(plan, /preimage `0:0:0707`, and target `0:0:0755`/);
  assert.match(plan, /LEGACY_GAME_COMMAND_ROOT_ACL_BOOTSTRAP\.md/);
  assert.match(plan, /H0 is audit-only and must prove through `flistxattr`/);
  assert.match(plan, /LK_ROOT_ACL_BOOTSTRAP_APPLY=APPLY_ROOT_MODE_0755_V1/);
  assert.match(plan, /Raw path-based `chmod` is\nforbidden/);
  assert.match(plan, /Restoring the insecure\npreimage is a separate break-glass live gate/);
  assert.match(plan, /LK_ROOT_ACL_BOOTSTRAP_ROLLBACK=ROLLBACK_ROOT_MODE_0707_V1/);
  assert.match(plan, /host has no `getfacl`, `getfattr`, or `attr`/);
  assert.match(plan, /Unknown\/non-empty xattrs or incomplete read-back/);
  assert.match(plan, /scan each\nmount without crossing filesystem boundaries/);
  assert.match(plan, /report zero ownership and ACL matches/);
  assert.match(plan, /groupadd --system --gid <frozen-unused-gid>/);
  assert.match(plan, /useradd --system --uid <frozen-unused-uid>/);
  assert.match(plan, /--gid <frozen-unused-gid> --no-user-group --no-create-home/);
  assert.match(plan, /--home-dir \/nonexistent --shell \/usr\/sbin\/nologin/);
  assert.match(plan, /usermod --lock padlhub-legacy-command/);
  assert.match(plan, /explicitly locked password\/account state/);
  assert.match(plan, /userdel padlhub-legacy-command/);
  assert.match(plan, /groupdel padlhub-legacy-command/);
  assert.match(plan, /passwd and group names plus both frozen numeric IDs\nmust all be absent/);
  assert.match(plan, /H2 approval, precheck, postcheck, failure, and rollback evidence may and must refer/);
  assert.match(plan, /Removal is forbidden after any downstream install or\nattestation/);
  assert.match(plan, /H1 and H2 do not authorize one another and do not authorize the release install/);
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
