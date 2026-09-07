import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const PROD_FILES = [
  "bundle.js",
  "games.js",
  "tournaments.js",
  "tournament-signup.js",
  "group-schedule.js",
  "padel-day-schedule.js",
  "tournament-subscription.js",
  "tournament-subscription-referral.js",
  "onboarding.js",
  "levels-info.js",
  "communities.js",
  "release.json",
];

const DEV_FILES = [
  "bundle-dev.js",
  "games-dev.js",
  "tournaments-dev.js",
  "tournament-signup-dev.js",
  "group-schedule-dev.js",
  "padel-day-schedule-dev.js",
  "tournament-subscription-dev.js",
  "tournament-subscription-referral-dev.js",
  "onboarding-dev.js",
  "levels-info-dev.js",
  "communities-dev.js",
  "release-dev.json",
];

const FONT_FILES = [
  "rf-dewi-ultrabold.woff2",
  "rf-dewi-expanded-ultrabold-italic.woff2",
  "SourceCodePro-Medium.woff2",
  "SourceCodePro-Regular.woff2",
];

function prepareArtifacts() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lk-deploy-topology-"));
  // Exercise the real provenance validator in an owned clean repository, not
  // whatever unrelated dist/manifest happens to exist in the developer checkout.
  const repoDir = path.join(root, "repo");
  fs.mkdirSync(repoDir);
  for (const name of ["deploy-lk.sh", "deploy-lk-topology.sh", "assert-clean-deploy.mjs",
    "lib/release-provenance.mjs", "lib/build-env.mjs"]) {
    const destination = path.join(repoDir, "scripts", name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(process.cwd(), "scripts", name), destination);
  }
  fs.writeFileSync(path.join(repoDir, ".gitignore"), "dist/\n");
  const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" }).trim();
  git(["init", "-q"]);
  git(["add", "."]);
  git(["-c", "user.name=fixture", "-c", "user.email=fixture", "commit", "-qm", "fixture"]);
  const sourceCommit = git(["rev-parse", "HEAD"]);
  const distDir = path.join(root, "dist");
  const fontsDir = path.join(root, "fonts");
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(fontsDir, { recursive: true });

  [...PROD_FILES, ...DEV_FILES].forEach((fileName) => {
    const payload = fileName.startsWith("release")
      ? JSON.stringify({ version: "fixture", sourceCommit, sourceDirty: false })
      : `${fileName}\nlk-runtime-config-v1:prod lk-runtime-config-v1:dev\n`
        + "communitiesBundleUrl levelsInfoBundleUrl onboardingBundleUrl pushRegistrationUrl keycloakBase serv2Fallback\n";
    fs.writeFileSync(path.join(distDir, fileName), payload, "utf8");
  });
  FONT_FILES.forEach((fileName) => {
    fs.writeFileSync(path.join(fontsDir, fileName), `${fileName}\n`, "utf8");
  });

  return { root, repoDir, distDir, fontsDir };
}

