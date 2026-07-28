import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  const distDir = path.join(root, "dist");
  const fontsDir = path.join(root, "fonts");
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(fontsDir, { recursive: true });

  [...PROD_FILES, ...DEV_FILES].forEach((fileName) => {
    fs.writeFileSync(path.join(distDir, fileName), `${fileName}\n`, "utf8");
  });
  FONT_FILES.forEach((fileName) => {
    fs.writeFileSync(path.join(fontsDir, fileName), `${fileName}\n`, "utf8");
  });

  return { distDir, fontsDir };
}

function runTopologyDeploy(
  channel: "prod" | "dev" | "all",
  envOverrides: Record<string, string> = {},
) {
  const { distDir, fontsDir } = prepareArtifacts();
  return spawnSync("bash", ["./scripts/deploy-lk-topology.sh", channel, "--dry-run"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      DEPLOY_DIST_DIR: distDir,
      DEPLOY_FONT_SOURCE_DIR: fontsDir,
      ...envOverrides,
    },
  });
}

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