function runTopologyDeploy(
  channel: "prod" | "dev" | "all",
  envOverrides: Record<string, string> = {},
  prepare?: (fixture: ReturnType<typeof prepareArtifacts>) => void,
) {
  const fixture = prepareArtifacts();
  const { root, repoDir, distDir, fontsDir } = fixture;
  try {
    prepare?.(fixture);
    return spawnSync("bash", ["./scripts/deploy-lk-topology.sh", channel, "--dry-run"], {
      cwd: repoDir,
      encoding: "utf8",
      env: {
        ...process.env,
        DEPLOY_DIST_DIR: distDir,
        DEPLOY_FONT_SOURCE_DIR: fontsDir,
        ...envOverrides,
      },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("external DEV manifest is checked even when checkout dist has a valid manifest", () => {
  const result = runTopologyDeploy("dev", { DEPLOY_PRUNE_OPPOSITE_CHANNEL: "0" }, ({ repoDir, distDir }) => {
    fs.cpSync(distDir, path.join(repoDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(distDir, "release-dev.json"), JSON.stringify({
      sourceCommit: "0".repeat(40), sourceDirty: false,
    }));
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /current HEAD/);
  assert.doesNotMatch(result.stdout, /Dry run commands:/);
});

test("external DEV bundles are checked and prune=0 is preserved", () => {
  const valid = runTopologyDeploy("dev", { DEPLOY_PRUNE_OPPOSITE_CHANNEL: "0" });
  assert.equal(valid.status, 0, valid.stderr);
  assert.doesNotMatch(valid.stdout, /Prune opposite-channel|rm -f/);
  const invalid = runTopologyDeploy("dev", {}, ({ distDir }) => {
    fs.writeFileSync(path.join(distDir, "games-dev.js"), "undefined/end-user");
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /undefined API/);
});
test("isolated DEV upload allows only reserve immutable target with no font or prune commands", () => {
  const target = `lk-reserve-89:/var/www/html/lk-frontend-dev-releases/${"1".repeat(40)}-${"a".repeat(16)}`;
  const env = { DEPLOY_DEV_ISOLATED: "1", DEPLOY_PRUNE_OPPOSITE_CHANNEL: "0", DEPLOY_TARGETS_DEV: target };
  const valid = runTopologyDeploy("dev", env);
  assert.equal(valid.status, 0, valid.stderr);
  assert.doesNotMatch(valid.stdout, /fonts\/|\.woff2|mkdir|rm -f|Prune opposite/);
  for (const changed of [
    { DEPLOY_PRUNE_OPPOSITE_CHANNEL: "1" },
    { DEPLOY_TARGETS_DEV: "lk-reserve-89:/var/www/html/lk" },
    { DEPLOY_TARGETS_DEV: target.replace("lk-reserve-89", "lk-primary-147") },
    { DEPLOY_TARGETS_DEV: target.replace("frontend-dev-releases", "frontend-releases") },
  ]) {
    const invalid = runTopologyDeploy("dev", { ...env, ...changed });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /Isolated DEV/);
    assert.doesNotMatch(invalid.stdout, /Dry run commands/);
  }
});

test("split deploy topology defaults prod to 147 only", () => {
  const result = runTopologyDeploy("prod");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Channel: prod/);
  assert.match(result.stdout, /lk-primary-147:\/var\/www\/html\/lk\//);
  assert.doesNotMatch(result.stdout, /lk-reserve-89:\/var\/www\/html\/lk\//);
  assert.match(result.stdout, /tournament-subscription-referral\.js/);
  assert.match(result.stdout, /Prune opposite-channel files:/);
  assert.match(result.stdout, /bundle-dev\.js/);
});

test("split deploy topology defaults dev to 89 only", () => {
  const result = runTopologyDeploy("dev");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Channel: dev/);
  assert.match(result.stdout, /lk-reserve-89:\/var\/www\/html\/lk\//);
  assert.doesNotMatch(result.stdout, /lk-primary-147:\/var\/www\/html\/lk\//);
  assert.match(result.stdout, /tournament-subscription-referral-dev\.js/);
  assert.match(result.stdout, /Prune opposite-channel files:/);
  assert.match(result.stdout, /bundle\.js/);
});

test("split deploy topology all deploys prod and dev to separate targets", () => {
  const result = runTopologyDeploy("all");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Channel: prod/);
  assert.match(result.stdout, /Channel: dev/);
  assert.match(result.stdout, /lk-primary-147:\/var\/www\/html\/lk\//);
  assert.match(result.stdout, /lk-reserve-89:\/var\/www\/html\/lk\//);
});

test("split deploy topology respects channel-specific target overrides", () => {
  const result = runTopologyDeploy("all", {
    DEPLOY_TARGETS_PROD: "prod-host:/srv/prod-lk",
    DEPLOY_TARGETS_DEV: "dev-host:/srv/dev-lk",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /prod-host:\/srv\/prod-lk\//);
  assert.match(result.stdout, /dev-host:\/srv\/dev-lk\//);
  assert.match(result.stdout, /\/srv\/prod-lk\/bundle-dev\.js/);
  assert.match(result.stdout, /\/srv\/dev-lk\/bundle\.js/);
});

test("package scripts point default deploy commands at split topology wrapper", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };
  const scripts = pkg.scripts || {};
  assert.equal(scripts["deploy:prod"], "bash ./scripts/deploy-lk-topology.sh prod");
  assert.equal(scripts["deploy:dev"], "bash ./scripts/deploy-lk-topology.sh dev");
  assert.equal(scripts["deploy:all"], "bash ./scripts/deploy-lk-topology.sh all");
});
